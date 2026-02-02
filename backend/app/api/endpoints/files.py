from fastapi import APIRouter, HTTPException, Query
from app.services.blob_storage import get_container_client, generate_sas_url
from app.core.config import settings
import os

router = APIRouter()

@router.get("/list")
async def list_files():
    """
    List all PDF files from common 'drawings' and 'documents' folders in Azure Blob Storage.
    """
    try:
        container_client = get_container_client()
        
        # Get all blobs from container
        # Note: walk_blobs might be more efficient if we want to filter by prefix, 
        # but list_blobs is fine for listing everything flatten
        all_blobs = list(container_client.list_blobs())
        
        files = []
        for blob in all_blobs:
            # Filter logic:
            # 1. Must be .pdf
            # 2. Must be in 'drawings/' or 'documents/' folder (directly or nested)
            # 3. Ignore other folders (like 'json/', or user folders if any exist)
            
            if not blob.name.lower().endswith('.pdf'):
                continue
                
            parts = blob.name.split('/')
            
            # Check for top-level folder
            if len(parts) > 1 and parts[0] in ['drawings', 'documents']:
                category = parts[0]
                filename = parts[-1] # Simple filename for display
                
                # If nested, full path logic? 
                # Let's keep it simple: Category | Filename | Size | Date
                
                # Format size
                size_mb = blob.size / (1024 * 1024)
                size_str = f"{size_mb:.2f} MB"
                
                files.append({
                    'filename': filename,
                    'fullPath': blob.name,
                    'category': category,
                    'size': size_str,
                    'lastModified': blob.last_modified.isoformat() if blob.last_modified else None
                })
        
        # Sort by date descending (newest first)
        files.sort(key=lambda x: x.get('lastModified', ''), reverse=True)
        
        return {
            'success': True,
            'files': files
        }
        
    except Exception as e:
        print(f"Error listing files: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list files: {str(e)}")

@router.get("/download")
async def get_download_url(path: str = Query(..., description="Blob path to download")):
    """
    Generate a SAS URL for downloading a file.
    """
    try:
        # Generate SAS URL (valid for 1 hour)
        sas_url = generate_sas_url(path, duration_hours=1)
        
        if not sas_url:
            raise HTTPException(status_code=500, detail="Failed to generate download URL")
            
        return {
            'success': True,
            'downloadUrl': sas_url
        }
    except Exception as e:
        print(f"Error generating download URL: {e}")
        raise HTTPException(status_code=500, detail=str(e))
