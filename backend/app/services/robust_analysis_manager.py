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

    async def run_analysis_loop(self, filename: str, local_file_path: str, total_pages: int, category: str):
        """
        Executes the Chunked Analysis Loop with LOCAL FILE CACHING + PARALLEL PROCESSING.
        Uses cached file from /tmp to avoid redundant downloads.
        Processes multiple chunks concurrently for speed.
        """
        try:
            print(f"[RobustAnalysis] Starting loop for {filename} (Pages: {total_pages}, Cached: {local_file_path})")
            
            chunk_size = 50  # Increased from 10 to reduce overhead
            total_chunks = (total_pages + chunk_size - 1) // chunk_size
            
            # 1. Load Existing Progress
            status = status_manager.get_status(filename)
            completed_chunks = set(status.get("completed_chunks", [])) if status else set()
            
            # 2. Build list of pending chunks
            pending_chunks = []
            for i in range(total_chunks):
                start_page = i * chunk_size + 1
                end_page = min((i + 1) * chunk_size, total_pages)
                page_range = f"{start_page}-{end_page}"
                
                if page_range not in completed_chunks:
                    pending_chunks.append(page_range)
            
            print(f"[RobustAnalysis] {len(pending_chunks)} chunks to process (out of {total_chunks})")
            
            # 3. Process chunks in PARALLEL batches
            parallel_workers = 3  # Process 3 chunks simultaneously
            
            for batch_start in range(0, len(pending_chunks), parallel_workers):
                batch = pending_chunks[batch_start:batch_start + parallel_workers]
                print(f"[RobustAnalysis] Processing batch: {batch}")
                
                # Create tasks for this batch
                tasks = [
                    self._process_chunk(filename, local_file_path, page_range)
                    for page_range in batch
                ]
                
                # Wait for all tasks in this batch to complete
                results = await asyncio.gather(*tasks, return_exceptions=True)
                
                # Check for errors
                for page_range, result in zip(batch, results):
                    if isinstance(result, Exception):
                        print(f"[RobustAnalysis] Chunk {page_range} failed: {result}")
                        self._mark_error(filename, f"Chunk {page_range} failed: {str(result)}")
                        return
            
            # 4. Finalize if all chunks done
            status = status_manager.get_status(filename)
            current_completed = set(status.get("completed_chunks", []))
            all_ranges = {f"{i*chunk_size+1}-{min((i+1)*chunk_size, total_pages)}" for i in range(total_chunks)}
            
            if all_ranges.issubset(current_completed):
                print(f"[RobustAnalysis] All chunks executed. Finalizing...")
                await self.finalize_analysis(filename, category)
                
                # Cleanup cached file
                import os
                if os.path.exists(local_file_path):
                    try:
                        os.remove(local_file_path)
                        print(f"[RobustAnalysis] Cleaned up cached file: {local_file_path}")
                    except: pass
            else:
                print(f"[RobustAnalysis] Loop finished but some chunks missing? {all_ranges - current_completed}")
                self._mark_error(filename, "Loop finished but chunks missing")

        except Exception as e:
            print(f"[RobustAnalysis] Critical Failure: {e}")
            import traceback
            traceback.print_exc()
            self._mark_error(filename, f"Critical System Error: {str(e)}")
            
            # Cleanup on error
            import os
            if 'local_file_path' in locals() and os.path.exists(local_file_path):
                try: os.remove(local_file_path)
                except: pass

    async def _process_chunk(self, filename: str, local_file_path: str, page_range: str):
        """
        Process a single chunk using the cached local file.
        """
        max_retries = 3
        
        for retry in range(max_retries):
            try:
                print(f"[RobustAnalysis] Processing chunk {page_range}...")
                
                # Analyze using CACHED LOCAL FILE (no download!)
                from app.services.doc_intel_service import get_doc_intel_service
                doc_service = get_doc_intel_service()
                
                loop = asyncio.get_running_loop()
                chunks = await loop.run_in_executor(
                    None,
                    lambda: doc_service.analyze_via_rendering(
                        local_file_path=local_file_path,  # Use cached file!
                        page_range=page_range,
                        dpi=150,
                        max_dimension=3000
                    )
                )
                
                # Save Partial Result
                container_client = get_container_client()
                part_name = f"temp/json/{filename}_part_{page_range}.json"
                blob_client = container_client.get_blob_client(part_name)
                
                import json
                json_content = json.dumps(chunks, ensure_ascii=False, indent=2)
                blob_client.upload_blob(json_content, overwrite=True)
                
                # Update Status
                status_manager.update_chunk_progress(filename, page_range)
                print(f"[RobustAnalysis] Chunk {page_range} completed!")
                return  # Success
                
            except Exception as e:
                print(f"[RobustAnalysis] Error chunk {page_range} (Retry {retry+1}): {e}")
                if retry < max_retries - 1:
                    await asyncio.sleep(2 * (retry + 1))
                else:
                    raise  # Final retry failed

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
