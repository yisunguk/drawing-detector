from fastapi import APIRouter, HTTPException, Depends, Header, Request, Response
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
from app.core.config import settings
from azure.storage.blob import BlobServiceClient
from azure.core.exceptions import ResourceNotFoundError
from app.services.blob_storage import get_container_client
from app.services.azure_search import azure_search_service
from app.services.lessons_search import lessons_search_service
from app.services.revision_search import revision_search_service
from app.services.linelist_search import linelist_search_service
import io
import json

router = APIRouter()


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
def list_files(path: str = "", recursive: bool = False):
    try:
        print(f"DEBUG: list_files called with path='{path}', recursive={recursive}")
        # Use Synchronous Client
        container_client = get_container_client()

        # Sanitize path
        path = path.lstrip('/')
        if path and not path.endswith('/'):
            path += '/'

        print(f"DEBUG: listing blobs with prefix='{path}'")

        items = []
        count = 0
        MAX_ITEMS = 1000

        if recursive:
            # Recursive: list all blobs without delimiter (flat list of files only)
            blobs = container_client.list_blobs(name_starts_with=path)
            for item in blobs:
                if count >= MAX_ITEMS:
                    break
                file_name_display = item.name.split('/')[-1]
                items.append({
                    "name": file_name_display,
                    "type": "file",
                    "path": item.name,
                    "size": item.size,
                    "last_modified": item.last_modified.isoformat() if item.last_modified else None
                })
                count += 1
        else:
            # Non-recursive: walk_blobs with delimiter (folders + files at current level)
            blobs = container_client.walk_blobs(name_starts_with=path, delimiter='/')
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
def get_index_status(username: str, folder: str = ""):
    """Get indexing status for all files of a given user.

    The `folder` parameter selects the correct Azure Search index:
      - lessons  → lessons-learned-index
      - revision → revision-master-index
      - (others) → pdf-search-index (documents, drawings, etc.)
    """
    try:
        print(f"[index-status] Checking index status for user: {username}, folder: {folder}", flush=True)

        # ── lessons / revision: dedicated indexes, no JSON step ──
        if folder == "lessons":
            indexed = lessons_search_service.get_indexed_facets(username)
            print(f"[index-status] Found {len(indexed)} indexed files in lessons-learned-index", flush=True)
            files = {}
            for fname, count in indexed.items():
                files[fname] = {"indexed_pages": count, "json_exists": True}
            return {"files": files}

        if folder == "revision":
            indexed = revision_search_service.get_indexed_facets(username)
            print(f"[index-status] Found {len(indexed)} indexed files in revision-master-index", flush=True)
            files = {}
            for fname, count in indexed.items():
                files[fname] = {"indexed_pages": count, "json_exists": True}
            return {"files": files}

        if folder == "line":
            indexed = linelist_search_service.get_indexed_facets(username)
            print(f"[index-status] Found {len(indexed)} indexed files in linelist-index", flush=True)
            files = {}
            for fname, count in indexed.items():
                files[fname] = {"indexed_pages": count, "json_exists": True}
            return {"files": files}

        # ── Default: pdf-search-index (documents, drawings, etc.) ──
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
                base = name.rsplit(".json", 1)[0]
                json_set.add(base)
                # Also add .pdf variant (some JSONs are named file.json not file.pdf.json)
                if not base.lower().endswith('.pdf'):
                    json_set.add(base + '.pdf')
            else:
                # Split format: folder name is the filename (e.g., filename.pdf/)
                json_set.add(name)

        print(f"[index-status] Found {len(json_set)} JSON entries in blob storage", flush=True)

        # 3. Normalize indexed keys: add .pdf variant if missing
        normalized_indexed = {}
        for fname, count in indexed.items():
            normalized_indexed[fname] = count
            if not fname.lower().endswith('.pdf'):
                normalized_indexed[fname + '.pdf'] = count

        # 4. Combine into response
        all_files = set(normalized_indexed.keys()) | json_set
        files = {}
        for fname in all_files:
            files[fname] = {
                "indexed_pages": normalized_indexed.get(fname, 0),
                "json_exists": fname in json_set
            }

        return {"files": files}
    except Exception as e:
        print(f"Error in get_index_status: {e}", flush=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/debug-linelist-index")
def debug_linelist_index(username: str = "", source_file: str = ""):
    """Temporary debug: check linelist-index data + optionally trigger re-index from blob JSON."""
    try:
        client = linelist_search_service.client
        if not client:
            return {"error": "linelist search client not initialized"}

        # Check index contents
        results = client.search(
            search_text="*",
            facets=["source_file,count:100"],
            top=3,
            include_total_count=True,
        )
        count = results.get_count()
        facets = results.get_facets()
        samples = []
        for r in results:
            samples.append({"username": r.get("username"), "source_file": r.get("source_file"), "line_number": r.get("line_number")})

        info = {
            "total_documents": count,
            "source_file_facets": {f["value"]: f["count"] for f in facets.get("source_file", [])},
            "sample_docs": samples,
        }

        # If username + source_file given, try to re-index from _linelist.json in blob
        if username and source_file:
            import os
            container_client = get_container_client()
            base_name = os.path.splitext(source_file)[0]
            json_blob_name = f"{username}/json/{base_name}_linelist.json"
            try:
                blob_client = container_client.get_blob_client(json_blob_name)
                data = json.loads(blob_client.download_blob().readall())
                lines = data.get("lines", [])
                blob_path = f"{username}/line/{source_file}"
                if lines:
                    linelist_search_service.delete_by_source_file(source_file, username)
                    indexed = linelist_search_service.index_lines(lines, username, source_file, blob_path)
                    info["reindex_result"] = {"lines_found": len(lines), "lines_indexed": indexed}
                else:
                    info["reindex_result"] = {"error": "no lines in JSON", "json_path": json_blob_name}
            except Exception as e:
                info["reindex_result"] = {"error": str(e), "json_path": json_blob_name}

        return info
    except Exception as e:
        return {"error": str(e)}


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
            # Try legacy formats:
            #   1) {username}/json/{filename}.json  (e.g. file.pdf.json)
            #   2) {username}/json/{basename}.json  (e.g. file.json, without .pdf)
            candidates = [f"{req.username}/json/{req.filename}.json"]
            if req.filename.lower().endswith('.pdf'):
                candidates.append(f"{req.username}/json/{req.filename[:-4]}.json")

            data = None
            for legacy_path in candidates:
                print(f"[reindex] Trying legacy format: {legacy_path}", flush=True)
                try:
                    blob_client = container_client.get_blob_client(legacy_path)
                    data = blob_client.download_blob().readall()
                    print(f"[reindex] Found JSON at: {legacy_path}", flush=True)
                    break
                except ResourceNotFoundError:
                    continue

            if data is None:
                raise HTTPException(status_code=404, detail=f"No JSON analysis found for {req.filename}")

            json_content = json.loads(data)
            print(f"[reindex] JSON type={type(json_content).__name__}, "
                  f"keys={list(json_content.keys()) if isinstance(json_content, dict) else f'len={len(json_content)}'}", flush=True)
            # Legacy format may have pages_data as a list or wrapped in an object
            if isinstance(json_content, list):
                pages_data = json_content
            elif isinstance(json_content, dict) and "pages" in json_content:
                pages_data = json_content["pages"]
            elif isinstance(json_content, dict) and "pages_data" in json_content:
                pages_data = json_content["pages_data"]
            else:
                pages_data = [json_content]

        if not pages_data:
            print(f"[reindex] ERROR: pages_data is empty for {req.filename}", flush=True)
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


@router.post("/cleanup-all-users")
def cleanup_all_users(x_cron_secret: str = Header(None)):
    """
    Daily batch cleanup: scan ALL users and remove orphaned index entries.
    Protected by CRON_SECRET header — intended for Cloud Scheduler.
    """
    if not settings.CRON_SECRET or x_cron_secret != settings.CRON_SECRET:
        raise HTTPException(status_code=403, detail="Forbidden")

    try:
        print("[cleanup-all-users] Starting daily batch cleanup...", flush=True)
        result = azure_search_service.cleanup_all_users()
        print(f"[cleanup-all-users] Done: {result['users_scanned']} users scanned, {result['deleted_count']} documents removed", flush=True)
        return result
    except Exception as e:
        print(f"Error in cleanup_all_users: {e}", flush=True)
        raise HTTPException(status_code=500, detail=str(e))
