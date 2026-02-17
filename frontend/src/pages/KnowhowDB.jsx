import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    ArrowLeft, Folder, FolderOpen, FileText, Search as SearchIcon,
    Send, Bot, User, Loader2, Sparkles, ChevronRight,
    X, LogOut, Upload,
    RefreshCcw, Trash2, List, Database, MessageSquare, Check
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import PDFViewer from '../components/PDFViewer';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../contexts/AuthContext';
import { auth, db } from '../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import {
    getUploadSas,
    uploadToAzure,
    startAnalysis,
    pollAnalysisStatus,
    countPdfPages,
    loadPdfJs
} from '../services/analysisService';
import { logActivity } from '../services/logging';

// Config
const API_BASE = (import.meta.env.VITE_API_URL || 'https://drawing-detector-backend-435353955407.us-central1.run.app').replace(/\/$/, '');
const AZURE_STORAGE_ACCOUNT_NAME = import.meta.env.VITE_AZURE_STORAGE_ACCOUNT_NAME;
const AZURE_CONTAINER_NAME = import.meta.env.VITE_AZURE_CONTAINER_NAME;
const rawSasToken = import.meta.env.VITE_AZURE_SAS_TOKEN || '';
const AZURE_SAS_TOKEN = rawSasToken.replace(/^"|"$/g, '');
const EXCLUDED_FOLDERS = ['temp', 'json'];

