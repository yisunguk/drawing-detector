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
        # 2. Construct SAS URL
        blob_url = blob_client.url
        sas_token = None
        
        # Priority: Generate a fresh, specific SAS using Connection String (Most Robust)
        if settings.AZURE_BLOB_CONNECTION_STRING:
            try:
                # Parse Connection String to get Key
                conn_str = settings.AZURE_BLOB_CONNECTION_STRING
                conn_dict = dict(item.split('=', 1) for item in conn_str.split(';') if '=' in item)
                
                if 'AccountName' in conn_dict and 'AccountKey' in conn_dict:
                    sas_token = generate_blob_sas(
                        account_name=conn_dict['AccountName'],
                        container_name=settings.AZURE_BLOB_CONTAINER_NAME,
                        blob_name=blob_name,
                        account_key=conn_dict['AccountKey'],
                        permission=BlobSasPermissions(read=True),
                        expiry=datetime.utcnow() + timedelta(hours=1)
                    )
                    print("Generated fresh SAS token from Connection String")
            except Exception as e:
                print(f"Failed to generate dynamic SAS: {e}")

        # Fallback: Use static SAS Token from settings
        if not sas_token and settings.AZURE_BLOB_SAS_TOKEN:
             # Sanitize and append
             # Strip whitespace and encode commas
             sas_token = settings.AZURE_BLOB_SAS_TOKEN.strip().replace(",", "%2C")
             if sas_token.startswith('?'): sas_token = sas_token[1:]
        
        if not sas_token:
             raise HTTPException(status_code=500, detail="SAS Token configuration missing for Analysis")

        full_url = f"{blob_url}?{sas_token}"

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
