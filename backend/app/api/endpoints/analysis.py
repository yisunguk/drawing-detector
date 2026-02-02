from fastapi import APIRouter, UploadFile, File, HTTPException
from app.services.azure_di import azure_di_service
from app.services.blob_storage import get_container_client
from azure.storage.blob import generate_blob_sas, BlobSasPermissions
from app.core.config import settings
from datetime import datetime, timedelta
import json
import os

router = APIRouter()

@router.post("/local")
async def analyze_local_file(file: UploadFile = File(...)):
    try:
        # 1. Upload file to Azure Blob (drawings folder)
        container_client = get_container_client()
        blob_name = f"drawings/{file.filename}"
        blob_client = container_client.get_blob_client(blob_name)
        
        file_content = await file.read()
        blob_client.upload_blob(file_content, overwrite=True)
        
        # 2. Construct SAS URL
        # If we are using a general SAS token from settings, we can just use that.
        blob_url = blob_client.url
        
        if settings.AZURE_BLOB_SAS_TOKEN:
             # Sanitize and append
             # Strip whitespace (crucial for URL) and encode commas (for spr=https,http -> spr=https%2Chttp)
             sas = settings.AZURE_BLOB_SAS_TOKEN.strip().replace(",", "%2C")
             if sas.startswith('?'): sas = sas[1:]
             full_url = f"{blob_url}?{sas}"
        else:
             # Fallback: Try to generate if we had a key (But we likely don't)
             # This block will likely fail if no account key is configured
             raise HTTPException(status_code=500, detail="SAS Token configuration missing for Analysis")

        # 3. Trigger DI Analysis
        print(f"Analyzing document: {full_url}")
        analysis_result = azure_di_service.analyze_document_from_url(full_url)
        
        # 4. Save result to Azure Blob (json folder)
        json_blob_name = f"json/{os.path.splitext(file.filename)[0]}.json"
        json_blob_client = container_client.get_blob_client(json_blob_name)
        
        json_content = json.dumps(analysis_result, ensure_ascii=False, indent=2)
        json_blob_client.upload_blob(json_content, overwrite=True)
        
        return analysis_result

    except Exception as e:
        print(f"Analysis Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
