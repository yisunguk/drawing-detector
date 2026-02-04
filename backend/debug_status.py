import asyncio
import os
from app.services.blob_storage import get_container_client

async def list_blobs():
    print("Connecting to Blob Storage...")
    try:
        container_client = get_container_client()
        
        target_file = "119103_CONSOL_GMTP-CS-TS-031-T0.pdf"
        print(f"\n--- Forensic Check for {target_file} ---")
        
        # 1. Check Temp Source
        blob_temp = container_client.get_blob_client(f"temp/{target_file}")
        print(f"[TEMP] exists: {blob_temp.exists()}")
        
        # 2. Check Final Destination (drawings/)
        blob_final = container_client.get_blob_client(f"drawings/{target_file}")
        if blob_final.exists():
             size_bytes = blob_final.get_blob_properties().size
             print(f"[FINAL] exists: True, Size: {size_bytes / 1024 / 1024:.2f} MB")
        else:
             print("[FINAL] exists: False")

        # 3. Check Status
        status_blob = container_client.get_blob_client(f"temp/status/{target_file}.status.json")
        if status_blob.exists():
            data = status_blob.download_blob().readall()
            print(f"[STATUS] content: {data.decode('utf-8')}")
        else:
            print(f"[STATUS] Not found")

        # 4. Check JSON Output
        json_name = target_file.replace(".pdf", ".json")
        json_blob = container_client.get_blob_client(f"json/{json_name}")
        if json_blob.exists():
            props = json_blob.get_blob_properties()
            print(f"[JSON] Found! Size: {props.size} bytes")
        else:
            print(f"[JSON] Not found (checked json/{json_name})")

        # 5. Check Partial JSONs
        print("[PARTIALS] Checking for temp/json/ parts...")
        partials = container_client.list_blobs(name_starts_with=f"temp/json/{target_file}")
        count = 0
        for p in partials:
            count += 1
            print(f" - {p.name} ({p.size} bytes)")
        if count == 0:
            print(" - No partial chunks found.")
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(list_blobs())
