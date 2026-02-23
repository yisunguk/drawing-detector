import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
    ArrowLeft, Upload, FileText, Trash2, Plus, Download,
    MessageSquareText, Loader2, LogOut, X, Edit3, Check,
    ChevronRight, AlertCircle, Settings, RefreshCw, CloudOff,
    CheckCircle2, Clock
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { auth, db } from '../firebase';
import { doc, setDoc, getDoc, getDocs, deleteDoc, collection, query, orderBy, serverTimestamp } from 'firebase/firestore';
import { getUploadSas, uploadToAzure, startAnalysis, pollAnalysisStatus, countPdfPages, loadPdfJs } from '../services/analysisService';

const API_BASE = (import.meta.env.VITE_API_URL || 'https://drawing-detector-backend-435353955407.us-central1.run.app').replace(/\/$/, '');
const getCommentsUrl = (path) => `${API_BASE}/api/v1/comments/${path}`;

const toDocId = (blobPath) => blobPath.replace(/\//g, '_').replace(/\./g, '-');

const COLUMNS = [
    { key: 'no', label: 'No', width: 50, editable: false },
    { key: 'drawing_no', label: '도면번호', width: 180, editable: true },
    { key: 'page', label: '페이지', width: 70, editable: false },
    { key: 'type', label: '타입', width: 100, editable: false },
    { key: 'author', label: '작성자', width: 120, editable: true },
    { key: 'contents', label: '코멘트 내용', width: 300, editable: true },
    { key: 'reply', label: '답변', width: 300, editable: true },
    { key: 'created_date', label: '작성일자', width: 140, editable: true },
];

const CommentExtractor = () => {
    const navigate = useNavigate();
    const { currentUser, logout } = useAuth();
    const fileInputRef = useRef(null);

    const username = currentUser?.displayName || currentUser?.email?.split('@')[0] || '';

    // State
    const [blobFiles, setBlobFiles] = useState([]); // blob file list
    const [loadingFiles, setLoadingFiles] = useState(false);
    const [selectedBlobPath, setSelectedBlobPath] = useState(null);
    const [rows, setRows] = useState([]);
    const [fileMeta, setFileMeta] = useState(null); // {filename, drawing_no, total_pages, total_comments}
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [editCell, setEditCell] = useState(null); // { rowIdx, colKey }
    const [editValue, setEditValue] = useState('');
    const [dragOver, setDragOver] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [analyzing, setAnalyzing] = useState(false);
    const [analysisMsg, setAnalysisMsg] = useState('');
    const [deleting, setDeleting] = useState(null); // blob_path being deleted

    // Firestore save state
    const [saveStatus, setSaveStatus] = useState('idle');
    const [lastSavedAt, setLastSavedAt] = useState(null);
    const rowsRef = useRef(rows);
    const saveTimerRef = useRef(null);

    // Keep rowsRef in sync
    useEffect(() => { rowsRef.current = rows; }, [rows]);

    // ── Auth helper ──
    const getToken = async () => {
        const user = auth.currentUser;
        if (!user) throw new Error('Not authenticated');
        return user.getIdToken();
    };

    // ── Load blob file list ──
    const loadBlobFiles = useCallback(async () => {
        if (!username) return;
        setLoadingFiles(true);
        try {
            const res = await fetch(`${API_BASE}/api/v1/azure/list?path=${encodeURIComponent(username)}/comments/`);
            if (res.ok) {
                const data = await res.json();
                setBlobFiles(data.filter(f => f.name.toLowerCase().endsWith('.pdf')));
            }
        } catch (err) {
            console.error('Failed to load blob files:', err);
        } finally {
            setLoadingFiles(false);
        }
    }, [username]);

    // Load on mount
    useEffect(() => { loadBlobFiles(); }, [loadBlobFiles]);

    // ── Firestore save ──
    const saveToFirestore = useCallback(async (commentRows, blobPath, meta, isInitial = false) => {
        if (!currentUser?.uid || !blobPath || !commentRows || commentRows.length === 0) return;
        setSaveStatus('saving');
        try {
            const docId = toDocId(blobPath);
            const docRef = doc(db, 'users', currentUser.uid, 'comments', docId);
            const fileName = blobPath.split('/').pop();
            const payload = {
                blob_path: blobPath,
                file_name: fileName,
                drawing_no: meta?.drawing_no || '',
                total_pages: meta?.total_pages || 0,
                total_comments: commentRows.length,
                comments: commentRows,
                updated_at: serverTimestamp(),
            };
            if (isInitial) {
                payload.created_at = serverTimestamp();
            }
            await setDoc(docRef, payload, { merge: true });
            setSaveStatus('saved');
            setLastSavedAt(new Date());
            setTimeout(() => setSaveStatus(prev => prev === 'saved' ? 'idle' : prev), 2500);
        } catch (err) {
            console.error('[Comments] Firestore save error:', err);
            setSaveStatus('error');
            setTimeout(() => setSaveStatus(prev => prev === 'error' ? 'idle' : prev), 4000);
        }
    }, [currentUser?.uid]);

    // Debounced auto-save
    useEffect(() => {
        if (!selectedBlobPath || rows.length === 0) return;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            saveToFirestore(rowsRef.current, selectedBlobPath, fileMeta);
        }, 1500);
        return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    }, [rows, selectedBlobPath, fileMeta, saveToFirestore]);

    // Cleanup timer on unmount
    useEffect(() => {
        return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    }, []);

    // ── Upload PDF (new blob flow) ──
    const uploadPdf = useCallback(async (file) => {
        if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
            setError('PDF 파일만 업로드 가능합니다.');
            return;
        }
        setLoading(true);
        setError('');
        setAnalyzing(false);
        setAnalysisMsg('');

        try {
            // 1. Count pages
            const totalPages = await countPdfPages(file);

            // 2. Get SAS upload URL
            const { upload_url: sasUrl, blob_name } = await getUploadSas(file.name, username);

            // 3. Upload to Azure Blob
            await uploadToAzure(sasUrl, file);

            // 4. Extract annotations from blob (temp path)
            const token = await getToken();
            const extractRes = await fetch(getCommentsUrl('extract-blob'), {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ blob_path: blob_name, username }),
            });
            if (!extractRes.ok) {
                const errData = await extractRes.json().catch(() => ({}));
                throw new Error(errData.detail || `추출 오류 (${extractRes.status})`);
            }
            const data = await extractRes.json();

            // 5. Start DI analysis + indexing (async, non-blocking)
            setAnalyzing(true);
            setAnalysisMsg('DI 분석 시작...');
            startAnalysis(file.name, totalPages, username, 'comments')
                .then(() => pollAnalysisStatus(file.name, (status) => {
                    if (status.status === 'in_progress') {
                        const pct = status.completed_chunks?.length
                            ? Math.round((status.completed_chunks.length / Math.ceil(totalPages / 50)) * 100)
                            : 0;
                        setAnalysisMsg(`DI 분석 중... ${pct}%`);
                    }
                }, totalPages, username))
                .then(() => {
                    setAnalyzing(false);
                    setAnalysisMsg('인덱싱 완료 - Know-how DB에서 검색 가능');
                    setTimeout(() => setAnalysisMsg(''), 5000);
                })
                .catch((err) => {
                    console.error('DI analysis error:', err);
                    setAnalyzing(false);
                    setAnalysisMsg('DI 분석 실패 (코멘트 추출은 정상)');
                    setTimeout(() => setAnalysisMsg(''), 5000);
                });

            // 6. The blob is in temp initially; after DI completes it moves to {user}/comments/{file}
            //    Construct the final blob path for Firestore reference
            const finalBlobPath = `${username}/comments/${file.name}`;

            // 7. Set UI state
            const meta = {
                filename: data.filename,
                drawing_no: data.drawing_no,
                total_pages: data.total_pages,
                total_comments: data.total_comments,
            };
            setFileMeta(meta);
            setRows(data.comments || []);
            setSelectedBlobPath(finalBlobPath);

            // 8. Firestore initial save
            if (data.comments && data.comments.length > 0) {
                saveToFirestore(data.comments, finalBlobPath, meta, true);
            }

            // 9. Refresh file list (with delay for blob move)
            setTimeout(() => loadBlobFiles(), 3000);
        } catch (err) {
            console.error('Upload error:', err);
            setError(err.message || 'PDF 업로드 중 오류가 발생했습니다.');
        } finally {
            setLoading(false);
        }
    }, [username, saveToFirestore, loadBlobFiles]);

    const handleFileSelect = (e) => {
        const fileList = e.target.files;
        if (fileList) {
            Array.from(fileList).forEach(f => uploadPdf(f));
        }
        e.target.value = '';
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setDragOver(false);
        const fileList = e.dataTransfer.files;
        if (fileList) {
            Array.from(fileList).forEach(f => uploadPdf(f));
        }
    };

    const handleDragOver = (e) => { e.preventDefault(); setDragOver(true); };
    const handleDragLeave = () => setDragOver(false);

    // ── Select file from sidebar (Firestore-first load) ──
    const selectFile = useCallback(async (file) => {
        const blobPath = file.path || `${username}/comments/${file.name}`;
        setSelectedBlobPath(blobPath);
        setEditCell(null);
        setLoading(true);
        setError('');

        try {
            // 1. Try Firestore first
            if (currentUser?.uid) {
                const docId = toDocId(blobPath);
                const docRef = doc(db, 'users', currentUser.uid, 'comments', docId);
                const snap = await getDoc(docRef);
                if (snap.exists()) {
                    const data = snap.data();
                    if (data.comments && data.comments.length > 0) {
                        setRows(data.comments);
                        setFileMeta({
                            filename: data.file_name,
                            drawing_no: data.drawing_no || '',
                            total_pages: data.total_pages || 0,
                            total_comments: data.comments.length,
                        });
                        setLoading(false);
                        return;
                    }
                }
            }

            // 2. Fallback: extract from blob
            const token = await getToken();
            const res = await fetch(getCommentsUrl('extract-blob'), {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ blob_path: blobPath, username }),
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.detail || `추출 오류 (${res.status})`);
            }
            const data = await res.json();
            const meta = {
                filename: data.filename,
                drawing_no: data.drawing_no,
                total_pages: data.total_pages,
                total_comments: data.total_comments,
            };
            setRows(data.comments || []);
            setFileMeta(meta);

            // Save to Firestore for future loads
            if (data.comments && data.comments.length > 0) {
                saveToFirestore(data.comments, blobPath, meta, true);
            }
        } catch (err) {
            console.error('File select error:', err);
            setError(err.message || '파일 로드 중 오류가 발생했습니다.');
            setRows([]);
            setFileMeta(null);
        } finally {
            setLoading(false);
        }
    }, [username, currentUser?.uid, saveToFirestore]);

    // ── Delete file ──
    const deleteFile = useCallback(async (file) => {
        const blobPath = file.path || `${username}/comments/${file.name}`;
        if (!window.confirm(`"${file.name}" 파일을 삭제하시겠습니까?\nBlob, 분석 데이터, 인덱스가 모두 삭제됩니다.`)) return;

        setDeleting(blobPath);
        try {
            const token = await getToken();
            // 1. Delete blob + JSON + search index
            await fetch(getCommentsUrl('delete-blob'), {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ blob_path: blobPath, username }),
            });

            // 2. Delete Firestore doc
            if (currentUser?.uid) {
                const docId = toDocId(blobPath);
                const docRef = doc(db, 'users', currentUser.uid, 'comments', docId);
                await deleteDoc(docRef).catch(() => {});
            }

            // 3. Update UI
            setBlobFiles(prev => prev.filter(f => {
                const fPath = f.path || `${username}/comments/${f.name}`;
                return fPath !== blobPath;
            }));
            if (selectedBlobPath === blobPath) {
                setSelectedBlobPath(null);
                setRows([]);
                setFileMeta(null);
            }
        } catch (err) {
            console.error('Delete error:', err);
            setError('파일 삭제 중 오류가 발생했습니다.');
        } finally {
            setDeleting(null);
        }
    }, [username, currentUser?.uid, selectedBlobPath]);

    // ── Inline editing ──
    const startEdit = (rowIdx, colKey) => {
        const col = COLUMNS.find(c => c.key === colKey);
        if (!col?.editable) return;
        setEditCell({ rowIdx, colKey });
        setEditValue(rows[rowIdx][colKey] ?? '');
    };

    const commitEdit = () => {
        if (!editCell) return;
        const { rowIdx, colKey } = editCell;
        setRows(prev => {
            const updated = [...prev];
            updated[rowIdx] = { ...updated[rowIdx], [colKey]: editValue };
            return updated;
        });
        setEditCell(null);
    };

    const cancelEdit = () => setEditCell(null);

    const handleEditKeyDown = (e) => {
        if (e.key === 'Enter') commitEdit();
        if (e.key === 'Escape') cancelEdit();
    };

    // ── Row add/delete ──
    const addRow = () => {
        const newRow = {
            no: rows.length + 1,
            drawing_no: fileMeta?.drawing_no || '',
            page: 0,
            type: '',
            author: '',
            contents: '',
            reply: '',
            created_date: '',
        };
        setRows(prev => [...prev, newRow]);
    };

    const deleteRow = (rowIdx) => {
        setRows(prev => prev.filter((_, i) => i !== rowIdx).map((r, i) => ({ ...r, no: i + 1 })));
        setEditCell(null);
    };

    // ── Export Excel ──
    const exportExcel = async () => {
        if (rows.length === 0) return;
        setExporting(true);
        try {
            const token = await getToken();
            const filename = (fileMeta?.filename || 'comments').replace('.pdf', '') + '_comments.xlsx';
            const res = await fetch(getCommentsUrl('export-excel'), {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ filename, rows }),
            });

            if (!res.ok) throw new Error('Excel 내보내기 실패');

            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Export error:', err);
            setError('Excel 내보내기 중 오류가 발생했습니다.');
        } finally {
            setExporting(false);
        }
    };

    // ── Logout ──
    const handleLogout = async () => {
        try { await logout(); navigate('/login'); }
        catch (err) { console.error('Logout failed:', err); }
    };

    // ── Render ──
    return (
        <div className="h-screen flex bg-[#fcfaf7] text-[#333]">
            {/* Sidebar */}
            <div className="w-72 bg-[#f5f1eb] border-r border-[#e5e1d8] flex flex-col">
                {/* Sidebar Header */}
                <div className="p-4 border-b border-[#e5e1d8]">
                    <div className="flex items-center gap-2">
                        <MessageSquareText className="w-5 h-5 text-lime-600" />
                        <h1 className="text-lg font-bold text-[#333]">설계 코멘트 관리</h1>
                    </div>
                </div>

                {/* Upload button */}
                <div className="p-3">
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={loading}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-lime-600 hover:bg-lime-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                    >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                        PDF 업로드
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf"
                        multiple
                        onChange={handleFileSelect}
                        className="hidden"
                    />
                </div>

                {/* File list */}
                <div className="flex-1 overflow-y-auto px-3 pb-3">
                    <div className="flex items-center justify-between px-1 mb-2">
                        <p className="text-xs text-[#8b7e6a] font-medium">
                            저장된 파일 ({blobFiles.length})
                        </p>
                        <button
                            onClick={loadBlobFiles}
                            disabled={loadingFiles}
                            className="p-1 hover:bg-[#ebe7df] rounded transition-colors"
                            title="새로고침"
                        >
                            <RefreshCw className={`w-3.5 h-3.5 text-[#8b7e6a] ${loadingFiles ? 'animate-spin' : ''}`} />
                        </button>
                    </div>
                    {loadingFiles && blobFiles.length === 0 && (
                        <div className="flex items-center gap-2 px-1 text-xs text-[#8b7e6a]">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 로딩 중...
                        </div>
                    )}
                    {!loadingFiles && blobFiles.length === 0 && (
                        <p className="text-xs text-[#b0a58e] px-1">아직 업로드된 파일이 없습니다.</p>
                    )}
                    {blobFiles.map((f, idx) => {
                        const fPath = f.path || `${username}/comments/${f.name}`;
                        const isSelected = selectedBlobPath === fPath;
                        const isDeleting = deleting === fPath;
                        return (
                            <div
                                key={fPath}
                                onClick={() => !isDeleting && selectFile(f)}
                                className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer mb-1 transition-colors ${
                                    isSelected
                                        ? 'bg-lime-100 border border-lime-300'
                                        : 'hover:bg-[#ebe7df] border border-transparent'
                                } ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
                            >
                                <FileText className={`w-4 h-4 flex-shrink-0 ${isSelected ? 'text-lime-600' : 'text-[#8b7e6a]'}`} />
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm truncate font-medium">{f.name}</p>
                                </div>
                                <button
                                    onClick={(e) => { e.stopPropagation(); deleteFile(f); }}
                                    disabled={isDeleting}
                                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-100 rounded transition-all"
                                    title="삭제"
                                >
                                    {isDeleting
                                        ? <Loader2 className="w-3.5 h-3.5 text-red-500 animate-spin" />
                                        : <X className="w-3.5 h-3.5 text-red-500" />
                                    }
                                </button>
                            </div>
                        );
                    })}
                </div>

                {/* User Profile Footer */}
                <div className="p-3 border-t border-[#e5e1d8] bg-[#f4f1ea]">
                    <div className="flex items-center justify-between gap-2">
                        <Link to="/profile" className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer hover:bg-[#e5e1d8] p-1.5 -ml-1.5 rounded-lg transition-colors group">
                            <div className="w-8 h-8 rounded-full bg-[#65a30d] flex items-center justify-center text-white font-bold shrink-0 group-hover:scale-105 transition-transform">
                                {(currentUser?.displayName || currentUser?.email || 'U')[0].toUpperCase()}
                            </div>
                            <div className="flex flex-col min-w-0">
                                <span className="text-sm font-medium text-[#333333] truncate">{currentUser?.displayName || 'User'}</span>
                                <span className="text-[10px] text-[#666666] truncate">{currentUser?.email}</span>
                            </div>
                        </Link>
                        <button
                            onClick={handleLogout}
                            className="p-2 hover:bg-green-100 text-[#555555] hover:text-green-700 rounded-md transition-colors"
                            title="로그아웃"
                        >
                            <LogOut size={18} />
                        </button>
                    </div>
                </div>
            </div>

            {/* Main content */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {/* Error banner */}
                {error && (
                    <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-sm">
                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                        {error}
                        <button onClick={() => setError('')} className="ml-auto p-0.5 hover:bg-red-100 rounded">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                )}

                {/* Analysis status banner */}
                {analysisMsg && (
                    <div className={`mx-6 mt-4 p-3 rounded-lg flex items-center gap-2 text-sm ${
                        analyzing
                            ? 'bg-blue-50 border border-blue-200 text-blue-700'
                            : analysisMsg.includes('실패')
                                ? 'bg-amber-50 border border-amber-200 text-amber-700'
                                : 'bg-green-50 border border-green-200 text-green-700'
                    }`}>
                        {analyzing
                            ? <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
                            : analysisMsg.includes('실패')
                                ? <AlertCircle className="w-4 h-4 flex-shrink-0" />
                                : <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                        }
                        {analysisMsg}
                    </div>
                )}

                {/* No file selected: drop zone */}
                {!selectedBlobPath ? (
                    <div className="flex-1 flex items-center justify-center p-8">
                        <div
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            onDragLeave={handleDragLeave}
                            onClick={() => fileInputRef.current?.click()}
                            className={`w-full max-w-2xl p-16 border-2 border-dashed rounded-2xl text-center cursor-pointer transition-all ${
                                dragOver
                                    ? 'border-lime-500 bg-lime-50'
                                    : 'border-[#d5cfc3] hover:border-lime-400 hover:bg-lime-50/50'
                            }`}
                        >
                            {loading ? (
                                <div className="flex flex-col items-center gap-4">
                                    <Loader2 className="w-12 h-12 text-lime-600 animate-spin" />
                                    <p className="text-lg font-medium text-[#5a4f3f]">PDF 업로드 및 분석 중...</p>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center gap-4">
                                    <div className="w-20 h-20 rounded-full bg-lime-100 flex items-center justify-center">
                                        <Upload className="w-10 h-10 text-lime-600" />
                                    </div>
                                    <div>
                                        <p className="text-xl font-bold text-[#333] mb-2">PDF 파일을 드래그하여 업로드</p>
                                        <p className="text-[#8b7e6a]">또는 클릭하여 파일을 선택하세요</p>
                                    </div>
                                    <p className="text-xs text-[#b0a58e]">PDF 파일의 주석(Annotation)을 자동 추출하고 Know-how DB에 인덱싱합니다</p>
                                </div>
                            )}
                        </div>
                    </div>
                ) : (
                    <>
                        {/* Toolbar */}
                        <div className="px-6 py-3 border-b border-[#e5e1d8] bg-white flex items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <h2 className="text-base font-bold truncate max-w-md">
                                    {fileMeta?.filename || selectedBlobPath?.split('/').pop()}
                                </h2>
                                <span className="text-sm text-[#8b7e6a]">
                                    ({rows.length}개 코멘트{fileMeta?.total_pages ? ` / ${fileMeta.total_pages}p` : ''})
                                </span>
                                {/* Save status badge */}
                                {rows.length > 0 && (
                                    <span className="flex items-center gap-1.5 text-xs">
                                        {saveStatus === 'saving' && (
                                            <>
                                                <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                                                <span className="text-amber-400">저장 중...</span>
                                            </>
                                        )}
                                        {saveStatus === 'saved' && lastSavedAt && (
                                            <>
                                                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                                                <span className="text-green-600">
                                                    저장됨 {lastSavedAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                                                </span>
                                            </>
                                        )}
                                        {saveStatus === 'error' && (
                                            <>
                                                <CloudOff className="w-3.5 h-3.5 text-red-400" />
                                                <span className="text-red-500">저장 오류</span>
                                            </>
                                        )}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={addRow}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#f5f1eb] hover:bg-[#ebe7df] border border-[#d5cfc3] rounded-lg transition-colors"
                                >
                                    <Plus className="w-3.5 h-3.5" /> 행 추가
                                </button>
                                <button
                                    onClick={exportExcel}
                                    disabled={rows.length === 0 || exporting}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-lime-600 hover:bg-lime-700 text-white rounded-lg transition-colors disabled:opacity-50"
                                >
                                    {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                    Excel 내보내기
                                </button>
                            </div>
                        </div>

                        {/* Table */}
                        <div className="flex-1 overflow-auto">
                            {loading ? (
                                <div className="flex items-center justify-center h-full">
                                    <div className="flex flex-col items-center gap-3">
                                        <Loader2 className="w-10 h-10 text-lime-600 animate-spin" />
                                        <p className="text-[#8b7e6a]">코멘트 로딩 중...</p>
                                    </div>
                                </div>
                            ) : rows.length === 0 ? (
                                <div className="flex items-center justify-center h-full text-[#8b7e6a]">
                                    <div className="text-center">
                                        <MessageSquareText className="w-12 h-12 mx-auto mb-3 text-[#d5cfc3]" />
                                        <p className="text-lg font-medium">추출된 코멘트가 없습니다</p>
                                        <p className="text-sm mt-1">이 PDF에는 주석이 포함되어 있지 않습니다.</p>
                                    </div>
                                </div>
                            ) : (
                                <table className="w-full border-collapse text-sm table-fixed">
                                    <thead className="sticky top-0 z-10">
                                        <tr className="bg-[#f0ece4]">
                                            {COLUMNS.map(col => (
                                                <th
                                                    key={col.key}
                                                    className="px-3 py-2.5 text-left text-xs font-semibold text-[#5a4f3f] border-b border-[#d5cfc3] whitespace-nowrap"
                                                    style={{ width: col.width }}
                                                >
                                                    {col.label}
                                                </th>
                                            ))}
                                            <th className="px-2 py-2.5 text-center text-xs font-semibold text-[#5a4f3f] border-b border-[#d5cfc3]" style={{ width: 44 }}>
                                                삭제
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((row, rowIdx) => (
                                            <tr
                                                key={rowIdx}
                                                className={`border-b border-[#e5e1d8] ${rowIdx % 2 === 0 ? 'bg-white' : 'bg-[#faf8f4]'} hover:bg-lime-50/50 transition-colors`}
                                            >
                                                {COLUMNS.map(col => {
                                                    const isEditing = editCell?.rowIdx === rowIdx && editCell?.colKey === col.key;
                                                    const cellValue = row[col.key] ?? '';
                                                    const isEmpty = String(cellValue).trim() === '';
                                                    const isLongText = col.key === 'contents' || col.key === 'reply';
                                                    return (
                                                        <td
                                                            key={col.key}
                                                            className={`px-3 py-2 align-top ${col.editable ? 'cursor-text group/cell' : ''}`}
                                                            onClick={() => startEdit(rowIdx, col.key)}
                                                            style={{ width: col.width }}
                                                        >
                                                            {isEditing ? (
                                                                isLongText ? (
                                                                    <textarea
                                                                        autoFocus
                                                                        rows={3}
                                                                        value={editValue}
                                                                        onChange={(e) => setEditValue(e.target.value)}
                                                                        onKeyDown={(e) => { if (e.key === 'Escape') cancelEdit(); }}
                                                                        onBlur={commitEdit}
                                                                        className="w-full px-2 py-1 border border-lime-400 rounded bg-white text-sm focus:outline-none focus:ring-2 focus:ring-lime-500 resize-y"
                                                                    />
                                                                ) : (
                                                                    <input
                                                                        autoFocus
                                                                        type="text"
                                                                        value={editValue}
                                                                        onChange={(e) => setEditValue(e.target.value)}
                                                                        onKeyDown={handleEditKeyDown}
                                                                        onBlur={commitEdit}
                                                                        className="w-full px-2 py-1 border border-lime-400 rounded bg-white text-sm focus:outline-none focus:ring-2 focus:ring-lime-500"
                                                                    />
                                                                )
                                                            ) : (
                                                                <div className={`whitespace-pre-wrap break-words text-sm ${col.editable ? 'min-h-[1.5rem]' : ''} ${col.editable && isEmpty ? 'text-[#c5bfb0] italic' : ''} ${col.editable ? 'hover:bg-lime-50 rounded px-1 -mx-1 transition-colors' : ''}`}>
                                                                    {isEmpty && col.editable
                                                                        ? (col.key === 'reply' ? '클릭하여 답변 입력...' : '클릭하여 편집...')
                                                                        : cellValue}
                                                                </div>
                                                            )}
                                                        </td>
                                                    );
                                                })}
                                                <td className="px-2 py-2 text-center align-top" style={{ width: 44 }}>
                                                    <button
                                                        onClick={() => deleteRow(rowIdx)}
                                                        className="p-1 hover:bg-red-100 rounded transition-colors"
                                                        title="행 삭제"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5 text-red-400 hover:text-red-600" />
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default CommentExtractor;
