"""
Blob Storage Monitor Service

Monitors Azure Blob Storage for new PDF uploads and automatically triggers DI analysis.
Runs as a background task polling for new files without corresponding JSON.
"""

import asyncio
import os
import tempfile
from datetime import datetime, timedelta
from typing import Set
from azure.storage.blob import ContainerClient

from app.services.blob_storage import get_container_client
from app.services.status_manager import status_manager
from app.services.robust_analysis_manager import robust_analysis_manager


def _count_pdf_pages(blob_data: bytes) -> int:
    """Count pages in a PDF using PyMuPDF without writing to disk."""
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(stream=blob_data, filetype="pdf")
        page_count = len(doc)
        doc.close()
        return page_count
    except Exception as e:
        print(f"[BlobMonitor] Failed to count PDF pages: {e}")
        return 0


class BlobMonitor:
    """Monitors blob storage for new PDF uploads"""

    def __init__(self):
        self.processing: Set[str] = set()  # Track files currently being processed
        self.poll_interval = 300  # seconds (5 min - cost optimization)

    async def start_monitor(self):
        """Start the monitoring loop"""
        print("[BlobMonitor] Starting blob storage monitor...")

        while True:
            try:
                await self.check_for_new_files()
            except Exception as e:
                print(f"[BlobMonitor] Error in monitoring loop: {e}")
                import traceback
                traceback.print_exc()

            await asyncio.sleep(self.poll_interval)

    async def check_for_new_files(self):
        """Check for PDFs without corresponding JSON"""
        container = get_container_client()

        # Get all blobs
        all_blobs = list(container.list_blobs())

        # Group by user and find PDFs in my-documents without JSON
        users_with_files = {}

        for blob in all_blobs:
            parts = blob.name.split('/')
            if len(parts) < 3:
                continue

            username = parts[0]
            folder = parts[1]
            filename = parts[2]

            # Look for PDFs in my-documents
            if folder == 'my-documents' and filename.lower().endswith('.pdf'):
                if username not in users_with_files:
                    users_with_files[username] = {'pdfs': [], 'jsons': set()}
                users_with_files[username]['pdfs'].append(blob.name)

            # Track JSON files
            elif folder == 'json' and filename.lower().endswith('.json'):
                if username not in users_with_files:
                    users_with_files[username] = {'pdfs': [], 'jsons': set()}
                # Store base name without .json extension
                base_name = filename[:-5]  # Remove .json
                users_with_files[username]['jsons'].add(base_name)

        # Find PDFs without JSON
        for username, files in users_with_files.items():
            for pdf_blob in files['pdfs']:
                pdf_filename = os.path.basename(pdf_blob)
                base_name = pdf_filename[:-4]  # Remove .pdf

                # Check if JSON exists
                if base_name not in files['jsons']:
                    # Check if already processing
                    if pdf_blob in self.processing:
                        continue

                    # Check status - don't re-trigger if in progress or failed
                    status = status_manager.get_status(pdf_filename, username=username)
                    if status:
                        state = status.get('status', '')
                        if state in ['in_progress', 'retrying', 'finalizing']:
                            print(f"[BlobMonitor] Skipping {pdf_filename} - already {state}")
                            continue
                        elif state == 'failed':
                            retry_count = status.get('retry_count', 0)
                            if retry_count >= 3:
                                print(f"[BlobMonitor] Skipping {pdf_filename} - max retries exceeded")
                                continue

                    # New file found - trigger analysis
                    print(f"[BlobMonitor] Found new PDF without JSON: {pdf_blob}")
                    await self.trigger_analysis(pdf_blob, username)

    async def trigger_analysis(self, blob_name: str, username: str):
        """Trigger DI analysis for a new file"""
        try:
            filename = os.path.basename(blob_name)
            self.processing.add(blob_name)

            print(f"[BlobMonitor] Triggering analysis for {filename}...")

            # H3 FIX: Get actual page count from PDF instead of hardcoding 100
            container = get_container_client()
            blob_client = container.get_blob_client(blob_name)

            total_pages = 0
            try:
                pdf_data = blob_client.download_blob().readall()
                total_pages = _count_pdf_pages(pdf_data)
                del pdf_data  # Free memory
                print(f"[BlobMonitor] Detected {total_pages} pages in {filename}")
            except Exception as e:
                print(f"[BlobMonitor] Failed to detect page count for {filename}: {e}")

            if total_pages <= 0:
                # Fallback: use a generous estimate to avoid missing pages
                total_pages = 500
                print(f"[BlobMonitor] Using fallback page count: {total_pages}")

            # Initialize status (with username scope)
            status_manager.init_status(filename, total_pages, 'my-documents', username=username)

            # Start analysis (with username propagation)
            await robust_analysis_manager.run_analysis_loop(
                filename=filename,
                blob_name=blob_name,
                total_pages=total_pages,
                category='my-documents',
                username=username
            )

            print(f"[BlobMonitor] Analysis completed for {filename}")

        except Exception as e:
            print(f"[BlobMonitor] Failed to trigger analysis for {blob_name}: {e}")
            import traceback
            traceback.print_exc()
        finally:
            self.processing.discard(blob_name)


# Global instance
blob_monitor = BlobMonitor()


async def start_monitor():
    """Entry point to start the blob monitor"""
    await blob_monitor.start_monitor()
