import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    ArrowLeft, Upload, FileText, Loader2, Download,
    Plus, Trash2, Search, ListChecks, Play, FolderOpen, RefreshCcw
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
    const fileInputRef = useRef(null);
    const editInputRef = useRef(null);

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

    // Render PDF page
    const renderPage = useCallback(async (pageNum) => {
        if (!pdfDocRef.current || !canvasRef.current) return;
        try {
            const page = await pdfDocRef.current.getPage(pageNum);
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');

            // Scale to fit container width (~500px)
            const containerWidth = canvas.parentElement?.clientWidth || 500;
            const viewport = page.getViewport({ scale: 1 });
            const scale = (containerWidth - 20) / viewport.width;
            const scaledViewport = page.getViewport({ scale });

            canvas.width = scaledViewport.width;
            canvas.height = scaledViewport.height;

            await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
        } catch (err) {
            console.error('PDF render error:', err);
        }
    }, []);

    // Load PDF file
    const handleFileSelect = useCallback(async (file) => {
        if (!file || !file.name.toLowerCase().endsWith('.pdf')) return;

        setPdfFile(file);
        setPdfUrl(URL.createObjectURL(file));
        setLines([]);
        setBlobPath(null);
        setExtractionStatus('');

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

    // Render page when currentPage changes
    useEffect(() => {
        if (pdfDocRef.current && currentPage > 0) {
            renderPage(currentPage);
        }
    }, [currentPage, renderPage]);

    // Also render after initial load
    useEffect(() => {
        if (pdfPages > 0) {
            renderPage(1);
        }
    }, [pdfPages, renderPage]);

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
                <div className="w-[450px] flex-shrink-0 border-r border-slate-700 flex flex-col bg-slate-800/50">
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
                                        setBlobPath(null);
                                        setSelectedBlobFile(null);
                                        setExtractionStatus('');
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

                            {/* PDF Preview */}
                            <div className="flex-1 overflow-auto p-2 flex flex-col items-center">
                                <canvas ref={canvasRef} className="max-w-full border border-slate-700 rounded" />

                                {/* Page navigation */}
                                {pdfPages > 1 && (
                                    <div className="flex items-center gap-3 mt-3 mb-2">
                                        <button
                                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                            disabled={currentPage <= 1}
                                            className="px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 rounded text-sm transition-colors"
                                        >
                                            이전
                                        </button>
                                        <span className="text-sm text-slate-400">
                                            {currentPage} / {pdfPages}
                                        </span>
                                        <button
                                            onClick={() => setCurrentPage(p => Math.min(pdfPages, p + 1))}
                                            disabled={currentPage >= pdfPages}
                                            className="px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 rounded text-sm transition-colors"
                                        >
                                            다음
                                        </button>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Right Panel: Line List Table */}
                <div className="flex-1 flex flex-col overflow-hidden">
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
                                        return (
                                            <tr
                                                key={actualIdx}
                                                className="hover:bg-slate-800/50 transition-colors"
                                            >
                                                <td className="px-2 py-1.5 border border-slate-700/50 text-center text-xs text-slate-500">
                                                    {actualIdx + 1}
                                                </td>
                                                {COLUMNS.map(col => {
                                                    const isEditing = editingCell?.row === actualIdx && editingCell?.col === col.key;
                                                    return (
                                                        <td
                                                            key={col.key}
                                                            className={`px-1 py-0.5 border border-slate-700/50 cursor-text ${isEditing ? 'bg-slate-700' : 'hover:bg-slate-800'}`}
                                                            onClick={() => handleCellClick(actualIdx, col.key)}
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
                                                                <span className="text-sm text-slate-300 px-1 block truncate">
                                                                    {line[col.key] || ''}
                                                                </span>
                                                            )}
                                                        </td>
                                                    );
                                                })}
                                                <td className="px-1 py-0.5 border border-slate-700/50 text-center">
                                                    <button
                                                        onClick={() => deleteRow(actualIdx)}
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
