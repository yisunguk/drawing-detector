
import json
import time
from azure.core.exceptions import ResourceModifiedError
from app.services.blob_storage import get_container_client


class StatusManager:
    """
    Manages analysis status blobs with:
    - Username-scoped paths to prevent cross-user collisions (C4)
    - ETag-based conditional writes for cross-process safety (H4)
    """

    ETAG_MAX_RETRIES = 5
    ETAG_BACKOFF_BASE = 0.1  # seconds

    def _get_blob_client(self, filename, username=None):
        container = get_container_client()
        if username:
            status_blob_name = f"temp/status/{username}/{filename}.status.json"
        else:
            status_blob_name = f"temp/status/{filename}.status.json"
        return container.get_blob_client(status_blob_name)

    def _read_with_etag(self, blob_client):
        """Read blob and return (data_dict, etag). Returns (None, None) if blob doesn't exist."""
        if not blob_client.exists():
            return None, None
        props = blob_client.get_blob_properties()
        etag = props.etag
        data = blob_client.download_blob().readall()
        return json.loads(data), etag

    def _write_with_etag(self, blob_client, data, etag):
        """
        Write blob with ETag-based conditional write.
        If etag is None (new blob), uses overwrite=True without condition.
        Raises ResourceModifiedError if blob was modified since read.
        """
        payload = json.dumps(data)
        if etag:
            from azure.core import MatchConditions
            blob_client.upload_blob(
                payload,
                overwrite=True,
                etag=etag,
                match_condition=MatchConditions.IfNotModified
            )
        else:
            blob_client.upload_blob(payload, overwrite=True)

    def _update_with_retry(self, filename, username, mutate_fn):
        """
        Read-modify-write loop with ETag retry for safe concurrent updates.
        mutate_fn(status_dict) -> should mutate the dict in place.
        Returns the updated status dict, or None if status doesn't exist.
        """
        blob_client = self._get_blob_client(filename, username)

        for attempt in range(self.ETAG_MAX_RETRIES):
            status, etag = self._read_with_etag(blob_client)
            if status is None:
                return None

            mutate_fn(status)

            try:
                self._write_with_etag(blob_client, status, etag)
                return status
            except ResourceModifiedError:
                if attempt < self.ETAG_MAX_RETRIES - 1:
                    time.sleep(self.ETAG_BACKOFF_BASE * (attempt + 1))
                else:
                    print(f"[StatusManager] ETag conflict after {self.ETAG_MAX_RETRIES} retries for {filename}", flush=True)
                    raise

    def init_status(self, filename, total_pages, category, username=None):
        blob_client = self._get_blob_client(filename, username)
        status_data = {
            "filename": filename,
            "username": username,
            "category": category,
            "total_pages": total_pages,
            "completed_chunks": [],
            "analyzed_pages": [],
            "status": "in_progress",
            "last_updated": None
        }
        blob_client.upload_blob(json.dumps(status_data), overwrite=True)
        return status_data

    def get_status(self, filename, username=None):
        blob_client = self._get_blob_client(filename, username)
        if not blob_client.exists():
            # Backward compat: try without username if username was provided
            if username:
                fallback = self._get_blob_client(filename, username=None)
                if fallback.exists():
                    data = fallback.download_blob().readall()
                    return json.loads(data)
            return None

        data = blob_client.download_blob().readall()
        return json.loads(data)

    def update_chunk_progress(self, filename, chunk_range, username=None):
        def _mutate(status):
            if chunk_range not in status["completed_chunks"]:
                status["completed_chunks"].append(chunk_range)

        status = self._update_with_retry(filename, username, _mutate)
        if status:
            print(f"[Status] Updated: {len(status['completed_chunks'])} chunks completed", flush=True)
        return status

    def mark_finalizing(self, filename, username=None):
        def _mutate(status):
            status["status"] = "finalizing"

        return self._update_with_retry(filename, username, _mutate)

    def mark_completed(self, filename, json_location=None, username=None):
        def _mutate(status):
            status["status"] = "completed"
            if json_location:
                status["json_location"] = json_location

        return self._update_with_retry(filename, username, _mutate)

    def increment_retry(self, filename, username=None):
        def _mutate(status):
            status["retry_count"] = status.get("retry_count", 0) + 1
            status["status"] = "retrying"

        status = self._update_with_retry(filename, username, _mutate)
        if status:
            print(f"[StatusManager] Retry {status['retry_count']} for {filename}")
        return status

    def mark_failed(self, filename, reason, username=None):
        def _mutate(status):
            status["status"] = "failed"
            status["error"] = reason

        status = self._update_with_retry(filename, username, _mutate)
        if status:
            print(f"[StatusManager] Marked {filename} as failed: {reason}")
        return status

    def reset_status(self, filename, username=None):
        blob_client = self._get_blob_client(filename, username)
        try:
            if blob_client.exists():
                blob_client.delete_blob()
                print(f"[StatusManager] Reset status for {filename} (deleted status blob)")
            else:
                # Also try old path without username for cleanup
                if username:
                    fallback = self._get_blob_client(filename, username=None)
                    if fallback.exists():
                        fallback.delete_blob()
                        print(f"[StatusManager] Reset status for {filename} (deleted legacy status blob)")
                        return
                print(f"[StatusManager] No existing status for {filename}")
        except Exception as e:
            print(f"[StatusManager] Warning: Failed to reset status for {filename}: {e}")

    def write_status_direct(self, filename, status_data, username=None):
        """Direct write for cases where the caller manages the full status dict (e.g., /start resume)."""
        blob_client = self._get_blob_client(filename, username)
        blob_client.upload_blob(json.dumps(status_data), overwrite=True)


status_manager = StatusManager()
