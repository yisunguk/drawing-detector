from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.api.endpoints import upload, chat
try:
    from app.api.endpoints import azure
except ImportError:
    azure = None

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
if azure:
    app.include_router(azure.router, prefix=f"{settings.API_V1_STR}/azure", tags=["azure"])
# app.include_router(search.router, prefix=f"{settings.API_V1_STR}/search", tags=["search"])

@app.get("/")
async def root():
    return {"message": "Intelligent PDF Drawing Management System API"}
