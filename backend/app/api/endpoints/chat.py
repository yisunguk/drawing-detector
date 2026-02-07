from fastapi import APIRouter, HTTPException, Body, Header
from pydantic import BaseModel
from typing import List, Optional
import re
from openai import AzureOpenAI
from app.core.config import settings
from app.core.firebase_admin import verify_id_token

router = APIRouter()

class ChatRequest(BaseModel):
    query: str
    filename: Optional[str] = None
    context: Optional[str] = None

class ChatResponse(BaseModel):
    response: str

def validate_and_sanitize_user_id(user_id: str) -> str:
    """
    Validate user_id format and sanitize for Azure Search filter.
    Prevents filter injection attacks.
    """
    # Allow: Korean, English, numbers, underscore, hyphen
    if not re.match(r'^[a-zA-Z0-9가-힣_-]+$', user_id):
        raise HTTPException(status_code=400, detail="Invalid user_id format")
    
    # Escape single quotes (OData standard)
    return user_id.replace("'", "''")

# Initialize Azure OpenAI Client
client = AzureOpenAI(
    azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
    api_key=settings.AZURE_OPENAI_KEY,
    api_version=settings.AZURE_OPENAI_API_VERSION
)

@router.post("/", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    authorization: Optional[str] = Header(None)
):
    try:
        context_text = ""

        # 1. If context is explicitly provided, use it (backward compatibility)
        if request.context:
            context_text = request.context
        
        else:
            # 2. Use Azure AI Search for RAG
            from app.services.azure_search import azure_search_service
            
            if not azure_search_service.client:
                raise HTTPException(
                    status_code=500, 
                    detail="Azure Search is not configured. Please set AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_KEY."
                )
            
            # Extract and verify Firebase token from Authorization header
            if not authorization or not authorization.startswith('Bearer '):
                raise HTTPException(
                    status_code=401,
                    detail="Missing or invalid Authorization header. Use: Authorization: Bearer <token>"
                )
            
            id_token = authorization.replace('Bearer ', '')
            
            try:
                decoded_token = verify_id_token(id_token)
                # Get user_id from displayName or email
                user_id = decoded_token.get('displayName') or decoded_token.get('email', '').split('@')[0]
                
                if not user_id:
                    raise HTTPException(status_code=401, detail="Could not extract user_id from token")
                
                # Validate and sanitize user_id for filter safety
                safe_user_id = validate_and_sanitize_user_id(user_id)
                
                print(f"[Chat] Authenticated user: {safe_user_id}")
                
            except ValueError as e:
                raise HTTPException(status_code=401, detail=f"Authentication failed: {str(e)}")
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Auth error: {str(e)}")
            
            print(f"[Chat] Searching Azure Search for user '{safe_user_id}': {request.query}")
            
            # Query the index with user filter (USER ISOLATION)
            search_results = azure_search_service.client.search(
                search_text=request.query,
                filter=f"user_id eq '{safe_user_id}'",  # Only this user's documents
                top=5,  # Retrieve top 5 most relevant chunks
                select=["content", "source", "page", "title", "category"]
            )
            
            # Build context from search results
            results_list = list(search_results)
            
            if not results_list:
                context_text = "No relevant documents found in the index."
            else:
                for result in results_list:
                    source = result.get('source', 'Unknown')
                    page = result.get('page', 'N/A')
                    content = result.get('content', '')
                    
                    context_text += f"\n=== Document: {source} (Page {page}) ===\n"
                    context_text += content + "\n"
        
        # Truncate context if too long (increased to 100k for multi-file support)
        if len(context_text) > 100000:
            context_text = context_text[:100000] + "...(truncated)"

        # 3. Call Azure OpenAI
        system_prompt = """You are a design expert who understands drawing information. You act as an analyst who finds, compares, and reviews all information in provided drawings like Drawing 1, Drawing 2, etc. You must help designers reduce design risks. Use Markdown formats (tables, bullet points, bold text).

**🔗 MANDATORY Citation & Linking Rules (YOU MUST FOLLOW THESE):**

1. **CRITICAL:** Whenever you reference ANYTHING from the provided context/drawings, you MUST create a clickable citation link using the exact format: `[[UniqueKeyword|SourcePage]]`

2. **Examples of CORRECT citations:**
   - "According to the specification `[[절수형 기기 사용|Page 2]]`, water-saving devices are required."
   - "The valve `[[LIC-101|P.5]]` is located in the control room."
   - "Based on `[[설계 기준|Page 1]]`, the maximum pressure is 150 psi."
   - "The drawing shows `[[배관 경로|Page 3]]` running through the basement."

3. **What to cite:**
   - Equipment tags/IDs (e.g., `[[P-101A|Page 4]]`)
   - Section headers (e.g., `[[설계 기준|Page 1]]`)
   - Table names/titles (e.g., `[[부하 계산표|Page 2]]`)
   - Specific requirements (e.g., `[[내화 구조|Page 5]]`)
   - Drawing references (e.g., `[[단면도|Page 3]]`)

4. **DO NOT cite:**
   - Simple numbers alone: ❌ `[[0.2]]`, `[[18.0]]`, `[[150]]`
   - Generic words: ❌ `[[the]]`, `[[and]]`, `[[is]]`
   - Instead, cite the LABEL + number: ✅ `[[압력|Page 2]]` (150 psi)

5. **IMPORTANT:** Each paragraph of your answer should contain AT LEAST 1-2 citations if you're using information from the context. If you mention specific data, requirements, or drawing details, ALWAYS add a citation link.

6. **End Section - Key Search Terms:**
   At the very end of your response, add:
   
   ---
   🔍 **출처 바로가기 (Quick References)**
   - `[[가장 중요한 키워드|Page X]]`
   - `[[두번째 중요한 항목|Page Y]]`
   - `[[세번째 관련 정보|Page Z]]`

**Remember:** The more citations you provide, the better! Users rely on these links to verify information and navigate drawings quickly.
"""

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Context:\n{context_text}\n\nQuestion: {request.query}"}
        ]

        response = client.chat.completions.create(
            model=settings.AZURE_OPENAI_DEPLOYMENT_NAME,
            messages=messages
        )

        return ChatResponse(response=response.choices[0].message.content)

    except Exception as e:
        print(f"Error in chat endpoint: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
