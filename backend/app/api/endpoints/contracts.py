"""
Contract Deviation Management - API Endpoints

- POST /upload           : Upload contract PDF → DI → parse articles → meta.json
- POST /parse-existing   : Parse existing blob JSON (no re-upload)
- GET  /list             : List user's contracts
- GET  /{contract_id}    : Contract detail (articles + deviation summary)
- POST /{contract_id}/deviations              : Create deviation
- GET  /{contract_id}/deviations              : List deviations (filter by article_id, status)
- POST /{contract_id}/deviations/{id}/comments : Add comment
- PATCH /{contract_id}/deviations/{id}/status  : Toggle open/close
- DELETE /{contract_id}  : Delete contract
"""

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Header, UploadFile, File, Form, Query
from pydantic import BaseModel

from app.core.config import settings
from app.core.firebase_admin import verify_id_token

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Pydantic Models ──

class CreateDeviationRequest(BaseModel):
    article_id: int
    subject: str
    initial_comment: str = ""
    author_role: str = "contractor"  # "contractor" | "client"
    author_name: str = ""


class AddCommentRequest(BaseModel):
    author: str = "contractor"
    author_name: str = ""
    content: str


class UpdateStatusRequest(BaseModel):
    status: str  # "open" | "closed"


class ParseExistingRequest(BaseModel):
    json_path: str
    contract_name: str = ""


# ── Auth Helper ──

def _get_username(authorization: Optional[str]) -> str:
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


# ── Blob Helpers ──

def _get_container():
    from app.services.blob_storage import get_container_client
    return get_container_client()


def _load_json(container, blob_path: str) -> Optional[dict]:
    try:
        blob = container.get_blob_client(blob_path)
        data = blob.download_blob().readall()
        return json.loads(data.decode('utf-8'))
    except Exception as e:
        logger.debug(f"Failed to load JSON: {blob_path} - {e}")
        return None


def _save_json(container, blob_path: str, obj: dict):
    data = json.dumps(obj, ensure_ascii=False, indent=2).encode('utf-8')
    container.upload_blob(name=blob_path, data=data, overwrite=True)


# ── Contract Article Parsing ──

