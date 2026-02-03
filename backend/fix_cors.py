import os
import sys
from azure.storage.blob import BlobServiceClient, CorsRule
from dotenv import load_dotenv

# Load env vars from .env file
load_dotenv()

def fix_cors():
    print("Attempting to fix CORS settings for Azure Blob Storage...")
    
    connect_str = os.getenv("AZURE_BLOB_CONNECTION_STRING")
    account_name = os.getenv("AZURE_STORAGE_ACCOUNT_NAME")
    sas_token = os.getenv("AZURE_BLOB_SAS_TOKEN")
    
    blob_service_client = None
    
    if connect_str:
        print("Using Connection String...")
        try:
            blob_service_client = BlobServiceClient.from_connection_string(connect_str)
        except Exception as e:
            print(f"Error creating client from connection string: {e}")

    if not blob_service_client and account_name and sas_token:
        print("Using SAS Token...")
        try:
            sas_token = sas_token.replace("%2C", ",").strip()
            if sas_token.startswith("?"):
                sas_token = sas_token[1:]
            account_url = f"https://{account_name}.blob.core.windows.net"
            blob_service_client = BlobServiceClient(account_url, credential=sas_token)
        except Exception as e:
            print(f"Error creating client from SAS: {e}")
            
    if not blob_service_client:
        print("Failed to authorize. Please check your .env file.")
        return

    # Define CORS rule
    cors_rule = CorsRule(
        allowed_origins=["*"], # Allow all origins (or specify your app's domain)
        allowed_methods=["GET", "PUT", "POST", "OPTIONS", "HEAD"],
        allowed_headers=["*"],
        exposed_headers=["*"],
        max_age_in_seconds=3600
    )

    try:
        print("Setting Service Properties (CORS)...")
        blob_service_client.set_service_properties(cors=[cors_rule])
        print("Successfully updated CORS settings!")
        
        # Verify
        props = blob_service_client.get_service_properties()
        print("Current CORS Rules:")
        for rule in props.cors:
            print(f"- Origins: {rule.allowed_origins}, Methods: {rule.allowed_methods}")
            
    except Exception as e:
        print(f"Failed to set CORS properties. You might not have permission (Account Key required, SAS might not be enough).")
        print(f"Error: {e}")
        print("\nACTION REQUIRED: Please go to Azure Portal -> Storage Account -> Resource Sharing (CORS) -> Blob service")
        print("And add a rule: Origins=*, Methods=GET,PUT,OPTIONS, Headers=*, ExposedHeaders=*")

if __name__ == "__main__":
    fix_cors()
