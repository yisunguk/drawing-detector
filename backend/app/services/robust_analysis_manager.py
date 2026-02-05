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

class RobustAnalysisManager:
    """
    Manages robust document analysis (Production Grade):
    - Uses Azure Form Recognizer SDK (via AzureDIService) for stable URL analysis.
    - Implements Adaptive Chunking: Starts with 20 pages, splits recursively on failure.
    - Strictly avoids image rendering fallback for DI.
    - Saves progress via StatusManager.
    """
    
    def __init__(self):
        # Initial chunk size recommended for stability
        self.INITIAL_CHUNK_SIZE = 20

    async def run_analysis_loop(self, filename: str, blob_name: str, total_pages: int, category: str):
        """
        Executes the Adaptive Analysis Loop.
        """
        try:
            print(f"[RobustAnalysis] Starting loop for {filename} (Pages: {total_pages}, Blob: {blob_name})")
            
            # 1. Generate SAS URL
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
                    expiry=datetime.utcnow() + timedelta(hours=4) # Extended expiry for large jobs
                )
            elif settings.AZURE_BLOB_SAS_TOKEN:
                 sas_token = settings.AZURE_BLOB_SAS_TOKEN.strip()
                 if sas_token.startswith("?"): sas_token = sas_token[1:]

            if not sas_token:
                raise Exception("Could not generate SAS token")
                
            # Use safe quoting to preserve directory structure but encode components
            encoded_blob_name = urllib.parse.quote(blob_name, safe="/~()-_.")
            blob_url = f"https://{account_name}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{encoded_blob_name}?{sas_token}"
            # WARNING: Do NOT double-encode or replace spaces manually, quote() handles it.
            
            print(f"[RobustAnalysis] SAS URL Ready: {blob_url[:60]}... (Safe Encoded)")

            # 2. Check Progress
            status = status_manager.get_status(filename)
            completed_chunks = set(status.get("completed_chunks", [])) if status else set()
            
            # 3. Build Initial Pending Chunks (Standard Size)
            # Note: We only queue standard chunks. Adaptive splitting happens inside _process_chunk
            total_chunks = (total_pages + self.INITIAL_CHUNK_SIZE - 1) // self.INITIAL_CHUNK_SIZE
            pending_chunks = []
            
            # Let's map all completed pages
            completed_pages = set()
            for c_str in completed_chunks:
                s, e = map(int, c_str.split('-'))
                for p in range(s, e + 1):
                    completed_pages.add(p)
            
            for i in range(total_chunks):
                start_page = i * self.INITIAL_CHUNK_SIZE + 1
                end_page = min((i + 1) * self.INITIAL_CHUNK_SIZE, total_pages)
                
                # Check if this entire range is already processed (page by page)
                range_pages = set(range(start_page, end_page + 1))
                if not range_pages.issubset(completed_pages):
                    pending_chunks.append(f"{start_page}-{end_page}")
            
            print(f"[RobustAnalysis] {len(pending_chunks)} initial chunks to process")
            
            # 4. Process chunks (Sequential)
            for page_range in pending_chunks:
                await self._process_chunk_adaptive(filename, blob_url, page_range)
            
            # 5. Finalize
            # Reload status to confirm everything is done
            await self.finalize_analysis(filename, category, blob_name, total_pages)

        except Exception as e:
            print(f"[RobustAnalysis] Critical Failure: {e}")
            import traceback
            traceback.print_exc()
            self._mark_error(filename, f"Critical System Error: {str(e)}")

    async def _process_chunk_adaptive(self, filename: str, blob_url: str, page_range: str):
        """
        Adaptive Chunk Processing:
        Tries to process the range.
        If it fails (due to timeout, size, etc), it splits the range in half and retries recursively.
        Base case: 1 page (cannot split further).
        """
        # Check if already done (optimization for resume)
        status = status_manager.get_status(filename)
        if status and page_range in status.get("completed_chunks", []):
            print(f"[Adaptive] Chunk {page_range} already marked complete. Skipping.")
            return

        start, end = map(int, page_range.split('-'))
        page_count = end - start + 1
        
        try:
            print(f"[Adaptive] Processing chunk {page_range} (Size: {page_count})...")
            
            # Call Azure DI (Blocking call wrapped in thread)
            # Use the STABLE AzureDIService (Form Recognizer SDK)
            loop = asyncio.get_running_loop()
            
            # We use a lambda to call the synchronous service
            chunks = await loop.run_in_executor(
                None,
                lambda: azure_di_service.analyze_document_from_url(
                    document_url=blob_url,
                    pages=page_range
                )
            )
            
            # Success! Save it.
            self._save_chunk_result(filename, page_range, chunks)
            return

        except Exception as e:
            error_msg = str(e).lower()
            print(f"[Adaptive] Error processing {page_range}: {str(e)[:200]}...")
            
            # Decision: Retry, Split, or Fail?
            
            # If it's a single page, we can't split.
            if page_count <= 1:
                print(f"[Adaptive] Failed on single page {page_range}. Checking skip criteria...")
                
                # Broaden Skip Logic:
                # If it's a Client Error (4xx), it's likely a data issue (Invalid content, size, format).
                # Since we cannot split further and cannot render images (User Policy), we MUST SKIP.
                should_skip = False
                
                if isinstance(e, HttpResponseError):
                    # 400 Bad Request (InvalidRequest, InvalidContentLength)
                    # 401/403 Forbidden (Check later, but single page fail usually means resource issue)
                    # 422 Unprocessable Entity
                    if e.status_code and 400 <= e.status_code < 500:
                        should_skip = True
                
                # Fallback string check
                if not should_skip:
                     if "invalidcontentlength" in error_msg or "invalidrequest" in error_msg or "image is too large" in error_msg:
                        should_skip = True
                
                if should_skip:
                    print(f"[Adaptive] SKIPPING page {page_range} due to non-recoverable error: {error_msg[:100]}")
                    # Log skip? Ideally yes.
                    # Just return to continue loop.
                    return
                
                raise e
            
            # Split Strategy
            mid = start + (page_count // 2) - 1
            range_a = f"{start}-{mid}"
            range_b = f"{mid+1}-{end}"
            
            print(f"[Adaptive] Splitting {page_range} -> {range_a}, {range_b}")
            
            # Recursively process halves
            # We await individually to ensure order and error handling
            try:
                await self._process_chunk_adaptive(filename, blob_url, range_a)
                await self._process_chunk_adaptive(filename, blob_url, range_b)
                
            except Exception as child_e:
                # If a child fails (and couldn't be resolved), we escalate
                raise child_e

    def _save_chunk_result(self, filename, page_range, chunks):
        from app.services.blob_storage import get_container_client
        container_client = get_container_client()
        part_name = f"temp/json/{filename}_part_{page_range}.json"
        
        # Format might differ between services, but this saves whatever dict we got
        import json
        json_content = json.dumps(chunks, ensure_ascii=False, indent=2)
        
        blob_client = container_client.get_blob_client(part_name)
        blob_client.upload_blob(json_content, overwrite=True)
        
        # Update Status Manager
        status_manager.update_chunk_progress(filename, page_range)
        print(f"[Adaptive] Saved result for {page_range}")

    def _mark_error(self, filename, message):
        try:
            import json
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
        """
        try:
            print(f"[RobustAnalysis] Finalizing {filename}...")
            container_client = get_container_client()
            
            status = status_manager.get_status(filename)
            chunks_list = status.get("completed_chunks", [])
            
            # Collect all completed pages
            completed_pages = []
            for c in chunks_list:
                part_name = f"temp/json/{filename}_part_{c}.json"
                blob_client = container_client.get_blob_client(part_name)
                if blob_client.exists():
                    data = blob_client.download_blob().readall()
                    import json
                    partial_json = json.loads(data)
                    completed_pages.extend(partial_json)
                    blob_client.delete_blob() # Cleanup temp
            
            # Verify completeness
            unique_processed_pages = {p.get("page_number") for p in completed_pages}
            print(f"[RobustAnalysis] Assembled {len(unique_processed_pages)} unique pages out of {total_pages}")
            
            completed_pages.sort(key=lambda x: x.get("page_number", 0))

            # Move/Copy PDF to final location
            parts = blob_name.split('/')
            final_blob_name = ""
            if "temp" in parts:
                idx = parts.index("temp")
                parts[idx] = category
                final_blob_name = "/".join(parts)
            else:
                 final_blob_name = f"{category}/{filename}"

            print(f"[RobustAnalysis] Moving {blob_name} -> {final_blob_name}")
            source_blob = container_client.get_blob_client(blob_name)
            dest_blob = container_client.get_blob_client(final_blob_name)
            
            if source_blob.exists():
                dest_blob.start_copy_from_url(source_blob.url)
                # Simple poll for copy
                for _ in range(60):
                    props = dest_blob.get_blob_properties()
                    if props.copy.status == 'success':
                        source_blob.delete_blob()
                        break
                    elif props.copy.status == 'failed':
                         print("Blob copy failed")
                         break
                    await asyncio.sleep(0.5)

            # Save Final JSON
            # Infer JSON name from blob path structure
            json_parts = blob_name.split('/')
            if "temp" in json_parts:
                json_parts[json_parts.index("temp")] = "json"
                base_name = os.path.splitext(json_parts[-1])[0]
                json_parts[-1] = f"{base_name}.json"
                json_blob_name = "/".join(json_parts)
            else:
                 json_blob_name = f"json/{os.path.splitext(filename)[0]}.json"
                 
            json_client = container_client.get_blob_client(json_blob_name)
            import json
            final_json_content = json.dumps(completed_pages, ensure_ascii=False, indent=2)
            json_client.upload_blob(final_json_content, overwrite=True)
            print(f"[RobustAnalysis] JSON Saved: {json_blob_name}")
            
            # Indexing
            try:
                from app.services.azure_search import azure_search_service
                print(f"[RobustAnalysis] Indexing {len(completed_pages)} pages...")
                azure_search_service.index_documents(filename, category, completed_pages)
            except Exception as e:
                print(f"[RobustAnalysis] Indexing Failed (Non-blocking): {e}")

            status_manager.mark_completed(filename)
            print(f"[RobustAnalysis] Finalization Complete.")
            
        except Exception as e:
            print(f"[RobustAnalysis] Finalize Failed: {e}")

robust_analysis_manager = RobustAnalysisManager()
