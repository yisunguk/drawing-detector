from fastapi import APIRouter, HTTPException, Body, Header
from pydantic import BaseModel
from typing import List, Optional
import re
from openai import AzureOpenAI
from azure.search.documents.models import VectorizedQuery
from app.core.config import settings
from app.core.firebase_admin import verify_id_token
from app.services.lessons_search import lessons_search_service
from app.services.revision_search import revision_search_service

router = APIRouter()


# ─── Common constants ───
_PARTICLES = ['에서', '으로', '까지', '부터', '해서', '세요',
              '을', '를', '의', '이', '가', '에', '도', '는', '은', '로', '와', '과', '하']

_FILLER = {'알려', '주세요', '알려주세요', '하세요', '해주세요', '설명', '뭐',
           '입니다', '합니다', '있는', '대해', '무엇', '어떤', '어떻게',
           'please', 'tell', 'what', 'about', 'the', 'show'}

_XML_COMMENT_RE = re.compile(r'<!--.*?-->', re.DOTALL)
_PARTIAL_XML_COMMENT_RE = re.compile(r'--\s*Page(?:Number|Header|Footer|Break)\s*(?:=\s*"[^"]*")?\s*-->')
_HTML_TAG_RE = re.compile(r'<[^>]+>')
_MULTI_SPACE_RE = re.compile(r'[ \t]+')
_MULTI_NEWLINE_RE = re.compile(r'\n{3,}')


def _strip_particle(w: str) -> str:
    """Strip common Korean particles from end of a word."""
    for p in sorted(_PARTICLES, key=len, reverse=True):
        if w.endswith(p) and len(w) - len(p) >= 2:
            return w[:-len(p)]
    return w


def _extract_search_keywords(query: str) -> list:
    """Extract meaningful keywords from a user query for highlighting."""
    query_lower = query.lower().strip()
    raw_words = re.split(r'\s+', query_lower)

    keywords = []
    for w in raw_words:
        # Preserve EPC tag patterns with hyphens (e.g. 110-PU-001A)
        if re.match(r'^[\w]+-[\w]+-?[\w]*$', w):
            keywords.append(w)
            continue
        stripped = _strip_particle(w)
        if len(stripped) >= 2 and stripped not in _FILLER:
            keywords.append(stripped)
    return keywords


def _clean_content(text: str) -> str:
    """Remove HTML/XML artifacts from document content."""
    if not text:
        return ""
    text = _XML_COMMENT_RE.sub('', text)
    text = _PARTIAL_XML_COMMENT_RE.sub('', text)
    text = _HTML_TAG_RE.sub('', text)
    text = _MULTI_SPACE_RE.sub(' ', text)
    text = _MULTI_NEWLINE_RE.sub('\n\n', text)
    return text.strip()


def _extract_and_highlight(content: str, keywords: list) -> str:
    """
    Find keyword occurrences in content, extract surrounding context (~150 chars),
    and wrap matched keywords with <mark> tags. Returns up to 3 snippets joined by ' ... '.
    """
    if not content or not keywords:
        return content[:300] if content else ""

    content_lower = content.lower()
    # Find all keyword positions
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

    # Deduplicate and sort by position
    positions.sort(key=lambda x: x[0])

    # Extract up to 3 non-overlapping snippets
    snippets = []
    used_ranges = []

    for pos, kw_len in positions:
        if len(snippets) >= 3:
            break
        # Check overlap with already used ranges
        snippet_start = max(0, pos - 150)
        snippet_end = min(len(content), pos + kw_len + 150)
        overlaps = any(s <= snippet_start <= e or s <= snippet_end <= e for s, e in used_ranges)
        if overlaps:
            # Extend existing range instead of creating new snippet
            continue

        used_ranges.append((snippet_start, snippet_end))
        snippet = content[snippet_start:snippet_end]

        # Add ellipsis indicators
        prefix = "..." if snippet_start > 0 else ""
        suffix = "..." if snippet_end < len(content) else ""
        snippets.append(f"{prefix}{snippet}{suffix}")

    # Join snippets
    result = " ... ".join(snippets)

    # Highlight all keywords in the combined result (case-insensitive)
    for kw in keywords:
        pattern = re.compile(re.escape(kw), re.IGNORECASE)
        result = pattern.sub(lambda m: f"<mark>{m.group(0)}</mark>", result)

    return result


