const API_URL = import.meta.env.VITE_API_URL || 'https://drawing-detector-backend-kr7kyy4mza-uc.a.run.app';

// CDN URLs (Matching Dashboard.jsx)
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Azure Config
const AZURE_STORAGE_ACCOUNT_NAME = import.meta.env.VITE_AZURE_STORAGE_ACCOUNT_NAME;
const AZURE_CONTAINER_NAME = import.meta.env.VITE_AZURE_CONTAINER_NAME;
const rawSasToken = import.meta.env.VITE_AZURE_SAS_TOKEN || "";
const AZURE_SAS_TOKEN = rawSasToken.replace(/^"|"$/g, '');

// Helper: Load PDF.js
export const loadPdfJs = () => {
    return new Promise((resolve, reject) => {
        if (window.pdfjsLib) {
            resolve(window.pdfjsLib);
            return;
        }

        const script = document.createElement('script');
        script.src = PDFJS_URL;
        script.onload = () => {
            if (window.pdfjsLib) {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
                resolve(window.pdfjsLib);
            } else {
                reject(new Error("PDF.js loaded but window.pdfjsLib is undefined"));
            }
        };
        script.onerror = () => reject(new Error("Failed to load PDF.js"));
        document.head.appendChild(script);
    });
};

// Helper: Count Pages
export const countPdfPages = async (file) => {
    try {
        const pdfjs = await loadPdfJs();
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        return pdf.numPages;
    } catch (e) {
        console.warn("Failed to count PDF pages, defaulting to 1:", e);
        return 1;
    }
};

// 1. Get SAS URL
export const getUploadSas = async (filename, username) => {
    const encodedName = encodeURIComponent(filename);
    const userParam = username ? `&username=${encodeURIComponent(username)}` : '';
    const response = await fetch(`${API_URL}/api/v1/analyze/upload-sas?filename=${encodedName}${userParam}`);
    if (!response.ok) throw new Error('Failed to get SAS URL');
    return await response.json(); // { upload_url, blob_name }
};

// 2. Direct Upload to Azure
export const uploadToAzure = async (uploadUrl, file, onProgress) => {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        xhr.setRequestHeader('x-ms-blob-type', 'BlockBlob');

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
                const percent = Math.round((e.loaded / e.total) * 100);
                onProgress(percent);
            }
        };

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`Upload failed: ${xhr.statusText}`));
        };
        xhr.onerror = () => reject(new Error("Network Error"));
        xhr.send(file);
    });
};

// 3. Start Analysis
export const startAnalysis = async (filename, totalPages, username, category = 'documents', force = false) => {
    const response = await fetch(`${API_URL}/api/v1/analyze/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename,
            total_pages: totalPages,
            category,
            username,
            force
        })
    });
    if (!response.ok) throw new Error('Failed to start analysis');
    return await response.json();
};

// 3b. Re-index (for failed documents)
export const reindexDocument = async (filename, totalPages, username, category = 'drawings') => {
    const response = await fetch(`${API_URL}/api/v1/analyze/reindex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename,
            total_pages: totalPages,
            category,
            username
        })
    });
    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.detail || 'Failed to start re-indexing');
    }
    return await response.json();
};

// 4. Poll Status
export const pollAnalysisStatus = async (filename, onStatus) => {
    let isComplete = false;
    let result = null;

    const startTime = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes timeout

    while (!isComplete) {
        if (Date.now() - startTime > timeout) {
            throw new Error('Analysis timed out. Please check "My Documents" later.');
        }

        await new Promise(r => setTimeout(r, 2000)); // Poll every 2s

        const res = await fetch(`${API_URL}/api/v1/analyze/status/${encodeURIComponent(filename)}`);

        if (res.ok) {
            const data = await res.json();
            if (onStatus) onStatus(data);

            if (data.status === 'completed') {
                isComplete = true;
                result = data;
            } else if (data.status === 'failed' || data.status === 'error') {
                throw new Error(data.error_message || 'Analysis failed');
            }
        } else if (res.status === 404) {
            // File not found yet - Blob Monitor hasn't picked it up
            if (onStatus) onStatus({ status: 'waiting', message: 'Waiting for analysis to start...' });
        }
    }
    return result;
};

// 5. List Files (Library)
export const listDocuments = async (username, category = 'documents') => {
    // If username is provided, we use it to filter, but robustly we should probably
    // check how Dashboard does it. Dashboard: `${userName}/${categoryFolder}`
    const path = username ? `${username}/${category}` : category;
    const response = await fetch(`${API_URL}/api/v1/azure/list?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error('Failed to list documents');
    return await response.json();
};

// 6. Fetch Document JSON (Analysis Data)
export const fetchDocumentJson = async (filename, username, category = 'json') => {
    // Backend logic: user/json/filename_without_ext.json
    const baseName = filename.toLowerCase().endsWith('.pdf') ? filename.slice(0, -4) : filename;
    const jsonFilename = `${baseName}.json`;
    const blobPath = username ? `${username}/${category}/${jsonFilename}` : `${category}/${jsonFilename}`;

    // Direct URL with SAS
    const url = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${AZURE_CONTAINER_NAME}/${encodeURIComponent(blobPath)}?${AZURE_SAS_TOKEN}`;

    const response = await fetch(url);
    if (!response.ok) {
        // Fallback: Check if it's just {filename} without .json (legacy)
        // or handle 404 (not analyzed yet)
        throw new Error('Analysis data not found');
    }
    return await response.json();
};
