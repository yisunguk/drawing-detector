
import json
import threading
from app.services.blob_storage import get_container_client

class StatusManager:
    def __init__(self):
        self._lock = threading.Lock()

    def _get_blob_client(self, filename):
        container = get_container_client()
        status_blob_name = f"temp/status/{filename}.status.json"
        return container.get_blob_client(status_blob_name)

    def init_status(self, filename, total_pages, category):
        blob_client = self._get_blob_client(filename)
        status_data = {
            "filename": filename,
            "category": category,
            "total_pages": total_pages,
            "completed_chunks": [],
            "analyzed_pages": [],
            "status": "in_progress",
            "last_updated": None
        }
        blob_client.upload_blob(json.dumps(status_data), overwrite=True)
        return status_data

    def get_status(self, filename):
        blob_client = self._get_blob_client(filename)
        if not blob_client.exists():
            return None

        data = blob_client.download_blob().readall()
        return json.loads(data)

    def update_chunk_progress(self, filename, chunk_range):
        with self._lock:
            status = self.get_status(filename)
            if not status:
                return None

            if chunk_range not in status["completed_chunks"]:
                status["completed_chunks"].append(chunk_range)

            blob_client = self._get_blob_client(filename)
            blob_client.upload_blob(json.dumps(status), overwrite=True)
            print(f"[Status] Updated: {len(status['completed_chunks'])} chunks completed", flush=True)
            return status

    def mark_finalizing(self, filename):
        with self._lock:
            status = self.get_status(filename)
            if not status:
                return None

            status["status"] = "finalizing"
            blob_client = self._get_blob_client(filename)
            blob_client.upload_blob(json.dumps(status), overwrite=True)
            return status

    def mark_completed(self, filename, json_location=None):
        with self._lock:
            status = self.get_status(filename)
            if not status:
                return

            status["status"] = "completed"
            if json_location:
                status["json_location"] = json_location

            blob_client = self._get_blob_client(filename)
            blob_client.upload_blob(json.dumps(status), overwrite=True)

    def increment_retry(self, filename):
        with self._lock:
            status = self.get_status(filename)
            if not status:
                return None

            status["retry_count"] = status.get("retry_count", 0) + 1
            status["status"] = "retrying"

            blob_client = self._get_blob_client(filename)
            blob_client.upload_blob(json.dumps(status), overwrite=True)
            print(f"[StatusManager] Retry {status['retry_count']} for {filename}")
            return status

    def mark_failed(self, filename, reason):
        with self._lock:
            status = self.get_status(filename)
            if not status:
                return None

            status["status"] = "failed"
            status["error"] = reason

            blob_client = self._get_blob_client(filename)
            blob_client.upload_blob(json.dumps(status), overwrite=True)
            print(f"[StatusManager] Marked {filename} as failed: {reason}")
            return status

    def reset_status(self, filename):
        blob_client = self._get_blob_client(filename)
        try:
            if blob_client.exists():
                blob_client.delete_blob()
                print(f"[StatusManager] Reset status for {filename} (deleted status blob)")
            else:
                print(f"[StatusManager] No existing status for {filename}")
        except Exception as e:
            print(f"[StatusManager] Warning: Failed to reset status for {filename}: {e}")

status_manager = StatusManager()
