import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    ArrowLeft, Folder, FolderOpen, FileText, Search as SearchIcon,
    Send, Bot, User, Loader2, Sparkles, ChevronRight,
    X, ZoomIn, ZoomOut, ChevronLeft, LogOut, Upload,
    RefreshCcw, Trash2, List, Database, MessageSquare
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
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

const getChatApiUrl = () => {
    return API_BASE.endsWith('/api') ? `${API_BASE}/v1/chat/` : `${API_BASE}/api/v1/chat/`;
};

const getListApiUrl = (path) => {
    return `${API_BASE}/api/v1/azure/list?path=${encodeURIComponent(path)}`;
};

const getIndexStatusApiUrl = (username) => {
    return `${API_BASE}/api/v1/azure/index-status?username=${encodeURIComponent(username)}`;
};

const getReindexApiUrl = () => {
    return `${API_BASE}/api/v1/azure/reindex-from-json`;
};

const buildBlobUrl = (blobPath) => {
    return `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${AZURE_CONTAINER_NAME}/${encodeURIComponent(blobPath)}?${AZURE_SAS_TOKEN}`;
};

const KnowhowDB = () => {
    const navigate = useNavigate();
    const { currentUser } = useAuth();
    const username = currentUser?.displayName || currentUser?.email?.split('@')[0];
    const isAdmin = currentUser?.email === 'admin@poscoenc.com' || currentUser?.displayName?.includes('관리자');

    // === Admin User Folder State ===
    const [userFolders, setUserFolders] = useState([]);
    const [selectedUserFolder, setSelectedUserFolder] = useState(null);
    const browseUsername = isAdmin && selectedUserFolder ? selectedUserFolder : username;

    // === Left Sidebar State ===
    const [folders, setFolders] = useState([]);
    const [activeFolder, setActiveFolder] = useState(null);
    const [files, setFiles] = useState([]);
    const [loadingFiles, setLoadingFiles] = useState(false);
    const [activeDoc, setActiveDoc] = useState(null);

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
    const [pdfZoom, setPdfZoom] = useState(1.2);
    const [pdfLoading, setPdfLoading] = useState(false);

    // === Upload State ===
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState('');
    const fileInputRef = useRef(null);

    // === Index Status State (Admin) ===
    const [indexStatus, setIndexStatus] = useState({});
    const [isReindexing, setIsReindexing] = useState(false);
    const [reindexingFile, setReindexingFile] = useState(null);
    const [isIndexingAll, setIsIndexingAll] = useState(false);

    // === Refs ===
    const canvasRef = useRef(null);
    const messagesEndRef = useRef(null);
    const resizingRef = useRef(false);
    const currentPdfUrlRef = useRef(null);
    const fileMapRef = useRef({});

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
            const res = await fetch(getListApiUrl(path));
            if (!res.ok) throw new Error('Failed to list files');
            const data = await res.json();
            const items = Array.isArray(data) ? data : (data.items || []);
            const fileItems = items.filter(item => item.type === 'file');

            fileItems.forEach(f => {
                fileMapRef.current[f.name] = folderName;
            });

            const filesWithUrl = fileItems.map(f => ({
                ...f,
                folder: folderName,
                pdfUrl: buildBlobUrl(`${browseUsername}/${folderName}/${f.name}`),
                id: f.name
            }));
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
    const loadIndexStatus = async (user) => {
        if (!isAdmin || !user) return;
        try {
            const res = await fetch(getIndexStatusApiUrl(user));
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
            loadIndexStatus(browseUsername);
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

    // =============================================
    // PDF RENDERING
    // =============================================
    const openPdf = async (url, page = 1) => {
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

    useEffect(() => {
        if (!pdfDocObj || !canvasRef.current) return;
        renderPdfPage();
    }, [pdfDocObj, pdfPage, pdfZoom]);

    const renderPdfPage = async () => {
        if (!pdfDocObj || !canvasRef.current) return;
        try {
            const page = await pdfDocObj.getPage(pdfPage);
            const viewport = page.getViewport({ scale: pdfZoom });
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: ctx, viewport }).promise;
        } catch (e) {
            console.error('PDF render error:', e);
        }
    };

    // =============================================
    // SEARCH HANDLER (AI 검색)
    // =============================================
    const handleSearch = async () => {
        if (!query.trim() || isSearching) return;
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
            const docIds = activeDoc ? [activeDoc.name] : null;

            const apiUrl = getChatApiUrl();
            const body = {
                query: query.trim(),
                context: null,
                doc_ids: docIds,
                mode: 'search',
                ...(isAdmin && selectedUserFolder && { target_user: selectedUserFolder })
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
                    if (r.filename && r.category) {
                        fileMapRef.current[r.filename] = r.category;
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
            const docIds = activeDoc ? [activeDoc.name] : null;

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
                    doc_ids: docIds,
                    mode: 'chat',
                    history: history.length > 0 ? history : null,
                    ...(isAdmin && selectedUserFolder && { target_user: selectedUserFolder })
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
                    if (r.filename && r.category) {
                        fileMapRef.current[r.filename] = r.category;
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
    const handleResultClick = (result) => {
        const filename = result.filename;
        const page = result.page || 1;
        let folder = fileMapRef.current[filename] || result.category;
        if (!folder && activeDoc && activeDoc.name === filename) folder = activeDoc.folder;
        if (!folder) folder = 'documents';

        const resultUser = result.user_id || browseUsername;
        const url = buildBlobUrl(`${resultUser}/${folder}/${filename}`);
        openPdf(url, page);
    };

    const handleCitationClick = (keyword) => {
        if (!keyword || keyword.length < 2) return;

        const noiseWords = ['g', 'e', 's', 't', 'c', 'd', 'p', 'i', 'v', 'l', 'r', 'o', 'm', 'n', 'u', 'k'];
        const clean = keyword.toLowerCase().trim();
        if (clean.length < 2 || noiseWords.includes(clean)) return;

        let targetPage = 1;
        let targetDocName = null;

        if (keyword.includes('|')) {
            const parts = keyword.split('|');
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

        let targetFile = null;
        if (targetDocName) {
            targetFile = files.find(f =>
                f.name.toLowerCase().includes(targetDocName.toLowerCase()) ||
                targetDocName.toLowerCase().includes(f.name.toLowerCase())
            );
        }
        if (!targetFile && activeDoc) targetFile = activeDoc;

        if (targetFile) {
            openPdf(targetFile.pdfUrl, targetPage);
        } else if (targetDocName) {
            const folder = fileMapRef.current[targetDocName] || 'documents';
            const url = buildBlobUrl(`${browseUsername}/${folder}/${targetDocName}`);
            openPdf(url, targetPage);
        }
    };

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
    // RESIZE HANDLER
    // =============================================
    const startResize = useCallback(() => {
        resizingRef.current = true;
        setIsResizing(true);
    }, []);

    const stopResize = useCallback(() => {
        resizingRef.current = false;
        setIsResizing(false);
    }, []);

    const onResize = useCallback((e) => {
        if (resizingRef.current) {
            const newWidth = window.innerWidth - e.clientX;
            if (newWidth > 300 && newWidth < 1200) setRightWidth(newWidth);
        }
    }, []);

    useEffect(() => {
        if (isResizing) {
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        } else {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
        window.addEventListener('mousemove', onResize);
        window.addEventListener('mouseup', stopResize);
        return () => {
            window.removeEventListener('mousemove', onResize);
            window.removeEventListener('mouseup', stopResize);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
    }, [onResize, stopResize, isResizing]);

    // =============================================
    // CHAT HISTORY PERSISTENCE
    // =============================================
    const chatStorageKey = `knowhow_chat_${activeDoc?.name || 'all'}`;

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
            setChatMessages([{
                role: 'assistant',
                content: activeDoc
                    ? `안녕하세요! "${activeDoc.name}"에 대해 궁금한 점을 물어보세요.`
                    : '안녕하세요! 문서에 대해 궁금한 점을 물어보세요.'
            }]);
        }
    }, [activeDoc?.name, mode]);

    useEffect(() => {
        if (mode === 'chat' && chatMessages.length > 1) {
            localStorage.setItem(chatStorageKey, JSON.stringify(chatMessages));
        }
    }, [chatMessages, chatStorageKey, mode]);

    const handleResetChat = () => {
        if (!confirm('대화 내용을 초기화 하시겠습니까?')) return;
        localStorage.removeItem(chatStorageKey);
        setChatMessages([{
            role: 'assistant',
            content: activeDoc
                ? `안녕하세요! "${activeDoc.name}"에 대해 궁금한 점을 물어보세요.`
                : '안녕하세요! 문서에 대해 궁금한 점을 물어보세요.'
        }]);
    };

    // =============================================
    // MARKDOWN COMPONENTS (for chat)
    // =============================================
    const markdownComponents = {
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
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleCitationClick(keyword); }}
                        className="mx-1 px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded cursor-pointer hover:bg-blue-100 font-medium inline-flex items-center gap-0.5 text-xs transition-colors border border-blue-200"
                        title={`View source`}
                    >
                        <Sparkles size={10} />
                        {children}
                    </button>
                );
            }
            return <a href={href} className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
        }
    };

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
            <div className="w-64 bg-[#f0f4f9] border-r border-gray-200 flex flex-col flex-shrink-0 h-full">
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
                <div className="px-3 py-2">
                    <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">Folders</div>
                    <div className="space-y-0.5">
                        {folders.map((folder) => (
                            <button
                                key={folder.name}
                                onClick={() => setActiveFolder(activeFolder === folder.name ? null : folder.name)}
                                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                                    activeFolder === folder.name
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
                </div>

                {activeFolder && <div className="border-t border-gray-200 mx-3" />}

                {/* Files */}
                <div className="flex-1 overflow-y-auto px-3 py-2">
                    {activeFolder && (
                        <>
                            <div className="flex items-center justify-between mb-2 px-1">
                                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Files</div>
                                <div className="flex items-center gap-1">
                                    {isAdmin && Object.keys(indexStatus).length > 0 && (
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
                                            className={`group flex items-center gap-2 px-3 py-2 rounded-lg text-xs cursor-pointer transition-colors ${
                                                activeDoc?.name === file.name
                                                    ? 'bg-blue-100 text-blue-700 font-medium'
                                                    : 'text-gray-600 hover:bg-gray-200'
                                            }`}
                                        >
                                            <div
                                                className="flex-1 flex items-center gap-2 min-w-0"
                                                onClick={() => setActiveDoc(file)}
                                            >
                                                <FileText className="w-3.5 h-3.5 flex-shrink-0" />
                                                <span className="truncate">{file.name}</span>
                                                {/* Index status indicator (admin only) */}
                                                {fStatus && (
                                                    <span
                                                        className="flex-shrink-0"
                                                        title={
                                                            fStatus.indexed_pages > 0
                                                                ? `Indexed: ${fStatus.indexed_pages} pages`
                                                                : fStatus.json_exists
                                                                    ? 'JSON exists, not indexed'
                                                                    : 'Not analyzed'
                                                        }
                                                    >
                                                        {fStatus.indexed_pages > 0 ? (
                                                            <span className="text-green-500 font-medium text-[10px]">●{fStatus.indexed_pages}p</span>
                                                        ) : fStatus.json_exists ? (
                                                            <span className="text-orange-500 text-[10px]">●</span>
                                                        ) : (
                                                            <span className="text-red-400 text-[10px]">●</span>
                                                        )}
                                                    </span>
                                                )}
                                            </div>
                                            {/* Admin reindex button */}
                                            {isAdmin && fStatus && fStatus.json_exists && (
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleReindex(file);
                                                    }}
                                                    disabled={isReindexing}
                                                    className={`hidden group-hover:flex p-1 hover:bg-orange-100 rounded text-orange-600 transition-colors ${
                                                        reindexingFile === file.name ? '!flex animate-spin' : ''
                                                    }`}
                                                    title="Reindex from JSON"
                                                >
                                                    <RefreshCcw className="w-3 h-3" />
                                                </button>
                                            )}
                                            {activeFolder === 'my-documents' && (
                                                <>
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
                                                                } catch {}
                                                                await startAnalysis(file.name, totalPages, username, 'my-documents', true);
                                                                await pollAnalysisStatus(file.name, () => {}, totalPages);
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
                                                    <button
                                                        onClick={async (e) => {
                                                            e.stopPropagation();
                                                            if (!confirm(`Delete "${file.name}"?`)) return;
                                                            try {
                                                                const res = await fetch(
                                                                    `${API_BASE}/api/v1/analyze/doc/${encodeURIComponent(file.name)}?username=${encodeURIComponent(username)}&category=my-documents`,
                                                                    { method: 'DELETE' }
                                                                );
                                                                if (res.ok) {
                                                                    loadFiles('my-documents');
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
                                                </>
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
                        className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                            mode === 'search' ? 'bg-[#d97757] text-white' : 'text-gray-500 hover:bg-gray-100'
                        }`}
                    >
                        <SearchIcon className="w-4 h-4" /> AI 검색
                    </button>
                    <button
                        onClick={() => setMode('chat')}
                        className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                            mode === 'chat' ? 'bg-[#d97757] text-white' : 'text-gray-500 hover:bg-gray-100'
                        }`}
                    >
                        <MessageSquare className="w-4 h-4" /> AI 분석
                    </button>

                    <div className="ml-auto flex items-center gap-2">
                        {activeDoc && (
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
                                                        <span className="text-sm font-medium text-gray-800 truncate">{result.filename || 'Unknown'}</span>
                                                        <span className="text-xs text-gray-400 flex-shrink-0">Page {result.page || '?'}</span>
                                                    </div>
                                                    <p className="text-sm text-gray-600 leading-relaxed line-clamp-3">
                                                        {result.content || 'No preview available'}
                                                    </p>
                                                </div>
                                                {result.score != null && (
                                                    <div className="flex-shrink-0 px-2 py-1 bg-blue-50 text-blue-700 text-xs font-medium rounded">
                                                        {result.score.toFixed(1)}
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
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                                        msg.role === 'user' ? 'bg-[#333333]' : 'bg-[#d97757]'
                                    }`}>
                                        {msg.role === 'user'
                                            ? <User size={14} className="text-white" />
                                            : <Bot size={14} className="text-white" />
                                        }
                                    </div>
                                    <div className={`max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed shadow-sm ${
                                        msg.role === 'user'
                                            ? '!bg-[#333333] !text-white rounded-tr-none'
                                            : msg.isError
                                                ? 'bg-red-50 text-red-600 border border-red-100 rounded-tl-none'
                                                : 'bg-white text-[#333333] border border-[#e5e1d8] rounded-tl-none'
                                    }`}>
                                        {msg.role === 'user' ? msg.content : (
                                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                                {processCitations(msg.content)}
                                            </ReactMarkdown>
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
                                    ? (activeDoc ? `"${activeDoc.name}" 내 검색...` : '전체 문서 검색...')
                                    : (activeDoc ? `"${activeDoc.name}"에 대해 질문...` : '문서에 대해 질문...')
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

                {/* PDF Header */}
                <div className="h-12 border-b border-[#e5e1d8] flex items-center justify-between px-4 bg-[#fcfaf7] flex-shrink-0">
                    <span className="text-sm font-semibold text-gray-700">PDF Viewer</span>
                    <button onClick={() => setRightOpen(false)} className="p-1 hover:bg-gray-200 rounded text-gray-500">
                        <X size={16} />
                    </button>
                </div>

                {/* PDF Controls */}
                {pdfDocObj && (
                    <div className="h-10 border-b border-[#e5e1d8] flex items-center justify-center gap-3 px-4 bg-[#fcfaf7] flex-shrink-0">
                        <button
                            onClick={() => setPdfPage(p => Math.max(1, p - 1))}
                            disabled={pdfPage <= 1}
                            className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"
                        >
                            <ChevronLeft size={14} />
                        </button>
                        <span className="text-xs text-gray-600 font-medium min-w-[60px] text-center">
                            {pdfPage} / {pdfTotalPages}
                        </span>
                        <button
                            onClick={() => setPdfPage(p => Math.min(pdfTotalPages, p + 1))}
                            disabled={pdfPage >= pdfTotalPages}
                            className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"
                        >
                            <ChevronRight size={14} />
                        </button>
                        <div className="w-px h-4 bg-gray-300 mx-1" />
                        <button onClick={() => setPdfZoom(z => Math.max(0.5, +(z - 0.2).toFixed(1)))} className="p-1 hover:bg-gray-200 rounded">
                            <ZoomOut size={14} />
                        </button>
                        <span className="text-xs text-gray-500 w-10 text-center">{Math.round(pdfZoom * 100)}%</span>
                        <button onClick={() => setPdfZoom(z => Math.min(3, +(z + 0.2).toFixed(1)))} className="p-1 hover:bg-gray-200 rounded">
                            <ZoomIn size={14} />
                        </button>
                    </div>
                )}

                {/* PDF Canvas */}
                <div className="flex-1 overflow-auto bg-gray-100 flex items-start justify-center p-4">
                    {pdfLoading ? (
                        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                            <Loader2 className="w-8 h-8 animate-spin text-[#d97757] mb-3" />
                            <span className="text-sm">Loading PDF...</span>
                        </div>
                    ) : pdfDocObj ? (
                        <canvas ref={canvasRef} className="shadow-lg" />
                    ) : (
                        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                            <FileText className="w-12 h-12 mb-3 opacity-30" />
                            <p className="text-sm">Click a search result to view PDF</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default KnowhowDB;