def _parse_contract_articles(pages: list) -> dict:
    """Parse contract articles from DI-extracted pages.
    Input: list of {content, page_number}
    Output: {chapters: [...], articles: [{no, title, page, content, sub_clauses, chapter}]}

    Strategy: Contract PDFs often bundle the main contract (sequential articles
    1~100) with appendix/specification sections that restart numbering.
    We use art_no as the dedup key and keep the FIRST occurrence with real
    content (earliest page wins), which is always the main contract body.
    """
    chapters = []
    articles_map = {}  # art_no -> article dict (earliest page with content wins)

    # Regex patterns for Korean legal documents
    chapter_re = re.compile(r'제\s*(\d+)\s*장\s+([^\n제]{2,30})')
    article_re = re.compile(r'제\s*(\d+)\s*조\s*[\(（]([^)）]+)[\)）]')
    sub_clause_re = re.compile(r'[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]')
    # Also match numbered clauses like "1 ...", "2 ..."
    numbered_clause_re = re.compile(r'(?:^|\n)\s*(\d{1,2})\s+\S')

    # Phase 1: Collect chapter headers
    current_chapter = None
    for page in pages:
        content = page.get('content', '')
        for m in chapter_re.finditer(content):
            ch_no = int(m.group(1))
            ch_title = m.group(2).strip()
            if not any(c['no'] == ch_no for c in chapters):
                chapters.append({'no': ch_no, 'title': ch_title})

    # Phase 2: Extract articles — first page with real content wins (= main contract)
    current_chapter = None
    for page in pages:
        content = page.get('content', '')
        page_num = page.get('page_number', 0)

        if len(content.strip()) < 30:
            continue

        # Track current chapter
        for m in chapter_re.finditer(content):
            current_chapter = int(m.group(1))

        # Extract articles
        art_matches = list(article_re.finditer(content))
        for i, m in enumerate(art_matches):
            art_no = int(m.group(1))
            art_title = m.group(2).strip()

            # Skip references to external laws (e.g. 민법 제777조)
            if art_no > 300:
                continue

            # Extract article body: text from this match to next article or end of page
            start_pos = m.end()
            if i + 1 < len(art_matches):
                end_pos = art_matches[i + 1].start()
            else:
                end_pos = len(content)
            art_content = content[start_pos:end_pos].strip()

            # Limit content length
            if len(art_content) > 3000:
                art_content = art_content[:3000] + '...'

            # Count sub-clauses (circled numbers + numbered items)
            sub_clauses = len(sub_clause_re.findall(art_content))
            numbered = len(numbered_clause_re.findall(art_content))
            sub_clauses = max(sub_clauses, numbered)

            # Determine chapter from before_text on same page
            chapter = current_chapter
            before_text = content[:m.start()]
            ch_matches_before = list(chapter_re.finditer(before_text))
            if ch_matches_before:
                chapter = int(ch_matches_before[-1].group(1))

            key = art_no
            existing = articles_map.get(key)

            # Priority: first occurrence with real content (>15 chars) wins.
            # TOC entries have <=12 chars of noise (chapter headers between titles).
            # This ensures the main contract body (earlier pages) takes priority
            # over appendix/spec sections (later pages) that reuse article numbers.
            MIN_REAL = 15
            if not existing:
                articles_map[key] = {
                    'no': art_no,
                    'title': art_title,
                    'page': page_num,
                    'content': art_content,
                    'sub_clauses': sub_clauses,
                    'chapter': chapter,
                }
            elif len(existing.get('content', '').strip()) < MIN_REAL and len(art_content.strip()) >= MIN_REAL:
                # Existing is a TOC stub — replace with first real body text
                articles_map[key] = {
                    'no': art_no,
                    'title': art_title,
                    'page': page_num,
                    'content': art_content,
                    'sub_clauses': sub_clauses,
                    'chapter': chapter,
                }

    # Filter out TOC-only entries (no real body content)
    articles = [a for a in articles_map.values() if len(a.get('content', '').strip()) > 5]

    # Sort by article number (sequential 1, 2, 3, ... 100)
    articles.sort(key=lambda a: a['no'])
    chapters.sort(key=lambda c: c['no'])

    # Assign unique sequential id for deviation linking
    for i, art in enumerate(articles):
        art['id'] = i

    return {'chapters': chapters, 'articles': articles}


# ── Upload Contract ──

