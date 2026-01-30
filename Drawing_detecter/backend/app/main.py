from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.api.endpoints import upload, chat

azure_routes_error = None
azure_routes = None
try:
    from app.api.endpoints import azure_routes
except Exception as e:
    azure_routes_error = str(e)
    print(f"Error loading azure_routes module: {e}")

app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json"
)

print(f"Backend '{settings.PROJECT_NAME}' starting up...")
print(f"🚀 Test deployment verification - Deployed at: 2026-01-30 23:59 KST")

@app.middleware("http")
async def log_requests(request, call_next):
    print(f"Incoming request: {request.method} {request.url.path}")
    response = await call_next(request)
    return response

# Set all CORS enabled origins
# Always enable CORS with explicit origins
cors_origins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://drawing-detecter.web.app",
    "https://drawing-detecter.firebaseapp.com",
]

# Add any additional origins from settings
if settings.BACKEND_CORS_ORIGINS:
    cors_origins.extend([str(origin) for origin in settings.BACKEND_CORS_ORIGINS])

print(f"CORS origins configured: {cors_origins}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from fastapi.staticfiles import StaticFiles
import os
from pathlib import Path

app.include_router(upload.router, prefix=f"{settings.API_V1_STR}/upload", tags=["upload"])
app.include_router(chat.router, prefix=f"{settings.API_V1_STR}/chat", tags=["chat"])

# Mount uploads directory to serve static files if it exists
uploads_dir = Path("uploads")
if not uploads_dir.exists():
    uploads_dir.mkdir(parents=True, exist_ok=True)
    print("Created uploads directory")

app.mount("/static", StaticFiles(directory="uploads"), name="static")
if azure_routes:
    app.include_router(azure_routes.router, prefix=f"{settings.API_V1_STR}/azure", tags=["azure"])
# app.include_router(search.router, prefix=f"{settings.API_V1_STR}/search", tags=["search"])

@app.get("/azure-debug")
async def debug_azure():
    return {
        "azure_loaded": azure_routes is not None,
        "error": azure_routes_error,
        "env_vars_check": {
            "conn_string": bool(settings.AZURE_BLOB_CONNECTION_STRING),
            "sas_token": bool(settings.AZURE_BLOB_SAS_TOKEN),
            "account_name": bool(settings.AZURE_STORAGE_ACCOUNT_NAME)
        }
    }

@app.get("/")
async def root():
    return {"message": "Intelligent PDF Drawing Management System API"}
