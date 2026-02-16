"""
Lessons Learned AI - API Endpoints

- POST /upload    : Upload SDC TXT or JSON → parse → classify → embed → index
- POST /search    : Hybrid search (keyword+vector) or RAG chat
- GET  /categories: Category tree with document counts
- GET  /documents : Documents by category
- GET  /files     : Uploaded file list per user
- DELETE /files   : Delete indexed docs from a source file
"""

import json
import logging
import re
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Header, UploadFile, File, Query
from pydantic import BaseModel
from openai import AzureOpenAI

from app.core.config import settings
from app.core.firebase_admin import verify_id_token
from app.services.lessons_search import (
    lessons_search_service,
    parse_sdc_txt,
    parse_json_lessons,
    classify_document,
    CATEGORY_TREE,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# ── Content cleaning: strip confidential footer ──

_CONFIDENTIAL_RE = re.compile(
    r'POSCO\s+ENC\s+CONFIDENTIAL\s+\S+(?:\(\S+\))?\s*\n?'
    r'\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*'
    r'이\s*문서는\s*포스코이앤씨의\s*\n?\s*허락없이\s*배포할\s*수\s*없습니다\.?',
    re.MULTILINE
)


def _clean_content(text: str) -> str:
    if not text:
        return text
    return _CONFIDENTIAL_RE.sub('', text)


# ── Keyword extraction for highlight fallback ──

_PARTICLES = ['에서', '으로', '까지', '부터', '해서', '세요',
              '을', '를', '의', '이', '가', '에', '도', '는', '은', '로', '와', '과', '하']

_FILLER = {'알려', '주세요', '알려주세요', '하세요', '해주세요', '설명', '뭐',
           '입니다', '합니다', '있는', '대해', '무엇', '어떤', '어떻게',
           'please', 'tell', 'what', 'about', 'the', 'show'}


def _strip_particle(w: str) -> str:
    for p in sorted(_PARTICLES, key=len, reverse=True):
        if w.endswith(p) and len(w) - len(p) >= 2:
            return w[:-len(p)]
    return w


def _extract_search_keywords(query: str) -> list:
    raw_words = re.split(r'\s+', query.lower().strip())
    keywords = []
    for w in raw_words:
        if re.match(r'^[\w]+-[\w]+-?[\w]*$', w):
            keywords.append(w)
            continue
        stripped = _strip_particle(w)
        if len(stripped) >= 2 and stripped not in _FILLER:
            keywords.append(stripped)
    return keywords


def _extract_and_highlight(content: str, keywords: list) -> str:
    if not content or not keywords:
        return content[:300] if content else ""

    content_lower = content.lower()
    positions = []
    for kw in keywords:
        start = 0
        kw_lower = kw.lower()
        while True:
            idx = content_lower.find(kw_lower, start)
            if idx == -1:
                break
            positions.append((idx, len(kw_lower)))
            start = idx + 1

    if not positions:
        return content[:300]

    positions.sort(key=lambda x: x[0])

    snippets = []
    used_ranges = []
    for pos, kw_len in positions:
        if len(snippets) >= 3:
            break
        snippet_start = max(0, pos - 150)
        snippet_end = min(len(content), pos + kw_len + 150)
        overlaps = any(s <= snippet_start <= e or s <= snippet_end <= e for s, e in used_ranges)
        if overlaps:
            continue
        used_ranges.append((snippet_start, snippet_end))
        snippet = content[snippet_start:snippet_end]
        prefix = "..." if snippet_start > 0 else ""
        suffix = "..." if snippet_end < len(content) else ""
        snippets.append(f"{prefix}{snippet}{suffix}")

    result = " ... ".join(snippets)
    for kw in keywords:
        pattern = re.compile(re.escape(kw), re.IGNORECASE)
        result = pattern.sub(lambda m: f"<mark>{m.group(0)}</mark>", result)
    return result

# Azure OpenAI client for RAG chat
_openai_client = AzureOpenAI(
    azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
    api_key=settings.AZURE_OPENAI_KEY,
    api_version=settings.AZURE_OPENAI_API_VERSION,
)


# ── Auth Helper ──

def _get_username(authorization: Optional[str]) -> str:
    """Extract username from Firebase Bearer token."""
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = authorization.replace('Bearer ', '')
    try:
        decoded = verify_id_token(token)
        name = decoded.get('name')
        if not name:
            uid = decoded.get('uid')
            if uid:
                try:
                    from firebase_admin import firestore
                    db = firestore.client()
                    user_doc = db.collection('users').document(uid).get()
                    if user_doc.exists:
                        user_data = user_doc.to_dict()
                        name = user_data.get('name') or user_data.get('displayName')
                except Exception:
                    pass
        return name or decoded.get('email', '').split('@')[0] or 'unknown'
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Authentication failed: {e}")


# ── Pydantic Models ──

class SearchRequest(BaseModel):
    query: str
    category: Optional[str] = None
    source_file: Optional[str] = None
    mode: Optional[str] = "search"  # "search" or "chat"
    history: Optional[List[dict]] = None
    top: Optional[int] = 20


class SearchResponse(BaseModel):
    results: Optional[List[dict]] = None
    response: Optional[str] = None
    total: Optional[int] = None


# ── Upload Endpoint ──

@router.post("/upload")
async def upload_lessons(
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(None)
):
    """Upload SDC TXT or JSON file → parse → classify → embed → index."""
    username = _get_username(authorization)
    filename = file.filename or "unknown.txt"

    print(f"[Lessons] Upload by '{username}': {filename}", flush=True)

    # Read file content
    raw = await file.read()
    try:
        content = raw.decode('utf-8')
    except UnicodeDecodeError:
        content = raw.decode('euc-kr', errors='replace')

    # Parse based on file type
    if filename.lower().endswith('.json'):
        try:
            data = json.loads(content)
            documents = parse_json_lessons(data)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}")
    else:
        # SDC TXT format
        documents = parse_sdc_txt(content)

    if not documents:
        raise HTTPException(status_code=400, detail="No documents found in uploaded file")

    print(f"[Lessons] Parsed {len(documents)} documents from '{filename}'", flush=True)

    # Save to blob storage
    try:
        from app.services.blob_storage import get_container_client
        container = get_container_client()
        blob_path = f"{username}/lessons/{filename}"
        container.upload_blob(name=blob_path, data=raw, overwrite=True)
        print(f"[Lessons] Saved to blob: {blob_path}", flush=True)
    except Exception as e:
        print(f"[Lessons] Blob upload warning (non-fatal): {e}", flush=True)

    # Delete existing docs from same source file (re-upload scenario)
    try:
        lessons_search_service.delete_by_source_file(filename, username)
    except Exception as e:
        print(f"[Lessons] Cleanup warning: {e}", flush=True)

    # Index documents
    indexed = lessons_search_service.index_documents(documents, username, filename)

    # Compute category counts
    category_counts = {}
    for doc in documents:
        cat = doc.get('category', '6.0 기타 및 미분류')
        category_counts[cat] = category_counts.get(cat, 0) + 1

    return {
        "status": "success",
        "filename": filename,
        "documents_parsed": len(documents),
        "documents_indexed": indexed,
        "categories": category_counts,
    }