@router.post("/upload")
async def upload_contract(
    file: UploadFile = File(...),
    contract_name: str = Form(""),
    authorization: Optional[str] = Header(None)
):
    """Upload contract PDF → DI extraction → parse articles → save meta.json."""
    username = _get_username(authorization)
    filename = file.filename or "contract.pdf"
    contract_id = str(uuid.uuid4())
    contract_name = contract_name or filename.rsplit('.', 1)[0]

    print(f"[Contract] Upload by '{username}': {filename}", flush=True)

    file_content = await file.read()
    container = _get_container()

    # Save PDF to blob
    pdf_blob_path = f"{username}/contracts/{contract_id}/{filename}"
    container.upload_blob(name=pdf_blob_path, data=file_content, overwrite=True)
    print(f"[Contract] Saved PDF: {pdf_blob_path}", flush=True)

    # Azure DI text extraction
    pages = []
    try:
        from app.services.azure_di import azure_di_service
        from app.services.blob_storage import generate_sas_url
        pdf_url = generate_sas_url(pdf_blob_path)
        pages = azure_di_service.analyze_document_from_url(pdf_url)
        print(f"[Contract] DI extracted {len(pages)} pages", flush=True)
    except Exception as e:
        print(f"[Contract] DI extraction failed: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"Document analysis failed: {e}")

    # Parse articles
    parsed = _parse_contract_articles(pages)
    print(f"[Contract] Parsed {len(parsed['chapters'])} chapters, {len(parsed['articles'])} articles", flush=True)

    # Save DI result JSON for future re-parsing
    di_json_path = f"{username}/contracts/{contract_id}/di_result.json"
    _save_json(container, di_json_path, pages)

    # Build & save meta.json
    now = datetime.now(timezone.utc).isoformat()
    meta = {
        'contract_id': contract_id,
        'contract_name': contract_name,
        'filename': filename,
        'pdf_blob_path': pdf_blob_path,
        'di_json_path': di_json_path,
        'uploaded_at': now,
        'created_by': username,
        'total_pages': len(pages),
        'chapters': parsed['chapters'],
        'articles': parsed['articles'],
    }
    meta_path = f"{username}/contracts/{contract_id}/meta.json"
    _save_json(container, meta_path, meta)

    # Initialize empty deviations.json
    deviations_data = {
        'contract_id': contract_id,
        'deviations': [],
    }
    dev_path = f"{username}/contracts/{contract_id}/deviations.json"
    _save_json(container, dev_path, deviations_data)

    print(f"[Contract] Contract created: {contract_id}", flush=True)

    return {
        'status': 'success',
        'contract_id': contract_id,
        'contract_name': contract_name,
        'total_pages': len(pages),
        'chapters': len(parsed['chapters']),
        'articles': len(parsed['articles']),
    }


# ── Parse Existing JSON ──

@router.post("/parse-existing")
async def parse_existing(
    request: ParseExistingRequest,
    authorization: Optional[str] = Header(None)
):
    """Parse articles from existing DI-extracted JSON in blob storage."""
    username = _get_username(authorization)
    container = _get_container()
    contract_id = str(uuid.uuid4())

    json_path = request.json_path
    print(f"[Contract] Parse existing JSON: {json_path}", flush=True)

    # Load existing JSON
    pages = _load_json(container, json_path)
    if pages is None:
        raise HTTPException(status_code=404, detail=f"JSON not found: {json_path}")

    # Handle both list format and dict with pages key
    if isinstance(pages, dict):
        pages = pages.get('pages', pages.get('analyzeResult', {}).get('pages', []))
    if not isinstance(pages, list):
        raise HTTPException(status_code=400, detail="Invalid JSON format: expected list of pages")

    # Parse articles
    parsed = _parse_contract_articles(pages)
    contract_name = request.contract_name or json_path.rsplit('/', 1)[-1].rsplit('.', 1)[0]

    print(f"[Contract] Parsed {len(parsed['chapters'])} chapters, {len(parsed['articles'])} articles", flush=True)

    # Save meta.json
    now = datetime.now(timezone.utc).isoformat()
    meta = {
        'contract_id': contract_id,
        'contract_name': contract_name,
        'filename': json_path.rsplit('/', 1)[-1],
        'source_json_path': json_path,
        'uploaded_at': now,
        'created_by': username,
        'total_pages': len(pages),
        'chapters': parsed['chapters'],
        'articles': parsed['articles'],
    }
    meta_path = f"{username}/contracts/{contract_id}/meta.json"
    _save_json(container, meta_path, meta)

    # Initialize empty deviations.json
    deviations_data = {
        'contract_id': contract_id,
        'deviations': [],
    }
    dev_path = f"{username}/contracts/{contract_id}/deviations.json"
    _save_json(container, dev_path, deviations_data)

    return {
        'status': 'success',
        'contract_id': contract_id,
        'contract_name': contract_name,
        'total_pages': len(pages),
        'chapters': len(parsed['chapters']),
        'articles': len(parsed['articles']),
    }


# ── List Contracts ──

@router.get("/list")
async def list_contracts(
    authorization: Optional[str] = Header(None)
):
    """List all contracts for the current user."""
    username = _get_username(authorization)
    container = _get_container()

    contracts = []
    prefix = f"{username}/contracts/"
    try:
        blobs = container.list_blobs(name_starts_with=prefix)
        contract_ids = set()
        for blob in blobs:
            parts = blob.name.split('/')
            if len(parts) >= 3:
                cid = parts[2]
                if cid not in contract_ids:
                    contract_ids.add(cid)

        for cid in sorted(contract_ids):
            meta_path = f"{username}/contracts/{cid}/meta.json"
            meta = _load_json(container, meta_path)
            if meta:
                contracts.append({
                    'contract_id': meta.get('contract_id', cid),
                    'contract_name': meta.get('contract_name', ''),
                    'filename': meta.get('filename', ''),
                    'uploaded_at': meta.get('uploaded_at', ''),
                    'total_pages': meta.get('total_pages', 0),
                    'articles_count': len(meta.get('articles', [])),
                    'chapters_count': len(meta.get('chapters', [])),
                })
    except Exception as e:
        logger.error(f"List contracts failed: {e}")

    return {'contracts': contracts, 'username': username}


# ── Contract Detail ──

@router.get("/{contract_id}")
async def get_contract(
    contract_id: str,
    authorization: Optional[str] = Header(None)
):
    """Get contract detail: meta (articles) + deviations."""
    username = _get_username(authorization)
    container = _get_container()

    meta_path = f"{username}/contracts/{contract_id}/meta.json"
    meta = _load_json(container, meta_path)
    if not meta:
        raise HTTPException(status_code=404, detail="Contract not found")

    dev_path = f"{username}/contracts/{contract_id}/deviations.json"
    dev_data = _load_json(container, dev_path) or {'contract_id': contract_id, 'deviations': []}

    # Build deviation summary per article
    deviations = dev_data.get('deviations', [])
    dev_by_article = {}
    for d in deviations:
        art_no = d.get('article_id')
        if art_no not in dev_by_article:
            dev_by_article[art_no] = {'total': 0, 'open': 0, 'closed': 0}
        dev_by_article[art_no]['total'] += 1
        if d.get('status') == 'open':
            dev_by_article[art_no]['open'] += 1
        else:
            dev_by_article[art_no]['closed'] += 1

    # Overall summary
    total_dev = len(deviations)
    open_dev = sum(1 for d in deviations if d.get('status') == 'open')
    closed_dev = total_dev - open_dev

    return {
        **meta,
        'deviations': deviations,
        'deviation_summary': dev_by_article,
        'stats': {
            'total_articles': len(meta.get('articles', [])),
            'total_deviations': total_dev,
            'open_deviations': open_dev,
            'closed_deviations': closed_dev,
        },
    }


# ── Create Deviation ──

@router.post("/{contract_id}/deviations")
async def create_deviation(
    contract_id: str,
    request: CreateDeviationRequest,
    authorization: Optional[str] = Header(None)
):
    """Create a new deviation for a contract article."""
    username = _get_username(authorization)
    container = _get_container()

    # Verify contract exists
    meta_path = f"{username}/contracts/{contract_id}/meta.json"
    meta = _load_json(container, meta_path)
    if not meta:
        raise HTTPException(status_code=404, detail="Contract not found")

    # Load deviations
    dev_path = f"{username}/contracts/{contract_id}/deviations.json"
    dev_data = _load_json(container, dev_path) or {'contract_id': contract_id, 'deviations': []}

    now = datetime.now(timezone.utc).isoformat()
    deviation_id = str(uuid.uuid4())

    deviation = {
        'deviation_id': deviation_id,
        'article_id': request.article_id,
        'subject': request.subject,
        'status': 'open',
        'created_at': now,
        'created_by': request.author_name or username,
        'comments': [],
    }

    # Add initial comment if provided
    if request.initial_comment:
        deviation['comments'].append({
            'comment_id': str(uuid.uuid4()),
            'author': request.author_role,
            'author_name': request.author_name or username,
            'content': request.initial_comment,
            'created_at': now,
        })

    dev_data['deviations'].append(deviation)
    _save_json(container, dev_path, dev_data)

    print(f"[Contract] Deviation created: {deviation_id} for article {request.article_id}", flush=True)

    return {'status': 'success', 'deviation_id': deviation_id, 'deviation': deviation}


# ── List Deviations ──

@router.get("/{contract_id}/deviations")
async def list_deviations(
    contract_id: str,
    article_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None)
):
    """List deviations for a contract, optionally filtered by article_id or status."""
    username = _get_username(authorization)
    container = _get_container()

    dev_path = f"{username}/contracts/{contract_id}/deviations.json"
    dev_data = _load_json(container, dev_path)
    if not dev_data:
        raise HTTPException(status_code=404, detail="Contract not found")

    deviations = dev_data.get('deviations', [])

    if article_id is not None:
        deviations = [d for d in deviations if d.get('article_id') == article_id]
    if status:
        deviations = [d for d in deviations if d.get('status') == status]

    return {'deviations': deviations, 'total': len(deviations)}


