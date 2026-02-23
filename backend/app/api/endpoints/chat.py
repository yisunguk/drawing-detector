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
from app.services.linelist_search import linelist_search_service

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
    Re-rank search results using Azure score (primary) + keyword boost from highlight.

    Azure Search already scores using full content + embeddings.
    We use the highlight field (Azure's keyword extraction from FULL content)
    to add a keyword-match boost — this avoids reading full content in Python.
    """
    query_lower = original_query.lower().strip()
    raw_words = re.split(r'\s+', query_lower)

    keywords = []
    for w in raw_words:
        stripped = _strip_particle(w)
        if len(stripped) >= 2 and stripped not in _FILLER:
            keywords.append(stripped)

    if not keywords:
        return results_list

    print(f"[Chat] Re-ranking {len(results_list)} results by keywords: {keywords}", flush=True)

    # Normalize Azure scores across different indexes to 0-100 scale
    max_azure = max((r.get('@search.score', 0) for r in results_list), default=1) or 1

    for result in results_list:
        azure_score = result.get('@search.score', 0)
        normalized_azure = (azure_score / max_azure) * 100  # 0-100

        # Use highlight (Azure's keyword extraction from full content) + content for keyword matching
        highlight = re.sub(r'<[^>]+>', '', (result.get('highlight') or '')).lower()
        content = (result.get('content') or '').lower()
        text = highlight + " " + content

        # Count keyword hits
        hits = sum(1 for kw in keywords if kw in text)
        keyword_ratio = hits / len(keywords)

        # Adjacency bonus
        adjacency_bonus = 0
        for i in range(len(keywords) - 1):
            pattern = re.escape(keywords[i]) + r'.{0,30}' + re.escape(keywords[i + 1])
            if re.search(pattern, text):
                adjacency_bonus += 1

        # Combined: normalized azure (0-100) + keyword boost (0-200) + adjacency (0-100)
        result['_rerank_score'] = normalized_azure + (keyword_ratio * 200) + (adjacency_bonus * 100)

    results_list.sort(key=lambda r: r.get('_rerank_score', 0), reverse=True)

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
    exact_match: Optional[bool] = False  # True: keyword-only (no vector/translation), False: hybrid

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

def _search_lessons_revision(search_query: str, username: str | None, is_admin: bool, top: int = 20, exact_match: bool = False):
    """Search lessons-learned-index and revision-master-index, return unified results."""
    extra_results = []

    # Lessons
    try:
        lr = lessons_search_service.hybrid_search(
            query=search_query, username=username, top=top, exact_match=exact_match
        )
        for r in lr:
            full_raw = r.get("content", "") or r.get("content_preview", "")
            full_cleaned = _clean_content(full_raw)
            cleaned_short = full_cleaned[:300] + ("..." if len(full_cleaned) > 300 else "")
            azure_hl = r.get("azure_highlights", [])
            highlight_text = " ... ".join(azure_hl[:3]) if azure_hl else cleaned_short
            score = r.get("score", 0)
            extra_results.append({
                "filename": r.get("source_file", ""),
                "source": r.get("source_file", ""),
                "page": None,
                "content": cleaned_short,
                "full_content": full_cleaned,
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
            query=search_query, username=username, top=top, exact_match=exact_match
        )
        for r in rr:
            full_raw = r.get("content", "") or r.get("content_preview", "")
            full_cleaned = _clean_content(full_raw)
            cleaned_short = full_cleaned[:300] + ("..." if len(full_cleaned) > 300 else "")
            azure_hl = r.get("azure_highlights", [])
            highlight_text = " ... ".join(azure_hl[:3]) if azure_hl else cleaned_short
            score = r.get("score", 0)
            # Use actual filename from blob_path, with revision label
            blob_path = r.get("blob_path", "")
            rev_filename = blob_path.split("/")[-1] if blob_path else r.get("doc_no", "")
            rev_label = r.get("revision", "")
            display_name = f"[Rev.{rev_label}] {rev_filename}" if rev_label else rev_filename
            extra_results.append({
                "filename": display_name,
                "source": display_name,
                "page": r.get("page_number", 0),
                "content": cleaned_short,
                "full_content": full_cleaned,
                "highlight": highlight_text,
                "score": score,
                "@search.score": score,
                "path": blob_path,
                "blob_path": blob_path,
                "coords": None,
                "type": "revision",
                "category": r.get("phase_name", ""),
                "user_id": username or "",
            })
    except Exception as e:
        print(f"[Chat] Revision cross-search failed: {e}", flush=True)

    # Linelist
    try:
        ll = linelist_search_service.hybrid_search(
            query=search_query, username=username, top=top, exact_match=exact_match
        )
        for r in ll:
            full_raw = r.get("content", "") or r.get("content_preview", "")
            full_cleaned = _clean_content(full_raw)
            cleaned_short = full_cleaned[:300] + ("..." if len(full_cleaned) > 300 else "")
            azure_hl = r.get("azure_highlights", [])
            highlight_text = " ... ".join(azure_hl[:3]) if azure_hl else cleaned_short
            score = r.get("score", 0)
            extra_results.append({
                "filename": r.get("line_number", ""),
                "source": r.get("source_file", ""),
                "page": r.get("source_page", 0),
                "content": cleaned_short,
                "full_content": full_cleaned,
                "highlight": highlight_text,
                "score": score,
                "@search.score": score,
                "path": r.get("blob_path", ""),
                "blob_path": r.get("blob_path", ""),
                "coords": None,
                "type": "linelist",
                "category": r.get("pid_no", ""),
                "user_id": username or "",
            })
    except Exception as e:
        print(f"[Chat] Linelist cross-search failed: {e}", flush=True)

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
        cross_search_extra = []  # Cross-search results for citation resolution

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
            translated_query = False
            try:
                if request.exact_match:
                    print(f"[Chat] exact_match=True → skipping translation, using original query: '{request.query}'", flush=True)
                # If query contains Korean (simple check), generate English keywords
                elif any(ord(c) > 127 for c in request.query):
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
                    translated_query = True
                
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
            query_type = "full" if translated_query else "simple"
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
            if request.folder in ("lessons", "revision", "linelist"):
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
                        top=50,
                        exact_match=request.exact_match,
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
                elif request.folder == "revision":
                    service_results = revision_search_service.hybrid_search(
                        query=search_query,
                        username=folder_username,
                        top=50,
                        exact_match=request.exact_match,
                    )
                    mapped_results = []
                    for r in service_results:
                        raw = r.get("content_preview", "") or ""
                        cleaned = _clean_content(raw)
                        azure_hl = r.get("azure_highlights", [])
                        highlight_text = " ... ".join(azure_hl[:3]) if azure_hl else cleaned[:300]
                        blob_path = r.get("blob_path", "")
                        rev_filename = blob_path.split("/")[-1] if blob_path else r.get("doc_no", "")
                        rev_label = r.get("revision", "")
                        display_name = f"[Rev.{rev_label}] {rev_filename}" if rev_label else rev_filename
                        mapped_results.append({
                            "filename": display_name,
                            "source": display_name,
                            "page": r.get("page_number", 0),
                            "content": cleaned[:300] + ("..." if len(cleaned) > 300 else ""),
                            "highlight": highlight_text,
                            "score": r.get("score", 0),
                            "@search.score": r.get("score", 0),
                            "path": blob_path,
                            "blob_path": blob_path,
                            "coords": None,
                            "type": "revision",
                            "category": r.get("phase_name", ""),
                            "user_id": folder_username or "",
                            "title": r.get("title", ""),
                            "revision": rev_label,
                        })
                else:  # linelist
                    service_results = linelist_search_service.hybrid_search(
                        query=search_query,
                        username=folder_username,
                        top=50,
                        exact_match=request.exact_match,
                    )
                    mapped_results = []
                    for r in service_results:
                        raw = r.get("content", "") or r.get("content_preview", "")
                        cleaned = _clean_content(raw)
                        azure_hl = r.get("azure_highlights", [])
                        highlight_text = " ... ".join(azure_hl[:3]) if azure_hl else cleaned[:300]
                        mapped_results.append({
                            "filename": r.get("line_number", ""),
                            "source": r.get("source_file", ""),
                            "page": r.get("source_page", 0),
                            "content": cleaned[:300] + ("..." if len(cleaned) > 300 else ""),
                            "highlight": highlight_text,
                            "score": r.get("score", 0),
                            "@search.score": r.get("score", 0),
                            "path": r.get("blob_path", ""),
                            "blob_path": r.get("blob_path", ""),
                            "coords": None,
                            "type": "linelist",
                            "category": r.get("pid_no", ""),
                            "user_id": folder_username or "",
                            "line_number": r.get("line_number", ""),
                            "from_equip": r.get("from_equip", ""),
                            "to_equip": r.get("to_equip", ""),
                            "pipe_spec": r.get("pipe_spec", ""),
                            "fluid_code": r.get("fluid_code", ""),
                            "pid_no": r.get("pid_no", ""),
                        })

                print(f"[Chat] Folder search found {len(mapped_results)} results", flush=True)

                if request.mode == "search":
                    # Re-rank folder-specific results too
                    if mapped_results and request.query:
                        try:
                            mapped_results = _rerank_by_keywords(mapped_results, request.query)
                        except Exception as e:
                            print(f"[Chat] Folder search re-ranking failed: {e}", flush=True)
                    for r in mapped_results:
                        if '_rerank_score' in r:
                            r['score'] = r['_rerank_score']
                        r.pop('_rerank_score', None)
                        r.pop('@search.score', None)

                    # Exact match filter for folder-specific search
                    if request.exact_match and mapped_results:
                        em_keywords = _extract_search_keywords(request.query)
                        em_kws_lower = [kw.lower() for kw in em_keywords]
                        if em_kws_lower:
                            filtered = []
                            for r in mapped_results:
                                content_lower = (r.get("content", "") or "").lower()
                                fname_lower = (r.get("filename", "") or "").lower()
                                highlight_lower = (r.get("highlight", "") or "").lower()
                                if any(kw in content_lower or kw in fname_lower or kw in highlight_lower for kw in em_kws_lower):
                                    filtered.append(r)
                            print(f"[Chat] Folder exact match filter: {len(mapped_results)} → {len(filtered)} results", flush=True)
                            mapped_results = filtered

                    return ChatResponse(
                        response=f"Found {len(mapped_results)} documents.",
                        results=mapped_results
                    )

                # Chat mode: send only top-K results to LLM (standard RAG approach)
                TOP_K_FOLDER = 5
                MAX_CONTENT_PER_DOC = 4000
                top_results = service_results[:TOP_K_FOLDER]
                print(f"[Chat] Folder chat: sending top {len(top_results)} of {len(service_results)} to LLM", flush=True)
                for r in top_results:
                    full_content = r.get("content", "") or r.get("content_preview", "")
                    if len(full_content) > MAX_CONTENT_PER_DOC:
                        full_content = full_content[:MAX_CONTENT_PER_DOC] + "...(truncated)"
                    if request.folder == "revision":
                        blob_path = r.get("blob_path", "")
                        rev_filename = blob_path.split("/")[-1] if blob_path else r.get("doc_no", "")
                        rev_label = r.get("revision", "")
                        fname = f"[Rev.{rev_label}] {rev_filename}" if rev_label else rev_filename
                        pg = r.get("page_number", "")
                    elif request.folder == "linelist":
                        fname = r.get("line_number", "") or r.get("source_file", "")
                        pg = r.get("source_page", "")
                    else:  # lessons
                        fname = r.get("source_file", "") or r.get("file_nm", "")
                        pg = ""
                    context_text += f"\n=== Document: {fname} (Page {pg}) ===\n"
                    context_text += full_content + "\n"

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

                    blob_path = res.get("blob_path") or ""
                
                    # FALLBACK: If blob_path is empty, construct it
                    if not blob_path:
                        # Try to find user_id from result or request
                        res_user_id = res.get("user_id") or request.username or "관리자"
                        res_category = res.get("category") or "documents"
                        res_filename = filename
                        blob_path = f"{res_user_id}/{res_category}/{res_filename}"
                        print(f"[Chat] WARNING: blob_path missing for {filename}. Constructed fallback: {blob_path}")

                    results.append({
                        "filename": filename,
                        "source": filename,
                        "page": page,
                        "content": cleaned[:300] + ("..." if len(cleaned) > 300 else ""),
                        "highlight": highlight_text,
                        "score": score,
                        "@search.score": score,
                        "path": path,
                        "blob_path": blob_path,
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
                    extra = _search_lessons_revision(search_query, cross_user, is_admin, top=20, exact_match=request.exact_match)
                    cross_search_extra = extra or []
                    if extra:
                        print(f"[Chat] Cross-search added {len(extra)} results from lessons/revision", flush=True)
                        results.extend(extra)

                # Re-rank search results by keyword match density
                if results and request.query:
                    try:
                        results = _rerank_by_keywords(results, request.query)
                    except Exception as e:
                        print(f"[Chat] Search re-ranking failed (using original order): {e}", flush=True)

                # Post-rerank: update score for UI badge
                for r in results:
                    if '_rerank_score' in r:
                        r['score'] = r['_rerank_score']
                    r.pop('_rerank_score', None)
                    r.pop('@search.score', None)

                # Exact match filter: keep only results where query keywords appear in content/filename
                if request.exact_match and results:
                    em_keywords = _extract_search_keywords(request.query)
                    em_kws_lower = [kw.lower() for kw in em_keywords]
                    if em_kws_lower:
                        filtered = []
                        for r in results:
                            content_lower = (r.get("content", "") or "").lower()
                            fname_lower = (r.get("filename", "") or "").lower()
                            highlight_lower = (r.get("highlight", "") or "").lower()
                            if any(kw in content_lower or kw in fname_lower or kw in highlight_lower for kw in em_kws_lower):
                                filtered.append(r)
                        print(f"[Chat] Exact match filter: {len(results)} → {len(filtered)} results", flush=True)
                        results = filtered

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
                    select=["content", "source", "page", "title", "category", "user_id", "blob_path", "metadata_storage_path", "coords", "type"],
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
                    # ── Standard RAG: Send only top-K most relevant results to LLM ──
                    # Search finds 50 candidates, but LLM only needs the best 5.
                    # This is the standard approach used by LangChain, LlamaIndex, etc.
                    TOP_K_MAIN = 10 if not request.doc_ids else min(len(results_list), 15)
                    TOP_K_CROSS = 5
                    MAX_CONTENT_PER_DOC = 4000  # ~1000 tokens per doc

                    # Cross-search: lessons + revision (only when no folder selected)
                    cross_context = ""
                    if not request.folder:
                        cross_user = None
                        if is_admin:
                            cross_user = (request.target_users[0] if request.target_users else request.target_user) or None
                        else:
                            cross_user = safe_user_id
                        extra = _search_lessons_revision(search_query, cross_user, is_admin, top=TOP_K_CROSS)
                        cross_search_extra = extra or []
                        if extra:
                            print(f"[Chat] Cross-search: {len(extra)} results from lessons/revision", flush=True)
                            for r in extra:
                                fname = r.get("filename", "Unknown")
                                pg = r.get("page", "")
                                full = r.get("full_content", "") or r.get("content", "")
                                if len(full) > MAX_CONTENT_PER_DOC:
                                    full = full[:MAX_CONTENT_PER_DOC] + "...(truncated)"
                                cross_context += f"\n=== [{r.get('type','doc')}] Document: {fname} (Page {pg}) ===\n"
                                cross_context += full + "\n"

                    # Main results: top-K after rerank
                    main_results = results_list[:TOP_K_MAIN]
                    total_context_chars = len(cross_context)
                    for result in main_results:
                        total_context_chars += len(result.get('content') or '')
                    print(f"[Chat] RAG context: top {len(main_results)} of {len(results_list)} results + {len(cross_context):,} chars cross-search = ~{total_context_chars:,} chars total", flush=True)

                    # Build context: cross-search first, then main results
                    if cross_context:
                        context_text += cross_context
                        # Add cross-search documents to page_doc_map for citation resolution
                        for r in (cross_search_extra or []):
                            pg = r.get("page")
                            fname = r.get("filename", "")
                            if pg and fname:
                                page_key = int(pg) if pg else 0
                                if page_key > 0 and page_key not in page_doc_map:
                                    page_doc_map[page_key] = fname

                    for idx, result in enumerate(main_results):
                        source_filename = result.get('source', 'Unknown')
                        target_page = int(result.get('page', 0))

                        if target_page > 0 and target_page not in page_doc_map:
                            page_doc_map[target_page] = source_filename

                        content = (result.get('content') or '')
                        if len(content) > MAX_CONTENT_PER_DOC:
                            content = content[:MAX_CONTENT_PER_DOC] + "...(truncated)"
                        context_text += f"\n=== Document: {source_filename} (Page {target_page}) ===\n"
                        context_text += content + "\n"

        # Debug: verify what's in context
        _ctx_upper = context_text.upper()
        _debug_keywords = ["FIBRE GLASS", "E-GLASS", "POLYESTER", "SINTERED"]
        _found = {kw: kw in _ctx_upper for kw in _debug_keywords}
        print(f"[Chat] Context debug: {len(context_text):,} chars, keywords={_found}", flush=True)

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
        system_prompt = """당신은 **건설 EPC 프로젝트 문서 관리 및 설계 지원 전문가**입니다.
제공된 컨텍스트(검색된 문서 내용)를 바탕으로 도면, 리비전, 설계 사양서, 데이터시트, 보고서를 분석하여 사용자에게 **정확한 정보**를 제공하는 것이 임무입니다. 설계 리스크를 줄이는 데 도움을 주어야 합니다.

---
## 📋 답변 가이드라인

1. **모든 문서 소스 활용:** 컨텍스트에는 Main 문서, 리비전 문서 `[revision]`, 교훈 문서 `[lessons]` 등 **여러 인덱스**의 문서가 포함됩니다. 관련 있는 **모든 문서**의 정보를 빠짐없이 언급하세요.
2. **리비전 비교 필수:** 동일 도면/문서에 여러 리비전(Rev.A, Rev.B, Rev.C 등)이 존재하면, **각 리비전의 차이점을 비교표(Table)로 정리**하세요. 재질·사양·치수 등이 변경된 경우 반드시 하이라이트하세요.
3. **최신 리비전 우선:** 최신 리비전을 기준으로 답변하되, 구버전과의 차이가 있으면 "Rev.A 기준" 등으로 명시하세요.
4. **고유 식별자 보존:** Tag No., 도면 번호, Material Spec, Pressure Class 등은 **원문 그대로** 전달하세요. 임의 요약이나 변경 금지.
5. **불확실성 처리:** 컨텍스트에 정보가 없으면 추측하지 마세요. "제공된 문서 내에서 해당 정보를 찾을 수 없습니다"라고 답하고, 관련 가능성이 있는 문서를 제안하세요.
6. **표 형식 활용:** 수치 데이터(설계 사양, 기자재 리스트, 리비전 비교 등)는 **Markdown 표**를 적극 활용하세요.

## 🛠️ 문서 유형별 특화 지침

- **도면/P&ID:** 라인 번호나 Instrument Tag 검색 시 전후단 도면 정보(Service, Origin/Destination)를 함께 언급.
- **설계 사양서/데이터시트:** 자재 규격(Standard), 허용 오차 등은 해당 섹션 번호와 함께 제공.
- **현장 보고서/교훈(Lessons Learned):** 이슈 발생 날짜, 작성자를 명확히 구분하여 전달.

---
## 🔗 인용(Citation) 규칙

정보를 참조할 때 반드시 아래 형식의 클릭 가능한 인용 링크를 삽입하세요:

`[[키워드|Page X|문서명]]`

- **문서명** = 컨텍스트 헤더의 정확한 파일명 (예: `=== Document: spec.pdf (Page 5) ===` → `spec.pdf`)
- **Page X** = 컨텍스트 헤더의 정확한 페이지 번호. **추측·날조 금지.**
- 단락마다 최소 1~2개 인용 포함. 구체적 데이터·요구사항·도면 상세를 언급할 때는 반드시 인용 추가.

**인용 예시:**
- `[[LIC-101|Page 5|P&ID_Area1.pdf]]` — 장비 태그
- `[[설계 기준|Page 30|기술규격서.pdf]]` — 섹션/요구사항
- `[[FILTER ELEMENT|Page 3|GA_Drawing_Rev.C.pdf]]` — 도면 상세

**인용 금지 대상:**
- 숫자만 단독: ❌ `[[0.2]]`, `[[150]]` → ✅ `[[압력 150psi|Page 2|spec.pdf]]`
- Markdown 표 셀 내부에 인용 링크 배치 금지 → 표 아래 또는 앞 단락에 배치
- 컨텍스트에 존재하지 않는 페이지 번호 인용 금지

**응답 마지막에 반드시 추가:**

---
🔍 **출처 바로가기 (Quick References)**
- `[[키워드1|Page X|문서명]]`
- `[[키워드2|Page Y|문서명]]`
- `[[키워드3|Page Z|문서명]]`
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
        
        # Prepare Sources Map for Index-Based Citations
        # We need to know the final index of each (filename, page) in the results array sent to frontend.
        # This mirrors the logic used to build `sources_for_response` later.
        source_index_map = {}
        _temp_seen = set()
        _current_index = 0

        # simulate main results addition
        for res in results_list:
            fname = res.get("source")
            pg = res.get("page")
            key = (fname, pg) # dedup key
            if key not in _temp_seen:
                _temp_seen.add(key)
                source_index_map[key] = _current_index
                _current_index += 1
        
        # simulate cross search addition
        if cross_search_extra:
            for r in cross_search_extra:
                fname = r.get("filename", "")
                pg = r.get("page")
                key = (fname, pg)
                if key not in _temp_seen:
                    _temp_seen.add(key)
                    source_index_map[key] = _current_index
                    _current_index += 1

        # Post-Processing: Inject Document Name AND Index into Citations
        # The LLM is instructed to produce [[Keyword|Page X|DocumentName]] (3-part).
        # We will upgrade this to [[Keyword|Page X|DocumentName|Index]] (4-part) for robust linking.
        def citation_replacer(match):
            keyword = match.group(1)
            try:
                page_num = int(match.group(2))
                
                # Default values
                doc_name = "Unknown"
                source_idx = -1

                # 1. Try to find robust match in page_doc_map (which stores filename)
                if page_num in page_doc_map:
                    doc_name = page_doc_map[page_num]
                    
                    # FIX: Handle double extension issue (.pdf.pdf)
                    if doc_name.lower().endswith('.pdf.pdf'):
                        doc_name = doc_name[:-4]

                    # 2. Find the index for this (doc_name, page_num)
                    # We look up in our pre-calculated map
                    # CAUTION: page_doc_map keys are ints. source_index_map keys are (filename, page_as_int_or_str?)
                    # Let's ensure consistency. source_index_map keys constructed from results are likely mixed types.
                    # We iterates to find best match if standard lookup fails, but let's try direct first.
                    
                    # Try exact key match (assuming map keys are (str, int) or (str, str))
                    # In results_list, page is often int or str.
                    # Let's check typical types.
                    
                    found_idx = -1
                    # Iterate to find matching index for this filename + page (safest)
                    for (f, p), idx in source_index_map.items():
                         # Compare filename (case insensitive just in case) and page
                         if f == doc_name and str(p) == str(page_num):
                             found_idx = idx
                             break
                    
                    if found_idx == -1:
                        # Fallback: maybe just filename match for that page?
                        # Or if doc_name is not in map (rare if page_doc_map has it)
                        pass
                    else:
                        source_idx = found_idx

                    # Return 4-part citation: [[Keyword|Page X|DocName|Index]]
                    # If index is -1, frontend will fall back to old fuzzy matching
                    return f"[[{keyword}|Page {page_num}|{doc_name}|{source_idx}]]"
            except:
                pass
            return match.group(0) # Return original if failure

        try:
            # Only matches 2-part: [[Keyword|Page 5]] -> convert to 4-part
            response_content = re.sub(r'\[\[(.*?)\|Page\s*(\d+)\]\]', citation_replacer, response_content, flags=re.IGNORECASE)

            # Also upgrade existing 3-part citations (produced effectively by LLM sometimes) to 4-part
            # Pattern: [[Keyword|Page X|DocName]] -> [[Keyword|Page X|DocName|Index]]
            def upgrade_3part(match):
                kw = match.group(1)
                pg = match.group(2)
                doc = match.group(3)
                idx = -1
                for (f, p), i in source_index_map.items():
                    if f == doc and str(p) == str(pg):
                        idx = i
                        break
                return f"[[{kw}|Page {pg}|{doc}|{idx}]]"

            response_content = re.sub(r'\[\[(.*?)\|Page\s*(\d+)\|(.*?)\]\]', upgrade_3part, response_content, flags=re.IGNORECASE)

            # Normalize any .pdf.pdf in resulting citations
            def fix_double_pdf(m):
                return m.group(0).replace('.pdf.pdf', '.pdf')
            response_content = re.sub(r'\.pdf\.pdf', '.pdf', response_content, flags=re.IGNORECASE)

            # Log all citations found in final response
            all_citations = re.findall(r'\[\[(.*?)\]\]', response_content)
            print(f"[Chat] Post-processed citations ({len(all_citations)}): {all_citations[:10]}", flush=True)
            print(f"[Chat] page_doc_map: {dict(list(page_doc_map.items())[:10])}", flush=True)
        except Exception as e:
            print(f"[Chat] Error in citation post-processing: {e}")

        # Prepare Deduplicated Results for Chat Response (Sources)
        sources_for_response = []
        seen_pages = set()

        # Include main search results (use rerank_score if available, else @search.score)
        for res in results_list:
            filename = res.get("source")
            page = res.get("page")
            dedup_key = (filename, page)

            if dedup_key in seen_pages:
                continue

            seen_pages.add(dedup_key)
            # Use _rerank_score (set by reranker) or fallback to @search.score
            display_score = res.get("_rerank_score") or res.get("@search.score", 0)
            sources_for_response.append({
                "filename": filename,
                "page": int(page) if page else 0,
                "content": (res.get("content") or "")[:200] + "...",
                "score": display_score,
                "coords": res.get("coords"),
                "type": res.get("type"),
                "category": res.get("category"),
                "user_id": res.get("user_id"),
                "blob_path": res.get("blob_path") or res.get("metadata_storage_path") or "",
            })

        # Include cross-search (revision/lessons) results for citation link resolution
        if cross_search_extra:
            for r in cross_search_extra:
                fname = r.get("filename", "")
                pg = r.get("page")
                dedup_key = (fname, pg)
                if dedup_key in seen_pages:
                    continue
                seen_pages.add(dedup_key)
                sources_for_response.append({
                    "filename": fname,
                    "page": int(pg) if pg else 0,
                    "content": (r.get("content") or "")[:200] + "...",
                    "score": r.get("score", 0),
                    "coords": None,
                    "type": r.get("type"),
                    "category": r.get("category"),
                    "user_id": r.get("user_id"),
                    "blob_path": r.get("blob_path", ""),
                })

        print(f"[Chat] Sources for response: {len(sources_for_response)} items", flush=True)
        for i, s in enumerate(sources_for_response[:5]):
            print(f"[Chat]   src#{i+1}: {s.get('filename')} p.{s.get('page')} score={s.get('score',0):.1f} blob={s.get('blob_path','')[:60]}", flush=True)

        return ChatResponse(
            response=response_content,
            results=sources_for_response
        )

    except Exception as e:
        print(f"Error in chat endpoint: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