def _rerank_by_keywords(results_list: list, original_query: str) -> list:
    """
    Re-rank Azure Search results by exact keyword match density.
    Ensures pages with precise Korean keyword matches rank higher.
    E.g., "변류기 2차 인출선의 굵기" should strongly boost a page containing
    "변류기 2차 인출선은 10 mm² 이상 굵기이어야".
    """
    query_lower = original_query.lower().strip()

    # Split query into words
    raw_words = re.split(r'\s+', query_lower)

    keywords = []
    for w in raw_words:
        stripped = _strip_particle(w)
        if len(stripped) >= 2 and stripped not in _FILLER:
            keywords.append(stripped)

    if not keywords:
        return results_list

    print(f"[Chat] Re-ranking {len(results_list)} results by keywords: {keywords}", flush=True)

    for result in results_list:
        content = (result.get('content') or '').lower()
        azure_score = result.get('@search.score', 0)

        # 1) Count keyword hits (substring match handles Korean conjugation)
        hits = sum(1 for kw in keywords if kw in content)
        keyword_ratio = hits / len(keywords)

        # 2) Adjacency bonus: consecutive keywords appearing near each other
        adjacency_bonus = 0
        for i in range(len(keywords) - 1):
            pattern = re.escape(keywords[i]) + r'.{0,30}' + re.escape(keywords[i + 1])
            if re.search(pattern, content):
                adjacency_bonus += 1

        # 3) Combined score: Azure score + keyword match + adjacency
        #    keyword_ratio * 200 ensures exact keyword match strongly boosts ranking
        #    adjacency * 100 rewards phrase-level matches
        result['_rerank_score'] = azure_score + (keyword_ratio * 200) + (adjacency_bonus * 100)

    results_list.sort(key=lambda r: r.get('_rerank_score', 0), reverse=True)

    # Log top 5 for debugging
    for i, r in enumerate(results_list[:5]):
        name = r.get('source') or r.get('filename') or '?'
        print(f"[Chat] Rerank #{i+1}: [{r.get('type','doc')}] {name} p.{r.get('page','?')} "
              f"azure={r.get('@search.score', 0):.1f} rerank={r.get('_rerank_score', 0):.1f}", flush=True)

    return results_list


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str

class ChatRequest(BaseModel):
    query: str
    filename: Optional[str] = None
    context: Optional[str] = None
    doc_ids: Optional[List[str]] = None  # NEW: List of document names to restrict search
    mode: Optional[str] = "chat" # chat or search
    history: Optional[List[ChatMessage]] = None  # Conversation history for context memory
    viewing_context: Optional[str] = None  # Current page context from frontend (user's viewport)
    target_user: Optional[str] = None  # Admin-only: filter search to a specific user folder
    target_users: Optional[List[str]] = None  # Admin-only: multi-user scope filter
    folder: Optional[str] = None  # Active folder: lessons, revision, etc.

class ChatResponse(BaseModel):
    response: str
    results: Optional[List[dict]] = None

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

def _search_lessons_revision(search_query: str, username: str | None, is_admin: bool, top: int = 20):
    """Search lessons-learned-index and revision-master-index, return unified results."""
    extra_results = []

    # Lessons
    try:
        lr = lessons_search_service.hybrid_search(
            query=search_query, username=username, top=top
        )
        for r in lr:
            raw = r.get("content", "") or r.get("content_preview", "")
            cleaned = _clean_content(raw)
            azure_hl = r.get("azure_highlights", [])
            highlight_text = " ... ".join(azure_hl[:3]) if azure_hl else cleaned[:300]
            score = r.get("score", 0)
            extra_results.append({
                "filename": r.get("source_file", ""),
                "source": r.get("source_file", ""),
                "page": None,
                "content": cleaned[:300] + ("..." if len(cleaned) > 300 else ""),
                "highlight": highlight_text,
                "score": score,
                "@search.score": score,
                "path": r.get("file_path", ""),
                "blob_path": r.get("file_path", ""),
                "coords": None,
                "type": "lessons",
                "category": r.get("category", ""),
                "user_id": username or "",
            })
    except Exception as e:
        print(f"[Chat] Lessons cross-search failed: {e}", flush=True)

    # Revision
    try:
        rr = revision_search_service.hybrid_search(
            query=search_query, username=username, top=top
        )
        for r in rr:
            raw = r.get("content_preview", "") or ""
            cleaned = _clean_content(raw)
            azure_hl = r.get("azure_highlights", [])
            highlight_text = " ... ".join(azure_hl[:3]) if azure_hl else cleaned[:300]
            score = r.get("score", 0)
            extra_results.append({
                "filename": r.get("doc_no", ""),
                "source": r.get("doc_no", ""),
                "page": r.get("page_number", 0),
                "content": cleaned[:300] + ("..." if len(cleaned) > 300 else ""),
                "highlight": highlight_text,
                "score": score,
                "@search.score": score,
                "path": r.get("blob_path", ""),
                "blob_path": r.get("blob_path", ""),
                "coords": None,
                "type": "revision",
                "category": r.get("phase_name", ""),
                "user_id": username or "",
            })
    except Exception as e:
        print(f"[Chat] Revision cross-search failed: {e}", flush=True)

    return extra_results


