from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Body
from app.services.azure_di import azure_di_service
from app.services.blob_storage import get_container_client, generate_sas_url
from app.services.status_manager import status_manager
from azure.storage.blob import generate_blob_sas, BlobSasPermissions
from app.core.config import settings
from datetime import datetime, timedelta
import json
import os
import asyncio

router = APIRouter()


@router.post("/local")
async def analyze_local_file(
    file: UploadFile = File(...),
    username: str = Form(None),
    category: str = Form("drawings")
):
    try:
        # 1. Upload file to Azure Blob
        container_client = get_container_client()
        
        # Validate category
        target_folder = category if category in ["drawings", "documents"] else "drawings"
        
        # Determine path (Force common folders, ignore username for folder structure)
        # Always save to {target_folder}/{filename}
        blob_name = f"{target_folder}/{file.filename}"
        json_blob_name = f"json/{os.path.splitext(file.filename)[0]}.json"
        
        # Log for debugging
        print(f"Uploading file to: {blob_name}")

        blob_client = container_client.get_blob_client(blob_name)
        
        file_content = await file.read()
        blob_client.upload_blob(file_content, overwrite=True)
        
        # 2. Trigger DI Analysis (Direct Bytes)
        # Using bytes avoids complex SAS/URL logic and ensures analysis works even if blob is private
        print(f"Analyzing document (Direct Bytes Mode)...")
        analysis_result = azure_di_service.analyze_document_from_bytes(file_content)
        
        # 3. Save result to Azure Blob (json folder)
        json_blob_client = container_client.get_blob_client(json_blob_name)
        
        json_content = json.dumps(analysis_result, ensure_ascii=False, indent=2)
        json_blob_client.upload_blob(json_content, overwrite=True)
        
        # 4. Index to Azure Search
        try:
            from app.services.azure_search import azure_search_service
            print(f"Indexing to Azure Search...")
            azure_search_service.index_documents(file.filename, category, analysis_result)
        except Exception as e:
            print(f"Indexing Failed: {e}")

        return analysis_result

    except Exception as e:
        print(f"Analysis Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# --- Batch Indexing Endpoints ---

@router.get("/upload-sas")
@router.get("/upload-url")
async def get_upload_sas(filename: str, username: str = None):
    """
    Generate a Write-enabled SAS URL for frontend direct upload.
    Blob will be saved to 'temp/{filename}'.
    """
    try:
        blob_name = f"{username}/temp/{filename}" if username else f"temp/{filename}"
        
        sas_token = None
        
        # 1. Try to generate specific SAS with WRITE permission if we have the Account Key
        if settings.AZURE_BLOB_CONNECTION_STRING and "AccountKey" in settings.AZURE_BLOB_CONNECTION_STRING:
             try:
                 # Extract Key and Account Name from Connection String
                 # Format: DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
                 parts = dict(item.split('=', 1) for item in settings.AZURE_BLOB_CONNECTION_STRING.split(';') if '=' in item)
                 account_name = parts.get("AccountName")
                 account_key = parts.get("AccountKey")
                 
                 if account_name and account_key:
                     sas_token = generate_blob_sas(
                        account_name=account_name,
                        container_name=settings.AZURE_BLOB_CONTAINER_NAME,
                        blob_name=blob_name,
                        account_key=account_key,
                        permission=BlobSasPermissions(create=True, write=True),
                        expiry=datetime.utcnow() + timedelta(hours=1)
                     )
                     # Construct URL
                     url = f"https://{account_name}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{blob_name}?{sas_token}"
                     return {"upload_url": url, "blob_name": blob_name}
             except Exception as e:
                 print(f"Key-based SAS generation failed: {e}, falling back to env SAS.")
        
        # 2. Fallback: Use the Env SAS (Must have Write permission pre-configured)
        print("Using Environment SAS Token (Warning: Ensure it has Write permission)")
        write_url = generate_sas_url(blob_name)
        
        return {"upload_url": write_url, "blob_name": blob_name}
    except Exception as e:
        print(f"SAS Gen Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Removed duplicate /start endpoint - using the one with BackgroundTasks below


@router.post("/analyze-sync")
async def analyze_document_sync(
    filename: str = Body(...),
    total_pages: int = Body(...),
    category: str = Body("drawings"),
    username: str = Body(None)
):
    """
    Synchronous document analysis endpoint (Streamlit-proven flow).
    """
    try:
        print(f"[AnalyzeSync] Starting: {filename}, {total_pages} pages, category={category}")
        
        # 1. Get container client
        container_client = get_container_client()
        
        # 2. Verify temp file exists
        temp_blob_name = f"{username}/temp/{filename}" if username else f"temp/{filename}"
        temp_blob_client = container_client.get_blob_client(temp_blob_name)
        
        if not temp_blob_client.exists():
            print(f"[AnalyzeSync] File not found: {temp_blob_name}")
            raise HTTPException(status_code=404, detail=f"File not found in temp/: {filename}")
        
        print(f"[AnalyzeSync] Temp file verified: {temp_blob_name}")
        
        # 3. Generate SAS URL for Document Intelligence
        account_name = container_client.account_name
        
        # Get account key from credential
        account_key = None
        
        if hasattr(container_client.credential, 'account_key'):
            account_key = container_client.credential.account_key
        elif isinstance(container_client.credential, dict) and 'account_key' in container_client.credential:
            account_key = container_client.credential['account_key']
        else:
            # ConnectionString case
            conn_str = settings.AZURE_BLOB_CONNECTION_STRING
            if conn_str:
                for part in conn_str.split(';'):
                    if 'AccountKey=' in part:
                        account_key = part.split('AccountKey=')[1]
                        break
        
        # Debug logging
        if not account_key:
            print(f"[AnalyzeSync] Credential Type: {type(container_client.credential)}")
            if isinstance(container_client.credential, dict):
                 print(f"[AnalyzeSync] Credential Keys: {container_client.credential.keys()}")

        
        if not account_key:
            # Check if we assume SAS Token auth (Singleton initialized with SAS)
            if settings.AZURE_BLOB_SAS_TOKEN:
                 print("[AnalyzeSync] Using configured SAS Token (Account Key not found/needed)")
                 # [MODIFIED] Do not replace %2C manually, trust the token or minimally clean
                 sas_token = settings.AZURE_BLOB_SAS_TOKEN.strip()
                 if sas_token.startswith("?"):
                     sas_token = sas_token[1:]
            else:
                print("[AnalyzeSync] Error: Could not extract account_key and no SAS Token configured")
                raise HTTPException(status_code=500, detail="Azure Storage authentication failed (No Key/SAS)")
        else:
             sas_token = generate_blob_sas(
                 account_name=account_name,
                 container_name=settings.AZURE_BLOB_CONTAINER_NAME,
                 blob_name=temp_blob_name,
                 account_key=account_key,
                 permission=BlobSasPermissions(read=True),
                 start=datetime.utcnow() - timedelta(minutes=15),
                 expiry=datetime.utcnow() + timedelta(hours=2)
             )
        
        import urllib.parse
        blob_url = f"https://{account_name}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{urllib.parse.quote(temp_blob_name)}?{sas_token}"
        
        # [MODIFIED] Normalize & Log
        blob_url = blob_url.replace(" ", "%20")
        
        print(f"[AnalyzeSync] SAS URL generated")
        print("[DI] url has space?", " " in blob_url)
        print("[DI] url length:", len(blob_url))
        print("[DI] url head:", blob_url[:180])
        
        # 4. Analyze document in chunks (Streamlit pattern: 50 pages per chunk)
        from app.services.doc_intel_service import get_doc_intel_service
        doc_intel_service = get_doc_intel_service()
        
        chunk_size = 50
        all_chunks = []
        
        for start_page in range(1, total_pages + 1, chunk_size):
            end_page = min(start_page + chunk_size - 1, total_pages)
            page_range = f"{start_page}-{end_page}"
            
            print(f"[AnalyzeSync] Analyzing pages {page_range}...")
            
            print(f"[AnalyzeSync] Analyzing pages {page_range} (Force Robust Mode)...")
            
            # Use analyze_via_rendering DIRECTLY to ensure stability
            # This bypasses Azure DI's internal limits by sending optimized images
            try:
                chunks = doc_intel_service.analyze_via_rendering(
                    blob_url=blob_url,
                    page_range=page_range,
                    dpi=150,
                    max_dimension=3000
                )
                print(f"[AnalyzeSync] Image-based analysis success, chunks: {len(chunks)}")
                
            except Exception as e:
                print(f"[AnalyzeSync] Chunk {page_range} Failed: {e}")
                # Log full traceback for debugging (cloud logs)
                import traceback
                traceback.print_exc()
                raise e
            
            # Apply P&ID Topology Processing (if chunks obtained)
            if chunks:
                from app.services.pid_processor import pid_processor
                enriched_chunks = []
                for chunk in chunks:
                    try:
                        print(f"[PID] processing page: {chunk.get('page_number')}")
                        enriched = pid_processor.process_chunk(chunk)
                        
                        # Format for LLM (Append to Content)
                        topology_text = pid_processor.format_to_text(enriched)
                        if topology_text:
                            enriched['content'] += topology_text
                            
                        enriched_chunks.append(enriched)
                    except Exception as e:
                        print(f"[AnalyzeSync] PID Processing Warning for page {chunk.get('page_number')}: {e}")
                        enriched_chunks.append(chunk) # Fallback to original
                        
                all_chunks.extend(enriched_chunks)
                print(f"[AnalyzeSync] Chunk {page_range} complete: {len(chunks)} pages")
                    

        
        print(f"[AnalyzeSync] Analysis complete: {len(all_chunks)} pages processed")
        
        # 5. Move to final location
        final_folder = category if category in ["drawings", "documents"] else "drawings"
        folder_prefix = f"{username}/{final_folder}" if username else final_folder
        final_blob_name = f"{folder_prefix}/{filename}"
        final_blob_client = container_client.get_blob_client(final_blob_name)
        
        # Copy from temp to final
        temp_blob_url_with_sas = blob_url  # Reuse SAS from before
        final_blob_client.start_copy_from_url(temp_blob_url_with_sas)
        
        # Wait for copy to complete
        import time
        for _ in range(30):  # Max 15 seconds
            props = final_blob_client.get_blob_properties()
            if props.copy.status == "success":
                break
            if props.copy.status == "failed":
                raise Exception(f"Blob copy failed: {props.copy.status_description}")
            time.sleep(0.5)
        
        # Delete temp file
        temp_blob_client.delete_blob()
        print(f"[AnalyzeSync] Moved to {final_blob_name}, temp deleted")
        
        # 6. Save JSON to Blob Storage
        json_prefix = f"{username}/json" if username else "json"
        json_blob_name = f"{json_prefix}/{os.path.splitext(filename)[0]}.json"
        json_blob_client = container_client.get_blob_client(json_blob_name)
        
        json_content = json.dumps(all_chunks, ensure_ascii=False, indent=2)
        json_blob_client.upload_blob(json_content, overwrite=True)
        print(f"[AnalyzeSync] JSON saved: {json_blob_name}")
        
        # 7. Index to Azure Search (Streamlit pattern: page-by-page with batch upload)
        from app.services.azure_search import azure_search_service
        
        if not azure_search_service.client:
            print("[AnalyzeSync] WARNING: Azure Search not configured, skipping indexing")
        else:
            documents_to_index = []
            
            for chunk in all_chunks:
                # Create unique document ID
                import base64
                page_id_str = f"{final_blob_name}_page_{chunk['page_number']}"
                doc_id = base64.urlsafe_b64encode(page_id_str.encode('utf-8')).decode('utf-8')
                
                # Get file size
                blob_props = final_blob_client.get_blob_properties()
                
                document = {
                    "id": doc_id,
                    "content": chunk['content'],
                    "content_exact": chunk['content'],
                    "metadata_storage_name": f"{filename} (p.{chunk['page_number']})",
                    "metadata_storage_path": f"https://{account_name}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{final_blob_name}#page={chunk['page_number']}",
                    "metadata_storage_last_modified": datetime.utcnow().isoformat() + "Z",
                    "metadata_storage_size": blob_props.size,
                    "metadata_storage_content_type": "application/pdf",
                    "project": "drawings_analysis",
                    "page_number": chunk['page_number'],
                    "filename": filename,
                    "category": category
                }
                
                documents_to_index.append(document)
            
            # Batch upload (50 docs at a time)
            batch_size = 50
            for i in range(0, len(documents_to_index), batch_size):
                batch = documents_to_index[i:i + batch_size]
                try:
                    result = azure_search_service.client.upload_documents(documents=batch)
                    print(f"[AnalyzeSync] Indexed batch {i//batch_size + 1}: {len(batch)} docs")
                except Exception as e:
                    print(f"[AnalyzeSync] Indexing batch {i//batch_size + 1} failed: {e}")
                    # Continue with other batches
            
            print(f"[AnalyzeSync] Indexing complete: {len(documents_to_index)} documents")
        
        # 8. Return success
        return {
            "status": "completed",
            "filename": filename,
            "total_pages": total_pages,
            "chunks_analyzed": len(all_chunks),
            "final_location": final_blob_name,
            "json_location": json_blob_name
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"[AnalyzeSync] Failed: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))





@router.post("/init")
async def init_analysis(
    file: UploadFile = File(None),
    filename: str = Form(None), # If file is None, filename must be provided (Direct Upload case)
    total_pages: int = Form(...),
    category: str = Form("drawings")
):
    try:
        container_client = get_container_client()
        
        # Case 1: File Uploaded via Backend (Legacy/Small files)
        if file:
            real_filename = file.filename
            temp_blob_name = f"temp/{real_filename}"
            blob_client = container_client.get_blob_client(temp_blob_name)
            file_content = await file.read()
            blob_client.upload_blob(file_content, overwrite=True)
            
        # Case 2: Direct Upload (File already in temp/)
        elif filename:
            real_filename = filename
            temp_blob_name = f"temp/{real_filename}"
            # Verify it exists?
            blob_client = container_client.get_blob_client(temp_blob_name)
            if not blob_client.exists():
                 raise HTTPException(status_code=404, detail=f"Blob {temp_blob_name} not found. Upload failed?")
        else:
            raise HTTPException(status_code=400, detail="Either 'file' or 'filename' must be provided.")
            
        # 2. Initialize Status
        status = status_manager.init_status(real_filename, total_pages, category)
        
        return {"status": "initialized", "blob_name": temp_blob_name, "info": status}
    except Exception as e:
        print(f"Init Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

from app.services.robust_analysis_manager import robust_analysis_manager
from fastapi import BackgroundTasks

@router.get("/status/{filename}")
async def get_analysis_status(filename: str):
    """
    Get the status of a background analysis task.
    """
    status = status_manager.get_status(filename)
    if not status:
        return {"status": "not_found", "filename": filename}
    return status

@router.post("/start")
async def start_robust_analysis_task(
    background_tasks: BackgroundTasks,
    filename: str = Body(...),
    total_pages: int = Body(...),
    category: str = Body(...),
    username: str = Body(None)
):
    """
    Triggers the Robust Analysis Loop in the background.
    Downloads PDF to /tmp once, then passes local path to avoid redundant downloads.
    """
    try:
        # Match the upload path from upload-sas endpoint
        # Files are uploaded to /temp/, analysis reads from there
        # finalize_analysis will move to /{category}/ after completion
        blob_name = f"{username}/temp/{filename}" if username else f"temp/{filename}"
        
        # Verify file exists
        container_client = get_container_client()
        blob_client = container_client.get_blob_client(blob_name)
        if not blob_client.exists():
            raise HTTPException(status_code=404, detail=f"File not found: {blob_name}")
        
        # ===== AUTO RE-ANALYSIS: Check for existing JSON and validate =====
        import json as json_module
        import os
        
        # Determine expected JSON path
        json_filename = os.path.splitext(filename)[0] + ".json"
        json_path = f"{username}/json/{json_filename}" if username else f"json/{json_filename}"
        
        json_blob = container_client.get_blob_client(json_path)
        should_reanalyze = False
        
        if json_blob.exists():
            print(f"[StartAnalysis] Existing JSON found: {json_path}")
            
            # Download and validate
            try:
                json_data = json_blob.download_blob().readall()
                existing_pages = json_module.loads(json_data)
                
                # VALIDATION CHECKS
                if not existing_pages or len(existing_pages) == 0:
                    print(f"[StartAnalysis] ⚠️ JSON is EMPTY - forcing re-analysis")
                    should_reanalyze = True
                elif len(existing_pages) < total_pages:
                    print(f"[StartAnalysis] ⚠️ Incomplete JSON: {len(existing_pages)}/{total_pages} pages - forcing re-analysis")
                    should_reanalyze = True
                else:
                    print(f"[StartAnalysis] ✅ Valid JSON exists with {len(existing_pages)} pages")
                    # For now, still allow re-analysis. Change to False to skip re-analysis
                    should_reanalyze = False
                    
            except Exception as e:
                print(f"[StartAnalysis] ⚠️ Failed to validate JSON: {e} - forcing re-analysis")
                should_reanalyze = True
        
        # Cleanup corrupted files if needed
        if should_reanalyze:
            print(f"[StartAnalysis] 🧹 Cleaning up corrupted analysis files...")
            
            # 1. Delete final JSON
            try:
                json_blob.delete_blob()
                print(f"[StartAnalysis] Deleted corrupted JSON: {json_path}")
            except Exception as e:
                print(f"[StartAnalysis] Note: Could not delete JSON (may not exist): {e}")
            
            # 2. Delete temp chunk JSONs (pattern: temp/json/{filename}_part_*)
            temp_json_prefix = f"{username}/temp/json/" if username else "temp/json/"
            base_filename = os.path.splitext(filename)[0]
            try:
                blob_list = container_client.list_blobs(name_starts_with=temp_json_prefix)
                deleted_count = 0
                for blob in blob_list:
                    # Only delete chunks for this specific file
                    if base_filename in blob.name and "_part_" in blob.name:
                        container_client.get_blob_client(blob.name).delete_blob()
                        deleted_count += 1
                if deleted_count > 0:
                    print(f"[StartAnalysis] Deleted {deleted_count} temp chunk JSON files")
            except Exception as e:
                print(f"[StartAnalysis] Cleanup warning: {e}")
            
            # 3. Reset status in status_manager
            status_manager.reset_status(filename)
            print(f"[StartAnalysis] Reset analysis status for fresh start")
        # ===== END AUTO RE-ANALYSIS =====
        
        # Download PDF to /tmp (ONCE)
        import tempfile
        import os
        tmp_dir = "/tmp"
        os.makedirs(tmp_dir, exist_ok=True)
        local_file_path = os.path.join(tmp_dir, filename)
        
        print(f"[StartAnalysis] Downloading {blob_name} to {local_file_path}...")
        with open(local_file_path, 'wb') as f:
            blob_data = blob_client.download_blob()
            blob_data.readinto(f)
        print(f"[StartAnalysis] Downloaded {os.path.getsize(local_file_path) / 1024 / 1024:.1f} MB")
        
        # Verify page count
        import fitz
        with fitz.open(local_file_path) as doc:
            real_pages = doc.page_count
            if real_pages != total_pages:
                 print(f"[StartAnalysis] mismatch pages: user={total_pages}, real={real_pages}. Updating.")
                 total_pages = real_pages
        
        # Initialize Status if not already
        if not status_manager.get_status(filename):
            status_manager.init_status(filename, total_pages, category)
        
        # Add Background Task
        background_tasks.add_task(
            robust_analysis_manager.run_analysis_loop,
            filename=filename,
            blob_name=blob_name,
            total_pages=total_pages,
            category=category,
            local_file_path=local_file_path
        )
        
        return {"status": "started", "message": "Analysis loop started in background"}
    except Exception as e:
        print(f"Start Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/chunk")
async def analyze_chunk(
    filename: str = Body(...),
    blob_name: str = Body(...), # temp/filename.pdf
    pages: str = Body(...)      # "1-30"
):
    try:
        print(f"Analyzing chunk {pages} for {filename}...")
        
        # 1. Get SAS URL for the blob
        blob_url = generate_sas_url(blob_name)
        
        # 2. Run DI on range
        # Note: azure_di_service.analyze_document_from_url now supports 'pages'
        partial_result = azure_di_service.analyze_document_from_url(blob_url, pages=pages)
        
        # 3. Save Partial Result to Blob
        # temp/json/{filename}_part_{pages}.json
        container_client = get_container_client()
        part_name = f"temp/json/{filename}_part_{pages}.json"
        
        blob_client = container_client.get_blob_client(part_name)
        json_content = json.dumps(partial_result, ensure_ascii=False, indent=2)
        blob_client.upload_blob(json_content, overwrite=True)
        
        # 4. Update Status
        status_manager.update_chunk_progress(filename, pages)
        
        return {"status": "chunk_completed", "pages": pages}
        
    except Exception as e:
        print(f"Chunk Analysis Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/finalize")
async def finalize_analysis(
    filename: str = Body(...),
    category: str = Body(...)
):
    try:
        print(f"Finalizing analysis for {filename}...")
        container_client = get_container_client()
        status = status_manager.get_status(filename)
        
        if not status:
            raise HTTPException(status_code=404, detail="Status not found")

        # 1. Merge Partial Results
        final_pages = []
        chunks = status["completed_chunks"]
        
        def get_start_page(chunk_str):
            return int(chunk_str.split('-')[0]) if '-' in chunk_str else int(chunk_str)
            
        chunks.sort(key=get_start_page)
        
        for chunk in chunks:
            part_name = f"temp/json/{filename}_part_{chunk}.json"
            blob_client = container_client.get_blob_client(part_name)
            if blob_client.exists():
                data = blob_client.download_blob().readall()
                partial_json = json.loads(data)
                final_pages.extend(partial_json)
                blob_client.delete_blob()
        
        # 2. Move File from temp/ to final location
        temp_blob_name = f"temp/{filename}"
        target_folder = category if category in ["drawings", "documents"] else "drawings"
        final_blob_name = f"{target_folder}/{filename}"
        
        source_blob = container_client.get_blob_client(temp_blob_name)
        dest_blob = container_client.get_blob_client(final_blob_name)
        
        if source_blob.exists():
            dest_blob.start_copy_from_url(source_blob.url)
            import time
            max_retries = 10
            while dest_blob.get_blob_properties().copy.status == 'pending' and max_retries > 0:
                time.sleep(0.5)
                max_retries -= 1
            if dest_blob.exists():
                 source_blob.delete_blob()

        # 3. Save Final JSON
        json_blob_name = f"json/{os.path.splitext(filename)[0]}.json"
        json_client = container_client.get_blob_client(json_blob_name)
        
        final_json_content = json.dumps(final_pages, ensure_ascii=False, indent=2)
        json_client.upload_blob(final_json_content, overwrite=True)
        
        # 4. Cleanup Status
        status_manager.mark_completed(filename)
        
        return {"status": "completed", "final_path": final_blob_name}

    except Exception as e:
        print(f"Finalize Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/incomplete")
async def list_incomplete_jobs():
    try:
        container_client = get_container_client()
        blobs = container_client.list_blobs(name_starts_with="temp/status/")
        
        incomplete_jobs = []
        for blob in blobs:
            blob_client = container_client.get_blob_client(blob.name)
            data = blob_client.download_blob().readall()
            status = json.loads(data)
            
            if status.get("status") in ["in_progress", "error"]:
                incomplete_jobs.append(status)
                
        return incomplete_jobs
    except Exception as e:
        print(f"List Incomplete Failed: {e}")
        return []

@router.delete("/cleanup")
async def cleanup_analysis(filename: str):
    """
    Clean up temporary files (blob and status) if analysis fails or is aborted.
    """
    try:
        print(f"Cleaning up analysis for {filename}...")
        container_client = get_container_client()
        
        # 1. Delete temp file
        temp_blob_name = f"temp/{filename}"
        blob_client = container_client.get_blob_client(temp_blob_name)
        if blob_client.exists():
            blob_client.delete_blob()
            
        # 2. Delete status file
        status_blob_name = f"temp/status/{filename}.status.json"
        status_client = container_client.get_blob_client(status_blob_name)
        if status_client.exists():
            status_client.delete_blob()
            
        return {"status": "cleaned_up", "filename": filename}
        
    except Exception as e:
        print(f"Cleanup Failed: {e}")
        return {"status": "error", "detail": str(e)}

@router.post("/repair")
async def repair_analysis(
    filename: str = Body(...),
    category: str = Body("drawings")
):
    """
    Manually triggers repair using CHUNKED analysis (to avoid size limits).
    """
    try:
        print(f"[Repair] Starting chunked repair for {filename} (Version: Chunked-Fix-Recalled)...")
        
        # 1. Verify File
        container_client = get_container_client()
        target_blob_name = f"{category}/{filename}"
        blob = container_client.get_blob_client(target_blob_name)
        
        if not blob.exists():
            return {"status": "error", "detail": f"File not found in {category}/"}
            
        total_pages = 44 
        
        from app.services.status_manager import status_manager
        status_manager.init_status(filename, total_pages, category)
        
        from app.services.robust_analysis_manager import robust_analysis_manager
        
        await robust_analysis_manager.run_analysis_loop(
            filename=filename,
            blob_name=target_blob_name, # Use final location as source for SAS
            total_pages=total_pages,
            category=category
        )
        
        return {"status": "repaired_chunked", "pages": total_pages}
        
    except Exception as e:
        print(f"[Repair] Failed: {e}")
        return {"status": "error", "detail": str(e)}

@router.post("/detect")
async def detect_document_robust(
    pdf_url: str = Body(..., embed=True),
    page_range: str = Body(..., embed=True),
    max_dim: int = Body(3000, embed=True),
    dpi: int = Body(150, embed=True)
):
    """
    Robust detection endpoint that bypasses Azure DI PDF limits by rendering pages as images on the backend.
    
    Args:
        pdf_url: SAS URL to the source PDF (must have Read permission).
        page_range: Pages to analyze (e.g., "1-5", "1,3,5").
        max_dim: Maximum dimension for the rendered image (default 3000px).
        dpi: DPI for rendering (default 150).
        
    Returns:
        JSON list of analyzed page chunks.
    """
    try:
        print(f"[Detect] Request received for {page_range} (max_dim={max_dim})")
        
        # Validate URL
        if not pdf_url.startswith("http"):
            raise HTTPException(status_code=400, detail="Invalid PDF URL")
            
        from app.services.doc_intel_service import get_doc_intel_service
        doc_service = get_doc_intel_service()
        
        # Delegate to the robust rendering method
        chunks = doc_service.analyze_via_rendering(
            blob_url=pdf_url,
            page_range=page_range,
            dpi=dpi,
            max_dimension=max_dim
        )
        
        print(f"[Detect] Success: {len(chunks)} pages processed")
        return chunks
        
    except Exception as e:
        print(f"[Detect] Failed: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/debug-sync")
async def debug_analyze_sync(
    filename: str = Body(...),
    total_pages: int = Body(...),
    category: str = Body(...)
):
    """
    Runs the analysis loop SYNCHRONOUSLY for debugging.
    Returns the log of what happened or the error.
    """
    try:
        print(f"[DEBUG v2] Starting Sync Analysis for {filename}")
        blob_name = f"temp/{filename}"
        
        # 1. Test SAS Generation
        try:
            from app.services.blob_storage import generate_sas_url
            test_sas = generate_sas_url(blob_name)
            print(f"[DEBUG] SAS Token Generated successfully: {test_sas[:50]}...")
        except Exception as e:
            return {"status": "error", "stage": "sas_generation", "detail": str(e)}

        # 1.5 Init Status for Debug
        if not status_manager.get_status(filename):
            print(f"[DEBUG] Initializing status for {filename}")
            status_manager.init_status(filename, total_pages, category)

        # 2. Run Analysis Loop (limited to 1 chunk/page for speed if possible, but let's run all)
        # We catch the error inside
        await robust_analysis_manager.run_analysis_loop(
            filename=filename,
            blob_name=blob_name,
            total_pages=total_pages, # maybe force 1 for test?
            category=category
        )
        
        return {"status": "completed", "message": "Sync analysis finished without raising exception"}
        
    except Exception as e:
        import traceback
        return {"status": "error", "stage": "execution", "detail": str(e), "traceback": traceback.format_exc()}
