import time
import asyncio
from app.services.azure_di import azure_di_service
from app.services.status_manager import status_manager
from app.services.blob_storage import get_container_client
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
    - STRICTLY avoids sequential bottlenecks.
    - Saves progress incrementally via StatusManager.
    """
    
    def __init__(self):
        # PAID TIER: Azure DI Standard has 50MB limit
        # With 234KB/page average:
        # 50 pages = ~11.7MB (WORKS for Paid Tier)
        # 200 pages = ~46.8MB (WORKS for Paid Tier)
        # Using 10 for better user feedback (more frequent updates)
        # Performance impact is minimal due to parallelization
        self.CHUNK_SIZE = 10

    async def run_analysis_loop(self, filename: str, blob_name: str, total_pages: int, category: str, local_file_path: str = None):
        """
        Executes the Optimized Analysis Loop.
        """
        try:
            print(f"[RobustAnalysis] Starting loop for {filename} (Pages: {total_pages}, Local: {local_file_path})")
            
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
                    sas_token = settings.AZURE_BLOB_SAS_TOKEN.strip()
                    if sas_token.startswith("?"): sas_token = sas_token[1:]

            if not sas_token:
                raise Exception("Could not generate SAS token")
                
            encoded_blob_name = urllib.parse.quote(blob_name, safe="/~-_.")
            blob_url = f"https://{account_name}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{encoded_blob_name}?{sas_token}"
            print(f"[RobustAnalysis] SAS URL Ready: {blob_url[:60]}...")

            # 2. Check Progress
            status = status_manager.get_status(filename)
            completed_chunks = set(status.get("completed_chunks", [])) if status else set()
            
            # Optimized for Speed:
            # Large chunks (150) to minimize API calls.
            # High Parallelism (10) to saturate Azure DI capacity.
            self.CHUNK_SIZE = 150
            
            # 3. Build Pending Chunks
            total_chunks = (total_pages + self.CHUNK_SIZE - 1) // self.CHUNK_SIZE
            pending_chunks = []
            
            for i in range(total_chunks):
                start_page = i * self.CHUNK_SIZE + 1
                end_page = min((i + 1) * self.CHUNK_SIZE, total_pages)
                page_range = f"{start_page}-{end_page}"
                
                if page_range not in completed_chunks:
                    pending_chunks.append(page_range)
            
            print(f"[RobustAnalysis] {len(pending_chunks)} chunks to process (out of {total_chunks}) | ChunkSize: {self.CHUNK_SIZE}")
            print(f"[RobustAnalysis] Pending list: {pending_chunks}")
            
            # 4. Process chunks in PARALLEL batches
            parallel_workers = 10  # Max throughput for Azure DI paid tier
            failed_chunks = []

            for batch_start in range(0, len(pending_chunks), parallel_workers):
                batch = pending_chunks[batch_start:batch_start + parallel_workers]
                print(f"[RobustAnalysis] ========== Processing batch {batch_start//parallel_workers + 1}: {batch} ==========")

                # Create tasks for this batch
                tasks = [
                    self._process_chunk(filename, blob_name, blob_url, local_file_path, page_range, category)
                    for page_range in batch
                ]

                # Wait for batch
                results = await asyncio.gather(*tasks, return_exceptions=True)

                # Check results
                for i, res in enumerate(results):
                    if isinstance(res, Exception):
                        print(f"[RobustAnalysis] Chunk {batch[i]} FAILED: {res}")
                        failed_chunks.append(batch[i])

            # 5. Check if ALL chunks failed - abort without finalize
            status = status_manager.get_status(filename)
            completed_chunks = status.get("completed_chunks", []) if status else []

            if len(completed_chunks) == 0:
                error_msg = f"All {len(pending_chunks)} chunks failed for {filename}. Aborting finalize (PDF stays in temp)."
                print(f"[RobustAnalysis] {error_msg}")
                self._mark_error(filename, error_msg)
                return

            if failed_chunks:
                print(f"[RobustAnalysis] WARNING: {len(failed_chunks)} chunks failed: {failed_chunks}")
                print(f"[RobustAnalysis] {len(completed_chunks)}/{total_chunks} chunks succeeded. Proceeding with partial results.")

            # 6. Finalize (JSON validation → JSON save → PDF move)
            status_manager.mark_finalizing(filename)
            await self.finalize_analysis(filename, category, blob_name, total_pages)

        except Exception as e:
            print(f"[RobustAnalysis] Critical Failure: {e}")
            import traceback
            traceback.print_exc()
            self._mark_error(filename, f"Critical System Error: {str(e)}")

    async def _process_chunk(self, filename: str, blob_name: str, master_blob_url: str, local_file_path: str, page_range: str, category: str):
        """
        Processes a single chunk:
        1. Split PDF locally (create a small temporary PDF for just this chunk).
        2. Upload small PDF to Blob Storage (temp/).
        3. Analyze the small PDF URL (avoiding 'Image too large' on master file).
        4. Save JSON & Index.
        5. Cleanup small PDF.
        """
        chunk_blob_name = None
        try:
            print(f"[Chunk] Processing {page_range}...")
            
            # --- STRATEGY A: Direct Range Analysis (Streamed) ---
            # Bypasses local download/splitting to avoid OOM on large files.
            
            # 1. Generate SAS for the MASTER File (if not provided/expired)
            # We already have master_blob_url from run_analysis_loop
            target_url = master_blob_url
            
            # 2. Analyze Direct URL with 'pages' parameter
            # Azure DI will fetch only the bytes needed for these pages
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
            self._save_chunk_result(filename, page_range, chunks)
            
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

    def _save_chunk_result(self, filename, page_range, chunks):
        from app.services.blob_storage import get_container_client
        container_client = get_container_client()
        part_name = f"temp/json/{filename}_part_{page_range}.json"
        
        json_content = json.dumps(chunks, ensure_ascii=False, indent=2)
        
        blob_client = container_client.get_blob_client(part_name)
        blob_client.upload_blob(json_content, overwrite=True)
        
        # Update Status Manager
        status_manager.update_chunk_progress(filename, page_range)
        print(f"[Chunk] Saved JSON for {page_range}")

    def _mark_error(self, filename, message):
        try:
            status = status_manager.get_status(filename)
            if status:
                status["status"] = "error"
                status["error_message"] = message
                status_manager._get_blob_client(filename).upload_blob(json.dumps(status), overwrite=True)
        except Exception as e:
            print(f"Failed to mark error: {e}")

    async def finalize_analysis(self, filename: str, category: str, blob_name: str, total_pages: int):
        """
        Merges results and cleans up.
        CORRECT ORDER: Validate JSON → Save JSON → Move PDF → Cleanup
        PDF is moved ONLY after JSON is successfully saved.
        """
        json_blob_name = None
        json_saved = False
        pdf_moved = False
        final_blob_name = None

        try:
            print(f"[RobustAnalysis] Finalizing {filename}...")
            container_client = get_container_client()

            status = status_manager.get_status(filename)
            chunks_list = status.get("completed_chunks", [])

            # ── Step 1: Collect all completed chunk JSONs ──
            completed_pages = []
            valid_chunks = []

            for c in chunks_list:
                part_name = f"temp/json/{filename}_part_{c}.json"
                blob_client = container_client.get_blob_client(part_name)
                if blob_client.exists():
                    try:
                        data = blob_client.download_blob().readall()
                        partial_json = json.loads(data)
                        completed_pages.extend(partial_json)
                        valid_chunks.append(c)
                    except Exception as e:
                        print(f"[RobustAnalysis] Warning: Failed to read chunk {c}: {e}")
                else:
                    print(f"[RobustAnalysis] Warning: Chunk blob missing: {part_name}")

            completed_pages.sort(key=lambda x: x.get("page_number", 0))

            # ── Step 2: Validate JSON BEFORE any file movement ──
            if not completed_pages or len(completed_pages) == 0:
                error_msg = f"DI analysis completed but extracted 0 pages for {filename}"
                print(f"[RobustAnalysis] VALIDATION FAILED: {error_msg}")
                raise Exception(error_msg)

            if len(completed_pages) < total_pages:
                print(f"[RobustAnalysis] WARNING: Partial result - {len(completed_pages)}/{total_pages} pages extracted")

            final_json_content = json.dumps(completed_pages, ensure_ascii=False, indent=2)

            if len(final_json_content) < 100:
                error_msg = f"JSON too small ({len(final_json_content)} bytes) - analysis incomplete"
                print(f"[RobustAnalysis] VALIDATION FAILED: {error_msg}")
                raise Exception(error_msg)

            print(f"[RobustAnalysis] Validation passed: {len(completed_pages)}/{total_pages} pages, {len(final_json_content)} bytes")

            # ── Step 3: Save Final JSON (before moving PDF) ──
            json_parts = blob_name.split('/')
            known_folders = ["temp", "my_documents", "documents", "drawings"]
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

            json_client = container_client.get_blob_client(json_blob_name)
            json_client.upload_blob(final_json_content, overwrite=True)
            json_saved = True
            print(f"[RobustAnalysis] Unified JSON Saved: {json_blob_name}")

            # ── Step 4: Move PDF ONLY after JSON is saved ──
            parts = blob_name.split('/')
            if "temp" in parts:
                idx = parts.index("temp")
                parts[idx] = category
                final_blob_name = "/".join(parts)
            else:
                # PDF already in non-temp location - preserve username prefix
                category_folders = ["my_documents", "documents", "drawings"]
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
                source_blob = container_client.get_blob_client(blob_name)
                dest_blob = container_client.get_blob_client(final_blob_name)

                if source_blob.exists():
                    dest_blob.start_copy_from_url(source_blob.url)
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

            # ── Step 5: Mark completed ──
            status_manager.mark_completed(filename, json_location=json_blob_name)
            print(f"[RobustAnalysis] Finalization Complete.")

            # ── Step 6: Cleanup temp chunks (ONLY after everything succeeded) ──
            print(f"[RobustAnalysis] Cleaning up {len(valid_chunks)} chunks...")
            for c in valid_chunks:
                try:
                    part_name = f"temp/json/{filename}_part_{c}.json"
                    container_client.get_blob_client(part_name).delete_blob()
                except Exception as e:
                    print(f"[RobustAnalysis] Warning: Failed to cleanup chunk {c}: {e}")

            print(f"[RobustAnalysis] Cleanup done.")

        except Exception as e:
            print(f"[RobustAnalysis] Finalize Failed: {e}")

            # ── Rollback: delete JSON if it was saved but PDF move failed ──
            if json_saved and not pdf_moved and json_blob_name:
                try:
                    container_client = get_container_client()
                    container_client.get_blob_client(json_blob_name).delete_blob()
                    print(f"[RobustAnalysis] Rollback: deleted JSON {json_blob_name}")
                except Exception as rb_err:
                    print(f"[RobustAnalysis] Rollback warning: {rb_err}")

            # Retry logic - PDF is still in temp (never moved on failure)
            status = status_manager.get_status(filename)
            retry_count = status.get("retry_count", 0) if status else 0

            if retry_count < 3:
                print(f"[RobustAnalysis] Retrying ({retry_count + 1}/3)...")
                status_manager.increment_retry(filename)
                # Reset chunks for fresh re-analysis
                if status:
                    status["completed_chunks"] = []
                    blob_client = status_manager._get_blob_client(filename)
                    blob_client.upload_blob(json.dumps(status), overwrite=True)
                # Re-run - blob_name still points to temp (PDF was never moved)
                await self.run_analysis_loop(filename, blob_name, total_pages, category)
            else:
                print(f"[RobustAnalysis] Max retries (3) exceeded for {filename}")
                status_manager.mark_failed(filename, f"Analysis failed after 3 attempts: {str(e)}")

robust_analysis_manager = RobustAnalysisManager()
