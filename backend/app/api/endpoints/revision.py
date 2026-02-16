"""
Revision Master - API Endpoints

- POST /upload-spec        : Upload spec PDF → DI → GPT → document checklist
- GET  /projects           : List user's projects
- GET  /project/{id}       : Project detail (project.json)
- POST /register-revision  : Upload revision file → DI → index → update project.json
- GET  /revision-history/{project_id}/{doc_id} : Revision history with download URLs
- POST /add-document       : Manually add a document entry
- PUT  /update-document    : Update document metadata
- DELETE /project/{id}     : Delete project
- POST /search             : AI hybrid search
"""

import asyncio
import json
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Header, UploadFile, File, Form, Query
from pydantic import BaseModel
from openai import AzureOpenAI

from app.core.config import settings
from app.core.firebase_admin import verify_id_token
from app.services.revision_search import revision_search_service

logger = logging.getLogger(__name__)
router = APIRouter()

# Phase definitions — based on GMTP-FEED-PR-RPT-013 flow
PHASES = {
    "phase_1": {
        "name": "Pre-Commissioning & MC",
        "name_ko": "사전시운전 / MC",
        "milestones": ["MC (Mechanical Completion)", "PSSR", "RFSU"],
        "description": "Construction completion → Flushing/Pressure test → Punch list → MC → PSSR → RFSU",
    },
    "phase_2": {
        "name": "Commissioning & Testing",
        "name_ko": "시운전 / 시험",
        "milestones": ["FGSO (First Gas Send-Out)", "Unit Function Test", "RRT", "Performance Guarantee Test"],
        "description": "Energizing → Cool-down → FGSO → Unit Function Test → RRT (30 days) → Performance Guarantee Test",
    },
    "phase_3": {
        "name": "Performance & Initial Acceptance",
        "name_ko": "성능인수 / 초기인수",
        "milestones": ["PA (Performance Acceptance)", "IA (Initial Acceptance)", "COD"],
        "description": "Performance Acceptance → Punch/Job Card close-out → As-built → Training → Initial Acceptance → COD",
    },
    "phase_4": {
        "name": "Final Acceptance",
        "name_ko": "최종 인수",
        "milestones": ["FA (Final Acceptance)"],
        "description": "Warranty period obligations → Defect remedy → Final Acceptance Certificate",
    },
}

# Azure OpenAI client for GPT
_openai_client = None
try:
    _openai_client = AzureOpenAI(
        azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
        api_key=settings.AZURE_OPENAI_KEY,
        api_version=settings.AZURE_OPENAI_API_VERSION,
    )
except Exception as e:
    logger.warning(f"OpenAI client init failed: {e}")


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


def _load_project_json(container, blob_path: str) -> dict:
    """Load project.json from blob storage."""
    try:
        blob = container.get_blob_client(blob_path)
        data = blob.download_blob().readall()
        return json.loads(data.decode('utf-8'))
    except Exception as e:
        logger.error(f"Failed to load project.json: {blob_path} - {e}")
        return None


def _save_project_json(container, blob_path: str, project: dict):
    """Save project.json to blob storage."""
    data = json.dumps(project, ensure_ascii=False, indent=2).encode('utf-8')
    container.upload_blob(name=blob_path, data=data, overwrite=True)


def _recalculate_summary(project: dict):
    """Recalculate project summary from documents list."""
    docs = project.get("documents", [])
    summary = {"total": len(docs)}
    for phase_key in PHASES:
        phase_docs = [d for d in docs if d.get("phase") == phase_key]
        counts = {"total": len(phase_docs), "not_started": 0, "in_progress": 0, "approved": 0, "cancelled": 0}
        for d in phase_docs:
            status = d.get("status", "not_started")
            if status in counts:
                counts[status] += 1
        summary[phase_key] = counts
    project["summary"] = summary


def _generate_sas_url(blob_path: str) -> str:
    """Generate SAS URL for a blob."""
    from app.services.blob_storage import generate_sas_url
    return generate_sas_url(blob_path)


# ── Pydantic Models ──

class AddDocumentRequest(BaseModel):
    project_id: str
    doc_no: str = ""
    tag_no: str = ""
    title: str
    phase: str = "phase_1"


class UpdateDocumentRequest(BaseModel):
    project_id: str
    doc_id: str
    doc_no: Optional[str] = None
    tag_no: Optional[str] = None
    title: Optional[str] = None
    phase: Optional[str] = None
    status: Optional[str] = None


class UpdateProjectRequest(BaseModel):
    project_id: str
    project_name: Optional[str] = None
    project_code: Optional[str] = None


class SearchRequest(BaseModel):
    query: str
    project_id: Optional[str] = None
    phase: Optional[str] = None
    mode: Optional[str] = "search"
    history: Optional[List[dict]] = None
    top: Optional[int] = 20


# ── Upload Spec Endpoint ──

@router.post("/upload-spec")
async def upload_spec(
    file: UploadFile = File(...),
    project_name: str = Form(...),
    project_code: str = Form(""),
    authorization: Optional[str] = Header(None)
):
    """Upload spec PDF → Azure DI text extraction → GPT document checklist generation."""
    username = _get_username(authorization)
    filename = file.filename or "spec.pdf"
    project_id = str(uuid.uuid4())

    print(f"[Revision] Upload spec by '{username}': {filename} → project '{project_name}'", flush=True)

    # Read file
    file_content = await file.read()

    # Save spec to blob
    container = _get_container()
    spec_blob_path = f"{username}/revision/{project_id}/spec/{filename}"
    container.upload_blob(name=spec_blob_path, data=file_content, overwrite=True)
    print(f"[Revision] Saved spec to blob: {spec_blob_path}", flush=True)

    # Azure DI text extraction
    extracted_text = ""
    try:
        from app.services.azure_di import azure_di_service
        from app.services.blob_storage import generate_sas_url
        spec_url = generate_sas_url(spec_blob_path)
        di_result = azure_di_service.analyze_document_from_url(spec_url)
        extracted_text = "\n\n".join([p.get("content", "") for p in di_result])
        print(f"[Revision] DI extracted {len(extracted_text)} chars from spec", flush=True)
    except Exception as e:
        print(f"[Revision] DI extraction failed (will use GPT with filename only): {e}", flush=True)

    # GPT: Extract document checklist from spec
    documents = []
    try:
        documents = _extract_documents_from_spec(extracted_text, project_code, project_name)
        print(f"[Revision] GPT extracted {len(documents)} documents from spec", flush=True)
    except Exception as e:
        print(f"[Revision] GPT extraction failed: {e}", flush=True)

    # Ensure minimum EPC standard documents
    if len(documents) < 20:
        documents = _ensure_standard_documents(documents, project_code)

    # Build project.json
    project = {
        "project_id": project_id,
        "project_name": project_name,
        "project_code": project_code,
        "spec_filename": filename,
        "spec_blob_path": spec_blob_path,
        "created_by": username,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "phases": PHASES,
        "documents": documents,
        "summary": {},
    }
    _recalculate_summary(project)

    # Save project.json
    project_json_path = f"{username}/revision/{project_id}/project.json"
    _save_project_json(container, project_json_path, project)
    print(f"[Revision] Saved project.json: {project_json_path}", flush=True)

    return {
        "status": "success",
        "project_id": project_id,
        "project_name": project_name,
        "documents_count": len(documents),
        "summary": project["summary"],
    }


