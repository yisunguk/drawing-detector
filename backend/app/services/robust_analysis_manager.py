import time
import asyncio
from app.services.azure_di import azure_di_service
from app.services.status_manager import status_manager
from app.services.blob_storage import get_container_client
from azure.storage.blob import generate_blob_sas, BlobSasPermissions
from datetime import datetime, timedelta
from app.core.config import settings
import urllib.parse
import os

class RobustAnalysisManager:
    """
    Manages robust document analysis:
    - Runs the analysis loop (chunks)
    - Saves progress via StatusManager
    - Handles retries
    - Uses Azure Document Intelligence via SAS URL (no local rendering)
    """
    
    def __init__(self):
        pass

    async def run_analysis_loop(self, filename: str, blob_name: str, total_pages: int, category: str):
        """
        Executes the Chunked Analysis Loop using Azure DI via SAS URL.
        1. Generates SAS for the blob.
        2. Iterates in chunks of 50 pages.
        3. Calls DI directly (no local rendering).
        4. Handles Retries and Resume.
        """
        try:
            print(f"[RobustAnalysis] Starting loop for {filename} (Pages: {total_pages}, Blob: {blob_name})")
            
            # 1. Generate SAS URL
            container_client = get_container_client()
            
             # Get account key/name
            account_name = container_client.account_name
            account_key = None
            
            # Extract key from credential or connection string
            if hasattr(container_client.credential, 'account_key'):
                account_key = container_client.credential.account_key
            elif isinstance(container_client.credential, dict) and 'account_key' in container_client.credential:
                account_key = container_client.credential['account_key']
            else:
                # ConnectionString parsing if needed
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
                    expiry=datetime.utcnow() + timedelta(hours=2) # 2 hours expiry
                )
            elif settings.AZURE_BLOB_SAS_TOKEN:
                 sas_token = settings.AZURE_BLOB_SAS_TOKEN.strip()
                 if sas_token.startswith("?"): sas_token = sas_token[1:]

            if not sas_token:
                raise Exception("Could not generate SAS token (No Key or Env SAS)")
                
            blob_url = f"https://{account_name}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{urllib.parse.quote(blob_name)}?{sas_token}"
            
            # Normalize URL (fix spaces)
            blob_url = blob_url.replace(" ", "%20")
            
            print(f"[RobustAnalysis] SAS URL Ready: {blob_url[:60]}...")

            chunk_size = 50 
            total_chunks = (total_pages + chunk_size - 1) // chunk_size
            
            # 2. Load Existing Progress
            status = status_manager.get_status(filename)
            completed_chunks = set(status.get("completed_chunks", [])) if status else set()
            
            # 3. Build list of pending chunks
            pending_chunks = []
            for i in range(total_chunks):
                start_page = i * chunk_size + 1
                end_page = min((i + 1) * chunk_size, total_pages)
                page_range = f"{start_page}-{end_page}"
                
                if page_range not in completed_chunks:
                    pending_chunks.append(page_range)
            
            print(f"[RobustAnalysis] {len(pending_chunks)} chunks to process (out of {total_chunks})")
            
            # 4. Process chunks (Sequential as requested)
            for page_range in pending_chunks:
                await self._process_chunk_with_retry(filename, blob_url, page_range)
            
            # 5. Finalize
            status = status_manager.get_status(filename)
            current_completed = set(status.get("completed_chunks", []))
            all_ranges = {f"{i*chunk_size+1}-{min((i+1)*chunk_size, total_pages)}" for i in range(total_chunks)}
            
            # Check if we are done (allow for some fuzziness or manual check?)
            # Actually, let's just check if we have results for all chunks.
            if len(pending_chunks) > 0: 
                # Re-check status because we just finished processing
                status = status_manager.get_status(filename)
                current_completed = set(status.get("completed_chunks", []))
            
            if all_ranges.issubset(current_completed):
                print(f"[RobustAnalysis] All chunks executed. Finalizing...")
                await self.finalize_analysis(filename, category, blob_name)
            else:
                print(f"[RobustAnalysis] Loop finished but some chunks missing? {all_ranges - current_completed}")
                self._mark_error(filename, f"Loop finished but chunks missing: {list(all_ranges - current_completed)}")

        except Exception as e:
            print(f"[RobustAnalysis] Critical Failure: {e}")
            import traceback
            traceback.print_exc()
            self._mark_error(filename, f"Critical System Error: {str(e)}")

    async def _process_chunk_with_retry(self, filename: str, blob_url: str, page_range: str):
        """
        Process a single chunk with Retry Logic (User B) logic).
        """
        max_retries = 3
        from app.services.doc_intel_service import get_doc_intel_service
        doc_service = get_doc_intel_service()
        
        for retry in range(max_retries):
            try:
                print(f"[RobustAnalysis] Processing chunk {page_range} (Attempt {retry+1})...")
                
                # Call DI (Blocking call wrapped in thread)
                loop = asyncio.get_running_loop()
                chunks = await loop.run_in_executor(
                    None,
                    lambda: doc_service.analyze_document(
                        blob_url=blob_url,
                        page_range=page_range,
                        high_res=True # User logic says "high_res=use_high_res", defaulting to True for better quality
                    )
                )
                
                # Save Partial Result
                container_client = get_container_client()
                # Store in temp/json
                part_name = f"temp/json/{filename}_part_{page_range}.json"
                blob_client = container_client.get_blob_client(part_name)
                
                import json
                json_content = json.dumps(chunks, ensure_ascii=False, indent=2)
                blob_client.upload_blob(json_content, overwrite=True)
                
                # Update Status
                status_manager.update_chunk_progress(filename, page_range)
                print(f"[RobustAnalysis] Chunk {page_range} completed!")
                return  # Success, exit loop
                
            except Exception as e:
                print(f"[RobustAnalysis] Error chunk {page_range} (Retry {retry+1}): {e}")
                
                wait_time = 5 * (retry + 1)
                if retry < max_retries - 1:
                    print(f"[RobustAnalysis] Waiting {wait_time}s...")
                    await asyncio.sleep(wait_time)
                else:
                    print(f"[RobustAnalysis] All retries failed for {page_range}")
                    raise e # This will bubble up and stop the loop, or we can catch it in the caller loop? 
                            # If we raise here, the whole loop stops. 
                            # Maybe we want to continue? 
                            # Robustness usually means fail fast for that chunk but maybe try others?
                            # User code: "break" in try, "except" just prints/waits. 
                            # BUT the user code snippet loops logic is inside the chunk loop. 
                            # If max_retries hit, it exits the retry loop, and continues to next chunk?
                            # User code: for retry in range(max_retries): try... except...
                            # So if it fails 3 times, it just finishes the retry loop.
                            # Then it likely crashes or moves on. 
                            # I will Re-raise to alert the system that this chunk failed.

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

    async def finalize_analysis(self, filename: str, category: str, blob_name: str):
        """
        Merges results and cleans up.
        """
        try:
            print(f"[RobustAnalysis] Finalizing {filename}...")
            container_client = get_container_client()
            
            # 1. Get Status for chunk list
            status = status_manager.get_status(filename)
            if not status:
                print(f"[RobustAnalysis] Status not found for {filename}")
                return

            chunks = status.get("completed_chunks", [])
            
            # Sort chunks
            def get_start_page(chunk_str):
                return int(chunk_str.split('-')[0]) if '-' in chunk_str else int(chunk_str)
            chunks.sort(key=get_start_page)
            
            final_pages = []
            
            # 2. Merge JSONs
            for chunk in chunks:
                part_name = f"temp/json/{filename}_part_{chunk}.json"
                blob_client = container_client.get_blob_client(part_name)
                if blob_client.exists():
                    data = blob_client.download_blob().readall()
                    import json
                    partial_json = json.loads(data)
                    final_pages.extend(partial_json)
                    # Cleanup partial
                    blob_client.delete_blob()
            
            # 3. Move File
            # Determine destination based on category and username (inferred from blob_name)
            # blob_name is like "kp/temp/foo.pdf" OR "temp/foo.pdf"
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
                # Wait for copy
                import time
                max_retries = 60
                while dest_blob.get_blob_properties().copy.status == 'pending' and max_retries > 0:
                    await asyncio.sleep(0.5)
                    max_retries -= 1
                
                status_copy = dest_blob.get_blob_properties().copy.status
                if status_copy == 'success':
                    source_blob.delete_blob()
                    print(f"[RobustAnalysis] Move success.")
                else:
                    print(f"[RobustAnalysis] Move failed or timed out: {status_copy}")
            
            # 4. Save Final JSON
            # Same path logic
            json_parts = blob_name.split('/')
            if "temp" in json_parts:
                json_parts[json_parts.index("temp")] = "json"
                # Check extension
                base_name = os.path.splitext(json_parts[-1])[0]
                json_parts[-1] = f"{base_name}.json"
                json_blob_name = "/".join(json_parts)
            else:
                 json_blob_name = f"json/{os.path.splitext(filename)[0]}.json"
                 
            json_client = container_client.get_blob_client(json_blob_name)
            import json
            final_json_content = json.dumps(final_pages, ensure_ascii=False, indent=2)
            json_client.upload_blob(final_json_content, overwrite=True)
            print(f"[RobustAnalysis] JSON Saved: {json_blob_name}")
            
            # 5. Index to Azure Search
            try:
                from app.services.azure_search import azure_search_service
                print(f"[RobustAnalysis] Indexing {len(final_pages)} pages to Azure Search...")
                azure_search_service.index_documents(filename, category, final_pages)
            except Exception as e:
                print(f"[RobustAnalysis] Indexing Failed (Non-blocking): {e}")

            # 6. Cleanup Status
            status_manager.mark_completed(filename)
            print(f"[RobustAnalysis] Finalization Complete.")
            
        except Exception as e:
            print(f"[RobustAnalysis] Finalize Failed: {e}")

robust_analysis_manager = RobustAnalysisManager()
