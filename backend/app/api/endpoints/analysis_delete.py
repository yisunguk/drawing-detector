
@router.delete("/doc/{filename}")
async def delete_document(
    filename: str,
    username: str = Query(None),
    category: str = Query("documents")
):
    """
    Deletes a document and its associated analysis files and search index entries.
    """
    try:
        from app.services.blob_storage import get_container_client
        from app.services.azure_search import azure_search_service
        from app.services.status_manager import status_manager
        import os

        # 1. Paths
        pdf_path = f"{username}/{category}/{filename}" if username else f"{category}/{filename}"
        json_filename = os.path.splitext(filename)[0] + ".json"
        json_path = f"{username}/json/{json_filename}" if username else f"json/{json_filename}"
        
        container_client = get_container_client()

        # 2. Delete Blobs
        for path in [pdf_path, json_path]:
            try:
                blob_client = container_client.get_blob_client(path)
                if blob_client.exists():
                    blob_client.delete_blob()
                    print(f"[Delete] Deleted blob: {path}")
            except Exception as e:
                print(f"[Delete] Warning: Failed to delete {path}: {e}")

        # 3. Cleanup temp chunks and status
        status_manager.reset_status(filename)
        
        # 4. Delete from Azure Search
        try:
            # Reconstruct doc tags/IDs if needed, or just search by source and delete
            # We search for all documents where 'source' == filename
            search_client = azure_search_service.client
            if search_client:
                results = search_client.search(search_text="*", filter=f"source eq '{filename}'", select=["id"])
                doc_ids = [r["id"] for r in results]
                if doc_ids:
                    search_client.delete_documents(documents=[{"id": doc_id} for doc_id in doc_ids])
                    print(f"[Delete] Deleted {len(doc_ids)} documents from search index")
        except Exception as e:
            print(f"[Delete] Warning: Failed to clean Search Index: {e}")

        return {"status": "success", "message": f"Document {filename} deleted successfully"}

    except Exception as e:
        print(f"[Delete] Critical Failure: {e}")
        raise HTTPException(status_code=500, detail=str(e))