# ── Search/Chat Endpoint ──

@router.post("/search", response_model=SearchResponse)
async def search_lessons(
    request: SearchRequest,
    authorization: Optional[str] = Header(None)
):
    """Hybrid search or RAG chat over lessons learned."""
    username = _get_username(authorization)

    print(f"[Lessons] {request.mode} by '{username}': {request.query}", flush=True)

    if request.mode == "chat":
        return await _handle_chat(request, username)
    else:
        return await _handle_search(request, username)


async def _handle_search(request: SearchRequest, username: str) -> SearchResponse:
    """Keyword + vector hybrid search with highlight."""
    results = lessons_search_service.hybrid_search(
        query=request.query,
        category=request.category,
        username=None,  # Search across all users' lessons
        top=request.top or 20,
        source_file=request.source_file,
    )

    # Clean confidential footer + build highlight text
    search_keywords = _extract_search_keywords(request.query)
    for r in results:
        r["content"] = _clean_content(r.get("content", ""))
        r["content_preview"] = _clean_content(r.get("content_preview", ""))
        azure_highlights = r.pop("azure_highlights", [])
        if azure_highlights:
            r["highlight"] = _clean_content(" ... ".join(azure_highlights[:3]))
        elif search_keywords:
            r["highlight"] = _extract_and_highlight(r["content"], search_keywords)
        else:
            r["highlight"] = r["content"][:300]

    return SearchResponse(
        results=results,
        total=len(results),
    )