# ── Add Comment ──

@router.post("/{contract_id}/deviations/{deviation_id}/comments")
async def add_comment(
    contract_id: str,
    deviation_id: str,
    request: AddCommentRequest,
    authorization: Optional[str] = Header(None)
):
    """Add a comment to a deviation thread."""
    username = _get_username(authorization)
    container = _get_container()

    dev_path = f"{username}/contracts/{contract_id}/deviations.json"
    dev_data = _load_json(container, dev_path)
    if not dev_data:
        raise HTTPException(status_code=404, detail="Contract not found")

    # Find deviation
    deviation = None
    for d in dev_data.get('deviations', []):
        if d.get('deviation_id') == deviation_id:
            deviation = d
            break
    if not deviation:
        raise HTTPException(status_code=404, detail="Deviation not found")

    comment = {
        'comment_id': str(uuid.uuid4()),
        'author': request.author,
        'author_name': request.author_name or username,
        'content': request.content,
        'created_at': datetime.now(timezone.utc).isoformat(),
    }
    deviation['comments'].append(comment)
    _save_json(container, dev_path, dev_data)

    print(f"[Contract] Comment added to deviation {deviation_id}", flush=True)

    return {'status': 'success', 'comment': comment}


# ── Update Deviation Status ──

@router.patch("/{contract_id}/deviations/{deviation_id}/status")
async def update_deviation_status(
    contract_id: str,
    deviation_id: str,
    request: UpdateStatusRequest,
    authorization: Optional[str] = Header(None)
):
    """Toggle deviation status (open/closed)."""
    username = _get_username(authorization)
    container = _get_container()

    if request.status not in ('open', 'closed'):
        raise HTTPException(status_code=400, detail="Status must be 'open' or 'closed'")

    dev_path = f"{username}/contracts/{contract_id}/deviations.json"
    dev_data = _load_json(container, dev_path)
    if not dev_data:
        raise HTTPException(status_code=404, detail="Contract not found")

    deviation = None
    for d in dev_data.get('deviations', []):
        if d.get('deviation_id') == deviation_id:
            deviation = d
            break
    if not deviation:
        raise HTTPException(status_code=404, detail="Deviation not found")

    deviation['status'] = request.status
    deviation['status_updated_at'] = datetime.now(timezone.utc).isoformat()
    _save_json(container, dev_path, dev_data)

    print(f"[Contract] Deviation {deviation_id} status → {request.status}", flush=True)

    return {'status': 'success', 'deviation_status': request.status}


# ── Delete Contract ──

@router.delete("/{contract_id}")
async def delete_contract(
    contract_id: str,
    authorization: Optional[str] = Header(None)
):
    """Delete a contract and all its data."""
    username = _get_username(authorization)
    container = _get_container()

    prefix = f"{username}/contracts/{contract_id}/"
    deleted_count = 0
    try:
        blobs = list(container.list_blobs(name_starts_with=prefix))
        for blob in blobs:
            container.delete_blob(blob.name)
            deleted_count += 1
        print(f"[Contract] Deleted {deleted_count} blobs for contract {contract_id}", flush=True)
    except Exception as e:
        logger.error(f"Contract deletion failed: {e}")

    return {'status': 'success', 'deleted_blobs': deleted_count}
