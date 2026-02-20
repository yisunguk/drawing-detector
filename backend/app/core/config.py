from pydantic_settings import BaseSettings
from typing import List

class Settings(BaseSettings):
    PROJECT_NAME: str = "Drawing Detector"
    API_V1_STR: str = "/api/v1"
    BACKEND_CORS_ORIGINS: List[str] = [
        "http://localhost:5173",  # Vite dev server
        "http://localhost:3000",  # Alternative dev port
        "https://drawing-detecter.web.app",  # Firebase production
        "https://drawing-detecter.firebaseapp.com"  # Firebase alternative domain
    ]
    
    # Azure OpenAI Settings - These should be set in .env
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_KEY: str = ""
    AZURE_OPENAI_API_VERSION: str = "2023-05-15"
    AZURE_OPENAI_DEPLOYMENT_NAME: str = "gpt-35-turbo"
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: str = "text-embedding-3-large-kimyeji"

    # Azure Blob Storage Settings
    AZURE_STORAGE_ACCOUNT_NAME: str = "encdevmkcsaaitest"
    AZURE_BLOB_CONNECTION_STRING: str = ""
    AZURE_BLOB_SAS_TOKEN: str = ""
    AZURE_BLOB_CONTAINER_NAME: str = "blob-leesunguk"
    
    # Azure Document Intelligence Settings (Paid Tier)
    AZURE_FORM_RECOGNIZER_ENDPOINT: str = ""
    AZURE_FORM_RECOGNIZER_KEY: str = ""
    AZURE_DOC_INTEL_ENDPOINT: str = ""  # Paid Tier (50MB Standard, 500MB Premium)
    AZURE_DOC_INTEL_KEY: str = ""

    # Azure AI Search Settings
    AZURE_SEARCH_ENDPOINT: str = ""
    AZURE_SEARCH_KEY: str = ""
    AZURE_SEARCH_INDEX_NAME: str = "pdf-search-index" # Default index name

    # KCSC (국가건설기준센터) API
    KCSC_API_KEY: str = ""

    # Cron / Cloud Scheduler (daily batch cleanup)
    CRON_SECRET: str = ""

    class Config:
        env_file = ".env"

settings = Settings()
