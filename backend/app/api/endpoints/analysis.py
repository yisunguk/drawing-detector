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
async def get_upload_sas(filename: str):
    """
    Generate a Write-enabled SAS URL for frontend direct upload.
    Blob will be saved to 'temp/{filename}'.
    """
    try:
        blob_name = f"temp/{filename}"
        
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

@router.post("/start")
async def start_robust_analysis(
    background_tasks: BackgroundTasks,
    filename: str = Body(...),
    total_pages: int = Body(...),
    category: str = Body(...)
):
    """
    Triggers the Robust Analysis Loop in the background.
    Frontend should poll /status (via list incomplete) to track progress.
    """
    try:
        blob_name = f"temp/{filename}"
        
        # Initialize Status if not already
        if not status_manager.get_status(filename):
            status_manager.init_status(filename, total_pages, category)
        
        # Add Background Task
        background_tasks.add_task(
            robust_analysis_manager.run_analysis_loop,
            filename=filename,
            blob_name=blob_name,
            total_pages=total_pages,
            category=category
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
        # Sort chunks by starting page number to ensure order
        # chunks are strings like "1-30", "31-60"
        chunks = status["completed_chunks"]
        
        # Helper to parse start page
        def get_start_page(chunk_str):
            return int(chunk_str.split('-')[0]) if '-' in chunk_str else int(chunk_str)
            
        chunks.sort(key=get_start_page)
        
        for chunk in chunks:
            part_name = f"temp/json/{filename}_part_{chunk}.json"
            blob_client = container_client.get_blob_client(part_name)
            if blob_client.exists():
                data = blob_client.download_blob().readall()
                partial_json = json.loads(data)
                # Append pages
                final_pages.extend(partial_json)
                
                # Cleanup partial json
                blob_client.delete_blob()
        
        # 2. Move File from temp/ to final location
        temp_blob_name = f"temp/{filename}"
        target_folder = category if category in ["drawings", "documents"] else "drawings"
        final_blob_name = f"{target_folder}/{filename}"
        
        source_blob = container_client.get_blob_client(temp_blob_name)
        dest_blob = container_client.get_blob_client(final_blob_name)
        
        # Copy
        if source_blob.exists():
            dest_blob.start_copy_from_url(source_blob.url)
            # Find a way to wait for copy? Usually instant for same account
            # But let's verify exists
            import time
            max_retries = 10
            while dest_blob.get_blob_properties().copy.status == 'pending' and max_retries > 0:
                time.sleep(0.5)
                max_retries -= 1
            
            # Delete temp
            if dest_blob.exists():
                 source_blob.delete_blob()

        # 3. Save Final JSON
        json_blob_name = f"json/{os.path.splitext(filename)[0]}.json"
        json_client = container_client.get_blob_client(json_blob_name)
        
        final_json_content = json.dumps(final_pages, ensure_ascii=False, indent=2)
        json_client.upload_blob(final_json_content, overwrite=True)
        
        # 4. Cleanup Status
        status_manager.mark_completed(filename)
        # Optionally delete status file:
        # status_blob = container_client.get_blob_client(f"temp/status/{filename}.status.json")
        # status_blob.delete_blob()
        
        return {"status": "completed", "final_path": final_blob_name}

    except Exception as e:
        print(f"Finalize Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/incomplete")
async def list_incomplete_jobs():
    try:
        container_client = get_container_client()
        # List blobs in temp/status/
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
        return [] # Return empty list on error

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
            
        # 3. Delete partial json chunks?
        # Listing and deleting might be expensive if many, but let's try to be clean
        # Uses detailed listing which might be slow, so maybe skip or do it async?
        # For now, let's leave partials or rely on a lifecycle policy for temp/ folder.
        # But we will try to delete the main partials if we can guess their names?
        # Without knowing how many chunks, we can't easily guess. 
        # So we just delete the main file and status, allowing Resume to restart fresh or User to retry.
        
        return {"status": "cleaned_up", "filename": filename}
        
    except Exception as e:
        print(f"Cleanup Failed: {e}")
        # Don't raise 500, just return error status, as this is best-effort
        return {"status": "error", "detail": str(e)}
