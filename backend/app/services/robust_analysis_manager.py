import time
import asyncio
from app.services.azure_di import azure_di_service
from app.services.status_manager import status_manager
from app.services.blob_storage import get_container_client

class RobustAnalysisManager:
    """
    Manages robust document analysis:
    - Runs the analysis loop (chunks)
    - Saves progress via StatusManager
    - Handles retries
    - (Placeholder) Indexing
    """
    
    def __init__(self):
        pass

    async def run_analysis_loop(self, filename: str, blob_name: str, total_pages: int, category: str):
        """
        Executes the Chunked Analysis Loop.
        Designed to be run as a background task.
        """
        try:
            print(f"[RobustAnalysis] Starting loop for {filename} (Pages: {total_pages})")
            
            chunk_size = 10 # Matches Dashboard.jsx logic
            total_chunks = (total_pages + chunk_size - 1) // chunk_size # Ceiling division
            
            # 1. Load Existing Progress
            status = status_manager.get_status(filename)
            completed_chunks = set(status.get("completed_chunks", [])) if status else set()
            
            # 2. Iterate Chunks
            for i in range(total_chunks):
                start_page = i * chunk_size + 1
                end_page = min((i + 1) * chunk_size, total_pages)
                page_range = f"{start_page}-{end_page}"
                
                if page_range in completed_chunks:
                    print(f"[RobustAnalysis] Skipping finished chunk: {page_range}")
                    continue
                
                print(f"[RobustAnalysis] Processing chunk {page_range}...")
                
                # Retry Logic
                max_retries = 3
                success = False
                
                for retry in range(max_retries):
                    try:
                        # A. Generate SAS URL (Read-Only) for DI
                        from app.services.blob_storage import generate_sas_url
                        blob_url = generate_sas_url(blob_name) 
                        
                        # B. Analyze (Run in Executor to avoid blocking async loop)
                        # analyze_document_from_url is blocking.
                        loop = asyncio.get_running_loop()
                        partial_result = await loop.run_in_executor(
                            None, 
                            lambda: azure_di_service.analyze_document_from_url(blob_url, pages=page_range)
                        )
                        
                        # C. Save Partial Result
                        container_client = get_container_client()
                        part_name = f"temp/json/{filename}_part_{page_range}.json"
                        blob_client = container_client.get_blob_client(part_name)
                        
                        import json
                        json_content = json.dumps(partial_result, ensure_ascii=False, indent=2)
                        blob_client.upload_blob(json_content, overwrite=True)
                        
                        # D. Update Status
                        status_manager.update_chunk_progress(filename, page_range)
                        success = True
                        break
                        
                    except Exception as e:
                        print(f"[RobustAnalysis] Error chunk {page_range} (Retry {retry+1}): {e}")
                        await asyncio.sleep(2 * (retry + 1)) # Simple backoff
                
                if not success:
                    print(f"[RobustAnalysis] Failed to process chunk {page_range} after {max_retries} retries.")
                    # Mark status as error so frontend stops polling
                    self._mark_error(filename, f"Failed to process chunk {page_range}")
                    return

            # 3. Finalize if all chunks done
            # logic for checking completeness
            status = status_manager.get_status(filename)
            current_completed = set(status.get("completed_chunks", []))
            all_ranges = {f"{i*chunk_size+1}-{min((i+1)*chunk_size, total_pages)}" for i in range(total_chunks)}
            
            if all_ranges.issubset(current_completed):
                print(f"[RobustAnalysis] All chunks executed. Finalizing...")
                await self.finalize_analysis(filename, category)
            else:
                print(f"[RobustAnalysis] Loop finished but some chunks missing? {all_ranges - current_completed}")
                self._mark_error(filename, "Loop finished but chunks missing")

        except Exception as e:
            print(f"[RobustAnalysis] Critical Failure: {e}")
            self._mark_error(filename, f"Critical System Error: {str(e)}")


    def _mark_error(self, filename, message):
        try:
            status = status_manager.get_status(filename)
            if status:
                status["status"] = "error"
                status["error_message"] = message
                status_manager._get_blob_client(filename).upload_blob(json.dumps(status), overwrite=True)
        except Exception as e:
            print(f"Failed to mark error: {e}")

    async def finalize_analysis(self, filename: str, category: str):
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
            temp_blob_name = f"temp/{filename}"
            target_folder = category if category in ["drawings", "documents"] else "drawings"
            final_blob_name = f"{target_folder}/{filename}"
            
            source_blob = container_client.get_blob_client(temp_blob_name)
            dest_blob = container_client.get_blob_client(final_blob_name)
            
            if source_blob.exists():
                dest_blob.start_copy_from_url(source_blob.url)
                # Wait for copy
                import time
                max_retries = 10
                while dest_blob.get_blob_properties().copy.status == 'pending' and max_retries > 0:
                    await asyncio.sleep(0.5)
                    max_retries -= 1
                
                if dest_blob.exists():
                    source_blob.delete_blob()
            
            # 4. Save Final JSON
            import os
            json_blob_name = f"json/{os.path.splitext(filename)[0]}.json"
            json_client = container_client.get_blob_client(json_blob_name)
            import json
            final_json_content = json.dumps(final_pages, ensure_ascii=False, indent=2)
            json_client.upload_blob(final_json_content, overwrite=True)
            
            # 5. Index to Azure Search
            try:
                from app.services.azure_search import azure_search_service
                print(f"[RobustAnalysis] Indexing {len(final_pages)} pages to Azure Search...")
                azure_search_service.index_documents(filename, category, final_pages)
            except Exception as e:
                print(f"[RobustAnalysis] Indexing Failed (Non-blocking): {e}")

            # 6. Cleanup Status
            status_manager.mark_completed(filename)
            print(f"[RobustAnalysis] Finalization Complete: {final_blob_name}")
            
        except Exception as e:
            print(f"[RobustAnalysis] Finalize Failed: {e}")

robust_analysis_manager = RobustAnalysisManager()
