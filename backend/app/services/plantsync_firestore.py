"""
PlantSync Firestore CRUD helpers.

Collections:
    plantsync_projects/{project_id}
        drawings/{drawing_id}
        markups/{markup_id}
        requests/{request_id}
        activities/{event_id}
    plantsync_shared/{username}_{project_id}
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException
from firebase_admin import firestore

logger = logging.getLogger(__name__)

_db = None

PROJECTS_COL = "plantsync_projects"
SHARED_COL = "plantsync_shared"


def _get_db():
    """Return Firestore client (singleton)."""
    global _db
    if _db is None:
        _db = firestore.client()
    return _db


# ────────────────────────────────────────────
# Project CRUD
# ────────────────────────────────────────────

def fs_create_project(project_id: str, data: dict) -> None:
    _get_db().collection(PROJECTS_COL).document(project_id).set(data)


def fs_get_project(project_id: str) -> Optional[dict]:
    doc = _get_db().collection(PROJECTS_COL).document(project_id).get()
    return doc.to_dict() if doc.exists else None


def fs_update_project(project_id: str, data: dict) -> None:
    _get_db().collection(PROJECTS_COL).document(project_id).update(data)


def fs_delete_project(project_id: str) -> None:
    db = _get_db()
    proj_ref = db.collection(PROJECTS_COL).document(project_id)
    # Delete subcollections
    for sub in ("drawings", "markups", "requests", "activities"):
        _delete_subcollection(proj_ref.collection(sub))
    proj_ref.delete()


def _delete_subcollection(col_ref, batch_size: int = 200):
    """Delete all documents in a subcollection."""
    db = _get_db()
    while True:
        docs = list(col_ref.limit(batch_size).stream())
        if not docs:
            break
        batch = db.batch()
        for doc in docs:
            batch.delete(doc.reference)
        batch.commit()


def fs_list_projects(username: str) -> list:
    """List projects where user is owner OR member."""
    db = _get_db()
    projects = []
    seen_ids = set()

    # 1) Owned projects
    query = db.collection(PROJECTS_COL).where("owner", "==", username)
    for doc in query.stream():
        d = doc.to_dict()
        if d:
            projects.append(d)
            seen_ids.add(doc.id)

    # 2) Projects where user is a member (array-contains on members[].name)
    query2 = db.collection(PROJECTS_COL).where("member_names", "array_contains", username)
    for doc in query2.stream():
        if doc.id not in seen_ids:
            d = doc.to_dict()
            if d:
                projects.append(d)
                seen_ids.add(doc.id)

    return projects


# ────────────────────────────────────────────
# Drawing CRUD (subcollection)
# ────────────────────────────────────────────

def _drawings_col(project_id: str):
    return _get_db().collection(PROJECTS_COL).document(project_id).collection("drawings")


def fs_get_drawing(project_id: str, drawing_id: str) -> Optional[dict]:
    doc = _drawings_col(project_id).document(drawing_id).get()
    return doc.to_dict() if doc.exists else None


def fs_add_drawing(project_id: str, drawing_id: str, data: dict) -> None:
    _drawings_col(project_id).document(drawing_id).set(data)


def fs_update_drawing(project_id: str, drawing_id: str, data: dict) -> None:
    _drawings_col(project_id).document(drawing_id).update(data)


def fs_delete_drawing(project_id: str, drawing_id: str) -> None:
    _drawings_col(project_id).document(drawing_id).delete()


def fs_list_drawings(project_id: str) -> list:
    docs = _drawings_col(project_id).stream()
    return [d.to_dict() for d in docs]


def fs_find_drawing_by_number(project_id: str, drawing_number: str) -> Optional[dict]:
    """Find a drawing by drawing_number within a project."""
    query = _drawings_col(project_id).where("drawing_number", "==", drawing_number).limit(1)
    for doc in query.stream():
        return doc.to_dict()
    return None


# ────────────────────────────────────────────
# Markup CRUD (subcollection)
# ────────────────────────────────────────────

def _markups_col(project_id: str):
    return _get_db().collection(PROJECTS_COL).document(project_id).collection("markups")


def fs_add_markup(project_id: str, markup_id: str, data: dict) -> None:
    _markups_col(project_id).document(markup_id).set(data)


def fs_get_markup(project_id: str, markup_id: str) -> Optional[dict]:
    doc = _markups_col(project_id).document(markup_id).get()
    return doc.to_dict() if doc.exists else None


def fs_update_markup(project_id: str, markup_id: str, data: dict) -> None:
    _markups_col(project_id).document(markup_id).update(data)


def fs_delete_markup(project_id: str, markup_id: str) -> None:
    _markups_col(project_id).document(markup_id).delete()


def fs_list_markups(
    project_id: str,
    drawing_id: Optional[str] = None,
    page: Optional[int] = None,
    discipline: Optional[str] = None,
) -> list:
    query = _markups_col(project_id)
    if drawing_id:
        query = query.where("drawing_id", "==", drawing_id)
    if page is not None:
        query = query.where("page", "==", page)
    if discipline:
        query = query.where("discipline", "==", discipline)
    return [d.to_dict() for d in query.stream()]


def fs_list_markups_all(project_id: str) -> list:
    """Return all markups in the project (no filter)."""
    return [d.to_dict() for d in _markups_col(project_id).stream()]


def fs_delete_markups_by_drawing(project_id: str, drawing_id: str) -> None:
    """Delete all markups for a specific drawing."""
    db = _get_db()
    query = _markups_col(project_id).where("drawing_id", "==", drawing_id)
    docs = list(query.stream())
    if docs:
        batch = db.batch()
        for doc in docs:
            batch.delete(doc.reference)
        batch.commit()


def fs_bulk_update_markups(project_id: str, markup_ids: list, data: dict) -> None:
    """Update multiple markups at once."""
    db = _get_db()
    col = _markups_col(project_id)
    batch = db.batch()
    for mid in markup_ids:
        batch.update(col.document(mid), data)
    batch.commit()


# ────────────────────────────────────────────
# Request CRUD (subcollection)
# ────────────────────────────────────────────

def _requests_col(project_id: str):
    return _get_db().collection(PROJECTS_COL).document(project_id).collection("requests")


def fs_add_request(project_id: str, request_id: str, data: dict) -> None:
    _requests_col(project_id).document(request_id).set(data)


def fs_get_request(project_id: str, request_id: str) -> Optional[dict]:
    doc = _requests_col(project_id).document(request_id).get()
    return doc.to_dict() if doc.exists else None


def fs_update_request(project_id: str, request_id: str, data: dict) -> None:
    _requests_col(project_id).document(request_id).update(data)


def fs_delete_request(project_id: str, request_id: str) -> None:
    _requests_col(project_id).document(request_id).delete()


def fs_list_requests(
    project_id: str,
    drawing_id: Optional[str] = None,
    status: Optional[str] = None,
) -> list:
    query = _requests_col(project_id)
    if drawing_id:
        query = query.where("drawing_id", "==", drawing_id)
    if status:
        query = query.where("status", "==", status)
    return [d.to_dict() for d in query.stream()]


def fs_count_transmittals(project_id: str) -> int:
    """Count requests that have a transmittal_no set."""
    count = 0
    for doc in _requests_col(project_id).stream():
        d = doc.to_dict()
        if d.get("transmittal_no"):
            count += 1
    return count


# ────────────────────────────────────────────
# Activity (subcollection, capped at 500)
# ────────────────────────────────────────────

def _activities_col(project_id: str):
    return _get_db().collection(PROJECTS_COL).document(project_id).collection("activities")


def fs_add_activity(project_id: str, action: str, details: dict = None, actor: str = None) -> None:
    """Append an activity event. Auto-cap at 500 newest."""
    try:
        col = _activities_col(project_id)
        event_id = str(uuid.uuid4())[:8]
        event = {
            "event_id": event_id,
            "action": action,
            "actor": actor or "",
            "details": details or {},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        col.document(event_id).set(event)

        # Cap at 500 — delete oldest beyond 500
        all_docs = list(col.order_by("timestamp", direction=firestore.Query.DESCENDING).stream())
        if len(all_docs) > 500:
            db = _get_db()
            batch = db.batch()
            for doc in all_docs[500:]:
                batch.delete(doc.reference)
            batch.commit()
    except Exception as e:
        logger.debug(f"Activity log failed: {e}")


def fs_list_activities(project_id: str, limit: int = 50) -> list:
    col = _activities_col(project_id)
    docs = col.order_by("timestamp", direction=firestore.Query.DESCENDING).limit(limit).stream()
    return [d.to_dict() for d in docs]


# ────────────────────────────────────────────
# Shared refs
# ────────────────────────────────────────────

def _shared_doc_id(username: str, project_id: str) -> str:
    return f"{username}_{project_id}"


def fs_add_shared_ref(username: str, project_id: str, data: dict) -> None:
    doc_id = _shared_doc_id(username, project_id)
    _get_db().collection(SHARED_COL).document(doc_id).set({
        "username": username,
        "project_id": project_id,
        **data,
    })


def fs_delete_shared_ref(username: str, project_id: str) -> None:
    doc_id = _shared_doc_id(username, project_id)
    _get_db().collection(SHARED_COL).document(doc_id).delete()


def fs_list_shared_refs(username: str) -> list:
    query = _get_db().collection(SHARED_COL).where("username", "==", username)
    return [d.to_dict() for d in query.stream()]


# ────────────────────────────────────────────
# Access control helpers
# ────────────────────────────────────────────

def fs_resolve_project(username: str, project_id: str) -> dict:
    """
    Return the project document if the user is owner or member.
    Raises HTTP 404 if not found or not accessible.
    """
    project = fs_get_project(project_id)
    if project:
        if project.get("owner") == username:
            return project
        if username in project.get("member_names", []):
            return project
    raise HTTPException(status_code=404, detail="Project not found")


def fs_check_access(username: str, project_id: str) -> bool:
    project = fs_get_project(project_id)
    if not project:
        return False
    if project.get("owner") == username:
        return True
    return username in project.get("member_names", [])
