import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
    Upload, FileText, Loader2, Download,
    Plus, Trash2, Search, ListChecks, Play, FolderOpen, RefreshCcw, LogOut,
    Check, AlertCircle, ArrowLeft, Clock, FileSpreadsheet
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { loadPdfJs, uploadToAzure } from '../services/analysisService';
import PDFViewer from '../components/PDFViewer';
import { db } from '../firebase';
import { doc, getDoc, setDoc, getDocs, deleteDoc, collection, query, orderBy, serverTimestamp } from 'firebase/firestore';

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

// Deterministic Firestore document ID from blob path
const toDocId = (blobPath) => blobPath.replace(/\//g, '_').replace(/\./g, '-');

const LineList = () => {
    const navigate = useNavigate();
    const { currentUser, logout } = useAuth();
    const username = currentUser?.displayName || currentUser?.email?.split('@')[0];

    // View state
    const [activeView, setActiveView] = useState('manage'); // 'manage' | 'editor'
    const [savedLineLists, setSavedLineLists] = useState([]);
    const [loadingSavedLists, setLoadingSavedLists] = useState(false);

    // PDF state
    const [pdfFile, setPdfFile] = useState(null);
    const [pdfUrl, setPdfUrl] = useState(null);
    const [pdfPages, setPdfPages] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [blobPath, setBlobPath] = useState(null);

    // Panel resize
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

    // Firestore save state
    const [saveStatus, setSaveStatus] = useState('idle'); // 'idle' | 'saving' | 'saved' | 'error'
    const [lastSavedAt, setLastSavedAt] = useState(null);

    // Refs
    const pdfDocRef = useRef(null);
    const fileInputRef = useRef(null);
    const editInputRef = useRef(null);
    const resizingRef = useRef(false);
    const saveTimerRef = useRef(null);
    const linesRef = useRef(lines);

    // Azure Blob config for preview
    const AZURE_STORAGE_ACCOUNT_NAME = import.meta.env.VITE_AZURE_STORAGE_ACCOUNT_NAME;
    const AZURE_CONTAINER_NAME = import.meta.env.VITE_AZURE_CONTAINER_NAME;
    const rawSasToken = import.meta.env.VITE_AZURE_SAS_TOKEN || '';
    const AZURE_SAS_TOKEN = rawSasToken.replace(/^"|"$/g, '');

    // Keep linesRef in sync for debounce callback
    useEffect(() => { linesRef.current = lines; }, [lines]);

    // Save lines to Firestore
    const saveToFirestore = useCallback(async (linesToSave, blob, isInitial = false) => {
        console.log('[LineList] saveToFirestore called:', { uid: currentUser?.uid, blob, linesCount: linesToSave?.length, isInitial });
        if (!currentUser?.uid || !blob || !linesToSave || linesToSave.length === 0) {
            console.warn('[LineList] saveToFirestore skipped — guard failed:', { uid: !!currentUser?.uid, blob: !!blob, lines: !!linesToSave, len: linesToSave?.length });
            return;
        }
        setSaveStatus('saving');
        try {
            const docId = toDocId(blob);
            const docRef = doc(db, 'users', currentUser.uid, 'linelists', docId);
            const fileName = blob.split('/').pop();
            const payload = {
                blob_path: blob,
                file_name: fileName,
                lines: linesToSave,
                line_count: linesToSave.length,
                updated_at: serverTimestamp(),
            };
            if (isInitial) {
                payload.created_at = serverTimestamp();
            }
            console.log('[LineList] Firestore setDoc path:', `users/${currentUser.uid}/linelists/${docId}`);
            await setDoc(docRef, payload, { merge: true });
            console.log('[LineList] Firestore save success');
            setSaveStatus('saved');
            setLastSavedAt(new Date());
            setTimeout(() => setSaveStatus(prev => prev === 'saved' ? 'idle' : prev), 2500);
        } catch (err) {
            console.error('[LineList] Firestore save error:', err);
            setSaveStatus('error');
            setTimeout(() => setSaveStatus(prev => prev === 'error' ? 'idle' : prev), 4000);
        }
    }, [currentUser?.uid]);

    // Debounced auto-save when lines change
    useEffect(() => {
        if (!blobPath || lines.length === 0) return;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            saveToFirestore(linesRef.current, blobPath);
        }, 1500);
        return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    }, [lines, blobPath, saveToFirestore]);

    // Cleanup timer on unmount
    useEffect(() => {
        return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    }, []);

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

    // Fetch saved line lists from Firestore
    const fetchSavedLineLists = useCallback(async () => {
        if (!currentUser?.uid) return;
        setLoadingSavedLists(true);
        try {
            const q = query(
                collection(db, 'users', currentUser.uid, 'linelists'),
                orderBy('updated_at', 'desc')
            );
            const snapshot = await getDocs(q);
            const items = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            setSavedLineLists(items);
        } catch (err) {
            console.error('Failed to fetch saved line lists:', err);
        } finally {
            setLoadingSavedLists(false);
        }
    }, [currentUser?.uid]);

    // Load saved line lists on mount + when entering manage view
    useEffect(() => {
        if (activeView === 'manage') {
            fetchSavedLineLists();
        }
    }, [activeView, fetchSavedLineLists]);

    // Open a saved line list card
    const handleOpenLineList = useCallback(async (item) => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

        setBlobPath(item.blob_path);
        setLines(item.lines || []);
        setPdfFile(null);
        setSelectedBlobFile({ name: item.file_name, path: item.blob_path });
        setExtractionStatus(item.lines?.length ? `저장된 데이터 ${item.lines.length}건 로드됨` : '');
        setSaveStatus('idle');
        setLastSavedAt(item.updated_at?.toDate?.() || null);

        const url = buildBlobUrl(item.blob_path);
        setPdfUrl(url);

        try {
            const pdfjsLib = await loadPdfJs();
            const pdf = await pdfjsLib.getDocument({ url }).promise;
            pdfDocRef.current = pdf;
            setPdfPages(pdf.numPages);
            setCurrentPage(1);
        } catch (err) {
            console.error('PDF load error (saved):', err);
            setPdfPages(0);
        }

        setActiveView('editor');
    }, []);

    // Delete a saved line list
    const handleDeleteLineList = useCallback(async (item) => {
        if (!window.confirm(`"${item.file_name}" 라인 리스트를 삭제하시겠습니까?`)) return;
        try {
            await deleteDoc(doc(db, 'users', currentUser.uid, 'linelists', item.id));
            setSavedLineLists(prev => prev.filter(x => x.id !== item.id));
        } catch (err) {
            console.error('Failed to delete line list:', err);
        }
    }, [currentUser?.uid]);

    // Back to manage view
    const handleBackToManage = useCallback(() => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        setPdfFile(null);
        setPdfUrl(null);
        setPdfPages(0);
        pdfDocRef.current = null;
        setBlobPath(null);
        setSelectedBlobFile(null);
        setExtractionStatus('');
        setLines([]);
        setSaveStatus('idle');
        setLastSavedAt(null);
        setSelectedRowIdx(null);
        setSearchTerm('');
        setEditingCell(null);
        setActiveView('manage');
    }, []);

    // Select an existing blob file for preview + extraction
    const handleBlobFileSelect = useCallback(async (file) => {
        // Clear previous save timer
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

        setSelectedBlobFile(file);
        setPdfFile(null); // clear local file
        setLines([]);
        setBlobPath(file.path);
        setExtractionStatus('');
        setSaveStatus('idle');
        setLastSavedAt(null);

        const url = buildBlobUrl(file.path);
        setPdfUrl(url);

        try {
            const pdfjsLib = await loadPdfJs();
            const pdf = await pdfjsLib.getDocument({ url }).promise;
            pdfDocRef.current = pdf;
            setPdfPages(pdf.numPages);
            setCurrentPage(1);
        } catch (err) {
            console.error('PDF load error (blob):', err);
            setPdfPages(0);
        }

        // Load saved line list from Firestore
        if (currentUser?.uid && file.path) {
            try {
                const docId = toDocId(file.path);
                const docRef = doc(db, 'users', currentUser.uid, 'linelists', docId);
                const snap = await getDoc(docRef);
                if (snap.exists()) {
                    const data = snap.data();
                    if (data.lines && data.lines.length > 0) {
                        setLines(data.lines);
                        setExtractionStatus(`저장된 데이터 ${data.lines.length}건 로드됨`);
                        setLastSavedAt(data.updated_at?.toDate?.() || null);
                    }
                }
            } catch (err) {
                console.error('Firestore load error:', err);
            }
        }

        setActiveView('editor');
    }, [username, currentUser?.uid]);

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

        setActiveView('editor');
    }, []);

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

            // Save to Firestore immediately after extraction
            if (deduped.length > 0 && blob_name) {
                await saveToFirestore(deduped, blob_name, true);
                // Update saved list for manage view
                const fileName = blob_name.split('/').pop();
                setSavedLineLists(prev => {
                    const docId = toDocId(blob_name);
                    const existing = prev.findIndex(x => x.id === docId);
                    const newItem = {
                        id: docId,
                        blob_path: blob_name,
                        file_name: fileName,
                        lines: deduped,
                        line_count: deduped.length,
                        updated_at: { toDate: () => new Date() },
                    };
                    if (existing >= 0) {
                        const updated = [...prev];
                        updated[existing] = newItem;
                        return updated;
                    }
                    return [newItem, ...prev];
                });
            }

        } catch (err) {
            console.error('Extraction error:', err);
            setExtractionStatus(`오류: ${err.message}`);
        } finally {
            setIsExtracting(false);
        }
    }, [pdfFile, pdfPages, username, selectedBlobFile, blobPath, saveToFirestore]);

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

    // ─── Manage View (카드 그리드) ───
    if (activeView === 'manage') {
        return (
            <div className="h-screen flex flex-col bg-slate-900 text-slate-100">
                {/* Header */}
                <header className="flex-shrink-0 bg-slate-800/80 border-b border-slate-700 px-6 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <ListChecks className="w-6 h-6 text-amber-400" />
                        <h1 className="text-xl font-bold text-slate-100">P&ID Line List Extractor</h1>
                    </div>
                </header>

                {/* Main: Sidebar + Card Grid */}
                <div className="flex-1 flex overflow-hidden">
                    {/* Left Sidebar: existing files + upload */}
                    <div className="w-72 flex-shrink-0 border-r border-slate-700 flex flex-col bg-slate-800/50">
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

                        {/* User Profile Footer */}
                        <div className="flex-shrink-0 p-3 border-t border-slate-700 bg-slate-800/80">
                            <div className="flex items-center justify-between gap-2">
                                <Link to="/" className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer hover:bg-slate-700 p-1.5 -ml-1.5 rounded-lg transition-colors group">
                                    <div className="w-8 h-8 rounded-full bg-amber-600 flex items-center justify-center text-white font-bold shrink-0 group-hover:scale-105 transition-transform">
                                        {(currentUser?.displayName || currentUser?.email || 'U')[0].toUpperCase()}
                                    </div>
                                    <div className="flex flex-col min-w-0">
                                        <span className="text-sm font-medium text-slate-200 truncate">{currentUser?.displayName || username || 'User'}</span>
                                        <span className="text-[10px] text-slate-400 truncate">{currentUser?.email}</span>
                                    </div>
                                </Link>
                                <button
                                    onClick={async () => { try { await logout(); navigate('/login'); } catch {} }}
                                    className="p-2 hover:bg-slate-700 text-slate-400 hover:text-red-400 rounded-md transition-colors"
                                    title="로그아웃"
                                >
                                    <LogOut size={18} />
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Right: Saved Line Lists Card Grid */}
                    <div className="flex-1 overflow-auto p-6">
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="text-lg font-semibold text-slate-200">
                                저장된 라인 리스트
                                <span className="ml-2 text-amber-400 text-base">({savedLineLists.length}건)</span>
                            </h2>
                            <button
                                onClick={fetchSavedLineLists}
                                disabled={loadingSavedLists}
                                className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
                                title="새로고침"
                            >
                                <RefreshCcw className={`w-4 h-4 ${loadingSavedLists ? 'animate-spin' : ''}`} />
                            </button>
                        </div>

                        {loadingSavedLists ? (
                            <div className="flex items-center justify-center py-20">
                                <Loader2 className="w-8 h-8 text-slate-500 animate-spin" />
                            </div>
                        ) : savedLineLists.length > 0 ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                                {savedLineLists.map((item) => (
                                    <div
                                        key={item.id}
                                        className="bg-slate-800/50 border border-slate-700 rounded-xl p-5 flex flex-col hover:border-amber-500/50 hover:shadow-lg hover:shadow-amber-500/5 transition-all group"
                                    >
                                        {/* Top: Icon + File name */}
                                        <div className="flex items-start gap-3 mb-3">
                                            <div className="w-10 h-10 rounded-lg bg-amber-600/20 flex items-center justify-center flex-shrink-0">
                                                <FileSpreadsheet className="w-5 h-5 text-amber-400" />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm font-medium text-slate-200 truncate" title={item.file_name}>
                                                    {item.file_name}
                                                </p>
                                            </div>
                                        </div>

                                        {/* Middle: line count + updated time */}
                                        <div className="flex items-center gap-3 mb-4">
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-600/20 text-amber-400 rounded-md text-xs font-medium">
                                                <ListChecks className="w-3 h-3" />
                                                {item.line_count || 0}건
                                            </span>
                                            {item.updated_at && (
                                                <span className="flex items-center gap-1 text-xs text-slate-500">
                                                    <Clock className="w-3 h-3" />
                                                    {(item.updated_at?.toDate?.() || new Date()).toLocaleDateString('ko-KR', {
                                                        month: 'short',
                                                        day: 'numeric',
                                                        hour: '2-digit',
                                                        minute: '2-digit',
                                                    })}
                                                </span>
                                            )}
                                        </div>

                                        {/* Bottom: Action buttons */}
                                        <div className="flex items-center gap-2 mt-auto">
                                            <button
                                                onClick={() => handleOpenLineList(item)}
                                                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg text-sm font-medium transition-colors"
                                            >
                                                <FolderOpen className="w-4 h-4" />
                                                열기
                                            </button>
                                            <button
                                                onClick={() => handleDeleteLineList(item)}
                                                className="px-3 py-2 bg-slate-700 hover:bg-red-600/80 text-slate-400 hover:text-white rounded-lg text-sm font-medium transition-colors"
                                                title="삭제"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center py-20 text-slate-500">
                                <FileSpreadsheet className="w-16 h-16 mb-4 opacity-20" />
                                <p className="text-lg font-medium mb-1">추출된 라인 리스트가 없습니다</p>
                                <p className="text-sm">좌측에서 도면을 선택하거나 새 PDF를 업로드하여 라인 리스트를 추출하세요</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // ─── Editor View (PDF + Table) ───
    return (
        <div className="h-screen flex flex-col bg-slate-900 text-slate-100">
            {/* Header */}
            <header className="flex-shrink-0 bg-slate-800/80 border-b border-slate-700 px-6 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <ListChecks className="w-6 h-6 text-amber-400" />
                    <h1 className="text-xl font-bold text-slate-100">P&ID Line List Extractor</h1>
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
                </div>
            </header>

            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left Panel: PDF Preview */}
                <div
                    className="flex-shrink-0 border-r border-slate-700 flex flex-col bg-slate-800/50"
                    style={{
                        width: panelWidth,
                        transition: isResizing ? 'none' : undefined,
                    }}
                >
                    {/* Back + Extract buttons */}
                    <div className="flex-shrink-0 px-3 py-2 border-b border-slate-700 flex items-center gap-2">
                        <button
                            onClick={handleBackToManage}
                            className="flex items-center gap-1.5 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium transition-colors"
                        >
                            <ArrowLeft className="w-4 h-4" />
                            목록
                        </button>
                        <button
                            onClick={handleExtract}
                            disabled={isExtracting}
                            className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-lg font-medium text-sm transition-colors"
                        >
                            {isExtracting ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    추출 중...
                                </>
                            ) : (
                                <>
                                    <Play className="w-4 h-4" />
                                    라인 리스트 추출
                                </>
                            )}
                        </button>
                        {isExtracting && (
                            <div className="flex-1 flex items-center gap-2">
                                <div className="flex-1 bg-slate-700 rounded-full h-1.5">
                                    <div
                                        className="bg-amber-500 h-1.5 rounded-full transition-all duration-500"
                                        style={{ width: `${extractionProgress}%` }}
                                    />
                                </div>
                                <span className="text-xs text-slate-400 whitespace-nowrap">{extractionStatus}</span>
                            </div>
                        )}
                    </div>

                    {/* PDF Viewer */}
                    <PDFViewer
                        doc={{ page: currentPage, docId: pdfUrl || 'local' }}
                        documents={[{ id: pdfUrl || 'local', name: pdfFile?.name || selectedBlobFile?.name || 'PDF', pdfUrl: pdfUrl }]}
                        onClose={handleBackToManage}
                    />

                    {/* User Profile Footer */}
                    <div className="flex-shrink-0 p-3 border-t border-slate-700 bg-slate-800/80">
                        <div className="flex items-center justify-between gap-2">
                            <Link to="/" className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer hover:bg-slate-700 p-1.5 -ml-1.5 rounded-lg transition-colors group">
                                <div className="w-8 h-8 rounded-full bg-amber-600 flex items-center justify-center text-white font-bold shrink-0 group-hover:scale-105 transition-transform">
                                    {(currentUser?.displayName || currentUser?.email || 'U')[0].toUpperCase()}
                                </div>
                                <div className="flex flex-col min-w-0">
                                    <span className="text-sm font-medium text-slate-200 truncate">{currentUser?.displayName || username || 'User'}</span>
                                    <span className="text-[10px] text-slate-400 truncate">{currentUser?.email}</span>
                                </div>
                            </Link>
                            <button
                                onClick={async () => { try { await logout(); navigate('/login'); } catch {} }}
                                className="p-2 hover:bg-slate-700 text-slate-400 hover:text-red-400 rounded-md transition-colors"
                                title="로그아웃"
                            >
                                <LogOut size={18} />
                            </button>
                        </div>
                    </div>
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
                        <div className="flex items-center gap-3">
                            {/* Save status indicator */}
                            {lines.length > 0 && blobPath && (
                                <span className="flex items-center gap-1.5 text-xs">
                                    {saveStatus === 'saving' && (
                                        <>
                                            <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                                            <span className="text-amber-400">저장 중...</span>
                                        </>
                                    )}
                                    {saveStatus === 'saved' && (
                                        <>
                                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                                            <span className="text-emerald-400">저장됨</span>
                                        </>
                                    )}
                                    {saveStatus === 'error' && (
                                        <>
                                            <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                                            <span className="text-red-400">저장 실패</span>
                                        </>
                                    )}
                                    {saveStatus === 'idle' && lastSavedAt && (
                                        <span className="text-slate-500">
                                            마지막 저장: {lastSavedAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                    )}
                                </span>
                            )}
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
