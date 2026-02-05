import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Search, ZoomIn, ZoomOut, RotateCcw, RotateCw, X, Plus, FileText, ChevronRight, ChevronLeft, Download, Grid3X3, List, Loader2, Check, Copy, Move, FileCheck, FileX, Cloud, Monitor, Folder, File, MessageSquare, Files, LogOut, User, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate, Link } from 'react-router-dom';
import ChatInterface from '../components/ChatInterface';
import { db } from '../firebase';
import { doc, getDoc, setDoc, collection, query, where, onSnapshot, orderBy, limit, serverTimestamp } from 'firebase/firestore';
import MessageModal from '../components/MessageModal';
import { VERSION } from '../version';

import { BlobServiceClient } from '@azure/storage-blob';

const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

import { get, set, del } from 'idb-keyval';

// Azure Configuration
// Azure Configuration
const AZURE_STORAGE_ACCOUNT_NAME = import.meta.env.VITE_AZURE_STORAGE_ACCOUNT_NAME;
const AZURE_CONTAINER_NAME = import.meta.env.VITE_AZURE_CONTAINER_NAME;
// Handle potentially quoted SAS token from .env
const rawSasToken = import.meta.env.VITE_AZURE_SAS_TOKEN || "";
const AZURE_SAS_TOKEN = rawSasToken.replace(/^"|"$/g, '');

