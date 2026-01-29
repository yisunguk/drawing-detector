from pydantic_settings import BaseSettings
from typing import List

class Settings(BaseSettings):
    PROJECT_NAME: str = "Drawing Detector"
    API_V1_STR: str = "/api/v1"
    BACKEND_CORS_ORIGINS: List[str] = ["*"]
    
    # Azure OpenAI Settings - These should be set in .env
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_KEY: str = ""
    AZURE_OPENAI_API_VERSION: str = "2023-05-15"
    AZURE_OPENAI_DEPLOYMENT_NAME: str = "gpt-35-turbo"

    # Azure Blob Storage Settings
    AZURE_BLOB_CONNECTION_STRING: str = ""
    AZURE_BLOB_SAS_TOKEN: str = ""
    AZURE_BLOB_CONTAINER_NAME: str = ""

    class Config:
        env_file = ".env"

settings = Settings()
