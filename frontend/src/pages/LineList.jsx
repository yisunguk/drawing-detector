import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    ArrowLeft, Upload, FileText, Loader2, Download,
    Plus, Trash2, Search, ListChecks, Play, FolderOpen, RefreshCcw,
    ZoomIn, ZoomOut, ChevronLeft, ChevronRight, Maximize, Columns
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { loadPdfJs, uploadToAzure } from '../services/analysisService';

const API_BASE = (import.meta.env.VITE_API_URL || 'https://drawing-detector-backend-435353955407.us-central1.run.app').replace(/\/$/, '');

// Line List column definitions
const COLUMNS = [
    { key: 'line_number', label: 'Line Number', width: 200, editable: true },
    { key: 'nb', label: 'NB (Size)', width: 80, editable: true },
    { key: 'fluid_code', label: 'Fluid Code', width: 100, editable: true },
    { key: 'area', label: 'Area', width: 70, editable: true },
    { key: 'seq_no', label: 'No.', width: 90, editable: true },
    { key: 'pipe_spec', label: 'Pipe Spec', width: 100, editable: true },
    { key: 'insulation', label: 'Insul.', width: 80, editable: true },
    { key: 'from_equip', label: 'From', width: 130, editable: true },
    { key: 'to_equip', label: 'To', width: 130, editable: true },
    { key: 'pid_no', label: 'P&ID No.', width: 180, editable: true },
    { key: 'source_page', label: 'Page', width: 60, editable: false },
    { key: 'operating_temp', label: 'Op. Temp', width: 90, editable: true },
    { key: 'operating_press', label: 'Op. Press', width: 90, editable: true },
    { key: 'design_temp', label: 'Des. Temp', width: 90, editable: true },
    { key: 'design_press', label: 'Des. Press', width: 90, editable: true },
    { key: 'remarks', label: 'Remarks', width: 150, editable: true },
];

const EMPTY_ROW = COLUMNS.reduce((acc, col) => ({ ...acc, [col.key]: '' }), {});

