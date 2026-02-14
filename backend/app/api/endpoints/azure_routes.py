from fastapi import APIRouter, HTTPException, Depends, Header, Request, Response, BackgroundTasks
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
from app.core.config import settings
from azure.storage.blob import BlobServiceClient
from azure.core.exceptions import ResourceNotFoundError
from app.services.blob_storage import get_container_client
from app.services.azure_search import azure_search_service
import io
import json
import time

router = APIRouter()

# In-memory debounce: user -> last cleanup timestamp
_cleanup_last_run: dict[str, float] = {}
_CLEANUP_COOLDOWN_SECONDS = 300  # 5 minutes


class ReindexRequest(BaseModel):
    username: str
    filename: str
    category: str


class CleanupIndexRequest(BaseModel):
    username: str

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
}

# Explicit OPTIONS handler for CORS preflight
@router.options("/download")
def download_options():
    return Response(status_code=200, headers=CORS_HEADERS)

@router.get("/list")
def list_files(path: str = ""):
    try:
        print(f"DEBUG: list_files called with path='{path}'")
        # Use Synchronous Client
        container_client = get_container_client()
        
        # Sanitize path
        path = path.lstrip('/')
        if path and not path.endswith('/'):
            path += '/'
            
        print(f"DEBUG: listing blobs with prefix='{path}'")
        
        items = []
        
        # Synchronous walk_blobs
        blobs = container_client.walk_blobs(name_starts_with=path, delimiter='/')
        
        count = 0
        MAX_ITEMS = 1000
        
        for item in blobs:
            if count >= MAX_ITEMS:
                break
                
            if item.name.endswith('/'):
                # Folder
                folder_name_full = item.name.rstrip('/') 
                folder_name_display = folder_name_full.split('/')[-1]
                
                items.append({
                    "name": folder_name_display,
                    "type": "folder",
                    "path": item.name
                })
            else:
                # File
                file_name_display = item.name.split('/')[-1]
                items.append({
                    "name": file_name_display,
                    "type": "file",
                    "path": item.name,
                    "size": item.size,
                    "last_modified": item.last_modified.isoformat() if item.last_modified else None
                })
            count += 1
            
        return items
    except Exception as e:
        print(f"Error in list_files: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/download")
def download_file(path: str, range: str = Header(None)):
    try:
        print(f"DEBUG: Download requested for path: '{path}' (Type: {type(path)})")
        container_client = get_container_client()
        blob_client = container_client.get_blob_client(path)
        
        # Get blob properties for size (Synchronous)
        try:
            props = blob_client.get_blob_properties()
        except ResourceNotFoundError:
             print(f"Error: Blob not found at path: {path}")
             raise HTTPException(status_code=404, detail="File not found")

        file_size = props.size
        
        # Default to full download
        offset = 0
        length = None
        status_code = 200
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
            **CORS_HEADERS,
        }
        
        # Handle Range Header
        if range:
            try:
                start, end = range.replace("bytes=", "").split("-")
                start = int(start)
                end = int(end) if end else file_size - 1
                
                if start >= file_size:
                    raise HTTPException(status_code=416, detail="Requested Range Not Satisfiable")
                    
                offset = start
                length = end - start + 1
                status_code = 206
                headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
                headers["Content-Length"] = str(length)
            except ValueError:
                pass 
        
        # Download stream (Synchronous)
        try:
            download_stream = blob_client.download_blob(offset=offset, length=length)
        except ResourceNotFoundError:
             raise HTTPException(status_code=404, detail="File not found during download")
        
        # Synchronous generator with explicit chunk handling
        def stream_generator():
            # Iterate chunks cleanly
            for chunk in download_stream.chunks():
                yield chunk

        media_type = "application/pdf"
        if path.lower().endswith(".json"):
            media_type = "application/json"
            
        return StreamingResponse(
            stream_generator(), 
            status_code=status_code, 
            headers=headers, 
            media_type=media_type
        )
    except HTTPException as he:
        return JSONResponse(
            status_code=he.status_code,
            content={"detail": he.detail},
            headers=CORS_HEADERS,
        )
    except Exception as e:
        print(f"Error in download_file: {e}")
        return JSONResponse(
            status_code=500,
            content={"detail": str(e)},
            headers=CORS_HEADERS,
        )


