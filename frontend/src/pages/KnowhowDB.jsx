import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    ArrowLeft, Plus, FileText, X,
    Search as SearchIcon, ChevronRight, Copy, Check, List, Grid3X3, LogOut, Paperclip,
    RefreshCcw, Trash2
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import ChatInterface from '../components/ChatInterface';
import PDFViewer from '../components/PDFViewer';
import {
    getUploadSas,
    uploadToAzure,
    startAnalysis,
    pollAnalysisStatus,
    listDocuments,
    countPdfPages,
    loadPdfJs,
    fetchDocumentJson
} from '../services/analysisService';

// Azure Config for PDF URL construction
const AZURE_STORAGE_ACCOUNT_NAME = import.meta.env.VITE_AZURE_STORAGE_ACCOUNT_NAME;
const AZURE_CONTAINER_NAME = import.meta.env.VITE_AZURE_CONTAINER_NAME;
const rawSasToken = import.meta.env.VITE_AZURE_SAS_TOKEN || "";
const AZURE_SAS_TOKEN = rawSasToken.replace(/^"|"$/g, '');

const KnowhowDB = () => {
    const navigate = useNavigate();
    const { currentUser } = useAuth();

    // UI State
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(true);
    const [isResizing, setIsResizing] = useState(false); // New state for transition control
    const [rightSidebarWidth, setRightSidebarWidth] = useState(400); // Default width increased to 400
    const [rightSidebarMode, setRightSidebarMode] = useState('search'); // 'search' | 'pdf'
    const [citedDoc, setCitedDoc] = useState(null);

    // Upload & Analysis State
    const [isUploading, setIsUploading] = useState(false);
    const [analysisStatus, setAnalysisStatus] = useState('');
    const fileInputRef = useRef(null);

    // Document Library & Search State
    const [documents, setDocuments] = useState([]); // File list
    const [showDocLibrary, setShowDocLibrary] = useState(false);
    const [activeDoc, setActiveDoc] = useState(null); // Selected Document for Search
    const [activeDocData, setActiveDocData] = useState(null); // Loaded JSON Content
    const [isDocLoading, setIsDocLoading] = useState(false);

    // Search State (Right Sidebar)
    const [searchTerm, setSearchTerm] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [copiedTag, setCopiedTag] = useState(null);
    const [viewMode, setViewMode] = useState('list');

    const messagesEndRef = useRef(null);

    // Initial Data Loading
    useEffect(() => {
        if (!currentUser) return;
        loadDocuments();
    }, [currentUser]);

    const loadDocuments = async () => {
        if (!currentUser) return;
        try {
            const docs = await listDocuments(
                currentUser.displayName || currentUser.email.split('@')[0],
                'my_documents'
            );

            // Add pdfUrl to documents for PDFViewer
            const docsWithUrl = docs.map(d => {
                const username = currentUser.displayName || currentUser.email.split('@')[0];
                const blobPath = `${username}/my_documents/${d.name}`;
                const pdfUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${AZURE_CONTAINER_NAME}/${encodeURIComponent(blobPath)}?${AZURE_SAS_TOKEN}`;
                return { ...d, pdfUrl, id: d.name }; // Ensure ID exists
            });

            setDocuments(docsWithUrl.filter(d => d.type === 'file'));
        } catch (e) {
            console.error("Failed to load documents:", e);
        }
    };

    // Load Document Content when Active Doc Changes
    useEffect(() => {
        const loadContent = async () => {
            if (!activeDoc) {
                setActiveDocData(null);
                setSearchResults([]);
                setSearchTerm('');
                return;
            }

            setIsDocLoading(true);
            try {
                const username = currentUser.displayName || currentUser.email.split('@')[0];
                const jsonData = await fetchDocumentJson(activeDoc.name, username, 'json');
                setActiveDocData(jsonData);
            } catch (e) {
                console.error("Failed to load doc content:", e);
                // Optional: Notify user
            } finally {
                setIsDocLoading(false);
            }
        };
        loadContent();
    }, [activeDoc]);

    // Search Logic
    useEffect(() => {
        if (!searchTerm.trim() || !activeDocData) {
            setSearchResults([]);
            return;
        }

        const term = searchTerm.toLowerCase();
        const results = [];

        // Search in ocrData (Array of pages)
        const pages = activeDocData.ocrData || activeDocData.pdfTextData || [];

        pages.forEach((page, pageIndex) => {
            const lines = page.lines || page.layout?.lines || [];
            lines.forEach((line) => {
                if (line.content && line.content.toLowerCase().includes(term)) {
                    results.push({
                        content: line.content,
                        pageNum: page.page_number || (pageIndex + 1),
                        tagType: 'other', // Default to generic
                        docName: activeDoc.name
                    });
                }
            });
        });

        setSearchResults(results);
    }, [searchTerm, activeDocData]);



    // Sidebar Rezizing Logic
    const resizingRef = useRef(false);

    const startResizing = useCallback(() => {
        resizingRef.current = true;
        setIsResizing(true);
    }, []);

    const stopResizing = useCallback(() => {
        resizingRef.current = false;
        setIsResizing(false);
    }, []);

    const resize = useCallback(
        (mouseMoveEvent) => {
            if (resizingRef.current) {
                const newWidth = window.innerWidth - mouseMoveEvent.clientX;
                if (newWidth > 300 && newWidth < 1200) {
                    setRightSidebarWidth(newWidth);
                }
            }
        },
        []
    );

    useEffect(() => {
        if (isResizing) {
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        } else {
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
        }

        window.addEventListener("mousemove", resize);
        window.addEventListener("mouseup", stopResizing);
        return () => {
            window.removeEventListener("mousemove", resize);
            window.removeEventListener("mouseup", stopResizing);
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
        };
    }, [resize, stopResizing, isResizing]);

    const handleResultClick = (result) => {
        if (!activeDoc) return;
        setCitedDoc({
            docId: activeDoc.id,
            page: result.pageNum,
            term: result.content
        });
        setRightSidebarMode('pdf');
        setIsRightSidebarOpen(true);
    };

    const handleCitationClick = (keyword) => {
        console.log(`[KnowhowDB] Handled citation link click: "${keyword}"`);

        // Noise Filtering
        const cleanKeyword = keyword.toLowerCase().trim();
        const noiseWords = ['g', 'e', 'ㅎ', 's', 't', 'c', 'd', 'p', 'i', 'v', 'l', 'r', 'o', 'm', 'n', 'u', 'k'];
        if (cleanKeyword.length < 2 || noiseWords.includes(cleanKeyword)) {
            console.log(`[KnowhowDB] Citation ignored (noise): "${keyword}"`);
            return;
        }

        // Parse citation: [[Term|Page|DocName]] OR "DocId (Page)"
        let targetPage = 1;
        let targetDocName = null;
        let cleanText = keyword;

        if (keyword.includes('|')) {
            // New Format: content|page|filename|coords|type
            const parts = keyword.split('|');
            cleanText = parts[0].trim();

            if (parts.length > 1) {
                const pageMatch = parts[1].trim().match(/(\d+)/);
                if (pageMatch) targetPage = parseInt(pageMatch[1]);
            }
            if (parts.length > 2) targetDocName = parts[2].trim();

            // Extract extra metadata for high-precision fallback
            let targetCoords = null;
            let targetType = null;
            if (parts.length > 3 && parts[3]) {
                try { targetCoords = JSON.parse(parts[3]); } catch (e) { }
            }
            if (parts.length > 4) targetType = parts[4].trim();

            // Store extra info in state
            if (targetCoords) {
                console.log(`[KnowhowDB] Found embedded coordinates for "${cleanText}":`, targetCoords);
            }

            // Set highlight with extra info
            setHighlightDoc({
                term: cleanText,
                page: targetPage,
                docName: targetDocName,
                coords: targetCoords,
                type: targetType
            });

        } else if (keyword.match(/(.*)\s+\((\d+)\)$/)) {
            const match = keyword.match(/(.*)\s+\((\d+)\)$/);
            targetDocName = match[1].trim();
            targetPage = parseInt(match[2]);
            cleanText = targetDocName;

            setHighlightDoc({
                term: cleanText,
                page: targetPage,
                docName: targetDocName
            });
        }

        console.log(`[KnowhowDB] Parsed citation -> Term: "${cleanText}", Page: ${targetPage}, DocName: "${targetDocName || 'N/A'}"`);

        // Find target doc
        let targetDoc = null;
        if (targetDocName) {
            targetDoc = documents.find(d =>
                d.name.toLowerCase().includes(targetDocName.toLowerCase()) ||
                targetDocName.toLowerCase().includes(d.name.toLowerCase())
            );
        }

        // If no explicit doc name, or not found, try to find a doc that matches the primary part of the citation
        if (!targetDoc && cleanText) {
            targetDoc = documents.find(d =>
                d.name.toLowerCase().includes(cleanText.toLowerCase()) ||
                cleanText.toLowerCase().includes(d.name.toLowerCase())
            );
        }

        // Fallback to active doc if still no doc found
        if (!targetDoc && activeDoc) {
            targetDoc = activeDoc;
            console.log(`[KnowhowDB] Falling back to active document: ${activeDoc.name}`);
        }

        if (targetDoc) {
            console.log(`[KnowhowDB] Opening PDF for document: ${targetDoc.name}, ID: ${targetDoc.id}`);
            // Set as active document to load metadata
            setActiveDoc(targetDoc);

            setCitedDoc({
                docId: targetDoc.id,
                page: targetPage,
                term: cleanText
            });
            setRightSidebarMode('pdf');
            setIsRightSidebarOpen(true);
        } else {
            console.warn(`[KnowhowDB] ❌ No matching document found for citation: "${keyword}"`);
            // Optional: Alert the user that the doc couldn't be found
        }
    };




    // ... (Chat & Upload Handlers remain same, omitted for brevity but included in full file write) ...
    // Re-implementing handlers for full file overwrite
    const handleFileSelect = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';
        setIsUploading(true);
        setAnalysisStatus('Reading file...');

        try {
            const username = currentUser.displayName || currentUser.email.split('@')[0];
            console.log("Creating upload task for user:", username, "currentUser:", currentUser); // Debug log

            const totalPages = await countPdfPages(file);

            setAnalysisStatus('Preparing upload...');
            const { upload_url } = await getUploadSas(file.name, username);

            await uploadToAzure(upload_url, file, (percent) => setAnalysisStatus(`Uploading... ${percent}%`));

            setAnalysisStatus('Starting analysis...');
            await startAnalysis(file.name, totalPages, username, 'my_documents');

            // Poll for status
            await pollAnalysisStatus(file.name, (statusData) => {
                if (statusData.status === 'in_progress' || statusData.status === 'finalizing') {
                    const completedChunks = statusData.completed_chunks || [];
                    let pagesCompleted = 0;
                    for (const chunkRange of completedChunks) {
                        const [start, end] = chunkRange.split('-').map(Number);
                        pagesCompleted += (end - start + 1);
                    }
                    setAnalysisStatus(`Processing... (${pagesCompleted}/${totalPages} pages)`);
                }
            }, totalPages);

            setAnalysisStatus('Done!');
            await loadDocuments();

            // Show success notification (optional)
            console.log(`✅ ${file.name} (${totalPages} pages) uploaded and indexed successfully`);
        } catch (error) {
            console.error("Upload failed:", error);
            alert(`Upload failed: ${error.message}`);
        } finally {
            setIsUploading(false);
            setAnalysisStatus('');
        }
    };

    const copyToClipboard = (text) => {
        navigator.clipboard.writeText(text);
        setCopiedTag(text);
        setTimeout(() => setCopiedTag(null), 2000);
    };

    return (
        <div className="flex h-screen bg-[#fcfaf7] overflow-hidden font-sans">
            {/* Left Sidebar */}
            <div className={`${isSidebarOpen ? 'w-64 translate-x-0' : 'w-0 -translate-x-full'} bg-[#f0f4f9] border-r border-gray-200 transition-all duration-300 flex flex-col flex-shrink-0 absolute md:relative z-20 h-full overflow-hidden`}>
                <div className="p-4 space-y-2">
                    <button onClick={() => setShowDocLibrary(!showDocLibrary)} className={`w-full flex items-center gap-2 py-2 px-4 rounded-xl text-sm font-medium transition-colors ${showDocLibrary ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-200 text-[#444746]'}`}>
                        <FileText className="w-5 h-5 pb-0.5" /> {showDocLibrary ? 'Hide Documents' : 'My Documents'}
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto px-2">
                    {showDocLibrary ? (
                        <div className="px-2 mt-2">
                            <div className="flex items-center justify-between mb-2">
                                <div className="text-xs font-medium text-gray-500">Indexed Documents</div>
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={isUploading}
                                    className="flex items-center gap-1 px-2 py-1 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded text-xs font-medium transition-colors"
                                    title="Upload PDF"
                                >
                                    <Paperclip className="w-3 h-3" />
                                    Upload
                                </button>
                            </div>
                            <div className="space-y-1">
                                {documents.length === 0 ? (
                                    <div className="text-xs text-gray-400 italic px-2">No documents found.</div>
                                ) : (
                                    documents.map((doc, i) => (
                                        <div
                                            key={i}
                                            className={`group flex items-center gap-2 px-2 py-2 rounded text-xs cursor-pointer ${activeDoc?.name === doc.name ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-200'}`}
                                        >
                                            <div
                                                className="flex-1 flex items-center gap-2 min-w-0"
                                                onClick={() => { setActiveDoc(doc); setIsRightSidebarOpen(true); }}
                                            >
                                                <FileText className="w-3 h-3 flex-shrink-0" />
                                                <span className="truncate">{doc.name}</span>
                                            </div>

                                            <button
                                                onClick={async (e) => {
                                                    e.stopPropagation();
                                                    if (!window.confirm(`Re-analyze "${doc.name}"?`)) return;

                                                    setIsUploading(true);
                                                    setAnalysisStatus(`Re-analyzing ${doc.name}...`);
                                                    try {
                                                        const username = currentUser.displayName || currentUser.email.split('@')[0];
                                                        // Count actual pages from PDF URL
                                                        let totalPages = 1;
                                                        try {
                                                            const pdfjs = await loadPdfJs();
                                                            const pdf = await pdfjs.getDocument(doc.pdfUrl).promise;
                                                            totalPages = pdf.numPages;
                                                        } catch (pgErr) {
                                                            console.warn('Failed to count pages, using default:', pgErr);
                                                        }
                                                        const res = await startAnalysis(doc.name, totalPages, username, 'my_documents', true);
                                                        setAnalysisStatus('Analysis started...');
                                                        await pollAnalysisStatus(doc.name, (status) => {
                                                            setAnalysisStatus(`${status.status}... ${status.progress || ''}`);
                                                        }, totalPages);
                                                        loadDocuments();
                                                    } catch (err) {
                                                        console.error("Re-analysis failed:", err);
                                                        alert("Failed to start analysis: " + err.message);
                                                    } finally {
                                                        setIsUploading(false);
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
                                                    if (!window.confirm(`Delete "${doc.name}"? This will remove all analysis results.`)) return;

                                                    setIsUploading(true);
                                                    setAnalysisStatus(`Deleting ${doc.name}...`);
                                                    try {
                                                        const username = currentUser.displayName || currentUser.email.split('@')[0];
                                                        const response = await fetch(`${API_URL}/api/v1/analyze/doc/${encodeURIComponent(doc.name)}?username=${encodeURIComponent(username)}&category=my_documents`, {
                                                            method: 'DELETE'
                                                        });
                                                        if (response.ok) {
                                                            alert(`${doc.name} deleted.`);
                                                            loadDocuments();
                                                            if (activeDoc?.name === doc.name) setActiveDoc(null);
                                                        } else {
                                                            throw new Error("Failed to delete document from server.");
                                                        }
                                                    } catch (err) {
                                                        console.error("Deletion failed:", err);
                                                        alert("Deletion failed: " + err.message);
                                                    } finally {
                                                        setIsUploading(false);
                                                    }
                                                }}
                                                className="hidden group-hover:flex p-1 hover:bg-red-100 rounded text-red-500 transition-colors"
                                                title="Delete Document"
                                            >
                                                <Trash2 className="w-3 h-3" />
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    ) : null}
                </div>
                <div className="border-t border-gray-200">
                    <button onClick={() => navigate('/')} className="w-full flex items-center gap-2 px-4 py-3 text-sm text-gray-600 hover:bg-gray-100 transition-colors border-b border-gray-200">
                        <ArrowLeft className="w-4 h-4" /> Return to Home
                    </button>
                    <div className="p-4 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-400 to-red-500 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                            {currentUser?.displayName?.charAt(0)?.toUpperCase() || currentUser?.email?.charAt(0)?.toUpperCase() || 'U'}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">
                                {currentUser?.displayName || '사용자'}
                            </p>
                            <p className="text-xs text-gray-500 truncate">{currentUser?.email}</p>
                        </div>
                        <button
                            onClick={async () => {
                                try {
                                    await logout();
                                    navigate('/login');
                                } catch (error) {
                                    console.error('Logout failed:', error);
                                }
                            }}
                            className="p-2 hover:bg-gray-100 rounded-full text-gray-600 transition-colors"
                            title="Sign out"
                        >
                            <LogOut className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Hidden File Input */}
            <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileSelect}
                className="hidden"
                accept=".pdf"
            />

            {/* Main Area - Chat Interface */}
            <div className="flex-1 flex flex-col h-full relative min-w-0">
                <ChatInterface
                    activeDoc={activeDoc}
                    documents={documents}
                    chatScope="all"
                    onCitationClick={handleCitationClick}
                />

                {/* Upload Status Banner */}
                {isUploading && (
                    <div className="absolute top-0 left-0 w-full bg-blue-50 border-b border-blue-100 py-2 px-4 text-xs text-blue-700 flex items-center justify-center gap-2 shadow-sm z-20">
                        <div className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                        <span>{analysisStatus}</span>
                    </div>
                )}
            </div>

            {/* Right Sidebar (Search or PDF) */}
            <div
                className={`${isRightSidebarOpen ? '' : 'w-0'} bg-[#f4f1ea] border-l border-[#e5e1d8] flex flex-col flex-shrink-0 overflow-hidden relative shadow-2xl`}
                style={{
                    width: isRightSidebarOpen ? rightSidebarWidth : 0,
                    transition: isResizing ? 'none' : 'width 300ms cubic-bezier(0.4, 0, 0.2, 1), all 300ms'
                }}
            >
                {/* Resize Handle */}
                <div
                    className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400 z-50 transition-colors"
                    onMouseDown={startResizing}
                />
                {rightSidebarMode === 'search' ? (
                    <>
                        <div className="h-14 border-b border-[#e5e1d8] flex items-center justify-between px-4 bg-[#f4f1ea]">
                            <span className="font-semibold text-gray-700">Search</span>
                            <button onClick={() => setIsRightSidebarOpen(false)} className="p-1 hover:bg-[#e5e1d8] rounded text-gray-500"><ChevronRight size={18} /></button>
                        </div>

                        <div className="p-4 border-b border-[#e5e1d8] space-y-3">
                            {/* Active Doc Indicator */}
                            <div className="text-xs font-medium text-gray-500 mb-1">Target Document:</div>
                            <div className="bg-white border border-[#e5e1d8] rounded-lg px-3 py-2 text-sm text-gray-800 flex items-center gap-2">
                                {activeDoc ? (
                                    <>
                                        <FileText className="w-4 h-4 text-blue-500" />
                                        <span className="truncate">{activeDoc.name}</span>
                                    </>
                                ) : (
                                    <span className="text-gray-400 italic">No document selected</span>
                                )}
                            </div>

                            <div className="relative">
                                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                                <input
                                    type="text"
                                    placeholder={activeDoc ? "Search in document..." : "Select a doc to search"}
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    disabled={!activeDoc}
                                    className="w-full bg-white border border-[#e5e1d8] focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-lg py-2 pl-10 pr-4 text-sm outline-none transition-all placeholder-gray-400"
                                />
                                {searchTerm && (
                                    <button onClick={() => setSearchTerm('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"><X size={14} /></button>
                                )}
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto p-2 bg-[#f9f8f6]">
                            {isDocLoading ? (
                                <div className="flex flex-col items-center justify-center py-8 text-gray-500">
                                    <Loader2 className="w-6 h-6 animate-spin mb-2 text-blue-500" />
                                    <span className="text-xs">Loading document data...</span>
                                </div>
                            ) : !activeDoc ? (
                                <div className="flex flex-col items-center justify-center h-full text-gray-400 p-4 text-center">
                                    <FileText size={32} className="mb-2 opacity-30" />
                                    <p className="text-sm">Select a document from the left library to search its content.</p>
                                </div>
                            ) : searchResults.length > 0 ? (
                                <div className="space-y-2">
                                    <div className="px-2 text-xs font-medium text-gray-500 flex justify-between">
                                        <span>{searchResults.length} results</span>
                                        <div className="flex gap-1">
                                            <button onClick={() => setViewMode('list')} className={`p-1 rounded ${viewMode === 'list' ? 'bg-gray-200 text-gray-800' : 'text-gray-500'}`}><List size={14} /></button>
                                            <button onClick={() => setViewMode('grid')} className={`p-1 rounded ${viewMode === 'grid' ? 'bg-gray-200 text-gray-800' : 'text-gray-500'}`}><Grid3X3 size={14} /></button>
                                        </div>
                                    </div>

                                    {viewMode === 'list' ? searchResults.map((r, i) => (
                                        <div
                                            key={i}
                                            onClick={() => handleResultClick(r)}
                                            className="bg-white border border-gray-200 rounded-lg p-3 hover:shadow-sm hover:border-blue-300 transition-all group cursor-pointer"
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-sm text-gray-800 font-medium break-words leading-snug mb-1">
                                                        {/* Simple Highlight */}
                                                        {(r.content || "").split(new RegExp(`(${searchTerm})`, 'gi')).map((part, idx) =>
                                                            part.toLowerCase() === searchTerm.toLowerCase()
                                                                ? <span key={idx} className="bg-yellow-200 text-gray-900 rounded px-0.5">{part}</span>
                                                                : part
                                                        )}
                                                    </div>
                                                    <div className="text-xs text-gray-500">Page {r.pageNum}</div>
                                                </div>
                                                <button onClick={(e) => { e.stopPropagation(); copyToClipboard(r.content); }} className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-blue-500 transition-all">
                                                    {copiedTag === r.content ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                                                </button>
                                            </div>
                                        </div>
                                    )) : (
                                        <div className="grid grid-cols-2 gap-2">
                                            {searchResults.map((r, i) => (
                                                <div
                                                    key={i}
                                                    onClick={() => handleResultClick(r)}
                                                    className="bg-white border border-gray-200 rounded-lg p-2 text-center hover:shadow-sm hover:border-blue-300 transition-all cursor-pointer"
                                                >
                                                    <div className="text-xs font-bold text-gray-800 truncate mb-1" title={r.content}>{r.content}</div>
                                                    <div className="text-[10px] text-gray-500">P.{r.pageNum}</div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : searchTerm ? (
                                <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                                    <SearchIcon size={24} className="mb-2 opacity-50" />
                                    <p className="text-sm">No matches found.</p>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                                    <SearchIcon size={24} className="mb-2 opacity-50" />
                                    <p className="text-sm">Enter search term</p>
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="h-full flex flex-col">
                        {/* Close Button Row if needed, or PDFViewer handles it */}
                        {/* PDFViewer has its own header with close button */}
                        <PDFViewer
                            doc={citedDoc}
                            documents={documents}
                            activeDocData={activeDocData}
                            onClose={() => setRightSidebarMode('search')}
                        />
                    </div>
                )}
            </div>
        </div>
    );
};

export default KnowhowDB;