# ── Re-analyze Spec (merge with existing documents) ──

@router.post("/reanalyze-spec")
async def reanalyze_spec(
    project_id: str = Form(...),
    file: Optional[UploadFile] = File(None),
    authorization: Optional[str] = Header(None)
):
    """Re-analyze spec PDF and merge with existing documents.
    - If file is provided, use new spec; otherwise re-analyze existing spec.
    - Merge: match by title → fill empty doc_no, add new docs, preserve revisions.
    """
    username = _get_username(authorization)
    container = _get_container()

    # Load existing project
    json_path = f"{username}/revision/{project_id}/project.json"
    project = _load_project_json(container, json_path)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_code = project.get("project_code", "")
    project_name = project.get("project_name", "")

    print(f"[Revision] Re-analyze spec for project '{project_name}' ({project_id})", flush=True)

    # Determine spec source: new upload or existing blob
    spec_blob_path = project.get("spec_blob_path", "")
    if file and file.filename:
        # New spec uploaded — save to blob
        file_content = await file.read()
        filename = file.filename
        spec_blob_path = f"{username}/revision/{project_id}/spec/{filename}"
        container.upload_blob(name=spec_blob_path, data=file_content, overwrite=True)
        project["spec_filename"] = filename
        project["spec_blob_path"] = spec_blob_path
        print(f"[Revision] New spec uploaded: {spec_blob_path}", flush=True)

    if not spec_blob_path:
        raise HTTPException(status_code=400, detail="No spec file found for this project")

    # Azure DI text extraction
    extracted_text = ""
    try:
        from app.services.azure_di import azure_di_service
        from app.services.blob_storage import generate_sas_url
        spec_url = generate_sas_url(spec_blob_path)
        di_result = azure_di_service.analyze_document_from_url(spec_url)
        extracted_text = "\n\n".join([p.get("content", "") for p in di_result])
        print(f"[Revision] DI extracted {len(extracted_text)} chars from spec", flush=True)
    except Exception as e:
        print(f"[Revision] DI extraction failed: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"Document analysis failed: {e}")

    # GPT extraction with improved prompt
    new_docs = []
    try:
        new_docs = _extract_documents_from_spec(extracted_text, project_code, project_name)
        print(f"[Revision] GPT re-extracted {len(new_docs)} documents", flush=True)
    except Exception as e:
        print(f"[Revision] GPT extraction failed: {e}", flush=True)

    if len(new_docs) < 20:
        new_docs = _ensure_standard_documents(new_docs, project_code)

    # === Merge Logic ===
    existing_docs = project.get("documents", [])
    merged_count = {"updated": 0, "added": 0, "kept": 0}

    # Build lookup by normalized title
    def _normalize(title: str) -> str:
        return title.strip().lower().replace("  ", " ")

    existing_by_title = {}
    for doc in existing_docs:
        key = _normalize(doc.get("title", ""))
        if key:
            existing_by_title[key] = doc

    matched_existing_keys = set()

    for new_doc in new_docs:
        new_title_key = _normalize(new_doc.get("title", ""))
        if not new_title_key:
            continue

        if new_title_key in existing_by_title:
            # Match found — update empty fields only
            ex = existing_by_title[new_title_key]
            matched_existing_keys.add(new_title_key)
            updated = False
            if (not ex.get("doc_no") or ex["doc_no"].strip() in ("", "-")) and new_doc.get("doc_no"):
                ex["doc_no"] = new_doc["doc_no"]
                updated = True
            if (not ex.get("tag_no") or ex["tag_no"].strip() in ("", "-")) and new_doc.get("tag_no"):
                ex["tag_no"] = new_doc["tag_no"]
                updated = True
            if updated:
                merged_count["updated"] += 1
            else:
                merged_count["kept"] += 1
        else:
            # New document — add to list
            existing_docs.append(new_doc)
            merged_count["added"] += 1

    # Auto-fill any remaining empty doc_no
    _auto_fill_doc_no(existing_docs, project_code)

    project["documents"] = existing_docs
    _recalculate_summary(project)
    _save_project_json(container, json_path, project)

    print(f"[Revision] Merge complete: {merged_count}", flush=True)

    return {
        "status": "success",
        "project_id": project_id,
        "documents_count": len(existing_docs),
        "merge_result": merged_count,
        "summary": project["summary"],
    }


def _extract_documents_from_spec(spec_text: str, project_code: str, project_name: str) -> list:
    """Use GPT to extract required document checklist from spec text."""
    if not _openai_client:
        return []

    # Truncate spec text if too long
    if len(spec_text) > 60000:
        spec_text = spec_text[:60000] + "\n...(truncated)"

    prompt = f"""당신은 EPCC 프로젝트 Pre-Commissioning/Commissioning/Acceptance 전문가입니다.
아래 사양서(Specification) 내용을 분석하여 4단계 Phase별 필요 문서/성적서/인증서 목록을 JSON으로 추출하세요.

프로젝트 코드: {project_code}
프로젝트명: {project_name}

Phase 정의 (EPCC 준공 프로세스 기준):
- phase_1: Pre-Commissioning & MC — 배관 플러싱/세정/건조, 수압시험, 기밀시험, 계기루프시험, 케이블시험, 장비정렬, 펀치리스트(A/B/C), System Completion Manual, P&ID 워크다운, MC 인증서, PSSR, RFSU 인증서
- phase_2: Commissioning & Testing — 유틸리티 시운전, 냉각(Cool-down), FGSO(First Gas Send-Out), 단독운전(Unit Function Test), 연동시험, 신뢰성시험(RRT 30일), 성능보증시험(Performance Guarantee Test), 일일보고서
- phase_3: Performance & Initial Acceptance — 성능인수 인증서, 펀치/Job Card 클로즈아웃, As-Built 도면, 운전매뉴얼, 교육기록, 예비품목록(3년), 정부허가, 초기인수 인증서
- phase_4: Final Acceptance — 보증기간 의무이행, 결함시정, 최종인수 인증서

추출 규칙:
1. 사양서에 명시된 모든 제출문서(deliverables)를 빠짐없이 추출
2. 각 System별 반복 문서는 대표 1건으로 추출 (예: "System Completion Manual (per system)")
3. 장비별 시험성적서는 장비 tag_no 포함 (사양서에 언급된 경우)
4. 최소 30개 이상 문서 추출
5. 사양서에 없더라도 EPCC 표준 문서 포함:
   - Inspection & Testing Plan, Check Sheet/Log Sheet
   - Marked-up P&IDs (System isolation)
   - Vendor Attendance Schedule
   - Commissioning Execution Plan
   - Emergency Response Plan
   - Interface Procedures
   - Consumables List
   - Commissioning Spare Parts List
   - Job Card Form / Job Card Item List

문서번호(doc_no) 규칙 — 반드시 모든 문서에 doc_no를 부여하세요:
1. 사양서에 문서번호가 명시된 경우 그대로 사용 (예: GMTP-FEED-PR-RPT-013)
2. 사양서에 문서번호가 없는 경우, 아래 분류별 접두어 + 순번으로 자동 생성:
   - 계획서/절차서: {project_code}-CMS-PRC-NNN (Commissioning Procedure)
   - 스케줄: {project_code}-CMS-SCH-NNN (Schedule)
   - 시험성적서/보고서: {project_code}-CMS-RPT-NNN (Report)
   - 인증서: {project_code}-CMS-CRT-NNN (Certificate)
   - 목록/리스트: {project_code}-CMS-LST-NNN (List)
   - 매뉴얼/교육: {project_code}-CMS-MNL-NNN (Manual)
   - 기타: {project_code}-CMS-DOC-NNN (Document)
3. NNN은 001부터 순번 (같은 접두어 내에서 순서대로)

태그번호(tag_no) 규칙:
1. 장비별 시험/성적서에만 해당 장비 tag_no 기입 (예: P-1001A, V-2001)
2. 일반 문서(계획서, 스케줄, 인증서 등)는 tag_no를 빈 문자열("")로 설정

반드시 아래 JSON 형식으로 응답하세요:
{{"documents": [{{"doc_no": "문서번호", "tag_no": "태그번호 또는 빈문자열", "title": "문서제목", "phase": "phase_1"}}]}}

사양서 내용:
{spec_text}"""

    try:
        response = _openai_client.chat.completions.create(
            model=settings.AZURE_OPENAI_DEPLOYMENT_NAME,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0.2,
        )
        raw = response.choices[0].message.content
        data = json.loads(raw)
        docs_raw = data.get("documents", [])

        documents = []
        for d in docs_raw:
            documents.append({
                "doc_id": str(uuid.uuid4()),
                "doc_no": d.get("doc_no", ""),
                "tag_no": d.get("tag_no", ""),
                "title": d.get("title", ""),
                "phase": d.get("phase", "phase_1"),
                "status": "not_started",
                "latest_revision": "-",
                "latest_date": "",
                "revisions": [],
            })

        # Post-process: auto-fill empty doc_no
        _auto_fill_doc_no(documents, project_code)
        return documents
    except Exception as e:
        logger.error(f"GPT extraction failed: {e}")
        return []


def _auto_fill_doc_no(documents: list, project_code: str):
    """Auto-fill empty doc_no for documents that GPT didn't assign a number."""
    prefix = project_code or "DOC"

    # Classify document by title keywords → category prefix
    def _classify(title: str) -> str:
        t = title.lower()
        if any(k in t for k in ["certificate", "인증서", "acceptance"]):
            return "CRT"
        if any(k in t for k in ["schedule", "스케줄", "일정"]):
            return "SCH"
        if any(k in t for k in ["plan", "procedure", "계획", "절차"]):
            return "PRC"
        if any(k in t for k in ["list", "목록", "리스트", "inventory"]):
            return "LST"
        if any(k in t for k in ["manual", "training", "매뉴얼", "교육"]):
            return "MNL"
        if any(k in t for k in ["report", "test", "record", "보고", "시험", "성적", "check"]):
            return "RPT"
        return "DOC"

    # Count existing numbers per category to avoid collision
    cat_counters = {}
    for doc in documents:
        if doc.get("doc_no"):
            # Parse existing number to track used indices
            parts = doc["doc_no"].split("-")
            if len(parts) >= 4 and parts[-1].isdigit():
                cat_key = parts[-2] if len(parts) >= 3 else "DOC"
                cat_counters[cat_key] = max(cat_counters.get(cat_key, 0), int(parts[-1]))

    # Fill empty doc_no
    for doc in documents:
        if not doc.get("doc_no") or doc["doc_no"].strip() in ("", "-"):
            cat = _classify(doc.get("title", ""))
            cat_counters[cat] = cat_counters.get(cat, 0) + 1
            doc["doc_no"] = f"{prefix}-CMS-{cat}-{cat_counters[cat]:03d}"


def _ensure_standard_documents(documents: list, project_code: str) -> list:
    """Add standard EPC documents if not enough were extracted."""
    existing_titles = {d.get("title", "").lower() for d in documents}

    standard_docs = [
        # Phase 1: Pre-Commissioning & MC
        {"title": "Commissioning Execution Plan", "phase": "phase_1"},
        {"title": "System Definition & Isolation (Marked-up P&IDs)", "phase": "phase_1"},
        {"title": "Inspection & Testing Plan (per System)", "phase": "phase_1"},
        {"title": "Equipment List (per System)", "phase": "phase_1"},
        {"title": "Piping Flushing / Cleaning / Drying Report", "phase": "phase_1"},
        {"title": "Hydrostatic Pressure Test Report", "phase": "phase_1"},
        {"title": "Pneumatic / Tightness Test Report", "phase": "phase_1"},
        {"title": "Instrument Loop Test Report", "phase": "phase_1"},
        {"title": "Cable Continuity / Megger Test Report", "phase": "phase_1"},
        {"title": "Equipment Alignment Report", "phase": "phase_1"},
        {"title": "Motor Solo Run Test Report", "phase": "phase_1"},
        {"title": "Punch List (Category A/B/C)", "phase": "phase_1"},
        {"title": "System Completion Manual (per System)", "phase": "phase_1"},
        {"title": "Integrated Systems Completion Schedule", "phase": "phase_1"},
        {"title": "P&ID Walk-down Report", "phase": "phase_1"},
        {"title": "Certificate of Mechanical Completion (MC)", "phase": "phase_1"},
        {"title": "PSSR (Pre-Start-up Safety Review) Report", "phase": "phase_1"},
        {"title": "Certificate of RFSU (Ready For Start-Up)", "phase": "phase_1"},
        # Phase 2: Commissioning & Testing
        {"title": "Detailed Commissioning Schedule", "phase": "phase_2"},
        {"title": "Commissioning & Testing Procedures", "phase": "phase_2"},
        {"title": "Consumables List for Commissioning", "phase": "phase_2"},
        {"title": "Commissioning Spare Parts & Special Tools List", "phase": "phase_2"},
        {"title": "Vendor Attendance Schedule", "phase": "phase_2"},
        {"title": "Emergency Response Plan for Commissioning", "phase": "phase_2"},
        {"title": "Interface Procedures (Commissioning/Construction/Operation)", "phase": "phase_2"},
        {"title": "Commissioning Daily Report", "phase": "phase_2"},
        {"title": "Unit Function Test Report (per Equipment)", "phase": "phase_2"},
        {"title": "Safety Valve Test Report", "phase": "phase_2"},
        {"title": "DCS/ESD Functional Test Report", "phase": "phase_2"},
        {"title": "Fire & Gas Detection System Test Report", "phase": "phase_2"},
        {"title": "Control Valve Calibration Report", "phase": "phase_2"},
        {"title": "Reliability Run Test (RRT) Report - 30 Days", "phase": "phase_2"},
        {"title": "Performance Guarantee Test Procedures", "phase": "phase_2"},
        {"title": "Performance Guarantee Test Report", "phase": "phase_2"},
        {"title": "Job Card Form / Job Card Item List", "phase": "phase_2"},
        # Phase 3: Performance & Initial Acceptance
        {"title": "Certificate of Performance Acceptance", "phase": "phase_3"},
        {"title": "Punch List Close-out Report", "phase": "phase_3"},
        {"title": "Job Card Close-out Report", "phase": "phase_3"},
        {"title": "Operating Manual (incl. Vendor Manuals)", "phase": "phase_3"},
        {"title": "Maintenance Manual", "phase": "phase_3"},
        {"title": "Training Records & Course Materials", "phase": "phase_3"},
        {"title": "Recommended Spare Parts List (3 Years)", "phase": "phase_3"},
        {"title": "As-Built Drawing Package", "phase": "phase_3"},
        {"title": "Government Permits & Approvals", "phase": "phase_3"},
        {"title": "Certificate of Initial Acceptance (IA)", "phase": "phase_3"},
        # Phase 4: Final Acceptance
        {"title": "Warranty Obligation Completion Report", "phase": "phase_4"},
        {"title": "Defect Remedy Report (Warranty Period)", "phase": "phase_4"},
        {"title": "Certificate of Final Acceptance (FA)", "phase": "phase_4"},
    ]

    for sd in standard_docs:
        if sd["title"].lower() not in existing_titles:
            documents.append({
                "doc_id": str(uuid.uuid4()),
                "doc_no": "",  # Will be auto-filled below
                "tag_no": "",
                "title": sd["title"],
                "phase": sd["phase"],
                "status": "not_started",
                "latest_revision": "-",
                "latest_date": "",
                "revisions": [],
            })

    # Auto-fill empty doc_no for all documents (including newly added standard docs)
    _auto_fill_doc_no(documents, project_code)
    return documents


# ── Projects List ──

@router.get("/projects")
async def list_projects(
    authorization: Optional[str] = Header(None)
):
    """List all projects for the current user."""
    username = _get_username(authorization)
    container = _get_container()

    projects = []
    prefix = f"{username}/revision/"
    try:
        blobs = container.list_blobs(name_starts_with=prefix)
        project_ids = set()
        for blob in blobs:
            # Extract project_id from path: {user}/revision/{project_id}/...
            parts = blob.name.split('/')
            if len(parts) >= 3:
                pid = parts[2]
                if pid not in project_ids:
                    project_ids.add(pid)

        for pid in sorted(project_ids):
            json_path = f"{username}/revision/{pid}/project.json"
            project = _load_project_json(container, json_path)
            if project:
                projects.append({
                    "project_id": project.get("project_id", pid),
                    "project_name": project.get("project_name", ""),
                    "project_code": project.get("project_code", ""),
                    "created_at": project.get("created_at", ""),
                    "summary": project.get("summary", {}),
                })
    except Exception as e:
        logger.error(f"List projects failed: {e}")

    return {"projects": projects, "username": username}


# ── Project Detail ──

@router.get("/project/{project_id}")
async def get_project(
    project_id: str,
    authorization: Optional[str] = Header(None)
):
    """Get full project detail (project.json)."""
    username = _get_username(authorization)
    container = _get_container()

    json_path = f"{username}/revision/{project_id}/project.json"
    project = _load_project_json(container, json_path)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    return project


# ── Analyze Revision File (auto-detect revision & change description) ──

@router.post("/analyze-revision-file")
async def analyze_revision_file(
    file: UploadFile = File(...),
    project_id: str = Form(...),
    doc_id: str = Form(...),
    authorization: Optional[str] = Header(None)
):
    """Upload file → DI extract → GPT analyze → suggest revision number & change description."""
    username = _get_username(authorization)
    container = _get_container()

    # Load project and find document
    json_path = f"{username}/revision/{project_id}/project.json"
    project = _load_project_json(container, json_path)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    doc = None
    for d in project.get("documents", []):
        if d["doc_id"] == doc_id:
            doc = d
            break
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    print(f"[Revision] Analyzing revision file for doc '{doc.get('title')}'", flush=True)

    # Save file temporarily to blob for DI analysis
    file_content = await file.read()
    filename = file.filename or "document.pdf"
    temp_blob_path = f"{username}/revision/{project_id}/docs/{doc_id}/temp_{filename}"
    container.upload_blob(name=temp_blob_path, data=file_content, overwrite=True)

    # Azure DI text extraction
    extracted_text = ""
    try:
        from app.services.azure_di import azure_di_service
        from app.services.blob_storage import generate_sas_url
        file_url = generate_sas_url(temp_blob_path)
        di_result = azure_di_service.analyze_document_from_url(file_url)
        extracted_text = "\n\n".join([p.get("content", "") for p in di_result])
        print(f"[Revision] DI extracted {len(extracted_text)} chars for analysis", flush=True)
    except Exception as e:
        print(f"[Revision] DI extraction failed: {e}", flush=True)
        # Clean up temp file
        try:
            container.delete_blob(temp_blob_path)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Document analysis failed: {e}")

    # Clean up temp blob
    try:
        container.delete_blob(temp_blob_path)
    except Exception:
        pass

    # Determine next revision number from existing history
    existing_revs = [r.get("revision", "") for r in doc.get("revisions", [])]
    suggested_revision = _suggest_next_revision(existing_revs)

    # Get previous revision's content summary for comparison
    prev_summary = ""
    if existing_revs:
        last_rev = doc["revisions"][-1]
        prev_desc = last_rev.get("change_description", "")
        prev_rev = last_rev.get("revision", "")
        prev_summary = f"이전 리비전: {prev_rev}, 변경내용: {prev_desc}" if prev_desc else f"이전 리비전: {prev_rev}"

    # GPT: Analyze document and generate change description
    suggested_description = ""
    detected_revision = ""
    try:
        if _openai_client and extracted_text:
            doc_text = extracted_text[:30000] if len(extracted_text) > 30000 else extracted_text
            gpt_prompt = f"""당신은 EPC 프로젝트 준공도서 리비전 관리 전문가입니다.
아래 문서를 분석하여 리비전 정보를 추출하세요.

문서 제목: {doc.get('title', '')}
문서번호: {doc.get('doc_no', '')}
{prev_summary}

분석할 내용:
1. 문서에서 리비전 번호를 찾으세요 (예: Rev.A, Rev.0, Rev.1, Revision A 등)
2. 문서의 핵심 내용을 1-2문장으로 요약하세요
3. 이전 리비전이 있는 경우, 주요 변경사항을 추론하세요

반드시 아래 JSON 형식으로 응답하세요:
{{"detected_revision": "문서에서 발견한 리비전 번호 (없으면 빈 문자열)", "description": "문서 내용 요약 또는 변경사항 (한국어, 1-2문장)"}}

문서 내용:
{doc_text}"""

            response = _openai_client.chat.completions.create(
                model=settings.AZURE_OPENAI_DEPLOYMENT_NAME,
                messages=[{"role": "user", "content": gpt_prompt}],
                response_format={"type": "json_object"},
                temperature=0.2,
            )
            result = json.loads(response.choices[0].message.content)
            detected_revision = result.get("detected_revision", "")
            suggested_description = result.get("description", "")
            print(f"[Revision] GPT detected rev='{detected_revision}', desc='{suggested_description[:50]}'", flush=True)
    except Exception as e:
        print(f"[Revision] GPT analysis failed: {e}", flush=True)

    # Use detected revision if available, otherwise use calculated suggestion
    final_revision = detected_revision if detected_revision else suggested_revision

    return {
        "suggested_revision": final_revision,
        "suggested_description": suggested_description,
        "detected_from_document": bool(detected_revision),
        "extracted_text_length": len(extracted_text),
    }


def _suggest_next_revision(existing_revs: list) -> str:
    """Suggest next revision number based on existing revision history."""
    if not existing_revs:
        return "Rev.A"

    last = existing_revs[-1].upper().replace("REV.", "").replace("REV ", "").strip()

    # If last was a letter (A, B, C...) → suggest next letter or Rev.0
    if len(last) == 1 and last.isalpha() and last in "ABCDEFGHIJKLMNOPQRSTUVWXY":
        # If it's a late draft letter, suggest Rev.0 (formal issue)
        if last >= "B":
            return "Rev.0"
        return f"Rev.{chr(ord(last) + 1)}"

    # If last was a number → suggest next number
    if last.isdigit():
        return f"Rev.{int(last) + 1}"

    return "Rev.A"


# ── DI Page-level Helpers ──

async def _extract_pages_with_di(blob_path: str) -> list:
    """Extract pages from a document using Azure DI.
    Tries full analysis first, falls back to chunked processing for large docs.
    Returns list of page dicts from Azure DI (each with page_number, content, etc.)
    """
    from app.services.azure_di import azure_di_service
    from app.services.blob_storage import generate_sas_url

    file_url = generate_sas_url(blob_path)
    loop = asyncio.get_event_loop()

    try:
        # Try full document analysis (works for most docs, up to ~500 pages)
        di_result = await loop.run_in_executor(
            None,
            lambda: azure_di_service.analyze_document_from_url(file_url)
        )
        print(f"[Revision] Full DI analysis: {len(di_result)} pages extracted", flush=True)
        return di_result
    except Exception as e:
        error_msg = str(e).lower()
        # If timeout or size issue, try chunked processing
        if any(k in error_msg for k in ["timeout", "timed out", "too large", "413", "exceeded"]):
            print(f"[Revision] Full DI timed out, switching to chunked processing: {e}", flush=True)
            return await _chunked_di_extraction(file_url)
        raise


async def _chunked_di_extraction(file_url: str) -> list:
    """Process large document in chunks (100 pages per chunk) when full DI times out."""
    from app.services.azure_di import azure_di_service

    loop = asyncio.get_event_loop()
    all_pages = []
    chunk_size = 100
    start_page = 1
    max_pages = 5000  # Safety limit

    while start_page < max_pages:
        end_page = start_page + chunk_size - 1
        page_range = f"{start_page}-{end_page}"

        try:
            chunk_result = await loop.run_in_executor(
                None,
                lambda pr=page_range: azure_di_service.analyze_document_from_url(file_url, pages=pr)
            )

            if not chunk_result:
                break

            all_pages.extend(chunk_result)
            print(f"[Revision] Chunk {page_range}: {len(chunk_result)} pages extracted", flush=True)

            # If fewer pages than requested, we've reached the end
            if len(chunk_result) < chunk_size:
                break

            start_page = end_page + 1
        except Exception as e:
            print(f"[Revision] Chunk {page_range} failed: {e}", flush=True)
            break

    print(f"[Revision] Chunked DI complete: {len(all_pages)} total pages", flush=True)
    return all_pages


def _save_page_jsons(container, di_folder_path: str, pages: list, doc_meta: dict, revision: str):
    """Save DI results as individual page JSON files + meta.json."""
    if not pages:
        return

    def _upload_page(page_data, page_num):
        page_blob = f"{di_folder_path}page_{page_num}.json"
        data = json.dumps(page_data, ensure_ascii=False).encode('utf-8')
        container.upload_blob(name=page_blob, data=data, overwrite=True)
        return page_num

    # Parallel upload (10 workers)
    uploaded = []
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {}
        for page in pages:
            pn = page.get("page_number", 1)
            futures[executor.submit(_upload_page, page, pn)] = pn

        for future in as_completed(futures):
            try:
                uploaded.append(future.result())
            except Exception as e:
                logger.warning(f"Page JSON upload failed: {e}")

    # Save meta.json
    meta = {
        "total_pages": len(pages),
        "pages": sorted(uploaded),
        "doc_id": doc_meta.get("doc_id", ""),
        "doc_no": doc_meta.get("doc_no", ""),
        "title": doc_meta.get("title", ""),
        "revision": revision,
        "format": "split",
        "version": 2,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
    }
    meta_blob = f"{di_folder_path}meta.json"
    container.upload_blob(
        name=meta_blob,
        data=json.dumps(meta, ensure_ascii=False).encode('utf-8'),
        overwrite=True
    )
    print(f"[Revision] Saved {len(uploaded)} page JSONs + meta.json to {di_folder_path}", flush=True)


# ── Register Revision ──

@router.post("/register-revision")
async def register_revision(
    file: UploadFile = File(...),
    project_id: str = Form(...),
    doc_id: str = Form(...),
    revision: str = Form(...),
    change_description: str = Form(""),
    engineer_name: str = Form(""),
    authorization: Optional[str] = Header(None)
):
    """Upload a revision file → DI (page-level) → index → update project.json."""
    username = _get_username(authorization)
    filename = file.filename or "document.pdf"

    print(f"[Revision] Register revision by '{username}': {revision} for doc {doc_id}", flush=True)

    # Read file
    file_content = await file.read()

    # Load project.json
    container = _get_container()
    json_path = f"{username}/revision/{project_id}/project.json"
    project = _load_project_json(container, json_path)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Find document in project
    doc = None
    for d in project.get("documents", []):
        if d["doc_id"] == doc_id:
            doc = d
            break
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found in project")

    # Save file to blob
    rev_filename = f"{revision}_{filename}"
    blob_path = f"{username}/revision/{project_id}/docs/{doc_id}/{rev_filename}"
    container.upload_blob(name=blob_path, data=file_content, overwrite=True)
    print(f"[Revision] Saved revision file: {blob_path}", flush=True)

    # Azure DI page-level extraction (with chunked fallback for large docs)
    di_pages = []
    di_folder_path = ""
    total_pages = 0
    full_text = ""

    try:
        di_pages = await _extract_pages_with_di(blob_path)
        total_pages = len(di_pages)
        full_text = "\n\n".join([p.get("content", "") for p in di_pages])
        print(f"[Revision] DI extracted {total_pages} pages, {len(full_text)} chars total", flush=True)

        # Save page-level JSONs to blob
        di_folder_path = f"{username}/revision/{project_id}/docs/{doc_id}/{revision}_di/"
        _save_page_jsons(container, di_folder_path, di_pages, {
            "doc_id": doc_id,
            "doc_no": doc.get("doc_no", ""),
            "title": doc.get("title", ""),
        }, revision)
    except Exception as e:
        print(f"[Revision] DI extraction failed (non-fatal): {e}", flush=True)

    # Index pages in Azure AI Search (page-level embedding + indexing)
    phase_name = PHASES.get(doc.get("phase", ""), {}).get("name", "")
    try:
        if di_pages:
            pages_for_index = [
                {"page_number": p.get("page_number", i + 1), "content": p.get("content", "")}
                for i, p in enumerate(di_pages)
            ]
            metadata = {
                "project_id": project_id,
                "project_name": project.get("project_name", ""),
                "doc_id": doc_id,
                "doc_no": doc.get("doc_no", ""),
                "tag_no": doc.get("tag_no", ""),
                "title": doc.get("title", ""),
                "phase": doc.get("phase", ""),
                "phase_name": phase_name,
                "revision": revision,
                "engineer_name": engineer_name,
                "revision_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                "change_description": change_description,
                "blob_path": blob_path,
                "username": username,
            }
            indexed = revision_search_service.index_revision_pages(pages_for_index, metadata)
            print(f"[Revision] Indexed {indexed}/{total_pages} pages", flush=True)
    except Exception as e:
        print(f"[Revision] Search indexing failed (non-fatal): {e}", flush=True)

    # Update project.json
    now = datetime.now(timezone.utc)
    revision_entry = {
        "revision_id": str(uuid.uuid4()),
        "revision": revision,
        "change_description": change_description,
        "engineer_name": engineer_name,
        "date": now.strftime("%Y-%m-%d"),
        "blob_path": blob_path,
        "filename": rev_filename,
        "di_folder_path": di_folder_path,
        "total_pages": total_pages,
        "text_length": len(full_text),
        "uploaded_at": now.isoformat(),
    }
    doc["revisions"].append(revision_entry)
    doc["latest_revision"] = revision
    doc["latest_date"] = now.strftime("%Y-%m-%d")

    # Update status based on revision naming
    rev_upper = revision.upper()
    if rev_upper.startswith("REV.") or rev_upper.startswith("REV "):
        rev_num = rev_upper.replace("REV.", "").replace("REV ", "").strip()
    else:
        rev_num = rev_upper

    if rev_num.startswith("Z"):
        doc["status"] = "cancelled"
    elif rev_num.isdigit() and int(rev_num) >= 0:
        doc["status"] = "approved"
    elif rev_num.isalpha() and rev_num.upper() in "ABCDEFGHIJKLMNOPQRSTUVWXY":
        doc["status"] = "in_progress"
    else:
        doc["status"] = "in_progress"

    _recalculate_summary(project)
    _save_project_json(container, json_path, project)

    return {
        "status": "success",
        "revision": revision,
        "doc_id": doc_id,
        "doc_status": doc["status"],
        "total_pages": total_pages,
        "summary": project["summary"],
    }


# ── Revision History ──

@router.get("/revision-history/{project_id}/{doc_id}")
async def get_revision_history(
    project_id: str,
    doc_id: str,
    authorization: Optional[str] = Header(None)
):
    """Get revision history for a document, with download URLs."""
    username = _get_username(authorization)
    container = _get_container()

    json_path = f"{username}/revision/{project_id}/project.json"
    project = _load_project_json(container, json_path)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    doc = None
    for d in project.get("documents", []):
        if d["doc_id"] == doc_id:
            doc = d
            break
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Add download URLs to each revision
    revisions_with_urls = []
    for rev in doc.get("revisions", []):
        rev_copy = dict(rev)
        if rev.get("blob_path"):
            try:
                rev_copy["download_url"] = _generate_sas_url(rev["blob_path"])
            except Exception:
                rev_copy["download_url"] = ""
        revisions_with_urls.append(rev_copy)

    return {
        "doc_id": doc_id,
        "doc_no": doc.get("doc_no", ""),
        "title": doc.get("title", ""),
        "status": doc.get("status", ""),
        "revisions": revisions_with_urls,
    }


# ── Update Revision ──

class UpdateRevisionRequest(BaseModel):
    project_id: str
    doc_id: str
    revision_id: str
    revision: Optional[str] = None
    change_description: Optional[str] = None
    engineer_name: Optional[str] = None


@router.put("/update-revision")
async def update_revision(
    request: UpdateRevisionRequest,
    authorization: Optional[str] = Header(None)
):
    """Update revision metadata (revision number, description, engineer)."""
    username = _get_username(authorization)
    container = _get_container()

    json_path = f"{username}/revision/{request.project_id}/project.json"
    project = _load_project_json(container, json_path)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    doc = None
    for d in project.get("documents", []):
        if d["doc_id"] == request.doc_id:
            doc = d
            break
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    rev = None
    for r in doc.get("revisions", []):
        if r["revision_id"] == request.revision_id:
            rev = r
            break
    if not rev:
        raise HTTPException(status_code=404, detail="Revision not found")

    if request.revision is not None:
        rev["revision"] = request.revision
    if request.change_description is not None:
        rev["change_description"] = request.change_description
    if request.engineer_name is not None:
        rev["engineer_name"] = request.engineer_name

    # Update latest_revision on doc if this is the last revision
    if doc["revisions"] and doc["revisions"][-1]["revision_id"] == request.revision_id:
        doc["latest_revision"] = rev["revision"]
        # Recalculate status from revision name
        rev_upper = rev["revision"].upper().replace("REV.", "").replace("REV ", "").strip()
        if rev_upper.startswith("Z"):
            doc["status"] = "cancelled"
        elif rev_upper.isdigit() and int(rev_upper) >= 0:
            doc["status"] = "approved"
        elif rev_upper.isalpha() and rev_upper in "ABCDEFGHIJKLMNOPQRSTUVWXY":
            doc["status"] = "in_progress"

    _recalculate_summary(project)
    _save_project_json(container, json_path, project)

    return {"status": "success", "summary": project["summary"]}


# ── Compare Revisions (AI) ──

class CompareRevisionsRequest(BaseModel):
    project_id: str
    doc_id: str
    revision_id_a: str
    revision_id_b: str


@router.post("/compare-revisions")
async def compare_revisions(
    request: CompareRevisionsRequest,
    authorization: Optional[str] = Header(None)
):
    """AI-powered comparison between two revisions using indexed content."""
    username = _get_username(authorization)
    container = _get_container()

    json_path = f"{username}/revision/{request.project_id}/project.json"
    project = _load_project_json(container, json_path)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    doc = None
    for d in project.get("documents", []):
        if d["doc_id"] == request.doc_id:
            doc = d
            break
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Find both revisions
    rev_a = rev_b = None
    for r in doc.get("revisions", []):
        if r["revision_id"] == request.revision_id_a:
            rev_a = r
        if r["revision_id"] == request.revision_id_b:
            rev_b = r
    if not rev_a or not rev_b:
        raise HTTPException(status_code=404, detail="Revision not found")

    print(f"[Revision] Comparing {rev_a['revision']} vs {rev_b['revision']} for doc {doc.get('doc_no')}", flush=True)

    # Extract text: prefer saved DI results (page-level or legacy), fallback to live DI extraction
    text_a = _load_di_text(
        container,
        di_json_path=rev_a.get("di_json_path", ""),
        di_folder_path=rev_a.get("di_folder_path", ""),
    ) or await _extract_text_from_blob(rev_a.get("blob_path", ""))
    text_b = _load_di_text(
        container,
        di_json_path=rev_b.get("di_json_path", ""),
        di_folder_path=rev_b.get("di_folder_path", ""),
    ) or await _extract_text_from_blob(rev_b.get("blob_path", ""))

    if not text_a and not text_b:
        return {"comparison": "두 리비전 모두 텍스트를 추출할 수 없습니다.", "rev_a": rev_a["revision"], "rev_b": rev_b["revision"]}

    # Truncate for GPT context
    max_len = 25000
    text_a_trunc = text_a[:max_len] if len(text_a) > max_len else text_a
    text_b_trunc = text_b[:max_len] if len(text_b) > max_len else text_b

    # GPT comparison
    try:
        prompt = f"""당신은 EPC 프로젝트 준공도서 리비전 비교 분석 전문가입니다.
아래 두 리비전의 문서 내용을 비교 분석하세요.

문서 제목: {doc.get('title', '')}
문서번호: {doc.get('doc_no', '')}

=== 리비전 {rev_a['revision']} ({rev_a.get('date', '')}) ===
담당자: {rev_a.get('engineer_name', '-')}
변경내용: {rev_a.get('change_description', '-')}
문서 내용:
{text_a_trunc}

=== 리비전 {rev_b['revision']} ({rev_b.get('date', '')}) ===
담당자: {rev_b.get('engineer_name', '-')}
변경내용: {rev_b.get('change_description', '-')}
문서 내용:
{text_b_trunc}

다음 항목을 마크다운 형식으로 분석해 주세요:
1. **변경 요약**: 두 리비전 간 핵심 변경사항 (3-5줄)
2. **상세 비교**: 추가/삭제/수정된 주요 내용을 표 또는 리스트로 정리
3. **기술적 의미**: 변경이 프로젝트에 미치는 영향
4. **주의사항**: 리뷰어가 확인해야 할 포인트

한국어로 답변하세요."""

        response = _openai_client.chat.completions.create(
            model=settings.AZURE_OPENAI_DEPLOYMENT_NAME,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )
        comparison = response.choices[0].message.content
    except Exception as e:
        comparison = f"AI 비교 분석 중 오류 발생: {e}"

    return {
        "comparison": comparison,
        "rev_a": rev_a["revision"],
        "rev_b": rev_b["revision"],
        "text_a_length": len(text_a),
        "text_b_length": len(text_b),
    }


def _load_di_text(container, di_json_path: str = "", di_folder_path: str = "") -> str:
    """Load pre-extracted text from DI results.
    Supports both new page-level format (di_folder_path) and legacy single-file (di_json_path).
    """
    # New format: page-level JSONs in folder
    if di_folder_path:
        try:
            meta_blob = container.get_blob_client(f"{di_folder_path}meta.json")
            meta = json.loads(meta_blob.download_blob().readall().decode('utf-8'))
            page_numbers = meta.get("pages", [])

            texts = []
            for pn in sorted(page_numbers):
                try:
                    page_blob = container.get_blob_client(f"{di_folder_path}page_{pn}.json")
                    page_data = json.loads(page_blob.download_blob().readall().decode('utf-8'))
                    texts.append(page_data.get("content", ""))
                except Exception:
                    pass

            full_text = "\n\n".join(texts)
            if full_text:
                print(f"[Revision] Loaded DI text from {len(page_numbers)} page JSONs ({len(full_text)} chars)", flush=True)
                return full_text
        except Exception as e:
            logger.warning(f"Failed to load page-level DI from {di_folder_path}: {e}")

    # Legacy format: single DI JSON file
    if di_json_path:
        try:
            blob = container.get_blob_client(di_json_path)
            data = json.loads(blob.download_blob().readall().decode('utf-8'))
            text = data.get("full_text", "")
            if text:
                print(f"[Revision] Loaded DI text from cache: {di_json_path} ({len(text)} chars)", flush=True)
            return text
        except Exception:
            return ""

    return ""


async def _extract_text_from_blob(blob_path: str) -> str:
    """Extract text from a blob file using Azure DI."""
    if not blob_path:
        return ""
    try:
        from app.services.azure_di import azure_di_service
        from app.services.blob_storage import generate_sas_url
        file_url = generate_sas_url(blob_path)
        di_result = azure_di_service.analyze_document_from_url(file_url)
        return "\n\n".join([p.get("content", "") for p in di_result])
    except Exception as e:
        print(f"[Revision] Text extraction failed for {blob_path}: {e}", flush=True)
        return ""


# ── Add Document ──

@router.post("/add-document")
async def add_document(
    request: AddDocumentRequest,
    authorization: Optional[str] = Header(None)
):
    """Manually add a document entry to a project."""
    username = _get_username(authorization)
    container = _get_container()

    json_path = f"{username}/revision/{request.project_id}/project.json"
    project = _load_project_json(container, json_path)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    new_doc = {
        "doc_id": str(uuid.uuid4()),
        "doc_no": request.doc_no,
        "tag_no": request.tag_no,
        "title": request.title,
        "phase": request.phase,
        "status": "not_started",
        "latest_revision": "-",
        "latest_date": "",
        "revisions": [],
    }
    project["documents"].append(new_doc)

    # Auto-fill doc_no if empty (considers existing documents to avoid collision)
    if not request.doc_no or request.doc_no.strip() in ("", "-"):
        project_code = project.get("project_code", "DOC")
        _auto_fill_doc_no(project["documents"], project_code)

    _recalculate_summary(project)
    _save_project_json(container, json_path, project)

    return {"status": "success", "doc_id": new_doc["doc_id"], "summary": project["summary"]}


# ── Update Document ──

@router.put("/update-document")
async def update_document(
    request: UpdateDocumentRequest,
    authorization: Optional[str] = Header(None)
):
    """Update document metadata."""
    username = _get_username(authorization)
    container = _get_container()

    json_path = f"{username}/revision/{request.project_id}/project.json"
    project = _load_project_json(container, json_path)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    doc = None
    for d in project.get("documents", []):
        if d["doc_id"] == request.doc_id:
            doc = d
            break
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if request.doc_no is not None:
        doc["doc_no"] = request.doc_no
    if request.tag_no is not None:
        doc["tag_no"] = request.tag_no
    if request.title is not None:
        doc["title"] = request.title
    if request.phase is not None:
        doc["phase"] = request.phase
    if request.status is not None:
        doc["status"] = request.status

    _recalculate_summary(project)
    _save_project_json(container, json_path, project)

    return {"status": "success", "summary": project["summary"]}


# ── Update Project ──

@router.put("/update-project")
async def update_project(
    request: UpdateProjectRequest,
    authorization: Optional[str] = Header(None)
):
    """Update project name and/or code. Blob paths use UUID so no folder rename needed."""
    username = _get_username(authorization)
    container = _get_container()

    json_path = f"{username}/revision/{request.project_id}/project.json"
    project = _load_project_json(container, json_path)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if request.project_name is not None:
        project["project_name"] = request.project_name
    if request.project_code is not None:
        project["project_code"] = request.project_code

    _save_project_json(container, json_path, project)

    return {
        "status": "success",
        "project_name": project["project_name"],
        "project_code": project["project_code"],
    }


# ── Delete Project ──

@router.delete("/project/{project_id}")
async def delete_project(
    project_id: str,
    authorization: Optional[str] = Header(None)
):
    """Delete a project and all its data."""
    username = _get_username(authorization)
    container = _get_container()

    # Delete all blobs under project folder
    prefix = f"{username}/revision/{project_id}/"
    deleted_count = 0
    try:
        blobs = list(container.list_blobs(name_starts_with=prefix))
        for blob in blobs:
            container.delete_blob(blob.name)
            deleted_count += 1
        print(f"[Revision] Deleted {deleted_count} blobs for project {project_id}", flush=True)
    except Exception as e:
        logger.error(f"Blob deletion failed: {e}")

    # Delete from search index
    try:
        revision_search_service.delete_by_project(project_id)
    except Exception as e:
        print(f"[Revision] Search index cleanup failed: {e}", flush=True)

    return {"status": "success", "deleted_blobs": deleted_count}


# ── Reindex Project ──

@router.post("/reindex-project/{project_id}")
async def reindex_project(
    project_id: str,
    authorization: Optional[str] = Header(None)
):
    """Re-index all revisions in a project with page-level DI + embedding.
    - Deletes old search index entries
    - For each revision with blob_path: DI page-level → save page JSONs → index
    - Updates project.json with di_folder_path / total_pages
    """
    username = _get_username(authorization)
    container = _get_container()

    json_path = f"{username}/revision/{project_id}/project.json"
    project = _load_project_json(container, json_path)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_name = project.get("project_name", "")
    print(f"[Revision] Reindex project '{project_name}' ({project_id}) started", flush=True)

    # Step 1: Delete all existing index entries
    try:
        deleted = revision_search_service.delete_by_project(project_id)
        print(f"[Revision] Cleared {deleted} old index entries", flush=True)
    except Exception as e:
        print(f"[Revision] Index cleanup failed: {e}", flush=True)

    # Step 2: Process each revision
    total_revisions = 0
    success_count = 0
    error_count = 0
    total_pages_indexed = 0

    for doc in project.get("documents", []):
        for rev in doc.get("revisions", []):
            blob_path = rev.get("blob_path", "")
            if not blob_path:
                continue

            total_revisions += 1
            revision = rev.get("revision", "")
            doc_title = doc.get("title", "")[:40]
            print(f"[Revision] Reindexing [{total_revisions}] {doc.get('doc_no', '')} {revision} - {doc_title}", flush=True)

            try:
                # DI page-level extraction
                di_pages = await _extract_pages_with_di(blob_path)
                total_pages = len(di_pages)
                full_text = "\n\n".join([p.get("content", "") for p in di_pages])

                # Save page-level JSONs
                di_folder_path = f"{username}/revision/{project_id}/docs/{doc['doc_id']}/{revision}_di/"
                _save_page_jsons(container, di_folder_path, di_pages, {
                    "doc_id": doc["doc_id"],
                    "doc_no": doc.get("doc_no", ""),
                    "title": doc.get("title", ""),
                }, revision)

                # Index pages
                phase_name = PHASES.get(doc.get("phase", ""), {}).get("name", "")
                pages_for_index = [
                    {"page_number": p.get("page_number", i + 1), "content": p.get("content", "")}
                    for i, p in enumerate(di_pages)
                ]
                metadata = {
                    "project_id": project_id,
                    "project_name": project_name,
                    "doc_id": doc["doc_id"],
                    "doc_no": doc.get("doc_no", ""),
                    "tag_no": doc.get("tag_no", ""),
                    "title": doc.get("title", ""),
                    "phase": doc.get("phase", ""),
                    "phase_name": phase_name,
                    "revision": revision,
                    "engineer_name": rev.get("engineer_name", ""),
                    "revision_date": rev.get("date", ""),
                    "change_description": rev.get("change_description", ""),
                    "blob_path": blob_path,
                    "username": username,
                }
                indexed = revision_search_service.index_revision_pages(pages_for_index, metadata)
                total_pages_indexed += indexed

                # Update revision entry in project.json
                rev["di_folder_path"] = di_folder_path
                rev["total_pages"] = total_pages
                rev["text_length"] = len(full_text)

                success_count += 1
                print(f"[Revision] ✓ {doc.get('doc_no', '')} {revision}: {total_pages} pages indexed", flush=True)

            except Exception as e:
                error_count += 1
                print(f"[Revision] ✗ {doc.get('doc_no', '')} {revision} failed: {e}", flush=True)

    # Save updated project.json
    _save_project_json(container, json_path, project)

    result = {
        "status": "success",
        "project_id": project_id,
        "total_revisions": total_revisions,
        "success": success_count,
        "errors": error_count,
        "total_pages_indexed": total_pages_indexed,
    }
    print(f"[Revision] Reindex complete: {result}", flush=True)
    return result


# ── Search ──

@router.post("/search")
async def search_revision(
    request: SearchRequest,
    authorization: Optional[str] = Header(None)
):
    """Hybrid search or RAG chat over revision documents."""
    username = _get_username(authorization)

    print(f"[Revision] {request.mode} by '{username}': {request.query}", flush=True)

    if request.mode == "chat":
        return await _handle_chat(request, username)
    else:
        return await _handle_search(request)


async def _handle_search(request: SearchRequest) -> dict:
    results = revision_search_service.hybrid_search(
        query=request.query,
        project_id=request.project_id,
        phase=request.phase,
        top=request.top or 20,
    )

    for r in results:
        azure_highlights = r.pop("azure_highlights", [])
        if azure_highlights:
            r["highlight"] = " ... ".join(azure_highlights[:3])
        else:
            r["highlight"] = r.get("content_preview", "")[:300]

    return {"results": results, "total": len(results)}


async def _handle_chat(request: SearchRequest, username: str) -> dict:
    results = revision_search_service.hybrid_search(
        query=request.query,
        project_id=request.project_id,
        phase=request.phase,
        top=15,
    )

    if not results:
        context_text = "관련 리비전 문서를 찾지 못했습니다."
    else:
        context_parts = []
        for r in results:
            header = f"=== 문서: {r['doc_no']} {r['title']} | Phase: {r['phase_name']} | Rev: {r['revision']} ==="
            context_parts.append(f"{header}\n{r.get('content_preview', '')}")
        context_text = "\n\n".join(context_parts)

    if len(context_text) > 80000:
        context_text = context_text[:80000] + "...(truncated)"

    system_prompt = """당신은 EPC 프로젝트 준공도서 리비전 관리 전문가입니다.
제공된 문서 리비전 이력과 내용을 기반으로 질문에 답변합니다.

**답변 규칙:**
1. 제공된 문서 내용 기반으로 답변
2. 문서번호와 리비전 번호를 인용
3. Phase별 진행 상태를 정확히 파악
4. 마크다운 포맷 사용
5. 한국어로 답변"""

    messages = [{"role": "system", "content": system_prompt}]

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

    sources = [
        {
            "doc_no": r["doc_no"],
            "title": r["title"],
            "phase": r["phase"],
            "revision": r["revision"],
            "score": r.get("score", 0),
            "content_preview": r.get("content_preview", ""),
        }
        for r in results[:10]
    ]

    return {"response": answer, "results": sources, "total": len(sources)}
