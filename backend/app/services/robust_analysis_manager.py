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
    Manages robust document analysis:
    - Strictly uses Azure Document Intelligence via SAS URL (No Image Rendering)
    - Runs the analysis loop (chunks)
    - Saves progress via StatusManager
    - Handles retries
    """
    
    def __init__(self):
        pass

    async def run_analysis_loop(self, filename: str, blob_name: str, total_pages: int, category: str):
        """
        Executes the Chunked Analysis Loop using Strictly SAS URL.
        """
        try:
            print(f"[RobustAnalysis] Starting loop for {filename} (Pages: {total_pages}, Blob: {blob_name})")
            
            # 1. Generate SAS URL
            container_client = get_container_client()
            account_name = container_client.account_name
            account_key = None
            
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
                    expiry=datetime.utcnow() + timedelta(hours=2)
                )
            elif settings.AZURE_BLOB_SAS_TOKEN:
                 sas_token = settings.AZURE_BLOB_SAS_TOKEN.strip()
                 if sas_token.startswith("?"): sas_token = sas_token[1:]

            if not sas_token:
                raise Exception("Could not generate SAS token")
                
            blob_url = f"https://{account_name}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{urllib.parse.quote(blob_name)}?{sas_token}"
            blob_url = blob_url.replace(" ", "%20")
            
            print(f"[RobustAnalysis] SAS URL Ready: {blob_url[:60]}...")

            chunk_size = 50 
            total_chunks = (total_pages + chunk_size - 1) // chunk_size
            
            # 2. Check Progress
            status = status_manager.get_status(filename)
            completed_chunks = set(status.get("completed_chunks", [])) if status else set()
            
            # 3. Build Pending Chunks
            pending_chunks = []
            for i in range(total_chunks):
                start_page = i * chunk_size + 1
                end_page = min((i + 1) * chunk_size, total_pages)
                page_range = f"{start_page}-{end_page}"
                
                if page_range not in completed_chunks:
                    pending_chunks.append(page_range)
            
            print(f"[RobustAnalysis] {len(pending_chunks)} chunks to process")
            
            # 4. Process chunks (Sequential)
            for page_range in pending_chunks:
                await self._process_chunk_with_retry(filename, blob_url, page_range)
            
            # 5. Finalize
            status = status_manager.get_status(filename)
            current_completed = set(status.get("completed_chunks", []))
            all_ranges = {f"{i*chunk_size+1}-{min((i+1)*chunk_size, total_pages)}" for i in range(total_chunks)}
            
            if len(pending_chunks) > 0: 
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
        Process a single chunk with Retry Logic.
        STRICTLY uses analyze_document (SAS URL).
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
                        high_res=False # Disable high_res to reduce load/complexity as per user hint
                    )
                )
                
                # Success
                self._save_chunk_result(filename, page_range, chunks)
                return 
                
            except Exception as e:
                print(f"[RobustAnalysis] Error chunk {page_range} (Retry {retry+1}): {e}")
                
                wait_time = 5 * (retry + 1)
                if retry < max_retries - 1:
                    print(f"[RobustAnalysis] Waiting {wait_time}s...")
                    await asyncio.sleep(wait_time)
                else:
                    print(f"[RobustAnalysis] All retries failed for {page_range}")
                    raise e 

    def _save_chunk_result(self, filename, page_range, chunks):
        from app.services.blob_storage import get_container_client
        container_client = get_container_client()
        part_name = f"temp/json/{filename}_part_{page_range}.json"
        blob_client = container_client.get_blob_client(part_name)
        
        import json
        json_content = json.dumps(chunks, ensure_ascii=False, indent=2)
        blob_client.upload_blob(json_content, overwrite=True)
        
        status_manager.update_chunk_progress(filename, page_range)
        print(f"[RobustAnalysis] Chunk {page_range} saved.")

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
            
            status = status_manager.get_status(filename)
            if not status:
                return

            chunks = status.get("completed_chunks", [])
            
            def get_start_page(chunk_str):
                return int(chunk_str.split('-')[0]) if '-' in chunk_str else int(chunk_str)
            chunks.sort(key=get_start_page)
            
            final_pages = []
            
            for chunk in chunks:
                part_name = f"temp/json/{filename}_part_{chunk}.json"
                blob_client = container_client.get_blob_client(part_name)
                if blob_client.exists():
                    data = blob_client.download_blob().readall()
                    import json
                    partial_json = json.loads(data)
                    final_pages.extend(partial_json)
                    blob_client.delete_blob()
            
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
                import time
                max_retries = 60
                while dest_blob.get_blob_properties().copy.status == 'pending' and max_retries > 0:
                    await asyncio.sleep(0.5)
                    max_retries -= 1
                
                if dest_blob.get_blob_properties().copy.status == 'success':
                    source_blob.delete_blob()

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
            final_json_content = json.dumps(final_pages, ensure_ascii=False, indent=2)
            json_client.upload_blob(final_json_content, overwrite=True)
            print(f"[RobustAnalysis] JSON Saved: {json_blob_name}")
            
            try:
                from app.services.azure_search import azure_search_service
                print(f"[RobustAnalysis] Indexing {len(final_pages)} pages to Azure Search...")
                azure_search_service.index_documents(filename, category, final_pages)
            except Exception as e:
                print(f"[RobustAnalysis] Indexing Failed: {e}")

            status_manager.mark_completed(filename)
            print(f"[RobustAnalysis] Finalization Complete.")
            
        except Exception as e:
            print(f"[RobustAnalysis] Finalize Failed: {e}")

robust_analysis_manager = RobustAnalysisManager()
