from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel
from typing import List, Optional
from openai import AzureOpenAI
from app.core.config import settings
from app.services.pdf_extractor import PDFExtractor
from pathlib import Path

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

        # 1. Use provided context if available
        if request.context:
            context_text = request.context
        
        # 2. Fallback to file extraction if filename is provided
        elif request.filename:
            file_path = Path("uploads") / request.filename
            if not file_path.exists():
                raise HTTPException(status_code=404, detail="File not found")
                
            # For efficiency in this demo, we'll extract on the fly if small, 
            # but ideally this should be pre-computed.
            extractor = PDFExtractor(str(file_path))
            text_blocks = extractor.extract_text_with_coordinates()
            extractor.close()
            
            # Prepare context from text blocks
            # Simple strategy: Concatenate all text
            context_text = "\n".join([block['text'] for block in text_blocks])
        
        else:
            raise HTTPException(status_code=400, detail="Either context or filename must be provided")
        
        # Truncate context if too long (simple check)
        if len(context_text) > 20000:
            context_text = context_text[:20000] + "...(truncated)"

        # 3. Call Azure OpenAI
        messages = [
            {"role": "system", "content": "You are a design expert who understands drawing information. You act as an analyst who finds, compares, and reviews all information in provided drawings like Drawing 1, Drawing 2, etc. You must help designers reduce design risks. Use Markdown formats (tables, bullet points, bold text).\n\n**Citation & Linking Rules:**\n1. When answering, if the answer relies on specific information in the drawing, you must provide a clickable link using double brackets `[[ ]]`.\n2. **CRITICAL:** Do NOT link simple numeric values (e.g., `[[0.2]]`, `[[18.0]]`) as these are too common and cause confusing search results.\n3. Instead, link the **Label**, **Header**, **Row Title**, or **Unique Identifier** associated with that value. \n   - Bad: \"The load is `[[13912.3]]`.\"\n   - Good: \"The load is 13912.3 (see `[[Mx]]` or `[[BFS-01]]`).\"\n4. Only link a value directly if it is a unique string ID (e.g., `[[P-101A]]`, `[[Polyester]]`).\n\n**Ranking System:**\nAt the very end of your response, append a section titled \"🔍 **Key Search Terms**\". List the top 3-5 most relevant keywords or labels present in the drawing that would help the user find the evidence for your answer. Wrap them in `[[ ]]`. Order them by relevance to the user's question."},
            {"role": "user", "content": f"Context:\n{context_text}\n\nQuestion: {request.query}"}
        ]

        response = client.chat.completions.create(
            model=settings.AZURE_OPENAI_DEPLOYMENT_NAME,
            messages=messages
        )

        return ChatResponse(response=response.choices[0].message.content)

    except Exception as e:
        print(f"Error in chat endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))
