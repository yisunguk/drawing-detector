import asyncio
import os
from azure.storage.blob.aio import BlobServiceClient
from dotenv import load_dotenv

load_dotenv()

async def test_azure_list():
    conn_str = os.getenv("AZURE_BLOB_CONNECTION_STRING")
    account_name = os.getenv("AZURE_STORAGE_ACCOUNT_NAME")
    sas_token = os.getenv("AZURE_BLOB_SAS_TOKEN")
    container_name = os.getenv("AZURE_BLOB_CONTAINER_NAME", "drawings")

    blob_service_client = None

    print(f"DEBUG: Account: {account_name}")
    print(f"DEBUG: Container: {container_name}")

    if account_name and sas_token:
        sas_token = sas_token.replace("%2C", ",").strip()
        account_url = f"https://{account_name}.blob.core.windows.net"
        blob_service_client = BlobServiceClient(account_url, credential=sas_token)
        print("Using SAS Token Auth")
    elif conn_str:
        blob_service_client = BlobServiceClient.from_connection_string(conn_str)
        print("Using Connection String Auth")
    
    if not blob_service_client:
        print("Failed to initialize client")
        return

    try:
        container_client = blob_service_client.get_container_client(container_name)
        async with container_client:
            print("Listing blobs at root...")
            blobs = container_client.walk_blobs(name_starts_with="", delimiter='/')
            count = 0
            async for item in blobs:
                print(f" - {item.name}")
                count += 1
                if count >= 5:
                    break
            print(f"Successfully listed {count} items.")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        await blob_service_client.close()

if __name__ == "__main__":
    asyncio.run(test_azure_list())
