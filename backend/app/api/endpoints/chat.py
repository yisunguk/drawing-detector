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
    # Allow: Korean, English, numbers, underscore, hyphen, DOT, SPACE, and @
    # Fix: Added \. and \s to allow emails (john.doe) and names with spaces
    if not re.match(r'^[a-zA-Z0-9가-힣_\-\. @]+$', user_id):
        print(f"[Chat] Validation failed for user_id: {user_id}")
        raise HTTPException(status_code=400, detail=f"Invalid user_id format: {user_id}")
    
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
                # Get user_id from name (displayName in token is 'name') or email
                user_id = decoded_token.get('name') or decoded_token.get('email', '').split('@')[0]
                
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
                select=["content", "source", "page", "title", "category", "user_id", "blob_path"]
            )
            
            # Build context from search results (Search-to-JSON)
            results_list = list(search_results)
            print(f"[Chat] Raw Search Results Count: {len(results_list)}")
            
            if not results_list:
                context_text = "No relevant documents found in the index."
                print("[Chat] No results found in Azure Search.")
            else:
                from app.services.blob_storage import get_container_client
                import json
                
                print(f"[Chat] Found {len(results_list)} search results. Fetching JSON contexts...")
                container_client = get_container_client()
                
                # Cache fetched JSONs to avoid repeated downloads for same file
                json_cache = {} 
                
                for idx, result in enumerate(results_list):
                    source_filename = result.get('source', 'Unknown')
                    target_page = int(result.get('page', 0))
                    result_user_id = result.get('user_id', safe_user_id)
                    blob_path = result.get('blob_path')
                    
                    print(f"[Chat] Processing Result #{idx+1}: {source_filename} (Page {target_page}) | BlobPath: {blob_path} | User: {result_user_id}")
                    
                    # Robust Path Derivation using 'blob_path' from Index
                    blob_path = result.get('blob_path')
                    candidates = []
                    
                    if blob_path:
                        # Strategy 1: Infer from blob_path (Best)
                        # e.g. "User/drawings/file.pdf" -> "User/json/file.json"
                        # e.g. "User/documents/file.pdf" -> "User/json/file.json"
                        
                        path_parts = blob_path.split('/')
                        if len(path_parts) >= 2:
                             user_dir = path_parts[0]
                             category_dir = path_parts[1] # e.g. 'drawings', 'documents', 'spec'
                             filename_raw = path_parts[-1]
                             
                             # Check extension
                             base_name = filename_raw
                             if base_name.lower().endswith('.pdf'):
                                 base_name = base_name[:-4]

                             # Candidate 1: User/json/File.json
                             candidates.append(f"{user_dir}/json/{base_name}.json")
                             candidates.append(f"{user_dir}/json/{filename_raw}.json")
                             candidates.append(f"{user_dir}/json/{filename_raw}.pdf.json")
                             
                             # Candidate 2: Try replacing category dir directly (e.g. User/documents -> User/json)
                             if category_dir != 'json':
                                json_path_1 = blob_path.replace(f"/{category_dir}/", "/json/")
                                # Adjust extension
                                if json_path_1.lower().endswith('.pdf'):
                                    candidates.append(json_path_1[:-4] + ".json")
                                    candidates.append(json_path_1 + ".json") # .pdf.json
                                else:
                                    candidates.append(json_path_1 + ".json")

                    # Strategy 2: Fallback to token user_id

                    # Strategy 2: Fallback to token user_id (Old method)
                    result_user_id = result.get('user_id', safe_user_id)
                    base_name = source_filename
                    if base_name.lower().endswith('.pdf'):
                         base_name = base_name[:-4]
                    
                    candidates.append(f"{result_user_id}/json/{base_name}.json")
                    candidates.append(f"{result_user_id}/json/{source_filename}.json")
                    
                    file_json_data = None
                    
                    # Check Cache first
                    for cand in candidates:
                        if cand in json_cache:
                            file_json_data = json_cache[cand]
                            break
                            
                    # If not in cache, try download
                    if not file_json_data:
                        for path in candidates:
                            try:
                                blob_client = container_client.get_blob_client(path)
                                if blob_client.exists():
                                    print(f"[Chat] Downloading JSON: {path}")
                                    download_stream = blob_client.download_blob()
                                    json_text = download_stream.readall()
                                    file_json_data = json.loads(json_text)
                                    json_cache[path] = file_json_data # Cache it with the winning path
                                    json_cache[cand] = file_json_data # Also cache with the requested candidate to hit faster? (optional)
                                    break
                            except Exception:
                                continue # Try next candidate
                    
                    # 2. Extract Page Context
                    if file_json_data:
                        # Find the specific page in the JSON
                        # JSON structure is usually a list of pages
                        target_page_data = next((p for p in file_json_data if p.get('page_number') == target_page), None)
                        
                        if target_page_data:
                            # Convert structured page data to string context
                            # We keep it as JSON string to preserve structure for LLM
                            # Optimize: Remove non-essential heavy fields if needed (like extremely detailed layout?)
                            # For now, pass relevant fields.
                            
                            simplified_page = {
                                "file": source_filename,
                                "page": target_page,
                                "content": target_page_data.get("content", ""),
                                "tables": target_page_data.get("tables", []), # Crucial for RAG
                                # "lines": target_page_data.get("lines", []) # Optional: Lines might be too verbose
                            }
                            
                            context_text += f"\n=== JSON Context: {source_filename} (Page {target_page}) ===\n"
                            context_text += json.dumps(simplified_page, ensure_ascii=False) + "\n"
                        else:
                            # Fallback: Page not found in JSON? Use Search Index Content
                            print(f"[Chat] Page {target_page} not found in JSON. Fallback to index text.")
                            context_text += f"\n=== Text Context: {source_filename} (Page {target_page}) ===\n"
                            context_text += result.get('content', '') + "\n"
                    else:
                        # Fallback: JSON not found? Use Search Index Content
                        # print(f"[Chat] JSON not found for {source_filename}. Fallback to index text.")
                        context_text += f"\n=== Text Context: {source_filename} (Page {target_page}) ===\n"
                        context_text += result.get('content', '') + "\n"
        
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
