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
        # Increased chunk size for efficiency (User Preference: 50)
        self.CHUNK_SIZE = 50

    async def run_analysis_loop(self, filename: str, blob_name: str, total_pages: int, category: str, local_file_path: str = None):
        """
        Executes the Optimized Analysis Loop.
        """
        try:
            print(f"[RobustAnalysis] Starting loop for {filename} (Pages: {total_pages}, Local: {local_file_path})")
            
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
                
            encoded_blob_name = urllib.parse.quote(blob_name, safe="/~()-_.")
            blob_url = f"https://{account_name}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{encoded_blob_name}?{sas_token}"
            print(f"[RobustAnalysis] SAS URL Ready: {blob_url[:60]}...")

            # 2. Check Progress
            status = status_manager.get_status(filename)
            completed_chunks = set(status.get("completed_chunks", [])) if status else set()
            
            # 3. Build Pending Chunks
            total_chunks = (total_pages + self.CHUNK_SIZE - 1) // self.CHUNK_SIZE
            pending_chunks = []
            
            for i in range(total_chunks):
                start_page = i * self.CHUNK_SIZE + 1
                end_page = min((i + 1) * self.CHUNK_SIZE, total_pages)
                page_range = f"{start_page}-{end_page}"
                
                if page_range not in completed_chunks:
                    pending_chunks.append(page_range)
            
            print(f"[RobustAnalysis] {len(pending_chunks)} chunks to process (out of {total_chunks})")
            print(f"[RobustAnalysis] Pending list: {pending_chunks}")
            
            # 4. Process chunks in PARALLEL batches
            parallel_workers = 5  # Max parallel requests
            
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
                        # We don't abort the whole loop, just log
            
            # 5. Finalize (Cleanup only, indexing is done incrementally)
            await self.finalize_analysis(filename, category, blob_name, total_pages)

        except Exception as e:
            print(f"[RobustAnalysis] Critical Failure: {e}")
            import traceback
            traceback.print_exc()
            self._mark_error(filename, f"Critical System Error: {str(e)}")

    async def _process_chunk(self, filename: str, blob_name: str, blob_url: str, local_file_path: str, page_range: str, category: str):
        """
        Processes a single chunk:
        1. Analyze (Using URL-based analysis for stability)
        2. Save JSON
        3. Index to Azure Search (INCREMENTAL)
        """
        try:
            print(f"[Chunk] Processing {page_range}...")
            
            # 1. Analyze (Use Azure DI directly via URL - Server-to-Server)
            # This avoids "Image too large" errors from manual rendering
            from app.services.azure_di import azure_di_service

            loop = asyncio.get_running_loop()
            
            # Run blocking analysis in executor
            chunks = await loop.run_in_executor(
                None,
                lambda: azure_di_service.analyze_document_from_url(
                    document_url=blob_url,
                    pages=page_range
                )
            )
            
            # 2. Save JSON
            self._save_chunk_result(filename, page_range, chunks)
            
            # 3. Index Immediately (User Request)
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
        NOTE: Indexing is already done incrementally!
        """
        try:
            print(f"[RobustAnalysis] Finalizing {filename}...")
            container_client = get_container_client()
            
            status = status_manager.get_status(filename)
            chunks_list = status.get("completed_chunks", [])
            
            # Collect all completed pages for Final JSON
            completed_pages = []
            for c in chunks_list:
                part_name = f"temp/json/{filename}_part_{c}.json"
                blob_client = container_client.get_blob_client(part_name)
                if blob_client.exists():
                    data = blob_client.download_blob().readall()
                    partial_json = json.loads(data)
                    completed_pages.extend(partial_json)
                    blob_client.delete_blob() # Cleanup temp
            
            completed_pages.sort(key=lambda x: x.get("page_number", 0))

            # Move PDF
            parts = blob_name.split('/')
            final_blob_name = ""
            if "temp" in parts:
                idx = parts.index("temp")
                parts[idx] = category
                final_blob_name = "/".join(parts)
            else:
                 final_blob_name = f"{category}/{filename}"
            
            source_blob = container_client.get_blob_client(blob_name)
            dest_blob = container_client.get_blob_client(final_blob_name)
            
            if source_blob.exists():
                dest_blob.start_copy_from_url(source_blob.url)
                for _ in range(60):
                    props = dest_blob.get_blob_properties()
                    if props.copy.status == 'success':
                        source_blob.delete_blob()
                        break
                    await asyncio.sleep(0.5)

            # Save Final JSON
            # Infer JSON name
            json_parts = blob_name.split('/')
            if "temp" in json_parts:
                json_parts[json_parts.index("temp")] = "json"
                base_name = os.path.splitext(json_parts[-1])[0]
                json_parts[-1] = f"{base_name}.json"
                json_blob_name = "/".join(json_parts)
            else:
                 json_blob_name = f"json/{os.path.splitext(filename)[0]}.json"
                 
            json_client = container_client.get_blob_client(json_blob_name)
            final_json_content = json.dumps(completed_pages, ensure_ascii=False, indent=2)
            json_client.upload_blob(final_json_content, overwrite=True)
            print(f"[RobustAnalysis] Unified JSON Saved: {json_blob_name}")
            
            status_manager.mark_completed(filename)
            print(f"[RobustAnalysis] Finalization Complete.")
            
        except Exception as e:
            print(f"[RobustAnalysis] Finalize Failed: {e}")

robust_analysis_manager = RobustAnalysisManager()