@router.post("/", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    authorization: Optional[str] = Header(None)
):
    try:
        context_text = ""
        page_doc_map = {}
        results_list = []

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
                # user_id = decoded_token.get('name') or decoded_token.get('email', '').split('@')[0]
                
                # Get multiple potential user identifiers to robustly match documents
                # Some docs might be indexed with 'name' (e.g. '이성욱'), others with 'email_prefix' (e.g. 'piere')
                uid = decoded_token.get('uid')
                user_name = decoded_token.get('name')
                email_prefix = decoded_token.get('email', '').split('@')[0]
                
                # Fallback: If name not in token, check Firestore (e.g. new user profile update)
                if not user_name and uid:
                    try:
                        from firebase_admin import firestore
                        db = firestore.client()
                        user_ref = db.collection('users').document(uid)
                        user_doc = user_ref.get()
                        if user_doc.exists:
                             user_data = user_doc.to_dict()
                             # Try 'name' or 'displayName' field
                             user_name = user_data.get('name') or user_data.get('displayName')
                             if user_name:
                                 print(f"[Chat] Resolved user name from Firestore: {user_name}")
                    except Exception as fs_err:
                        print(f"[Chat] Firestore user lookup failed: {fs_err}")

                # Admin detection: skip user_id filter for admin users
                is_admin = (user_name and '관리자' in user_name) or (email_prefix and email_prefix.lower() == 'admin')

                if is_admin:
                    if request.target_users and len(request.target_users) > 0:
                        # Multi-user scope: OR'd blob_path filters
                        user_parts = []
                        for tu in request.target_users:
                            safe_tu = validate_and_sanitize_user_id(tu)
                            user_parts.append(f"(blob_path ge '{safe_tu}/' and blob_path lt '{safe_tu}0')")
                        user_filter = " or ".join(user_parts)
                        if len(user_parts) > 1:
                            user_filter = f"({user_filter})"
                        print(f"[Chat] Admin multi-user scope: {request.target_users}", flush=True)
                    elif request.target_user:
                        # Single user filter by blob_path
                        safe_target = validate_and_sanitize_user_id(request.target_user)
                        user_filter = f"blob_path ge '{safe_target}/' and blob_path lt '{safe_target}0'"
                        print(f"[Chat] Admin targeting user folder: {request.target_user} → blob_path filter", flush=True)
                    else:
                        user_filter = None
                        print(f"[Chat] Admin user detected ({user_name}/{email_prefix}). Bypassing user_id filter.")
                else:
                    # Construct OData filter for Azure Search
                    # (user_id eq '이성욱') or (user_id eq 'piere')
                    filter_clauses = []

                    # Clause 1: Name (e.g. '이성욱')
                    if user_name:
                        safe_name = user_name.replace("'", "''")
                        filter_clauses.append(f"user_id eq '{safe_name}'")

                    # Clause 2: Email Prefix (e.g. 'piere')
                    if email_prefix:
                        safe_email = email_prefix.replace("'", "''")
                        # Avoid duplicate clause if name == email_prefix
                        if safe_email != (user_name or "").replace("'", "''"):
                            filter_clauses.append(f"user_id eq '{safe_email}'")

                    if not filter_clauses:
                         raise HTTPException(status_code=401, detail="Could not extract any user identifier from token or database")

                    # Combine with OR
                    user_filter = " or ".join(filter_clauses)
                    print(f"[Chat] Built User Filter: {user_filter}")

                # Use the primary ID for logging/fallback
                safe_user_id = user_name or email_prefix
                
                # Validate and sanitize user_id for filter safety (using the primary ID for logging)
                # The actual filter is 'user_filter', but we still need a 'safe_user_id' for other parts of the code
                if safe_user_id:
                    safe_user_id = validate_and_sanitize_user_id(safe_user_id)
                else:
                    safe_user_id = "unknown_user" # Fallback for logging if both name/email_prefix are empty

                print(f"[Chat] Authenticated user (primary ID for logging): {safe_user_id}")
                
            except ValueError as e:
                raise HTTPException(status_code=401, detail=f"Authentication failed: {str(e)}")
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Auth error: {str(e)}")
            
            # ---------------------------------------------------------
            # NEW: Translate/Extract English Keywords for Search
            # ---------------------------------------------------------
            search_query = request.query
            try:
                # If query contains Korean (simple check), generate English keywords
                if any(ord(c) > 127 for c in request.query):
                    print(f"[Chat] Detecting Korean query. Generating English search keywords...")
                    completion = client.chat.completions.create(
                        model=settings.AZURE_OPENAI_DEPLOYMENT_NAME,
                        messages=[
                            {"role": "system", "content": "You are a search assistant. Extract English technical keywords from the user's query for searching engineering documents. Return ONLY the keywords, separated by spaces. No explanation."},
                            {"role": "user", "content": request.query}
                        ],
                        temperature=0.0
                    )
                    english_keywords = completion.choices[0].message.content.strip()
                    print(f"[Chat] Translated/Expanded Query: '{request.query}' -> '{english_keywords}'")
                    search_query = f"{english_keywords} OR {request.query}" # Hybrid: Search both
                
            except Exception as e:
                print(f"[Chat] Warning: Keyword generation failed: {e}. Using original query.")
            
            print(f"[Chat] Searching Azure Search for user '{safe_user_id}': {search_query}", flush=True)
            print(f"[Chat] user_filter = {user_filter}", flush=True)

            # Apply doc_ids filter to Azure Search query (BEFORE relevance scoring)
            # IMPORTANT: Use OData 'source eq' for exact matching, NOT search.ismatch
            # search.ismatch tokenizes Korean filenames and matches wrong documents
            search_filter = user_filter  # None for admin, OData string for regular users

            if request.doc_ids and len(request.doc_ids) > 0:
                print(f"[Chat] Applying doc_ids filter at Azure Search level: {request.doc_ids}")
                doc_filter_parts = []
                for doc_id in request.doc_ids:
                    safe_id = doc_id.replace("'", "''")
                    base_name = doc_id.replace('.pdf', '').replace("'", "''")
                    # Exact match with common filename variants
                    doc_filter_parts.append(f"source eq '{safe_id}'")
                    doc_filter_parts.append(f"source eq '{base_name}'")
                    doc_filter_parts.append(f"source eq '{base_name}.pdf'")
                    doc_filter_parts.append(f"source eq '{base_name}.pdf.pdf'")

                if doc_filter_parts:
                    combined_doc_filter = " or ".join(doc_filter_parts)
                    if search_filter:
                        search_filter = f"({search_filter}) and ({combined_doc_filter})"
                    else:
                        search_filter = combined_doc_filter  # Admin: only doc_ids filter
                    print(f"[Chat] Final Azure Search filter: {search_filter[:200]}...")
            
            # ---------------------------------------------------------
            # Tag pattern query expansion (HS9717 → "HS9717" OR "HS 9717" OR (HS AND 9717))
            # ---------------------------------------------------------
            query_type = "simple"
            tag_match = re.match(r'^([A-Za-z]{1,5})(\d{1,5}[A-Za-z]?)$', search_query.strip())
            if tag_match:
                prefix = tag_match.group(1).upper()
                number = tag_match.group(2)
                combined = f"{prefix}{number}"
                search_query = f'"{combined}" OR "{prefix} {number}" OR ({prefix} AND {number})'
                query_type = "full"
                print(f"[Chat] Tag pattern detected → expanded query: {search_query}")

            # ---------------------------------------------------------
            # FOLDER-SPECIFIC SEARCH: lessons / revision
            # (These use dedicated Azure Search indexes)
            # ---------------------------------------------------------
            if request.folder in ("lessons", "revision"):
                # Determine username for lessons/revision search
                folder_username = None
                if is_admin:
                    if request.target_users and len(request.target_users) > 0:
                        folder_username = request.target_users[0]
                    elif request.target_user:
                        folder_username = request.target_user
                else:
                    folder_username = safe_user_id

                print(f"[Chat] Folder-specific search: folder={request.folder}, username={folder_username}", flush=True)

                if request.folder == "lessons":
                    service_results = lessons_search_service.hybrid_search(
                        query=search_query,
                        username=folder_username,
                        top=50
                    )
                    mapped_results = []
                    for r in service_results:
                        raw = r.get("content", "") or r.get("content_preview", "")
                        cleaned = _clean_content(raw)
                        azure_hl = r.get("azure_highlights", [])
                        highlight_text = " ... ".join(azure_hl[:3]) if azure_hl else cleaned[:300]
                        mapped_results.append({
                            "filename": r.get("source_file", ""),
                            "page": None,
                            "content": cleaned[:300] + ("..." if len(cleaned) > 300 else ""),
                            "highlight": highlight_text,
                            "score": r.get("score", 0),
                            "path": r.get("file_path", ""),
                            "blob_path": r.get("file_path", ""),
                            "coords": None,
                            "type": "lessons",
                            "category": r.get("category", ""),
                            "user_id": folder_username or "",
                            "file_nm": r.get("file_nm", ""),
                        })
                else:  # revision
                    service_results = revision_search_service.hybrid_search(
                        query=search_query,
                        username=folder_username,
                        top=50
                    )
                    mapped_results = []
                    for r in service_results:
                        raw = r.get("content_preview", "") or ""
                        cleaned = _clean_content(raw)
                        azure_hl = r.get("azure_highlights", [])
                        highlight_text = " ... ".join(azure_hl[:3]) if azure_hl else cleaned[:300]
                        mapped_results.append({
                            "filename": r.get("doc_no", ""),
                            "page": r.get("page_number", 0),
                            "content": cleaned[:300] + ("..." if len(cleaned) > 300 else ""),
                            "highlight": highlight_text,
                            "score": r.get("score", 0),
                            "path": r.get("blob_path", ""),
                            "blob_path": r.get("blob_path", ""),
                            "coords": None,
                            "type": "revision",
                            "category": r.get("phase_name", ""),
                            "user_id": folder_username or "",
                            "title": r.get("title", ""),
                            "revision": r.get("revision", ""),
                        })

                print(f"[Chat] Folder search found {len(mapped_results)} results", flush=True)

                if request.mode == "search":
                    return ChatResponse(
                        response=f"Found {len(mapped_results)} documents.",
                        results=mapped_results
                    )

                # Chat mode: build context for GPT
                for r in mapped_results:
                    fname = r.get("filename", "Unknown")
                    pg = r.get("page", "")
                    context_text += f"\n=== Document: {fname} (Page {pg}) ===\n"
                    context_text += r.get("content", "") + "\n"

            # ---------------------------------------------------------
            # MODE: KEYWORD SEARCH (pdf-search-index)
            # ---------------------------------------------------------
            elif request.mode == "search":
                print(f"[Chat] Executing Keyword Search for user '{safe_user_id}': {search_query} | filter={search_filter}", flush=True)

                # Extract keywords for highlighting fallback
                search_keywords = _extract_search_keywords(request.query)
                print(f"[Chat] Search keywords for highlight: {search_keywords}", flush=True)

                # Execute Search with Azure highlight support
                search_results = azure_search_service.client.search(
                    search_text=search_query,
                    query_type=query_type,
                    filter=search_filter,
                    top=50,
                    select=["content", "source", "page", "title", "user_id", "category", "blob_path", "metadata_storage_path", "coords", "type"],
                    highlight_fields="content",
                    highlight_pre_tag="<mark>",
                    highlight_post_tag="</mark>",
                )

                results = []
                seen_pages = set()

                for res in search_results:
                    path = res.get("metadata_storage_path") or res.get("blob_path") or ""
                    filename = res.get("source")
                    page = res.get("page")

                    # Deduplication Key: Filename + Page
                    dedup_key = (filename, page)
                    if dedup_key in seen_pages:
                        continue

                    score = res.get("@search.score", 0)
                    seen_pages.add(dedup_key)

                    # Clean content (remove XML comments, HTML tags)
                    raw_content = res.get("content") or ""
                    cleaned = _clean_content(raw_content)

                    # Build highlight text:
                    # 1. Azure highlights (preferred — already has <mark> tags)
                    azure_highlights = (res.get("@search.highlights") or {}).get("content", [])
                    if azure_highlights:
                        # Clean XML artifacts but preserve <mark> tags from Azure
                        def _clean_preserve_mark(text):
                            text = _XML_COMMENT_RE.sub('', text)
                            # Remove HTML tags except <mark> and </mark>
                            text = re.sub(r'<(?!/?mark\b)[^>]+>', '', text)
                            text = _MULTI_SPACE_RE.sub(' ', text)
                            return text.strip()
                        cleaned_highlights = [_clean_preserve_mark(h) for h in azure_highlights[:3]]
                        highlight_text = " ... ".join(cleaned_highlights)
                    # 2. Python fallback: keyword-based snippet extraction
                    elif search_keywords:
                        highlight_text = _extract_and_highlight(cleaned, search_keywords)
                    # 3. Last resort: cleaned content first 300 chars
                    else:
                        highlight_text = cleaned[:300]

                    results.append({
                        "filename": filename,
                        "page": page,
                        "content": cleaned[:300] + ("..." if len(cleaned) > 300 else ""),
                        "highlight": highlight_text,
                        "score": score,
                        "path": path,
                        "blob_path": res.get("blob_path") or "",
                        "coords": res.get("coords"),
                        "type": res.get("type"),
                        "category": res.get("category"),
                        "user_id": res.get("user_id")
                    })

                # Cross-search: also search lessons + revision indexes (no folder = all indexes)
                if not request.folder:
                    cross_user = None
                    if is_admin:
                        cross_user = (request.target_users[0] if request.target_users else request.target_user) or None
                    else:
                        cross_user = safe_user_id
                    extra = _search_lessons_revision(search_query, cross_user, is_admin, top=20)
                    if extra:
                        print(f"[Chat] Cross-search added {len(extra)} results from lessons/revision", flush=True)
                        results.extend(extra)

                # Re-rank search results by keyword match density
                if results and request.query:
                    try:
                        results = _rerank_by_keywords(results, request.query)
                    except Exception as e:
                        print(f"[Chat] Search re-ranking failed (using original order): {e}", flush=True)

                print(f"[Chat] Keyword Search found {len(results)} unique pages.")
                return ChatResponse(
                    response=f"Found {len(results)} documents.",
                    results=results
                )

            # ---------------------------------------------------------
            # MODE: CHAT — Hybrid Search (Vector + Keyword)
            # (Only runs for default folders: documents, drawings, etc.)
            # ---------------------------------------------------------
            else:
                # Generate query embedding for vector search
                query_vector = None
                try:
                    from app.services.azure_search import azure_search_service as _search_svc
                    query_vector = _search_svc._generate_embedding(search_query)
                except Exception as e:
                    print(f"[Chat] Warning: Query embedding failed: {e}. Falling back to keyword-only.")

                vector_queries = []
                if query_vector:
                    vector_queries.append(
                        VectorizedQuery(
                            vector=query_vector,
                            k_nearest_neighbors=50,
                            fields="content_vector",
                        )
                    )

                search_results = azure_search_service.client.search(
                    search_text=search_query,
                    query_type=query_type,
                    filter=search_filter,
                    vector_queries=vector_queries if vector_queries else None,
                    top=50,
                    select=["content", "source", "page", "title", "category", "user_id", "blob_path", "coords", "type"],
                )

                results_list = list(search_results)
                print(f"[Chat] Hybrid Search Results Count: {len(results_list)}")

                # Python-side filtering by doc_ids (avoids Azure OData Korean issues)
                if request.doc_ids and len(request.doc_ids) > 0:
                    print(f"[Chat] Filtering results by doc_ids: {request.doc_ids}")
                    filtered_results = []
                    for result in results_list:
                        source_filename = result.get('source', '')
                        src_base = source_filename.replace('.pdf', '').replace('.pdf', '')  # Handle .pdf.pdf
                        for doc_id in request.doc_ids:
                            base_name = doc_id.replace('.pdf', '')
                            # Flexible matching: exact, contains, or partial overlap
                            if (src_base == base_name
                                or source_filename == doc_id
                                or base_name in src_base
                                or src_base in base_name):
                                filtered_results.append(result)
                                break
                    print(f"[Chat] Filtered Results Count: {len(filtered_results)} (from {len(results_list)})")
                    # Fallback: if strict filter yields 0, use all results
                    if len(filtered_results) > 0:
                        results_list = filtered_results
                    else:
                        print(f"[Chat] doc_ids filter matched 0 results. Using all {len(results_list)} search results as fallback.")

                # ---------------------------------------------------------
                # Re-ranking: Boost results with exact keyword matches
                # ---------------------------------------------------------
                if results_list and request.query:
                    try:
                        results_list = _rerank_by_keywords(results_list, request.query)
                    except Exception as e:
                        print(f"[Chat] Re-ranking failed (using original order): {e}", flush=True)

                if not results_list:
                    context_text = "No relevant documents found in the index."
                    print("[Chat] No results found in Azure Search.")
                else:
                    # Build context from re-ranked results (most relevant first)
                    for idx, result in enumerate(results_list):
                        source_filename = result.get('source', 'Unknown')
                        target_page = int(result.get('page', 0))

                        if target_page > 0:
                            page_doc_map[target_page] = source_filename

                        context_text += f"\n=== Document: {source_filename} (Page {target_page}) ===\n"
                        context_text += (result.get('content') or '') + "\n"

                # Cross-search: also include lessons + revision context (no folder = all indexes)
                if not request.folder:
                    cross_user = None
                    if is_admin:
                        cross_user = (request.target_users[0] if request.target_users else request.target_user) or None
                    else:
                        cross_user = safe_user_id
                    extra = _search_lessons_revision(search_query, cross_user, is_admin, top=10)
                    if extra:
                        print(f"[Chat] Cross-search added {len(extra)} context items from lessons/revision", flush=True)
                        for r in extra:
                            fname = r.get("filename", "Unknown")
                            pg = r.get("page", "")
                            context_text += f"\n=== [{r.get('type','doc')}] Document: {fname} (Page {pg}) ===\n"
                            context_text += r.get("content", "") + "\n"

        # Prepend viewing context (user's current viewport) if provided
        # This ensures the LLM always sees what the user is currently looking at
        if request.viewing_context:
            viewing_text = request.viewing_context.strip()
            if viewing_text:
                print(f"[Chat] Prepending viewing context ({len(viewing_text)} chars) to search results")
                context_text = f"=== 사용자가 현재 보고 있는 페이지 (Currently Viewing) ===\n{viewing_text}\n\n=== 검색 결과 (Search Results) ===\n{context_text}"

        # Truncate context if too long (increased to 100k for multi-file support)
        if len(context_text) > 100000:
            context_text = context_text[:100000] + "...(truncated)"

        # 3. Call Azure OpenAI
        system_prompt = """You are a design expert who understands drawing information. You act as an analyst who finds, compares, and reviews all information in provided drawings like Drawing 1, Drawing 2, etc. You must help designers reduce design risks. Use Markdown formats (tables, bullet points, bold text).

**🔗 MANDATORY Citation & Linking Rules (YOU MUST FOLLOW THESE):**

1. **CRITICAL:** Whenever you reference ANYTHING from the provided context/drawings, you MUST create a clickable citation link using the exact format: `[[UniqueKeyword|Page X|DocumentName]]`
   - **DocumentName** must be the exact filename from the context headers (e.g., from `=== Document: filename.pdf (Page 30) ===`, use `filename.pdf`)
   - **Page X** must be the exact page number shown in the context header where the information actually appears
   - **DO NOT guess or invent page numbers.** Only cite pages that exist in the provided context.
   - If only one document is in the context, still include its name in every citation.

2. **Examples of CORRECT citations:**
   - "According to the specification `[[절수형 기기 사용|Page 2|설계조건서.pdf]]`, water-saving devices are required."
   - "The valve `[[LIC-101|Page 5|P&ID_Area1.pdf]]` is located in the control room."
   - "Based on `[[설계 기준|Page 30|기술규격서.pdf]]`, the maximum pressure is 150 psi."
   - "The drawing shows `[[배관 경로|Page 3|배관도.pdf]]` running through the basement."

3. **What to cite:**
   - Equipment tags/IDs (e.g., `[[P-101A|Page 4|P&ID.pdf]]`)
   - Section headers (e.g., `[[설계 기준|Page 1|spec.pdf]]`)
   - Table names/titles (e.g., `[[부하 계산표|Page 2|계산서.pdf]]`)
   - Specific requirements (e.g., `[[내화 구조|Page 5|건축설계.pdf]]`)
   - Drawing references (e.g., `[[단면도|Page 3|도면.pdf]]`)

4. **DO NOT cite:**
   - Simple numbers alone: ❌ `[[0.2]]`, `[[18.0]]`, `[[150]]`
   - Generic words: ❌ `[[the]]`, `[[and]]`, `[[is]]`
   - Instead, cite the LABEL + number: ✅ `[[압력|Page 2|설계조건서.pdf]]` (150 psi)
   - **NEVER place citation links inside Markdown table cells.** Tables must contain only plain data values. Place citations in a note below the table or in the preceding paragraph instead.
   - **NEVER cite a page number that does not appear in the provided context.** If you see `=== Document: X (Page 30) ===`, cite Page 30, NOT Page 1.

5. **IMPORTANT:** Each paragraph of your answer should contain AT LEAST 1-2 citations if you're using information from the context. If you mention specific data, requirements, or drawing details, ALWAYS add a citation link.

6. **End Section - Key Search Terms:**
   At the very end of your response, add:

   ---
   🔍 **출처 바로가기 (Quick References)**
   - `[[가장 중요한 키워드|Page X|DocumentName]]`
   - `[[두번째 중요한 항목|Page Y|DocumentName]]`
   - `[[세번째 관련 정보|Page Z|DocumentName]]`

**Remember:** The more citations you provide, the better! Users rely on these links to verify information and navigate drawings quickly. Always use the EXACT page numbers and document names from the context.
"""

        # Build messages array with conversation history
        messages = [{"role": "system", "content": system_prompt}]

        # Include conversation history (last 10 exchanges max to stay within token limits)
        if request.history:
            history_msgs = request.history[-20:]  # Last 20 messages (10 exchanges)
            for msg in history_msgs:
                if msg.role in ("user", "assistant") and msg.content:
                    # Truncate long history messages to save tokens
                    content = msg.content[:2000] if len(msg.content) > 2000 else msg.content
                    messages.append({"role": msg.role, "content": content})

        messages.append({"role": "user", "content": f"Context:\n{context_text}\n\nQuestion: {request.query}"})

        response = client.chat.completions.create(
            model=settings.AZURE_OPENAI_DEPLOYMENT_NAME,
            messages=messages
        )

        response_content = response.choices[0].message.content
        
        # Post-Processing: Inject Document Name into Citations
        # The LLM is instructed to produce [[Keyword|Page X|DocumentName]] (3-part).
        # As a fallback, if LLM produces 2-part [[Keyword|Page X]], inject doc name from page_doc_map.
        # 3-part citations are left untouched (regex only matches 2-part).
        def citation_replacer(match):
            keyword = match.group(1)
            try:
                page_num = int(match.group(2))
                if page_num in page_doc_map:
                    doc_name = page_doc_map[page_num]

                    # FIX: Handle double extension issue (.pdf.pdf)
                    if doc_name.lower().endswith('.pdf.pdf'):
                        doc_name = doc_name[:-4]  # Remove last .pdf

                    return f"[[{keyword}|Page {page_num}|{doc_name}]]"
            except:
                pass
            return match.group(0)

        try:
            # Only matches 2-part: [[Keyword|Page 5]] (NOT 3-part with |DocName)
            response_content = re.sub(r'\[\[(.*?)\|Page\s*(\d+)\]\]', citation_replacer, response_content, flags=re.IGNORECASE)

            # Normalize any .pdf.pdf in 3-part citations produced by LLM
            def fix_double_pdf(m):
                return m.group(0).replace('.pdf.pdf', '.pdf')
            response_content = re.sub(r'\[\[.*?\|Page\s*\d+\|.*?\.pdf\.pdf\]\]', fix_double_pdf, response_content, flags=re.IGNORECASE)

            print("[Chat] Post-processed citations with document names.")
        except Exception as e:
            print(f"[Chat] Error in citation post-processing: {e}")

        # Prepare Deduplicated Results for Chat Response (Sources)
        sources_for_response = []
        seen_pages = set()
        for res in results_list:
            filename = res.get("source")
            page = res.get("page")
            dedup_key = (filename, page)
            
            if dedup_key in seen_pages:
                continue
            
            score = res.get("@search.score", 0)
            if score < 5.0:
                continue
                
            seen_pages.add(dedup_key)
            sources_for_response.append({
                "filename": filename,
                "page": int(page) if page else 0,
                "content": (res.get("content") or "")[:200] + "...",
                "score": score,
                "coords": res.get("coords"),
                "type": res.get("type"),
                "category": res.get("category"),
                "user_id": res.get("user_id")
            })

        return ChatResponse(
            response=response_content,
            results=sources_for_response
        )

    except Exception as e:
        print(f"Error in chat endpoint: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
