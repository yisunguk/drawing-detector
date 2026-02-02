from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from app.services.azure_di import azure_di_service
from app.services.blob_storage import get_container_client
from azure.storage.blob import generate_blob_sas, BlobSasPermissions
from app.core.config import settings
from datetime import datetime, timedelta
import json
import os

router = APIRouter()

@router.post("/local")
async def analyze_local_file(
    file: UploadFile = File(...),
    username: str = Form(None)
):
    try:
        # 1. Upload file to Azure Blob
        container_client = get_container_client()
        
        # Determine path based on username
        if username:
            blob_name = f"{username}/drawings/{file.filename}"
            json_blob_name = f"{username}/json/{os.path.splitext(file.filename)[0]}.json"
        else:
            blob_name = f"drawings/{file.filename}"
            json_blob_name = f"json/{os.path.splitext(file.filename)[0]}.json"

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
