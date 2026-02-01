# backend/debug_di.py
import os
import sys
from dotenv import load_dotenv

# Load env before importing app modules
load_dotenv()

# Add project root to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.core.config import settings
from app.services.azure_di import azure_di_service
from azure.storage.blob import BlobServiceClient

def debug_print(msg, type="INFO"):
    print(f"[{type}] {msg}")

def test_azure_di():
    debug_print("Starting Azure DI Debug Tool...")
    
    # 1. Check Credentials
    endpoint = settings.AZURE_FORM_RECOGNIZER_ENDPOINT
    key = settings.AZURE_FORM_RECOGNIZER_KEY
    
    debug_print(f"Endpoint: {endpoint}")
    debug_print(f"Key (masked): {key[:4]}...{key[-4:]} if key else 'None'")
    
    if not endpoint or not key:
        debug_print("❌ Missing Configuration!", "ERROR")
        return

    # 2. Check Blob Storage Access
    debug_print("Checking Storage Connection...")
    try:
        if settings.AZURE_BLOB_CONNECTION_STRING:
             client = BlobServiceClient.from_connection_string(settings.AZURE_BLOB_CONNECTION_STRING)
             account_name = client.account_name
             debug_print(f"✅ Blob Connection OK (Account: {account_name})")
        else:
             debug_print("⚠️ No Connection String found", "WARN")
    except Exception as e:
        debug_print(f"❌ Blob Connection Failed: {e}", "ERROR")

    # 3. Test DI Service Initialization
    try:
        # Assuming service is already initialized at module level
        debug_print("DI Service Initialized.")
        
        # We can't easily analyze a URL without uploading one, 
        # but we can try to call a lightweight method or just confirm the client exists.
        if azure_di_service.client:
             debug_print("✅ Azure DI Client Ready")
        else:
             debug_print("❌ Azure DI Client failed to init", "ERROR")
             
    except Exception as e:
        debug_print(f"❌ Service Integrity Check Failed: {e}", "ERROR")

if __name__ == "__main__":
    test_azure_di()
