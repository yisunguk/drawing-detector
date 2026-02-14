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

    // PDF viewer state (new)
    const [pdfZoom, setPdfZoom] = useState(1.2);
    const [panelWidth, setPanelWidth] = useState(50); // percentage
    const [isResizing, setIsResizing] = useState(false);
    const [selectedRowIdx, setSelectedRowIdx] = useState(null);

    // Existing files state
    const [existingFiles, setExistingFiles] = useState([]);
    const [loadingFiles, setLoadingFiles] = useState(false);
    const [selectedBlobFile, setSelectedBlobFile] = useState(null);

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
    const pageViewportRef = useRef(null); // store base viewport for fit calculations

    // Azure Blob config for preview
    const AZURE_STORAGE_ACCOUNT_NAME = import.meta.env.VITE_AZURE_STORAGE_ACCOUNT_NAME;
    const AZURE_CONTAINER_NAME = import.meta.env.VITE_AZURE_CONTAINER_NAME;
    const rawSasToken = import.meta.env.VITE_AZURE_SAS_TOKEN || '';
    const AZURE_SAS_TOKEN = rawSasToken.replace(/^"|"$/g, '');

    const buildBlobUrl = (blobPath) => {
        const encodedPath = blobPath.split('/').map(s => encodeURIComponent(s)).join('/');
        return `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${AZURE_CONTAINER_NAME}/${encodedPath}?${AZURE_SAS_TOKEN}`;
    };

    const hasPdf = pdfFile || selectedBlobFile;

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
        setPdfFile(null);
        setLines([]);
        setBlobPath(file.path);
        setExtractionStatus('');

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

    // Render PDF page with zoom
    const renderPage = useCallback(async (pageNum) => {
        if (!pdfDocRef.current || !canvasRef.current) return;
        try {
            const page = await pdfDocRef.current.getPage(pageNum);
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');

            // Store base viewport for fit calculations
            const baseViewport = page.getViewport({ scale: 1 });
            pageViewportRef.current = baseViewport;

            const viewport = page.getViewport({ scale: pdfZoom });
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            await page.render({ canvasContext: ctx, viewport }).promise;
        } catch (err) {
            console.error('PDF render error:', err);
        }
    }, [pdfZoom]);

    // Load PDF file
    const handleFileSelect = useCallback(async (file) => {
        if (!file || !file.name.toLowerCase().endsWith('.pdf')) return;

        setPdfFile(file);
        setPdfUrl(URL.createObjectURL(file));
        setLines([]);
        setBlobPath(null);
        setExtractionStatus('');
        setSelectedBlobFile(null);

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
    }, [currentPage, pdfZoom, renderPage]);

    // Also render after initial load
    useEffect(() => {
        if (pdfPages > 0) {
            renderPage(1);
        }
    }, [pdfPages, renderPage]);

    // Zoom controls
    const handleZoomIn = () => setPdfZoom(z => Math.min(5, +(z + 0.2).toFixed(1)));
    const handleZoomOut = () => setPdfZoom(z => Math.max(0.3, +(z - 0.2).toFixed(1)));

    const handleFitWidth = useCallback(() => {
        if (!pdfContainerRef.current || !pageViewportRef.current) return;
        const containerWidth = pdfContainerRef.current.clientWidth - 32; // padding
        const baseWidth = pageViewportRef.current.width;
        const newZoom = +(containerWidth / baseWidth).toFixed(2);
        setPdfZoom(Math.max(0.3, Math.min(5, newZoom)));
    }, []);

    const handleFitPage = useCallback(() => {
        if (!pdfContainerRef.current || !pageViewportRef.current) return;
        const containerWidth = pdfContainerRef.current.clientWidth - 32;
        const containerHeight = pdfContainerRef.current.clientHeight - 32;
        const baseWidth = pageViewportRef.current.width;
        const baseHeight = pageViewportRef.current.height;
        const scaleW = containerWidth / baseWidth;
        const scaleH = containerHeight / baseHeight;
        const newZoom = +(Math.min(scaleW, scaleH)).toFixed(2);
        setPdfZoom(Math.max(0.3, Math.min(5, newZoom)));
    }, []);

    // Ctrl+Wheel zoom
    const handleWheel = useCallback((e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            setPdfZoom(z => Math.min(5, Math.max(0.3, +(z + delta).toFixed(1))));
        }
    }, []);

    // Attach wheel listener with passive:false for preventDefault
    useEffect(() => {
        const container = pdfContainerRef.current;
        if (!container) return;
        container.addEventListener('wheel', handleWheel, { passive: false });
        return () => container.removeEventListener('wheel', handleWheel);
    }, [handleWheel]);

    // Panel resize handlers (KnowhowDB pattern)
    const startResize = useCallback((e) => {
        e.preventDefault();
        resizingRef.current = true;
        setIsResizing(true);
        const startX = e.clientX;
        const startWidth = panelWidth;

        const onMove = (e) => {
            if (!resizingRef.current) return;
            const dx = e.clientX - startX;
            const pct = startWidth + (dx / window.innerWidth * 100);
            setPanelWidth(Math.max(20, Math.min(75, pct)));
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
                setExtractionStatus('PDF \uc5c5\ub85c\ub4dc \uc911...');
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
                setExtractionProgress(30);
            }

            setExtractionStatus('\ud14d\uc2a4\ud2b8 \ucd94\ucd9c \uc911 (Azure Document Intelligence)...');
            setExtractionProgress(30);

            const chunkSize = 5;
            const totalPages = pdfPages || 1;
            let allLines = [];
            let allPidNumbers = new Set();

            if (totalPages <= chunkSize) {
                setExtractionStatus('\ub77c\uc778 \ub9ac\uc2a4\ud2b8 \ucd94\ucd9c \uc911 (GPT \ubd84\uc11d)...');
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
                for (let start = 1; start <= totalPages; start += chunkSize) {
                    const end = Math.min(start + chunkSize - 1, totalPages);
                    const pageRange = `${start}-${end}`;
                    const pct = 30 + Math.round(((start - 1) / totalPages) * 60);
                    setExtractionProgress(pct);
                    setExtractionStatus(`\ud398\uc774\uc9c0 ${start}-${end} / ${totalPages} \ubd84\uc11d \uc911...`);

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
            setExtractionStatus(`\uc644\ub8cc! ${deduped.length}\uac1c \ub77c\uc778 \ucd94\ucd9c\ub428`);

        } catch (err) {
            console.error('Extraction error:', err);
            setExtractionStatus(`\uc624\ub958: ${err.message}`);
        } finally {
            setIsExtracting(false);
        }
    }, [pdfFile, pdfPages, username, selectedBlobFile, blobPath]);

    // Table row click -> navigate PDF to source_page
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
                if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                    return `"${val.replace(/"/g, '""')}"`;
                }
                return val;
            })
        );

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

    // Clear file selection
    const clearFile = () => {
        setPdfFile(null);
        setPdfUrl(null);
        setPdfPages(0);
        pdfDocRef.current = null;
        pageViewportRef.current = null;
        setBlobPath(null);
        setSelectedBlobFile(null);
        setExtractionStatus('');
        setPdfZoom(1.2);
    };

    return (
        <div className="h-screen flex flex-col bg-slate-900 text-slate-100">
            {/* Header with file controls */}
            <header className="flex-shrink-0 bg-slate-800/80 border-b border-slate-700 px-4 py-2">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => navigate('/')}
                            className="p-2 rounded-lg hover:bg-slate-700 transition-colors"
                            title="Home"
                        >
                            <ArrowLeft className="w-5 h-5 text-slate-300" />
                        </button>
                        <div className="flex items-center gap-2">
                            <ListChecks className="w-5 h-5 text-amber-400" />
                            <h1 className="text-lg font-bold text-slate-100">P&ID Line List</h1>
                        </div>

                        {/* Divider */}
                        <div className="w-px h-6 bg-slate-700 mx-1" />

                        {/* File selector dropdown */}
                        <div className="flex items-center gap-2">
                            <FolderOpen className="w-4 h-4 text-amber-400/70" />
                            <select
                                value={selectedBlobFile ? selectedBlobFile.path : ''}
                                onChange={(e) => {
                                    const file = existingFiles.find(f => f.path === e.target.value);
                                    if (file) handleBlobFileSelect(file);
                                }}
                                className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500 max-w-[250px]"
                            >
                                <option value="">{loadingFiles ? '\ub85c\ub529...' : `\ub3c4\uba74 \uc120\ud0dd (${existingFiles.length})`}</option>
                                {existingFiles.map((file, idx) => (
                                    <option key={idx} value={file.path}>{file.name}</option>
                                ))}
                            </select>
                            <button
                                onClick={fetchExistingFiles}
                                disabled={loadingFiles}
                                className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
                                title="\uc0c8\ub85c\uace0\uce68"
                            >
                                <RefreshCcw className={`w-3.5 h-3.5 ${loadingFiles ? 'animate-spin' : ''}`} />
                            </button>
                        </div>

                        {/* Upload button */}
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm transition-colors"
                            title="\uc0c8 PDF \uc5c5\ub85c\ub4dc"
                        >
                            <Upload className="w-3.5 h-3.5" />
                            \uc5c5\ub85c\ub4dc
                        </button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".pdf"
                            className="hidden"
                            onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                        />

                        {/* Current file info */}
                        {hasPdf && (
                            <>
                                <div className="w-px h-6 bg-slate-700 mx-1" />
                                <div className="flex items-center gap-2">
                                    <FileText className="w-4 h-4 text-amber-400 flex-shrink-0" />
                                    <span className="text-sm text-slate-300 truncate max-w-[200px]">
                                        {pdfFile?.name || selectedBlobFile?.name}
                                    </span>
                                    {pdfPages > 0 && (
                                        <span className="text-xs text-slate-500">({pdfPages}p)</span>
                                    )}
                                    <button
                                        onClick={clearFile}
                                        className="text-slate-500 hover:text-slate-300 text-xs ml-1"
                                    >
                                        \ubcc0\uacbd
                                    </button>
                                </div>
                            </>
                        )}

                        {/* Divider */}
                        {hasPdf && <div className="w-px h-6 bg-slate-700 mx-1" />}

                        {/* Extract button */}
                        {hasPdf && (
                            <button
                                onClick={handleExtract}
                                disabled={isExtracting}
                                className="flex items-center gap-1.5 px-4 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 disabled:cursor-not-allowed rounded text-sm font-medium transition-colors"
                            >
                                {isExtracting ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        \ucd94\ucd9c \uc911...
                                    </>
                                ) : (
                                    <>
                                        <Play className="w-4 h-4" />
                                        \ub77c\uc778\ub9ac\uc2a4\ud2b8 \ucd94\ucd9c
                                    </>
                                )}
                            </button>
                        )}

                        {/* Extraction progress inline */}
                        {(isExtracting || extractionStatus) && (
                            <div className="flex items-center gap-2 ml-2">
                                {isExtracting && (
                                    <div className="w-24 bg-slate-700 rounded-full h-1.5">
                                        <div
                                            className="bg-amber-500 h-1.5 rounded-full transition-all duration-500"
                                            style={{ width: `${extractionProgress}%` }}
                                        />
                                    </div>
                                )}
                                <span className="text-xs text-slate-400 max-w-[200px] truncate">{extractionStatus}</span>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-3">
                        {lines.length > 0 && (
                            <button
                                onClick={exportToCSV}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium transition-colors"
                            >
                                <Download className="w-3.5 h-3.5" />
                                CSV
                            </button>
                        )}
                        <span className="text-xs text-slate-400">{currentUser?.email}</span>
                    </div>
                </div>
            </header>

            {/* Main Content: 2-panel layout */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left Panel: PDF Viewer */}
                <div
                    className="flex-shrink-0 border-r border-slate-700 flex flex-col bg-slate-800/50"
                    style={{
                        width: hasPdf ? `${panelWidth}%` : '100%',
                        transition: isResizing ? 'none' : undefined,
                    }}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                >
                    {!hasPdf ? (
                        /* No file: show file picker */
                        <div className="flex-1 flex items-center justify-center">
                            <div className="text-center max-w-lg">
                                <ListChecks className="w-16 h-16 text-amber-400/30 mx-auto mb-6" />
                                <h2 className="text-xl font-semibold text-slate-300 mb-2">P&ID Line List Extractor</h2>
                                <p className="text-slate-500 mb-8">\ub3c4\uba74\uc744 \uc120\ud0dd\ud558\uac70\ub098 PDF\ub97c \uc5c5\ub85c\ub4dc\ud558\uc5ec \uc2dc\uc791\ud558\uc138\uc694</p>

                                {/* Existing files grid */}
                                {existingFiles.length > 0 && (
                                    <div className="mb-6">
                                        <p className="text-sm text-slate-400 mb-3">\uae30\uc874 \ub3c4\uba74</p>
                                        <div className="grid grid-cols-2 gap-2 max-h-[300px] overflow-auto">
                                            {existingFiles.map((file, idx) => (
                                                <button
                                                    key={idx}
                                                    onClick={() => handleBlobFileSelect(file)}
                                                    className="flex items-center gap-2 px-3 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors text-left"
                                                >
                                                    <FileText className="w-4 h-4 text-amber-400/70 flex-shrink-0" />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="text-sm text-slate-300 truncate">{file.name}</p>
                                                        <p className="text-xs text-slate-500">
                                                            {file.size ? `${(file.size / 1024 / 1024).toFixed(1)}MB` : ''}
                                                        </p>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Upload drop zone */}
                                <div
                                    onClick={() => fileInputRef.current?.click()}
                                    className="border-2 border-dashed border-slate-600 hover:border-amber-500 rounded-xl p-8 cursor-pointer transition-colors group"
                                >
                                    <Upload className="w-8 h-8 text-slate-500 group-hover:text-amber-400 mx-auto mb-2 transition-colors" />
                                    <p className="text-slate-400">\uc0c8 PDF \uc5c5\ub85c\ub4dc (\ub4dc\ub798\uadf8 & \ub4dc\ub86d)</p>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <>
                            {/* PDF Viewer toolbar */}
                            <div className="flex-shrink-0 h-9 border-b border-slate-700 flex items-center justify-center gap-2 px-3 bg-slate-800/80">
                                {/* Page navigation */}
                                <button
                                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                    disabled={currentPage <= 1}
                                    className="p-1 hover:bg-slate-700 rounded disabled:opacity-30 transition-colors"
                                    title="\uc774\uc804 \ud398\uc774\uc9c0"
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
                                    title="\ub2e4\uc74c \ud398\uc774\uc9c0"
                                >
                                    <ChevronRight className="w-4 h-4" />
                                </button>

                                <div className="w-px h-4 bg-slate-600 mx-1" />

                                {/* Zoom controls */}
                                <button
                                    onClick={handleZoomOut}
                                    className="p-1 hover:bg-slate-700 rounded transition-colors"
                                    title="Zoom Out"
                                >
                                    <ZoomOut className="w-4 h-4" />
                                </button>
                                <span className="text-xs text-slate-400 w-10 text-center">
                                    {Math.round(pdfZoom * 100)}%
                                </span>
                                <button
                                    onClick={handleZoomIn}
                                    className="p-1 hover:bg-slate-700 rounded transition-colors"
                                    title="Zoom In"
                                >
                                    <ZoomIn className="w-4 h-4" />
                                </button>

                                <div className="w-px h-4 bg-slate-600 mx-1" />

                                {/* Fit buttons */}
                                <button
                                    onClick={handleFitWidth}
                                    className="px-2 py-0.5 hover:bg-slate-700 rounded text-xs text-slate-400 hover:text-slate-200 transition-colors"
                                    title="Fit Width"
                                >
                                    <Columns className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={handleFitPage}
                                    className="px-2 py-0.5 hover:bg-slate-700 rounded text-xs text-slate-400 hover:text-slate-200 transition-colors"
                                    title="Fit Page"
                                >
                                    <Maximize className="w-4 h-4" />
                                </button>
                            </div>

                            {/* PDF Canvas (scrollable) */}
                            <div
                                ref={pdfContainerRef}
                                className="flex-1 overflow-auto bg-slate-900/50 flex items-start justify-center p-4"
                            >
                                {pdfPages > 0 ? (
                                    <canvas
                                        ref={canvasRef}
                                        className="shadow-lg border border-slate-700/50"
                                    />
                                ) : (
                                    <div className="flex flex-col items-center justify-center py-20 text-slate-500">
                                        <Loader2 className="w-8 h-8 animate-spin mb-3" />
                                        <span className="text-sm">PDF \ub85c\ub529 \uc911...</span>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Resize handle */}
                {hasPdf && (
                    <div
                        className="w-1.5 flex-shrink-0 cursor-col-resize hover:bg-amber-500/50 active:bg-amber-500/70 bg-slate-700/50 transition-colors relative z-20"
                        onMouseDown={startResize}
                        title="\ub4dc\ub798\uadf8\ud558\uc5ec \ud328\ub110 \ud06c\uae30 \uc870\uc808"
                    >
                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 bg-slate-500 rounded-full" />
                    </div>
                )}

                {/* Right Panel: Line List Table */}
                {hasPdf && (
                    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
                        {/* Table toolbar */}
                        <div className="flex-shrink-0 px-4 py-2 border-b border-slate-700 flex items-center justify-between bg-slate-800/30">
                            <div className="flex items-center gap-3">
                                <h2 className="text-sm font-semibold text-slate-300">
                                    Line List
                                    {lines.length > 0 && (
                                        <span className="ml-2 text-amber-400">({filteredLines.length}\uac74)</span>
                                    )}
                                </h2>
                                <button
                                    onClick={addRow}
                                    className="flex items-center gap-1 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs font-medium transition-colors"
                                >
                                    <Plus className="w-3 h-3" /> \ud589 \ucd94\uac00
                                </button>
                            </div>
                            {lines.length > 0 && (
                                <div className="relative">
                                    <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                                    <input
                                        type="text"
                                        placeholder="\uac80\uc0c9..."
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
                                        <p className="text-lg font-medium mb-2">\ub77c\uc778 \ub9ac\uc2a4\ud2b8\uac00 \ube44\uc5b4 \uc788\uc2b5\ub2c8\ub2e4</p>
                                        <p className="text-sm">"\ub77c\uc778\ub9ac\uc2a4\ud2b8 \ucd94\ucd9c" \ubc84\ud2bc\uc744 \ud074\ub9ad\ud558\uc138\uc694</p>
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
                                                                    isPageCol
                                                                        ? 'text-center'
                                                                        : 'cursor-text'
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
                                                            title="\uc0ad\uc81c"
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
                )}
            </div>
        </div>
    );
};

export default LineList;
