# Google Cloud Run Deployment Script
# This script automates the deployment of the Drawing Detector backend to Google Cloud Run

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Drawing Detector - Cloud Run Deployment" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if gcloud is installed
try {
    $gcloudVersion = gcloud --version 2>&1
    Write-Host "✓ Google Cloud SDK is installed" -ForegroundColor Green
} catch {
    Write-Host "✗ Google Cloud SDK is not installed" -ForegroundColor Red
    Write-Host "Please install from: https://cloud.google.com/sdk/docs/install" -ForegroundColor Yellow
    exit 1
}

# Ask for project ID
$projectId = Read-Host "Enter your Google Cloud Project ID (e.g., drawing-detector-12345)"
gcloud config set project $projectId

# Enable required APIs
Write-Host ""
Write-Host "Enabling required Google Cloud APIs..." -ForegroundColor Yellow
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable secretmanager.googleapis.com

# Load environment variables from .env file
Write-Host ""
Write-Host "Loading secrets from backend/.env file..." -ForegroundColor Yellow
$envPath = ".\backend\.env"

if (Test-Path $envPath) {
    $envVars = @{}
    Get-Content $envPath | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.+)$') {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim().Trim('"')
            $envVars[$key] = $value
        }
    }
    
    # Create secrets in Secret Manager
    Write-Host "Creating secrets in Google Secret Manager..." -ForegroundColor Yellow
    
    $secrets = @(
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_KEY",
        "AZURE_OPENAI_API_VERSION",
        "AZURE_OPENAI_DEPLOYMENT_NAME",
        "AZURE_BLOB_CONNECTION_STRING",
        "AZURE_BLOB_SAS_TOKEN",
        "AZURE_BLOB_CONTAINER_NAME",
        "AZURE_FORM_RECOGNIZER_ENDPOINT",
        "AZURE_FORM_RECOGNIZER_KEY",
        "AZURE_SEARCH_ENDPOINT",
        "AZURE_SEARCH_KEY",
        "AZURE_SEARCH_INDEX_NAME"
    )
    
    foreach ($secretName in $secrets) {
        if ($envVars.ContainsKey($secretName)) {
            $secretValue = $envVars[$secretName]
            
            # Create temp file for secret to avoid PowerShell encoding issues (BOM/UTF-16)
            $tempSecret = [System.IO.Path]::GetTempFileName()
            $secretValue | Out-File -FilePath $tempSecret -Encoding ASCII -NoNewline

            # Check if secret already exists
            $existingSecret = gcloud secrets describe $secretName 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  Updating existing secret: $secretName" -ForegroundColor Cyan
                gcloud secrets versions add $secretName --data-file=$tempSecret
            } else {
                Write-Host "  Creating new secret: $secretName" -ForegroundColor Green
                gcloud secrets create $secretName --data-file=$tempSecret
            }
            
            # Clean up
            Remove-Item $tempSecret
        } else {
            Write-Host "  Warning: $secretName not found in .env file" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "Error: .env file not found at $envPath" -ForegroundColor Red
    exit 1
}

# Deploy to Cloud Run
Write-Host ""
Write-Host "Deploying to Google Cloud Run..." -ForegroundColor Yellow
Write-Host "This may take 3-5 minutes..." -ForegroundColor Cyan

cd backend

gcloud run deploy drawing-detector-backend `
    --source . `
    --region us-central1 `
    --platform managed `
    --allow-unauthenticated `
    --set-secrets="AZURE_OPENAI_ENDPOINT=AZURE_OPENAI_ENDPOINT:latest,AZURE_OPENAI_KEY=AZURE_OPENAI_KEY:latest,AZURE_OPENAI_API_VERSION=AZURE_OPENAI_API_VERSION:latest,AZURE_OPENAI_DEPLOYMENT_NAME=AZURE_OPENAI_DEPLOYMENT_NAME:latest,AZURE_BLOB_CONNECTION_STRING=AZURE_BLOB_CONNECTION_STRING:latest,AZURE_BLOB_SAS_TOKEN=AZURE_BLOB_SAS_TOKEN:latest,AZURE_BLOB_CONTAINER_NAME=AZURE_BLOB_CONTAINER_NAME:latest,AZURE_FORM_RECOGNIZER_ENDPOINT=AZURE_FORM_RECOGNIZER_ENDPOINT:latest,AZURE_FORM_RECOGNIZER_KEY=AZURE_FORM_RECOGNIZER_KEY:latest,AZURE_SEARCH_ENDPOINT=AZURE_SEARCH_ENDPOINT:latest,AZURE_SEARCH_KEY=AZURE_SEARCH_KEY:latest,AZURE_SEARCH_INDEX_NAME=AZURE_SEARCH_INDEX_NAME:latest" `
    --max-instances 10 `
    --memory 2048Mi `
    --cpu 2 `
    --timeout 300

cd ..

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "✓ Deployment Successful!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Your backend is now live!" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "1. Copy the backend URL from above" -ForegroundColor White
    Write-Host "2. Update frontend/.env.production with the URL" -ForegroundColor White
    Write-Host "3. Rebuild and redeploy frontend to Firebase" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "✗ Deployment failed. Please check the errors above." -ForegroundColor Red
    exit 1
}
