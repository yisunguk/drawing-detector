import asyncio
import os
import json
from dotenv import load_dotenv
load_dotenv() # Load env before importing config

from app.core.config import settings
from app.services.blob_storage import get_container_client, generate_sas_url
# from app.services.azure_di import azure_di_service # Don't use global service
# from app.services.azure_search import azure_search_service

from azure.ai.formrecognizer import DocumentAnalysisClient
from azure.core.credentials import AzureKeyCredential
from azure.core.pipeline.transport import RequestsTransport
from azure.search.documents import SearchClient
import logging

FILENAME = "119103_CONSOL_GMTP-CS-TS-031-T0.pdf"
CATEGORY = "drawings"

# Suppress warnings
logging.getLogger("azure.core.pipeline.policies.http_logging_policy").setLevel(logging.WARNING)

async def repair_data():
    print(f"Starting Repair for {FILENAME}...")
    
    # Debug Env
    print("Debug Env Keys:")
    for k, v in os.environ.items():
        if k.startswith("AZURE_"):
            print(f"  {k} = {'*' * len(v) if v else 'EMPTY'}")

    # 0. Setup Clients with SSL Bypass
    di_endpoint = settings.AZURE_FORM_RECOGNIZER_ENDPOINT
    di_key = settings.AZURE_FORM_RECOGNIZER_KEY
    search_endpoint = settings.AZURE_SEARCH_ENDPOINT
    search_key = settings.AZURE_SEARCH_KEY
    index_name = settings.AZURE_SEARCH_INDEX_NAME
    
    if not di_key or not search_key:
        print("ERROR: Missing Azure Credentials in env")
        return

    # DI Client
    di_client = DocumentAnalysisClient(
        endpoint=di_endpoint, 
        credential=AzureKeyCredential(di_key),
        transport=RequestsTransport(connection_verify=False)
    )
    
    # Search Client
    search_client = SearchClient(
        endpoint=search_endpoint,
        index_name=index_name,
        credential=AzureKeyCredential(search_key),
        transport=RequestsTransport(connection_verify=False)
    )

    # 1. Verify File Exists
    container = get_container_client()
    blob_path = f"{CATEGORY}/{FILENAME}"
    blob = container.get_blob_client(blob_path)
    
    if not blob.exists():
        print(f"ERROR: File not found at {blob_path}")
        return

    print(f"Found file at {blob_path}. Size: {blob.get_blob_properties().size}")

    # 2. Analyze
    print("Generating SAS URL...")
    sas_url = generate_sas_url(blob_path)
    
    print("Running Azure DI Analysis (This may take 1-2 mins)...")
    loop = asyncio.get_running_loop()
    try:
        # Define analyze function
        def analyze():
            poller = di_client.begin_analyze_document_from_url("prebuilt-layout", sas_url)
            result = poller.result()
            
            pages_data = []
            for page in result.pages:
                content = "\n".join([line.content for line in page.lines])
                pages_data.append({
                    "page_number": page.page_number,
                    "content": content,
                    "width": page.width,
                    "height": page.height,
                    "unit": page.unit
                })
            return pages_data

        pages = await loop.run_in_executor(None, analyze)
        print(f"Analysis Complete. extracted {len(pages)} pages.")
        
        # 3. Save JSON
        json_path = f"json/{FILENAME.replace('.pdf', '.json')}"
        print(f"Saving JSON to {json_path}...")
        json_client = container.get_blob_client(json_path)
        json_content = json.dumps(pages, ensure_ascii=False, indent=2)
        json_client.upload_blob(json_content, overwrite=True)
        print("JSON Saved.")

        # 4. Index
        print("Indexing to Azure Search...")
        import base64
        documents = []
        for page in pages:
            doc_id_raw = f"{FILENAME}_{page['page_number']}"
            doc_id = base64.urlsafe_b64encode(doc_id_raw.encode()).decode().strip("=")
            doc = {
                "id": doc_id,
                "content": page["content"],
                "source": FILENAME,
                "page": str(page["page_number"]),
                "title": FILENAME,
                "category": CATEGORY
            }
            documents.append(doc)
            
        result = search_client.upload_documents(documents=documents)
        print(f"Indexed {len(documents)} pages. Success: {all(r.succeeded for r in result)}")
        
    except Exception as e:
        print(f"Repair Failed: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(repair_data())