async def _handle_chat(request: SearchRequest, username: str) -> SearchResponse:
    """RAG chat: search → build context → LLM answer."""
    # Search for relevant documents
    results = lessons_search_service.hybrid_search(
        query=request.query,
        category=request.category,
        username=None,
        top=15,
        source_file=request.source_file,
    )

    # Build context from search results
    if not results:
        context_text = "관련 Lessons Learned 문서를 찾지 못했습니다."
    else:
        context_parts = []
        for r in results:
            r["content"] = _clean_content(r.get("content", ""))
            header = f"=== 문서: {r['file_nm']} | 분류: {r['category']} | 프로젝트: {r.get('pjt_nm', '')} ==="
            context_parts.append(f"{header}\n{r['content']}")
        context_text = "\n\n".join(context_parts)

    # Truncate if too long
    if len(context_text) > 80000:
        context_text = context_text[:80000] + "...(truncated)"

    system_prompt = """당신은 EPC 프로젝트의 Lessons Learned 분석 전문가입니다.
제공된 과거 프로젝트 경험과 교훈 데이터를 기반으로 질문에 답변합니다.

**답변 규칙:**
1. 반드시 제공된 문서 내용을 기반으로 답변하세요.
2. 관련 문서명과 프로젝트명을 인용하세요.
3. 실제 사례와 조치 내용을 구체적으로 언급하세요.
4. 유사한 패턴이나 반복되는 문제를 식별하면 언급하세요.
5. 마크다운 포맷 (표, 불릿, 볼드)을 사용하세요.
6. 한국어로 답변하세요.

**인용 형식:** 문서를 참조할 때 `[문서명]` 형태로 표시하세요."""

    messages = [{"role": "system", "content": system_prompt}]

    # Add conversation history
    if request.history:
        for msg in (request.history or [])[-20:]:
            role = msg.get('role', '')
            content = msg.get('content', '')
            if role in ('user', 'assistant') and content:
                messages.append({"role": role, "content": content[:2000]})

    messages.append({
        "role": "user",
        "content": f"참고 문서:\n{context_text}\n\n질문: {request.query}"
    })

    try:
        response = _openai_client.chat.completions.create(
            model=settings.AZURE_OPENAI_DEPLOYMENT_NAME,
            messages=messages,
        )
        answer = response.choices[0].message.content
    except Exception as e:
        logger.error(f"LLM call failed: {e}")
        answer = f"AI 응답 생성 중 오류가 발생했습니다: {e}"

    # Sources from search results
    sources = [
        {
            "file_nm": r["file_nm"],
            "category": r["category"],
            "pjt_nm": r.get("pjt_nm", ""),
            "score": r.get("score", 0),
            "content_preview": _clean_content(r.get("content_preview", "")),
            "content": r.get("content", ""),  # already cleaned above
            "source_file": r.get("source_file", ""),
            "file_path": r.get("file_path", ""),
        }
        for r in results[:10]
    ]

    return SearchResponse(
        response=answer,
        results=sources,
        total=len(sources),
    )


# ── Category Endpoints ──

@router.get("/categories")
async def get_categories(
    authorization: Optional[str] = Header(None)
):
    """Get category tree with document counts."""
    username = _get_username(authorization)

    counts = lessons_search_service.get_category_counts(username=None)

    # Build tree structure
    tree = []
    for group_name, subcategories in CATEGORY_TREE.items():
        children = []
        group_total = 0
        for subcat in subcategories:
            count = counts.get(subcat, 0)
            group_total += count
            children.append({"name": subcat, "count": count})
        tree.append({
            "name": group_name,
            "count": group_total,
            "children": children,
        })

    return {"tree": tree, "total": sum(counts.values())}


@router.get("/documents")
async def get_documents(
    category: str = Query(...),
    authorization: Optional[str] = Header(None)
):
    """Get documents in a specific category."""
    username = _get_username(authorization)

    documents = lessons_search_service.get_documents_by_category(
        category=category,
        username=None,
    )

    # Clean confidential footer from content
    for doc in documents:
        if "content" in doc:
            doc["content"] = _clean_content(doc["content"])

    return {"category": category, "documents": documents, "total": len(documents)}


# ── File Management Endpoints ──

@router.get("/files")
async def get_files(
    authorization: Optional[str] = Header(None)
):
    """Get list of uploaded source files for the current user."""
    username = _get_username(authorization)

    files = lessons_search_service.get_uploaded_files(username)
    return {"files": files, "username": username}


@router.delete("/files")
async def delete_file(
    filename: str = Query(...),
    authorization: Optional[str] = Header(None)
):
    """Delete all indexed documents from a specific source file."""
    username = _get_username(authorization)

    deleted = lessons_search_service.delete_by_source_file(filename, username)

    # Also delete from blob storage
    try:
        from app.services.blob_storage import get_container_client
        container = get_container_client()
        blob_path = f"{username}/lessons/{filename}"
        container.delete_blob(blob_path)
        print(f"[Lessons] Deleted blob: {blob_path}", flush=True)
    except Exception as e:
        print(f"[Lessons] Blob delete warning: {e}", flush=True)

    return {"status": "success", "deleted_count": deleted, "filename": filename}


@router.post("/recreate-index")
async def recreate_index(
    authorization: Optional[str] = Header(None)
):
    """Delete and recreate the lessons index (fixes schema). Data must be re-uploaded."""
    _get_username(authorization)
    lessons_search_service.recreate_index()
    return {"status": "success", "message": "Index recreated. Please re-upload files."}
