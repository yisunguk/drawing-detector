import requests
import json

API_URL = "https://drawing-detector-backend-kr7kyy4mza-uc.a.run.app/api/v1/azure/list"

def test_prod_list():
    try:
        print(f"Requesting: {API_URL}?path=")
        # Disable SSL verification for debug
        response = requests.get(f"{API_URL}?path=", verify=False)
        
        print(f"Status Code: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            print(f"Item Count: {len(data)}")
            print("Items:")
            for item in data:
                print(f" - {item.get('name')} ({item.get('type')})")
        else:
            print("Error Response:")
            print(response.text)
            
    except Exception as e:
        print(f"Exception: {e}")

if __name__ == "__main__":
    test_prod_list()