const OFFICE_EXTENSIONS = ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt'];
const getFileType = (filename) => {
    if (!filename) return 'unknown';
    const lower = filename.toLowerCase();
    if (lower.endsWith('.pdf')) return 'pdf';
    if (OFFICE_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'office';
    return 'unknown';
};

const getChatApiUrl = () => {
    return API_BASE.endsWith('/api') ? `${API_BASE}/v1/chat/` : `${API_BASE}/api/v1/chat/`;
};

const getListApiUrl = (path) => {
    return `${API_BASE}/api/v1/azure/list?path=${encodeURIComponent(path)}`;
};

const getIndexStatusApiUrl = (username, folder = '') => {
    let url = `${API_BASE}/api/v1/azure/index-status?username=${encodeURIComponent(username)}`;
    if (folder) url += `&folder=${encodeURIComponent(folder)}`;
    return url;
};

const getReindexApiUrl = () => {
    return `${API_BASE}/api/v1/azure/reindex-from-json`;
};

const getCleanupIndexApiUrl = () => {
    return `${API_BASE}/api/v1/azure/cleanup-index`;
};

const buildBlobUrl = (blobPath) => {
    const encodedPath = blobPath.split('/').map(s => encodeURIComponent(s)).join('/');
    return `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${AZURE_CONTAINER_NAME}/${encodedPath}?${AZURE_SAS_TOKEN}`;
};

const KnowhowDB = () => {
    const navigate = useNavigate();
    const { currentUser } = useAuth();
    const username = currentUser?.displayName || currentUser?.email?.split('@')[0];
    const isAdmin = currentUser?.email === 'admin@poscoenc.com' || currentUser?.displayName?.includes('관리자');

    // === Admin User Folder State ===
    const [userFolders, setUserFolders] = useState([]);
    const [selectedUserFolder, setSelectedUserFolder] = useState(null);
    // Tree mode state (admin "전체" mode)
    const [treeActiveUser, setTreeActiveUser] = useState(null);
    const [expandedUsers, setExpandedUsers] = useState(new Set());
    const [userSubFolders, setUserSubFolders] = useState({});
    const browseUsername = isAdmin
        ? (selectedUserFolder || treeActiveUser || null)
        : username;

    // === Left Sidebar State ===
    const [folders, setFolders] = useState([]);
    const [activeFolder, setActiveFolder] = useState(null);
    const [files, setFiles] = useState([]);
    const [loadingFiles, setLoadingFiles] = useState(false);
    const [activeDoc, setActiveDoc] = useState(null);
    const [scopeUsers, setScopeUsers] = useState(new Set());  // admin: multi-user search scope

    // === Center State ===
    const [mode, setMode] = useState('search');
    const [query, setQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [isSearching, setIsSearching] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [searchError, setSearchError] = useState(null);
    const [chatMessages, setChatMessages] = useState([
        { role: 'assistant', content: '안녕하세요! 문서에 대해 궁금한 점을 물어보세요.' }
    ]);
    const [isChatLoading, setIsChatLoading] = useState(false);

    // === Right Sidebar State ===
    const [rightOpen, setRightOpen] = useState(false);
    const [rightWidth, setRightWidth] = useState(500);
    const [isResizing, setIsResizing] = useState(false);
    const [pdfDocObj, setPdfDocObj] = useState(null);
    const [pdfPage, setPdfPage] = useState(1);
    const [pdfTotalPages, setPdfTotalPages] = useState(0);
    const [pdfLoading, setPdfLoading] = useState(false);
    const [viewerType, setViewerType] = useState(null); // 'pdf' | 'office'
    const [officeUrl, setOfficeUrl] = useState(null);

    // === Upload State ===
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState('');
    const fileInputRef = useRef(null);

    // === Index Status State (Admin) ===
    const [indexStatus, setIndexStatus] = useState({});
    const [isReindexing, setIsReindexing] = useState(false);
    const [reindexingFile, setReindexingFile] = useState(null);
    const [isIndexingAll, setIsIndexingAll] = useState(false);
    const [isAnalyzingAll, setIsAnalyzingAll] = useState(false);
    const [isCleaningIndex, setIsCleaningIndex] = useState(false);

    // === Left Sidebar Resize ===
    const [leftWidth, setLeftWidth] = useState(320);
    const [isLeftResizing, setIsLeftResizing] = useState(false);
    const leftResizingRef = useRef(false);

    // === Folder/File Divider Resize ===
    const [folderHeight, setFolderHeight] = useState(null); // null = auto, px value when dragged
    const [isDividerResizing, setIsDividerResizing] = useState(false);
    const dividerResizingRef = useRef(false);
    const sidebarRef = useRef(null);

    // === Highlight State ===
    const [highlightKeyword, setHighlightKeyword] = useState(null);
    const [highlightRects, setHighlightRects] = useState([]);
    const [highlightPolygons, setHighlightPolygons] = useState([]); // DI polygon-based highlights
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
    const highlightMetaRef = useRef(null); // { user_id, filename, page } for OCR fallback

    // === Refs ===
    const messagesEndRef = useRef(null);
    const resizingRef = useRef(false);
    const currentPdfUrlRef = useRef(null);
    const fileMapRef = useRef({});
    const lastQueryRef = useRef('');
    const ocrPageCacheRef = useRef({}); // cache: "user/filename/page" → pageData
    const citationHandlerRef = useRef(null); // always-latest handleCitationClick (avoids stale closure in ReactMarkdown)

    // =============================================
    // LOAD USER FOLDERS (Admin only - root level)
    // =============================================
    useEffect(() => {
        if (!isAdmin) return;
        (async () => {
            try {
                const res = await fetch(getListApiUrl(''));
                if (!res.ok) throw new Error('Failed to list user folders');
                const data = await res.json();
                const items = Array.isArray(data) ? data : (data.items || []);
                const names = items
                    .filter(item => item.type === 'folder' && !EXCLUDED_FOLDERS.includes(item.name.toLowerCase()))
                    .map(item => item.name);
                setUserFolders(names);
            } catch (e) {
                console.error('Failed to load user folders:', e);
            }
        })();
    }, [isAdmin]);

    // =============================================
    // LOAD FOLDERS ON MOUNT / USER CHANGE
    // =============================================
    useEffect(() => {
        if (!browseUsername) return;
        if (isAdmin && !selectedUserFolder) return; // "전체" tree mode — folders loaded via tree
        loadFolders();
    }, [browseUsername]);

    const loadFolders = async () => {
        try {
            const res = await fetch(getListApiUrl(`${browseUsername}/`));
            if (!res.ok) throw new Error('Failed to list folders');
            const data = await res.json();
            const items = Array.isArray(data) ? data : (data.items || []);
            const folderItems = items.filter(
                item => item.type === 'folder' && !EXCLUDED_FOLDERS.includes(item.name.toLowerCase())
            );
            setFolders(folderItems);
        } catch (e) {
            console.error('Failed to load folders:', e);
        }
    };

    // Load subfolders for a user in tree mode (lazy, cached)
    const loadUserSubFolders = async (user) => {
        if (userSubFolders[user]) return;
        try {
            const res = await fetch(getListApiUrl(`${user}/`));
            if (!res.ok) throw new Error('Failed');
            const data = await res.json();
            const items = Array.isArray(data) ? data : (data.items || []);
            const folderItems = items.filter(
                item => item.type === 'folder' && !EXCLUDED_FOLDERS.includes(item.name.toLowerCase())
            );
            setUserSubFolders(prev => ({ ...prev, [user]: folderItems }));
        } catch (e) {
            console.error(`Failed to load subfolders for ${user}:`, e);
        }
    };

    const toggleTreeUser = (user) => {
        setExpandedUsers(prev => {
            const next = new Set(prev);
            if (next.has(user)) {
                next.delete(user);
            } else {
                next.add(user);
                loadUserSubFolders(user);
            }
            return next;
        });
    };

    // =============================================
    // LOAD FILES WHEN FOLDER CHANGES
    // =============================================
    useEffect(() => {
        if (!activeFolder || !browseUsername) {
            setFiles([]);
            return;
        }
        loadFiles(activeFolder);
    }, [activeFolder, browseUsername]);

    const loadFiles = async (folderName) => {
        setLoadingFiles(true);
        try {
            const path = `${browseUsername}/${folderName}`;
            const isRecursive = folderName === 'revision';
            let url = getListApiUrl(path);
            if (isRecursive) url += '&recursive=true';
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to list files');
            const data = await res.json();
            const items = Array.isArray(data) ? data : (data.items || []);
            let fileItems = items.filter(item => item.type === 'file');
            // revision: recursive 탐색 시 PDF만 표시 (meta.json, page_N.json 등 제외)
            if (isRecursive) fileItems = fileItems.filter(f => f.name.toLowerCase().endsWith('.pdf'));

            fileItems.forEach(f => {
                const blobPath = isRecursive ? f.path : `${browseUsername}/${folderName}/${f.name}`;
                fileMapRef.current[isRecursive ? f.path : f.name] = {
                    category: folderName,
                    blob_path: blobPath,
                    user_id: browseUsername
                };
            });

            const filesWithUrl = fileItems.map(f => {
                const blobPath = isRecursive ? f.path : `${browseUsername}/${folderName}/${f.name}`;
                return {
                    ...f,
                    folder: folderName,
                    pdfUrl: buildBlobUrl(blobPath),
                    id: isRecursive ? f.path : f.name
                };
            });
            setFiles(filesWithUrl);
        } catch (e) {
            console.error('Failed to load files:', e);
            setFiles([]);
        } finally {
            setLoadingFiles(false);
        }
    };

    // =============================================
    // INDEX STATUS (Admin only)
    // =============================================
    const loadIndexStatus = async (user, folder = '') => {
        if (!isAdmin || !user) return;
        try {
            const res = await fetch(getIndexStatusApiUrl(user, folder));
            if (!res.ok) throw new Error('Failed to load index status');
            const data = await res.json();
            setIndexStatus(data.files || {});
        } catch (e) {
            console.error('Failed to load index status:', e);
            setIndexStatus({});
        }
    };

    useEffect(() => {
        if (isAdmin && browseUsername && activeFolder) {
            loadIndexStatus(browseUsername, activeFolder);
        } else {
            setIndexStatus({});
        }
    }, [isAdmin, browseUsername, activeFolder]);

    const handleReindex = async (file) => {
        if (isReindexing) return;
        setIsReindexing(true);
        setReindexingFile(file.name);
        try {
            const res = await fetch(getReindexApiUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: browseUsername,
                    filename: file.name,
                    category: activeFolder
                })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Reindex failed');
            }
            const data = await res.json();
            // Update local index status
            setIndexStatus(prev => ({
                ...prev,
                [file.name]: {
                    ...prev[file.name],
                    indexed_pages: data.pages_indexed || 0
                }
            }));
        } catch (e) {
            console.error('Reindex failed:', e);
            alert(`Reindex failed: ${e.message}`);
        } finally {
            setIsReindexing(false);
            setReindexingFile(null);
        }
    };

    const handleIndexAll = async () => {
        if (isIndexingAll || !activeFolder) return;
        // Find all files that have JSON but no index
        const toIndex = files.filter(f => {
            const status = indexStatus[f.name];
            return status && status.json_exists && status.indexed_pages === 0;
        });
        if (toIndex.length === 0) {
            alert('No files need reindexing.');
            return;
        }
        if (!confirm(`Reindex ${toIndex.length} files?`)) return;
        setIsIndexingAll(true);
        setIsReindexing(true);
        try {
            for (const file of toIndex) {
                setReindexingFile(file.name);
                try {
                    const res = await fetch(getReindexApiUrl(), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            username: browseUsername,
                            filename: file.name,
                            category: activeFolder
                        })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        setIndexStatus(prev => ({
                            ...prev,
                            [file.name]: {
                                ...prev[file.name],
                                indexed_pages: data.pages_indexed || 0
                            }
                        }));
                    }
                } catch (e) {
                    console.error(`Reindex failed for ${file.name}:`, e);
                }
            }
        } finally {
            setIsIndexingAll(false);
            setIsReindexing(false);
            setReindexingFile(null);
        }
    };

    const handleAnalyzeAll = async () => {
        if (isAnalyzingAll || !activeFolder) return;
        const toAnalyze = files.filter(f => {
            const status = indexStatus[f.name];
            return !status || (!status.json_exists && !(status.indexed_pages > 0));
        });
        if (toAnalyze.length === 0) {
            alert('분석할 파일이 없습니다.');
            return;
        }
        if (!confirm(`${toAnalyze.length}개 파일을 분석하시겠습니까?`)) return;
        setIsAnalyzingAll(true);
        setIsUploading(true);
        try {
            for (const file of toAnalyze) {
                setUploadStatus(`Analyzing ${file.name}...`);
                try {
                    let totalPages = 1;
                    try {
                        const pdfjs = await loadPdfJs();
                        const pdf = await pdfjs.getDocument(file.pdfUrl).promise;
                        totalPages = pdf.numPages;
                    } catch { }
                    const blobName = `${browseUsername}/${activeFolder}/${file.name}`;
                    await startAnalysis(file.name, totalPages, browseUsername, activeFolder, true, blobName);
                    await pollAnalysisStatus(file.name, (statusData) => {
                        if (statusData.status === 'in_progress' || statusData.status === 'finalizing') {
                            const completed = statusData.completed_chunks || [];
                            let done = 0;
                            for (const c of completed) {
                                const [s, en] = c.split('-').map(Number);
                                done += (en - s + 1);
                            }
                            setUploadStatus(`Analyzing ${file.name}... (${done}/${totalPages}p)`);
                        }
                    }, totalPages);
                } catch (e) {
                    console.error(`Analysis failed for ${file.name}:`, e);
                }
            }
            setUploadStatus('Done!');
            await loadIndexStatus(browseUsername, activeFolder);
        } finally {
            setIsAnalyzingAll(false);
            setIsUploading(false);
            setUploadStatus('');
        }
    };

    const handleCleanupIndex = async () => {
        if (isCleaningIndex || !browseUsername) return;
        if (!confirm(`"${browseUsername}" 사용자의 삭제된 파일 인덱스를 정리하시겠습니까?`)) return;
        setIsCleaningIndex(true);
        try {
            const res = await fetch(getCleanupIndexApiUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: browseUsername })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Cleanup failed');
            }
            const data = await res.json();
            if (data.deleted_count > 0) {
                alert(`인덱스 정리 완료: ${data.deleted_count}개 항목 삭제\n\n삭제된 파일:\n${data.deleted_files.join('\n')}`);
                await loadIndexStatus(browseUsername, activeFolder);
            } else {
                alert('정리할 orphaned 인덱스가 없습니다.');
            }
        } catch (e) {
            console.error('Cleanup failed:', e);
            alert(`인덱스 정리 실패: ${e.message}`);
        } finally {
            setIsCleaningIndex(false);
        }
    };

    // =============================================
    // PDF RENDERING
    // =============================================
    const openDocument = async (url, page = 1, filename = '', keyword = null, meta = null) => {
        setHighlightKeyword(keyword || null);
        highlightMetaRef.current = meta; // { user_id, filename, page }
        setHighlightRects([]);
        setHighlightPolygons([]);
        const fileType = getFileType(filename);

        if (fileType === 'office') {
            // Office Online Viewer needs a clean URL with literal '/' (not %2F)
            const officeCleanUrl = url.replace(/%2F/gi, '/');
            setRightOpen(true);
            setViewerType('office');
            setOfficeUrl(`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(officeCleanUrl)}`);
            setPdfDocObj(null);
            currentPdfUrlRef.current = null;
            setPdfLoading(false);
            return;
        }

        // PDF logic
        setViewerType('pdf');
        setOfficeUrl(null);
        setRightOpen(true);

        if (url === currentPdfUrlRef.current && pdfDocObj) {
            setPdfPage(Math.min(page, pdfTotalPages));
            return;
        }

        setPdfLoading(true);
        currentPdfUrlRef.current = url;

        try {
            const pdfjs = await loadPdfJs();
            const doc = await pdfjs.getDocument(url).promise;
            setPdfDocObj(doc);
            setPdfTotalPages(doc.numPages);
            setPdfPage(Math.min(page, doc.numPages));
        } catch (e) {
            console.error('Failed to load PDF:', e);
            setPdfDocObj(null);
            setPdfTotalPages(0);
        } finally {
            setPdfLoading(false);
        }
    };

    // =============================================
    // KEYWORD-BASED HIGHLIGHT (pdf.js text → OCR fallback)
    // =============================================
    useEffect(() => {
        if (!pdfDocObj || !highlightKeyword || canvasSize.width === 0) {
            setHighlightRects([]);
            setHighlightPolygons([]);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const page = await pdfDocObj.getPage(pdfPage);
                // Compute viewport that matches PDFViewer's canvas size
                const baseVp = page.getViewport({ scale: 1 });
                const scale = canvasSize.width / baseVp.width;
                const viewport = page.getViewport({ scale });
                const textContent = await page.getTextContent();
                const stopWords = new Set([
                    '알려', '주세요', '해줘', '해주세요', '뭐야', '뭔가', '있나요', '인가요', '인지', '무엇',
                    '어떤', '어떻게', '얼마나', '대해', '관련', '관해', '입니다', '있는', '하는', '그리고',
                    '또는', '에서', '으로', '에게', '부터', '까지', '이것', '저것', '그것',
                    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her',
                    'was', 'one', 'our', 'out', 'had', 'has', 'its', 'let', 'say', 'she',
                    'too', 'use', 'how', 'what', 'where', 'when', 'which', 'who', 'why',
                    'about', 'from', 'into', 'that', 'than', 'them', 'then', 'they',
                    'this', 'will', 'with', 'have', 'been', 'each', 'make', 'like',
                    'please', 'tell', 'show', 'find', 'give', 'help',
                ]);
                const keywords = highlightKeyword.toLowerCase().split(/\s+/).filter(k => {
                    if (k.length < 2) return false;
                    if (stopWords.has(k)) return false;
                    if (/^[a-z0-9]+$/.test(k) && k.length < 4) return false;
                    return true;
                });
                const rects = [];

                for (const item of textContent.items) {
                    if (!item.str) continue;
                    const text = item.str.toLowerCase();
                    if (!keywords.some(kw => text.includes(kw))) continue;

                    const pdfX = item.transform[4];
                    const pdfY = item.transform[5];
                    const pdfWidth = item.width;
                    const pdfHeight = Math.abs(item.transform[3]);

                    const [vx1, vy1] = viewport.convertToViewportPoint(pdfX, pdfY);
                    const [vx2, vy2] = viewport.convertToViewportPoint(pdfX + pdfWidth, pdfY + pdfHeight);

                    rects.push({
                        x: Math.min(vx1, vx2),
                        y: Math.min(vy1, vy2),
                        width: Math.abs(vx2 - vx1),
                        height: Math.abs(vy2 - vy1)
                    });
                }

                if (cancelled) return;

                // If pdf.js found matches, use them
                if (rects.length > 0) {
                    setHighlightRects(rects);
                    setHighlightPolygons([]);
                    return;
                }

                // Fallback: load OCR page data and match lines (for drawing PDFs)
                setHighlightRects([]);
                const meta = highlightMetaRef.current;
                if (!meta?.user_id || !meta?.filename) {
                    setHighlightPolygons([]);
                    return;
                }

                const cacheKey = `${meta.user_id}/${meta.filename}/${pdfPage}`;
                let pageData = ocrPageCacheRef.current[cacheKey];

                if (!pageData) {
                    const baseName = meta.filename.replace(/\.[^.]+$/, '');

                    // blob_path 기반 JSON 폴더 계산 (Dashboard 동일 로직)
                    let jsonFolder = null;
                    if (meta.blob_path) {
                        const decoded = decodeURIComponent(meta.blob_path);

                        // Revision Master: {user}/revision/.../docs/{doc_id}/{Rev}_file.pdf → {Rev}_di/
                        const revisionMatch = decoded.match(/\/revision\/[^/]+\/docs\/[^/]+\/([^_]+)_[^/]+$/);
                        if (revisionMatch) {
                            const dir = decoded.substring(0, decoded.lastIndexOf('/'));
                            jsonFolder = `${dir}/${revisionMatch[1]}_di`;
                        }

                        // 도면분석: drawings|documents|my-documents|temp → json
                        if (!jsonFolder) {
                            const folderPattern = /\/(drawings|documents|my-documents|temp)\//i;
                            if (folderPattern.test(decoded)) {
                                jsonFolder = decoded.replace(folderPattern, '/json/').replace(/\.[^.]+$/, '');
                            }
                        }
                    }
                    // fallback: 기존 방식
                    if (!jsonFolder) {
                        jsonFolder = `${meta.user_id}/json/${baseName}`;
                    }
                    console.log('[Highlight] jsonFolder:', jsonFolder, '| blob_path:', meta.blob_path);

                    // 1) Try meta.json first (split format 확인)
                    const metaPath = `${jsonFolder}/meta.json`;
                    try {
                        const res = await fetch(buildBlobUrl(metaPath));
                        if (res.ok) {
                            const metaJson = await res.json();
                            if (metaJson.format === 'split') {
                                // split format → page_N.json
                                const splitPath = `${jsonFolder}/page_${pdfPage}.json`;
                                const pageRes = await fetch(buildBlobUrl(splitPath));
                                if (pageRes.ok) {
                                    pageData = await pageRes.json();
                                    ocrPageCacheRef.current[cacheKey] = pageData;
                                }
                            }
                        }
                    } catch (e) { /* ignore */ }

                    // 2) Fallback: direct split path (meta.json 없는 경우)
                    if (!pageData) {
                        const splitPath = `${jsonFolder}/page_${pdfPage}.json`;
                        try {
                            const res = await fetch(buildBlobUrl(splitPath));
                            if (res.ok) {
                                pageData = await res.json();
                                ocrPageCacheRef.current[cacheKey] = pageData;
                            }
                        } catch (e) { /* ignore */ }
                    }

                    // 3) Fallback: old single JSON format
                    if (!pageData) {
                        const singleCandidates = [
                            `${meta.user_id}/json/${baseName}.json`,
                            `${meta.user_id}/json/${meta.filename}.json`,
                        ];
                        for (const candidate of singleCandidates) {
                            if (cancelled) return;
                            try {
                                const res = await fetch(buildBlobUrl(candidate));
                                if (res.ok) {
                                    const fullJson = await res.json();
                                    // Extract page data from single JSON (array of pages)
                                    const pages = Array.isArray(fullJson) ? fullJson
                                        : fullJson.analyzeResult?.pages || fullJson.pages || [];
                                    const found = pages.find(p => (p.page_number || (p.pageIndex != null ? p.pageIndex + 1 : 0)) === pdfPage)
                                        || pages[pdfPage - 1];
                                    if (found) {
                                        pageData = found;
                                        // Cache all pages from this JSON for future use
                                        pages.forEach((p, idx) => {
                                            const pn = p.page_number || (p.pageIndex != null ? p.pageIndex + 1 : idx + 1);
                                            const pk = `${meta.user_id}/${meta.filename}/${pn}`;
                                            if (!ocrPageCacheRef.current[pk]) {
                                                ocrPageCacheRef.current[pk] = p;
                                            }
                                        });
                                        break;
                                    }
                                }
                            } catch (e) { /* ignore */ }
                        }
                    }
                }

                if (cancelled) return;

                if (!pageData) {
                    setHighlightPolygons([]);
                    return;
                }

                // Match keywords against OCR lines (same logic as Dashboard)
                const lines = pageData.layout?.lines || pageData.lines || [];
                const layoutWidth = pageData.layout?.width || pageData.width || 0;
                const layoutHeight = pageData.layout?.height || pageData.height || 0;
                if (!layoutWidth || !layoutHeight || lines.length === 0) {
                    setHighlightPolygons([]);
                    return;
                }

                const searchLower = highlightKeyword.toLowerCase();
                const matchedPolygons = [];

                for (const line of lines) {
                    const content = (line.content || line.text || '').toLowerCase();
                    if (!content) continue;
                    let score = 0;
                    if (content.includes(searchLower)) score = 80;
                    else if (searchLower.includes(content) && content.length > 3) score = 60;
                    else {
                        const hits = keywords.filter(t => content.includes(t)).length;
                        if (hits > 0) score = 30 + (hits / keywords.length * 30);
                    }
                    if (score > 0) {
                        let polygon = line.polygon || line.boundingBox || [];
                        if (Array.isArray(polygon[0])) polygon = polygon.flat();
                        if (polygon.length >= 8) {
                            matchedPolygons.push({ polygon, score });
                        }
                    }
                }

                // Sort by score, take top matches
                matchedPolygons.sort((a, b) => b.score - a.score);
                const topPolygons = matchedPolygons.slice(0, 5);

                // Scale polygons: DI coordinates → canvas pixels
                const sx = canvasSize.width / layoutWidth;
                const sy = canvasSize.height / layoutHeight;

                const scaledPolygons = topPolygons.map(m => ({
                    points: m.polygon.map((v, i) => (i % 2 === 0 ? v * sx : v * sy)),
                    score: m.score
                }));

                if (!cancelled) {
                    setHighlightPolygons(scaledPolygons);
                }
            } catch (e) {
                console.error('Highlight computation error:', e);
                if (!cancelled) {
                    setHighlightRects([]);
                    setHighlightPolygons([]);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [pdfDocObj, pdfPage, highlightKeyword, canvasSize]);


    // =============================================
    // SEARCH HANDLER (AI 검색)
    // =============================================
    const handleSearch = async () => {
        if (!query.trim() || isSearching) return;
        lastQueryRef.current = query.trim();
        console.log('[KnowhowDB] Starting search:', query.trim());
        setIsSearching(true);
        setSearchResults([]);
        setSearchError(null);
        setHasSearched(true);

        try {
            const user = auth.currentUser;
            if (!user) {
                setSearchError('로그인이 필요합니다.');
                return;
            }
            const idToken = await user.getIdToken();

            const apiUrl = getChatApiUrl();
            const body = {
                query: query.trim(),
                context: null,
                doc_ids: activeDoc ? [activeDoc.name] : null,
                mode: 'search',
                ...(activeFolder && { folder: activeFolder }),
                ...(isAdmin && scopeUsers.size > 0 && { target_users: [...scopeUsers] }),
                ...(isAdmin && scopeUsers.size === 0 && (selectedUserFolder || treeActiveUser) && { target_user: selectedUserFolder || treeActiveUser })
            };
            console.log('[KnowhowDB] Search API:', apiUrl, 'body:', JSON.stringify(body));

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=UTF-8',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify(body)
            });

            console.log('[KnowhowDB] Search response status:', response.status);

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                console.error('[KnowhowDB] Search failed:', response.status, errText);
                setSearchError(`검색 실패 (${response.status}): ${errText.substring(0, 100)}`);
                return;
            }
            const data = await response.json();
            console.log('[KnowhowDB] Search results:', data.results?.length || 0);

            if (data.results && data.results.length > 0) {
                setSearchResults(data.results);
                data.results.forEach(r => {
                    if (r.filename) {
                        fileMapRef.current[r.filename] = {
                            category: r.category,
                            blob_path: r.blob_path,
                            user_id: r.user_id,
                        };
                    }
                });
            }

            if (currentUser) {
                logActivity(currentUser.uid, currentUser.email, 'KNOWHOW_SEARCH', `Query: ${query.trim().substring(0, 50)}`);
            }
        } catch (e) {
            console.error('[KnowhowDB] Search error:', e);
            setSearchError(`검색 중 오류: ${e.message}`);
        } finally {
            setIsSearching(false);
        }
    };

    // =============================================
    // CHAT HANDLER (AI 분석)
    // =============================================
    const handleChat = async () => {
        if (!query.trim() || isChatLoading) return;
        const userMessage = query.trim();
        lastQueryRef.current = userMessage;
        setQuery('');
        setChatMessages(prev => [...prev, { role: 'user', content: userMessage }]);
        setIsChatLoading(true);

        try {
            const user = auth.currentUser;
            if (!user) {
                setChatMessages(prev => [...prev, { role: 'assistant', content: '❌ 인증이 필요합니다.', isError: true }]);
                setIsChatLoading(false);
                return;
            }
            const idToken = await user.getIdToken();

            const history = chatMessages
                .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.isError))
                .slice(-20)
                .map(m => ({ role: m.role, content: m.content }));

            const response = await fetch(getChatApiUrl(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=UTF-8',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({
                    query: userMessage,
                    context: null,
                    filename: activeDoc?.name,
                    doc_ids: activeDoc ? [activeDoc.name] : null,
                    mode: 'chat',
                    history: history.length > 0 ? history : null,
                    ...(activeFolder && { folder: activeFolder }),
                    ...(isAdmin && scopeUsers.size > 0 && { target_users: [...scopeUsers] }),
                    ...(isAdmin && scopeUsers.size === 0 && (selectedUserFolder || treeActiveUser) && { target_user: selectedUserFolder || treeActiveUser })
                })
            });

            if (!response.ok) throw new Error('Chat request failed');
            const data = await response.json();

            if (data.response) {
                setChatMessages(prev => [...prev, {
                    role: 'assistant',
                    content: data.response,
                    results: data.results
                }]);
            } else {
                setChatMessages(prev => [...prev, { role: 'assistant', content: '답변을 생성하지 못했습니다.' }]);
            }

            if (data.results) {
                data.results.forEach(r => {
                    if (r.filename) {
                        fileMapRef.current[r.filename] = {
                            category: r.category,
                            blob_path: r.blob_path,
                            user_id: r.user_id,
                        };
                    }
                });
            }

            if (currentUser) {
                try {
                    await addDoc(collection(db, 'users', currentUser.uid, 'chatHistory'), {
                        query: userMessage,
                        response: data.response || '',
                        timestamp: serverTimestamp(),
                        context: 'knowhow',
                        filename: activeDoc?.name || 'All Documents'
                    });
                } catch (historyErr) {
                    console.error('Failed to save history:', historyErr);
                }
                logActivity(currentUser.uid, currentUser.email, 'KNOWHOW_CHAT', `Query: ${userMessage.substring(0, 50)}`);
            }
        } catch (e) {
            console.error('Chat error:', e);
            setChatMessages(prev => [...prev, { role: 'assistant', content: '죄송합니다. 오류가 발생했습니다.', isError: true }]);
        } finally {
            setIsChatLoading(false);
        }
    };

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatMessages]);

    // =============================================
    // SUBMIT / KEY HANDLER
    // =============================================
    const handleSubmit = () => {
        if (mode === 'search') handleSearch();
        else handleChat();
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    // =============================================
    // RESULT / CITATION CLICK → OPEN PDF
    // =============================================
    const handleResultClick = (result, overrideKeyword = null) => {
        const filename = result.filename;
        const page = result.page || 1;
        const keyword = overrideKeyword || query.trim() || lastQueryRef.current || null;
        const resultUser = result.user_id || fileMapRef.current[filename]?.user_id || browseUsername || username;
        const meta = { user_id: resultUser, filename, page, blob_path: result.blob_path || null };

        // Use blob_path directly if available (most reliable — exact path in storage)
        if (result.blob_path) {
            const url = buildBlobUrl(result.blob_path);
            openDocument(url, page, filename, keyword, meta);
            return;
        }

        // Fallback: construct URL from fileMapRef or result metadata
        const mapped = fileMapRef.current[filename];
        if (mapped?.blob_path) {
            const url = buildBlobUrl(mapped.blob_path);
            openDocument(url, page, filename, keyword, meta);
            return;
        }
        let folder = (typeof mapped === 'string' ? mapped : mapped?.category) || result.category;
        if (!folder && activeDoc && activeDoc.name === filename) folder = activeDoc.folder;
        if (!folder) folder = 'documents';

        const blobPath = `${resultUser}/${folder}/${filename}`;
        const url = buildBlobUrl(blobPath);
        openDocument(url, page, filename, keyword, meta);
    };

    const handleCitationClick = (keyword, msgResults = []) => {
        if (!keyword || keyword.length < 2) return;

        const noiseWords = ['g', 'e', 's', 't', 'c', 'd', 'p', 'i', 'v', 'l', 'r', 'o', 'm', 'n', 'u', 'k'];
        const clean = keyword.toLowerCase().trim();
        if (clean.length < 2 || noiseWords.includes(clean)) return;

        // Parse citation: "Keyword|Page X|DocName" or "DocName (Page)"
        let targetPage = 1;
        let targetDocName = null;
        let searchText = null;

        if (keyword.includes('|')) {
            const parts = keyword.split('|');
            searchText = parts[0].trim() || null;
            if (parts.length > 1) {
                const pageMatch = parts[1].trim().match(/(\d+)/);
                if (pageMatch) targetPage = parseInt(pageMatch[1]);
            }
            if (parts.length > 2) targetDocName = parts[2].trim();
        } else if (keyword.match(/(.*)\s+\((\d+)\)$/)) {
            const match = keyword.match(/(.*)\s+\((\d+)\)$/);
            targetDocName = match[1].trim();
            targetPage = parseInt(match[2]);
        }

        console.log('[Citation] parsed:', { searchText, targetDocName, targetPage, resultsCount: msgResults.length });

        // Helper: partial filename match (case-insensitive, .pdf-tolerant)
        const nameMatches = (a, b) => {
            if (!a || !b) return false;
            const al = a.toLowerCase().replace(/\.pdf$/i, '');
            const bl = b.toLowerCase().replace(/\.pdf$/i, '');
            return al.includes(bl) || bl.includes(al);
        };

        // ── Strategy 1: Match from message's results (도면분석 패턴 — 가장 신뢰) ──
        // The results array has blob_path, user_id, category — everything needed.
        if (msgResults.length > 0) {
            let matched = null;
            if (targetDocName) {
                // Match by filename + page
                matched = msgResults.find(r => nameMatches(r.filename, targetDocName) && r.page === targetPage)
                    || msgResults.find(r => nameMatches(r.filename, targetDocName));
            }
            if (!matched && targetPage > 0) {
                // Match by page only
                matched = msgResults.find(r => r.page === targetPage);
            }
            // Fallback: use first result (same chat response → likely same document)
            if (!matched && msgResults.length > 0) {
                matched = msgResults[0];
            }
            if (matched) {
                console.log('[Citation] Resolved from msgResults:', matched.filename, 'page:', targetPage, 'blob:', matched.blob_path?.slice(0, 60));
                handleResultClick({ ...matched, page: targetPage }, searchText);
                return;
            }
        }

        // ── Strategy 2: Match from files array (현재 폴더 파일) ──
        if (targetDocName) {
            const targetFile = files.find(f => nameMatches(f.name, targetDocName));
            if (targetFile) {
                console.log('[Citation] Found in files:', targetFile.name);
                const mappedUser = fileMapRef.current[targetFile.name]?.user_id || browseUsername || username;
                openDocument(targetFile.pdfUrl, targetPage, targetFile.name, searchText, { user_id: mappedUser, filename: targetFile.name, page: targetPage, blob_path: targetFile.blob_path || fileMapRef.current[targetFile.name]?.blob_path || null });
                return;
            }
        }

        // ── Strategy 3: Active document fallback ──
        if (activeDoc) {
            console.log('[Citation] Fallback to activeDoc:', activeDoc.name);
            const mappedUser = fileMapRef.current[activeDoc.name]?.user_id || browseUsername || username;
            openDocument(activeDoc.pdfUrl, targetPage, activeDoc.name, searchText, { user_id: mappedUser, filename: activeDoc.name, page: targetPage, blob_path: activeDoc.blob_path || fileMapRef.current[activeDoc.name]?.blob_path || null });
            return;
        }

        // ── Strategy 4: Navigate currently open PDF (이미 열린 문서로 페이지 이동) ──
        if (currentPdfUrlRef.current && pdfDocObj) {
            console.log('[Citation] Fallback: navigating current PDF to page', targetPage, 'keyword:', searchText);
            const currentMeta = highlightMetaRef.current;
            openDocument(currentPdfUrlRef.current, targetPage, currentMeta?.filename || '', searchText, currentMeta);
        }
    };

    // Keep ref always pointing to latest handleCitationClick (avoids stale closure in ReactMarkdown buttons)
    citationHandlerRef.current = handleCitationClick;

    // =============================================
    // UPLOAD HANDLER
    // =============================================
    const handleFileSelect = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';
        setIsUploading(true);
        setUploadStatus('Reading file...');

        try {
            const totalPages = await countPdfPages(file);
            setUploadStatus('Preparing upload...');
            const { upload_url } = await getUploadSas(file.name, username);
            await uploadToAzure(upload_url, file, (percent) => setUploadStatus(`Uploading... ${percent}%`));
            setUploadStatus('Starting analysis...');
            await startAnalysis(file.name, totalPages, username, 'my-documents');

            await pollAnalysisStatus(file.name, (statusData) => {
                if (statusData.status === 'in_progress' || statusData.status === 'finalizing') {
                    const completedChunks = statusData.completed_chunks || [];
                    let pagesCompleted = 0;
                    for (const chunkRange of completedChunks) {
                        const [start, end] = chunkRange.split('-').map(Number);
                        pagesCompleted += (end - start + 1);
                    }
                    setUploadStatus(`Processing... (${pagesCompleted}/${totalPages} pages)`);
                }
            }, totalPages);

            setUploadStatus('Done!');
            if (activeFolder === 'my-documents') await loadFiles('my-documents');
        } catch (error) {
            console.error('Upload failed:', error);
            alert(`Upload failed: ${error.message}`);
        } finally {
            setIsUploading(false);
            setUploadStatus('');
        }
    };

    // =============================================
    // RESIZE HANDLERS (Left + Right sidebars)
    // =============================================
    const startResize = useCallback(() => {
        resizingRef.current = true;
        setIsResizing(true);
    }, []);

    const startLeftResize = useCallback(() => {
        leftResizingRef.current = true;
        setIsLeftResizing(true);
    }, []);

    const startDividerResize = useCallback(() => {
        dividerResizingRef.current = true;
        setIsDividerResizing(true);
    }, []);

    const stopAllResize = useCallback(() => {
        resizingRef.current = false;
        leftResizingRef.current = false;
        dividerResizingRef.current = false;
        setIsResizing(false);
        setIsLeftResizing(false);
        setIsDividerResizing(false);
    }, []);

    const onResizeMove = useCallback((e) => {
        if (resizingRef.current) {
            const newWidth = window.innerWidth - e.clientX;
            if (newWidth > 300 && newWidth < 1200) setRightWidth(newWidth);
        }
        if (leftResizingRef.current) {
            const newWidth = e.clientX;
            if (newWidth > 240 && newWidth < 600) setLeftWidth(newWidth);
        }
        if (dividerResizingRef.current && sidebarRef.current) {
            const sidebarRect = sidebarRef.current.getBoundingClientRect();
            // Calculate folder height relative to sidebar top
            // Account for header + user selector above the folders
            const foldersTop = sidebarRef.current.querySelector('[data-folders]')?.getBoundingClientRect().top || sidebarRect.top;
            const newHeight = e.clientY - foldersTop;
            const maxHeight = sidebarRect.height * 0.8;
            if (newHeight > 80 && newHeight < maxHeight) setFolderHeight(newHeight);
        }
    }, []);

    useEffect(() => {
        const anyResizing = isResizing || isLeftResizing || isDividerResizing;
        if (anyResizing) {
            document.body.style.cursor = isDividerResizing ? 'row-resize' : 'col-resize';
            document.body.style.userSelect = 'none';
        } else {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
        window.addEventListener('mousemove', onResizeMove);
        window.addEventListener('mouseup', stopAllResize);
        return () => {
            window.removeEventListener('mousemove', onResizeMove);
            window.removeEventListener('mouseup', stopAllResize);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
    }, [onResizeMove, stopAllResize, isResizing, isLeftResizing, isDividerResizing]);

    // =============================================
    // CHAT HISTORY PERSISTENCE
    // =============================================
    const chatStorageKey = `knowhow_chat_${scopeUsers.size > 0 ? [...scopeUsers].sort().join(',') : activeDoc?.name || 'all'}`;

    useEffect(() => {
        if (mode !== 'chat') return;
        const saved = localStorage.getItem(chatStorageKey);
        if (saved) {
            try {
                setChatMessages(JSON.parse(saved));
            } catch {
                setChatMessages([{ role: 'assistant', content: '안녕하세요! 문서에 대해 궁금한 점을 물어보세요.' }]);
            }
        } else {
            const scopeDesc = scopeUsers.size > 0
                ? `${[...scopeUsers].join(', ')} 사용자`
                : activeDoc
                    ? `"${activeDoc.name}"`
                    : null;
            setChatMessages([{
                role: 'assistant',
                content: scopeDesc
                    ? `안녕하세요! ${scopeDesc}에 대해 궁금한 점을 물어보세요.`
                    : '안녕하세요! 문서에 대해 궁금한 점을 물어보세요.'
            }]);
        }
    }, [chatStorageKey, mode]);

    useEffect(() => {
        if (mode === 'chat' && chatMessages.length > 1) {
            localStorage.setItem(chatStorageKey, JSON.stringify(chatMessages));
        }
    }, [chatMessages, chatStorageKey, mode]);

    const handleResetChat = () => {
        if (!confirm('대화 내용을 초기화 하시겠습니까?')) return;
        localStorage.removeItem(chatStorageKey);
        const scopeDesc = scopeUsers.size > 0
            ? `${[...scopeUsers].join(', ')} 사용자`
            : activeDoc
                ? `"${activeDoc.name}"`
                : null;
        setChatMessages([{
            role: 'assistant',
            content: scopeDesc
                ? `안녕하세요! ${scopeDesc}에 대해 궁금한 점을 물어보세요.`
                : '안녕하세요! 문서에 대해 궁금한 점을 물어보세요.'
        }]);
    };

    // =============================================
    // MARKDOWN + CITATIONS — copied from ChatInterface.jsx (proven working)
    // =============================================
    const processCitations = (text) => {
        return text.replace(/(`*)\[\[(.*?)\]\]\1/g, (match, backticks, p1) => {
            const cleanText = p1.includes('|') ? p1.split('|')[0].trim() + ' (' + p1.split('|')[1].trim() + ')' : p1;
            return `[${cleanText.replace(/\|/g, '\\|')}](#citation-${encodeURIComponent(p1)})`;
        });
    };

    // =============================================
    // RENDER
    // =============================================
    return (
        <div className="flex h-screen bg-[#fcfaf7] overflow-hidden font-sans">
            {/* ===== LEFT SIDEBAR ===== */}
            <div ref={sidebarRef} className="bg-[#f0f4f9] border-r border-gray-200 flex flex-col flex-shrink-0 h-full relative" style={{ width: leftWidth }}>
                {/* Left Resize Handle */}
                <div
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-400 z-50 transition-colors"
                    onMouseDown={startLeftResize}
                />
                {/* Header */}
                <div className="p-4 border-b border-gray-200">
                    <h1 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                        <Database className="w-5 h-5 text-[#d97757]" />
                        Knowhow DB
                    </h1>
                </div>

                {/* Admin User Folder Selector */}
                {isAdmin && userFolders.length > 0 && (
                    <div className="px-3 py-2 border-b border-gray-200">
                        <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">사용자 선택</div>
                        <select
                            value={selectedUserFolder || ''}
                            onChange={(e) => {
                                setSelectedUserFolder(e.target.value || null);
                                setActiveFolder(null);
                                setActiveDoc(null);
                                setFiles([]);
                                setTreeActiveUser(null);
                                setExpandedUsers(new Set());
                                setScopeUsers(new Set());
                            }}
                            className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#d97757] focus:ring-1 focus:ring-[#d97757] transition-colors"
                        >
                            <option value="">전체 (모든 사용자)</option>
                            {userFolders.map(name => (
                                <option key={name} value={name}>{name}</option>
                            ))}
                        </select>
                    </div>
                )}

                {/* Folders */}
                <div data-folders className="overflow-y-auto px-3 py-2 min-h-[80px]" style={activeFolder ? { height: folderHeight || undefined, maxHeight: folderHeight ? undefined : '40%', flexShrink: 0 } : undefined}>
                    <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">Folders</div>
                    {isAdmin && !selectedUserFolder ? (
                        /* Tree mode: show all users with expandable subfolders */
                        <div className="space-y-0.5">
                            {userFolders.map(user => (
                                <div key={user}>
                                    <div className="flex items-center gap-0.5">
                                        <button
                                            onClick={() => toggleTreeUser(user)}
                                            className="p-1.5 rounded hover:bg-gray-200 transition-colors"
                                        >
                                            <ChevronRight className={`w-3 h-3 text-gray-500 transition-transform ${expandedUsers.has(user) ? 'rotate-90' : ''}`} />
                                        </button>
                                        <button
                                            onClick={() => {
                                                setScopeUsers(prev => {
                                                    const next = new Set(prev);
                                                    if (next.has(user)) next.delete(user);
                                                    else next.add(user);
                                                    return next;
                                                });
                                                if (!expandedUsers.has(user)) toggleTreeUser(user);
                                            }}
                                            className={`flex-1 flex items-center gap-2 px-2 py-2 rounded-lg text-sm transition-colors ${scopeUsers.has(user)
                                                ? 'bg-blue-100 text-blue-700 font-medium'
                                                : 'text-gray-600 hover:bg-gray-200'
                                                }`}
                                        >
                                            {scopeUsers.has(user)
                                                ? <><FolderOpen className="w-4 h-4 flex-shrink-0" /><Check className="w-3.5 h-3.5 flex-shrink-0 text-blue-600" /></>
                                                : <Folder className="w-4 h-4 flex-shrink-0" />
                                            }
                                            <span className="truncate">{user}</span>
                                        </button>
                                    </div>
                                    {expandedUsers.has(user) && userSubFolders[user]?.map(folder => (
                                        <button
                                            key={folder.name}
                                            onClick={() => {
                                                if (treeActiveUser === user && activeFolder === folder.name) {
                                                    setActiveFolder(null);
                                                    setActiveDoc(null);
                                                    setFiles([]);
                                                } else {
                                                    setTreeActiveUser(user);
                                                    setActiveFolder(folder.name);
                                                    setActiveDoc(null);
                                                }
                                            }}
                                            className={`w-full flex items-center gap-2 pl-10 pr-3 py-1.5 rounded-lg text-sm transition-colors ${activeFolder === folder.name && treeActiveUser === user
                                                ? 'bg-gray-200 text-blue-700 font-medium'
                                                : 'text-gray-500 hover:bg-gray-200'
                                                }`}
                                        >
                                            {activeFolder === folder.name && treeActiveUser === user
                                                ? <FolderOpen className="w-3.5 h-3.5 flex-shrink-0" />
                                                : <Folder className="w-3.5 h-3.5 flex-shrink-0" />
                                            }
                                            <span className="truncate">{folder.name}</span>
                                        </button>
                                    ))}
                                </div>
                            ))}
                            {userFolders.length === 0 && (
                                <div className="text-xs text-gray-400 italic px-3 py-2">Loading...</div>
                            )}
                        </div>
                    ) : (
                        /* Flat mode: show selected user's folders */
                        <div className="space-y-0.5">
                            {folders.map((folder) => (
                                <button
                                    key={folder.name}
                                    onClick={() => setActiveFolder(activeFolder === folder.name ? null : folder.name)}
                                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${activeFolder === folder.name
                                        ? 'bg-blue-100 text-blue-700 font-medium'
                                        : 'text-gray-600 hover:bg-gray-200'
                                        }`}
                                >
                                    {activeFolder === folder.name
                                        ? <FolderOpen className="w-4 h-4 flex-shrink-0" />
                                        : <Folder className="w-4 h-4 flex-shrink-0" />
                                    }
                                    <span className="truncate">{folder.name}</span>
                                </button>
                            ))}
                            {folders.length === 0 && (
                                <div className="text-xs text-gray-400 italic px-3 py-2">Loading folders...</div>
                            )}
                        </div>
                    )}
                </div>

                {activeFolder && (
                    <div
                        className="flex-shrink-0 mx-3 cursor-row-resize group relative"
                        onMouseDown={startDividerResize}
                    >
                        <div className="border-t border-gray-300 group-hover:border-blue-400 transition-colors" />
                        <div className="absolute inset-x-0 -top-1 -bottom-1" />
                    </div>
                )}

                {/* Files */}
                <div className="flex-1 overflow-y-auto px-3 py-2">
                    {activeFolder && (
                        <>
                            <div className="flex items-center justify-between mb-2 px-1">
                                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Files</div>
                                <div className="flex items-center gap-1">
                                    {isAdmin && activeFolder !== 'revision' && activeFolder !== 'lessons' && files.some(f => { const s = indexStatus[f.name]; return !s || (!s.json_exists && !(s.indexed_pages > 0)); }) && (
                                        <button
                                            onClick={handleAnalyzeAll}
                                            disabled={isAnalyzingAll || isUploading}
                                            className="flex items-center gap-1 px-2 py-1 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded text-xs font-medium transition-colors"
                                            title="Analyze all un-analyzed files"
                                        >
                                            <Sparkles className="w-3 h-3" />
                                            {isAnalyzingAll ? 'Analyzing...' : 'Analyze All'}
                                        </button>
                                    )}
                                    {isAdmin && activeFolder !== 'revision' && activeFolder !== 'lessons' && files.some(f => indexStatus[f.name]?.json_exists && !indexStatus[f.name]?.indexed_pages) && (
                                        <button
                                            onClick={handleIndexAll}
                                            disabled={isIndexingAll || isReindexing}
                                            className="flex items-center gap-1 px-2 py-1 bg-orange-500 hover:bg-orange-600 disabled:bg-gray-400 text-white rounded text-xs font-medium transition-colors"
                                            title="Index all un-indexed files"
                                        >
                                            <Database className="w-3 h-3" />
                                            {isIndexingAll ? 'Indexing...' : 'Index All'}
                                        </button>
                                    )}
                                    {activeFolder === 'my-documents' && (
                                        <button
                                            onClick={() => fileInputRef.current?.click()}
                                            disabled={isUploading}
                                            className="flex items-center gap-1 px-2 py-1 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded text-xs font-medium transition-colors"
                                        >
                                            <Upload className="w-3 h-3" />
                                            Upload
                                        </button>
                                    )}
                                </div>
                            </div>
                            {loadingFiles ? (
                                <div className="flex items-center gap-2 text-xs text-gray-400 px-3 py-4">
                                    <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                                </div>
                            ) : files.length === 0 ? (
                                <div className="text-xs text-gray-400 italic px-3 py-2">No files found.</div>
                            ) : (
                                <div className="space-y-0.5">
                                    {files.map((file) => {
                                        const fStatus = isAdmin ? indexStatus[file.name] : null;
                                        return (
                                            <div
                                                key={file.name}
                                                className={`group flex items-center gap-2 px-3 py-2 rounded-lg text-xs cursor-pointer transition-colors ${activeDoc?.name === file.name
                                                    ? 'bg-blue-100 text-blue-700 font-medium'
                                                    : 'text-gray-600 hover:bg-gray-200'
                                                    }`}
                                            >
                                                <div
                                                    className="flex-1 flex items-center gap-2 min-w-0"
                                                    onClick={() => {
                                                        setActiveDoc(file);
                                                        openDocument(file.pdfUrl, 1, file.name);
                                                    }}
                                                >
                                                    <FileText className="w-3.5 h-3.5 flex-shrink-0" />
                                                    <span className="truncate">{file.name}</span>
                                                    {/* Index status indicator (admin only) */}
                                                    {isAdmin && (
                                                        fStatus?.indexed_pages > 0 ? (
                                                            <span className="flex-shrink-0 text-green-600 font-bold text-[10px]" title={`Indexed: ${fStatus.indexed_pages} pages`}>●{fStatus.indexed_pages}p</span>
                                                        ) : fStatus?.json_exists ? (
                                                            <span className="flex-shrink-0 bg-amber-100 text-amber-700 font-medium text-[9px] px-1 rounded" title="JSON exists, not indexed">미인덱싱</span>
                                                        ) : (
                                                            <span className="flex-shrink-0 text-gray-300 text-[10px]" title="Not analyzed">●</span>
                                                        )
                                                    )}
                                                </div>
                                                {/* Admin reindex button - for un-indexed files with JSON (not for revision/lessons) */}
                                                {isAdmin && activeFolder !== 'revision' && activeFolder !== 'lessons' && fStatus?.json_exists && !fStatus?.indexed_pages && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleReindex(file);
                                                        }}
                                                        disabled={isReindexing}
                                                        className={`hidden group-hover:flex p-1 hover:bg-orange-100 rounded text-orange-600 transition-colors ${reindexingFile === file.name ? '!flex animate-spin' : ''
                                                            }`}
                                                        title="Reindex from JSON"
                                                    >
                                                        <RefreshCcw className="w-3 h-3" />
                                                    </button>
                                                )}
                                                {/* Admin analyze button - for files without JSON and not indexed (not for revision/lessons) */}
                                                {isAdmin && activeFolder !== 'revision' && activeFolder !== 'lessons' && !fStatus?.json_exists && !(fStatus?.indexed_pages > 0) && (
                                                    <button
                                                        onClick={async (e) => {
                                                            e.stopPropagation();
                                                            if (!confirm(`Analyze "${file.name}"?`)) return;
                                                            setIsUploading(true);
                                                            setUploadStatus(`Analyzing ${file.name}...`);
                                                            try {
                                                                let totalPages = 1;
                                                                try {
                                                                    const pdfjs = await loadPdfJs();
                                                                    const pdf = await pdfjs.getDocument(file.pdfUrl).promise;
                                                                    totalPages = pdf.numPages;
                                                                } catch { }
                                                                const blobName = `${browseUsername}/${activeFolder}/${file.name}`;
                                                                await startAnalysis(file.name, totalPages, browseUsername, activeFolder, true, blobName);
                                                                await pollAnalysisStatus(file.name, (statusData) => {
                                                                    if (statusData.status === 'in_progress' || statusData.status === 'finalizing') {
                                                                        const completed = statusData.completed_chunks || [];
                                                                        let done = 0;
                                                                        for (const c of completed) {
                                                                            const [s, en] = c.split('-').map(Number);
                                                                            done += (en - s + 1);
                                                                        }
                                                                        setUploadStatus(`Analyzing ${file.name}... (${done}/${totalPages}p)`);
                                                                    }
                                                                }, totalPages);
                                                                setUploadStatus('Done!');
                                                                await loadIndexStatus(browseUsername, activeFolder);
                                                            } catch (err) {
                                                                alert('Analysis failed: ' + err.message);
                                                            } finally {
                                                                setIsUploading(false);
                                                                setUploadStatus('');
                                                            }
                                                        }}
                                                        disabled={isUploading}
                                                        className="flex p-1 hover:bg-blue-100 rounded text-blue-600 transition-colors"
                                                        title="Analyze & Index"
                                                    >
                                                        <Sparkles className="w-3 h-3" />
                                                    </button>
                                                )}
                                                {activeFolder === 'my-documents' && (
                                                    <button
                                                        onClick={async (e) => {
                                                            e.stopPropagation();
                                                            if (!confirm(`Re-analyze "${file.name}"?`)) return;
                                                            setIsUploading(true);
                                                            setUploadStatus(`Re-analyzing ${file.name}...`);
                                                            try {
                                                                let totalPages = 1;
                                                                try {
                                                                    const pdfjs = await loadPdfJs();
                                                                    const pdf = await pdfjs.getDocument(file.pdfUrl).promise;
                                                                    totalPages = pdf.numPages;
                                                                } catch { }
                                                                await startAnalysis(file.name, totalPages, username, 'my-documents', true);
                                                                await pollAnalysisStatus(file.name, () => { }, totalPages);
                                                                loadFiles('my-documents');
                                                            } catch (err) {
                                                                alert('Re-analysis failed: ' + err.message);
                                                            } finally {
                                                                setIsUploading(false);
                                                                setUploadStatus('');
                                                            }
                                                        }}
                                                        className="hidden group-hover:flex p-1 hover:bg-blue-200 rounded text-blue-600 transition-colors"
                                                        title="Re-analyze"
                                                    >
                                                        <RefreshCcw className="w-3 h-3" />
                                                    </button>
                                                )}
                                                {(activeFolder === 'my-documents' || isAdmin) && (
                                                    <button
                                                        onClick={async (e) => {
                                                            e.stopPropagation();
                                                            if (!confirm(`Delete "${file.name}"?`)) return;
                                                            try {
                                                                const res = await fetch(
                                                                    `${API_BASE}/api/v1/analyze/doc/${encodeURIComponent(file.name)}?username=${encodeURIComponent(browseUsername)}&category=${encodeURIComponent(activeFolder)}`,
                                                                    { method: 'DELETE' }
                                                                );
                                                                if (res.ok) {
                                                                    loadFiles(activeFolder);
                                                                    loadIndexStatus(browseUsername, activeFolder);
                                                                    if (activeDoc?.name === file.name) setActiveDoc(null);
                                                                } else {
                                                                    throw new Error('Delete failed');
                                                                }
                                                            } catch (err) {
                                                                alert('Delete failed: ' + err.message);
                                                            }
                                                        }}
                                                        className="hidden group-hover:flex p-1 hover:bg-red-100 rounded text-red-500 transition-colors"
                                                        title="Delete"
                                                    >
                                                        <Trash2 className="w-3 h-3" />
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Upload Status */}
                {isUploading && (
                    <div className="px-4 py-2 bg-blue-50 border-t border-blue-100 text-xs text-blue-700 flex items-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span className="truncate">{uploadStatus}</span>
                    </div>
                )}

                {/* Reindex Status */}
                {isReindexing && reindexingFile && (
                    <div className="px-4 py-2 bg-orange-50 border-t border-orange-100 text-xs text-orange-700 flex items-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span className="truncate">Reindexing: {reindexingFile}</span>
                    </div>
                )}

                {/* Bottom */}
                <div className="border-t border-gray-200">
                    <button onClick={() => navigate('/')} className="w-full flex items-center gap-2 px-4 py-3 text-sm text-gray-600 hover:bg-gray-100 transition-colors">
                        <ArrowLeft className="w-4 h-4" /> Return to Home
                    </button>
                    <div className="p-4 flex items-center gap-3 border-t border-gray-200">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-orange-400 to-red-500 flex items-center justify-center text-white font-bold text-xs flex-shrink-0">
                            {username?.charAt(0)?.toUpperCase() || 'U'}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">{currentUser?.displayName || 'User'}</p>
                            <p className="text-xs text-gray-500 truncate">{currentUser?.email}</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Hidden File Input */}
            <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" accept=".pdf" />

            {/* ===== CENTER AREA ===== */}
            <div className="flex-1 flex flex-col h-full min-w-0">
                {/* Mode Tabs */}
                <div className="h-12 border-b border-[#e5e1d8] bg-white flex items-center px-4 gap-1 flex-shrink-0">
                    <button
                        onClick={() => setMode('search')}
                        className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${mode === 'search' ? 'bg-[#d97757] text-white' : 'text-gray-500 hover:bg-gray-100'
                            }`}
                    >
                        <SearchIcon className="w-4 h-4" /> AI 검색
                    </button>
                    <button
                        onClick={() => setMode('chat')}
                        className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${mode === 'chat' ? 'bg-[#d97757] text-white' : 'text-gray-500 hover:bg-gray-100'
                            }`}
                    >
                        <MessageSquare className="w-4 h-4" /> AI 분석
                    </button>

                    <div className="ml-auto flex items-center gap-2">
                        {scopeUsers.size > 0 && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
                                <SearchIcon className="w-3 h-3" />
                                <span>{scopeUsers.size}명 사용자 선택</span>
                                <button onClick={() => setScopeUsers(new Set())} className="hover:text-red-500"><X className="w-3 h-3" /></button>
                            </div>
                        )}
                        {activeDoc && !scopeUsers.size && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
                                <FileText className="w-3 h-3" />
                                <span className="truncate max-w-[200px]">{activeDoc.name}</span>
                                <button onClick={() => setActiveDoc(null)} className="hover:text-red-500"><X className="w-3 h-3" /></button>
                            </div>
                        )}
                        {mode === 'chat' && (
                            <button onClick={handleResetChat} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-400 hover:text-[#d97757]" title="대화 초기화">
                                <RefreshCcw size={14} />
                            </button>
                        )}
                    </div>
                </div>

                {/* Scope Bar */}
                {scopeUsers.size > 0 && (
                    <div className="px-4 py-2 bg-blue-50 border-b border-blue-200 flex items-center gap-2 flex-wrap flex-shrink-0">
                        <span className="text-xs font-medium text-blue-600">검색 범위:</span>
                        {[...scopeUsers].map(u => (
                            <span key={`su-${u}`} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs">
                                <User className="w-3 h-3" />
                                {u}
                                <button onClick={() => setScopeUsers(prev => { const n = new Set(prev); n.delete(u); return n; })} className="hover:text-red-500"><X className="w-3 h-3" /></button>
                            </span>
                        ))}
                        <button
                            onClick={() => setScopeUsers(new Set())}
                            className="text-xs text-blue-500 hover:text-blue-700 ml-1 underline"
                        >
                            초기화
                        </button>
                    </div>
                )}

                {/* Content Area */}
                <div className="flex-1 overflow-y-auto p-4 bg-[#f9f8f6]">
                    {mode === 'search' ? (
                        /* ===== SEARCH RESULTS ===== */
                        <div className="max-w-3xl mx-auto">
                            {isSearching ? (
                                <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                                    <Loader2 className="w-8 h-8 animate-spin text-[#d97757] mb-3" />
                                    <span className="text-sm">검색 중...</span>
                                </div>
                            ) : searchError ? (
                                <div className="flex flex-col items-center justify-center py-20">
                                    <div className="bg-red-50 border border-red-200 rounded-xl p-4 max-w-md text-center">
                                        <p className="text-sm text-red-600 font-medium mb-1">검색 오류</p>
                                        <p className="text-xs text-red-500">{searchError}</p>
                                    </div>
                                </div>
                            ) : searchResults.length > 0 ? (
                                <div className="space-y-3">
                                    <div className="text-xs font-medium text-gray-500 mb-2">
                                        {searchResults.length}개 결과
                                    </div>
                                    {searchResults.map((result, i) => (
                                        <div
                                            key={i}
                                            onClick={() => handleResultClick(result)}
                                            className="bg-white border border-gray-200 rounded-xl p-4 hover:shadow-md hover:border-blue-300 transition-all cursor-pointer group"
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 mb-1.5">
                                                        <FileText className="w-4 h-4 text-[#d97757] flex-shrink-0" />
                                                        {result.type === 'revision' ? (
                                                            <span className="flex-shrink-0 px-1.5 py-0.5 text-[9px] font-bold rounded bg-purple-100 text-purple-700">REV</span>
                                                        ) : result.type === 'lessons' ? (
                                                            <span className="flex-shrink-0 px-1.5 py-0.5 text-[9px] font-bold rounded bg-teal-100 text-teal-700">LL</span>
                                                        ) : result.category === 'drawings' ? (
                                                            <span className="flex-shrink-0 px-1.5 py-0.5 text-[9px] font-bold rounded bg-blue-100 text-blue-700">DWG</span>
                                                        ) : result.category === 'documents' ? (
                                                            <span className="flex-shrink-0 px-1.5 py-0.5 text-[9px] font-bold rounded bg-amber-100 text-amber-700">DOC</span>
                                                        ) : null}
                                                        <span className="text-sm font-medium text-gray-800 truncate">{result.filename || 'Unknown'}</span>
                                                        <span className="text-xs text-gray-400 flex-shrink-0">{result.page ? `Page ${result.page}` : ''}</span>
                                                    </div>
                                                    {result.highlight ? (
                                                        <p className="text-sm text-gray-600 leading-relaxed line-clamp-4 search-highlight"
                                                            dangerouslySetInnerHTML={{ __html: result.highlight }} />
                                                    ) : (
                                                        <p className="text-sm text-gray-600 leading-relaxed line-clamp-3">
                                                            {result.content || 'No preview available'}
                                                        </p>
                                                    )}
                                                </div>
                                                {result.score != null && (
                                                    <div className={`flex-shrink-0 px-2 py-1 text-xs font-medium rounded ${result.score >= 200 ? 'bg-green-50 text-green-700' :
                                                        result.score >= 100 ? 'bg-blue-50 text-blue-700' :
                                                            'bg-gray-50 text-gray-500'
                                                        }`}>
                                                        {result.score >= 200 ? '높음' : result.score >= 100 ? '보통' : '낮음'}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : hasSearched ? (
                                <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                                    <SearchIcon className="w-12 h-12 mb-3 opacity-30" />
                                    <p className="text-sm">검색 결과가 없습니다</p>
                                    <p className="text-xs mt-1 text-gray-300">다른 키워드로 검색해보세요</p>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                                    <SearchIcon className="w-12 h-12 mb-3 opacity-30" />
                                    <p className="text-sm">검색어를 입력하고 Enter를 누르세요</p>
                                    <p className="text-xs mt-1 text-gray-300">Azure AI Search를 활용한 키워드 검색</p>
                                </div>
                            )}
                        </div>
                    ) : (
                        /* ===== CHAT MESSAGES ===== */
                        <div className="max-w-3xl mx-auto space-y-4">
                            {chatMessages.map((msg, idx) => (
                                <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === 'user' ? 'bg-[#333333]' : 'bg-[#d97757]'
                                        }`}>
                                        {msg.role === 'user'
                                            ? <User size={14} className="text-white" />
                                            : <Bot size={14} className="text-white" />
                                        }
                                    </div>
                                    <div className={`max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed shadow-sm ${msg.role === 'user'
                                        ? '!bg-[#333333] !text-white rounded-tr-none'
                                        : msg.isError
                                            ? 'bg-red-50 text-red-600 border border-red-100 rounded-tl-none'
                                            : 'bg-white text-[#333333] border border-[#e5e1d8] rounded-tl-none'
                                        }`}>
                                        {msg.role === 'user' ? msg.content : (
                                            <div onClickCapture={(e) => {
                                                const btn = e.target.closest('[data-citation]');
                                                if (!btn) return;
                                                e.preventDefault();
                                                e.stopPropagation();
                                                const raw = btn.getAttribute('data-citation');

                                                // 항상 citationHandlerRef 통해 문서 매칭 시도 (이미 열린 문서인지 확인도 그 안에서 처리됨)
                                                citationHandlerRef.current(raw, msg.results || []);
                                                return;


                                            }}>
                                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                                                    table: ({ node, ...props }) => <div className="overflow-x-auto my-2"><table className="border-collapse border border-gray-300 w-full text-xs" {...props} /></div>,
                                                    thead: ({ node, ...props }) => <thead className="bg-gray-100" {...props} />,
                                                    th: ({ node, ...props }) => <th className="border border-gray-300 px-3 py-2 font-semibold text-left" {...props} />,
                                                    td: ({ node, ...props }) => <td className="border border-gray-300 px-3 py-2" {...props} />,
                                                    ul: ({ node, ...props }) => <ul className="list-disc pl-4 my-2 space-y-1" {...props} />,
                                                    ol: ({ node, ...props }) => <ol className="list-decimal pl-4 my-2 space-y-1" {...props} />,
                                                    li: ({ node, ...props }) => <li className="leading-relaxed" {...props} />,
                                                    p: ({ node, ...props }) => <p className="mb-2 last:mb-0 leading-relaxed" {...props} />,
                                                    strong: ({ node, ...props }) => <strong className="font-bold text-[#333333]" {...props} />,
                                                    code: ({ node, inline, ...props }) => inline
                                                        ? <code className="bg-gray-100 px-1 py-0.5 rounded font-mono text-xs" {...props} />
                                                        : <code className="block bg-gray-100 p-2 rounded font-mono text-xs overflow-x-auto my-2" {...props} />,
                                                    a: ({ node, href, children, ...props }) => {
                                                        if (href?.startsWith('#citation-')) {
                                                            const keyword = decodeURIComponent(href.replace('#citation-', ''));
                                                            return (
                                                                <button
                                                                    data-citation={keyword}
                                                                    className="mx-1 px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded cursor-pointer hover:bg-blue-100 font-medium inline-flex items-center gap-0.5 text-xs transition-colors border border-blue-200 relative z-10"
                                                                    title={`"${keyword}" 위치 찾기`}
                                                                >
                                                                    <Sparkles size={10} />
                                                                    {children}
                                                                </button>
                                                            );
                                                        }
                                                        return <a href={href} className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
                                                    }
                                                }}>
                                                    {processCitations(msg.content)}
                                                </ReactMarkdown>
                                            </div>
                                        )}
                                        {msg.role === 'assistant' && msg.results && msg.results.length > 0 && (
                                            <div className="mt-4 pt-3 border-t border-gray-100">
                                                <div className="flex items-center gap-1.5 text-[10px] font-bold text-gray-400 mb-2 uppercase tracking-wider">
                                                    <List size={10} /> 출처 (Sources)
                                                </div>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {msg.results.map((res, rIdx) => (
                                                        <button
                                                            key={rIdx}
                                                            onClick={() => handleResultClick(res)}
                                                            className="flex items-center gap-1 px-2 py-1 bg-[#f4f1ea] hover:bg-[#e5e1d8] text-[#d97757] text-[10px] font-medium rounded-md border border-[#e5e1d8]/50 transition-colors max-w-[180px] truncate"
                                                            title={`${res.filename} - Page ${res.page}`}
                                                        >
                                                            <Sparkles size={8} />
                                                            <span className="truncate">{res.filename}</span>
                                                            <span className="text-gray-400 font-normal ml-0.5">p.{res.page}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                            {isChatLoading && (
                                <div className="flex gap-3">
                                    <div className="w-8 h-8 rounded-full bg-[#d97757] flex items-center justify-center flex-shrink-0">
                                        <Bot size={14} className="text-white" />
                                    </div>
                                    <div className="bg-white border border-[#e5e1d8] p-3 rounded-2xl rounded-tl-none shadow-sm flex items-center gap-2">
                                        <Loader2 size={14} className="animate-spin text-[#d97757]" />
                                        <span className="text-xs text-[#666666]">Thinking...</span>
                                    </div>
                                </div>
                            )}
                            <div ref={messagesEndRef} />
                        </div>
                    )}
                </div>

                {/* Input Area */}
                <div className="p-4 bg-white border-t border-[#e5e1d8] flex-shrink-0">
                    <div className="max-w-3xl mx-auto relative">
                        <textarea
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={
                                mode === 'search'
                                    ? (scopeUsers.size > 0
                                        ? `${[...scopeUsers].join(', ')} 사용자 문서에서 검색...`
                                        : activeDoc
                                            ? `"${activeDoc.name}" 내 검색...`
                                            : '전체 문서 검색...')
                                    : (scopeUsers.size > 0
                                        ? `${[...scopeUsers].join(', ')} 사용자 문서에 대해 질문...`
                                        : activeDoc
                                            ? `"${activeDoc.name}"에 대해 질문...`
                                            : '문서에 대해 질문...')
                            }
                            className="w-full bg-[#f4f1ea] border border-[#e5e1d8] rounded-xl py-3 pl-4 pr-12 text-sm focus:outline-none focus:border-[#d97757] focus:ring-1 focus:ring-[#d97757] transition-all resize-none h-[50px] max-h-[120px] overflow-y-auto placeholder-[#a0a0a0]"
                            disabled={isSearching || isChatLoading}
                        />
                        <button
                            onClick={handleSubmit}
                            disabled={!query.trim() || isSearching || isChatLoading}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-[#d97757] text-white rounded-lg hover:bg-[#c05535] disabled:opacity-50 transition-colors"
                        >
                            <Send size={14} />
                        </button>
                    </div>
                </div>
            </div>

            {/* ===== RIGHT SIDEBAR - PDF VIEWER ===== */}
            <div
                className="bg-white border-l border-[#e5e1d8] flex flex-col flex-shrink-0 overflow-hidden relative"
                style={{
                    width: rightOpen ? rightWidth : 0,
                    transition: isResizing ? 'none' : 'width 300ms ease'
                }}
            >
                {/* Resize Handle */}
                <div
                    className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-400 z-50 transition-colors"
                    onMouseDown={startResize}
                />

                {/* PDF / Office Viewer — uses the SAME PDFViewer component as Dashboard */}
                {viewerType === 'office' && officeUrl ? (
                    <>
                        <div className="h-12 border-b border-[#e5e1d8] flex items-center justify-between px-4 bg-[#fcfaf7] flex-shrink-0">
                            <span className="text-sm font-semibold text-gray-700">Document Viewer</span>
                            <button onClick={() => { setRightOpen(false); setViewerType(null); setOfficeUrl(null); }} className="p-1 hover:bg-gray-200 rounded text-gray-500">
                                <X size={16} />
                            </button>
                        </div>
                        <iframe src={officeUrl} className="flex-1 w-full border-0" allowFullScreen />
                    </>
                ) : currentPdfUrlRef.current ? (
                    <PDFViewer
                        doc={{ page: pdfPage, docId: currentPdfUrlRef.current, term: highlightKeyword || undefined }}
                        documents={[{ id: currentPdfUrlRef.current, name: highlightMetaRef.current?.filename || 'PDF', pdfUrl: currentPdfUrlRef.current }]}
                        onClose={() => { setRightOpen(false); setViewerType(null); }}
                        onCanvasSizeChange={(size) => setCanvasSize(size)}
                        overlay={(cs) => (highlightRects.length > 0 || highlightPolygons.length > 0) ? (() => {
                            // Compute center of first highlight for animated target
                            let cx = 0, cy = 0;
                            if (highlightRects.length > 0) {
                                const r = highlightRects[0];
                                cx = r.x + r.width / 2;
                                cy = r.y + r.height / 2;
                            } else if (highlightPolygons.length > 0) {
                                const pts = highlightPolygons[0].points;
                                let sumX = 0, sumY = 0, n = pts.length / 2;
                                for (let j = 0; j < pts.length; j += 2) { sumX += pts[j]; sumY += pts[j + 1]; }
                                cx = sumX / n; cy = sumY / n;
                            }
                            return (
                                <svg
                                    className="absolute top-0 left-0 pointer-events-none"
                                    style={{ width: cs.width, height: cs.height, zIndex: 10 }}
                                    viewBox={`0 0 ${cs.width} ${cs.height}`}
                                >
                                    {highlightRects.map((rect, i) => (
                                        <rect key={`r${i}`} x={rect.x} y={rect.y} width={rect.width} height={rect.height}
                                            fill="rgba(255, 235, 59, 0.35)" stroke="#f59e0b" strokeWidth="1.5" />
                                    ))}
                                    {highlightPolygons.map((poly, i) => {
                                        const pts = poly.points;
                                        const svgPts = [];
                                        for (let j = 0; j < pts.length; j += 2) svgPts.push(`${pts[j]},${pts[j + 1]}`);
                                        return (
                                            <polygon key={`p${i}`}
                                                points={svgPts.join(' ')}
                                                fill={i === 0 ? 'rgba(255, 235, 59, 0.45)' : 'rgba(255, 235, 59, 0.25)'}
                                                stroke="#f59e0b" strokeWidth={i === 0 ? 2 : 1}
                                                style={{ strokeLinejoin: 'round' }} />
                                        );
                                    })}
                                    {/* Animated pulsing target indicator */}
                                    <circle cx={cx} cy={cy} r="20" fill="none" stroke="#f59e0b" strokeWidth="3" opacity="0.8">
                                        <animate attributeName="r" values="20;30;20" dur="2s" repeatCount="indefinite" />
                                        <animate attributeName="opacity" values="0.8;0.4;0.8" dur="2s" repeatCount="indefinite" />
                                    </circle>
                                    {/* Crosshair lines */}
                                    <line x1={cx - 30} y1={cy} x2={cx + 30} y2={cy} stroke="#f59e0b" strokeWidth="2" strokeDasharray="4" />
                                    <line x1={cx} y1={cy - 30} x2={cx} y2={cy + 30} stroke="#f59e0b" strokeWidth="2" strokeDasharray="4" />
                                </svg>
                            );
                        })() : null}
                    />
                ) : (
                    <>
                        <div className="h-12 border-b border-[#e5e1d8] flex items-center justify-between px-4 bg-[#fcfaf7] flex-shrink-0">
                            <span className="text-sm font-semibold text-gray-700">PDF Viewer</span>
                            <button onClick={() => { setRightOpen(false); setViewerType(null); }} className="p-1 hover:bg-gray-200 rounded text-gray-500">
                                <X size={16} />
                            </button>
                        </div>
                        <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
                            <FileText className="w-12 h-12 mb-3 opacity-30" />
                            <p className="text-sm">Click a search result to view document</p>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default KnowhowDB;
