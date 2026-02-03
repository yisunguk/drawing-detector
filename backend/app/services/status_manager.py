
import json
from app.services.blob_storage import get_container_client

class StatusManager:
    def __init__(self):
        pass

    def _get_blob_client(self, filename):
        container = get_container_client()
        # Status file is stored in 'temp/status/{filename}.json'
        # Filename should be unique enough or use a UUID if possible, but for now we use the filename
        # assuming user uploads same file name. Ideally we'd use a unique ID.
        # But to resume, we need to know the filename.
        # Let's use the file path as key? "folder/filename.pdf" -> "temp/status/folder_filename.pdf.json"
        
        # Simple mapping: 
        status_blob_name = f"temp/status/{filename}.status.json"
        return container.get_blob_client(status_blob_name)

    def init_status(self, filename, total_pages, category):
        blob_client = self._get_blob_client(filename)
        status_data = {
            "filename": filename,
            "category": category,
            "total_pages": total_pages,
            "completed_chunks": [], # List of strings "start-end" or just IDs
            "analyzed_pages": [], # List of page numbers to be safer? No, chunk strings "1-30" is easier.
            "status": "in_progress", # in_progress, completed, error
            "last_updated": None # Timestamp
        }
        blob_client.upload_blob(json.dumps(status_data), overwrite=True)
        return status_data

    def get_status(self, filename):
        blob_client = self._get_blob_client(filename)
        if not blob_client.exists():
            return None
        
        data = blob_client.download_blob().readall()
        return json.loads(data)

    def update_chunk_progress(self, filename, chunk_range):
        status = self.get_status(filename)
        if not status:
            return None
        
        if chunk_range not in status["completed_chunks"]:
            status["completed_chunks"].append(chunk_range)
            # Sort or just keep as is
            
        blob_client = self._get_blob_client(filename)
        blob_client.upload_blob(json.dumps(status), overwrite=True)
        return status

    def mark_completed(self, filename):
        status = self.get_status(filename)
        if not status:
            return
        
        status["status"] = "completed"
        blob_client = self._get_blob_client(filename)
        blob_client.upload_blob(json.dumps(status), overwrite=True)
        # We might want to delete the status file eventually, but keeping it for now is safe.

status_manager = StatusManager()
