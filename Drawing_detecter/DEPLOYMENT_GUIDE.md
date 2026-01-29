# Google Cloud Run Deployment Guide

## Prerequisites Check
- ✅ Dockerfile created
- ✅ CORS configured for Firebase domain
- ❌ Docker not installed locally
- ❌ Google Cloud SDK not installed locally

## Deployment Strategy

Since Docker and gcloud CLI are not installed, we'll use **Google Cloud Console (web interface)** to deploy directly from GitHub.

---

## Step-by-Step Deployment Instructions

### Step 1: Install Google Cloud SDK (Required)

**Download and install from**: https://cloud.google.com/sdk/docs/install

After installation, run in a new terminal:
```powershell
gcloud init
gcloud auth login
```

### Step 2: Set Up Google Cloud Project

1. **Create a new project** (or use existing):
   - Go to: https://console.cloud.google.com/
   - Click "Select a project" → "New Project"
   - Name: `drawing-detector` (or your choice)
   - Click "Create"

2. **Enable required APIs**:
   ```powershell
   gcloud services enable run.googleapis.com
   gcloud services enable cloudbuild.googleapis.com
   gcloud services enable secretmanager.googleapis.com
   ```

### Step 3: Set Up Secrets in Secret Manager

Store your Azure credentials securely:

```powershell
# Set your project ID
gcloud config set project YOUR_PROJECT_ID

# Create secrets (you'll be prompted to enter values)
echo "YOUR_AZURE_OPENAI_ENDPOINT" | gcloud secrets create AZURE_OPENAI_ENDPOINT --data-file=-
echo "YOUR_AZURE_OPENAI_KEY" | gcloud secrets create AZURE_OPENAI_KEY --data-file=-
echo "YOUR_AZURE_STORAGE_ACCOUNT_NAME" | gcloud secrets create AZURE_BLOB_CONNECTION_STRING --data-file=-
echo "YOUR_AZURE_STORAGE_SAS_TOKEN" | gcloud secrets create AZURE_BLOB_SAS_TOKEN --data-file=-
echo "YOUR_AZURE_CONTAINER_NAME" | gcloud secrets create AZURE_BLOB_CONTAINER_NAME --data-file=-
echo "2023-05-15" | gcloud secrets create AZURE_OPENAI_API_VERSION --data-file=-
echo "gpt-35-turbo" | gcloud secrets create AZURE_OPENAI_DEPLOYMENT_NAME --data-file=-
```

### Step 4: Deploy to Cloud Run

From your project directory:

```powershell
cd D:\Projects\Drawing_detecter\backend

# Deploy to Cloud Run (this will build and deploy in one command)
gcloud run deploy drawing-detector-backend `
  --source . `
  --region us-central1 `
  --platform managed `
  --allow-unauthenticated `
  --set-secrets="AZURE_OPENAI_ENDPOINT=AZURE_OPENAI_ENDPOINT:latest,AZURE_OPENAI_KEY=AZURE_OPENAI_KEY:latest,AZURE_BLOB_CONNECTION_STRING=AZURE_BLOB_CONNECTION_STRING:latest,AZURE_BLOB_SAS_TOKEN=AZURE_BLOB_SAS_TOKEN:latest,AZURE_BLOB_CONTAINER_NAME=AZURE_BLOB_CONTAINER_NAME:latest,AZURE_OPENAI_API_VERSION=AZURE_OPENAI_API_VERSION:latest,AZURE_OPENAI_DEPLOYMENT_NAME=AZURE_OPENAI_DEPLOYMENT_NAME:latest" `
  --max-instances 10
```

**Note**: The deployment will take 3-5 minutes. You'll receive a URL like:
```
https://drawing-detector-backend-xxxxx-uc.a.run.app
```

### Step 5: Update Frontend with Backend URL

After deployment, update the frontend to use the production backend URL.

---

## Alternative: Deploy via Cloud Console (No CLI)

If you prefer not to install gcloud CLI:

1. **Push code to GitHub** (already done ✅)

2. **Go to Cloud Run Console**: https://console.cloud.google.com/run

3. **Click "Create Service"**
   - Select "Continuously deploy new revisions from a source repository"
   - Click "Set up with Cloud Build"
   - Connect your GitHub repository: `yisunguk/drawing-detector`
   - Branch: `main`
   - Build type: Dockerfile
   - Dockerfile path: `backend/Dockerfile`

4. **Configure Service**:
   - Service name: `drawing-detector-backend`
   - Region: `us-central1`
   - Authentication: "Allow unauthenticated invocations"
   - Container port: `8080`

5. **Add Environment Variables**:
   - Click "Variables & Secrets" tab
   - Add secrets from Secret Manager (created in Step 3)

6. **Deploy!**

---

## Cost Estimate

**Google Cloud Run Free Tier** (monthly):
- 2 million requests
- 360,000 GB-seconds (memory)
- 180,000 vCPU-seconds

**Expected cost for low traffic**: $0-5/month

For moderate traffic (10k requests/month): ~$5-10/month

---

## Next Steps After Deployment

1. Get your backend URL
2. Update frontend environment variables
3. Redeploy frontend to Firebase
4. Test full application flow
