import time
import asyncio
import gc
from app.services.azure_di import azure_di_service
from app.services.status_manager import status_manager
from app.services.blob_storage import get_container_client, generate_sas_url
from azure.storage.blob import generate_blob_sas, BlobSasPermissions
from azure.core.exceptions import HttpResponseError
from datetime import datetime, timedelta
from app.core.config import settings
import urllib.parse
import os
import json

class RobustAnalysisManager:
    """
    Manages robust document analysis (Production Grade):
    - Semaphore-based concurrency (no idle workers between batches).
    - Direct per-page JSON upload during chunk processing (no heavy finalize re-read).
    - Non-fatal status updates (ETag conflicts don't trigger expensive DI retries).
    - Per-chunk timeout (10min) and retry (2 attempts) for resilience.
    """

    # Safety limits
    MAX_PARALLEL_WORKERS = 5       # Cap concurrent Azure DI calls
    CHUNK_TIMEOUT_SEC = 600        # 10 minutes per chunk
    CHUNK_MAX_RETRIES = 2          # Retry failed chunks up to 2 times
    RETRY_BACKOFF_SEC = 15         # Base backoff between retries

    def __init__(self):
        self.CHUNK_SIZE = 10  # Default, overridden by local variable in run_analysis_loop

    def _compute_json_folder(self, blob_name, filename):
        """Compute the JSON folder path from blob_name."""
        json_parts = blob_name.split('/')
        known_folders = ["temp", "my-documents", "documents", "drawings"]
        matched_folder = None
        for folder in known_folders:
            if folder in json_parts:
                matched_folder = folder
                break

        if matched_folder:
            f_idx = json_parts.index(matched_folder)
            json_parts[f_idx] = "json"
            base_name = os.path.splitext(json_parts[-1])[0]
            json_parts[-1] = base_name
            return "/".join(json_parts)
        else:
            if len(json_parts) > 1:
                return f"{json_parts[0]}/json/{os.path.splitext(filename)[0]}"
            else:
                return f"json/{os.path.splitext(filename)[0]}"

    async def run_analysis_loop(self, filename: str, blob_name: str, total_pages: int, category: str, local_file_path: str = None, username: str = None):
        """
        Executes the Optimized Analysis Loop with semaphore-based concurrency.
        """
        try:
            print(f"[RobustAnalysis] Starting loop for {filename} (Pages: {total_pages}, User: {username}, Local: {local_file_path})", flush=True)

            # ALWAYS Generate SAS URL for Azure DI (Azure-to-Azure transfer is faster/stable)
            container_client = get_container_client()
            account_name = container_client.account_name
            account_key = None

            # Credential extraction logic
            if hasattr(container_client.credential, 'account_key'):
                account_key = container_client.credential.account_key
            elif isinstance(container_client.credential, dict) and 'account_key' in container_client.credential:
                account_key = container_client.credential['account_key']
            else:
                conn_str = settings.AZURE_BLOB_CONNECTION_STRING
                if conn_str:
                    for part in conn_str.split(';'):
                        if 'AccountKey=' in part:
                            account_key = part.split('AccountKey=')[1]
                            break

            sas_token = None
            if account_key:
                sas_token = generate_blob_sas(
                    account_name=account_name,
                    container_name=settings.AZURE_BLOB_CONTAINER_NAME,
                    blob_name=blob_name,
                    account_key=account_key,
                    permission=BlobSasPermissions(read=True),
                    expiry=datetime.utcnow() + timedelta(hours=4)
                )
            elif settings.AZURE_BLOB_SAS_TOKEN:
                    from app.services.blob_storage import _clean_sas_token
                    sas_token = _clean_sas_token(settings.AZURE_BLOB_SAS_TOKEN)

            if not sas_token:
                raise Exception("Could not generate SAS token")

            encoded_blob_name = urllib.parse.quote(blob_name, safe="/~-_.")
            blob_url = f"https://{account_name}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{encoded_blob_name}?{sas_token}"
            print(f"[RobustAnalysis] SAS URL Ready: {blob_url[:60]}...", flush=True)

            # Compute json_folder upfront for direct page uploads
            json_folder = self._compute_json_folder(blob_name, filename)
            print(f"[RobustAnalysis] JSON folder: {json_folder}/", flush=True)

            # 2. Check Progress
            status = status_manager.get_status(filename, username=username)
            completed_chunks = set(status.get("completed_chunks", [])) if status else set()

            # Dynamic scaling based on document size
            if total_pages <= 100:
                chunk_size = 50
            else:
                chunk_size = 100
            parallel_workers = min(5, self.MAX_PARALLEL_WORKERS)

            print(f"[RobustAnalysis] Dynamic config: {total_pages} pages → ChunkSize={chunk_size}, Workers={parallel_workers}", flush=True)

            # 3. Build Pending Chunks
            total_chunks = (total_pages + chunk_size - 1) // chunk_size
            pending_chunks = []

            for i in range(total_chunks):
                start_page = i * chunk_size + 1
                end_page = min((i + 1) * chunk_size, total_pages)
                page_range = f"{start_page}-{end_page}"

                if page_range not in completed_chunks:
                    pending_chunks.append(page_range)

            print(f"[RobustAnalysis] {len(pending_chunks)} chunks to process (out of {total_chunks}) | ChunkSize: {chunk_size}", flush=True)

            # 4. Process chunks with SEMAPHORE-based concurrency (no idle workers)
            failed_chunks = []
            semaphore = asyncio.Semaphore(parallel_workers)
            completed_count = 0

            async def process_with_semaphore(page_range):
                nonlocal completed_count
                async with semaphore:
                    result = await self._process_chunk_with_retry(
                        filename, blob_name, blob_url, local_file_path,
                        page_range, category, username, json_folder
                    )
                    completed_count += 1
                    print(f"[RobustAnalysis] Progress: {completed_count}/{len(pending_chunks)} chunks done", flush=True)
                    return result

            # Submit ALL chunks at once - semaphore controls concurrency
            tasks = [process_with_semaphore(pr) for pr in pending_chunks]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            # Check results
            for i, res in enumerate(results):
                if isinstance(res, Exception):
                    print(f"[RobustAnalysis] Chunk {pending_chunks[i]} FAILED after retries: {res}", flush=True)
                    failed_chunks.append(pending_chunks[i])

            ok_count = len(pending_chunks) - len(failed_chunks)
            print(f"[RobustAnalysis] All chunks done: {ok_count}/{len(pending_chunks)} succeeded", flush=True)
            gc.collect()

            # 5. Check if ALL chunks failed - abort without finalize
            if ok_count == 0:
                error_msg = f"All {len(pending_chunks)} chunks failed for {filename}. Aborting finalize."
                print(f"[RobustAnalysis] {error_msg}", flush=True)
                self._mark_error(filename, error_msg, username)
                return

            if failed_chunks:
                print(f"[RobustAnalysis] WARNING: {len(failed_chunks)} chunks failed: {failed_chunks}", flush=True)

            # 6. Finalize (lightweight: meta.json + PDF move + cleanup)
            status_manager.mark_finalizing(filename, username=username)
            await self.finalize_analysis(filename, category, blob_name, total_pages, username, json_folder)

        except Exception as e:
            print(f"[RobustAnalysis] Critical Failure: {e}", flush=True)
            import traceback
            traceback.print_exc()
            self._mark_error(filename, f"Critical System Error: {str(e)}", username)

    async def _process_chunk_with_retry(self, filename: str, blob_name: str, master_blob_url: str, local_file_path: str, page_range: str, category: str, username: str = None, json_folder: str = None):
        """
        Wraps _process_chunk with timeout and retry logic.
        - Timeout: CHUNK_TIMEOUT_SEC per attempt
        - Retries: CHUNK_MAX_RETRIES times with backoff
        """
        last_error = None
        for attempt in range(self.CHUNK_MAX_RETRIES + 1):
            try:
                result = await asyncio.wait_for(
                    self._process_chunk(filename, blob_name, master_blob_url, local_file_path, page_range, category, username, json_folder),
                    timeout=self.CHUNK_TIMEOUT_SEC
                )
                return result
            except asyncio.TimeoutError:
                last_error = TimeoutError(f"Chunk {page_range} timed out after {self.CHUNK_TIMEOUT_SEC}s (attempt {attempt + 1})")
                print(f"[Chunk] TIMEOUT: {page_range} (attempt {attempt + 1}/{self.CHUNK_MAX_RETRIES + 1})", flush=True)
            except Exception as e:
                last_error = e
                print(f"[Chunk] ERROR: {page_range} (attempt {attempt + 1}/{self.CHUNK_MAX_RETRIES + 1}): {e}", flush=True)

            if attempt < self.CHUNK_MAX_RETRIES:
                backoff = self.RETRY_BACKOFF_SEC * (attempt + 1)
                print(f"[Chunk] Retrying {page_range} in {backoff}s...", flush=True)
                await asyncio.sleep(backoff)

        raise last_error

    async def _process_chunk(self, filename: str, blob_name: str, master_blob_url: str, local_file_path: str, page_range: str, category: str, username: str = None, json_folder: str = None):
        """
        Processes a single chunk:
        1. Azure DI extraction
        2. Direct per-page JSON upload (parallel)
        3. Save chunk JSON + status update (non-fatal)
        4. Index/embed
        """
        try:
            print(f"[Chunk] Processing {page_range}...", flush=True)

            target_url = master_blob_url

            print(f"[Chunk] Calling Azure DI for {page_range} (Direct Stream)...", flush=True)

            loop = asyncio.get_running_loop()
            from app.services.azure_di import azure_di_service

            chunks = await loop.run_in_executor(
                None,
                lambda: azure_di_service.analyze_document_from_url(
                    document_url=target_url,
                    pages=page_range
                )
            )

            # CRITICAL: Validate chunks are not empty
            if not chunks or len(chunks) == 0:
                error_msg = f"Azure DI returned ZERO pages for {page_range}. API call succeeded but extracted no data!"
                print(f"[Chunk] FAILED: {error_msg}", flush=True)
                raise Exception(error_msg)

            print(f"[Chunk] OK: Azure DI extracted {len(chunks)} pages for {page_range}", flush=True)

            # 2. Upload per-page JSONs directly (parallel, 10 threads)
            if json_folder:
                from concurrent.futures import ThreadPoolExecutor, as_completed
                container_client = get_container_client()

                def upload_page(page_data, page_num):
                    page_blob_name = f"{json_folder}/page_{page_num}.json"
                    page_json = json.dumps(page_data, ensure_ascii=False)
                    page_client = container_client.get_blob_client(page_blob_name)
                    page_client.upload_blob(page_json, overwrite=True)
                    return page_num

                uploaded = []
                with ThreadPoolExecutor(max_workers=10) as executor:
                    futures = {}
                    for idx, page in enumerate(chunks):
                        pn = page.get("page_number", idx + 1)
                        futures[executor.submit(upload_page, page, pn)] = pn
                    for f in as_completed(futures):
                        try:
                            uploaded.append(f.result())
                        except Exception as e:
                            print(f"[Chunk] Page upload error in {page_range}: {e}", flush=True)

                print(f"[Chunk] Uploaded {len(uploaded)} page JSONs for {page_range}", flush=True)

            # 3. Update status only (page JSONs already uploaded — skip 17MB chunk JSON blob)
            try:
                status_manager.update_chunk_progress(filename, page_range, username=username)
                print(f"[Chunk] Status updated for {page_range}", flush=True)
            except Exception as e:
                print(f"[Chunk] Warning: Status update failed for {page_range} (pages already uploaded): {e}", flush=True)

            # 4. Index
            try:
                from app.services.azure_search import azure_search_service
                print(f"[Chunk] Indexing {len(chunks)} pages for {page_range}...", flush=True)
                azure_search_service.index_documents(filename, category, chunks, blob_name=blob_name)
            except Exception as e:
                print(f"[Chunk] Indexing Warning for {page_range}: {e}", flush=True)

            return True

        except Exception as e:
            print(f"[Chunk] Failed {page_range}: {e}", flush=True)
            raise e

    def _save_chunk_result(self, filename, page_range, chunks, username=None):
        """Legacy: only used if chunk JSON blob is needed for backward compat."""
        from app.services.blob_storage import get_container_client
        container_client = get_container_client()
        part_name = f"temp/json/{filename}_part_{page_range}.json"

        json_content = json.dumps(chunks, ensure_ascii=False, indent=2)

        blob_client = container_client.get_blob_client(part_name)
        blob_client.upload_blob(json_content, overwrite=True)

        status_manager.update_chunk_progress(filename, page_range, username=username)
        print(f"[Chunk] Saved JSON for {page_range}", flush=True)

    def _mark_error(self, filename, message, username=None):
        try:
            status_manager.mark_failed(filename, message, username=username)
        except Exception as e:
            print(f"Failed to mark error: {e}", flush=True)

    async def finalize_analysis(self, filename: str, category: str, blob_name: str, total_pages: int, username: str = None, json_folder: str = None):
        """
        Lightweight finalize: page JSONs already uploaded during chunk processing.
        Just creates meta.json, moves PDF, and cleans up temp chunks.
        """
        pdf_moved = False
        final_blob_name = None

        try:
            print(f"[Finalize] Starting for {filename}...", flush=True)
            container_client = get_container_client()

            if not json_folder:
                json_folder = self._compute_json_folder(blob_name, filename)

            # ── Step 1: Discover uploaded page JSONs ──
            page_blobs = list(container_client.list_blobs(name_starts_with=f"{json_folder}/page_"))
            page_numbers = []
            for blob in page_blobs:
                name = blob.name.split('/')[-1]  # "page_123.json"
                try:
                    num = int(name.replace("page_", "").replace(".json", ""))
                    page_numbers.append(num)
                except (ValueError, AttributeError):
                    pass

            page_numbers.sort()
            print(f"[Finalize] Found {len(page_numbers)} page JSONs in {json_folder}/", flush=True)

            if len(page_numbers) == 0:
                raise Exception(f"No page JSONs found in {json_folder}/ - cannot finalize")

            if len(page_numbers) < total_pages:
                print(f"[Finalize] WARNING: Partial result - {len(page_numbers)}/{total_pages} pages", flush=True)

            # ── Step 2: Upload meta.json ──
            meta = {
                "total_pages": len(page_numbers),
                "pages": page_numbers,
                "format": "split",
                "version": 2
            }
            meta_blob_name = f"{json_folder}/meta.json"
            meta_client = container_client.get_blob_client(meta_blob_name)
            meta_client.upload_blob(json.dumps(meta, ensure_ascii=False), overwrite=True)
            print(f"[Finalize] meta.json saved: {meta_blob_name} ({len(page_numbers)} pages)", flush=True)

            # ── Step 3: Move PDF ONLY after meta.json is saved ──
            parts = blob_name.split('/')
            if "temp" in parts:
                idx = parts.index("temp")
                parts[idx] = category
                final_blob_name = "/".join(parts)
            else:
                category_folders = ["my-documents", "documents", "drawings"]
                replaced = False
                for folder in category_folders:
                    if folder in parts:
                        f_idx = parts.index(folder)
                        parts[f_idx] = category
                        final_blob_name = "/".join(parts)
                        replaced = True
                        break
                if not replaced:
                    final_blob_name = blob_name

            if blob_name == final_blob_name:
                print(f"[Finalize] PDF already at final location: {final_blob_name} (skip move)", flush=True)
                pdf_moved = True
            else:
                source_sas_url = generate_sas_url(blob_name)
                dest_blob = container_client.get_blob_client(final_blob_name)

                source_blob = container_client.get_blob_client(blob_name)
                if source_blob.exists():
                    dest_blob.start_copy_from_url(source_sas_url)
                    for _ in range(120):
                        props = dest_blob.get_blob_properties()
                        copy_status = props.copy.status
                        if copy_status == 'success':
                            source_blob.delete_blob()
                            pdf_moved = True
                            print(f"[Finalize] PDF moved to {final_blob_name}", flush=True)
                            break
                        elif copy_status == 'failed':
                            raise Exception(f"PDF copy failed: {props.copy.status_description}")
                        await asyncio.sleep(0.5)

                    if not pdf_moved:
                        print(f"[Finalize] WARNING: PDF copy timed out, but JSON is saved. PDF stays in temp.", flush=True)

            # ── Step 4: Mark completed (json_location = folder path) ──
            status_manager.mark_completed(filename, json_location=json_folder, username=username)
            print(f"[Finalize] Complete.", flush=True)

            # ── Step 5: Cleanup any leftover temp chunk blobs (best-effort) ──
            try:
                leftover = list(container_client.list_blobs(name_starts_with=f"temp/json/{filename}_part_"))
                if leftover:
                    print(f"[Finalize] Cleaning up {len(leftover)} leftover temp blobs...", flush=True)
                    for blob in leftover:
                        try:
                            container_client.get_blob_client(blob.name).delete_blob()
                        except Exception:
                            pass
                    print(f"[Finalize] Cleanup done.", flush=True)
            except Exception:
                pass

        except Exception as e:
            print(f"[Finalize] Failed: {e}", flush=True)
            import traceback
            traceback.print_exc()

            # ── Rollback: delete meta.json only (keep page JSONs for retry) ──
            if json_folder:
                try:
                    meta_client = container_client.get_blob_client(f"{json_folder}/meta.json")
                    if meta_client.exists():
                        meta_client.delete_blob()
                        print(f"[Finalize] Rollback: deleted meta.json", flush=True)
                except Exception as rb_err:
                    print(f"[Finalize] Rollback warning: {rb_err}", flush=True)

            # Retry finalize only (page JSONs are intact, just need meta.json + PDF move)
            status = status_manager.get_status(filename, username=username)
            retry_count = status.get("retry_count", 0) if status else 0

            if retry_count < 3:
                print(f"[Finalize] Retrying ({retry_count + 1}/3)...", flush=True)
                status_manager.increment_retry(filename, username=username)
                await self.finalize_analysis(filename, category, blob_name, total_pages, username, json_folder)
            else:
                print(f"[Finalize] Max retries (3) exceeded for {filename}", flush=True)
                status_manager.mark_failed(filename, f"Finalize failed after 3 attempts: {str(e)}", username=username)

robust_analysis_manager = RobustAnalysisManager()
