from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel
from typing import List, Optional
from openai import AzureOpenAI
from app.core.config import settings

router = APIRouter()

class ChatRequest(BaseModel):
    query: str
    filename: Optional[str] = None
    context: Optional[str] = None

class ChatResponse(BaseModel):
    response: str

# Initialize Azure OpenAI Client
client = AzureOpenAI(
    azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
    api_key=settings.AZURE_OPENAI_KEY,
    api_version=settings.AZURE_OPENAI_API_VERSION
)

@router.post("/", response_model=ChatResponse)
async def chat(request: ChatRequest):
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
            
            print(f"[Chat] Searching Azure Search for: {request.query}")
            
            # Query the index
            search_results = azure_search_service.client.search(
                search_text=request.query,
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
        
        # Truncate context if too long
        if len(context_text) > 20000:
            context_text = context_text[:20000] + "...(truncated)"

        # 3. Call Azure OpenAI
        system_prompt = """You are a design expert who understands drawing information. You act as an analyst who finds, compares, and reviews all information in provided drawings like Drawing 1, Drawing 2, etc. You must help designers reduce design risks. Use Markdown formats (tables, bullet points, bold text).

**Citation & Linking Rules:**
1. When answering, if the answer relies on specific information in the drawing, you must provide a clickable link using double brackets `[[ ]]`.
2. **CRITICAL:** Do NOT link simple numeric values (e.g., `[[0.2]]`, `[[18.0]]`) as these are too common and cause confusing search results.
3. Instead, link the **Label**, **Header**, **Row Title**, or **Unique Identifier** associated with that value. 
   - Bad: "The load is `[[13912.3]]`."
   - Good: "The load is 13912.3 (see `[[Mx]]`, `[[BFS-01]]`, or `[[Stream 7332]]`)."
4. Only link a value directly if it is a unique string ID (e.g., `[[P-101A]]`, `[[Polyester]]`).
5. **Table Data:** When citing data from a table, ALWAYS use the **Row Identifier** (e.g., Stream No, Line No) combined with the value if needed (e.g. `[[Stream 7332]]`) to ensure the user can identify the specific row.

**Ranking System:**
At the very end of your response, append a section titled "🔍 **Key Search Terms**". List the top 3-5 most relevant keywords or labels present in the drawing that would help the user find the evidence for your answer. Wrap them in `[[ ]]`. Order them by relevance to the user's question."""

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
