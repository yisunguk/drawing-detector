import requests
import json

def trigger_repair(filename):
    url = "https://drawing-detector-backend-435353955407.us-central1.run.app/api/v1/analyze/repair"
    
    payload = {
        "filename": filename,
        "category": "drawings"
    }
    
    print(f"Triggering Repair for {filename}...")
    try:
        res = requests.post(url, json=payload, timeout=300, verify=False) # Disable SSL verify
        print(f"Status Code: {res.status_code}")
        try:
            print(json.dumps(res.json(), indent=2))
        except:
            print(res.text)
    except Exception as e:
        print(f"Request Failed: {e}")

if __name__ == "__main__":
    trigger_repair("119103_CONSOL_GMTP-CS-TS-031-T0.pdf")
