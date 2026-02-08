import requests
import json

# Production API URL
API_URL = "https://drawing-detector-backend-435353955407.us-central1.run.app/api/v1/chat/"

# Test with doc_ids
payload = {
    "query": "한전공급",
    "context": None,
    "filename": None,  
    "doc_ids": ["단선도(3차).pdf", "제3권 1편 일반규격서(청주).pdf"]
}

# Need auth token - user should provide
print("📌 이 테스트는 실제 Firebase 인증 토큰이 필요합니다.")
print("브라우저 개발자 도구에서 Authorization 헤더를 복사해주세요.\n")

# For now, test without auth to see error
headers = {
    "Content-Type": "application/json"
}

try:
    response = requests.post(API_URL, json=payload, headers=headers, timeout=60)
    print(f"✅ Status Code: {response.status_code}")
    print(f"✅ Response:\n{json.dumps(response.json(), indent=2, ensure_ascii=False)}")
except Exception as e:
    print(f"❌ Error: {e}")