const AZURE_CONTAINER_URL = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${AZURE_CONTAINER_NAME}?${AZURE_SAS_TOKEN}`;

const classifyTag = (content) => {
    if (/^(\d{1,2}["']?)[-]([A-Z]{1,4})[-]?(\d{3,5})/.test(content)) return 'line';
    if (/^([A-Z]{1,3}G)[-_]?(\d{3,4})$/.test(content)) return 'gauge'; // e.g. PG-1234
    if (/^([A-Z]{2,4})[-_]?(\d{3,4}[A-Z]?)$/.test(content)) return 'instrument';
    if (/^([A-Z]{1,3}V)[-_]?(\d{3,4})$/.test(content)) return 'valve';
    if (/^([A-Z])[-_]?(\d{3,4})$/.test(content)) return 'equipment';
    return 'other';
};

const DOC_COLORS = [
    { border: 'border-emerald-500', text: 'text-emerald-600', bg: 'bg-emerald-50', indicator: 'bg-emerald-500', ring: 'ring-emerald-200', activeBorder: 'border-emerald-500' },
    { border: 'border-blue-500', text: 'text-blue-600', bg: 'bg-blue-50', indicator: 'bg-blue-500', ring: 'ring-blue-200', activeBorder: 'border-blue-500' },
    { border: 'border-amber-500', text: 'text-amber-600', bg: 'bg-amber-50', indicator: 'bg-amber-500', ring: 'ring-amber-200', activeBorder: 'border-amber-500' },
    { border: 'border-purple-500', text: 'text-purple-600', bg: 'bg-purple-50', indicator: 'bg-purple-500', ring: 'ring-purple-200', activeBorder: 'border-purple-500' },
    { border: 'border-pink-500', text: 'text-pink-600', bg: 'bg-pink-50', indicator: 'bg-pink-500', ring: 'ring-pink-200', activeBorder: 'border-pink-500' },
    { border: 'border-cyan-500', text: 'text-cyan-600', bg: 'bg-cyan-50', indicator: 'bg-cyan-500', ring: 'ring-cyan-200', activeBorder: 'border-cyan-500' },
    { border: 'border-indigo-500', text: 'text-indigo-600', bg: 'bg-indigo-50', indicator: 'bg-indigo-500', ring: 'ring-indigo-200', activeBorder: 'border-indigo-500' },
    { border: 'border-rose-500', text: 'text-rose-600', bg: 'bg-rose-50', indicator: 'bg-rose-500', ring: 'ring-rose-200', activeBorder: 'border-rose-500' },
];

const App = () => {
    // Auth & Navigation (Move to top)
    const { currentUser, logout } = useAuth();
    const navigate = useNavigate();
    const [userProfile, setUserProfile] = useState(null);

    const [documents, setDocuments] = useState([]);
    const [activeDocId, setActiveDocId] = useState(null);
    const [activePage, setActivePage] = useState(1);
    const [searchTerm, setSearchTerm] = useState('');
    const [searchScope, setSearchScope] = useState('active'); // 'active' or 'all'
    const [searchPreferPage, setSearchPreferPage] = useState(null);
    const [selectedResult, setSelectedResult] = useState(null);
    const [filters, setFilters] = useState({ line: true, instrument: true, valve: true, equipment: true, gauge: true, other: true });
    const [zoom, setZoom] = useState(1);
    const [rotation, setRotation] = useState(0);
    const [panX, setPanX] = useState(50);
    const [panY, setPanY] = useState(50);
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
    const [isLoading, setIsLoading] = useState(false);
    const [pdfJsReady, setPdfJsReady] = useState(false);
    const [loadingProgress, setLoadingProgress] = useState(null);
    const [inputPage, setInputPage] = useState(1);
    const [isInitialLoad, setIsInitialLoad] = useState(true);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [unreadMessages, setUnreadMessages] = useState([]);
    const [newMessagePopup, setNewMessagePopup] = useState(null);
    const isFirstRun = useRef(true);
    const [isMessageModalOpen, setIsMessageModalOpen] = useState(false);
    const [shareMessageData, setShareMessageData] = useState(null);

    const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
    const [viewMode, setViewMode] = useState('list');
    const [copiedTag, setCopiedTag] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const [extractionProgress, setExtractionProgress] = useState(null); // { current, total }
    // Chat Context Scope: 'active' (default) or 'all'
    const [chatScope, setChatScope] = useState('active');
    const [hasUserSelectedScope, setHasUserSelectedScope] = useState(false);
    const [pendingUploads, setPendingUploads] = useState([]); // Array of { file, docId }

    useEffect(() => {
        setInputPage(activePage);
    }, [activePage]);

    // Persistence: Load Documents on Mount
    useEffect(() => {
        const loadPersistedData = async () => {
            try {
                // Load IDs first
                const savedIds = await get('doc_ids');
                if (savedIds && Array.isArray(savedIds)) {
                    // Load each doc
                    const docsPromises = savedIds.map(id => get(`doc_${id}`));
                    const docs = await Promise.all(docsPromises);
                    const validDocs = docs.filter(d => d);

                    if (validDocs.length > 0) {
                        setDocuments(validDocs);

                        const [savedActiveId, savedPage, savedZoom, savedPanX, savedPanY, savedRotation] = await Promise.all([
                            get('activeDocId'),
                            get('activePage'),
                            get('zoom'),
                            get('panX'),
                            get('panY'),
                            get('rotation')
                        ]);

                        if (savedActiveId && validDocs.find(d => d.id === savedActiveId)) {
                            setActiveDocId(savedActiveId);
                        } else {
                            setActiveDocId(validDocs[0].id);
                        }

                        if (savedPage) setActivePage(Number(savedPage));
                        if (savedZoom) setZoom(Number(savedZoom));
                        if (savedPanX) setPanX(Number(savedPanX));
                        if (savedPanY) setPanY(Number(savedPanY));
                        if (savedRotation) setRotation(Number(savedRotation));

                        // Small delay to allow canvas render before disabling protection
                    }
                }
            } catch (err) {
                console.error('Failed to load persisted documents:', err);
            } finally {
                // Always mark initial load process as complete, even if no docs found
                // This enables auto-fit logic for the first upload ever.
                setTimeout(() => setIsInitialLoad(false), 500);
            }
        };
        loadPersistedData();
    }, []);

    // Persistence: Save Documents on Change (Itemized)
    useEffect(() => {
        const saveDocs = async () => {
            if (documents.length > 0) {
                // 1. Save list of IDs
                const ids = documents.map(d => d.id);
                try {
                    await set('doc_ids', ids);
                    // 2. Save each document
                    // Optimization: We could track dirty/new docs, but saving all ensures consistency for now.
                    // Promise.all to maximize throughput
                    await Promise.all(documents.map(doc => set(`doc_${doc.id}`, doc)));
                } catch (e) {
                    console.error("Failed to save documents:", e);
                }
            }
        };
        saveDocs();

        if (activeDocId) {
            set('activeDocId', activeDocId).catch(err => console.error('Failed to persist activeDocId:', err));
        }
    }, [documents, activeDocId]);

    // Auto-open Analysis Modal when pending uploads exist
    useEffect(() => {
        if (pendingUploads.length > 0) {
            console.log("[Dashboard] Pending uploads detected:", pendingUploads.length);
            setShowAnalysisConfirmModal(true);
        }
    }, [pendingUploads]);

    // Message Listener for Notifications
    useEffect(() => {
        if (!currentUser) return;

        const q = query(
            collection(db, 'messages'),
            where('receiverId', '==', currentUser.uid),
            where('read', '==', false),
            orderBy('timestamp', 'desc')
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const newMessages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            if (isFirstRun.current) {
                isFirstRun.current = false;
                setUnreadMessages(newMessages);
                return;
            }

            setUnreadMessages(prev => {
                // If we have a new message that wasn't previously in our list, show a popup
                const latestMsg = newMessages[0];
                if (latestMsg && !prev.find(m => m.id === latestMsg.id)) {
                    setNewMessagePopup(latestMsg);
                    // Auto-hide popup after 5 seconds
                    setTimeout(() => setNewMessagePopup(null), 5000);
                }
                return newMessages;
            });
        }, (err) => {
            console.error("Messaging listener error:", err);
        });

        return () => unsubscribe();
    }, [currentUser?.uid]);

    // View State Persistence
    useEffect(() => {
        if (!isInitialLoad) {
            set('activePage', activePage);
            set('zoom', zoom);
            set('panX', panX);
            set('panY', panY);
            set('rotation', rotation);
        }
    }, [activePage, zoom, panX, panY, rotation, isInitialLoad]);

    const handleReset = async () => {
        if (window.confirm('모든 도면과 채팅 기록을 초기화하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) {
            try {
                setIsLoading(true);
                // 1. Delete Global Keys
                await del('doc_ids');
                await del('activeDocId');
                await del('global_chat_history');
                await del('documents'); // legacy key

                // 2. Delete Individual Docs and View State
                await Promise.all([
                    ...(documents.length > 0 ? documents.map(d => del(`doc_${d.id}`)) : []),
                    del('activePage'),
                    del('zoom'),
                    del('panX'),
                    del('panY'),
                    del('rotation')
                ]);

                // 3. Reload
                window.location.reload();
            } catch (error) {
                console.error("Reset failed:", error);
                alert("초기화 중 오류가 발생했습니다.");
                setIsLoading(false);
            }
        }
    };

    useEffect(() => {
        const syncUserProfile = async () => {
            if (!currentUser) return;
            try {
                const userDocRef = doc(db, "users", currentUser.uid);
                const userDocSnap = await getDoc(userDocRef);

                if (userDocSnap.exists()) {
                    setUserProfile(userDocSnap.data());
                } else {
                    // Create basic profile if missing - this ensures the user appears in recipient lists
                    const newProfile = {
                        name: currentUser.displayName || currentUser.email.split('@')[0],
                        email: currentUser.email,
                        createdAt: serverTimestamp()
                    };
                    await setDoc(userDocRef, newProfile);
                    setUserProfile(newProfile);
                }
            } catch (err) {
                console.error("Error syncing user profile:", err);
            }
        };

        syncUserProfile();
    }, [currentUser]);

    const handleLogout = async () => {
        try {
            await logout();
            navigate('/login');
        } catch (error) {
            console.error("Failed to log out", error);
        }
    };

    // Azure Integration State
    const [showSourceModal, setShowSourceModal] = useState(false);
    const [uploadType, setUploadType] = useState(null); // 'pdf' or 'json'
    const [showAzureBrowser, setShowAzureBrowser] = useState(false);
    const [azurePath, setAzurePath] = useState('');
    const [azureItems, setAzureItems] = useState([]);
    const [azureLoading, setAzureLoading] = useState(false);
    const [error, setError] = useState(null);
    const [autoSelectFirstResult, setAutoSelectFirstResult] = useState(false);
    const [selectedAzureItems, setSelectedAzureItems] = useState([]);
    const [showScopeSelectionModal, setShowScopeSelectionModal] = useState(false);

    const [loadingType, setLoadingType] = useState('listing'); // 'listing' or 'downloading'
    const [uploadCategory, setUploadCategory] = useState('drawings'); // 'drawings' or 'documents'

    // Sidebar Resize State
    const [sidebarWidth, setSidebarWidth] = useState(350);
    const [isResizing, setIsResizing] = useState(false);

    // Sidebar Resize Handler
    useEffect(() => {
        const handleMouseMove = (e) => {
            if (!isResizing) return;
            const newWidth = window.innerWidth - e.clientX;
            // Limit width between 300px and 800px (approx 50% of screen)
            if (newWidth >= 300 && newWidth <= 800) {
                setSidebarWidth(newWidth);
            }
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            // Re-enable text selection if we disabled it (optional implementation detail)
            document.body.style.userSelect = '';
        };

        if (isResizing) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
            document.body.style.userSelect = 'none'; // Prevent selection while dragging
        }

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            document.body.style.userSelect = '';
        };
    }, [isResizing]);

    const pdfRef = useRef(null);
    const canvasRef = useRef(null);
    const renderTaskRef = useRef(null);
    const containerRef = useRef(null);
    const fileInputRef = useRef(null);
    const jsonInputRef = useRef(null);

    useEffect(() => {
        if (!window.pdfjsLib) {
            const script = document.createElement('script');
            script.src = PDFJS_URL;
            script.onload = () => {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
                setPdfJsReady(true);
            };
            document.head.appendChild(script);
        } else {
            setPdfJsReady(true);
        }
    }, []);

    useEffect(() => {
        if (!containerRef.current) return;

        const updateSize = () => {
            if (containerRef.current) {
                setContainerSize({
                    width: containerRef.current.clientWidth,
                    height: containerRef.current.clientHeight
                });
            }
        };

        // Use ResizeObserver for more robust size tracking (handles sidebar toggles)
        const observer = new ResizeObserver(() => {
            updateSize();
        });

        observer.observe(containerRef.current);

        // Final fallback/initial check
        updateSize();

        return () => {
            if (observer) observer.disconnect();
        };
    }, []);

    const activeDoc = useMemo(() => documents.find(d => d.id === activeDocId), [documents, activeDocId]);

    // 현재 페이지 OCR/PDF텍스트 데이터
    const currentPageData = useMemo(() => {
        if (!activeDoc) return null;
        if (activeDoc.ocrData) {
            if (Array.isArray(activeDoc.ocrData)) {
                return activeDoc.ocrData.find(p => p.page_number === activePage) || activeDoc.ocrData[activePage - 1];
            }
            return activePage === 1 ? activeDoc.ocrData : null;
        }
        if (activeDoc.pdfTextData) {
            return activeDoc.pdfTextData[activePage - 1];
        }
        return null;
    }, [activeDoc, activePage]);

    // PDF 텍스트 추출
    const extractPdfText = useCallback(async (pdf, pageNum) => {
        try {
            const page = await pdf.getPage(pageNum);
            const scale = 2.0;
            const viewport = page.getViewport({ scale });

            const textContent = await page.getTextContent();
            const items = [];

            for (const item of textContent.items) {
                if (!item.str.trim()) continue;
                const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
                const x = tx[4];
                const y = tx[5];
                const w = item.width * scale;
                const h = item.height * scale;

                items.push({
                    content: item.str.trim(),
                    polygon: [x, y, x + w, y, x + w, y + h, x, y + h],
                });
            }

            return {
                page_number: pageNum,
                layout: { width: viewport.width, height: viewport.height, lines: items },
                source: 'pdfjs'
            };
        } catch (err) {
            console.error('Extract error:', err);
            return null;
        }
    }, []);

    // 버블 파싱
    const parseInstrumentBubbles = useCallback((ocrData) => {
        const lines = ocrData.layout?.lines || ocrData.lines || [];
        if (lines.length === 0) return [];
        const bubbles = [];
        const used = new Set();

        lines.forEach((line1, i) => {
            if (!line1?.content) return; // Defensive check
            if (used.has(i) || !/^N\d+[A-Z]?$/i.test(line1.content.trim())) return;
            lines.forEach((line2, j) => {
                if (i === j || used.has(j)) return;
                if (!line2?.content) return; // Defensive check

                const x1 = line1.polygon[0], y1 = line1.polygon[1];
                const x2 = line2.polygon[0], y2 = line2.polygon[1];
                const dx = Math.abs(x1 - x2), dy = y2 - y1;

                if (dx < 0.15 && dy > 0.02 && dy < 0.2) {
                    const content2 = line2.content.trim();
                    if (/^[\d/]+"?$/.test(content2) || /^\d/.test(content2)) {
                        bubbles.push({
                            content: `${line1.content.trim()}/${content2}`,
                            polygon: [
                                Math.min(line1.polygon[0], line2.polygon[0]), line1.polygon[1],
                                Math.max(line1.polygon[2], line2.polygon[2]), line1.polygon[3],
                                Math.max(line1.polygon[4], line2.polygon[4]), line2.polygon[5],
                                Math.min(line1.polygon[6], line2.polygon[6]), line2.polygon[7],
                            ],
                        });
                        used.add(i);
                        used.add(j);
                    }
                }
            });
        });
        return bubbles;
    }, []);

    // 검색
    const searchResults = useMemo(() => {
        const rawSearch = searchTerm.trim();
        if (!rawSearch) return [];

        // Noise Filtering: Ignore extremely short/meaningless keywords
        const cleanSearch = searchTerm.toLowerCase().replace(/\s+/g, '');
        const noiseWords = ['g', 'e', 'ㅎ', 's', 't', 'c', 'd', 'p', 'i', 'v', 'l', 'r', 'o', 'm', 'n', 'u', 'k'];
        if (cleanSearch.length < 2 || noiseWords.includes(cleanSearch)) {
            console.log("Search ignored due to noise/length:", cleanSearch);
            return [];
        }

        const results = [];
        const docsToSearch = searchScope === 'all' ? documents : documents.filter(d => d.id === activeDocId);

        // Scoring helper
        const calculateScore = (content, search) => {
            const cleanContent = content.toLowerCase().replace(/\s+/g, '');
            const cleanSearch = search.toLowerCase().replace(/\s+/g, '');

            if (cleanContent === cleanSearch) return 100; // Perfect match

            // Exact word matching bonus
            // If the content contains the search term as a discrete word (or words)
            // e.g., "절수형 기기 사용" in "여기에 절수형 기기 사용 항목이 있음"
            const contentWords = content.toLowerCase().split(/[^a-zA-Z0-9가-힣]+/).filter(Boolean);
            const searchWords = search.toLowerCase().split(/[^a-zA-Z0-9가-힣]+/).filter(Boolean);

            if (searchWords.length > 0) {
                // Check if ALL search words appear as exact words in the content
                const allWordsMatch = searchWords.every(sw => contentWords.includes(sw));
                if (allWordsMatch) return 95; // Very high score for exact word matches

                // Partial word match (some words match exactly)
                const matchCount = searchWords.filter(sw => contentWords.includes(sw)).length;
                if (matchCount > 0) {
                    return 60 + (matchCount / searchWords.length * 30);
                }
            }

            if (cleanContent.startsWith(cleanSearch)) return 80;
            if (cleanContent.includes(cleanSearch)) return 60;

            return 0;
        };

        const searchGenericJson = (obj, doc, pageNum) => {
            if (!obj) return;
            if (typeof obj === 'string') {
                const score = calculateScore(obj, rawSearch);
                if (score > 0) {
                    results.push({
                        content: obj,
                        polygon: null,
                        docId: doc.id,
                        docName: doc.name,
                        pageNum,
                        tagType: 'other',
                        layoutWidth: 0,
                        layoutHeight: 0,
                        isMetadata: true,
                        score: score
                    });
                }
            } else if (Array.isArray(obj)) {
                obj.forEach(item => searchGenericJson(item, doc, pageNum));
            } else if (typeof obj === 'object') {
                Object.values(obj).forEach(val => searchGenericJson(val, doc, pageNum));
            }
        };

        docsToSearch.forEach(doc => {
            // 0. Document Name Match
            const docScore = calculateScore(doc.name, rawSearch);
            if (docScore > 0) {
                results.push({
                    content: doc.name,
                    polygon: null,
                    docId: doc.id,
                    docName: doc.name,
                    pageNum: 1,
                    tagType: 'other',
                    layoutWidth: 0,
                    layoutHeight: 0,
                    isDocumentMatch: true,
                    score: docScore + 10 // Bonus for being a document name
                });
            }

            const dataSource = doc.ocrData || doc.pdfTextData;
            if (!dataSource) return;
            const pages = Array.isArray(dataSource) ? dataSource : [dataSource];

            const hasOcrStructure = pages.some(p => p?.layout?.lines || p?.lines);

            if (hasOcrStructure || doc.pdfTextData) {
                pages.forEach((pageData, idx) => {
                    const lines = pageData.layout?.lines || pageData.lines || [];
                    if (lines.length === 0) return;

                    const pageNum = pageData.page_number || idx + 1;
                    const layoutWidth = pageData.layout?.width || pageData.metadata?.width || pageData.width || 0;
                    const layoutHeight = pageData.layout?.height || pageData.metadata?.height || pageData.height || 0;

                    lines.forEach(line => {
                        const lineContent = line?.content || line?.text;
                        if (!lineContent || typeof lineContent !== 'string') return;

                        let score = calculateScore(lineContent, rawSearch);

                        // Token match for terms with spaces (e.g. "LIC 7240")
                        if (score < 60 && rawSearch.includes(' ')) {
                            const tokens = rawSearch.toLowerCase().split(/\s+/).filter(t => t.length > 1);
                            if (tokens.length > 0) {
                                let tokenHits = 0;
                                tokens.forEach(token => {
                                    if (lineContent.toLowerCase().includes(token)) tokenHits++;
                                });
                                if (tokenHits > 0) {
                                    score = 40 + (tokenHits / tokens.length * 20);
                                }
                            }
                        }

                        // Page Preference Bonus
                        // Boost items on the page where the citation or user is looking
                        if (score > 0 && pageNum === searchPreferPage) {
                            score += 200; // Significant boost to stay on the correct page
                        }

                        if (score > 0) {
                            const type = classifyTag(lineContent);
                            if (filters[type]) {
                                results.push({
                                    content: lineContent,
                                    polygon: line.polygon ? [...line.polygon] : [],
                                    docId: doc.id,
                                    docName: doc.name,
                                    pageNum,
                                    tagType: type,
                                    layoutWidth: layoutWidth,
                                    layoutHeight: layoutHeight,
                                    score: score
                                });
                            }
                        }
                    });

                    if (doc.ocrData) {
                        const bubbles = parseInstrumentBubbles(pageData);
                        bubbles.forEach(bubble => {
                            const score = calculateScore(bubble.content, rawSearch);
                            if (score > 0 && filters.instrument) {
                                results.push({
                                    content: bubble.content,
                                    polygon: [...bubble.polygon],
                                    docId: doc.id,
                                    docName: doc.name,
                                    pageNum,
                                    tagType: 'instrument',
                                    layoutWidth: layoutWidth,
                                    layoutHeight: layoutHeight,
                                    score: score
                                });
                            }
                        });
                    }
                });
            } else {
                // Fallback: Generic JSON Search
                // Treat the whole doc.ocrData as searchable metadata
                // We'll assign it to "Page 1" logically
                if (filters.other) {
                    searchGenericJson(doc.ocrData, doc, 1);
                }
            }
        });

        // Sort by Score descending and Limit results to prevent crashes
        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, 200);
    }, [searchTerm, documents, activeDocId, searchScope, filters, parseInstrumentBubbles, searchPreferPage]);

    const handlePageInputChange = (e) => {
        setInputPage(e.target.value);
    };

    const handlePageInputKeyDown = (e) => {
        if (e.key === 'Enter') {
            const page = parseInt(inputPage);
            if (activeDoc && !isNaN(page) && page >= 1 && page <= (activeDoc.totalPages || 1)) {
                goToPage(page);
                e.currentTarget.blur();
            } else {
                setInputPage(activePage);
            }
        }
    };

    const handlePageInputBlur = () => {
        const page = parseInt(inputPage);
        if (activeDoc && !isNaN(page) && page >= 1 && page <= (activeDoc.totalPages || 1)) {
            if (page !== activePage) goToPage(page);
        } else {
            setInputPage(activePage);
        }
    };

    // PDF 로드 및 페이지 렌더링
    const pdfCache = useRef({}); // Cache for parsed PDF documents: { [docId]: pdfProxy }

    // PDF 로드 및 페이지 렌더링
    const loadAndRenderPage = useCallback(async (doc, pageNum) => {
        if (!window.pdfjsLib || !canvasRef.current || (!doc?.pdfData && !doc?.pdfUrl)) return;
        setIsLoading(true);

        try {
            let pdf = pdfCache.current[doc.id];

            // If not in cache, load it and cache it
            if (!pdf) {
                if (doc.pdfUrl) {
                    // Try URL for Azure files first (Range Requests)
                    try {
                        console.log('Loading PDF from URL with Range Requests:', doc.pdfUrl);
                        const loadingTask = window.pdfjsLib.getDocument({
                            url: doc.pdfUrl,
                            rangeChunkSize: 65536,
                            disableAutoFetch: true,
                            disableStream: false,
                        });

                        loadingTask.onProgress = (progress) => {
                            if (progress.total > 0) {
                                setLoadingProgress({ current: progress.loaded, total: progress.total, type: 'download' });
                            }
                        };

                        // Add Timeout to prevent infinite loading (30 seconds)
                        const timeoutPromise = new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Timeout loading PDF via URL')), 30000)
                        );

                        pdf = await Promise.race([loadingTask.promise, timeoutPromise]);
                        setLoadingProgress(null);
                        console.log('✅ PDF loaded successfully via URL');
                    } catch (urlError) {
                        console.warn('⚠️ URL loading failed/timed out, falling back to full download:', urlError);
                        setLoadingProgress(null); // Reset progress on error

                        // Fallback: Download entire file as ArrayBuffer with Timeout
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout for full download

                        try {
                            const response = await fetch(doc.pdfUrl, { signal: controller.signal });
                            clearTimeout(timeoutId);
                            if (!response.ok) throw new Error(`Failed to download PDF: ${response.status}`);
                            const arrayBuffer = await response.arrayBuffer();
                            pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                            console.log('✅ PDF loaded via fallback ArrayBuffer');
                        } catch (fallbackError) {
                            clearTimeout(timeoutId);
                            throw fallbackError;
                        }
                    }
                } else {
                    // Use ArrayBuffer for local files
                    // Clone ArrayBuffer to avoid detachment (DataCloneError) during IDB save
                    const bufferClone = doc.pdfData.slice(0);
                    pdf = await window.pdfjsLib.getDocument({ data: bufferClone }).promise;
                }
                pdfCache.current[doc.id] = pdf;

                // Update total pages in state only if it's new (to avoid infinite loops or unnecessary updates)
                if (doc.totalPages !== pdf.numPages) {
                    setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, totalPages: pdf.numPages } : d));
                }

                // Auto-extract text in background (non-blocking)
                if (!doc.ocrData && !doc.pdfTextData) {
                    (async () => {
                        const textData = [];
                        // Initial chunk size can be small to get *some* search results fast, then larger
                        // For simplicity, we process all but yield to main thread occasionally if needed
                        setExtractionProgress({ current: 0, total: pdf.numPages });
                        for (let i = 1; i <= pdf.numPages; i++) {
                            const data = await extractPdfText(pdf, i);
                            if (data) textData.push(data);
                            setExtractionProgress({ current: i, total: pdf.numPages });

                            // Yield to main thread every 5 pages to keep UI responsive
                            if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
                        }
                        setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, pdfTextData: textData } : d));
                        setExtractionProgress(null);
                    })();
                }
            }

            const page = await pdf.getPage(pageNum);

            // Standard PDF.js rotation handling:
            // Passing 'rotation' to getViewport applies it as an ABSOLUTE rotation (0, 90, 180, 270).
            // By default, rotation state is 0. If drawings look upside down, we can adjust here.
            // Respect the PDF's default rotation (page.rotate) and add user's manual rotation
            const effectiveRotation = (page.rotate + rotation) % 360;
            let viewport = page.getViewport({ scale: 2.0, rotation: effectiveRotation });

            // If the drawing is naturally portrait (tall) AND it's the initial load (rotation === 0),
            // we might want to rotate it to landscape for better viewing.
            // Check dimensions AFTER applying default rotation.
            if (rotation === 0 && viewport.width < viewport.height) {
                // Determine layout rotation needed to make it landscape
                const newRotation = (effectiveRotation + 90) % 360;
                viewport = page.getViewport({ scale: 2.0, rotation: newRotation });
            }
            // Double Buffering: Render to offscreen canvas first to prevent flickering
            const offscreenCanvas = document.createElement('canvas');
            offscreenCanvas.width = viewport.width;
            offscreenCanvas.height = viewport.height;
            const offscreenCtx = offscreenCanvas.getContext('2d');

            const renderContext = { canvasContext: offscreenCtx, viewport };

            // Cancel any existing render task
            if (renderTaskRef.current) {
                try {
                    renderTaskRef.current.cancel();
                } catch (e) {
                    console.warn('Render cancellation error:', e);
                }
            }

            const renderTask = page.render(renderContext);
            renderTaskRef.current = renderTask;

            try {
                await renderTask.promise;

                if (renderTaskRef.current === renderTask) {
                    // Rendering complete, copy to main canvas
                    const mainCanvas = canvasRef.current;
                    if (mainCanvas) {
                        // Only resize and draw when ready
                        if (mainCanvas.width !== viewport.width || mainCanvas.height !== viewport.height) {
                            mainCanvas.width = viewport.width;
                            mainCanvas.height = viewport.height;
                        }

                        const mainCtx = mainCanvas.getContext('2d');
                        if (mainCtx) {
                            // Clear not strictly needed if we fill the whole canvas, but safe
                            mainCtx.drawImage(offscreenCanvas, 0, 0);
                        }
                    }
                    setCanvasSize({ width: viewport.width, height: viewport.height });
                    renderTaskRef.current = null;
                }
            } catch (err) {
                if (err.name === 'RenderingCancelledException' || err.message?.includes('cancelled')) {
                    return;
                }
                console.error('Render promise error:', err);
                throw err;
            }

            // Auto-fit after rendering is purely visual, can stay here.
            setTimeout(() => {
                if (containerRef.current && viewport.width && viewport.height) {
                    const containerWidth = containerRef.current.clientWidth;
                    const containerHeight = containerRef.current.clientHeight;
                    const padding = 20;
                    const scaleX = (containerWidth - padding) / viewport.width;
                    const scaleY = (containerHeight - padding) / viewport.height;
                    const fitZoom = Math.min(scaleX, scaleY);

                    // Only auto-fit if it's the first render of this doc/page distinct from zoom actions
                    // For now, we keep it simple or it might reset zoom annoyingly.
                    // Let's rely on the useEffect fitToScreen for initial load instead of forcing it deeply here.
                }
            }, 100);

            // Mark document as loaded after successful render
            setDocuments(prev => prev.map(d => d.id === doc.id && !d.isLoaded ? { ...d, isLoaded: true } : d));


        } catch (err) {
            console.error('PDF error:', err);
        } finally {
            setIsLoading(false);
            setLoadingProgress(null); // Ensure progress is cleared
        }
    }, [extractPdfText, rotation]); // Removed inputPage dependency

    useEffect(() => {
        if (activeDoc && pdfJsReady) {
            loadAndRenderPage(activeDoc, activePage);
        }
    }, [activeDoc, activePage, loadAndRenderPage, pdfJsReady]);

    const fitToScreen = useCallback(() => {
        if (!canvasSize.width || !containerSize.width) return;
        const padding = 20;
        const scaleX = (containerSize.width - padding) / canvasSize.width;
        const scaleY = (containerSize.height - padding) / canvasSize.height;
        const fitZoom = Math.min(scaleX, scaleY);
        setZoom(fitZoom);
        setPanX(50);
        setPanY(50);
    }, [canvasSize, containerSize]);

    useEffect(() => {
        // Only auto-fit if it's NOT the initial load (which restores saved zoom)
        // or if we explicitly want to re-fit (e.g. on new doc upload/switch)
        if (canvasSize.width && containerSize.width && activeDoc && !isInitialLoad) {
            console.log("Auto-fitting document:", activeDoc.name);
            setTimeout(fitToScreen, 150);
        }
    }, [canvasSize.width, containerSize.width, activeDocId, fitToScreen, isInitialLoad]);

    // --- Upload Handlers ---

    const initiateUpload = (type, category = 'drawings') => {
        setUploadType(type);
        setUploadCategory(category);
        setShowSourceModal(true);
    };

    const handleLocalUpload = () => {
        setShowSourceModal(false);
        if (uploadType === 'pdf') {
            fileInputRef.current?.click();
        } else {
            jsonInputRef.current?.click();
        }
    };

    const handleAzureUpload = () => {
        setShowSourceModal(false);
        setShowAzureBrowser(true);

        const userName = (userProfile?.name || currentUser?.displayName || '').trim();
        const categoryFolder = uploadCategory === 'documents' ? 'documents' : 'drawings';

        // Strict Navigation: Go to [User]/[Category]
        let initialPath = '';
        if (userName) {
            initialPath = `${userName}/${categoryFolder}`;
        }
        console.log(`[Azure] Auto-navigating to locked path: ${initialPath}`);
        fetchAzureItems(initialPath);
    };

    // --- Analysis State ---
    const [analysisState, setAnalysisState] = useState({ isAnalyzing: false, progress: 0, status: '' });
    const [showAnalysisConfirmModal, setShowAnalysisConfirmModal] = useState(false);



    // --- Analysis ---
    const analyzeLocalDocument = async (file, docId, index = null, total = null) => {
        const prefix = (index !== null && total > 1) ? `[${index + 1}/${total}] ` : '';
        try {
            const PRODUCTION_API_URL = 'https://drawing-detector-backend-kr7kyy4mza-uc.a.run.app';
            const API_URL = import.meta.env.VITE_API_URL || PRODUCTION_API_URL;

            // Step 1: Request SAS URL
            setAnalysisState({ isAnalyzing: true, progress: 5, status: `${prefix}업로드 채널 확보 중...` });

            // Encode filename to handle spaces/special characters safely
            const uName = userProfile?.name || currentUser?.displayName;
            const usernameParam = uName ? `&username=${encodeURIComponent(uName)}` : '';
            const sasRes = await fetch(`${API_URL}/api/v1/analyze/upload-sas?filename=${encodeURIComponent(file.name)}${usernameParam}`);

            if (!sasRes.ok) throw new Error("Failed to get upload URL");
            const { upload_url, blob_name } = await sasRes.json();

            // Step 2: Direct Upload to Azure (Bypassing Backend)
            setAnalysisState({ isAnalyzing: true, progress: 10, status: `${prefix}클라우드 스토리지로 직접 전송 중...` });

            await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('PUT', upload_url, true);
                xhr.setRequestHeader('x-ms-blob-type', 'BlockBlob'); // Required for Azure Block Blobs

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const percentComplete = (e.loaded / e.total) * 80; // Allocate 80% to upload
                        setAnalysisState(prev => ({
                            ...prev,
                            progress: 10 + Math.round(percentComplete),
                            status: `${prefix}클라우드로 전송 중... (${Math.round((e.loaded / e.total) * 100)}%)`
                        }));
                    }
                };

                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve();
                    } else {
                        reject(new Error(`Upload failed: ${xhr.statusText}`));
                    }
                };
                xhr.onerror = () => reject(new Error("Network Error during Upload"));
                xhr.send(file);
            });

            // Step 3: Start Robust Analysis (Backend Background Task)
            setAnalysisState({ isAnalyzing: true, progress: 20, status: `${prefix}분석 요청 중...` });

            // Call synchronous analysis endpoint (Streamlit-proven flow)
            // This will block until analysis is complete
            const totalPages = documents.find(d => d.id === docId)?.totalPages || 1;

            setAnalysisState({ isAnalyzing: true, progress: 30, status: `${prefix}서버에서 분석 중... (총 ${totalPages} 페이지)` });

            const syncRes = await fetch(`${API_URL}/api/v1/analyze/analyze-sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: file.name,
                    total_pages: totalPages,
                    category: uploadCategory,
                    username: userProfile?.name || currentUser?.displayName
                })
            });

            if (!syncRes.ok) {
                const err = await syncRes.json();
                throw new Error(err.detail || "Analysis failed");
            }

            const result = await syncRes.json();
            console.log("Analysis Complete:", result);

            // Success!
            setAnalysisState({ isAnalyzing: false, progress: 100, status: '완료!' });

            // Refresh file list
            if (uploadCategory === 'documents') fetchAzureItems('documents');
            else fetchAzureItems('drawings');

            alert(`분석 완료! ${result.chunks_analyzed}개 페이지를 처리했습니다.`);

            // --- Context Fix: Fetch the generated JSON and update local state ---
            // --- Context Fix: Fetch the generated JSON and update local state ---
            try {
                let fetchedOcrData = null;
                const jsonCandidates = [];

                // 1. Try precise location from backend
                if (result.json_location) {
                    jsonCandidates.push(result.json_location);
                }

                // 2. Fallback: Construct path from blob_name
                // blob_name example: "username/drawings/filename.pdf" or "username/documents/filename.pdf"
                if (blob_name) {
                    // Always try to look in the parallel 'json' folder (backend standard)
                    // Method A: Replace parent folder (drawings/documents) with 'json'
                    if (blob_name.toLowerCase().includes('drawings')) {
                        jsonCandidates.push(blob_name.replace(/drawings/i, 'json').replace(/\.pdf$/i, '.json'));
                        jsonCandidates.push(blob_name.replace(/drawings/i, 'json') + '.json');
                    } else if (blob_name.toLowerCase().includes('documents')) {
                        jsonCandidates.push(blob_name.replace(/documents/i, 'json').replace(/\.pdf$/i, '.json'));
                        jsonCandidates.push(blob_name.replace(/documents/i, 'json') + '.json');
                    }

                    // Method B: Same directory (just in case)
                    jsonCandidates.push(blob_name.replace(/\.pdf$/i, '.json'));
                    jsonCandidates.push(blob_name + '.json');
                }

                console.log("[ContextFix] Attempting to fetch derived JSON from candidates:", jsonCandidates);

                for (const jsonPath of jsonCandidates) {
                    try {
                        const jsonRes = await fetch(`${API_URL}/api/v1/azure/download?path=${encodeURIComponent(jsonPath)}`);
                        if (jsonRes.ok) {
                            const jsonBlob = await jsonRes.blob();
                            const jsonText = await jsonBlob.text();
                            fetchedOcrData = JSON.parse(jsonText);
                            console.log(`[ContextFix] ✅ JSON context fetched from: ${jsonPath}`);
                            break;
                        }
                    } catch (e) {
                        console.warn(`[ContextFix] Failed to fetch from ${jsonPath}`, e);
                    }
                }

                if (fetchedOcrData) {
                    setDocuments(prev => prev.map(d => d.id === docId ? { ...d, ocrData: fetchedOcrData, isLoaded: true } : d));
                    console.log("[ContextFix] Document state updated with OCR data.");
                } else {
                    console.warn("[ContextFix] ⚠️ Could not fetch generated JSON. Chat context may be empty.");
                    // Optional: Show a non-blocking toast or indicator?
                }
            } catch (ctxErr) {
                console.error("[ContextFix] Error fetching context JSON:", ctxErr);
            }

        } catch (e) {
            console.error("Analysis Error:", e);
            setAnalysisState({ isAnalyzing: false, progress: 0, status: '' });
            alert("전송 실패: " + e.message);
        }
    };

    // pollAnalysisStatus function removed - no longer needed with synchronous endpoint


    const confirmAnalysis = async () => {
        setShowAnalysisConfirmModal(false);
        const uploads = [...pendingUploads];
        console.log(`[BatchAnalysis] Processing ${uploads.length} files:`, uploads.map(u => u.file.name));
        setPendingUploads([]);

        for (let i = 0; i < uploads.length; i++) {
            const { file, docId } = uploads[i];
            await analyzeLocalDocument(file, docId, i, uploads.length);
        }
    };

    const cancelAnalysis = () => {
        setShowAnalysisConfirmModal(false);
        setPendingUploads([]);
    };

    const handleFilesUpload = async (e, type) => {
        const files = Array.from(e.target.files);
        const newPending = [];

        // Helper to read file as Promise
        const readFile = (file, readAs) => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => resolve(event.target.result);
            reader.onerror = (error) => reject(error);
            if (readAs === 'arrayBuffer') reader.readAsArrayBuffer(file);
            else reader.readAsText(file);
        });

        for (const file of files) {
            const id = `doc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const name = file.name.replace(/\.(pdf|json)$/i, '');

            if (type === 'pdf') {
                try {
                    const result = await readFile(file, 'arrayBuffer');
                    // Calculate color index correctly for batches
                    const colorIndex = (documents.length + newPending.length) % DOC_COLORS.length;

                    // Clone ArrayBuffer to prevent detached buffer error
                    const clonedBuffer = result.slice(0);

                    // Sequential update guarantees no race condition
                    // Initialize with ocrData: null. Analysis will update it later.
                    setDocuments(prev => [...prev, { id, name, pdfData: clonedBuffer, ocrData: null, pdfTextData: null, totalPages: 1, colorIndex, isLoaded: false }]);
                    setActiveDocId(id);
                    setActivePage(1);
                    setRotation(0);

                    // Add to pending batch
                    newPending.push({ file, docId: id });
                } catch (err) {
                    console.error("Error reading file:", file.name, err);
                }
            } else if (type === 'json' && activeDocId) {
                // ... same ...
                try {
                    const result = await readFile(file, 'text');
                    const json = JSON.parse(result);
                    setDocuments(prev => prev.map(d => d.id === activeDocId ? { ...d, ocrData: json, pdfTextData: null } : d));
                } catch (err) {
                    console.error("Error parsing JSON:", file.name, err);
                }
            }
        }

        if (newPending.length > 0) {
            console.log("[Dashboard] Adding to pending uploads:", newPending.length);
            setPendingUploads(prev => [...prev, ...newPending]);
        }

        // Modal Trigger... 
        if (type === 'pdf' && (documents.length + files.length > 1) && !hasUserSelectedScope) {
            // setShowScopeSelectionModal(true); // Defer this or keep it? Keep it.
            // Actually, the Analysis modal will popup first. 
        }

        e.target.value = '';
    };



    // --- Azure Integration ---

    const fetchAzureItems = async (path = '') => {
        try {
            setLoadingType('listing');
            setAzureLoading(true);
            setError(null);

            const PRODUCTION_API_URL = 'https://drawing-detector-backend-kr7kyy4mza-uc.a.run.app';
            const API_URL = import.meta.env.VITE_API_URL || PRODUCTION_API_URL;
            const response = await fetch(`${API_URL}/api/v1/azure/list?path=${encodeURIComponent(path)}`);

            if (!response.ok) {
                const contentType = response.headers.get("content-type");
                if (contentType && contentType.includes("application/json")) {
                    const errData = await response.json();
                    throw new Error(errData.detail || 'Failed to fetch Azure items');
                } else {
                    const text = await response.text();
                    console.error("Non-JSON Error Response:", text);
                    // Extract title if it's HTML
                    const titleMatch = text.match(/<title>(.*?)<\/title>/i);
                    const title = titleMatch ? titleMatch[1] : text.slice(0, 100);
                    throw new Error(`Server Error (${response.status}): ${title}`);
                }
            }

            const items = await response.json();

            // --- RBAC replaced by Strict Navigation Locking ---
            // We trust the path locking mechanism to keep users in their folder.
            setAzureItems(items);
            setAzurePath(path);
        } catch (err) {
            console.error('Error fetching Azure files:', err);
            setError(err.message || 'Failed to load files from Azure Storage via Backend.');
        } finally {
            setAzureLoading(false);
        }
    };

    const handleAzureFileSelect = async (file, keepBrowserOpen = false) => {
        try {
            setLoadingType('downloading');
            setAzureLoading(true);
            setError(null);

            const PRODUCTION_API_URL = 'https://drawing-detector-backend-kr7kyy4mza-uc.a.run.app';
            const API_URL = import.meta.env.VITE_API_URL || PRODUCTION_API_URL;
            const response = await fetch(`${API_URL}/api/v1/azure/download?path=${encodeURIComponent(file.path)}`);

            if (!response.ok) {
                const contentType = response.headers.get("content-type");
                let errorMessage = `Server Error (${response.status})`;
                if (contentType && contentType.includes("application/json")) {
                    const errData = await response.json();
                    errorMessage = errData.detail || errorMessage;
                } else {
                    const text = await response.text();
                    const titleMatch = text.match(/<title>(.*?)<\/title>/i);
                    errorMessage = titleMatch ? titleMatch[1] : text.slice(0, 100);
                }
                throw new Error(errorMessage);
            }

            const blob = await response.blob();
            const fileName = file.name.toLowerCase();

            // Logic to match handleFilesUpload identically
            if (activeDocId && fileName.endsWith('.json')) {
                // Treat as JSON metadata Upload
                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        const json = JSON.parse(event.target.result);
                        setDocuments(prev => prev.map(d => d.id === activeDocId ? { ...d, ocrData: json, pdfTextData: null } : d));
                        setShowAzureBrowser(false);
                        alert("Metadata loaded successfully!");
                    } catch (e) {
                        console.error("JSON Parse Error:", e);
                        alert('Invalid JSON file.');
                    }
                };
                reader.readAsText(blob);
            } else if (fileName.endsWith('.pdf')) {
                // PDF Upload - Use URL for Range Requests (Fast Web View)
                const id = `doc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                const name = file.name.replace(/\.pdf$/i, '');

                // Construct URL for PDF.js Range Requests - DO NOT download the blob
                const pdfUrl = `${API_URL}/api/v1/azure/download?path=${encodeURIComponent(file.path)}`;

                // Auto-fetch JSON logic
                let fetchedJson = null;
                const jsonCandidates = [];

                // Priority 1: Parallel 'json' folder (if in 'drawings' folder)
                if (file.path.toLowerCase().includes('drawings')) {
                    jsonCandidates.push(file.path.replace(/drawings/i, 'json').replace(/\.pdf$/i, '.json'));
                    jsonCandidates.push(file.path.replace(/drawings/i, 'json') + '.json');
                }

                // Priority 2: Same directory
                jsonCandidates.push(file.path.replace(/\.pdf$/i, '.json'));
                jsonCandidates.push(file.path + '.json');

                console.log("Attempting to fetch JSON metadata from candidates:", jsonCandidates);

                for (const jsonPath of jsonCandidates) {
                    try {
                        const jsonResponse = await fetch(`${API_URL}/api/v1/azure/download?path=${encodeURIComponent(jsonPath)}`);
                        if (jsonResponse.ok) {
                            const jsonBlob = await jsonResponse.blob();
                            const jsonText = await jsonBlob.text();
                            fetchedJson = JSON.parse(jsonText);
                            console.log(`✅ Successfully fetched JSON metadata from: ${jsonPath}`);
                            break; // Stop after first success
                        }
                    } catch (jsonErr) {
                        // Continue to next candidate
                        console.warn(`Failed to fetch JSON from ${jsonPath}`, jsonErr);
                    }
                }

                if (!fetchedJson) {
                    console.warn("⚠️ No JSON metadata found for this document.");
                }
                const colorIndex = documents.length % DOC_COLORS.length;

                // Store URL instead of pdfData for Azure files (enables Range Requests)
                setDocuments(prev => [...prev, {
                    id,
                    name,
                    pdfData: null,
                    pdfUrl: pdfUrl,
                    ocrData: fetchedJson,
                    pdfTextData: null,
                    totalPages: 1,
                    colorIndex,
                    isLoaded: false
                }]);

                setActiveDocId(id);
                setActivePage(1);
                setRotation(0);
                if (!keepBrowserOpen) setShowAzureBrowser(false);
            } else {
                alert(`Unsupported file type: ${file.name}`);
            }

        } catch (err) {
            console.error('Error downloading Azure file:', err);
            setError(err.message || 'Failed to download file from Azure via Backend');
        } finally {
            setAzureLoading(false);
        }
    };

    const handleAzureItemClick = (item) => {
        if (item.type === 'folder') {
            fetchAzureItems(item.path);
        } else {
            // Toggle selection for files
            setSelectedAzureItems(prev => {
                const exists = prev.some(i => i.path === item.path);
                if (exists) {
                    return prev.filter(i => i.path !== item.path);
                } else {
                    return [...prev, item];
                }
            });
        }
    };

    const handleAzureBatchUpload = async () => {
        if (selectedAzureItems.length === 0) return;

        // Process sequentially to ensure order and state stability
        for (const item of selectedAzureItems) {
            await handleAzureFileSelect(item, true);
        }
        setShowAzureBrowser(false);
        setSelectedAzureItems([]);

        // Trigger scope selection modal if total documents > 1 (Existing + New)
        if (documents.length + selectedAzureItems.length > 1 && !hasUserSelectedScope) {
            setShowScopeSelectionModal(true);
        }
    };


    const closeDocument = (id) => {
        setDocuments(prev => prev.filter(d => d.id !== id));
        if (activeDocId === id) {
            const remaining = documents.filter(d => d.id !== id);
            setActiveDocId(remaining.length > 0 ? remaining[0].id : null);
            setActivePage(1);
            setRotation(0);
        }
    };

    const goToPage = (num) => {
        const total = activeDoc?.totalPages || 1;
        const page = Math.max(1, Math.min(total, num));
        if (page !== activePage) {
            setActivePage(page);
            setSelectedResult(null);
        }
    };

    const handleResultClick = (result) => {
        console.log("Selected Result Debug:", result); // DEBUG
        setSelectedResult(result);
        if (result.docId !== activeDocId) {
            setActiveDocId(result.docId);
        }
        if (result.pageNum !== activePage) {
            setActivePage(result.pageNum);
        }
    };

    // Auto-pan to selected result
    /* 
    // Auto-pan disabled per user request ("도면은 가운대 고정해줘")
    useEffect(() => {
        if (!selectedResult || !selectedResult.polygon || !activeDoc || !canvasSize.width) return;
        if (selectedResult.docId !== activeDocId) return;

        // Get center point of the polygon
        const p = selectedResult.polygon;
        const lw = selectedResult.layoutWidth || 1; 
        const lh = selectedResult.layoutHeight || 1;

        const cx = (p[0] + p[2]) / 2;
        const cy = (p[1] + p[5]) / 2;

        let perX = (cx / lw) * 100;
        let perY = (cy / lh) * 100;

        perX = Math.max(0, Math.min(100, perX));
        perY = Math.max(0, Math.min(100, perY));

        setPanX(perX);
        setPanY(perY);
    }, [selectedResult, activeDocId, activeDoc, canvasSize]);
    */

    const getPolygonPoints = (result) => {
        if (!canvasSize.width || !result.layoutWidth || !result.layoutHeight || !result.polygon || result.polygon.length < 8) return "";
        const p = result.polygon;
        const lw = result.layoutWidth;
        const lh = result.layoutHeight;
        const needScale = Math.abs(lw - canvasSize.width) > 5;

        if (!needScale) {
            return `${p[0]},${p[1]} ${p[2]},${p[3]} ${p[4]},${p[5]} ${p[6]},${p[7]}`;
        } else {
            const sx = canvasSize.width / lw;
            const sy = canvasSize.height / lh;
            return `${p[0] * sx},${p[1] * sy} ${p[2] * sx},${p[3] * sy} ${p[4] * sx},${p[5] * sy} ${p[6] * sx},${p[7] * sy}`;
        }
    };

    const getSelectedCenter = () => {
        if (!selectedResult || !canvasSize.width || !selectedResult.polygon) return null;
        const p = selectedResult.polygon;
        const lw = selectedResult.layoutWidth;
        const lh = selectedResult.layoutHeight;
        const needScale = Math.abs(lw - canvasSize.width) > 1;

        let cx, cy;
        if (!needScale) {
            cx = (p[0] + p[2]) / 2;
            cy = (p[1] + p[5]) / 2;
        } else {
            const sx = canvasSize.width / lw;
            const sy = canvasSize.height / lh;
            cx = ((p[0] + p[2]) / 2) * sx;
            cy = ((p[1] + p[5]) / 2) * sy;
        }
        return { cx, cy };
    };

    const copyToClipboard = (text) => {
        navigator.clipboard.writeText(text);
        setCopiedTag(text);
        setTimeout(() => setCopiedTag(null), 2000);
    };

    const exportResults = () => {
        const csv = ['Tag,Type,Document,Page'].concat(searchResults.map(r => `"${r.content}","${r.tagType}","${r.docName}","${r.pageNum}"`)).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'results.csv'; a.click();
    };

    const tagColors = {
        line: { bg: 'bg-emerald-50 border-emerald-200', border: 'border-emerald-300', text: 'text-emerald-700', dot: 'bg-emerald-500' },
        instrument: { bg: 'bg-blue-50 border-blue-200', border: 'border-blue-300', text: 'text-blue-700', dot: 'bg-blue-500' },
        valve: { bg: 'bg-amber-50 border-amber-200', border: 'border-amber-300', text: 'text-amber-700', dot: 'bg-amber-500' },
        equipment: { bg: 'bg-purple-50 border-purple-200', border: 'border-purple-300', text: 'text-purple-700', dot: 'bg-purple-500' },
        gauge: { bg: 'bg-orange-50 border-orange-200', border: 'border-orange-300', text: 'text-orange-700', dot: 'bg-orange-500' },
        other: { bg: 'bg-gray-50 border-gray-200', border: 'border-gray-300', text: 'text-gray-700', dot: 'bg-gray-500' },
    };

    // Mouse Interaction
    const handleWheel = useCallback((e) => {
        if (!activeDoc) return;
        e.preventDefault();
        const delta = -e.deltaY;
        const scaleMultiplier = delta > 0 ? 1.1 : 0.9;
        setZoom(prev => Math.min(Math.max(prev * scaleMultiplier, 0.1), 5));
    }, [activeDoc]);

    // Attach wheel listener manually to support { passive: false }
    useEffect(() => {
        const container = containerRef.current;
        if (container) {
            container.addEventListener('wheel', handleWheel, { passive: false });
        }
        return () => {
            if (container) container.removeEventListener('wheel', handleWheel);
        };
    }, [handleWheel]);

    const handleMouseDown = useCallback((e) => {
        if (!activeDoc) return;
        setIsDragging(true);
        setDragStart({ x: e.clientX, y: e.clientY });
    }, [activeDoc]);

    const handleMouseMove = useCallback((e) => {
        if (!isDragging || !activeDoc || !containerRef.current) return;
        e.preventDefault();
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;

        // Calculate percentages based on CURRENT VISUAL SIZE (canvas * zoom)
        // Drag Right (dx > 0) -> Paper moves Right -> translate increases -> (50 - panX) increases -> panX decreases
        const currentWidth = (canvasSize.width * zoom) || containerRef.current.clientWidth;
        const currentHeight = (canvasSize.height * zoom) || containerRef.current.clientHeight;

        setPanX(prev => Math.min(Math.max(prev - (dx / currentWidth * 100), 0), 100));
        setPanY(prev => Math.min(Math.max(prev - (dy / currentHeight * 100), 0), 100));
        setDragStart({ x: e.clientX, y: e.clientY });
    }, [isDragging, activeDoc, dragStart, canvasSize, zoom]);

    const handleMouseUp = useCallback(() => {
        setIsDragging(false);
    }, []);

    const getPanRange = () => {
        if (!canvasSize.width || !containerSize.width) return { minX: 50, maxX: 50, minY: 50, maxY: 50 };
        const cw = canvasSize.width * zoom;
        const ch = canvasSize.height * zoom;
        // Calculate max overhang % (how much we can shift to see the edge)
        // If Image > Container: Shift = (Image - Container) / 2 / Image * 100
        const overX = Math.max(0, (cw - containerSize.width) / 2 / cw * 100);
        const overY = Math.max(0, (ch - containerSize.height) / 2 / ch * 100);
        return { minX: 50 - overX, maxX: 50 + overX, minY: 50 - overY, maxY: 50 + overY };
    };
    const panRange = getPanRange();
    const selectedCenter = getSelectedCenter();
    const hasOcr = !!activeDoc?.ocrData;
    const hasPdfText = !!activeDoc?.pdfTextData;

    // Citation Handler
    const handleCitationClick = (keyword) => {
        console.log(`App handled citation: ${keyword}`);

        // Noise Filtering for Citations
        const cleanKeyword = keyword.toLowerCase().trim();
        const noiseWords = ['g', 'e', 'ㅎ', 's', 't', 'c', 'd', 'p', 'i', 'v', 'l', 'r', 'o', 'm', 'n', 'u', 'k'];
        if (cleanKeyword.length < 2 || noiseWords.includes(cleanKeyword)) {
            console.log("Citation click ignored (noise/too short):", cleanKeyword);
            return;
        }

        // Parse optional page identifier: [[Keyword|Page 5]] or [[Keyword|P.5]]
        let targetPage = null;
        let cleanText = keyword;

        if (keyword.includes('|')) {
            const parts = keyword.split('|');
            cleanText = parts[0].trim();
            const pageStr = parts[1].trim();
            const pageMatch = pageStr.match(/(\d+)/);
            if (pageMatch) {
                targetPage = parseInt(pageMatch[1]);
                console.log(`Navigating to page ${targetPage} for citation: ${cleanText}`);
            }
        }

        // 1. Check if it's a pure page navigation (e.g. "Page 2" or "2페이지")
        const pageMatch = cleanText.match(/(?:Page|페이지)\s*(\d+)/i);
        if (pageMatch) {
            const pageNum = parseInt(pageMatch[1]);
            if (activeDoc && pageNum >= 1 && pageNum <= (activeDoc.totalPages || 1)) {
                goToPage(pageNum);
                return;
            }
        }

        // 2. Check if it matches a document name
        const docMatch = documents.find(d =>
            d.name.toLowerCase().includes(cleanText.toLowerCase()) ||
            cleanText.toLowerCase().includes(d.name.toLowerCase())
        );
        if (docMatch) {
            setActiveDocId(docMatch.id);
            if (targetPage) setActivePage(targetPage);
            else setActivePage(1);
            return;
        }

        // 3. Fallback to searching the term, potentially restricted to context page
        if (targetPage && activeDoc && targetPage <= activeDoc.totalPages) {
            // If we have a target page, jump there first
            setSearchPreferPage(targetPage);
            goToPage(targetPage);
        }

        setSearchTerm(cleanText);
        setAutoSelectFirstResult(true);
    };

    // Auto-select first result when triggered by citation click
    useEffect(() => {
        if (autoSelectFirstResult && searchResults.length > 0) {
            handleResultClick(searchResults[0]);
            setAutoSelectFirstResult(false);
        }
    }, [searchResults, autoSelectFirstResult]);

    return (
        <div className="flex h-screen w-full bg-[#fcfaf7] text-[#333333] font-sans overflow-hidden relative">
            {/* Sidebar */}
            <div className={`${sidebarCollapsed ? 'w-12' : 'w-72'} border-r border-[#e5e1d8] bg-[#f4f1ea] flex flex-col transition-all duration-300 relative z-50`}>
                <div className="h-12 border-b border-[#e5e1d8] flex items-center justify-between px-4 bg-[#f4f1ea]">
                    {!sidebarCollapsed && (
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-serif font-bold text-[#5d5d5d]">Drawings Analyzer</span>
                            <span className="text-[10px] text-[#a0a0a0] bg-[#e5e1d8] px-1.5 py-0.5 rounded-full">v{VERSION}</span>
                        </div>
                    )}
                    <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="p-1.5 hover:bg-[#e5e1d8] rounded-md text-[#5d5d5d] transition-colors">
                        <ChevronRight size={16} className={sidebarCollapsed ? '' : 'rotate-180'} />
                    </button>
                </div>

                {!sidebarCollapsed && (
                    <>
                        <div className="p-4 border-b border-[#e5e1d8] space-y-3">
                            <div className="relative group/search">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#888888] group-focus-within/search:text-[#d97757] transition-colors" size={16} />
                                <input
                                    type="text"
                                    placeholder="도면 내 검색..."
                                    value={searchTerm}
                                    onChange={(e) => {
                                        setSearchTerm(e.target.value);
                                        setSearchPreferPage(null); // Clear preference on manual search
                                    }}
                                    className="w-full bg-[#f4f1ea] border border-[#e5e1d8] focus:border-[#d97757] focus:ring-1 focus:ring-[#d97757] rounded-lg py-1.5 pl-10 pr-4 text-xs outline-none transition-all placeholder-[#a0a0a0] font-medium"
                                />
                                {searchTerm && (
                                    <button
                                        onClick={() => { setSearchTerm(''); setSelectedResult(null); setSearchPreferPage(null); }}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#a0a0a0] hover:text-[#d97757] transition-colors"
                                        title="Clear search"
                                    >
                                        <X size={14} />
                                    </button>
                                )}
                            </div>
                            <div className="flex gap-1 p-1 bg-[#e5e1d8] rounded-lg">
                                <button onClick={() => setSearchScope('all')} className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${searchScope === 'all' ? 'bg-white text-[#333333] shadow-sm' : 'text-[#666666] hover:text-[#333333]'}`}>All</button>
                                <button onClick={() => setSearchScope('current')} className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${searchScope === 'current' ? 'bg-white text-[#333333] shadow-sm' : 'text-[#666666] hover:text-[#333333]'}`}>Current</button>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {Object.entries(filters).map(([k, v]) => (
                                    <button key={k} onClick={() => setFilters(f => ({ ...f, [k]: !f[k] }))} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium uppercase tracking-wide transition-all ${v ? `${tagColors[k].bg} ${tagColors[k].text} border ${tagColors[k].border}` : 'bg-[#e5e1d8] text-[#888888] border border-transparent'}`}>
                                        <div className={`w-1.5 h-1.5 rounded-full ${v ? tagColors[k].dot : 'bg-[#a0a0a0]'}`} />{k}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="flex-1 overflow-hidden flex flex-col bg-[#f9f8f6]">
                            <div className="px-4 py-2 border-b border-[#e5e1d8] flex items-center justify-between bg-[#f4f1ea]">
                                <span className="text-xs font-medium text-[#666666]">{searchResults.length} results</span>
                                <div className="flex gap-1">
                                    <button onClick={() => setViewMode('list')} className={`p-1.5 rounded-md transition-colors ${viewMode === 'list' ? 'bg-[#e5e1d8] text-[#333333]' : 'text-[#888888] hover:bg-[#e5e1d8]'}`}><List size={14} /></button>
                                    <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-[#e5e1d8] text-[#333333]' : 'text-[#888888] hover:bg-[#e5e1d8]'}`}><Grid3X3 size={14} /></button>
                                    {searchResults.length > 0 && <button onClick={exportResults} className="p-1.5 rounded-md text-[#888888] hover:bg-[#e5e1d8] hover:text-[#333333] transition-colors"><Download size={14} /></button>}
                                </div>
                            </div>

                            <div className="flex-1 overflow-y-auto p-2 space-y-2">
                                {searchResults.length > 0 ? (
                                    viewMode === 'list' ? searchResults.map((r, i) => {
                                        const resDoc = documents.find(d => d.id === r.docId);
                                        const docColor = resDoc ? DOC_COLORS[resDoc.colorIndex % DOC_COLORS.length] : DOC_COLORS[0];
                                        return (
                                            <div key={i} onClick={() => handleResultClick(r)} className={`p-3 rounded-lg cursor-pointer border transition-all ${selectedResult === r ? 'bg-[#fff8f0] border-[#d97757] shadow-sm' : 'bg-white border-[#e5e1d8] hover:border-[#d0cdc5] hover:shadow-sm'}`}>
                                                <div className="flex items-start justify-between gap-2">
                                                    {/* Color Indicator */}
                                                    <div className={`w-1 self-stretch rounded-full ${docColor.indicator} mr-1 shrink-0 opacity-70`} title={resDoc?.name}></div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-semibold text-sm text-[#333333] break-words line-clamp-2" title={r.content}>
                                                                {(r.content || "").split(new RegExp(`(${searchTerm})`, 'gi')).map((part, idx) =>
                                                                    part.toLowerCase() === searchTerm.toLowerCase()
                                                                        ? <span key={idx} className="bg-yellow-200 text-black rounded px-0.5">{part}</span>
                                                                        : part
                                                                )}
                                                            </span>
                                                            <button onClick={(e) => { e.stopPropagation(); copyToClipboard(r.content || ""); }} className="p-1 text-[#a0a0a0] hover:text-[#d97757] transition-colors shrink-0">
                                                                {copiedTag === r.content ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                                                            </button>
                                                        </div>
                                                        <div className="text-[10px] text-[#888888] mt-0.5">{r.docName} • P.{r.pageNum}</div>
                                                    </div>
                                                    <span className={`text-[9px] px-2 py-0.5 rounded-full font-medium ${tagColors[r.tagType].bg} ${tagColors[r.tagType].text} shrink-0`}>{r.tagType}</span>
                                                </div>
                                            </div>
                                        )
                                    }) : (
                                        <div className="grid grid-cols-2 gap-2">
                                            {searchResults.map((r, i) => (
                                                <div key={i} onClick={() => handleResultClick(r)} className={`p-2 rounded-lg cursor-pointer text-center border transition-all ${selectedResult === r ? 'bg-[#fff8f0] border-[#d97757] shadow-sm' : 'bg-white border-[#e5e1d8] hover:border-[#d0cdc5] hover:shadow-sm'}`}>
                                                    <div className={`text-xs font-bold truncate ${tagColors[r.tagType].text}`}>{r.content}</div>
                                                    <div className="text-[9px] text-[#888888] mt-1">P.{r.pageNum}</div>
                                                </div>
                                            ))}
                                        </div>
                                    )
                                ) : (
                                    <div className="flex flex-col items-center justify-center h-full p-6 text-[#a0a0a0]">
                                        <Search size={32} className="mb-3 opacity-50" />
                                        <p className="text-xs font-medium">{searchTerm ? 'No results found' : 'Enter search term'}</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </>
                )}

                {/* User Profile Footer */}
                <div className="p-3 border-t border-[#e5e1d8] bg-[#f4f1ea]">
                    <div className={`flex items-center ${sidebarCollapsed ? 'justify-center' : 'justify-between'} gap-2`}>
                        {!sidebarCollapsed && (

                            <Link
                                to="/profile"
                                className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer hover:bg-[#e5e1d8] p-1.5 -ml-1.5 rounded-lg transition-colors group relative z-20"
                            >
                                <div className="w-8 h-8 rounded-full bg-[#d97757] flex items-center justify-center text-white font-bold shrink-0 group-hover:scale-105 transition-transform">
                                    {(userProfile?.name || currentUser?.email || 'U')[0].toUpperCase()}
                                    {unreadMessages.length > 0 && (
                                        <span className="absolute -top-1 -right-1 w-3 h-3 bg-[#d97757] border-2 border-[#f4f1ea] rounded-full"></span>
                                    )}
                                </div>
                                <div className="flex flex-col min-w-0">
                                    <span className="text-sm font-medium text-[#333333] truncate">{userProfile?.name || currentUser?.displayName || 'User'}</span>
                                    <span className="text-[10px] text-[#666666] truncate">{currentUser?.email}</span>
                                </div>
                            </Link>
                        )}


                        <button
                            onClick={handleLogout}
                            className={`p-2 hover:bg-[#ffe0d6] text-[#555555] hover:text-[#c05535] rounded-md transition-colors ${sidebarCollapsed ? 'w-full flex justify-center' : ''}`}
                            title="Logout"
                        >
                            <LogOut size={18} />
                        </button>
                    </div>
                </div>
            </div>

            {/* Main */}
            <div className="flex-1 flex flex-col overflow-hidden bg-[#fcfaf7]">
                {/* Tabs */}
                <div className="h-12 bg-[#fcfaf7] border-b border-[#e5e1d8] flex items-center px-2 gap-1 overflow-x-auto pt-2">
                    {documents.map(doc => {
                        const docColor = DOC_COLORS[(doc.colorIndex || 0) % DOC_COLORS.length];
                        const isActive = activeDocId === doc.id;
                        return (
                            <div key={doc.id} onClick={() => {
                                setActiveDocId(doc.id);
                                setActivePage(1);
                                setSelectedResult(null);
                                // Reset view state when switching docs to prevent zoom inheritance
                                setRotation(0);
                                setPanX(50);
                                setPanY(50);
                                // Note: Zoom will be handled by the fitToScreen useEffect
                            }}
                                className={`group flex items-center gap-2 px-4 py-2 rounded-t-lg text-xs font-medium cursor-pointer border-t-4 transition-all ${isActive ? `bg-white ${docColor.text} border-x border-[#e5e1d8] shadow-sm -mb-px z-10 ${docColor.activeBorder}` : 'text-[#888888] hover:bg-[#f4f1ea] hover:text-[#555555] border-t-transparent'}`}>
                                {/* Icon color matches tab color */}
                                {doc.ocrData ? <FileCheck size={14} className={isActive ? docColor.text : "text-emerald-500"} /> : doc.pdfTextData ? <FileText size={14} className={isActive ? docColor.text : "text-amber-500"} /> : <FileX size={14} className={isActive ? docColor.text : "text-red-500"} />}
                                <span className="max-w-32 truncate">{doc.name}</span>
                                {doc.totalPages > 1 && <span className="text-[10px] opacity-70">({doc.totalPages}p)</span>}
                                <button onClick={(e) => { e.stopPropagation(); closeDocument(doc.id); }} className="p-0.5 opacity-0 group-hover:opacity-100 text-[#a0a0a0] hover:text-red-500 transition-all"><X size={12} /></button>
                            </div>
                        )
                    })}
                    <div className="flex gap-2 ml-3">
                        <button onClick={() => initiateUpload('pdf', 'drawings')} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#555555] bg-[#f4f1ea] hover:bg-[#e5e1d8] hover:text-[#333333] rounded-md transition-colors"><Plus size={16} /> 도면 업로드</button>
                        <button onClick={() => initiateUpload('pdf', 'documents')} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#d97757] bg-[#fff0eb] hover:bg-[#ffe0d6] hover:text-[#c05535] rounded-md transition-colors"><Plus size={16} /> 설계자료 업로드</button>

                        <button onClick={handleReset} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors border border-red-100"><Trash2 size={14} /> 초기화</button>
                    </div>
                    <input ref={fileInputRef} type="file" accept=".pdf" multiple className="hidden" onChange={(e) => handleFilesUpload(e, 'pdf')} />
                    <input ref={jsonInputRef} type="file" accept=".json" multiple className="hidden" onChange={(e) => handleFilesUpload(e, 'json')} />
                </div>

                {/* Toolbar */}
                <div className="h-12 bg-white border-b border-[#e5e1d8] flex items-center justify-between px-6 shadow-sm z-10">
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-1 bg-[#f4f1ea] rounded-lg p-1">
                            <button onClick={() => setZoom(z => Math.max(z * 0.8, 0.05))} className="p-1.5 hover:bg-white rounded-md text-[#555555] transition-all shadow-sm hover:shadow"><ZoomOut size={16} /></button>
                            <span className="text-xs font-medium w-12 text-center text-[#333333]">{(zoom * 100).toFixed(0)}%</span>
                            <button onClick={() => setZoom(z => Math.min(z * 1.25, 5))} className="p-1.5 hover:bg-white rounded-md text-[#555555] transition-all shadow-sm hover:shadow"><ZoomIn size={16} /></button>
                        </div>
                        <button onClick={fitToScreen} className="px-3 py-1.5 hover:bg-[#f4f1ea] text-[#555555] hover:text-[#333333] rounded-md text-xs font-medium border border-[#e5e1d8] transition-all">Fit</button>
                        <button onClick={() => setRotation(r => (r + 90) % 360)} className="p-1.5 hover:bg-[#f4f1ea] text-[#555555] hover:text-[#333333] rounded-md transition-all" title="Rotate"><RotateCw size={16} /></button>
                        <button onClick={() => { setZoom(1); setPanX(50); setPanY(50); setRotation(0); }} className="p-1.5 hover:bg-[#f4f1ea] text-[#555555] hover:text-[#333333] rounded-md transition-all" title="Reset"><RotateCcw size={16} /></button>

                        <div className="h-6 w-px bg-[#e5e1d8] mx-2"></div>

                        {/* Extraction Progress Bar */}
                        {extractionProgress && (
                            <div className="flex items-center gap-2 mr-4 bg-[#fff8f0] border border-[#ffecd6] px-2 py-1 rounded-md">
                                <Loader2 size={14} className="animate-spin text-[#d97757]" />
                                <div className="flex flex-col">
                                    <span className="text-[10px] font-medium text-[#d97757] leading-tight">Processing Text</span>
                                    <div className="w-20 h-1 bg-[#ffecd6] rounded-full mt-0.5 overflow-hidden">
                                        <div className="h-full bg-[#d97757] transition-all duration-300" style={{ width: `${(extractionProgress.current / extractionProgress.total) * 100}%` }}></div>
                                    </div>
                                </div>
                                <span className="text-[9px] text-[#c05535] font-mono ml-1">{extractionProgress.current}/{extractionProgress.total}</span>
                            </div>
                        )}

                        {/* Pagination - Always show if doc is loaded, even if 1 page, to be consistent */}
                        {activeDoc && (
                            <div className="flex items-center gap-2 bg-[#f4f1ea] rounded-lg p-1 px-2">
                                <button onClick={() => goToPage(activePage - 1)} disabled={activePage <= 1} className="p-1.5 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-white rounded-md text-[#555555] transition-all shadow-sm hover:shadow" title="Previous Page"><ChevronLeft size={16} /></button>
                                <div className="flex items-center text-xs font-semibold text-[#333333]">
                                    <input
                                        type="number"
                                        className="w-10 text-center bg-transparent focus:bg-white border-b border-transparent focus:border-[#d97757] outline-none transition-all p-0.5 appearance-none"
                                        value={inputPage}
                                        onChange={handlePageInputChange}
                                        onKeyDown={handlePageInputKeyDown}
                                        onBlur={handlePageInputBlur}
                                    />
                                    <span className="select-none text-[#888888] ml-1">/ {activeDoc.totalPages || 1}</span>
                                </div>
                                <button onClick={() => goToPage(activePage + 1)} disabled={activePage >= (activeDoc.totalPages || 1)} className="p-1.5 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-white rounded-md text-[#555555] transition-all shadow-sm hover:shadow" title="Next Page"><ChevronRight size={16} /></button>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-3 text-xs font-medium">
                        {/* Chat Scope Toggle */}
                        <div className="flex items-center gap-1 bg-[#f4f1ea] rounded-lg p-0.5 border border-[#e5e1d8]">
                            <button
                                onClick={() => setChatScope('active')}
                                className={`px-2 py-1 text-[10px] font-bold rounded-md transition-all ${chatScope === 'active' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#888888] hover:text-[#555555]'}`}
                                title="Chat with current document only"
                            >
                                Active
                            </button>
                            <button
                                onClick={() => setChatScope('all')}
                                className={`px-2 py-1 text-[10px] font-bold rounded-md transition-all ${chatScope === 'all' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#888888] hover:text-[#555555]'}`}
                                title="Chat with all open documents"
                            >
                                All
                            </button>
                        </div>
                        <div className="w-px h-4 bg-[#e5e1d8]"></div>

                        {/* Unified Progress Indicator */}
                        {(loadingProgress || extractionProgress || isLoading) && (
                            <div className="flex items-center gap-2 bg-[#f4f1ea] px-3 py-1.5 rounded-full border border-[#e5e1d8]">
                                {loadingProgress ? (
                                    <>
                                        <div className="w-4 h-4 rounded-full border-2 border-[#d97757]/30 border-t-[#d97757] animate-spin" />
                                        <span className="text-[10px] font-medium text-[#d97757]">
                                            Downloading {Math.round((loadingProgress.current / loadingProgress.total) * 100)}%
                                        </span>
                                    </>
                                ) : extractionProgress ? (
                                    <>
                                        <div className="relative w-4 h-4 flex items-center justify-center">
                                            <svg className="w-full h-full transform -rotate-90">
                                                <circle cx="8" cy="8" r="7" fill="none" stroke="#e5e1d8" strokeWidth="2" />
                                                <circle cx="8" cy="8" r="7" fill="none" stroke="#d97757" strokeWidth="2" strokeDasharray="44" strokeDashoffset={44 - (44 * (extractionProgress.current / extractionProgress.total))} className="transition-all duration-300" />
                                            </svg>
                                        </div>
                                        <span className="text-[10px] font-medium text-[#d97757]">
                                            Analyzing {Math.round((extractionProgress.current / extractionProgress.total) * 100)}%
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <Loader2 size={14} className="animate-spin text-[#d97757]" />
                                        <span className="text-[10px] font-medium text-[#d97757]">Rendering...</span>
                                    </>
                                )}
                            </div>
                        )}
                        {activeDoc && (hasOcr ? <span className="text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100">OCR Ready</span> : hasPdfText ? <span className="text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-100">PDF Text</span> : <span className="text-red-500 bg-red-50 px-2 py-0.5 rounded-full border border-red-100">No Data</span>)}
                        <button
                            onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
                            className={`p-2 rounded-lg transition-all ${rightSidebarOpen ? 'bg-[#d97757] text-white shadow-sm' : 'text-[#555555] hover:bg-[#f4f1ea]'}`}
                            title="Toggle AI Chat"
                        >
                            <MessageSquare size={18} />
                        </button>
                    </div>
                </div>



                {/* Canvas */}
                <div
                    ref={containerRef}
                    className={`flex-1 overflow-hidden bg-[#f0ede6] relative flex items-center justify-center ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                >
                    {activeDoc ? (
                        <>
                            {isLoading && (
                                <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#f0ede6]/90 backdrop-blur-sm">
                                    <Loader2 size={48} className="animate-spin text-[#d97757] mb-4" />
                                    <h3 className="text-lg font-medium text-[#333333] mb-2">도면을 렌더링 중입니다</h3>
                                    <p className="text-sm text-[#888888]">잠시만 기다려 주세요...</p>
                                </div>
                            )}
                            <div style={{ transform: `scale(${zoom}) translate(${(50 - (isNaN(panX) ? 50 : panX))}%, ${(50 - (isNaN(panY) ? 50 : panY))}%)`, transformOrigin: 'center center' }} className="relative shadow-xl transition-transform duration-75 ease-out">
                                <canvas ref={canvasRef} className="block bg-white" />

                                {canvasSize.width > 0 && (currentPageData?.layout || currentPageData?.lines) && (
                                    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}>
                                        {searchResults.filter(r => r.docId === activeDocId && r.pageNum === activePage && r !== selectedResult && r.polygon).map((r, i) => (
                                            <polygon key={i} points={getPolygonPoints(r)} fill="rgba(250,204,21,0.2)" stroke="rgba(250,204,21,0.6)" strokeWidth="2" />
                                        ))}
                                        {selectedResult && selectedResult.docId === activeDocId && selectedResult.pageNum === activePage && selectedCenter && selectedResult.polygon && (
                                            <>
                                                <polygon points={getPolygonPoints(selectedResult)} fill="rgba(217,119,87,0.2)" stroke="#d97757" strokeWidth="3" />
                                                <circle cx={selectedCenter.cx} cy={selectedCenter.cy} r="15" fill="none" stroke="#d97757" strokeWidth="2" opacity="0.8" />
                                                <line x1={selectedCenter.cx - 20} y1={selectedCenter.cy} x2={selectedCenter.cx + 20} y2={selectedCenter.cy} stroke="#d97757" strokeWidth="2" />
                                                <line x1={selectedCenter.cx} y1={selectedCenter.cy - 20} x2={selectedCenter.cx} y2={selectedCenter.cy + 20} stroke="#d97757" strokeWidth="2" />
                                            </>
                                        )}
                                    </svg>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="text-center p-10 bg-white rounded-2xl shadow-sm border border-[#e5e1d8]">
                            <div className="bg-[#f4f1ea] p-4 rounded-full inline-block mb-4">
                                <FileText size={48} className="text-[#d97757]" />
                            </div>
                            <h3 className="text-lg font-serif font-bold text-[#333333] mb-2">선택된 도면이 없습니다</h3>
                            <p className="text-[#666666] mb-6 text-sm">시작하려면 도면을 등록해주세요.</p>
                            <div className="flex gap-3 justify-center">
                                <button onClick={() => initiateUpload('pdf')} className="px-5 py-2.5 bg-[#d97757] hover:bg-[#c05535] text-white rounded-lg text-sm font-medium shadow-sm transition-all flex items-center gap-2"><Plus size={16} /> 도면 업로드</button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Nav */}
                {activeDoc && (
                    <div className="h-12 bg-white border-t border-[#e5e1d8] px-6 flex items-center gap-6 shadow-[0_-2px_10px_rgba(0,0,0,0.02)] z-10">
                        <div className="flex items-center gap-3 flex-1">
                            <span className="text-xs font-bold text-[#888888] w-4">X</span>
                            <input type="range" min={panRange.minX} max={panRange.maxX} step="0.5" value={panX} onChange={(e) => setPanX(+e.target.value)} className="flex-1 h-1.5 bg-[#f0ede6] rounded-full cursor-pointer accent-[#d97757]" />
                        </div>
                        <div className="flex items-center gap-3 flex-1">
                            <span className="text-xs font-bold text-[#888888] w-4">Y</span>
                            <input type="range" min={panRange.minY} max={panRange.maxY} step="0.5" value={panY} onChange={(e) => setPanY(+e.target.value)} className="flex-1 h-1.5 bg-[#f0ede6] rounded-full cursor-pointer accent-[#d97757]" />
                        </div>
                        <button onClick={() => { setPanX(50); setPanY(50); }} className="px-4 py-1.5 bg-[#f4f1ea] hover:bg-[#e5e1d8] text-[#555555] rounded-md text-xs font-medium transition-colors"><Move size={14} className="inline mr-1.5" />Center</button>
                    </div>
                )}

                {/* Status */}
                <div className="h-6 bg-[#fcfaf7] border-t border-[#e5e1d8] px-4 flex items-center justify-between text-[10px] font-medium text-[#888888]">
                    <span>{documents.length} documents • {searchResults.length} matches found</span>
                    <span>v4.1 (Azure Integrated)</span>
                </div>
            </div>

            {/* Right Sidebar (Chat) */}
            <div
                className={`border-l border-[#e5e1d8] bg-white overflow-hidden flex flex-col relative ${!isResizing ? 'transition-[width] duration-300' : ''}`}
                style={{ width: rightSidebarOpen ? sidebarWidth : 0 }}
            >
                {/* Drag Handle */}
                <div
                    onMouseDown={(e) => { setIsResizing(true); }}
                    className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#d97757] z-50 transition-colors opacity-0 hover:opacity-100"
                    title="Drag to resize"
                />

                <div style={{ width: sidebarWidth }} className="h-full">
                    <ChatInterface activeDoc={activeDoc} documents={documents} chatScope={chatScope} onCitationClick={handleCitationClick} />
                </div>
            </div>

            {/* Source Selection Modal */}
            {
                showSourceModal && (
                    <div className="absolute inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50">
                        <div className="bg-white rounded-xl shadow-2xl p-6 w-96 border border-[#e5e1d8]">
                            <div className="flex justify-between items-center mb-4">
                                <h3 className="text-lg font-bold text-[#333333]">Upload Source</h3>
                                <button onClick={() => setShowSourceModal(false)} className="text-[#888888] hover:text-[#333333]"><X size={20} /></button>
                            </div>
                            <div className="space-y-3">
                                <button onClick={handleLocalUpload} className="w-full flex items-center gap-3 p-4 rounded-lg border border-[#e5e1d8] hover:border-[#d97757] hover:bg-[#fff8f0] transition-all group">
                                    <div className="bg-[#f4f1ea] p-2 rounded-full group-hover:bg-[#fff0eb]"><Monitor size={24} className="text-[#555555] group-hover:text-[#d97757]" /></div>
                                    <div className="text-left">
                                        <div className="font-bold text-[#333333]">{uploadCategory === 'documents' ? '설계 데이터 등록하기' : '도면 등록하기'}</div>
                                        <div className="text-xs text-[#888888]">업로드 즉시 AI가 {uploadCategory === 'documents' ? '설계 데이터' : '도면 데이터'}를 정밀 판독합니다.</div>
                                    </div>
                                </button>
                                <button onClick={handleAzureUpload} className="w-full flex items-center gap-3 p-4 rounded-lg border border-[#e5e1d8] hover:border-[#0078d4] hover:bg-[#f0f8ff] transition-all group">
                                    <div className="bg-[#f4f1ea] p-2 rounded-full group-hover:bg-[#e6f2ff]"><Cloud size={24} className="text-[#555555] group-hover:text-[#0078d4]" /></div>
                                    <div className="text-left">
                                        <div className="font-bold text-[#333333]">{uploadCategory === 'documents' ? '내가 등록한 설계 데이터 찾기' : '내가 등록한 도면 찾기'}</div>
                                        <div className="text-xs text-[#888888]">분석이 완료된 {uploadCategory === 'documents' ? '설계 데이터' : '도면'}을 즉시 확인하고 활용하세요.</div>
                                    </div>
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }


            {/* Azure File Browser Modal */}
            {
                showAzureBrowser && (
                    <div className="absolute inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50">
                        <div className="bg-white rounded-xl shadow-2xl w-[600px] h-[500px] flex flex-col border border-[#e5e1d8]">
                            <div className="p-4 border-b border-[#e5e1d8] flex justify-between items-center bg-[#fcfaf7] rounded-t-xl">
                                <h3 className="text-lg font-bold text-[#333333] flex items-center gap-2"><Cloud size={20} className="text-[#0078d4]" /> Azure Blob Storage</h3>
                                <button onClick={() => setShowAzureBrowser(false)} className="text-[#888888] hover:text-[#333333]"><X size={20} /></button>
                            </div>

                            <div className="p-2 bg-[#f4f1ea] border-b border-[#e5e1d8] flex items-center gap-2 text-sm">
                                <button onClick={() => {
                                    // Calculate locked root again for Home button
                                    const userName = (userProfile?.name || currentUser?.displayName || '').trim();
                                    const categoryFolder = uploadCategory === 'documents' ? 'documents' : 'drawings';
                                    const lockedRootPath = userName ? `${userName}/${categoryFolder}` : '';
                                    fetchAzureItems(lockedRootPath);
                                }} className="p-1 hover:bg-[#e5e1d8] rounded" title="Home"><RotateCcw size={14} /></button>
                                <span className="text-[#666666]">Path:</span>
                                <span className="font-mono text-[#333333] bg-white px-2 py-0.5 rounded border border-[#dcd8d0] flex-1 truncate">/{azurePath}</span>
                                {(() => {
                                    // Calculate strict root to decide if "Up" is allowed
                                    const userName = (userProfile?.name || currentUser?.displayName || '').trim();
                                    const categoryFolder = uploadCategory === 'documents' ? 'documents' : 'drawings';
                                    const lockedRootPath = userName ? `${userName}/${categoryFolder}` : '';

                                    // Check if current path depends on locked path
                                    const normalize = (p) => p.replace(/\/$/, '');
                                    const current = normalize(azurePath);
                                    const root = normalize(lockedRootPath);

                                    // allow going up only if deeper than root
                                    // Ensure simple string comparison works by handling slashes
                                    const canGoUp = current.length > root.length && current.startsWith(root);

                                    return canGoUp ? (
                                        <button onClick={() => fetchAzureItems(azurePath.split('/').slice(0, -2).join('/') + (azurePath.split('/').length > 2 ? '/' : ''))} className="px-2 py-0.5 bg-[#e5e1d8] hover:bg-[#dcd8d0] rounded text-xs">Up</button>
                                    ) : null;
                                })()}
                            </div>

                            {error && (
                                <div className="mx-4 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm flex items-center gap-2">
                                    <X size={16} />
                                    {error}
                                </div>
                            )}

                            <div className="flex-1 overflow-y-auto p-2">
                                {azureLoading ? (
                                    <div className="flex flex-col items-center justify-center h-full text-[#888888]">
                                        <Loader2 size={32} className="animate-spin mb-3 text-[#d97757]" />

                                        {loadingType === 'downloading' ? (
                                            <>
                                                <span className="font-medium text-[#333333] mb-1">데이터를 불러오고 있습니다</span>
                                                <span className="text-xs text-[#888888]">파일이 많을 경우 시간이 소요될 수 있습니다.</span>
                                                <span className="text-xs text-[#888888] mb-4">잠시만 기다려주세요...</span>

                                                {/* Progress Bar */}
                                                <div className="w-48 h-1 bg-[#f0ede6] rounded-full overflow-hidden relative">
                                                    <div className="absolute top-0 left-0 h-full w-full bg-[#d97757] animate-indeterminate origin-left"></div>
                                                </div>
                                            </>
                                        ) : (
                                            <span className="text-sm">Loading...</span>
                                        )}
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-4 gap-2">
                                        {azureItems.map((item, i) => {
                                            const isSelected = selectedAzureItems.some(sel => sel.path === item.path);
                                            return (
                                                <div key={i} onClick={() => handleAzureItemClick(item)}
                                                    className={`p-3 rounded-lg border cursor-pointer flex flex-col items-center gap-2 text-center transition-all group relative ${isSelected ? 'bg-[#fff8f0] border-[#d97757] ring-1 ring-[#d97757]' : 'border-[#e5e1d8] hover:border-[#0078d4] hover:bg-[#f0f8ff]'}`}>
                                                    {item.type === 'folder' ? (
                                                        <Folder size={32} className="text-[#d97757] group-hover:text-[#0078d4]" />
                                                    ) : (
                                                        <File size={32} className={isSelected ? "text-[#d97757]" : "text-[#888888] group-hover:text-[#0078d4]"} />
                                                    )}
                                                    {isSelected && <div className="absolute top-2 right-2 bg-[#d97757] text-white rounded-full p-0.5"><Check size={10} /></div>}
                                                    <span className={`text-xs font-medium break-all line-clamp-2 ${isSelected ? 'text-[#d97757]' : 'text-[#333333]'}`}>{item.name}</span>
                                                </div>
                                            )
                                        })}
                                        {azureItems.length === 0 && (
                                            <div className="col-span-4 text-center py-10 text-[#888888]">Folder is empty</div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Azure Modal Footer */}
                            <div className="p-4 border-t border-[#e5e1d8] bg-[#fcfaf7] rounded-b-xl flex justify-between items-center">
                                <span className="text-xs text-[#888888]">{selectedAzureItems.length} files selected</span>
                                <div className="flex gap-2">
                                    <button onClick={() => { setSelectedAzureItems([]); setShowAzureBrowser(false); }} className="px-4 py-2 bg-white border border-[#dcd8d0] hover:bg-[#e5e1d8] text-[#555555] rounded-lg text-sm font-medium transition-colors">Cancel</button>
                                    <button
                                        onClick={handleAzureBatchUpload}
                                        disabled={selectedAzureItems.length === 0}
                                        className="px-4 py-2 bg-[#d97757] hover:bg-[#c05535] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                                    >
                                        <Download size={16} /> Load Selected ({selectedAzureItems.length})
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )
            }


            {/* Analysis Confirmation Modal */}
            {
                showAnalysisConfirmModal && pendingUploads.length > 0 && (
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[70]">
                        <div className="bg-white rounded-xl shadow-2xl p-6 w-[450px] border border-[#e5e1d8] animate-in fade-in zoom-in duration-200">
                            <div className="text-center mb-6">
                                <div className="bg-[#e6f2ff] w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                                    <Monitor size={24} className="text-[#0078d4]" />
                                </div>
                                <h3 className="text-lg font-bold text-[#333333] mb-1">AI 도면 분석을 시작할까요?</h3>
                                <p className="text-sm font-medium text-[#333333] mb-2">
                                    {pendingUploads.length > 1
                                        ? `${pendingUploads[0].file.name} 외 ${pendingUploads.length - 1}개`
                                        : pendingUploads[0]?.file.name}
                                </p>
                                <p className="text-xs text-[#666666] bg-[#f9fafb] p-3 rounded-lg border border-[#e5e7eb]">
                                    <span className="font-bold text-[#d97757]">💡 팁:</span> 분석을 진행하면 도면의 텍스트, 기호, 장비 태그를 자동으로 인식하여 <span className="font-bold">검색 및 하이라이트</span> 기능을 사용할 수 있습니다.<br /><br />
                                    300페이지 이상의 대용량 도면은 분석에 시간이 소요될 수 있습니다.
                                </p>
                            </div>

                            <div className="flex gap-3">
                                <button
                                    onClick={cancelAnalysis}
                                    className="flex-1 px-4 py-3 bg-white border border-[#dcd8d0] hover:bg-[#f5f5f5] text-[#555555] rounded-lg text-sm font-medium transition-colors"
                                >
                                    취소 (뷰어만 실행)
                                </button>
                                <button
                                    onClick={confirmAnalysis}
                                    className="flex-1 px-4 py-3 bg-[#0078d4] hover:bg-[#0063b1] text-white rounded-lg text-sm font-medium transition-colors shadow-sm"
                                >
                                    AI 분석 시작
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* New Message Alert Popup */}
            {
                newMessagePopup && (
                    <div
                        className="fixed top-20 right-6 z-[100] bg-white rounded-2xl shadow-2xl border-l-[4px] border-[#d97757] p-4 flex gap-4 min-w-[320px] animate-in slide-in-from-right-full duration-300 cursor-pointer hover:bg-[#fcfaf7]"
                        onClick={() => {
                            setNewMessagePopup(null);
                            navigate('/profile');
                        }}
                    >
                        <div className="bg-[#fff0eb] p-2 rounded-xl text-[#d97757] h-fit">
                            <MessageSquare size={20} />
                        </div>
                        <div className="flex-1">
                            <div className="flex justify-between items-start mb-1">
                                <h4 className="font-bold text-sm text-[#333333]">새 메시지 도착</h4>
                                <span className="text-[10px] text-[#a0a0a0]">방금 전</span>
                            </div>
                            <p className="text-xs text-[#666666] font-medium mb-1">
                                <span className="text-[#d97757] font-bold">{newMessagePopup.senderName}</span>님이 메시지를 보냈습니다.
                            </p>
                            <p className="text-[10px] text-[#888888] line-clamp-1">{newMessagePopup.content || "공유된 도면 데이터가 있습니다."}</p>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); setNewMessagePopup(null); }} className="text-gray-400 hover:text-gray-600">
                            <X size={14} />
                        </button>
                    </div>
                )
            }

            {/* Analysis Progress Modal */}
            {
                analysisState.isAnalyzing && (
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center z-[80]">
                        <div className="bg-white rounded-xl shadow-2xl p-8 w-[400px] text-center border border-[#e5e1d8] animate-in fade-in zoom-in duration-300">
                            <div className="mb-6 relative">
                                <div className="w-16 h-16 border-4 border-[#e6f2ff] border-t-[#0078d4] rounded-full animate-spin mx-auto"></div>
                                <div className="absolute inset-0 flex items-center justify-center font-bold text-[#0078d4] text-xs">AI</div>
                            </div>

                            <h3 className="text-lg font-bold text-[#333333] mb-2">도면을 분석하고 있습니다</h3>
                            <p className="text-sm text-[#666666] mb-6 animate-pulse">{analysisState.status}</p>

                            <div className="w-full h-2 bg-[#f0ede6] rounded-full overflow-hidden mb-2 relative">
                                <div
                                    className="h-full bg-gradient-to-r from-[#0078d4] to-[#00bcf2] transition-all duration-300 ease-out relative"
                                    style={{ width: `${analysisState.progress}%` }}
                                >
                                    <div className="absolute inset-0 bg-white/30 animate-[shimmer_2s_infinite]"></div>
                                </div>
                            </div>
                            <div className="flex justify-between text-xs text-[#888888] font-mono">
                                <span>Progress</span>
                                <span>{analysisState.progress}%</span>
                            </div>

                            <div className="mt-6 text-xs text-[#a0a0a0] bg-[#fdfdfd] p-3 rounded border border-[#f0f0f0]">
                                창을 닫지 마세요. 대용량 파일은 1~2분 정도 소요될 수 있습니다.
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Scope Selection Modal */}
            {
                showScopeSelectionModal && (
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[60]">
                        <div className="bg-white rounded-xl shadow-2xl p-6 w-[400px] border border-[#e5e1d8] animate-in fade-in zoom-in duration-200">
                            <div className="text-center mb-6">
                                <div className="bg-[#fff8f0] w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                                    <MessageSquare size={24} className="text-[#d97757]" />
                                </div>
                                <h3 className="text-lg font-bold text-[#333333] mb-1">업로드 완료!</h3>
                                <p className="text-sm text-[#666666]">채팅 범위를 어떻게 설정하시겠습니까?</p>
                            </div>

                            <div className="flex flex-col gap-3">
                                <button
                                    onClick={() => { setChatScope('active'); setShowScopeSelectionModal(false); setHasUserSelectedScope(true); }}
                                    className="flex items-center gap-3 p-4 rounded-lg border border-[#e5e1d8] hover:border-[#d97757] hover:bg-[#fff8f0] transition-all group text-left"
                                >
                                    <div className="bg-[#f4f1ea] p-2 rounded-full group-hover:bg-[#fff0eb]">
                                        <FileText size={20} className="text-[#555555] group-hover:text-[#d97757]" />
                                    </div>
                                    <div>
                                        <div className="font-bold text-[#333333] text-sm">현재 도면만 채팅</div>
                                        <div className="text-xs text-[#888888]">지금 보고 있는 도면에 대해서만 질문합니다.</div>
                                    </div>
                                </button>

                                <button
                                    onClick={() => { setChatScope('all'); setShowScopeSelectionModal(false); setHasUserSelectedScope(true); }}
                                    className="flex items-center gap-3 p-4 rounded-lg border border-[#e5e1d8] hover:border-[#d97757] hover:bg-[#fff8f0] transition-all group text-left"
                                >
                                    <div className="bg-[#f4f1ea] p-2 rounded-full group-hover:bg-[#fff0eb]">
                                        <Files size={20} className="text-[#555555] group-hover:text-[#d97757]" />
                                    </div>
                                    <div>
                                        <div className="font-bold text-[#333333] text-sm">전체 도면 채팅</div>
                                        <div className="text-xs text-[#888888]">업로드된 모든 도면을 대상으로 질문합니다.</div>
                                    </div>
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Messaging Modal */}
            <MessageModal
                isOpen={isMessageModalOpen}
                onClose={() => {
                    setIsMessageModalOpen(false);
                    setShareMessageData(null);
                }}
                shareData={shareMessageData}
                senderName={userProfile?.name}
            />
        </div >
    );
};


export default App;
