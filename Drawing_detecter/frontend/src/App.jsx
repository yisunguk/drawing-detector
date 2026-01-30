import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Search, ZoomIn, ZoomOut, RotateCcw, RotateCw, X, Plus, FileText, ChevronRight, ChevronLeft, Download, Grid3X3, List, Loader2, Check, Copy, Move, FileCheck, FileX, Cloud, Monitor, Folder, File, MessageSquare } from 'lucide-react';
import ChatInterface from './components/ChatInterface';

import { BlobServiceClient } from '@azure/storage-blob';

const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Azure Configuration
const AZURE_STORAGE_ACCOUNT_NAME = "encdevmkcsaaitest";
const AZURE_CONTAINER_NAME = "blob-leesunguk";
const AZURE_SAS_TOKEN = "sv=2024-11-04&ss=bfqt&srt=sco&sp=rwdlacupiytfx&se=2027-12-31T09:21:21Z&st=2026-01-29T01:06:21Z&spr=https,http&sig=V4Ha%2Bu0hAKwVpQE86WNvD4nBTBgvFe1c6bii3PjCQcE%3D";
const AZURE_CONTAINER_URL = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${AZURE_CONTAINER_NAME}?${AZURE_SAS_TOKEN}`;

const classifyTag = (content) => {
    if (/^(\d{1,2}["']?)[-]([A-Z]{1,4})[-]?(\d{3,5})/.test(content)) return 'line';
    if (/^([A-Z]{2,4})[-_]?(\d{3,4}[A-Z]?)$/.test(content)) return 'instrument';
    if (/^([A-Z]{1,3}V)[-_]?(\d{3,4})$/.test(content)) return 'valve';
    if (/^([A-Z])[-_]?(\d{3,4})$/.test(content)) return 'equipment';
    return 'other';
};

const App = () => {
    const [documents, setDocuments] = useState([]);
    const [activeDocId, setActiveDocId] = useState(null);
    const [activePage, setActivePage] = useState(1);
    const [searchTerm, setSearchTerm] = useState('');
    const [searchScope, setSearchScope] = useState('all');
    const [selectedResult, setSelectedResult] = useState(null);
    const [filters, setFilters] = useState({ line: true, instrument: true, valve: true, equipment: true, other: true });
    const [zoom, setZoom] = useState(1);
    const [rotation, setRotation] = useState(0);
    const [panX, setPanX] = useState(50);
    const [panY, setPanY] = useState(50);
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
    const [isLoading, setIsLoading] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
    const [viewMode, setViewMode] = useState('list');
    const [copiedTag, setCopiedTag] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

    // Azure Integration State
    const [showSourceModal, setShowSourceModal] = useState(false);
    const [uploadType, setUploadType] = useState(null); // 'pdf' or 'json'
    const [showAzureBrowser, setShowAzureBrowser] = useState(false);
    const [azurePath, setAzurePath] = useState('');
    const [azureItems, setAzureItems] = useState([]);
    const [azureLoading, setAzureLoading] = useState(false);
    const [error, setError] = useState(null);

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
            script.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL; };
            document.head.appendChild(script);
        }
    }, []);

    useEffect(() => {
        const updateSize = () => {
            if (containerRef.current) {
                setContainerSize({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
            }
        };
        updateSize();
        setTimeout(updateSize, 100);
        window.addEventListener('resize', updateSize);
        return () => window.removeEventListener('resize', updateSize);
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
            // Use natural viewport without automatic adjustments that might flip drawings
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
        if (!ocrData?.layout?.lines) return [];
        const lines = ocrData.layout.lines;
        const bubbles = [];
        const used = new Set();

        lines.forEach((line1, i) => {
            if (used.has(i) || !/^N\d+[A-Z]?$/i.test(line1.content.trim())) return;
            lines.forEach((line2, j) => {
                if (i === j || used.has(j)) return;
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
        if (!searchTerm.trim()) return [];
        const cleanSearch = searchTerm.toLowerCase().replace(/\s+/g, '');
        const results = [];
        const docsToSearch = searchScope === 'all' ? documents : documents.filter(d => d.id === activeDocId);

        docsToSearch.forEach(doc => {
            const dataSource = doc.ocrData || doc.pdfTextData;
            if (!dataSource) return;
            const pages = Array.isArray(dataSource) ? dataSource : [dataSource];

            pages.forEach((pageData, idx) => {
                if (!pageData?.layout) return;
                const pageNum = pageData.page_number || idx + 1;
                const lines = pageData.layout.lines || [];

                lines.forEach(line => {
                    const cleanContent = line.content.replace(/\s+/g, '').toLowerCase();
                    if (cleanContent.includes(cleanSearch)) {
                        const type = classifyTag(line.content);
                        if (filters[type]) {
                            results.push({
                                content: line.content,
                                polygon: [...line.polygon],
                                docId: doc.id,
                                docName: doc.name,
                                pageNum,
                                tagType: type,
                                layoutWidth: pageData.layout.width,
                                layoutHeight: pageData.layout.height,
                            });
                        }
                    }
                });

                if (doc.ocrData) {
                    const bubbles = parseInstrumentBubbles(pageData);
                    bubbles.forEach(bubble => {
                        const nb = bubble.content.toLowerCase().replace(/[\s/]+/g, '');
                        if (nb.includes(cleanSearch.replace(/[\s/]+/g, ''))) {
                            if (filters.instrument) {
                                results.push({
                                    content: bubble.content,
                                    polygon: [...bubble.polygon],
                                    docId: doc.id,
                                    docName: doc.name,
                                    pageNum,
                                    tagType: 'instrument',
                                    layoutWidth: pageData.layout.width,
                                    layoutHeight: pageData.layout.height,
                                });
                            }
                        }
                    });
                }
            });
        });
        return results;
    }, [searchTerm, documents, activeDocId, searchScope, filters, parseInstrumentBubbles]);

    // PDF 로드 및 페이지 렌더링
    const loadAndRenderPage = useCallback(async (doc, pageNum) => {
        if (!window.pdfjsLib || !canvasRef.current || !doc?.pdfData) return;
        setIsLoading(true);

        try {
            let pdf = pdfRef.current;
            if (!pdf || pdf.docId !== doc.id) {
                pdf = await window.pdfjsLib.getDocument({ data: doc.pdfData }).promise;
                pdf.docId = doc.id;
                pdfRef.current = pdf;

                const totalPages = pdf.numPages;
                setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, totalPages } : d));

                if (!doc.ocrData && !doc.pdfTextData) {
                    const textData = [];
                    for (let i = 1; i <= totalPages; i++) {
                        const data = await extractPdfText(pdf, i);
                        if (data) textData.push(data);
                    }
                    setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, pdfTextData: textData } : d));
                }
            }

            const page = await pdf.getPage(pageNum);

            // Respect natural rotation + user rotation
            const naturalRotation = page.rotate || 0;
            const totalRotation = (naturalRotation + rotation) % 360;

            let viewport = page.getViewport({ scale: 2.0, rotation: totalRotation });
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');

            canvas.width = viewport.width;
            canvas.height = viewport.height;
            ctx.clearRect(0, 0, viewport.width, viewport.height);

            setCanvasSize({ width: viewport.width, height: viewport.height });

            // Cancel any existing render task to prevent "same canvas" error
            if (renderTaskRef.current) {
                try {
                    renderTaskRef.current.cancel();
                } catch (e) {
                    console.warn('Render cancellation error:', e);
                }
            }

            const renderContext = { canvasContext: ctx, viewport };
            const renderTask = page.render(renderContext);
            renderTaskRef.current = renderTask;

            try {
                await renderTask.promise;
                if (renderTaskRef.current === renderTask) {
                    renderTaskRef.current = null;
                }
            } catch (err) {
                if (err.name === 'RenderingCancelledException' || err.message?.includes('cancelled')) {
                    return;
                }
                console.error('Render promise error:', err);
                throw err;
            }

            // Auto-fit after rendering
            setTimeout(() => {
                if (containerRef.current && viewport.width && viewport.height) {
                    const containerWidth = containerRef.current.clientWidth;
                    const containerHeight = containerRef.current.clientHeight;
                    const padding = 20;
                    const scaleX = (containerWidth - padding) / viewport.width;
                    const scaleY = (containerHeight - padding) / viewport.height;
                    const fitZoom = Math.min(scaleX, scaleY);
                    setZoom(fitZoom);
                    setPanX(50);
                    setPanY(50);
                }
            }, 100);

        } catch (err) {
            console.error('PDF error:', err);
        }
        setIsLoading(false);
    }, [extractPdfText, rotation]);

    useEffect(() => {
        if (activeDoc) {
            loadAndRenderPage(activeDoc, activePage);
        }
    }, [activeDoc, activePage, loadAndRenderPage]);

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
        if (canvasSize.width && containerSize.width && activeDoc) {
            setTimeout(fitToScreen, 200);
        }
    }, [canvasSize.width, containerSize.width, activeDoc, fitToScreen]);

    // --- Upload Handlers ---

    const initiateUpload = (type) => {
        setUploadType(type);
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
        fetchAzureItems('');
    };

    const handleFilesUpload = async (e, type) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
            const id = `doc-${Date.now()}`;
            const name = file.name.replace(/\.(pdf|json)$/i, '');

            if (type === 'pdf') {
                const reader = new FileReader();
                reader.onload = (event) => {
                    setDocuments(prev => [...prev, { id, name, pdfData: event.target.result, ocrData: null, pdfTextData: null, totalPages: 1 }]);
                    setActiveDocId(id);
                    setActivePage(1);
                    setRotation(0);
                };
                reader.readAsArrayBuffer(file);
            } else if (type === 'json' && activeDocId) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        const json = JSON.parse(event.target.result);
                        setDocuments(prev => prev.map(d => d.id === activeDocId ? { ...d, ocrData: json, pdfTextData: null } : d));
                    } catch { /* ignore */ }
                };
                reader.readAsText(file);
            }
        }
        e.target.value = '';
    };

    // --- Azure Integration ---

    const fetchAzureItems = async (path = '') => {
        try {
            setAzureLoading(true);
            setError(null);

            const API_URL = import.meta.env.VITE_API_URL || '';
            const response = await fetch(`${API_URL}/api/v1/azure/list?path=${encodeURIComponent(path)}`);
            if (!response.ok) throw new Error('Failed to fetch Azure items');

            const items = await response.json();
            setAzureItems(items);
            setAzurePath(path);
        } catch (err) {
            console.error('Error fetching Azure files:', err);
            setError('Failed to load files from Azure Storage via Backend.');
        } finally {
            setAzureLoading(false);
        }
    };

    const handleAzureFileSelect = async (file) => {
        try {
            setAzureLoading(true);
            setError(null);

            const API_URL = import.meta.env.VITE_API_URL || '';
            const response = await fetch(`${API_URL}/api/v1/azure/download?path=${encodeURIComponent(file.path)}`);
            if (!response.ok) throw new Error('Failed to download from Azure via Backend');

            const blob = await response.blob();

            if (uploadType === 'pdf' && file.name.toLowerCase().endsWith('.pdf')) {
                const id = `doc-${Date.now()}`;
                const name = file.name.replace(/\.pdf$/i, '');
                const arrayBuffer = await blob.arrayBuffer();

                setDocuments(prev => [...prev, { id, name, pdfData: arrayBuffer, ocrData: null, pdfTextData: null, totalPages: 1 }]);
                setActiveDocId(id);
                setActivePage(1);
                setRotation(0);
                setShowAzureBrowser(false);
            } else if (uploadType === 'json' && activeDocId && file.name.toLowerCase().endsWith('.json')) {
                const text = await blob.text();
                try {
                    const json = JSON.parse(text);
                    setDocuments(prev => prev.map(d => d.id === activeDocId ? { ...d, ocrData: json, pdfTextData: null } : d));
                    setShowAzureBrowser(false);
                } catch { alert('Invalid JSON'); }
            } else {
                alert(`Please select a .${uploadType} file.`);
            }
        } catch (err) {
            console.error('Error downloading Azure file:', err);
            setError('Failed to download file from Azure via Backend');
        } finally {
            setAzureLoading(false);
        }
    };

    const handleAzureItemClick = async (item) => {
        if (item.type === 'folder') {
            fetchAzureItems(item.path);
        } else {
            handleAzureFileSelect(item);
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
        setSelectedResult(result);
        if (result.docId !== activeDocId) {
            setActiveDocId(result.docId);
        }
        if (result.pageNum !== activePage) {
            setActivePage(result.pageNum);
        }
    };

    const getPolygonPoints = (result) => {
        if (!canvasSize.width) return "";
        const p = result.polygon;
        const lw = result.layoutWidth;
        const lh = result.layoutHeight;
        const needScale = Math.abs(lw - canvasSize.width) > 1;

        if (!needScale) {
            return `${p[0]},${p[1]} ${p[2]},${p[3]} ${p[4]},${p[5]} ${p[6]},${p[7]}`;
        } else {
            const sx = canvasSize.width / lw;
            const sy = canvasSize.height / lh;
            return `${p[0] * sx},${p[1] * sy} ${p[2] * sx},${p[3] * sy} ${p[4] * sx},${p[5] * sy} ${p[6] * sx},${p[7] * sy}`;
        }
    };

    const getSelectedCenter = () => {
        if (!selectedResult || !canvasSize.width) return null;
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
        const containerWidth = containerRef.current.clientWidth;
        const containerHeight = containerRef.current.clientHeight;
        const sensitivity = 0.2;
        setPanX(prev => Math.min(Math.max(prev + (dx / containerWidth * 100 * sensitivity), 0), 100));
        setPanY(prev => Math.min(Math.max(prev + (dy / containerHeight * 100 * sensitivity), 0), 100));
        setDragStart({ x: e.clientX, y: e.clientY });
    }, [isDragging, activeDoc, dragStart]);

    const handleMouseUp = useCallback(() => {
        setIsDragging(false);
    }, []);

    const getPanRange = () => {
        if (!canvasSize.width || !containerSize.width) return { min: 50, max: 50 };
        const cw = canvasSize.width * zoom;
        const ch = canvasSize.height * zoom;
        const overX = Math.max(0, (cw - containerSize.width) / 2 / cw * 50);
        const overY = Math.max(0, (ch - containerSize.height) / 2 / ch * 50);
        return { minX: 50 - overX, maxX: 50 + overX, minY: 50 - overY, maxY: 50 + overY };
    };
    const panRange = getPanRange();
    const selectedCenter = getSelectedCenter();
    const hasOcr = !!activeDoc?.ocrData;
    const hasPdfText = !!activeDoc?.pdfTextData;

    return (
        <div className="flex h-screen w-full bg-[#fcfaf7] text-[#333333] font-sans overflow-hidden select-none relative">
            {/* Sidebar */}
            <div className={`${sidebarCollapsed ? 'w-12' : 'w-72'} border-r border-[#e5e1d8] bg-[#f4f1ea] flex flex-col transition-all duration-300`}>
                <div className="h-12 border-b border-[#e5e1d8] flex items-center justify-between px-4 bg-[#f4f1ea]">
                    {!sidebarCollapsed && <span className="text-sm font-serif font-bold text-[#5d5d5d]">Drawings Analyzer</span>}
                    <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="p-1.5 hover:bg-[#e5e1d8] rounded-md text-[#5d5d5d] transition-colors">
                        <ChevronRight size={16} className={sidebarCollapsed ? '' : 'rotate-180'} />
                    </button>
                </div>

                {!sidebarCollapsed && (
                    <>
                        <div className="p-4 border-b border-[#e5e1d8] space-y-3">
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8e8e8e]" size={14} />
                                <input type="text" placeholder="Search tags..." className="w-full bg-white border border-[#dcd8d0] rounded-lg py-2 pl-9 pr-3 text-sm focus:outline-none focus:border-[#d97757] focus:ring-1 focus:ring-[#d97757] transition-all placeholder-[#a0a0a0]" value={searchTerm} onChange={(e) => { setSearchTerm(e.target.value); setSelectedResult(null); }} />
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
                                    viewMode === 'list' ? searchResults.map((r, i) => (
                                        <div key={i} onClick={() => handleResultClick(r)} className={`p-3 rounded-lg cursor-pointer border transition-all ${selectedResult === r ? 'bg-[#fff8f0] border-[#d97757] shadow-sm' : 'bg-white border-[#e5e1d8] hover:border-[#d0cdc5] hover:shadow-sm'}`}>
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-semibold text-sm text-[#333333] truncate">{r.content}</span>
                                                        <button onClick={(e) => { e.stopPropagation(); copyToClipboard(r.content); }} className="p-1 text-[#a0a0a0] hover:text-[#d97757] transition-colors">
                                                            {copiedTag === r.content ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                                                        </button>
                                                    </div>
                                                    <div className="text-[10px] text-[#888888] mt-0.5">{r.docName} • P.{r.pageNum}</div>
                                                </div>
                                                <span className={`text-[9px] px-2 py-0.5 rounded-full font-medium ${tagColors[r.tagType].bg} ${tagColors[r.tagType].text}`}>{r.tagType}</span>
                                            </div>
                                        </div>
                                    )) : (
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
            </div>

            {/* Main */}
            <div className="flex-1 flex flex-col overflow-hidden bg-[#fcfaf7]">
                {/* Tabs */}
                <div className="h-12 bg-[#fcfaf7] border-b border-[#e5e1d8] flex items-center px-2 gap-1 overflow-x-auto pt-2">
                    {documents.map(doc => (
                        <div key={doc.id} onClick={() => { setActiveDocId(doc.id); setActivePage(1); setSelectedResult(null); setRotation(0); }} className={`group flex items-center gap-2 px-4 py-2 rounded-t-lg text-xs font-medium cursor-pointer border-t-2 transition-all ${activeDocId === doc.id ? 'bg-white text-[#333333] border-x border-[#e5e1d8] shadow-sm -mb-px z-10' : 'text-[#888888] hover:bg-[#f4f1ea] hover:text-[#555555]'} ${activeDocId === doc.id ? (doc.ocrData ? 'border-t-emerald-500' : doc.pdfTextData ? 'border-t-amber-500' : 'border-t-red-500') : 'border-t-transparent'}`}>
                            {doc.ocrData ? <FileCheck size={14} className="text-emerald-500" /> : doc.pdfTextData ? <FileText size={14} className="text-amber-500" /> : <FileX size={14} className="text-red-500" />}
                            <span className="max-w-32 truncate">{doc.name}</span>
                            {doc.totalPages > 1 && <span className="text-[10px] text-[#a0a0a0]">({doc.totalPages}p)</span>}
                            <button onClick={(e) => { e.stopPropagation(); closeDocument(doc.id); }} className="p-0.5 opacity-0 group-hover:opacity-100 text-[#a0a0a0] hover:text-[#d97757] transition-all"><X size={12} /></button>
                        </div>
                    ))}
                    <div className="flex gap-2 ml-3">
                        <button onClick={() => initiateUpload('pdf')} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#555555] bg-[#f4f1ea] hover:bg-[#e5e1d8] hover:text-[#333333] rounded-md transition-colors"><Plus size={14} /> 도면 업로드</button>
                        <button onClick={() => initiateUpload('json')} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#d97757] bg-[#fff0eb] hover:bg-[#ffe0d6] hover:text-[#c05535] rounded-md transition-colors"><Plus size={14} /> 메타데이터 업로드</button>
                    </div>
                    <input ref={fileInputRef} type="file" accept=".pdf" multiple className="hidden" onChange={(e) => handleFilesUpload(e, 'pdf')} />
                    <input ref={jsonInputRef} type="file" accept=".json" className="hidden" onChange={(e) => handleFilesUpload(e, 'json')} />
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

                        {activeDoc?.totalPages > 1 && (
                            <div className="flex items-center gap-1 ml-4 bg-[#f4f1ea] rounded-lg p-1">
                                <button onClick={() => goToPage(activePage - 1)} disabled={activePage <= 1} className="p-1.5 disabled:opacity-30 hover:bg-white rounded-md text-[#555555] transition-all shadow-sm hover:shadow"><ChevronLeft size={16} /></button>
                                <span className="text-xs font-medium w-16 text-center text-[#333333]">{activePage} / {activeDoc.totalPages}</span>
                                <button onClick={() => goToPage(activePage + 1)} disabled={activePage >= activeDoc.totalPages} className="p-1.5 disabled:opacity-30 hover:bg-white rounded-md text-[#555555] transition-all shadow-sm hover:shadow"><ChevronRight size={16} /></button>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-3 text-xs font-medium">
                        {isLoading && <span className="text-[#d97757] flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" />Processing...</span>}
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
                    onWheel={handleWheel}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                >
                    {activeDoc ? (
                        <div style={{ transform: `scale(${zoom}) translate(${(panX - 50) * 2}%, ${(panY - 50) * 2}%)`, transformOrigin: 'center center' }} className="relative shadow-xl transition-transform duration-75 ease-out">
                            <canvas ref={canvasRef} className="block bg-white" />

                            {canvasSize.width > 0 && currentPageData?.layout && (
                                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}>
                                    {searchResults.filter(r => r.docId === activeDocId && r.pageNum === activePage && r !== selectedResult).map((r, i) => (
                                        <polygon key={i} points={getPolygonPoints(r)} fill="rgba(250,204,21,0.2)" stroke="rgba(250,204,21,0.6)" strokeWidth="2" />
                                    ))}
                                    {selectedResult && selectedResult.docId === activeDocId && selectedResult.pageNum === activePage && selectedCenter && (
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
                    ) : (
                        <div className="text-center p-10 bg-white rounded-2xl shadow-sm border border-[#e5e1d8]">
                            <div className="bg-[#f4f1ea] p-4 rounded-full inline-block mb-4">
                                <FileText size={48} className="text-[#d97757]" />
                            </div>
                            <h3 className="text-lg font-serif font-bold text-[#333333] mb-2">No Drawing Selected</h3>
                            <p className="text-[#666666] mb-6 text-sm">Upload a PDF drawing to get started.</p>
                            <div className="flex gap-3 justify-center">
                                <button onClick={() => initiateUpload('pdf')} className="px-5 py-2.5 bg-[#d97757] hover:bg-[#c05535] text-white rounded-lg text-sm font-medium shadow-sm transition-all flex items-center gap-2"><Plus size={16} /> 도면 업로드</button>
                                <button onClick={() => initiateUpload('json')} className="px-5 py-2.5 bg-white border border-[#d97757] text-[#d97757] hover:bg-[#fff0eb] rounded-lg text-sm font-medium shadow-sm transition-all flex items-center gap-2"><Plus size={16} /> 메타데이터 업로드</button>
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
            <div className={`${rightSidebarOpen ? 'w-[350px]' : 'w-0'} border-l border-[#e5e1d8] bg-white transition-all duration-300 overflow-hidden flex flex-col`}>
                <div className="w-[350px] h-full">
                    <ChatInterface activeDoc={activeDoc} />
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
                                        <div className="font-bold text-[#333333]">Local PC</div>
                                        <div className="text-xs text-[#888888]">Upload from your computer</div>
                                    </div>
                                </button>
                                <button onClick={handleAzureUpload} className="w-full flex items-center gap-3 p-4 rounded-lg border border-[#e5e1d8] hover:border-[#0078d4] hover:bg-[#f0f8ff] transition-all group">
                                    <div className="bg-[#f4f1ea] p-2 rounded-full group-hover:bg-[#e6f2ff]"><Cloud size={24} className="text-[#555555] group-hover:text-[#0078d4]" /></div>
                                    <div className="text-left">
                                        <div className="font-bold text-[#333333]">Azure Storage</div>
                                        <div className="text-xs text-[#888888]">Select from Blob Storage</div>
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
                                <button onClick={() => fetchAzureItems('')} className="p-1 hover:bg-[#e5e1d8] rounded"><RotateCcw size={14} /></button>
                                <span className="text-[#666666]">Path:</span>
                                <span className="font-mono text-[#333333] bg-white px-2 py-0.5 rounded border border-[#dcd8d0] flex-1 truncate">/{azurePath}</span>
                                {azurePath && <button onClick={() => fetchAzureItems(azurePath.split('/').slice(0, -2).join('/') + (azurePath.split('/').length > 2 ? '/' : ''))} className="px-2 py-0.5 bg-[#e5e1d8] hover:bg-[#dcd8d0] rounded text-xs">Up</button>}
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
                                        <Loader2 size={32} className="animate-spin mb-2" />
                                        <span>Loading...</span>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-4 gap-2">
                                        {azureItems.map((item, i) => (
                                            <div key={i} onClick={() => handleAzureItemClick(item)} className="p-3 rounded-lg border border-[#e5e1d8] hover:border-[#0078d4] hover:bg-[#f0f8ff] cursor-pointer flex flex-col items-center gap-2 text-center transition-all group">
                                                {item.type === 'folder' ? (
                                                    <Folder size={32} className="text-[#d97757] group-hover:text-[#0078d4]" />
                                                ) : (
                                                    <File size={32} className="text-[#888888] group-hover:text-[#0078d4]" />
                                                )}
                                                <span className="text-xs font-medium text-[#333333] break-all line-clamp-2">{item.name}</span>
                                            </div>
                                        ))}
                                        {azureItems.length === 0 && (
                                            <div className="col-span-4 text-center py-10 text-[#888888]">Folder is empty</div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )
            }
        </div>
    );
};

export default App;
