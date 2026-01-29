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
            {"role": "system", "content": "You are a helpful assistant that answers questions based on the provided drawing information. The information is extracted from a PDF drawing. Provide clear and concise answers."},
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
