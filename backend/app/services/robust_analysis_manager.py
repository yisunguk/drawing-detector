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
    - Uses Azure Form Recognizer SDK (via AzureDIService) for stable URL analysis.
    - Optimized: Supports Local File Caching + Parallel Processing.
    - Max 5 concurrent workers to prevent OOM on Cloud Run (8Gi).
    - Per-chunk timeout (10min) and retry (2 attempts) for resilience.
    - Saves progress incrementally via StatusManager (ETag-safe).
    """

    # Safety limits
    MAX_PARALLEL_WORKERS = 5       # Cap concurrent Azure DI calls
    CHUNK_TIMEOUT_SEC = 600        # 10 minutes per chunk
    CHUNK_MAX_RETRIES = 2          # Retry failed chunks up to 2 times
    RETRY_BACKOFF_SEC = 30         # Base backoff between retries

    def __init__(self):
        self.CHUNK_SIZE = 10  # Default, overridden by local variable in run_analysis_loop

    async def run_analysis_loop(self, filename: str, blob_name: str, total_pages: int, category: str, local_file_path: str = None, username: str = None):
        """
        Executes the Optimized Analysis Loop.
        """
        try:
            print(f"[RobustAnalysis] Starting loop for {filename} (Pages: {total_pages}, User: {username}, Local: {local_file_path})")

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
            print(f"[RobustAnalysis] SAS URL Ready: {blob_url[:60]}...")

            # 2. Check Progress
            status = status_manager.get_status(filename, username=username)
            completed_chunks = set(status.get("completed_chunks", [])) if status else set()

            # Dynamic scaling based on document size (workers capped at MAX_PARALLEL_WORKERS)
            # Use LOCAL variable to avoid mutating singleton state during concurrent analyses
            if total_pages <= 100:
                chunk_size = 50
            else:
                chunk_size = 100
            parallel_workers = min(5, self.MAX_PARALLEL_WORKERS)

            print(f"[RobustAnalysis] Dynamic config: {total_pages} pages → ChunkSize={chunk_size}, Workers={parallel_workers}")

            # 3. Build Pending Chunks
            total_chunks = (total_pages + chunk_size - 1) // chunk_size
            pending_chunks = []

            for i in range(total_chunks):
                start_page = i * chunk_size + 1
                end_page = min((i + 1) * chunk_size, total_pages)
                page_range = f"{start_page}-{end_page}"

                if page_range not in completed_chunks:
                    pending_chunks.append(page_range)

            print(f"[RobustAnalysis] {len(pending_chunks)} chunks to process (out of {total_chunks}) | ChunkSize: {chunk_size}")
            print(f"[RobustAnalysis] Pending list: {pending_chunks}")

            # 4. Process chunks in PARALLEL batches (with per-chunk timeout & retry)
            failed_chunks = []
            total_batches = (len(pending_chunks) + parallel_workers - 1) // parallel_workers

            for batch_start in range(0, len(pending_chunks), parallel_workers):
                batch = pending_chunks[batch_start:batch_start + parallel_workers]
                batch_num = batch_start // parallel_workers + 1
                print(f"[RobustAnalysis] ========== Batch {batch_num}/{total_batches}: {batch} ==========")

                # Create tasks with timeout wrapper for this batch
                tasks = [
                    self._process_chunk_with_retry(
                        filename, blob_name, blob_url, local_file_path, page_range, category, username
                    )
                    for page_range in batch
                ]

                # Wait for batch - each task has its own timeout/retry
                results = await asyncio.gather(*tasks, return_exceptions=True)

                # Check results
                batch_ok = 0
                for i, res in enumerate(results):
                    if isinstance(res, Exception):
                        print(f"[RobustAnalysis] Chunk {batch[i]} FAILED after retries: {res}")
                        failed_chunks.append(batch[i])
                    else:
                        batch_ok += 1

                print(f"[RobustAnalysis] Batch {batch_num} done: {batch_ok}/{len(batch)} succeeded")

                # Free memory between batches
                gc.collect()

            # 5. Check if ALL chunks failed - abort without finalize
            status = status_manager.get_status(filename, username=username)
            completed_chunks = status.get("completed_chunks", []) if status else []

            if len(completed_chunks) == 0:
                error_msg = f"All {len(pending_chunks)} chunks failed for {filename}. Aborting finalize (PDF stays in temp)."
                print(f"[RobustAnalysis] {error_msg}")
                self._mark_error(filename, error_msg, username)
                return

            if failed_chunks:
                print(f"[RobustAnalysis] WARNING: {len(failed_chunks)} chunks failed: {failed_chunks}")
                print(f"[RobustAnalysis] {len(completed_chunks)}/{total_chunks} chunks succeeded. Proceeding with partial results.")

            # 6. Finalize (JSON validation → JSON save → PDF move)
            status_manager.mark_finalizing(filename, username=username)
            await self.finalize_analysis(filename, category, blob_name, total_pages, username)

        except Exception as e:
            print(f"[RobustAnalysis] Critical Failure: {e}")
            import traceback
            traceback.print_exc()
            self._mark_error(filename, f"Critical System Error: {str(e)}", username)

    async def _process_chunk_with_retry(self, filename: str, blob_name: str, master_blob_url: str, local_file_path: str, page_range: str, category: str, username: str = None):
        """
        Wraps _process_chunk with timeout and retry logic.
        - Timeout: CHUNK_TIMEOUT_SEC per attempt
        - Retries: CHUNK_MAX_RETRIES times with exponential backoff
        """
        last_error = None
        for attempt in range(self.CHUNK_MAX_RETRIES + 1):
            try:
                result = await asyncio.wait_for(
                    self._process_chunk(filename, blob_name, master_blob_url, local_file_path, page_range, category, username),
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

    async def _process_chunk(self, filename: str, blob_name: str, master_blob_url: str, local_file_path: str, page_range: str, category: str, username: str = None):
        """
        Processes a single chunk:
        1. Analyze the master PDF URL with page range (Direct Streaming).
        2. Save JSON & Index.
        """
        try:
            print(f"[Chunk] Processing {page_range}...")

            target_url = master_blob_url

            print(f"[Chunk] Calling Azure DI for {page_range} (Direct Stream)...")
            print(f"[Chunk] URL: {target_url[:60]}...")

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
                print(f"[Chunk] FAILED: {error_msg}")
                raise Exception(error_msg)

            print(f"[Chunk] OK: Azure DI extracted {len(chunks)} pages for {page_range}")

            # 3. Save JSON
            self._save_chunk_result(filename, page_range, chunks, username)

            # 4. Index
            try:
                from app.services.azure_search import azure_search_service
                print(f"[Chunk] Indexing {len(chunks)} pages for {page_range}...")
                azure_search_service.index_documents(filename, category, chunks, blob_name=blob_name)
            except Exception as e:
                print(f"[Chunk] Indexing Warning for {page_range}: {e}")

            return True

        except Exception as e:
            print(f"[Chunk] Failed {page_range}: {e}")
            raise e

    def _save_chunk_result(self, filename, page_range, chunks, username=None):
        from app.services.blob_storage import get_container_client
        container_client = get_container_client()
        part_name = f"temp/json/{filename}_part_{page_range}.json"

        json_content = json.dumps(chunks, ensure_ascii=False, indent=2)

        blob_client = container_client.get_blob_client(part_name)
        blob_client.upload_blob(json_content, overwrite=True)

        # Update Status Manager (with username for scoped status)
        status_manager.update_chunk_progress(filename, page_range, username=username)
        print(f"[Chunk] Saved JSON for {page_range}")

    def _mark_error(self, filename, message, username=None):
        try:
            status_manager.mark_failed(filename, message, username=username)
        except Exception as e:
            print(f"Failed to mark error: {e}")

    async def finalize_analysis(self, filename: str, category: str, blob_name: str, total_pages: int, username: str = None):
        """
        Merges results and cleans up using STREAMING to avoid OOM.
        Writes chunks one-by-one to /tmp file, then uploads to blob.
        CORRECT ORDER: Stream JSON to /tmp → Upload → Move PDF → Cleanup
        """
        import tempfile

        json_blob_name = None
        json_saved = False
        pdf_moved = False
        final_blob_name = None
        tmp_path = None

        try:
            print(f"[RobustAnalysis] Finalizing {filename} (streaming mode)...")
            container_client = get_container_client()

            status = status_manager.get_status(filename, username=username)
            chunks_list = status.get("completed_chunks", [])

            # Sort chunks by page range for correct ordering
            chunks_list_sorted = sorted(chunks_list, key=lambda x: int(x.split("-")[0]))

            # ── Step 1: Stream chunk JSONs to /tmp file (one at a time, low memory) ──
            valid_chunks = []
            total_page_count = 0

            tmp_fd, tmp_path = tempfile.mkstemp(suffix=".json", prefix="finalize_")
            os.close(tmp_fd)

            print(f"[RobustAnalysis] Streaming {len(chunks_list_sorted)} chunks to {tmp_path}...", flush=True)

            with open(tmp_path, "w", encoding="utf-8") as f:
                f.write("[\n")
                first_page = True

                for chunk_range in chunks_list_sorted:
                    part_name = f"temp/json/{filename}_part_{chunk_range}.json"
                    blob_client = container_client.get_blob_client(part_name)

                    if not blob_client.exists():
                        print(f"[RobustAnalysis] Warning: Chunk blob missing: {part_name}")
                        continue

                    try:
                        # Download and parse one chunk at a time
                        data = blob_client.download_blob().readall()
                        pages = json.loads(data)
                        del data  # Free memory immediately

                        for page in pages:
                            if not first_page:
                                f.write(",\n")
                            json.dump(page, f, ensure_ascii=False)
                            first_page = False
                            total_page_count += 1

                        del pages  # Free memory
                        valid_chunks.append(chunk_range)
                        gc.collect()

                    except Exception as e:
                        print(f"[RobustAnalysis] Warning: Failed to read chunk {chunk_range}: {e}")

                f.write("\n]")

            file_size = os.path.getsize(tmp_path)
            print(f"[RobustAnalysis] Streaming done: {total_page_count} pages, {file_size:,} bytes")

            # ── Step 2: Validate ──
            if total_page_count == 0:
                error_msg = f"DI analysis completed but extracted 0 pages for {filename}"
                print(f"[RobustAnalysis] VALIDATION FAILED: {error_msg}")
                raise Exception(error_msg)

            if total_page_count < total_pages:
                print(f"[RobustAnalysis] WARNING: Partial result - {total_page_count}/{total_pages} pages")

            if file_size < 100:
                error_msg = f"JSON too small ({file_size} bytes) - analysis incomplete"
                print(f"[RobustAnalysis] VALIDATION FAILED: {error_msg}")
                raise Exception(error_msg)

            print(f"[RobustAnalysis] Validation passed: {total_page_count}/{total_pages} pages, {file_size:,} bytes")

            # ── Step 3: Determine JSON blob path ──
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
                json_parts[-1] = f"{base_name}.json"
                json_blob_name = "/".join(json_parts)
            else:
                if len(json_parts) > 1:
                    json_blob_name = f"{json_parts[0]}/json/{os.path.splitext(filename)[0]}.json"
                else:
                    json_blob_name = f"json/{os.path.splitext(filename)[0]}.json"

            # ── Step 4: Upload from /tmp file (streaming upload, not in-memory) ──
            print(f"[RobustAnalysis] Uploading {file_size:,} bytes to {json_blob_name}...")
            json_client = container_client.get_blob_client(json_blob_name)
            with open(tmp_path, "rb") as f:
                json_client.upload_blob(f, overwrite=True, max_concurrency=4)
            json_saved = True
            print(f"[RobustAnalysis] Unified JSON Saved: {json_blob_name}")

            # ── Step 5: Move PDF ONLY after JSON is saved ──
            parts = blob_name.split('/')
            if "temp" in parts:
                idx = parts.index("temp")
                parts[idx] = category
                final_blob_name = "/".join(parts)
            else:
                # PDF already in non-temp location - preserve username prefix
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

            # Skip move if source and destination are the same
            if blob_name == final_blob_name:
                print(f"[RobustAnalysis] PDF already at final location: {final_blob_name} (skip move)")
                pdf_moved = True
            else:
                # C2 FIX: Use SAS-authenticated URL for copy source (private container requires auth)
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
                            print(f"[RobustAnalysis] PDF moved to {final_blob_name}")
                            break
                        elif copy_status == 'failed':
                            raise Exception(f"PDF copy failed: {props.copy.status_description}")
                        await asyncio.sleep(0.5)

                    if not pdf_moved:
                        print(f"[RobustAnalysis] WARNING: PDF copy timed out, but JSON is saved. PDF stays in temp.")

            # ── Step 6: Mark completed ──
            status_manager.mark_completed(filename, json_location=json_blob_name, username=username)
            print(f"[RobustAnalysis] Finalization Complete.")

            # ── Step 7: Cleanup temp chunks (ONLY after everything succeeded) ──
            print(f"[RobustAnalysis] Cleaning up {len(valid_chunks)} chunks...")
            for c in valid_chunks:
                try:
                    part_name = f"temp/json/{filename}_part_{c}.json"
                    container_client.get_blob_client(part_name).delete_blob()
                except Exception as e:
                    print(f"[RobustAnalysis] Warning: Failed to cleanup chunk {c}: {e}")

            print(f"[RobustAnalysis] Cleanup done.")

            # Cleanup tmp file
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)

        except Exception as e:
            print(f"[RobustAnalysis] Finalize Failed: {e}")
            import traceback
            traceback.print_exc()

            # Cleanup tmp file on error
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass

            # ── Rollback: delete JSON if it was saved but PDF move failed ──
            if json_saved and not pdf_moved and json_blob_name:
                try:
                    container_client = get_container_client()
                    container_client.get_blob_client(json_blob_name).delete_blob()
                    print(f"[RobustAnalysis] Rollback: deleted JSON {json_blob_name}")
                except Exception as rb_err:
                    print(f"[RobustAnalysis] Rollback warning: {rb_err}")

            # Retry finalize only (do NOT reset completed_chunks - they are valid data!)
            status = status_manager.get_status(filename, username=username)
            retry_count = status.get("retry_count", 0) if status else 0

            if retry_count < 3:
                print(f"[RobustAnalysis] Retrying finalize ({retry_count + 1}/3)...")
                status_manager.increment_retry(filename, username=username)
                # Re-run finalize only - completed_chunks are preserved
                await self.finalize_analysis(filename, category, blob_name, total_pages, username)
            else:
                print(f"[RobustAnalysis] Max finalize retries (3) exceeded for {filename}")
                status_manager.mark_failed(filename, f"Finalize failed after 3 attempts: {str(e)}", username=username)

robust_analysis_manager = RobustAnalysisManager()