@router.get("/index-status")
def get_index_status(username: str, background_tasks: BackgroundTasks):
    """Get indexing status for all files of a given user."""
    try:
        print(f"[index-status] Checking index status for user: {username}", flush=True)

        # 1. Get indexed file → page count from Azure Search
        indexed = azure_search_service.get_indexed_facets(username)
        print(f"[index-status] Found {len(indexed)} indexed files in Azure Search", flush=True)

        # 2. Check which files have JSON analysis results in blob storage
        container_client = get_container_client()
        json_set = set()
        prefix = f"{username}/json/"
        for blob in container_client.walk_blobs(name_starts_with=prefix, delimiter="/"):
            name = blob.name.rstrip("/").split("/")[-1]
            if name.endswith(".json"):
                # Legacy format: filename.pdf.json → filename.pdf
                json_set.add(name.rsplit(".json", 1)[0])
            else:
                # Split format: folder name is the filename (e.g., filename.pdf/)
                json_set.add(name)

        print(f"[index-status] Found {len(json_set)} JSON entries in blob storage", flush=True)

        # 3. Combine into response
        all_files = set(indexed.keys()) | json_set
        files = {}
        for fname in all_files:
            files[fname] = {
                "indexed_pages": indexed.get(fname, 0),
                "json_exists": fname in json_set
            }

        # 4. Schedule background cleanup (debounced per user, 5-min cooldown)
        now = time.time()
        last_run = _cleanup_last_run.get(username, 0)
        if now - last_run > _CLEANUP_COOLDOWN_SECONDS:
            _cleanup_last_run[username] = now
            background_tasks.add_task(_run_background_cleanup, username)

        return {"files": files}
    except Exception as e:
        print(f"Error in get_index_status: {e}", flush=True)
        raise HTTPException(status_code=500, detail=str(e))


def _run_background_cleanup(username: str):
    """Background task to clean up orphaned index entries."""
    try:
        result = azure_search_service.cleanup_orphaned_index(username)
        if result["deleted_count"] > 0:
            print(f"[index-status] Background cleanup for {username}: removed {result['deleted_count']} orphaned entries", flush=True)
    except Exception as e:
        print(f"[index-status] Background cleanup error for {username}: {e}", flush=True)


@router.post("/reindex-from-json")
def reindex_from_json(req: ReindexRequest):
    """Re-index a file from its existing JSON analysis results."""
    try:
        print(f"[reindex] Starting reindex for {req.username}/{req.category}/{req.filename}", flush=True)
        container_client = get_container_client()

        pages_data = []

        # Try split format first: {username}/json/{filename}/page_N.json
        split_prefix = f"{req.username}/json/{req.filename}/"
        split_blobs = list(container_client.list_blobs(name_starts_with=split_prefix))
        page_blobs = [b for b in split_blobs if b.name.split("/")[-1].startswith("page_")]

        if page_blobs:
            print(f"[reindex] Found split format: {len(page_blobs)} page files", flush=True)
            # Sort by page number
            page_blobs.sort(key=lambda b: int(b.name.split("/")[-1].replace("page_", "").replace(".json", "")))
            for blob in page_blobs:
                blob_client = container_client.get_blob_client(blob.name)
                data = blob_client.download_blob().readall()
                page = json.loads(data)
                pages_data.append(page)
        else:
            # Try legacy format: {username}/json/{filename}.json
            legacy_path = f"{req.username}/json/{req.filename}.json"
            print(f"[reindex] Trying legacy format: {legacy_path}", flush=True)
            try:
                blob_client = container_client.get_blob_client(legacy_path)
                data = blob_client.download_blob().readall()
                json_content = json.loads(data)
                # Legacy format may have pages_data as a list or wrapped in an object
                if isinstance(json_content, list):
                    pages_data = json_content
                elif isinstance(json_content, dict) and "pages" in json_content:
                    pages_data = json_content["pages"]
                elif isinstance(json_content, dict) and "pages_data" in json_content:
                    pages_data = json_content["pages_data"]
                else:
                    pages_data = [json_content]
            except ResourceNotFoundError:
                raise HTTPException(status_code=404, detail=f"No JSON analysis found for {req.filename}")

        if not pages_data:
            raise HTTPException(status_code=404, detail=f"No page data found for {req.filename}")

        print(f"[reindex] Loaded {len(pages_data)} pages, starting indexing...", flush=True)

        # Build blob_name for index_documents
        blob_name = f"{req.username}/{req.category}/{req.filename}"

        # Call existing index_documents
        azure_search_service.index_documents(
            filename=req.filename,
            category=req.category,
            pages_data=pages_data,
            blob_name=blob_name
        )

        print(f"[reindex] Completed reindex for {req.filename}: {len(pages_data)} pages", flush=True)
        return {"status": "success", "pages_indexed": len(pages_data)}
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in reindex_from_json: {e}", flush=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cleanup-index")
def cleanup_index(req: CleanupIndexRequest):
    """Delete index entries whose blobs no longer exist in storage."""
    try:
        print(f"[cleanup-index] Starting cleanup for user: {req.username}", flush=True)
        result = azure_search_service.cleanup_orphaned_index(req.username)
        print(f"[cleanup-index] Done: {result['deleted_count']} documents removed", flush=True)
        return result
    except Exception as e:
        print(f"Error in cleanup_index: {e}", flush=True)
        raise HTTPException(status_code=500, detail=str(e))