const LineList = () => {
    const navigate = useNavigate();
    const { currentUser } = useAuth();
    const username = currentUser?.displayName || currentUser?.email?.split('@')[0];

    // PDF state
    const [pdfFile, setPdfFile] = useState(null);
    const [pdfUrl, setPdfUrl] = useState(null);
    const [pdfPages, setPdfPages] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [blobPath, setBlobPath] = useState(null);

    // PDF viewer 확대/축소
    const [pdfZoom, setPdfZoom] = useState(1.2);
    const [renderZoom, setRenderZoom] = useState(1.2); // Debounced zoom for smooth rendering
    const [isDragging, setIsDragging] = useState(false);
    const [panelWidth, setPanelWidth] = useState(450); // px (기존 450px 기본값)
    const [isResizing, setIsResizing] = useState(false);
    const [selectedRowIdx, setSelectedRowIdx] = useState(null);

    // Existing files state
    const [existingFiles, setExistingFiles] = useState([]);
    const [loadingFiles, setLoadingFiles] = useState(false);
    const [selectedBlobFile, setSelectedBlobFile] = useState(null); // blob file selected (not local file)

    // Extraction state
    const [isExtracting, setIsExtracting] = useState(false);
    const [extractionStatus, setExtractionStatus] = useState('');
    const [extractionProgress, setExtractionProgress] = useState(0);

    // Table state
    const [lines, setLines] = useState([]);
    const [editingCell, setEditingCell] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');

    // Refs
    const canvasRef = useRef(null);
    const pdfDocRef = useRef(null);
    const pdfContainerRef = useRef(null);
    const fileInputRef = useRef(null);
    const editInputRef = useRef(null);
    const resizingRef = useRef(false);
    const pageViewportRef = useRef(null);
    const dragStartRef = useRef({ x: 0, y: 0, left: 0, top: 0 });

    // Azure Blob config for preview
    const AZURE_STORAGE_ACCOUNT_NAME = import.meta.env.VITE_AZURE_STORAGE_ACCOUNT_NAME;
    const AZURE_CONTAINER_NAME = import.meta.env.VITE_AZURE_CONTAINER_NAME;
    const rawSasToken = import.meta.env.VITE_AZURE_SAS_TOKEN || '';
    const AZURE_SAS_TOKEN = rawSasToken.replace(/^"|"$/g, '');

    const buildBlobUrl = (blobPath) => {
        const encodedPath = blobPath.split('/').map(s => encodeURIComponent(s)).join('/');
        return `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${AZURE_CONTAINER_NAME}/${encodedPath}?${AZURE_SAS_TOKEN}`;
    };

    // Fetch existing files from {username}/line/
    const fetchExistingFiles = useCallback(async () => {
        if (!username) return;
        setLoadingFiles(true);
        try {
            const res = await fetch(`${API_BASE}/api/v1/linelist/files?username=${encodeURIComponent(username)}`);
            if (res.ok) {
                const data = await res.json();
                setExistingFiles(data);
            }
        } catch (err) {
            console.error('Failed to fetch existing files:', err);
        } finally {
            setLoadingFiles(false);
        }
    }, [username]);

    // Load existing files on mount
    useEffect(() => {
        fetchExistingFiles();
    }, [fetchExistingFiles]);

    // Select an existing blob file for preview + extraction
    const handleBlobFileSelect = useCallback(async (file) => {
        setSelectedBlobFile(file);
        setPdfFile(null); // clear local file
        setLines([]);
        setBlobPath(file.path);
        setExtractionStatus('');
        setPdfZoom(1.2);

        try {
            const pdfjsLib = await loadPdfJs();
            const pdfUrl = buildBlobUrl(file.path);
            const pdf = await pdfjsLib.getDocument({ url: pdfUrl }).promise;
            pdfDocRef.current = pdf;
            setPdfPages(pdf.numPages);
            setCurrentPage(1);
        } catch (err) {
            console.error('PDF load error (blob):', err);
            setPdfPages(0);
        }
    }, [username]);

    // Debounce zoom for rendering to prevent flicker
    useEffect(() => {
        const timer = setTimeout(() => setRenderZoom(pdfZoom), 300);
        return () => clearTimeout(timer);
    }, [pdfZoom]);

    // Canvas size state for scroll area
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

    // Render PDF page (줌 적용)
    const renderPage = useCallback(async (pageNum) => {
        if (!pdfDocRef.current || !canvasRef.current) return;
        try {
            const page = await pdfDocRef.current.getPage(pageNum);

            // 원본 viewport 저장 (Fit 계산용)
            const baseViewport = page.getViewport({ scale: 1 });
            pageViewportRef.current = baseViewport;

            const viewport = page.getViewport({ scale: renderZoom });

            // Offscreen canvas rendering to prevent flicker
            const offscreen = document.createElement('canvas');
            offscreen.width = viewport.width;
            offscreen.height = viewport.height;
            const offCtx = offscreen.getContext('2d');
            await page.render({ canvasContext: offCtx, viewport }).promise;

            const canvas = canvasRef.current;
            if (canvas) {
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(offscreen, 0, 0);
            }
            setCanvasSize({ width: viewport.width, height: viewport.height });
        } catch (err) {
            console.error('PDF render error:', err);
        }
    }, [renderZoom]);

    // Load PDF file
    const handleFileSelect = useCallback(async (file) => {
        if (!file || !file.name.toLowerCase().endsWith('.pdf')) return;

        setPdfFile(file);
        setPdfUrl(URL.createObjectURL(file));
        setLines([]);
        setBlobPath(null);
        setExtractionStatus('');
        setPdfZoom(1.2);

        try {
            const pdfjsLib = await loadPdfJs();
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            pdfDocRef.current = pdf;
            setPdfPages(pdf.numPages);
            setCurrentPage(1);
        } catch (err) {
            console.error('PDF load error:', err);
        }
    }, []);

    // Render page when currentPage or zoom changes
    useEffect(() => {
        if (pdfDocRef.current && currentPage > 0) {
            renderPage(currentPage);
        }
    }, [currentPage, renderZoom, renderPage]);

    // Also render after initial load
    useEffect(() => {
        if (pdfPages > 0) {
            renderPage(1);
        }
    }, [pdfPages, renderPage]);

    // 줌 컨트롤
    const handleZoomIn = () => setPdfZoom(z => Math.min(5, +(z + 0.2).toFixed(1)));
    const handleZoomOut = () => setPdfZoom(z => Math.max(0.3, +(z - 0.2).toFixed(1)));

    const handleFitWidth = useCallback(() => {
        if (!pdfContainerRef.current || !pageViewportRef.current) return;
        const containerWidth = pdfContainerRef.current.clientWidth - 20;
        const baseWidth = pageViewportRef.current.width;
        const newZoom = +(containerWidth / baseWidth).toFixed(2);
        setPdfZoom(Math.max(0.3, Math.min(5, newZoom)));
    }, []);

    const handleFitPage = useCallback(() => {
        if (!pdfContainerRef.current || !pageViewportRef.current) return;
        const containerWidth = pdfContainerRef.current.clientWidth - 20;
        const containerHeight = pdfContainerRef.current.clientHeight - 20;
        const baseWidth = pageViewportRef.current.width;
        const baseHeight = pageViewportRef.current.height;
        const scaleW = containerWidth / baseWidth;
        const scaleH = containerHeight / baseHeight;
        const newZoom = +(Math.min(scaleW, scaleH)).toFixed(2);
        setPdfZoom(Math.max(0.3, Math.min(5, newZoom)));
    }, []);

    // Wheel zoom: single native listener with passive:false to fully prevent scroll
    useEffect(() => {
        const container = pdfContainerRef.current;
        if (!container) return;
        const handleWheel = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const delta = -e.deltaY;
            setPdfZoom(prev => {
                const next = prev + (delta > 0 ? 0.1 : -0.1);
                return Math.min(Math.max(0.3, next), 5.0);
            });
        };
        container.addEventListener('wheel', handleWheel, { passive: false });
        return () => container.removeEventListener('wheel', handleWheel);
    }, []);

    // Mouse pan/drag handlers (plain functions for fresh isDragging reference)
    const handlePdfMouseDown = (e) => {
        if (e.button !== 0) return;
        setIsDragging(true);
        const container = pdfContainerRef.current;
        dragStartRef.current = {
            x: e.clientX,
            y: e.clientY,
            left: container.scrollLeft,
            top: container.scrollTop
        };
        container.style.cursor = 'grabbing';
    };

    const handlePdfMouseMove = (e) => {
        if (!isDragging) return;
        const container = pdfContainerRef.current;
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        container.scrollLeft = dragStartRef.current.left - dx;
        container.scrollTop = dragStartRef.current.top - dy;
    };

    const handlePdfMouseUp = () => {
        setIsDragging(false);
        if (pdfContainerRef.current) pdfContainerRef.current.style.cursor = 'grab';
    };

    const handlePdfMouseLeave = () => {
        setIsDragging(false);
        if (pdfContainerRef.current) pdfContainerRef.current.style.cursor = 'default';
    };

    // 패널 리사이즈 핸들러
    const startResize = useCallback((e) => {
        e.preventDefault();
        resizingRef.current = true;
        setIsResizing(true);
        const startX = e.clientX;
        const startWidth = panelWidth;

        const onMove = (e) => {
            if (!resizingRef.current) return;
            const dx = e.clientX - startX;
            const newWidth = startWidth + dx;
            setPanelWidth(Math.max(300, Math.min(window.innerWidth * 0.7, newWidth)));
        };
        const onUp = () => {
            resizingRef.current = false;
            setIsResizing(false);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [panelWidth]);

    // Upload & Extract
    const handleExtract = useCallback(async () => {
        if (!pdfFile && !selectedBlobFile) return;
        setIsExtracting(true);
        setExtractionProgress(0);

        try {
            let blob_name = blobPath;

            if (pdfFile && !blobPath) {
                // New file: upload to Azure ({username}/line/ folder)
                setExtractionStatus('PDF 업로드 중...');
                const sasRes = await fetch(`${API_BASE}/api/v1/linelist/upload-sas?filename=${encodeURIComponent(pdfFile.name)}&username=${encodeURIComponent(username)}`);
                if (!sasRes.ok) throw new Error('Failed to get upload SAS URL');
                const sasData = await sasRes.json();
                blob_name = sasData.blob_name;
                await uploadToAzure(sasData.upload_url, pdfFile, (pct) => {
                    setUploadProgress(pct);
                    setExtractionProgress(Math.round(pct * 0.3));
                });
                setBlobPath(blob_name);
            } else {
                // Existing blob file: skip upload
                setExtractionProgress(30);
            }

            setExtractionStatus('텍스트 추출 중 (Azure Document Intelligence)...');
            setExtractionProgress(30);

            // Step 2: Call extraction API
            // For large PDFs, process in chunks of 5 pages
            const chunkSize = 5;
            const totalPages = pdfPages || 1;
            let allLines = [];
            let allPidNumbers = new Set();

            if (totalPages <= chunkSize) {
                // Small PDF: single request
                setExtractionStatus('라인 리스트 추출 중 (GPT 분석)...');
                setExtractionProgress(50);

                const response = await fetch(`${API_BASE}/api/v1/linelist/extract`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ blob_path: blob_name, username }),
                });
                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(err.detail || 'Extraction failed');
                }
                const data = await response.json();
                allLines = data.lines || [];
                (data.pid_numbers || []).forEach(p => allPidNumbers.add(p));
            } else {
                // Large PDF: chunk by pages
                for (let start = 1; start <= totalPages; start += chunkSize) {
                    const end = Math.min(start + chunkSize - 1, totalPages);
                    const pageRange = `${start}-${end}`;
                    const pct = 30 + Math.round(((start - 1) / totalPages) * 60);
                    setExtractionProgress(pct);
                    setExtractionStatus(`페이지 ${start}-${end} / ${totalPages} 분석 중...`);

                    const response = await fetch(`${API_BASE}/api/v1/linelist/extract-pages`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ blob_path: blob_name, pages: pageRange, username }),
                    });
                    if (!response.ok) {
                        const err = await response.json().catch(() => ({}));
                        console.warn(`Page ${pageRange} extraction failed:`, err.detail);
                        continue;
                    }
                    const data = await response.json();
                    if (data.lines) allLines.push(...data.lines);
                    (data.pid_numbers || []).forEach(p => allPidNumbers.add(p));
                }
            }

            // Deduplicate by line_number
            const seen = new Set();
            const deduped = [];
            for (const line of allLines) {
                const key = line.line_number || JSON.stringify(line);
                if (!seen.has(key)) {
                    seen.add(key);
                    deduped.push(line);
                }
            }

            setLines(deduped);
            setExtractionProgress(100);
            setExtractionStatus(`완료! ${deduped.length}개 라인 추출됨`);

        } catch (err) {
            console.error('Extraction error:', err);
            setExtractionStatus(`오류: ${err.message}`);
        } finally {
            setIsExtracting(false);
        }
    }, [pdfFile, pdfPages, username, selectedBlobFile, blobPath]);

    // 테이블 행 클릭 → PDF 페이지 이동
    const handleRowClick = useCallback((line, actualIdx) => {
        setSelectedRowIdx(actualIdx);
        const sourcePage = parseInt(line.source_page);
        if (sourcePage && sourcePage >= 1 && sourcePage <= pdfPages) {
            setCurrentPage(sourcePage);
        }
    }, [pdfPages]);

    // Table editing
    const handleCellClick = (rowIdx, colKey) => {
        setEditingCell({ row: rowIdx, col: colKey });
    };

    const handleCellChange = (rowIdx, colKey, value) => {
        setLines(prev => {
            const updated = [...prev];
            updated[rowIdx] = { ...updated[rowIdx], [colKey]: value };
            return updated;
        });
    };

    const handleCellBlur = () => {
        setEditingCell(null);
    };

    const handleCellKeyDown = (e, rowIdx, colKey) => {
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            setEditingCell(null);

            // Move to next cell
            const colIdx = COLUMNS.findIndex(c => c.key === colKey);
            if (e.key === 'Tab' && colIdx < COLUMNS.length - 1) {
                setEditingCell({ row: rowIdx, col: COLUMNS[colIdx + 1].key });
            } else if (e.key === 'Enter' && rowIdx < lines.length - 1) {
                setEditingCell({ row: rowIdx + 1, col: colKey });
            }
        } else if (e.key === 'Escape') {
            setEditingCell(null);
        }
    };

    const addRow = () => {
        setLines(prev => [...prev, { ...EMPTY_ROW }]);
    };

    const deleteRow = (rowIdx) => {
        setLines(prev => prev.filter((_, i) => i !== rowIdx));
    };

    // Excel/CSV export
    const exportToCSV = () => {
        if (lines.length === 0) return;

        const headers = COLUMNS.map(c => c.label);
        const rows = lines.map(line =>
            COLUMNS.map(c => {
                const val = (line[c.key] || '').toString();
                // Escape quotes and wrap in quotes if contains comma
                if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                    return `"${val.replace(/"/g, '""')}"`;
                }
                return val;
            })
        );

        // BOM for Korean Excel compatibility
        const BOM = '\uFEFF';
        const csv = BOM + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        const exportName = (pdfFile?.name || selectedBlobFile?.name || 'export').replace('.pdf', '');
        a.download = `line_list_${exportName}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // Filter lines by search term
    const filteredLines = searchTerm
        ? lines.filter(line =>
            Object.values(line).some(v =>
                (v || '').toString().toLowerCase().includes(searchTerm.toLowerCase())
            )
        )
        : lines;

    // Drag and drop handlers
    const handleDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleFileSelect(files[0]);
        }
    };

    return (
        <div className="h-screen flex flex-col bg-slate-900 text-slate-100">
            {/* Header */}
            <header className="flex-shrink-0 bg-slate-800/80 border-b border-slate-700 px-6 py-3 flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <button
                        onClick={() => navigate('/')}
                        className="p-2 rounded-lg hover:bg-slate-700 transition-colors"
                        title="Home"
                    >
                        <ArrowLeft className="w-5 h-5 text-slate-300" />
                    </button>
                    <div className="flex items-center gap-2">
                        <ListChecks className="w-6 h-6 text-amber-400" />
                        <h1 className="text-xl font-bold text-slate-100">P&ID Line List Extractor</h1>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {lines.length > 0 && (
                        <button
                            onClick={exportToCSV}
                            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium transition-colors"
                        >
                            <Download className="w-4 h-4" />
                            Excel (CSV) 다운로드
                        </button>
                    )}
                    <span className="text-sm text-slate-400">{currentUser?.email}</span>
                </div>
            </header>

            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left Panel: PDF Upload & Preview */}
                <div
                    className="flex-shrink-0 border-r border-slate-700 flex flex-col bg-slate-800/50"
                    style={{
                        width: panelWidth,
                        transition: isResizing ? 'none' : undefined,
                    }}
                >
                    {/* No file selected: show existing files + upload */}
                    {!pdfFile && !selectedBlobFile ? (
                        <div className="flex-1 flex flex-col overflow-hidden">
                            {/* Existing files header */}
                            <div className="flex-shrink-0 px-4 py-3 border-b border-slate-700 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <FolderOpen className="w-4 h-4 text-amber-400" />
                                    <span className="text-sm font-medium text-slate-300">기존 도면 ({existingFiles.length})</span>
                                </div>
                                <button
                                    onClick={fetchExistingFiles}
                                    disabled={loadingFiles}
                                    className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
                                    title="새로고침"
                                >
                                    <RefreshCcw className={`w-4 h-4 ${loadingFiles ? 'animate-spin' : ''}`} />
                                </button>
                            </div>

                            {/* Existing files list */}
                            <div className="flex-1 overflow-auto">
                                {loadingFiles ? (
                                    <div className="flex items-center justify-center py-8">
                                        <Loader2 className="w-6 h-6 text-slate-500 animate-spin" />
                                    </div>
                                ) : existingFiles.length > 0 ? (
                                    <div className="divide-y divide-slate-700/50">
                                        {existingFiles.map((file, idx) => (
                                            <button
                                                key={idx}
                                                onClick={() => handleBlobFileSelect(file)}
                                                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-700/50 transition-colors text-left"
                                            >
                                                <FileText className="w-4 h-4 text-amber-400/70 flex-shrink-0" />
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-sm text-slate-300 truncate">{file.name}</p>
                                                    <p className="text-xs text-slate-500">
                                                        {file.size ? `${(file.size / 1024 / 1024).toFixed(1)}MB` : ''}
                                                        {file.last_modified ? ` · ${new Date(file.last_modified).toLocaleDateString('ko-KR')}` : ''}
                                                    </p>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-center py-8 text-slate-500 text-sm">
                                        저장된 도면이 없습니다
                                    </div>
                                )}
                            </div>

                            {/* Upload button at bottom */}
                            <div
                                className="flex-shrink-0 border-t border-slate-700 p-4"
                                onDragOver={handleDragOver}
                                onDrop={handleDrop}
                            >
                                <div
                                    onClick={() => fileInputRef.current?.click()}
                                    className="w-full border-2 border-dashed border-slate-600 hover:border-amber-500 rounded-xl p-4 text-center cursor-pointer transition-colors group"
                                >
                                    <Upload className="w-6 h-6 text-slate-500 group-hover:text-amber-400 mx-auto mb-1 transition-colors" />
                                    <p className="text-slate-400 text-sm">새 PDF 업로드</p>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".pdf"
                                        className="hidden"
                                        onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                                    />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <>
                            {/* File info bar */}
                            <div className="flex-shrink-0 px-4 py-3 border-b border-slate-700 flex items-center justify-between">
                                <div className="flex items-center gap-2 min-w-0">
                                    <FileText className="w-4 h-4 text-amber-400 flex-shrink-0" />
                                    <span className="text-sm text-slate-300 truncate">{pdfFile?.name || selectedBlobFile?.name}</span>
                                    {pdfPages > 0 && <span className="text-xs text-slate-500">({pdfPages}p)</span>}
                                </div>
                                <button
                                    onClick={() => {
                                        setPdfFile(null);
                                        setPdfUrl(null);
                                        setPdfPages(0);
                                        pdfDocRef.current = null;
                                        pageViewportRef.current = null;
                                        setBlobPath(null);
                                        setSelectedBlobFile(null);
                                        setExtractionStatus('');
                                        setPdfZoom(1.2);
                                    }}
                                    className="text-slate-500 hover:text-slate-300 text-sm"
                                >
                                    변경
                                </button>
                            </div>

                            {/* Extract Button */}
                            <div className="flex-shrink-0 px-4 py-3 border-b border-slate-700">
                                <button
                                    onClick={handleExtract}
                                    disabled={isExtracting}
                                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
                                >
                                    {isExtracting ? (
                                        <>
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                            추출 중...
                                        </>
                                    ) : (
                                        <>
                                            <Play className="w-5 h-5" />
                                            라인 리스트 추출
                                        </>
                                    )}
                                </button>

                                {/* Progress */}
                                {(isExtracting || extractionStatus) && (
                                    <div className="mt-3">
                                        {isExtracting && (
                                            <div className="w-full bg-slate-700 rounded-full h-2 mb-2">
                                                <div
                                                    className="bg-amber-500 h-2 rounded-full transition-all duration-500"
                                                    style={{ width: `${extractionProgress}%` }}
                                                />
                                            </div>
                                        )}
                                        <p className="text-xs text-slate-400">{extractionStatus}</p>
                                    </div>
                                )}
                            </div>

                            {/* PDF 뷰어 툴바 (줌/페이지) */}
                            <div className="flex-shrink-0 h-9 border-b border-slate-700 flex items-center justify-center gap-2 px-3 bg-slate-800/80">
                                {/* 페이지 네비게이션 */}
                                <button
                                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                    disabled={currentPage <= 1}
                                    className="p-1 hover:bg-slate-700 rounded disabled:opacity-30 transition-colors"
                                    title="이전 페이지"
                                >
                                    <ChevronLeft className="w-4 h-4" />
                                </button>
                                <span className="text-xs text-slate-400 font-medium min-w-[50px] text-center">
                                    {currentPage} / {pdfPages || '?'}
                                </span>
                                <button
                                    onClick={() => setCurrentPage(p => Math.min(pdfPages, p + 1))}
                                    disabled={currentPage >= pdfPages}
                                    className="p-1 hover:bg-slate-700 rounded disabled:opacity-30 transition-colors"
                                    title="다음 페이지"
                                >
                                    <ChevronRight className="w-4 h-4" />
                                </button>

                                <div className="w-px h-4 bg-slate-600 mx-1" />

                                {/* 줌 컨트롤 */}
                                <button
                                    onClick={handleZoomOut}
                                    className="p-1 hover:bg-slate-700 rounded transition-colors"
                                    title="축소"
                                >
                                    <ZoomOut className="w-4 h-4" />
                                </button>
                                <span className="text-xs text-slate-400 w-10 text-center">
                                    {Math.round(pdfZoom * 100)}%
                                </span>
                                <button
                                    onClick={handleZoomIn}
                                    className="p-1 hover:bg-slate-700 rounded transition-colors"
                                    title="확대"
                                >
                                    <ZoomIn className="w-4 h-4" />
                                </button>

                                <div className="w-px h-4 bg-slate-600 mx-1" />

                                {/* 맞춤 버튼 */}
                                <button
                                    onClick={handleFitWidth}
                                    className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-slate-200 transition-colors"
                                    title="너비 맞춤"
                                >
                                    <Columns className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={handleFitPage}
                                    className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-slate-200 transition-colors"
                                    title="페이지 맞춤"
                                >
                                    <Maximize className="w-4 h-4" />
                                </button>
                            </div>

                            {/* PDF Preview (스크롤 가능) */}
                            <div
                                ref={pdfContainerRef}
                                className="relative flex-1 overflow-auto bg-slate-900 p-12 cursor-grab select-none"
                                onMouseDown={handlePdfMouseDown}
                                onMouseMove={handlePdfMouseMove}
                                onMouseUp={handlePdfMouseUp}
                                onMouseLeave={handlePdfMouseLeave}
                            >
                                <div
                                    className="relative mx-auto mb-8 shadow-2xl transition-transform duration-100 ease-out"
                                    style={{
                                        width: canvasSize.width,
                                        height: canvasSize.height,
                                        transform: `scale(${pdfZoom / renderZoom})`,
                                        transformOrigin: '0 0',
                                    }}
                                >
                                    <canvas ref={canvasRef} className="border border-slate-700 rounded shadow-lg" />
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* 리사이즈 핸들 */}
                <div
                    className="w-1.5 flex-shrink-0 cursor-col-resize hover:bg-amber-500/50 active:bg-amber-500/70 bg-slate-700/50 transition-colors relative z-20"
                    onMouseDown={startResize}
                    title="드래그하여 패널 크기 조절"
                >
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 bg-slate-500 rounded-full" />
                </div>

                {/* Right Panel: Line List Table */}
                <div className="flex-1 flex flex-col overflow-hidden min-w-0">
                    {/* Table toolbar */}
                    <div className="flex-shrink-0 px-4 py-3 border-b border-slate-700 flex items-center justify-between bg-slate-800/30">
                        <div className="flex items-center gap-3">
                            <h2 className="text-sm font-semibold text-slate-300">
                                Line List
                                {lines.length > 0 && (
                                    <span className="ml-2 text-amber-400">({filteredLines.length}건)</span>
                                )}
                            </h2>
                            <button
                                onClick={addRow}
                                className="flex items-center gap-1 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs font-medium transition-colors"
                            >
                                <Plus className="w-3 h-3" /> 행 추가
                            </button>
                        </div>
                        {lines.length > 0 && (
                            <div className="relative">
                                <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                                <input
                                    type="text"
                                    placeholder="검색..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="pl-9 pr-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500 w-48"
                                />
                            </div>
                        )}
                    </div>

                    {/* Table */}
                    <div className="flex-1 overflow-auto">
                        {lines.length === 0 && !isExtracting ? (
                            <div className="flex-1 flex items-center justify-center h-full">
                                <div className="text-center text-slate-500">
                                    <ListChecks className="w-16 h-16 mx-auto mb-4 opacity-30" />
                                    <p className="text-lg font-medium mb-2">라인 리스트가 비어 있습니다</p>
                                    <p className="text-sm">P&ID PDF를 업로드하고 "라인 리스트 추출" 버튼을 클릭하세요</p>
                                </div>
                            </div>
                        ) : (
                            <table className="w-full border-collapse text-sm">
                                <thead className="sticky top-0 z-10">
                                    <tr className="bg-slate-800">
                                        <th className="px-2 py-2 border border-slate-700 text-center text-xs text-slate-400 w-10">#</th>
                                        {COLUMNS.map(col => (
                                            <th
                                                key={col.key}
                                                className="px-2 py-2 border border-slate-700 text-left text-xs text-slate-400 font-medium whitespace-nowrap"
                                                style={{ minWidth: col.width }}
                                            >
                                                {col.label}
                                            </th>
                                        ))}
                                        <th className="px-2 py-2 border border-slate-700 text-center text-xs text-slate-400 w-10"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredLines.map((line, rowIdx) => {
                                        // Find actual index in lines array for editing
                                        const actualIdx = lines.indexOf(line);
                                        const isSelected = selectedRowIdx === actualIdx;
                                        return (
                                            <tr
                                                key={actualIdx}
                                                className={`transition-colors cursor-pointer ${
                                                    isSelected
                                                        ? 'bg-amber-900/30 hover:bg-amber-900/40'
                                                        : 'hover:bg-slate-800/50'
                                                }`}
                                                onClick={() => handleRowClick(line, actualIdx)}
                                            >
                                                <td className="px-2 py-1.5 border border-slate-700/50 text-center text-xs text-slate-500">
                                                    {actualIdx + 1}
                                                </td>
                                                {COLUMNS.map(col => {
                                                    const isEditing = editingCell?.row === actualIdx && editingCell?.col === col.key;
                                                    const isPageCol = col.key === 'source_page';
                                                    return (
                                                        <td
                                                            key={col.key}
                                                            className={`px-1 py-0.5 border border-slate-700/50 ${
                                                                isPageCol ? 'text-center' : 'cursor-text'
                                                            } ${isEditing ? 'bg-slate-700' : 'hover:bg-slate-800'}`}
                                                            onClick={(e) => {
                                                                if (col.editable) {
                                                                    e.stopPropagation();
                                                                    handleCellClick(actualIdx, col.key);
                                                                }
                                                            }}
                                                        >
                                                            {isEditing ? (
                                                                <input
                                                                    ref={editInputRef}
                                                                    autoFocus
                                                                    type="text"
                                                                    value={line[col.key] || ''}
                                                                    onChange={(e) => handleCellChange(actualIdx, col.key, e.target.value)}
                                                                    onBlur={handleCellBlur}
                                                                    onKeyDown={(e) => handleCellKeyDown(e, actualIdx, col.key)}
                                                                    className="w-full bg-transparent border-none outline-none text-sm text-slate-100 px-1"
                                                                />
                                                            ) : (
                                                                <span className={`text-sm px-1 block truncate ${
                                                                    isPageCol
                                                                        ? 'text-amber-400/70 font-mono text-xs'
                                                                        : 'text-slate-300'
                                                                }`}>
                                                                    {line[col.key] || ''}
                                                                </span>
                                                            )}
                                                        </td>
                                                    );
                                                })}
                                                <td className="px-1 py-0.5 border border-slate-700/50 text-center">
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            deleteRow(actualIdx);
                                                        }}
                                                        className="p-1 text-slate-600 hover:text-red-400 transition-colors"
                                                        title="삭제"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default LineList;
