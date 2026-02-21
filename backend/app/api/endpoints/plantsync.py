"""
PlantSync AI - Plant Drawing Revision & Discipline Collaboration API

- POST   /projects                                    : Create project
- GET    /projects                                    : List projects
- GET    /projects/{id}                               : Project detail
- DELETE /projects/{id}                               : Delete project
- POST   /projects/{id}/upload                        : Upload drawing PDF → DI → Title Block
- PUT    /projects/{id}/drawings/{did}/title-block     : Confirm/edit Title Block
- GET    /projects/{id}/drawings/{did}/pdf-url         : Get PDF SAS URL
- POST   /projects/{id}/drawings/{did}/markups         : Create markup (pin)
- GET    /projects/{id}/drawings/{did}/markups          : List markups (filter: page, discipline)
- PATCH  /projects/{id}/drawings/{did}/markups/{mid}   : Update markup status
- POST   /projects/{id}/drawings/{did}/markups/{mid}/replies : Add reply
- PUT    /projects/{id}/drawings/{did}/review           : Update discipline review status
- POST   /projects/{id}/drawings/{did}/approve          : EM final approval
- GET    /projects/{id}/dashboard                       : Dashboard stats
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

class CreateProjectRequest(BaseModel):
    project_name: str
    project_code: Optional[str] = None
    description: Optional[str] = None


class ConfirmTitleBlockRequest(BaseModel):
    drawing_number: Optional[str] = None
    title: Optional[str] = None
    revision: Optional[str] = None
    discipline: Optional[str] = None


class CreateMarkupRequest(BaseModel):
    page: int
    x: float
    y: float
    discipline: str
    comment: str
    severity: Optional[str] = "normal"
    author_name: Optional[str] = None


class UpdateMarkupRequest(BaseModel):
    status: Optional[str] = None
    comment: Optional[str] = None


class AddMarkupReplyRequest(BaseModel):
    author_name: Optional[str] = None
    content: str


class UpdateReviewStatusRequest(BaseModel):
    discipline: str
    status: str  # "not_started" | "in_progress" | "completed" | "rejected"
    reviewer_name: Optional[str] = None
    comment: Optional[str] = None


class FinalApprovalRequest(BaseModel):
    decision: str  # "approved" | "rejected" | "conditionally_approved"
    approver_name: Optional[str] = None
    comment: Optional[str] = None


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


def _save_json(container, blob_path: str, obj):
    data = json.dumps(obj, ensure_ascii=False, indent=2).encode('utf-8')
    container.upload_blob(name=blob_path, data=data, overwrite=True)


def _meta_path(username: str, project_id: str) -> str:
    return f"{username}/plantsync/{project_id}/meta.json"


def _markups_path(username: str, project_id: str) -> str:
    return f"{username}/plantsync/{project_id}/markups.json"


def _list_projects(container, username: str) -> list:
    """List all project meta.json files for a user."""
    prefix = f"{username}/plantsync/"
    projects = []
    try:
        blobs = container.list_blobs(name_starts_with=prefix)
        for blob in blobs:
            if blob.name.endswith('/meta.json'):
                meta = _load_json(container, blob.name)
                if meta:
                    projects.append(meta)
    except Exception as e:
        logger.error(f"Error listing projects: {e}")
    return projects


DISCIPLINES = [
    "process", "mechanical", "piping", "electrical", "instrument", "civil"
]


def _empty_review_status():
    return {d: {"status": "not_started"} for d in DISCIPLINES}


# ── Title Block Extraction ──

def _extract_title_block(di_pages: list) -> dict:
    """Extract drawing number, title, revision from DI result (first page)."""
    result = {
        "drawing_number": "",
        "title": "",
        "revision": "",
        "discipline": "",
    }
    if not di_pages:
        return result

    page = di_pages[0]
    content = page.get("content", "")

    # Try DI metadata fields first
    if page.get("도면번호(DWG. NO.)"):
        result["drawing_number"] = page["도면번호(DWG. NO.)"]
    if page.get("도면명(TITLE)"):
        result["title"] = page["도면명(TITLE)"]

    # Pattern matching from content
    lines = content.split('\n')
    for line in lines:
        line_upper = line.strip().upper()

        # Drawing number patterns
        if not result["drawing_number"]:
            dwg_match = re.search(
                r'(?:DWG\.?\s*(?:NO\.?|NUMBER)?|DRAWING\s*(?:NO\.?|NUMBER)?)\s*[:\-]?\s*([A-Z0-9][\w\-\.]+)',
                line_upper
            )
            if dwg_match:
                result["drawing_number"] = dwg_match.group(1).strip()

            # Generic drawing number pattern (e.g. 10-24000-OM-171-200)
            if not result["drawing_number"]:
                generic = re.search(r'(\d{2,}-\d{3,}-[A-Z]{2,}-[\d\-]+)', line_upper)
                if generic:
                    result["drawing_number"] = generic.group(1)

        # Revision patterns
        if not result["revision"]:
            rev_match = re.search(
                r'(?:REV\.?\s*(?:NO\.?)?|REVISION)\s*[:\-]?\s*([A-Z0-9]{1,3})',
                line_upper
            )
            if rev_match:
                result["revision"] = rev_match.group(1).strip()

        # Title patterns
        if not result["title"]:
            title_match = re.search(
                r'(?:TITLE|DESCRIPTION)\s*[:\-]?\s*(.{5,})',
                line_upper
            )
            if title_match:
                result["title"] = title_match.group(1).strip()

    # If no title found from patterns, use the DI page content snippet
    if not result["title"] and len(lines) > 2:
        # Use longest line as a heuristic for the title
        longest = max(lines[:20], key=len).strip() if lines else ""
        if len(longest) > 5:
            result["title"] = longest[:200]

    # Try to guess discipline from drawing number or content
    content_lower = content.lower()
    dwg_lower = result["drawing_number"].lower()
    if any(k in dwg_lower or k in content_lower for k in ['pid', 'p&id', 'process']):
        result["discipline"] = "process"
    elif any(k in dwg_lower for k in ['-me-', '-mc-', '-om-']):
        result["discipline"] = "mechanical"
    elif any(k in dwg_lower for k in ['-pp-', '-pi-', '-pl-']):
        result["discipline"] = "piping"
    elif any(k in dwg_lower for k in ['-el-', '-ee-']):
        result["discipline"] = "electrical"
    elif any(k in dwg_lower for k in ['-in-', '-ic-']):
        result["discipline"] = "instrument"
    elif any(k in dwg_lower for k in ['-cv-', '-cs-', '-ci-']):
        result["discipline"] = "civil"

    return result


# ── API Endpoints ──

@router.post("/projects")
async def create_project(
    req: CreateProjectRequest,
    authorization: Optional[str] = Header(None)
):
    username = _get_username(authorization)
    container = _get_container()

    project_id = str(uuid.uuid4())[:8]
    now = datetime.now(timezone.utc).isoformat()

    meta = {
        "project_id": project_id,
        "project_name": req.project_name,
        "project_code": req.project_code or "",
        "description": req.description or "",
        "created_at": now,
        "updated_at": now,
        "drawings": [],
    }

    _save_json(container, _meta_path(username, project_id), meta)
    print(f"[PlantSync] Project created: {project_id} by {username}", flush=True)

    return {"status": "success", "project": meta}


@router.get("/projects")
async def list_projects(authorization: Optional[str] = Header(None)):
    username = _get_username(authorization)
    container = _get_container()

    projects = _list_projects(container, username)
    # Return summary (without full drawings list)
    summaries = []
    for p in projects:
        summaries.append({
            "project_id": p["project_id"],
            "project_name": p["project_name"],
            "project_code": p.get("project_code", ""),
            "description": p.get("description", ""),
            "drawing_count": len(p.get("drawings", [])),
            "created_at": p.get("created_at", ""),
            "updated_at": p.get("updated_at", ""),
        })

    return {"status": "success", "projects": summaries}


@router.get("/projects/{project_id}")
async def get_project(project_id: str, authorization: Optional[str] = Header(None)):
    username = _get_username(authorization)
    container = _get_container()

    meta = _load_json(container, _meta_path(username, project_id))
    if not meta:
        raise HTTPException(status_code=404, detail="Project not found")

    return {"status": "success", "project": meta}


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str, authorization: Optional[str] = Header(None)):
    username = _get_username(authorization)
    container = _get_container()

    prefix = f"{username}/plantsync/{project_id}/"
    try:
        blobs = list(container.list_blobs(name_starts_with=prefix))
        for blob in blobs:
            container.delete_blob(blob.name)
        print(f"[PlantSync] Project deleted: {project_id}, {len(blobs)} blobs removed", flush=True)
    except Exception as e:
        print(f"[PlantSync] Error deleting project: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"Delete failed: {e}")

    return {"status": "success", "deleted": project_id}


@router.post("/projects/{project_id}/upload")
async def upload_drawing(
    project_id: str,
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(None)
):
    username = _get_username(authorization)
    container = _get_container()

    meta = _load_json(container, _meta_path(username, project_id))
    if not meta:
        raise HTTPException(status_code=404, detail="Project not found")

    # Read file
    file_content = await file.read()
    if not file_content:
        raise HTTPException(status_code=400, detail="Empty file")

    drawing_id = str(uuid.uuid4())[:8]
    filename = file.filename or f"{drawing_id}.pdf"
    blob_path = f"{username}/plantsync/{project_id}/drawings/{drawing_id}/{filename}"

    # Upload PDF to blob
    container.upload_blob(name=blob_path, data=file_content, overwrite=True)
    print(f"[PlantSync] PDF uploaded: {blob_path}", flush=True)

    # Generate SAS URL for DI analysis
    from app.services.blob_storage import generate_sas_url
    pdf_url = generate_sas_url(blob_path)

    # Run Document Intelligence (page 1 only for title block)
    di_result = []
    title_block = {"drawing_number": "", "title": "", "revision": "", "discipline": ""}
    try:
        from app.services.azure_di import azure_di_service
        di_result = azure_di_service.analyze_document_from_url(pdf_url, pages="1")
        print(f"[PlantSync] DI analysis complete: {len(di_result)} pages", flush=True)

        # Save full DI result
        di_path = f"{username}/plantsync/{project_id}/drawings/{drawing_id}/di_result.json"
        _save_json(container, di_path, di_result)

        # Extract title block
        title_block = _extract_title_block(di_result)
        print(f"[PlantSync] Title block extracted: {title_block}", flush=True)
    except Exception as e:
        print(f"[PlantSync] DI analysis failed (non-fatal): {e}", flush=True)

    # Get page count from DI or default to 1
    page_count = len(di_result) if di_result else 1
    # For full page count, analyze all pages
    try:
        if di_result:
            full_result = azure_di_service.analyze_document_from_url(pdf_url)
            page_count = len(full_result) if full_result else 1
    except Exception:
        pass

    now = datetime.now(timezone.utc).isoformat()

    # Check if same drawing_number already exists → add as new revision
    existing_drawing = None
    if title_block.get("drawing_number"):
        for d in meta.get("drawings", []):
            if d.get("drawing_number") == title_block["drawing_number"]:
                existing_drawing = d
                break

    if existing_drawing:
        # Add new revision to existing drawing
        rev_entry = {
            "revision_id": drawing_id,
            "revision": title_block.get("revision", ""),
            "blob_path": blob_path,
            "uploaded_at": now,
            "page_count": page_count,
            "filename": filename,
        }
        existing_drawing["revisions"].append(rev_entry)
        existing_drawing["current_revision"] = title_block.get("revision", existing_drawing.get("current_revision", ""))
        existing_drawing["updated_at"] = now

        drawing_data = existing_drawing
        is_new_revision = True
        print(f"[PlantSync] New revision added to {existing_drawing['drawing_number']}", flush=True)
    else:
        # Create new drawing entry
        drawing_data = {
            "drawing_id": drawing_id,
            "drawing_number": title_block.get("drawing_number", ""),
            "title": title_block.get("title", filename),
            "discipline": title_block.get("discipline", ""),
            "current_revision": title_block.get("revision", "A"),
            "revisions": [{
                "revision_id": drawing_id,
                "revision": title_block.get("revision", "A"),
                "blob_path": blob_path,
                "uploaded_at": now,
                "page_count": page_count,
                "filename": filename,
            }],
            "review_status": _empty_review_status(),
            "em_approval": {"status": "pending"},
            "created_at": now,
            "updated_at": now,
        }
        meta["drawings"].append(drawing_data)
        is_new_revision = False

    meta["updated_at"] = now
    _save_json(container, _meta_path(username, project_id), meta)

    return {
        "status": "success",
        "drawing": drawing_data,
        "title_block": title_block,
        "is_new_revision": is_new_revision,
        "page_count": page_count,
    }


@router.put("/projects/{project_id}/drawings/{drawing_id}/title-block")
async def confirm_title_block(
    project_id: str,
    drawing_id: str,
    req: ConfirmTitleBlockRequest,
    authorization: Optional[str] = Header(None)
):
    username = _get_username(authorization)
    container = _get_container()

    meta = _load_json(container, _meta_path(username, project_id))
    if not meta:
        raise HTTPException(status_code=404, detail="Project not found")

    drawing = None
    for d in meta.get("drawings", []):
        if d["drawing_id"] == drawing_id:
            drawing = d
            break

    if not drawing:
        raise HTTPException(status_code=404, detail="Drawing not found")

    # Check if drawing_number changed → handle re-grouping
    old_number = drawing.get("drawing_number", "")
    new_number = req.drawing_number if req.drawing_number is not None else old_number

    if req.drawing_number is not None:
        drawing["drawing_number"] = req.drawing_number
    if req.title is not None:
        drawing["title"] = req.title
    if req.revision is not None:
        drawing["current_revision"] = req.revision
        # Also update latest revision entry
        if drawing.get("revisions"):
            drawing["revisions"][-1]["revision"] = req.revision
    if req.discipline is not None:
        drawing["discipline"] = req.discipline

    drawing["updated_at"] = datetime.now(timezone.utc).isoformat()
    meta["updated_at"] = drawing["updated_at"]
    _save_json(container, _meta_path(username, project_id), meta)

    return {"status": "success", "drawing": drawing}


@router.get("/projects/{project_id}/drawings/{drawing_id}/pdf-url")
async def get_pdf_url(
    project_id: str,
    drawing_id: str,
    revision_id: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None)
):
    username = _get_username(authorization)
    container = _get_container()

    meta = _load_json(container, _meta_path(username, project_id))
    if not meta:
        raise HTTPException(status_code=404, detail="Project not found")

    drawing = None
    for d in meta.get("drawings", []):
        if d["drawing_id"] == drawing_id:
            drawing = d
            break

    if not drawing:
        raise HTTPException(status_code=404, detail="Drawing not found")

    # Find the revision
    revisions = drawing.get("revisions", [])
    if not revisions:
        raise HTTPException(status_code=404, detail="No revisions found")

    if revision_id:
        rev = next((r for r in revisions if r["revision_id"] == revision_id), None)
    else:
        rev = revisions[-1]  # Latest

    if not rev:
        raise HTTPException(status_code=404, detail="Revision not found")

    from app.services.blob_storage import generate_sas_url
    pdf_url = generate_sas_url(rev["blob_path"])

    return {
        "status": "success",
        "pdf_url": pdf_url,
        "revision": rev,
    }


# ── Markups ──

@router.post("/projects/{project_id}/drawings/{drawing_id}/markups")
async def create_markup(
    project_id: str,
    drawing_id: str,
    req: CreateMarkupRequest,
    authorization: Optional[str] = Header(None)
):
    username = _get_username(authorization)
    container = _get_container()

    # Verify project/drawing exist
    meta = _load_json(container, _meta_path(username, project_id))
    if not meta:
        raise HTTPException(status_code=404, detail="Project not found")

    drawing = next((d for d in meta.get("drawings", []) if d["drawing_id"] == drawing_id), None)
    if not drawing:
        raise HTTPException(status_code=404, detail="Drawing not found")

    # Load or create markups
    markups_bp = _markups_path(username, project_id)
    markups = _load_json(container, markups_bp) or []

    markup_id = str(uuid.uuid4())[:8]
    now = datetime.now(timezone.utc).isoformat()

    markup = {
        "markup_id": markup_id,
        "drawing_id": drawing_id,
        "page": req.page,
        "x": req.x,
        "y": req.y,
        "discipline": req.discipline,
        "comment": req.comment,
        "severity": req.severity or "normal",
        "status": "open",
        "author_name": req.author_name or username,
        "created_at": now,
        "updated_at": now,
        "replies": [],
    }

    markups.append(markup)
    _save_json(container, markups_bp, markups)

    return {"status": "success", "markup": markup}


@router.get("/projects/{project_id}/drawings/{drawing_id}/markups")
async def list_markups(
    project_id: str,
    drawing_id: str,
    page: Optional[int] = Query(None),
    discipline: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None)
):
    username = _get_username(authorization)
    container = _get_container()

    markups_bp = _markups_path(username, project_id)
    markups = _load_json(container, markups_bp) or []

    # Filter by drawing_id
    filtered = [m for m in markups if m.get("drawing_id") == drawing_id]

    if page is not None:
        filtered = [m for m in filtered if m.get("page") == page]
    if discipline:
        filtered = [m for m in filtered if m.get("discipline") == discipline]

    return {"status": "success", "markups": filtered}


@router.patch("/projects/{project_id}/drawings/{drawing_id}/markups/{markup_id}")
async def update_markup(
    project_id: str,
    drawing_id: str,
    markup_id: str,
    req: UpdateMarkupRequest,
    authorization: Optional[str] = Header(None)
):
    username = _get_username(authorization)
    container = _get_container()

    markups_bp = _markups_path(username, project_id)
    markups = _load_json(container, markups_bp) or []

    markup = next((m for m in markups if m["markup_id"] == markup_id), None)
    if not markup:
        raise HTTPException(status_code=404, detail="Markup not found")

    if req.status is not None:
        markup["status"] = req.status
    if req.comment is not None:
        markup["comment"] = req.comment
    markup["updated_at"] = datetime.now(timezone.utc).isoformat()

    _save_json(container, markups_bp, markups)

    return {"status": "success", "markup": markup}


@router.post("/projects/{project_id}/drawings/{drawing_id}/markups/{markup_id}/replies")
async def add_markup_reply(
    project_id: str,
    drawing_id: str,
    markup_id: str,
    req: AddMarkupReplyRequest,
    authorization: Optional[str] = Header(None)
):
    username = _get_username(authorization)
    container = _get_container()

    markups_bp = _markups_path(username, project_id)
    markups = _load_json(container, markups_bp) or []

    markup = next((m for m in markups if m["markup_id"] == markup_id), None)
    if not markup:
        raise HTTPException(status_code=404, detail="Markup not found")

    reply = {
        "reply_id": str(uuid.uuid4())[:8],
        "author_name": req.author_name or username,
        "content": req.content,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    markup.setdefault("replies", []).append(reply)
    markup["updated_at"] = datetime.now(timezone.utc).isoformat()

    _save_json(container, markups_bp, markups)

    return {"status": "success", "reply": reply}


# ── Review Workflow ──

@router.put("/projects/{project_id}/drawings/{drawing_id}/review")
async def update_review_status(
    project_id: str,
    drawing_id: str,
    req: UpdateReviewStatusRequest,
    authorization: Optional[str] = Header(None)
):
    username = _get_username(authorization)
    container = _get_container()

    meta = _load_json(container, _meta_path(username, project_id))
    if not meta:
        raise HTTPException(status_code=404, detail="Project not found")

    drawing = next((d for d in meta.get("drawings", []) if d["drawing_id"] == drawing_id), None)
    if not drawing:
        raise HTTPException(status_code=404, detail="Drawing not found")

    if req.discipline not in DISCIPLINES:
        raise HTTPException(status_code=400, detail=f"Invalid discipline. Must be one of: {DISCIPLINES}")

    review_status = drawing.setdefault("review_status", _empty_review_status())
    now = datetime.now(timezone.utc).isoformat()

    review_status[req.discipline] = {
        "status": req.status,
        "reviewer_name": req.reviewer_name or username,
        "comment": req.comment or "",
        "updated_at": now,
    }

    drawing["updated_at"] = now
    meta["updated_at"] = now
    _save_json(container, _meta_path(username, project_id), meta)

    return {"status": "success", "review_status": review_status}


@router.post("/projects/{project_id}/drawings/{drawing_id}/approve")
async def final_approval(
    project_id: str,
    drawing_id: str,
    req: FinalApprovalRequest,
    authorization: Optional[str] = Header(None)
):
    username = _get_username(authorization)
    container = _get_container()

    meta = _load_json(container, _meta_path(username, project_id))
    if not meta:
        raise HTTPException(status_code=404, detail="Project not found")

    drawing = next((d for d in meta.get("drawings", []) if d["drawing_id"] == drawing_id), None)
    if not drawing:
        raise HTTPException(status_code=404, detail="Drawing not found")

    now = datetime.now(timezone.utc).isoformat()
    drawing["em_approval"] = {
        "status": req.decision,
        "approver_name": req.approver_name or username,
        "comment": req.comment or "",
        "approved_at": now,
    }

    drawing["updated_at"] = now
    meta["updated_at"] = now
    _save_json(container, _meta_path(username, project_id), meta)

    return {"status": "success", "em_approval": drawing["em_approval"]}


# ── Dashboard ──

@router.get("/projects/{project_id}/dashboard")
async def get_dashboard(
    project_id: str,
    authorization: Optional[str] = Header(None)
):
    username = _get_username(authorization)
    container = _get_container()

    meta = _load_json(container, _meta_path(username, project_id))
    if not meta:
        raise HTTPException(status_code=404, detail="Project not found")

    drawings = meta.get("drawings", [])
    markups_bp = _markups_path(username, project_id)
    markups = _load_json(container, markups_bp) or []

    # Compute stats
    total_drawings = len(drawings)
    by_discipline = {}
    review_progress = {d: {"not_started": 0, "in_progress": 0, "completed": 0, "rejected": 0} for d in DISCIPLINES}
    approval_stats = {"pending": 0, "approved": 0, "rejected": 0, "conditionally_approved": 0}

    for d in drawings:
        disc = d.get("discipline", "unknown")
        by_discipline[disc] = by_discipline.get(disc, 0) + 1

        # Review progress
        rs = d.get("review_status", {})
        for discipline_key in DISCIPLINES:
            st = rs.get(discipline_key, {}).get("status", "not_started")
            if st in review_progress[discipline_key]:
                review_progress[discipline_key][st] += 1

        # Approval stats
        ea = d.get("em_approval", {}).get("status", "pending")
        if ea in approval_stats:
            approval_stats[ea] += 1

    # Markup stats
    total_markups = len(markups)
    open_markups = sum(1 for m in markups if m.get("status") == "open")
    resolved_markups = sum(1 for m in markups if m.get("status") == "resolved")
    markups_by_discipline = {}
    for m in markups:
        md = m.get("discipline", "unknown")
        markups_by_discipline[md] = markups_by_discipline.get(md, 0) + 1

    return {
        "status": "success",
        "dashboard": {
            "total_drawings": total_drawings,
            "drawings_by_discipline": by_discipline,
            "review_progress": review_progress,
            "approval_stats": approval_stats,
            "total_markups": total_markups,
            "open_markups": open_markups,
            "resolved_markups": resolved_markups,
            "markups_by_discipline": markups_by_discipline,
        }
    }
