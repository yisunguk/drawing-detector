from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Body
from app.services.azure_di import azure_di_service
from app.services.blob_storage import get_container_client
from app.services.status_manager import status_manager
from azure.storage.blob import generate_blob_sas, BlobSasPermissions
from app.core.config import settings
from datetime import datetime, timedelta
import json
import os
import asyncio

router = APIRouter()

def generate_sas_url(blob_name):
    # Helper to generate a SAS URL for a blob
    if not settings.AZURE_STORAGE_ACCOUNT_NAME or not settings.AZURE_BLOB_SAS_TOKEN:
         # Fallback or error if using connection string implies we might not have key? 
         # Used for DI which needs a URL. If using Managed Identity it's easier, but here we assume SAS or Key.
         # For simplicity, if we have a SAS token in settings, we append it.
         pass

    # If we have a SAS token in settings (account level), we can validly construct the URL:
    # URL = https://<account>.blob.core.windows.net/<container>/<blob>?<sas>
    
    # Clean SAS token
    sas_token = settings.AZURE_BLOB_SAS_TOKEN.replace("%2C", ",").strip()
    if sas_token.startswith("?"):
        sas_token = sas_token[1:]

    url = f"https://{settings.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{blob_name}?{sas_token}"
    return url

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
        
        return analysis_result

    except Exception as e:
        print(f"Analysis Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# --- Batch Indexing Endpoints ---

@router.post("/init")
async def init_analysis(
    file: UploadFile = File(...),
    total_pages: int = Form(...),
    category: str = Form("drawings")
):
    try:
        # 1. Upload to temp/ folder
        container_client = get_container_client()
        temp_blob_name = f"temp/{file.filename}"
        
        blob_client = container_client.get_blob_client(temp_blob_name)
        file_content = await file.read()
        blob_client.upload_blob(file_content, overwrite=True)
        
        # 2. Initialize Status
        status = status_manager.init_status(file.filename, total_pages, category)
        
        return {"status": "initialized", "blob_name": temp_blob_name, "info": status}
    except Exception as e:
        print(f"Init Failed: {e}")
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
            
            if status.get("status") == "in_progress":
                incomplete_jobs.append(status)
                
        return incomplete_jobs
    except Exception as e:
        print(f"List Incomplete Failed: {e}")
        return [] # Return empty list on error
