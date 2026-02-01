from fastapi import APIRouter
from app.core.config import settings
from app.services.blob_storage import get_container_client
from app.services.azure_di import azure_di_service
import traceback

router = APIRouter()

@router.get("/status")
async def check_status():
    status = {
        "env_vars": {
            "AZURE_OPENAI_ENDPOINT": "SET" if settings.AZURE_OPENAI_ENDPOINT else "MISSING",
            "AZURE_OPENAI_KEY": "SET" if settings.AZURE_OPENAI_KEY else "MISSING",
            "AZURE_BLOB_CONNECTION_STRING": "SET" if settings.AZURE_BLOB_CONNECTION_STRING else "MISSING",
            "AZURE_BLOB_SAS_TOKEN": "SET" if settings.AZURE_BLOB_SAS_TOKEN else "MISSING",
            "AZURE_FORM_RECOGNIZER_ENDPOINT": "SET" if settings.AZURE_FORM_RECOGNIZER_ENDPOINT else "MISSING",
            "AZURE_FORM_RECOGNIZER_KEY": "SET" if settings.AZURE_FORM_RECOGNIZER_KEY else "MISSING",
        },
        "services": {}
    }

    # Check Blob Storage
    try:
        client = get_container_client()
        status["services"]["blob_storage"] = "OK"
    except Exception as e:
        status["services"]["blob_storage"] = f"ERROR: {str(e)}"

    # Check DI
    try:
        if azure_di_service.client:
            status["services"]["document_intelligence"] = "INITIALIZED"
        else:
            status["services"]["document_intelligence"] = "NOT_INITIALIZED"
    except Exception as e:
        status["services"]["document_intelligence"] = f"ERROR: {str(e)}"

    return status

@router.get("/test-di")
async def test_di_connection():
    """Attempts to list models or verify connection to DI"""
    try:
        if not azure_di_service.client:
            return {"status": "error", "message": "Client not initialized"}
        
        # We can't easily 'ping', but we can access properties
        return {
            "status": "ok", 
            "endpoint": settings.AZURE_FORM_RECOGNIZER_ENDPOINT,
            "message": "Client object created successfully. (Cannot skip actual analysis cost without valid URL)"
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "trace": traceback.format_exc()}
