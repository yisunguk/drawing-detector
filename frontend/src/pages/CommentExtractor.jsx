import React, { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    ArrowLeft, Upload, FileText, Trash2, Plus, Download,
    MessageSquareText, Loader2, LogOut, X, Edit3, Check,
    ChevronRight, AlertCircle
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { auth } from '../firebase';

const API_BASE = (import.meta.env.VITE_API_URL || 'https://drawing-detector-backend-435353955407.us-central1.run.app').replace(/\/$/, '');
const getCommentsUrl = (path) => `${API_BASE}/api/v1/comments/${path}`;

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

    // State
    const [files, setFiles] = useState([]); // { name, drawing_no, comments[] }
    const [selectedFileIdx, setSelectedFileIdx] = useState(null);
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [editCell, setEditCell] = useState(null); // { rowIdx, colKey }
    const [editValue, setEditValue] = useState('');
    const [dragOver, setDragOver] = useState(false);
    const [exporting, setExporting] = useState(false);

    // ── Auth helper ──
    const getToken = async () => {
        const user = auth.currentUser;
        if (!user) throw new Error('Not authenticated');
        return user.getIdToken();
    };

    // ── Upload PDF ──
    const uploadPdf = useCallback(async (file) => {
        if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
            setError('PDF 파일만 업로드 가능합니다.');
            return;
        }
        setLoading(true);
        setError('');
        try {
            const token = await getToken();
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch(getCommentsUrl('extract'), {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData,
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.detail || `서버 오류 (${res.status})`);
            }

            const data = await res.json();
            const newFile = {
                name: data.filename,
                drawing_no: data.drawing_no,
                total_pages: data.total_pages,
                total_comments: data.total_comments,
                comments: data.comments || [],
            };

            setFiles(prev => {
                const updated = [...prev, newFile];
                const newIdx = updated.length - 1;
                setSelectedFileIdx(newIdx);
                setRows(newFile.comments);
                return updated;
            });
        } catch (err) {
            console.error('Upload error:', err);
            setError(err.message || 'PDF 업로드 중 오류가 발생했습니다.');
        } finally {
            setLoading(false);
        }
    }, []);

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

    // ── Select file from sidebar ──
    const selectFile = (idx) => {
        setSelectedFileIdx(idx);
        setRows(files[idx].comments);
        setEditCell(null);
    };

    const removeFile = (idx) => {
        setFiles(prev => {
            const updated = prev.filter((_, i) => i !== idx);
            if (selectedFileIdx === idx) {
                setSelectedFileIdx(updated.length > 0 ? 0 : null);
                setRows(updated.length > 0 ? updated[0].comments : []);
            } else if (selectedFileIdx > idx) {
                setSelectedFileIdx(selectedFileIdx - 1);
            }
            return updated;
        });
    };

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
            // Sync back to file
            if (selectedFileIdx !== null) {
                setFiles(fPrev => {
                    const fUpdated = [...fPrev];
                    fUpdated[selectedFileIdx] = {
                        ...fUpdated[selectedFileIdx],
                        comments: updated,
                    };
                    return fUpdated;
                });
            }
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
            drawing_no: files[selectedFileIdx]?.drawing_no || '',
            page: 0,
            type: '',
            author: '',
            contents: '',
            reply: '',
            created_date: '',
        };
        const updated = [...rows, newRow];
        setRows(updated);
        if (selectedFileIdx !== null) {
            setFiles(prev => {
                const fUpdated = [...prev];
                fUpdated[selectedFileIdx] = { ...fUpdated[selectedFileIdx], comments: updated };
                return fUpdated;
            });
        }
    };

    const deleteRow = (rowIdx) => {
        const updated = rows.filter((_, i) => i !== rowIdx).map((r, i) => ({ ...r, no: i + 1 }));
        setRows(updated);
        if (selectedFileIdx !== null) {
            setFiles(prev => {
                const fUpdated = [...prev];
                fUpdated[selectedFileIdx] = { ...fUpdated[selectedFileIdx], comments: updated };
                return fUpdated;
            });
        }
        setEditCell(null);
    };

    // ── Export Excel ──
    const exportExcel = async () => {
        if (rows.length === 0) return;
        setExporting(true);
        try {
            const token = await getToken();
            const filename = (files[selectedFileIdx]?.name || 'comments').replace('.pdf', '') + '_comments.xlsx';
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
                    <button
                        onClick={() => navigate('/')}
                        className="flex items-center gap-2 text-sm text-[#8b7e6a] hover:text-[#5a4f3f] transition-colors mb-3"
                    >
                        <ArrowLeft className="w-4 h-4" />
                        메인으로 돌아가기
                    </button>
                    <div className="flex items-center gap-2">
                        <MessageSquareText className="w-5 h-5 text-lime-600" />
                        <h1 className="text-lg font-bold text-[#333]">PDF 코멘트 추출</h1>
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
                    <p className="text-xs text-[#8b7e6a] px-1 mb-2 font-medium">
                        업로드된 파일 ({files.length})
                    </p>
                    {files.length === 0 && (
                        <p className="text-xs text-[#b0a58e] px-1">아직 업로드된 파일이 없습니다.</p>
                    )}
                    {files.map((f, idx) => (
                        <div
                            key={idx}
                            onClick={() => selectFile(idx)}
                            className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer mb-1 transition-colors ${
                                selectedFileIdx === idx
                                    ? 'bg-lime-100 border border-lime-300'
                                    : 'hover:bg-[#ebe7df] border border-transparent'
                            }`}
                        >
                            <FileText className={`w-4 h-4 flex-shrink-0 ${selectedFileIdx === idx ? 'text-lime-600' : 'text-[#8b7e6a]'}`} />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm truncate font-medium">{f.name}</p>
                                <p className="text-xs text-[#8b7e6a]">{f.total_comments}개 코멘트 / {f.total_pages}p</p>
                            </div>
                            <button
                                onClick={(e) => { e.stopPropagation(); removeFile(idx); }}
                                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-100 rounded transition-all"
                                title="삭제"
                            >
                                <X className="w-3.5 h-3.5 text-red-500" />
                            </button>
                        </div>
                    ))}
                </div>

                {/* User menu */}
                <div className="p-3 border-t border-[#e5e1d8]">
                    <div className="flex items-center justify-between">
                        <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{currentUser?.email}</p>
                        </div>
                        <button
                            onClick={handleLogout}
                            className="p-1.5 hover:bg-[#e5e1d8] rounded-lg transition-colors"
                            title="로그아웃"
                        >
                            <LogOut className="w-4 h-4 text-[#8b7e6a]" />
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

                {/* No file selected: drop zone */}
                {selectedFileIdx === null ? (
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
                                    <p className="text-lg font-medium text-[#5a4f3f]">PDF 분석 중...</p>
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
                                    <p className="text-xs text-[#b0a58e]">PDF 파일의 주석(Annotation)을 자동 추출합니다</p>
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
                                    {files[selectedFileIdx]?.name}
                                </h2>
                                <span className="text-sm text-[#8b7e6a]">
                                    ({rows.length}개 코멘트)
                                </span>
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
                            {rows.length === 0 ? (
                                <div className="flex items-center justify-center h-full text-[#8b7e6a]">
                                    <div className="text-center">
                                        <MessageSquareText className="w-12 h-12 mx-auto mb-3 text-[#d5cfc3]" />
                                        <p className="text-lg font-medium">추출된 코멘트가 없습니다</p>
                                        <p className="text-sm mt-1">이 PDF에는 주석이 포함되어 있지 않습니다.</p>
                                    </div>
                                </div>
                            ) : (
                                <table className="w-full border-collapse text-sm">
                                    <thead className="sticky top-0 z-10">
                                        <tr className="bg-[#f0ece4]">
                                            {COLUMNS.map(col => (
                                                <th
                                                    key={col.key}
                                                    className="px-3 py-2.5 text-left text-xs font-semibold text-[#5a4f3f] border-b border-[#d5cfc3] whitespace-nowrap"
                                                    style={{ minWidth: col.width }}
                                                >
                                                    {col.label}
                                                    {col.editable && <Edit3 className="w-3 h-3 inline ml-1 text-[#b0a58e]" />}
                                                </th>
                                            ))}
                                            <th className="px-2 py-2.5 text-center text-xs font-semibold text-[#5a4f3f] border-b border-[#d5cfc3] w-10">
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
                                                    return (
                                                        <td
                                                            key={col.key}
                                                            className={`px-3 py-2 ${col.editable ? 'cursor-text' : ''}`}
                                                            onClick={() => startEdit(rowIdx, col.key)}
                                                            style={{ minWidth: col.width }}
                                                        >
                                                            {isEditing ? (
                                                                <div className="flex items-center gap-1">
                                                                    <input
                                                                        autoFocus
                                                                        type="text"
                                                                        value={editValue}
                                                                        onChange={(e) => setEditValue(e.target.value)}
                                                                        onKeyDown={handleEditKeyDown}
                                                                        onBlur={commitEdit}
                                                                        className="w-full px-2 py-1 border border-lime-400 rounded bg-white text-sm focus:outline-none focus:ring-1 focus:ring-lime-500"
                                                                    />
                                                                </div>
                                                            ) : (
                                                                <span className={`block truncate ${col.key === 'contents' || col.key === 'reply' ? 'max-w-xs' : ''}`} title={String(row[col.key] ?? '')}>
                                                                    {row[col.key] ?? ''}
                                                                </span>
                                                            )}
                                                        </td>
                                                    );
                                                })}
                                                <td className="px-2 py-2 text-center">
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
