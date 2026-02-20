import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
    ArrowLeft, Search as SearchIcon, Send, Bot, User, Loader2,
    ChevronRight, ChevronDown, X, Upload, Trash2, Plus, Edit3,
    FileText, FolderOpen, CheckCircle2, Clock, AlertCircle, XCircle,
    Download, MessageSquare, BarChart3, LogOut, ClipboardCheck, RefreshCcw,
    Users, Bell, Settings, Copy
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as XLSX from 'xlsx';
import { useAuth } from '../contexts/AuthContext';
import { auth } from '../firebase';

const API_BASE = (import.meta.env.VITE_API_URL || 'https://drawing-detector-backend-435353955407.us-central1.run.app').replace(/\/$/, '');

const getRevisionApiUrl = (path) => {
    const base = API_BASE.endsWith('/api') ? `${API_BASE}/v1/revision` : `${API_BASE}/api/v1/revision`;
    return `${base}/${path}`;
};

const PHASES = {
    phase_1: { name: 'Pre-Commissioning & MC', name_ko: '사전시운전/MC', milestones: ['MC', 'PSSR', 'RFSU'] },
    phase_2: { name: 'Commissioning & Testing', name_ko: '시운전/시험', milestones: ['FGSO', 'UFT', 'RRT', 'PG Test'] },
    phase_3: { name: 'Performance & Initial Acceptance', name_ko: '성능인수/초기인수', milestones: ['PA', 'IA', 'COD'] },
    phase_4: { name: 'Final Acceptance', name_ko: '최종 인수', milestones: ['FA'] },
};

const STATUS_CONFIG = {
    not_started: { label: '미착수', color: 'bg-gray-100 text-gray-600', dot: 'bg-gray-400' },
    in_progress: { label: '진행중', color: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-400' },
    approved: { label: '승인', color: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
    cancelled: { label: '취소', color: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
};

const SS_KEY = 'revision-master-state';
const _loadSS = () => { try { return JSON.parse(sessionStorage.getItem(SS_KEY)) || {}; } catch { return {}; } };

// ── Resizable Table Component ──
const COL_DEFAULTS = [80, 130, 100, 350, 60, 70, 90];
const COL_KEYS = ['상태', '문서번호', '태그번호', '제목', 'Phase', '리비전', '날짜'];

const ResizableTable = ({ docs, selectedDocId, onSelectDoc, onStatusChange, projectData }) => {
    const [colWidths, setColWidths] = useState(() => {
        try { const s = JSON.parse(sessionStorage.getItem('rev-col-widths')); return s || [...COL_DEFAULTS]; }
        catch { return [...COL_DEFAULTS]; }
    });
    const draggingCol = useRef(null);
    const startX = useRef(0);
    const startW = useRef(0);

    const handleMouseDown = (colIdx, e) => {
        e.preventDefault();
        e.stopPropagation();
        draggingCol.current = colIdx;
        startX.current = e.clientX;
        startW.current = colWidths[colIdx];
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    const handleMouseMove = useCallback((e) => {
        if (draggingCol.current === null) return;
        const diff = e.clientX - startX.current;
        const newWidth = Math.max(40, startW.current + diff);
        setColWidths(prev => {
            const next = [...prev];
            next[draggingCol.current] = newWidth;
            return next;
        });
    }, []);

    const handleMouseUp = useCallback(() => {
        draggingCol.current = null;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        setColWidths(prev => {
            sessionStorage.setItem('rev-col-widths', JSON.stringify(prev));
            return prev;
        });
    }, [handleMouseMove]);

    const [statusDropdown, setStatusDropdown] = useState(null);

    return (
        <table className="text-sm" style={{ tableLayout: 'fixed', width: colWidths.reduce((a, b) => a + b, 0) }}>
            <thead className="bg-slate-100 sticky top-0 z-10">
                <tr className="text-left text-slate-500">
                    {COL_KEYS.map((label, i) => (
                        <th key={label} className="relative px-3 py-2.5 font-medium select-none" style={{ width: colWidths[i] }}>
                            {label}
                            <div
                                onMouseDown={(e) => handleMouseDown(i, e)}
                                className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-cyan-400/50 active:bg-cyan-500/50 z-20"
                            />
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {docs.map(doc => {
                    const st = STATUS_CONFIG[doc.status] || STATUS_CONFIG.not_started;
                    const isSelected = selectedDocId === doc.doc_id;
                    return (
                        <tr
                            key={doc.doc_id}
                            onClick={() => onSelectDoc(doc.doc_id)}
                            className={`cursor-pointer border-b border-slate-100 transition ${isSelected ? 'bg-cyan-50' : 'hover:bg-slate-50'}`}
                        >
                            <td className="px-3 py-2.5 relative" style={{ width: colWidths[0] }}>
                                <button
                                    onClick={(e) => { e.stopPropagation(); setStatusDropdown(statusDropdown === doc.doc_id ? null : doc.doc_id); }}
                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${st.color} hover:ring-2 hover:ring-offset-1 hover:ring-cyan-300 transition`}
                                    title="상태 변경"
                                >
                                    <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                                    {st.label}
                                </button>
                                {statusDropdown === doc.doc_id && (
                                    <div className="absolute left-3 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[120px]"
                                        onClick={e => e.stopPropagation()}>
                                        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                                            <button key={key}
                                                onClick={() => { onStatusChange(doc.doc_id, key); setStatusDropdown(null); }}
                                                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 flex items-center gap-2 ${doc.status === key ? 'font-bold' : ''}`}>
                                                <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
                                                {cfg.label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-slate-700 truncate" style={{ width: colWidths[1] }}>{doc.doc_no || '-'}</td>
                            <td className="px-3 py-2.5 text-slate-600 truncate" style={{ width: colWidths[2] }}>{doc.tag_no || '-'}</td>
                            <td className="px-3 py-2.5 text-slate-800 font-medium truncate" style={{ width: colWidths[3] }} title={doc.title}>{doc.title}</td>
                            <td className="px-3 py-2.5 text-xs text-slate-500" style={{ width: colWidths[4] }}>{doc.phase?.replace('phase_', 'P')}</td>
                            <td className="px-3 py-2.5 font-mono text-slate-600" style={{ width: colWidths[5] }}>{doc.latest_revision || '-'}</td>
                            <td className="px-3 py-2.5 text-xs text-slate-400" style={{ width: colWidths[6] }}>{doc.latest_date || '-'}</td>
                        </tr>
                    );
                })}
                {docs.length === 0 && (
                    <tr>
                        <td colSpan={7} className="text-center py-12 text-slate-400">
                            {projectData ? '해당 Phase에 문서가 없습니다' : '데이터 로딩 중...'}
                        </td>
                    </tr>
                )}
            </tbody>
        </table>
    );
};

const RevisionMaster = () => {
    const navigate = useNavigate();
    const { currentUser, logout } = useAuth();
    const username = currentUser?.displayName || currentUser?.email?.split('@')[0];
    const isAdmin = currentUser?.email === 'admin@poscoenc.com';

    const saved = useRef(_loadSS()).current;
    const defaultChat = [{ role: 'assistant', content: '안녕하세요! 리비전 문서에 대해 궁금한 점을 물어보세요.' }];

    // === Project State ===
    const [projects, setProjects] = useState([]);
    const [selectedProject, setSelectedProject] = useState(saved.selectedProject || null);
    const [projectData, setProjectData] = useState(null);
    const [loadingProject, setLoadingProject] = useState(false);

    // === Left Panel State ===
    const [expandedPhases, setExpandedPhases] = useState(() => new Set(saved.expandedPhases || ['phase_1', 'phase_2', 'phase_3', 'phase_4']));

    // === Center Panel State ===
    const [activePhaseTab, setActivePhaseTab] = useState(saved.activePhaseTab || 'all');
    const [selectedDocId, setSelectedDocId] = useState(saved.selectedDocId || null);
    const [tableFilter, setTableFilter] = useState('');
    const [searchMode, setSearchMode] = useState(false);
    const [mode, setMode] = useState(saved.mode || 'search');
    const [query, setQuery] = useState('');
    const [exactMatch, setExactMatch] = useState(false);
    const [searchResults, setSearchResults] = useState([]);
    const [isSearching, setIsSearching] = useState(false);
    const [chatMessages, setChatMessages] = useState(saved.chatMessages?.length > 0 ? saved.chatMessages : defaultChat);
    const [isChatLoading, setIsChatLoading] = useState(false);

    // === Right Panel State ===
    const [revisionHistory, setRevisionHistory] = useState(null);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [editingRevId, setEditingRevId] = useState(null);
    const [editRevData, setEditRevData] = useState({});
    const [revSelection, setRevSelection] = useState([]);
    const [comparisonResult, setComparisonResult] = useState(null);
    const [copiedId, setCopiedId] = useState(null);
    const [isComparing, setIsComparing] = useState(false);

    // === Modal State ===
    const [showUploadSpec, setShowUploadSpec] = useState(false);
    const [showAddDoc, setShowAddDoc] = useState(false);
    const [showRegisterRev, setShowRegisterRev] = useState(false);
    const [showEditDoc, setShowEditDoc] = useState(false);
    const [showEditProject, setShowEditProject] = useState(false);
    const [showReanalyze, setShowReanalyze] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState('');
    const [isReindexing, setIsReindexing] = useState(false);
    const [reindexResult, setReindexResult] = useState(null);

    // === Layout ===
    const [leftWidth, setLeftWidth] = useState(saved.leftWidth || 280);
    const leftResizingRef = useRef(false);
    const [rightWidth, setRightWidth] = useState(saved.rightWidth || 400);
    const rightResizingRef = useRef(false);

    const messagesEndRef = useRef(null);
    const specFileRef = useRef(null);
    const revFileRef = useRef(null);

    // ── Persist state ──
    useEffect(() => {
        const state = {
            selectedProject, activePhaseTab, selectedDocId, mode, chatMessages,
            expandedPhases: [...expandedPhases], leftWidth, rightWidth,
        };
        try { sessionStorage.setItem(SS_KEY, JSON.stringify(state)); } catch { }
    }, [selectedProject, activePhaseTab, selectedDocId, mode, chatMessages, expandedPhases, leftWidth, rightWidth]);

    // ── Auth helper ──
    const getAuthHeaders = useCallback(async () => {
        const user = auth.currentUser;
        if (!user) return {};
        const token = await user.getIdToken();
        return { 'Authorization': `Bearer ${token}` };
    }, []);

    // ── Load projects ──
    const loadProjects = useCallback(async () => {
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(getRevisionApiUrl('projects'), { headers });
            const data = await res.json();
            setProjects(data.projects || []);
        } catch (e) {
            console.error('Load projects failed:', e);
        }
    }, [getAuthHeaders]);

    useEffect(() => { loadProjects(); }, [loadProjects]);

    // ── Load project detail ──
    const loadProjectDetail = useCallback(async (projectId) => {
        if (!projectId) return;
        setLoadingProject(true);
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(getRevisionApiUrl(`project/${projectId}`), { headers });
            const data = await res.json();
            setProjectData(data);
        } catch (e) {
            console.error('Load project detail failed:', e);
        } finally {
            setLoadingProject(false);
        }
    }, [getAuthHeaders]);

    useEffect(() => {
        if (selectedProject) loadProjectDetail(selectedProject);
        else setProjectData(null);
    }, [selectedProject, loadProjectDetail]);

    // ── Load revision history ──
    const loadRevisionHistory = useCallback(async (docId) => {
        if (!selectedProject || !docId) return;
        setLoadingHistory(true);
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(getRevisionApiUrl(`revision-history/${selectedProject}/${docId}`), { headers });
            const data = await res.json();
            setRevisionHistory(data);
        } catch (e) {
            console.error('Load revision history failed:', e);
        } finally {
            setLoadingHistory(false);
        }
    }, [selectedProject, getAuthHeaders]);

    useEffect(() => {
        if (selectedDocId && selectedProject) loadRevisionHistory(selectedDocId);
        else setRevisionHistory(null);
    }, [selectedDocId, selectedProject, loadRevisionHistory]);

    // ── Upload Spec ──
    const handleUploadSpec = async (e) => {
        e.preventDefault();
        const form = e.target;
        const file = specFileRef.current?.files?.[0];
        if (!file) return;

        setIsUploading(true);
        setUploadProgress('사양서 업로드 중...');
        try {
            const headers = await getAuthHeaders();
            const formData = new FormData();
            formData.append('file', file);
            formData.append('project_name', form.project_name.value);
            formData.append('project_code', form.project_code.value);

            setUploadProgress('Azure DI 분석 + GPT 문서 추출 중... (1-2분 소요)');
            const res = await fetch(getRevisionApiUrl('upload-spec'), {
                method: 'POST', headers, body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Upload failed');

            setUploadProgress(`완료! ${data.documents_count}개 문서 추출됨`);
            setSelectedProject(data.project_id);
            setShowUploadSpec(false);
            loadProjects();
        } catch (err) {
            setUploadProgress(`오류: ${err.message}`);
        } finally {
            setIsUploading(false);
        }
    };

    // ── Re-analyze Spec ──
    const reanalyzeFileRef = useRef(null);
    const handleReanalyzeSpec = async (e) => {
        e.preventDefault();
        if (!selectedProject) return;

        setIsUploading(true);
        setUploadProgress('사양서 재분석 중...');
        try {
            const headers = await getAuthHeaders();
            const formData = new FormData();
            formData.append('project_id', selectedProject);
            const file = reanalyzeFileRef.current?.files?.[0];
            if (file) {
                formData.append('file', file);
            }

            setUploadProgress('Azure DI 분석 + GPT 문서 추출 + 병합 중... (1-2분 소요)');
            const res = await fetch(getRevisionApiUrl('reanalyze-spec'), {
                method: 'POST', headers, body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Re-analysis failed');

            const mr = data.merge_result || {};
            setUploadProgress(`완료! 총 ${data.documents_count}개 문서 (업데이트: ${mr.updated || 0}, 신규: ${mr.added || 0}, 유지: ${mr.kept || 0})`);
            setTimeout(() => {
                setShowReanalyze(false);
                setUploadProgress('');
                loadProjectDetail(selectedProject);
                loadProjects();
            }, 2000);
        } catch (err) {
            setUploadProgress(`오류: ${err.message}`);
        } finally {
            setIsUploading(false);
        }
    };

    // ── Register Revision ──
    // ── Auto-analyze revision file ──
    const [revFormData, setRevFormData] = useState({ revision: '', change_description: '' });
    const [isAnalyzing, setIsAnalyzing] = useState(false);

    const handleRevFileChange = async (e) => {
        const file = e.target.files?.[0];
        if (!file || !selectedProject || !selectedDocId) return;

        setIsAnalyzing(true);
        setUploadProgress('파일 분석 중... (AI가 리비전 정보를 추출합니다)');
        try {
            const headers = await getAuthHeaders();
            const formData = new FormData();
            formData.append('file', file);
            formData.append('project_id', selectedProject);
            formData.append('doc_id', selectedDocId);

            const res = await fetch(getRevisionApiUrl('analyze-revision-file'), {
                method: 'POST', headers, body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Analysis failed');

            setRevFormData({
                revision: data.suggested_revision || '',
                change_description: data.suggested_description || '',
            });
            setUploadProgress(data.detected_from_document
                ? '문서에서 리비전 정보를 자동 추출했습니다'
                : '리비전 번호를 자동 제안했습니다');
        } catch (err) {
            setUploadProgress(`분석 실패 (수동 입력 가능): ${err.message}`);
        } finally {
            setIsAnalyzing(false);
        }
    };

    const handleRegisterRevision = async (e) => {
        e.preventDefault();
        const form = e.target;
        const file = revFileRef.current?.files?.[0];
        if (!file) return;

        setIsUploading(true);
        setUploadProgress('리비전 등록 중...');
        try {
            const headers = await getAuthHeaders();
            const formData = new FormData();
            formData.append('file', file);
            formData.append('project_id', selectedProject);
            formData.append('doc_id', selectedDocId);
            formData.append('revision', form.revision.value);
            formData.append('change_description', form.change_description.value);
            formData.append('engineer_name', form.engineer_name.value);

            setUploadProgress('파일 업로드 + DI 분석 중...');
            const res = await fetch(getRevisionApiUrl('register-revision'), {
                method: 'POST', headers, body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Registration failed');

            setUploadProgress('완료!');
            setShowRegisterRev(false);
            loadProjectDetail(selectedProject);
            loadRevisionHistory(selectedDocId);
        } catch (err) {
            setUploadProgress(`오류: ${err.message}`);
        } finally {
            setIsUploading(false);
        }
    };

    // ── Add Document ──
    const handleAddDocument = async (e) => {
        e.preventDefault();
        const form = e.target;
        try {
            const headers = await getAuthHeaders();
            headers['Content-Type'] = 'application/json';
            const res = await fetch(getRevisionApiUrl('add-document'), {
                method: 'POST', headers,
                body: JSON.stringify({
                    project_id: selectedProject,
                    doc_no: form.doc_no.value,
                    tag_no: form.tag_no.value,
                    title: form.title.value,
                    phase: form.phase.value,
                }),
            });
            if (!res.ok) throw new Error('Failed');
            setShowAddDoc(false);
            loadProjectDetail(selectedProject);
        } catch (err) {
            alert('문서 추가 실패: ' + err.message);
        }
    };

    // ── Update Document ──
    const handleUpdateDocument = async (e) => {
        e.preventDefault();
        const form = e.target;
        try {
            const headers = await getAuthHeaders();
            headers['Content-Type'] = 'application/json';
            const res = await fetch(getRevisionApiUrl('update-document'), {
                method: 'PUT', headers,
                body: JSON.stringify({
                    project_id: selectedProject,
                    doc_id: selectedDocId,
                    doc_no: form.doc_no.value,
                    tag_no: form.tag_no.value,
                    title: form.title.value,
                    phase: form.phase.value,
                }),
            });
            if (!res.ok) throw new Error('Failed');
            setShowEditDoc(false);
            loadProjectDetail(selectedProject);
        } catch (err) {
            alert('문서 수정 실패: ' + err.message);
        }
    };

    // ── Update Project ──
    const handleUpdateProject = async (e) => {
        e.preventDefault();
        const form = e.target;
        try {
            const headers = await getAuthHeaders();
            headers['Content-Type'] = 'application/json';
            const res = await fetch(getRevisionApiUrl('update-project'), {
                method: 'PUT', headers,
                body: JSON.stringify({
                    project_id: selectedProject,
                    project_name: form.project_name.value,
                    project_code: form.project_code.value,
                }),
            });
            if (!res.ok) throw new Error('Failed');
            setShowEditProject(false);
            loadProjects();
            loadProjectDetail(selectedProject);
        } catch (err) {
            alert('프로젝트 수정 실패: ' + err.message);
        }
    };

    // ── Update Revision ──
    const handleUpdateRevision = async () => {
        if (!editingRevId || !editRevData) return;
        try {
            const headers = await getAuthHeaders();
            headers['Content-Type'] = 'application/json';
            const res = await fetch(getRevisionApiUrl('update-revision'), {
                method: 'PUT', headers,
                body: JSON.stringify({
                    project_id: selectedProject,
                    doc_id: selectedDocId,
                    revision_id: editingRevId,
                    ...editRevData,
                }),
            });
            if (!res.ok) throw new Error('Failed');
            setEditingRevId(null);
            loadRevisionHistory(selectedDocId);
            loadProjectDetail(selectedProject);
        } catch (err) {
            alert('리비전 수정 실패: ' + err.message);
        }
    };

    // ── Compare Revisions (AI) ──
    const handleCompareRevisions = async () => {
        if (revSelection.length !== 2) return;
        setIsComparing(true);
        setComparisonResult(null);
        try {
            const headers = await getAuthHeaders();
            headers['Content-Type'] = 'application/json';
            const res = await fetch(getRevisionApiUrl('compare-revisions'), {
                method: 'POST', headers,
                body: JSON.stringify({
                    project_id: selectedProject,
                    doc_id: selectedDocId,
                    revision_id_a: revSelection[0],
                    revision_id_b: revSelection[1],
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Comparison failed');
            setComparisonResult(data);
        } catch (err) {
            setComparisonResult({ comparison: `오류: ${err.message}` });
        } finally {
            setIsComparing(false);
        }
    };

    const toggleRevSelection = (revisionId) => {
        setRevSelection(prev =>
            prev.includes(revisionId) ? prev.filter(id => id !== revisionId) : [...prev, revisionId]
        );
    };

    const handleReindexRevisions = async () => {
        if (!revSelection.length || !selectedProject || !selectedDocId) return;
        if (!window.confirm(`선택한 리비전 ${revSelection.length}건을 리인덱싱합니다.\nDI 분석 + 임베딩이 실행됩니다. 진행하시겠습니까?`)) return;
        setIsReindexing(true);
        setReindexResult(null);
        try {
            const headers = await getAuthHeaders();
            headers['Content-Type'] = 'application/json';
            const res = await fetch(getRevisionApiUrl('reindex-revisions'), {
                method: 'POST', headers,
                body: JSON.stringify({ project_id: selectedProject, doc_id: selectedDocId, revision_ids: revSelection }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Reindex failed');
            setReindexResult(data);
            setRevSelection([]);
            loadRevisionHistory(selectedDocId);
        } catch (err) {
            alert('리인덱싱 실패: ' + err.message);
        } finally {
            setIsReindexing(false);
        }
    };

    const handleDeleteRevisions = async () => {
        if (!revSelection.length || !selectedProject || !selectedDocId) return;
        if (!window.confirm(`선택한 리비전 ${revSelection.length}건을 삭제합니다.\n파일, DI 데이터, 검색 인덱스가 모두 삭제됩니다.\n\n정말 삭제하시겠습니까?`)) return;
        try {
            const headers = await getAuthHeaders();
            headers['Content-Type'] = 'application/json';
            const res = await fetch(getRevisionApiUrl('delete-revisions'), {
                method: 'POST', headers,
                body: JSON.stringify({ project_id: selectedProject, doc_id: selectedDocId, revision_ids: revSelection }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Delete failed');
            setRevSelection([]);
            loadRevisionHistory(selectedDocId);
            loadProjectDetail(selectedProject);
        } catch (err) {
            alert('삭제 실패: ' + err.message);
        }
    };

    // ── Delete Project ──
    const handleDeleteProject = async () => {
        if (!selectedProject) return;
        if (!window.confirm('이 프로젝트를 삭제하시겠습니까? 모든 데이터가 삭제됩니다.')) return;
        try {
            const headers = await getAuthHeaders();
            await fetch(getRevisionApiUrl(`project/${selectedProject}`), { method: 'DELETE', headers });
            setSelectedProject(null);
            setProjectData(null);
            loadProjects();
        } catch (err) {
            alert('삭제 실패: ' + err.message);
        }
    };

    // ── Search / Chat ──
    const handleSearch = async () => {
        if (!query.trim()) return;
        setIsSearching(true);
        try {
            const headers = await getAuthHeaders();
            headers['Content-Type'] = 'application/json';
            const res = await fetch(getRevisionApiUrl('search'), {
                method: 'POST', headers,
                body: JSON.stringify({
                    query, project_id: selectedProject, mode: 'search', exact_match: exactMatch, top: 20,
                }),
            });
            const data = await res.json();
            setSearchResults(data.results || []);
        } catch (err) {
            console.error('Search failed:', err);
        } finally {
            setIsSearching(false);
        }
    };

    const handleChat = async () => {
        if (!query.trim()) return;
        const userMsg = { role: 'user', content: query };
        setChatMessages(prev => [...prev, userMsg]);
        setQuery('');
        setIsChatLoading(true);
        try {
            const headers = await getAuthHeaders();
            headers['Content-Type'] = 'application/json';
            const res = await fetch(getRevisionApiUrl('search'), {
                method: 'POST', headers,
                body: JSON.stringify({
                    query: userMsg.content, project_id: selectedProject,
                    mode: 'chat', history: chatMessages,
                }),
            });
            const data = await res.json();
            setChatMessages(prev => [...prev, { role: 'assistant', content: data.response || '응답 없음' }]);
        } catch (err) {
            setChatMessages(prev => [...prev, { role: 'assistant', content: `오류: ${err.message}` }]);
        } finally {
            setIsChatLoading(false);
        }
    };

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatMessages]);

    // ── Filtered documents ──
    const filteredDocs = projectData?.documents?.filter(d => {
        if (activePhaseTab !== 'all' && d.phase !== activePhaseTab) return false;
        if (tableFilter.trim()) {
            const q = tableFilter.trim().toLowerCase();
            return (d.doc_no || '').toLowerCase().includes(q)
                || (d.tag_no || '').toLowerCase().includes(q)
                || (d.title || '').toLowerCase().includes(q)
                || (d.status || '').toLowerCase().includes(q)
                || (d.latest_revision || '').toLowerCase().includes(q);
        }
        return true;
    }) || [];

    const selectedDoc = projectData?.documents?.find(d => d.doc_id === selectedDocId);

    // ── Clipboard Copy ──
    const handleCopy = async (text, id) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedId(id);
            setTimeout(() => setCopiedId(null), 2000);
        } catch { /* ignore */ }
    };

    // ── Excel Download ──
    const handleExcelDownload = () => {
        if (!filteredDocs.length || !projectData) return;
        const STATUS_LABEL = { not_started: '미착수', in_progress: '진행중', approved: '승인', cancelled: '취소' };
        const PHASE_LABEL = { phase_1: 'Phase 1', phase_2: 'Phase 2', phase_3: 'Phase 3', phase_4: 'Phase 4' };

        const rows = filteredDocs.map((d, i) => ({
            'No': i + 1,
            '상태': STATUS_LABEL[d.status] || d.status,
            '문서번호': d.doc_no || '',
            '태그번호': d.tag_no || '',
            '제목': d.title || '',
            'Phase': PHASE_LABEL[d.phase] || d.phase,
            '최신 리비전': d.latest_revision || '-',
            '최신 날짜': d.latest_date || '-',
            '리비전 횟수': d.revisions?.length || 0,
        }));

        const ws = XLSX.utils.json_to_sheet(rows);
        // Column widths
        ws['!cols'] = [
            { wch: 5 }, { wch: 8 }, { wch: 22 }, { wch: 14 }, { wch: 55 },
            { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
        ];
        const wb = XLSX.utils.book_new();
        const sheetName = activePhaseTab === 'all' ? '전체' : (PHASES[activePhaseTab]?.name_ko || activePhaseTab);
        XLSX.utils.book_append_sheet(wb, ws, sheetName.substring(0, 31));
        const filename = `${projectData.project_code || projectData.project_name || 'Revision'}_${sheetName}_${new Date().toISOString().slice(0, 10)}.xlsx`;
        XLSX.writeFile(wb, filename);
    };

    // ── Phase progress ──
    const getPhaseProgress = (phaseKey) => {
        const s = projectData?.summary?.[phaseKey];
        if (!s || s.total === 0) return 0;
        return Math.round((s.approved / s.total) * 100);
    };

    // ── Resizer handlers ──
    const startLeftResize = useCallback((e) => {
        e.preventDefault();
        leftResizingRef.current = true;
        const startX = e.clientX;
        const startW = leftWidth;
        const onMove = (ev) => { if (leftResizingRef.current) setLeftWidth(Math.max(200, Math.min(400, startW + ev.clientX - startX))); };
        const onUp = () => { leftResizingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [leftWidth]);

    const startRightResize = useCallback((e) => {
        e.preventDefault();
        rightResizingRef.current = true;
        const startX = e.clientX;
        const startW = rightWidth;
        const onMove = (ev) => { if (rightResizingRef.current) setRightWidth(Math.max(300, Math.min(600, startW - (ev.clientX - startX)))); };
        const onUp = () => { rightResizingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [rightWidth]);

    // ═══════════════════ RENDER ═══════════════════

    return (
        <div className="h-screen flex flex-col bg-slate-50 overflow-hidden">
            {/* ── Top Bar ── */}
            <div className="h-12 bg-gradient-to-r from-cyan-700 to-teal-700 flex items-center px-4 shrink-0 shadow-md z-20">
                <button onClick={() => navigate('/')} className="flex items-center gap-2 text-white/80 hover:text-white transition mr-4">
                    <ArrowLeft className="w-4 h-4" />
                    <span className="text-sm">홈</span>
                </button>
                <ClipboardCheck className="w-5 h-5 text-cyan-200 mr-2" />
                <h1 className="text-white font-bold text-lg">Revision Master</h1>
                <div className="flex-1" />
            </div>

            <div className="flex flex-1 overflow-hidden">
                {/* ═══ LEFT PANEL ═══ */}
                <div style={{ width: leftWidth }} className="bg-white border-r border-slate-200 flex flex-col shrink-0 overflow-hidden">
                    {/* Project Selector */}
                    <div className="p-3 border-b border-slate-200">
                        <div className="flex items-center gap-2 mb-2">
                            <select
                                className="flex-1 text-sm border border-slate-300 rounded-lg px-2 py-1.5 bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                                value={selectedProject || ''}
                                onChange={(e) => { setSelectedProject(e.target.value || null); setSelectedDocId(null); }}
                            >
                                <option value="">프로젝트 선택...</option>
                                {projects.map(p => (
                                    <option key={p.project_id} value={p.project_id}>
                                        {p.project_code ? `[${p.project_code}] ` : ''}{p.project_name}
                                    </option>
                                ))}
                            </select>
                            <button onClick={() => { setShowUploadSpec(true); setUploadProgress(''); }} className="p-1.5 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition" title="새 프로젝트">
                                <Plus className="w-4 h-4" />
                            </button>
                        </div>
                        {selectedProject && (
                            <div className="flex gap-1 flex-wrap">
                                <button onClick={() => loadProjectDetail(selectedProject)} className="text-xs text-cyan-600 hover:text-cyan-800 flex items-center gap-1">
                                    <RefreshCcw className="w-3 h-3" /> 새로고침
                                </button>
                                <span className="text-slate-300 mx-0.5">|</span>
                                <button onClick={() => setShowEditProject(true)} className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1">
                                    <Edit3 className="w-3 h-3" /> 수정
                                </button>
                                <span className="text-slate-300 mx-0.5">|</span>
                                <button onClick={handleDeleteProject} className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1">
                                    <Trash2 className="w-3 h-3" /> 삭제
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Phase Tree */}
                    <div className="flex-1 overflow-y-auto p-2">
                        {projectData ? Object.entries(PHASES).map(([key, phase]) => {
                            const phaseDocs = projectData.documents?.filter(d => d.phase === key) || [];
                            const isExpanded = expandedPhases.has(key);
                            return (
                                <div key={key} className="mb-1">
                                    <button
                                        onClick={() => {
                                            setExpandedPhases(prev => {
                                                const next = new Set(prev);
                                                next.has(key) ? next.delete(key) : next.add(key);
                                                return next;
                                            });
                                            setActivePhaseTab(key);
                                        }}
                                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition
                                            ${activePhaseTab === key ? 'bg-cyan-50 text-cyan-700 font-medium' : 'text-slate-600 hover:bg-slate-50'}`}
                                    >
                                        {isExpanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                                        <span className="truncate flex-1 text-left">{phase.name_ko}</span>
                                        <span className="text-xs text-slate-400">({phaseDocs.length})</span>
                                    </button>
                                    {isExpanded && (
                                        <div className="ml-6 mt-0.5 space-y-0.5">
                                            {phaseDocs.slice(0, 10).map(doc => {
                                                const st = STATUS_CONFIG[doc.status] || STATUS_CONFIG.not_started;
                                                return (
                                                    <button
                                                        key={doc.doc_id}
                                                        onClick={() => { setSelectedDocId(doc.doc_id); setActivePhaseTab(key); }}
                                                        className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs transition
                                                            ${selectedDocId === doc.doc_id ? 'bg-cyan-100 text-cyan-800' : 'text-slate-500 hover:bg-slate-50'}`}
                                                    >
                                                        <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                                                        <span className="truncate text-left">{doc.doc_no || doc.title}</span>
                                                    </button>
                                                );
                                            })}
                                            {phaseDocs.length > 10 && (
                                                <p className="text-xs text-slate-400 px-2">+{phaseDocs.length - 10}개 더</p>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        }) : (
                            <div className="text-center text-slate-400 text-sm mt-8 px-4">
                                <FolderOpen className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                                <p>프로젝트를 선택하거나<br />새 프로젝트를 생성하세요</p>
                            </div>
                        )}
                    </div>

                    {/* Dashboard */}
                    {projectData && (
                        <div className="p-3 border-t border-slate-200 bg-slate-50">
                            <div className="flex items-center gap-1.5 mb-2">
                                <BarChart3 className="w-4 h-4 text-cyan-600" />
                                <span className="text-xs font-semibold text-slate-600">진행률</span>
                                <span className="text-xs text-slate-400 ml-auto">{projectData.summary?.total || 0}건</span>
                            </div>
                            {Object.entries(PHASES).map(([key, phase]) => {
                                const pct = getPhaseProgress(key);
                                const s = projectData?.summary?.[key];
                                return (
                                    <div key={key} className="mb-2">
                                        <div className="flex justify-between text-xs text-slate-500 mb-0.5">
                                            <span className="font-medium">{phase.name_ko}</span>
                                            <span>{pct}% ({s?.approved || 0}/{s?.total || 0})</span>
                                        </div>
                                        <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                            <div className="h-full bg-cyan-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                                        </div>
                                        <div className="flex gap-1 mt-0.5 flex-wrap">
                                            {phase.milestones?.map(ms => (
                                                <span key={ms} className="text-[10px] bg-slate-200 text-slate-500 px-1 rounded">{ms}</span>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* User Profile & Admin Menu */}
                    <div className="border-t border-slate-200 shrink-0">
                        <div className="p-3 flex items-center gap-2.5">
                            <Link
                                to="/profile"
                                className="flex items-center gap-2.5 flex-1 min-w-0 hover:bg-slate-100 p-1.5 -m-1.5 rounded-lg transition-colors group"
                            >
                                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500 to-teal-500 flex items-center justify-center text-white font-bold text-xs shrink-0 group-hover:scale-105 transition-transform">
                                    {(currentUser?.displayName || currentUser?.email || 'U')[0].toUpperCase()}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-slate-800 truncate">{currentUser?.displayName || username || 'User'}</p>
                                    <p className="text-[10px] text-slate-400 truncate">{currentUser?.email}</p>
                                </div>
                            </Link>
                            <button
                                onClick={async () => {
                                    try { await logout(); navigate('/login'); } catch {}
                                }}
                                className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors shrink-0"
                                title="로그아웃"
                            >
                                <LogOut className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Left resize handle */}
                <div onMouseDown={startLeftResize} className="w-1 cursor-col-resize bg-slate-200 hover:bg-cyan-400 transition shrink-0" />

                {/* ═══ CENTER PANEL ═══ */}
                <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                    {/* Phase Tabs */}
                    <div className="bg-white border-b border-slate-200 px-4 flex items-center gap-1 shrink-0">
                        <button
                            onClick={() => setActivePhaseTab('all')}
                            className={`px-3 py-2.5 text-sm font-medium border-b-2 transition flex items-center gap-1.5
                                ${activePhaseTab === 'all' ? 'border-cyan-600 text-cyan-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
                        >
                            전체
                            {projectData?.summary?.total > 0 && (
                                <span className={`text-xs px-1.5 py-0.5 rounded-full ${activePhaseTab === 'all' ? 'bg-cyan-100 text-cyan-700' : 'bg-slate-100 text-slate-400'}`}>
                                    {projectData.summary.total}
                                </span>
                            )}
                        </button>
                        {Object.entries(PHASES).map(([key, phase]) => {
                            const count = projectData?.summary?.[key]?.total || 0;
                            return (
                                <button
                                    key={key}
                                    onClick={() => setActivePhaseTab(key)}
                                    className={`px-3 py-2.5 text-sm font-medium border-b-2 transition flex items-center gap-1.5
                                        ${activePhaseTab === key ? 'border-cyan-600 text-cyan-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
                                >
                                    {phase.name_ko}
                                    {count > 0 && (
                                        <span className={`text-xs px-1.5 py-0.5 rounded-full ${activePhaseTab === key ? 'bg-cyan-100 text-cyan-700' : 'bg-slate-100 text-slate-400'}`}>
                                            {count}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                        <div className="flex-1" />
                        <button
                            onClick={() => setSearchMode(!searchMode)}
                            className={`px-2.5 py-1.5 text-sm rounded-lg transition flex items-center gap-1
                                ${searchMode ? 'bg-cyan-100 text-cyan-700' : 'text-slate-500 hover:bg-slate-100'}`}
                        >
                            <SearchIcon className="w-4 h-4" />
                            AI 검색
                        </button>
                    </div>

                    {!searchMode ? (
                        /* ── Document Table ── */
                        <div className="flex-1 overflow-hidden flex flex-col">
                            {/* Action bar */}
                            <div className="px-4 py-2 flex items-center gap-2 bg-slate-50 border-b border-slate-200 shrink-0">
                                {selectedProject && (
                                    <>
                                        <button onClick={() => setShowAddDoc(true)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition">
                                            <Plus className="w-3.5 h-3.5" /> 문서 추가
                                        </button>
                                        <button onClick={() => { setShowReanalyze(true); setUploadProgress(''); }} className="flex items-center gap-1 px-3 py-1.5 text-sm border border-cyan-300 text-cyan-700 rounded-lg hover:bg-cyan-50 transition">
                                            <RefreshCcw className="w-3.5 h-3.5" /> 사양서 재분석
                                        </button>
                                        {selectedDocId && (
                                            <>
                                                <button onClick={() => { setShowRegisterRev(true); setUploadProgress(''); setRevFormData({ revision: '', change_description: '' }); }} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition">
                                                    <Upload className="w-3.5 h-3.5" /> 리비전 등록
                                                </button>
                                                <button onClick={() => setShowEditDoc(true)} className="flex items-center gap-1 px-3 py-1.5 text-sm border border-slate-300 text-slate-600 rounded-lg hover:bg-slate-100 transition">
                                                    <Edit3 className="w-3.5 h-3.5" /> 수정
                                                </button>
                                            </>
                                        )}
                                    </>
                                )}
                                <div className="flex-1" />
                                {selectedProject && (
                                    <div className="relative">
                                        <SearchIcon className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                                        <input
                                            type="text"
                                            value={tableFilter}
                                            onChange={e => setTableFilter(e.target.value)}
                                            placeholder="문서 검색..."
                                            className="w-48 pl-8 pr-7 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 bg-white"
                                        />
                                        {tableFilter && (
                                            <button onClick={() => setTableFilter('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                                                <X className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                )}
                                {selectedProject && filteredDocs.length > 0 && (
                                    <button onClick={handleExcelDownload} className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-green-300 text-green-700 rounded-lg hover:bg-green-50 transition" title="엑셀 다운로드">
                                        <Download className="w-3.5 h-3.5" /> Excel
                                    </button>
                                )}
                                <span className="text-xs text-slate-400">{filteredDocs.length}건</span>
                            </div>

                            {/* Table */}
                            <div className="flex-1 overflow-auto">
                                {!selectedProject ? (
                                    <div className="flex items-center justify-center h-full text-slate-400">
                                        <div className="text-center">
                                            <ClipboardCheck className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                                            <p className="font-medium">프로젝트를 선택하세요</p>
                                            <p className="text-sm mt-1">왼쪽 패널에서 프로젝트를 선택하거나 새로 생성하세요</p>
                                        </div>
                                    </div>
                                ) : loadingProject ? (
                                    <div className="flex items-center justify-center h-full">
                                        <Loader2 className="w-8 h-8 text-cyan-600 animate-spin" />
                                    </div>
                                ) : (
                                    <ResizableTable
                                        docs={filteredDocs}
                                        selectedDocId={selectedDocId}
                                        onSelectDoc={(docId) => { setSelectedDocId(docId); setRevSelection([]); setComparisonResult(null); setEditingRevId(null); }}
                                        onStatusChange={async (docId, newStatus) => {
                                            try {
                                                const headers = await getAuthHeaders();
                                                headers['Content-Type'] = 'application/json';
                                                await fetch(getRevisionApiUrl('update-document'), {
                                                    method: 'PUT', headers,
                                                    body: JSON.stringify({ project_id: selectedProject, doc_id: docId, status: newStatus }),
                                                });
                                                loadProjectDetail(selectedProject);
                                            } catch (err) { console.error(err); }
                                        }}
                                        projectData={projectData}
                                    />
                                )}
                            </div>
                        </div>
                    ) : (
                        /* ── AI Search Mode ── */
                        <div className="flex-1 flex flex-col overflow-hidden">
                            {/* Mode toggle */}
                            <div className="px-4 py-2 flex gap-2 bg-slate-50 border-b border-slate-200 shrink-0">
                                <button onClick={() => setMode('search')} className={`px-3 py-1.5 text-sm rounded-lg transition flex items-center gap-1 ${mode === 'search' ? 'bg-cyan-600 text-white' : 'bg-white text-slate-600 border border-slate-300'}`}>
                                    <SearchIcon className="w-3.5 h-3.5" /> 검색
                                </button>
                                <button onClick={() => setMode('chat')} className={`px-3 py-1.5 text-sm rounded-lg transition flex items-center gap-1 ${mode === 'chat' ? 'bg-cyan-600 text-white' : 'bg-white text-slate-600 border border-slate-300'}`}>
                                    <MessageSquare className="w-3.5 h-3.5" /> 채팅
                                </button>
                            </div>

                            {/* Results / Chat area */}
                            <div className="flex-1 overflow-y-auto p-4">
                                {mode === 'search' ? (
                                    searchResults.length > 0 ? (
                                        <div className="space-y-3">
                                            {searchResults.map((r, i) => (
                                                <div key={i} className="bg-white border border-slate-200 rounded-lg p-4 hover:shadow-sm transition">
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <span className="text-xs font-mono text-cyan-600">{r.doc_no}</span>
                                                        <span className="text-xs text-slate-400">{r.phase_name}</span>
                                                        <span className="text-xs text-slate-400">Rev.{r.revision}</span>
                                                        {r.page_number > 0 && (
                                                            <span className="text-xs bg-cyan-50 text-cyan-600 px-1.5 py-0.5 rounded">p.{r.page_number}{r.total_pages ? `/${r.total_pages}` : ''}</span>
                                                        )}
                                                    </div>
                                                    <h4 className="font-medium text-slate-800 mb-1">{r.title}</h4>
                                                    <p className="text-sm text-slate-500" dangerouslySetInnerHTML={{ __html: r.highlight || r.content_preview || '' }} />
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-center text-slate-400 mt-12">
                                            <SearchIcon className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                                            <p>검색어를 입력하세요</p>
                                        </div>
                                    )
                                ) : (
                                    <div className="space-y-4">
                                        {chatMessages.map((msg, i) => (
                                            <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                                                {msg.role === 'assistant' && (
                                                    <div className="w-8 h-8 rounded-full bg-cyan-100 flex items-center justify-center shrink-0">
                                                        <Bot className="w-4 h-4 text-cyan-600" />
                                                    </div>
                                                )}
                                                <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${msg.role === 'user' ? 'bg-cyan-600 text-white' : 'bg-white border border-slate-200'}`}>
                                                    {msg.role === 'assistant' ? (
                                                        <ReactMarkdown remarkPlugins={[remarkGfm]} className="prose prose-sm max-w-none prose-slate">
                                                            {msg.content}
                                                        </ReactMarkdown>
                                                    ) : msg.content}
                                                </div>
                                                {msg.role === 'user' && (
                                                    <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center shrink-0">
                                                        <User className="w-4 h-4 text-slate-600" />
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                        {isChatLoading && (
                                            <div className="flex gap-3">
                                                <div className="w-8 h-8 rounded-full bg-cyan-100 flex items-center justify-center shrink-0">
                                                    <Bot className="w-4 h-4 text-cyan-600" />
                                                </div>
                                                <div className="bg-white border border-slate-200 rounded-2xl px-4 py-3">
                                                    <Loader2 className="w-4 h-4 text-cyan-600 animate-spin" />
                                                </div>
                                            </div>
                                        )}
                                        <div ref={messagesEndRef} />
                                    </div>
                                )}
                            </div>

                            {/* Search/Chat input */}
                            <div className="p-4 border-t border-slate-200 bg-white shrink-0">
                                <div className="flex gap-2">
                                    <input
                                        type="text" value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mode === 'chat' ? handleChat() : handleSearch(); } }}
                                        placeholder={mode === 'chat' ? '질문을 입력하세요...' : '검색어를 입력하세요...'}
                                        className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                                    />
                                    <button
                                        onClick={mode === 'chat' ? handleChat : handleSearch}
                                        disabled={isSearching || isChatLoading}
                                        className="px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 disabled:opacity-50 transition"
                                    >
                                        {isSearching || isChatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : mode === 'chat' ? <Send className="w-4 h-4" /> : <SearchIcon className="w-4 h-4" />}
                                    </button>
                                </div>
                                {mode === 'search' && (
                                    <div className="flex items-center mt-1.5 ml-1">
                                        <button
                                            onClick={() => setExactMatch(!exactMatch)}
                                            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${exactMatch ? 'bg-cyan-600' : 'bg-gray-300'}`}
                                        >
                                            <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${exactMatch ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                                        </button>
                                        <span className={`ml-1.5 text-xs ${exactMatch ? 'text-cyan-600 font-medium' : 'text-gray-400'}`}>
                                            원문 검색
                                        </span>
                                        <span className="ml-1 text-[10px] text-gray-300">
                                            {exactMatch ? '입력한 키워드가 포함된 문서만 표시' : 'AI 번역·유사어 포함'}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Right resize handle */}
                <div onMouseDown={startRightResize} className="w-1 cursor-col-resize bg-slate-200 hover:bg-cyan-400 transition shrink-0" />

                {/* ═══ RIGHT PANEL ═══ */}
                <div style={{ width: rightWidth }} className="bg-white border-l border-slate-200 flex flex-col shrink-0 overflow-hidden">
                    {selectedDoc ? (
                        <>
                            {/* Doc Header */}
                            <div className="p-4 border-b border-slate-200">
                                <div className="flex items-start justify-between">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-mono text-cyan-600 mb-1">{selectedDoc.doc_no || 'No Doc No.'}</p>
                                        <h3 className="font-bold text-slate-800 text-lg leading-tight">{selectedDoc.title}</h3>
                                        {selectedDoc.tag_no && (
                                            <p className="text-sm text-slate-500 mt-1">Tag: {selectedDoc.tag_no}</p>
                                        )}
                                    </div>
                                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium shrink-0 ml-2 ${(STATUS_CONFIG[selectedDoc.status] || STATUS_CONFIG.not_started).color}`}>
                                        {(STATUS_CONFIG[selectedDoc.status] || STATUS_CONFIG.not_started).label}
                                    </span>
                                </div>
                                <div className="mt-3 flex gap-2">
                                    <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                                        {PHASES[selectedDoc.phase]?.name_ko || selectedDoc.phase}
                                    </span>
                                    <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                                        Latest: {selectedDoc.latest_revision || '-'}
                                    </span>
                                </div>
                            </div>

                            {/* Revision Timeline */}
                            <div className="flex-1 overflow-y-auto p-4">
                                <div className="flex items-center justify-between mb-3">
                                    <h4 className="text-sm font-semibold text-slate-700">리비전 이력</h4>
                                    <button onClick={() => { setShowRegisterRev(true); setUploadProgress(''); setRevFormData({ revision: '', change_description: '' }); }} className="text-xs text-cyan-600 hover:text-cyan-800 flex items-center gap-1">
                                        <Plus className="w-3 h-3" /> 등록
                                    </button>
                                </div>

                                {/* Revision Action Bar */}
                                {revisionHistory?.revisions?.length > 0 && (
                                    <div className="mb-3 p-2 bg-slate-50 rounded-lg border border-slate-200">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                            <span className="text-xs text-slate-500 mr-1">
                                                {revSelection.length === 0 ? '리비전 선택' : `${revSelection.length}개 선택`}
                                            </span>
                                            {revSelection.length > 0 && (
                                                <button onClick={() => { setRevSelection([]); setComparisonResult(null); setReindexResult(null); }}
                                                    className="text-xs text-slate-400 hover:text-slate-600 px-1.5 py-0.5 rounded hover:bg-slate-200">초기화</button>
                                            )}
                                            <div className="flex-1" />
                                            <button onClick={handleReindexRevisions}
                                                disabled={revSelection.length === 0 || isReindexing}
                                                className="text-xs px-2 py-1 border border-orange-300 text-orange-600 rounded-md hover:bg-orange-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                                            >
                                                {isReindexing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCcw className="w-3 h-3" />}
                                                리인덱싱
                                            </button>
                                            <button onClick={handleDeleteRevisions}
                                                disabled={revSelection.length === 0}
                                                className="text-xs px-2 py-1 border border-red-300 text-red-600 rounded-md hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                                            >
                                                <Trash2 className="w-3 h-3" /> 삭제
                                            </button>
                                            <button onClick={handleCompareRevisions}
                                                disabled={revSelection.length !== 2 || isComparing}
                                                className="text-xs px-2 py-1 bg-cyan-600 text-white rounded-md hover:bg-cyan-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                                            >
                                                {isComparing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Bot className="w-3 h-3" />}
                                                AI 비교
                                            </button>
                                        </div>
                                        {reindexResult && (
                                            <div className="mt-2 text-xs text-green-700 bg-green-50 rounded p-1.5 flex items-center gap-1">
                                                <CheckCircle2 className="w-3 h-3" />
                                                리인덱싱 완료: {reindexResult.success}건 성공, {reindexResult.total_pages_indexed}p 인덱싱
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* AI Comparison Result */}
                                {comparisonResult && (
                                    <div className="mb-3 p-3 bg-gradient-to-br from-cyan-50 to-blue-50 border border-cyan-200 rounded-lg">
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-xs font-semibold text-cyan-700">
                                                AI 비교 분석: {comparisonResult.rev_a} vs {comparisonResult.rev_b}
                                            </span>
                                            <div className="flex items-center gap-1">
                                                <button onClick={() => handleCopy(comparisonResult.comparison, 'ai-compare')}
                                                    className="text-slate-400 hover:text-cyan-600 transition" title="복사">
                                                    {copiedId === 'ai-compare' ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                                                </button>
                                                <button onClick={() => setComparisonResult(null)} className="text-slate-400 hover:text-slate-600"><X className="w-3.5 h-3.5" /></button>
                                            </div>
                                        </div>
                                        <div className="revision-compare-result text-xs text-slate-700 max-w-none overflow-auto max-h-[60vh]">
                                            <ReactMarkdown
                                                remarkPlugins={[remarkGfm]}
                                                components={{
                                                    table: ({ children }) => (
                                                        <div className="overflow-x-auto my-2">
                                                            <table className="w-full border-collapse border border-slate-300 text-xs">{children}</table>
                                                        </div>
                                                    ),
                                                    thead: ({ children }) => <thead className="bg-slate-100">{children}</thead>,
                                                    th: ({ children }) => <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold text-slate-700 whitespace-nowrap">{children}</th>,
                                                    td: ({ children }) => <td className="border border-slate-300 px-2 py-1.5 text-slate-600">{children}</td>,
                                                    h1: ({ children }) => <h3 className="text-sm font-bold text-slate-800 mt-3 mb-1">{children}</h3>,
                                                    h2: ({ children }) => <h4 className="text-sm font-bold text-slate-800 mt-3 mb-1">{children}</h4>,
                                                    h3: ({ children }) => <h5 className="text-xs font-bold text-slate-700 mt-2 mb-1">{children}</h5>,
                                                    p: ({ children }) => <p className="mb-1.5 leading-relaxed">{children}</p>,
                                                    ul: ({ children }) => <ul className="list-disc list-inside mb-1.5 space-y-0.5">{children}</ul>,
                                                    ol: ({ children }) => <ol className="list-decimal list-inside mb-1.5 space-y-0.5">{children}</ol>,
                                                    strong: ({ children }) => <strong className="font-semibold text-slate-800">{children}</strong>,
                                                }}
                                            >
                                                {comparisonResult.comparison}
                                            </ReactMarkdown>
                                        </div>
                                    </div>
                                )}

                                {loadingHistory ? (
                                    <div className="flex justify-center py-8">
                                        <Loader2 className="w-6 h-6 text-cyan-600 animate-spin" />
                                    </div>
                                ) : revisionHistory?.revisions?.length > 0 ? (
                                    <div className="relative">
                                        {/* Timeline line */}
                                        <div className="absolute left-[11px] top-2 bottom-2 w-0.5 bg-slate-200" />

                                        <div className="space-y-4">
                                            {[...revisionHistory.revisions].reverse().map((rev, i) => {
                                                const isLatest = i === 0;
                                                const revNum = rev.revision?.toUpperCase().replace('REV.', '').replace('REV ', '').trim();
                                                const isApproved = /^\d+$/.test(revNum);
                                                const isEditing = editingRevId === rev.revision_id;
                                                const isSelected = revSelection.includes(rev.revision_id);
                                                return (
                                                    <div key={rev.revision_id} className="relative pl-8">
                                                        {/* Selection circle */}
                                                        <button
                                                            onClick={() => toggleRevSelection(rev.revision_id)}
                                                            className={`absolute left-0 top-1 w-6 h-6 rounded-full flex items-center justify-center transition-colors ${isSelected ? 'bg-cyan-600 ring-2 ring-cyan-300' : isLatest ? 'bg-cyan-600' : isApproved ? 'bg-green-500' : 'bg-slate-300'} hover:ring-2 hover:ring-cyan-200`}
                                                            title="선택"
                                                        >
                                                            {isSelected ? <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                                                                : isApproved ? <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                                                                : <Clock className="w-3.5 h-3.5 text-white" />}
                                                        </button>
                                                        <div className={`bg-white border rounded-lg p-3 ${isSelected ? 'border-cyan-400 shadow-md ring-1 ring-cyan-200' : isLatest ? 'border-cyan-200 shadow-sm' : 'border-slate-200'}`}>
                                                            {isEditing ? (
                                                                /* Edit mode */
                                                                <div className="space-y-2">
                                                                    <div>
                                                                        <label className="text-xs text-slate-500">리비전 번호</label>
                                                                        <input value={editRevData.revision || ''} onChange={e => setEditRevData(p => ({ ...p, revision: e.target.value }))}
                                                                            className="w-full border border-slate-300 rounded px-2 py-1 text-sm font-mono focus:ring-1 focus:ring-cyan-500" />
                                                                    </div>
                                                                    <div>
                                                                        <label className="text-xs text-slate-500">변경 내용</label>
                                                                        <textarea value={editRevData.change_description || ''} onChange={e => setEditRevData(p => ({ ...p, change_description: e.target.value }))}
                                                                            rows={2} className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-cyan-500" />
                                                                    </div>
                                                                    <div>
                                                                        <label className="text-xs text-slate-500">담당자</label>
                                                                        <input value={editRevData.engineer_name || ''} onChange={e => setEditRevData(p => ({ ...p, engineer_name: e.target.value }))}
                                                                            className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:ring-1 focus:ring-cyan-500" />
                                                                    </div>
                                                                    <div className="flex gap-2">
                                                                        <button onClick={handleUpdateRevision} className="px-3 py-1 text-xs bg-cyan-600 text-white rounded hover:bg-cyan-700">저장</button>
                                                                        <button onClick={() => setEditingRevId(null)} className="px-3 py-1 text-xs border border-slate-300 text-slate-600 rounded hover:bg-slate-100">취소</button>
                                                                    </div>
                                                                </div>
                                                            ) : (
                                                                /* View mode */
                                                                <>
                                                                    <div className="flex items-center justify-between mb-1">
                                                                        <span className="font-mono font-bold text-sm text-slate-800">{rev.revision}</span>
                                                                        <div className="flex items-center gap-2">
                                                                            <span className="text-xs text-slate-400">{rev.date}</span>
                                                                            <button onClick={() => handleCopy(
                                                                                `${rev.revision} (${rev.date})\n${rev.change_description || ''}\n담당: ${rev.engineer_name || '-'}`.trim(),
                                                                                `rev-${rev.revision_id}`
                                                                            )} className="text-slate-300 hover:text-cyan-600 transition" title="복사">
                                                                                {copiedId === `rev-${rev.revision_id}` ? <CheckCircle2 className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                                                                            </button>
                                                                            <button onClick={() => { setEditingRevId(rev.revision_id); setEditRevData({ revision: rev.revision, change_description: rev.change_description || '', engineer_name: rev.engineer_name || '' }); }}
                                                                                className="text-slate-300 hover:text-cyan-600 transition" title="수정">
                                                                                <Edit3 className="w-3 h-3" />
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                    {rev.change_description && (
                                                                        <p className="text-xs text-slate-600 mb-1">{rev.change_description}</p>
                                                                    )}
                                                                    <div className="flex items-center justify-between">
                                                                        <div className="flex items-center gap-2">
                                                                            <span className="text-xs text-slate-400">{rev.engineer_name || '-'}</span>
                                                                            {rev.total_pages > 0 ? (
                                                                                <span className="text-xs bg-green-50 text-green-600 px-1.5 py-0.5 rounded flex items-center gap-1">
                                                                                    <CheckCircle2 className="w-2.5 h-2.5" />{rev.total_pages}p
                                                                                </span>
                                                                            ) : rev.blob_path ? (
                                                                                <span className="text-xs bg-orange-50 text-orange-500 px-1.5 py-0.5 rounded flex items-center gap-1">
                                                                                    <AlertCircle className="w-2.5 h-2.5" />미인덱싱
                                                                                </span>
                                                                            ) : null}
                                                                        </div>
                                                                        {rev.download_url && (
                                                                            <a href={rev.download_url} target="_blank" rel="noreferrer"
                                                                                className="text-xs text-cyan-600 hover:text-cyan-800 flex items-center gap-1">
                                                                                <Download className="w-3 h-3" /> 다운로드
                                                                            </a>
                                                                        )}
                                                                    </div>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="text-center text-slate-400 py-8">
                                        <FileText className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                                        <p className="text-sm">등록된 리비전이 없습니다</p>
                                        <button onClick={() => { setShowRegisterRev(true); setUploadProgress(''); setRevFormData({ revision: '', change_description: '' }); }} className="mt-3 text-sm text-cyan-600 hover:text-cyan-800">
                                            첫 리비전 등록하기
                                        </button>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="flex items-center justify-center h-full text-slate-400">
                            <div className="text-center px-6">
                                <FileText className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                                <p className="font-medium">문서를 선택하세요</p>
                                <p className="text-sm mt-1">테이블에서 문서를 클릭하면<br />상세 정보가 표시됩니다</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* ═══ MODALS ═══ */}

            {/* Upload Spec Modal */}
            {showUploadSpec && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl w-[480px] max-h-[90vh] overflow-y-auto">
                        <div className="flex items-center justify-between p-5 border-b border-slate-200">
                            <h3 className="font-bold text-lg text-slate-800">새 프로젝트 생성</h3>
                            <button onClick={() => setShowUploadSpec(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
                        </div>
                        <form onSubmit={handleUploadSpec} className="p-5 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">프로젝트명 *</label>
                                <input name="project_name" required className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" placeholder="예: ABC Plant 준공도서" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">프로젝트 코드</label>
                                <input name="project_code" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" placeholder="예: ABC-2025" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">사양서 (Specification PDF) *</label>
                                <input ref={specFileRef} type="file" accept=".pdf" required className="w-full text-sm file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-cyan-50 file:text-cyan-700 file:font-medium file:cursor-pointer" />
                                <p className="text-xs text-slate-400 mt-1">사양서에서 필요 문서 목록을 자동 추출합니다</p>
                            </div>
                            {uploadProgress && (
                                <div className="flex items-center gap-2 text-sm">
                                    {isUploading && <Loader2 className="w-4 h-4 animate-spin text-cyan-600" />}
                                    <span className={isUploading ? 'text-cyan-600' : uploadProgress.startsWith('오류') ? 'text-red-600' : 'text-green-600'}>{uploadProgress}</span>
                                </div>
                            )}
                            <button type="submit" disabled={isUploading} className="w-full py-2.5 bg-cyan-600 text-white rounded-lg font-medium hover:bg-cyan-700 disabled:opacity-50 transition">
                                {isUploading ? '처리 중...' : '프로젝트 생성'}
                            </button>
                        </form>
                    </div>
                </div>
            )}

            {/* Add Document Modal */}
            {showAddDoc && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl w-[440px]">
                        <div className="flex items-center justify-between p-5 border-b border-slate-200">
                            <h3 className="font-bold text-lg text-slate-800">문서 추가</h3>
                            <button onClick={() => setShowAddDoc(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
                        </div>
                        <form onSubmit={handleAddDocument} className="p-5 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">문서번호</label>
                                <input name="doc_no" placeholder="비워두면 자동 채번됩니다" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                                <p className="text-xs text-slate-400 mt-1">예: GMTP-CMS-RPT-001 (비워두면 제목 기반 자동 생성)</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">태그번호</label>
                                <input name="tag_no" placeholder="장비 태그 (예: P-1001A)" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                                <p className="text-xs text-slate-400 mt-1">장비별 시험/성적서에만 해당. 일반 문서는 비워두세요.</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">제목 *</label>
                                <input name="title" required className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Phase</label>
                                <select name="phase" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500">
                                    {Object.entries(PHASES).map(([k, v]) => <option key={k} value={k}>{v.name_ko} ({v.name})</option>)}
                                </select>
                            </div>
                            <button type="submit" className="w-full py-2.5 bg-cyan-600 text-white rounded-lg font-medium hover:bg-cyan-700 transition">추가</button>
                        </form>
                    </div>
                </div>
            )}

            {/* Register Revision Modal */}
            {showRegisterRev && selectedDoc && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl w-[480px]">
                        <div className="flex items-center justify-between p-5 border-b border-slate-200">
                            <div>
                                <h3 className="font-bold text-lg text-slate-800">리비전 등록</h3>
                                <p className="text-sm text-slate-500 mt-0.5">{selectedDoc.doc_no} - {selectedDoc.title}</p>
                            </div>
                            <button onClick={() => { setShowRegisterRev(false); setUploadProgress(''); }} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
                        </div>
                        <form onSubmit={handleRegisterRevision} className="p-5 space-y-4">
                            {/* Step 1: File first */}
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">1. 파일 선택 (PDF) *</label>
                                <input ref={revFileRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx" required
                                    onChange={handleRevFileChange}
                                    className="w-full text-sm file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-cyan-50 file:text-cyan-700 file:font-medium file:cursor-pointer" />
                                <p className="text-xs text-slate-400 mt-1">파일을 선택하면 AI가 리비전 번호와 변경내용을 자동 추출합니다</p>
                            </div>
                            {/* Analysis progress */}
                            {isAnalyzing && (
                                <div className="flex items-center gap-2 text-sm p-3 bg-blue-50 rounded-lg text-blue-600">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    <span>AI가 문서를 분석 중입니다...</span>
                                </div>
                            )}
                            {/* Step 2: Auto-filled fields */}
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">2. 리비전 번호 *</label>
                                <input name="revision" required placeholder="예: Rev.A, Rev.0, Rev.1"
                                    value={revFormData.revision}
                                    onChange={e => setRevFormData(p => ({ ...p, revision: e.target.value }))}
                                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                                <p className="text-xs text-slate-400 mt-1">Rev.A = 초안 | Rev.0 = 정식 승인 | Rev.1+ = 수정</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">3. 변경 내용</label>
                                <textarea name="change_description" rows={2} placeholder="변경 사유 또는 설명"
                                    value={revFormData.change_description}
                                    onChange={e => setRevFormData(p => ({ ...p, change_description: e.target.value }))}
                                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">담당자</label>
                                <input name="engineer_name" defaultValue={username} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                            </div>
                            {uploadProgress && !isAnalyzing && (
                                <div className={`flex items-center gap-2 text-sm p-3 rounded-lg ${uploadProgress.includes('오류') || uploadProgress.includes('실패') ? 'bg-red-50 text-red-600' : uploadProgress.includes('완료') || uploadProgress.includes('추출') || uploadProgress.includes('제안') ? 'bg-green-50 text-green-600' : 'bg-blue-50 text-blue-600'}`}>
                                    {isUploading && <Loader2 className="w-4 h-4 animate-spin" />}
                                    <span>{uploadProgress}</span>
                                </div>
                            )}
                            <button type="submit" disabled={isUploading || isAnalyzing} className="w-full py-2.5 bg-teal-600 text-white rounded-lg font-medium hover:bg-teal-700 disabled:opacity-50 transition">
                                {isUploading ? '등록 중...' : isAnalyzing ? '분석 중...' : '리비전 등록'}
                            </button>
                        </form>
                    </div>
                </div>
            )}

            {/* Edit Project Modal */}
            {showEditProject && projectData && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl w-[440px]">
                        <div className="flex items-center justify-between p-5 border-b border-slate-200">
                            <h3 className="font-bold text-lg text-slate-800">프로젝트 정보 수정</h3>
                            <button onClick={() => setShowEditProject(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
                        </div>
                        <form onSubmit={handleUpdateProject} className="p-5 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">프로젝트명 *</label>
                                <input name="project_name" defaultValue={projectData.project_name} required className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">프로젝트 코드</label>
                                <input name="project_code" defaultValue={projectData.project_code} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                            </div>
                            <div className="bg-slate-50 rounded-lg p-3">
                                <p className="text-xs text-slate-500">
                                    <span className="font-medium">Project ID:</span> {projectData.project_id}
                                </p>
                                <p className="text-xs text-slate-400 mt-1">
                                    Blob 경로는 UUID 기반이므로 이름/코드 변경 시 파일 이동이 필요 없습니다.
                                </p>
                            </div>
                            <button type="submit" className="w-full py-2.5 bg-cyan-600 text-white rounded-lg font-medium hover:bg-cyan-700 transition">저장</button>
                        </form>
                    </div>
                </div>
            )}

            {/* Edit Document Modal */}
            {showEditDoc && selectedDoc && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl w-[440px]">
                        <div className="flex items-center justify-between p-5 border-b border-slate-200">
                            <h3 className="font-bold text-lg text-slate-800">문서 정보 수정</h3>
                            <button onClick={() => setShowEditDoc(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
                        </div>
                        <form onSubmit={handleUpdateDocument} className="p-5 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">문서번호</label>
                                <input name="doc_no" defaultValue={selectedDoc.doc_no} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">태그번호</label>
                                <input name="tag_no" defaultValue={selectedDoc.tag_no} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">제목 *</label>
                                <input name="title" defaultValue={selectedDoc.title} required className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Phase</label>
                                <select name="phase" defaultValue={selectedDoc.phase} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500">
                                    {Object.entries(PHASES).map(([k, v]) => <option key={k} value={k}>{v.name_ko} ({v.name})</option>)}
                                </select>
                            </div>
                            <button type="submit" className="w-full py-2.5 bg-cyan-600 text-white rounded-lg font-medium hover:bg-cyan-700 transition">저장</button>
                        </form>
                    </div>
                </div>
            )}

            {/* Re-analyze Spec Modal */}
            {showReanalyze && selectedProject && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl w-[480px]">
                        <div className="flex items-center justify-between p-5 border-b border-slate-200">
                            <div>
                                <h3 className="font-bold text-lg text-slate-800">사양서 재분석</h3>
                                <p className="text-sm text-slate-500 mt-0.5">기존 문서를 유지하면서 문서번호를 자동 채번합니다</p>
                            </div>
                            <button onClick={() => { setShowReanalyze(false); setUploadProgress(''); }} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
                        </div>
                        <form onSubmit={handleReanalyzeSpec} className="p-5 space-y-4">
                            <div className="bg-cyan-50 rounded-lg p-3 border border-cyan-200">
                                <p className="text-sm text-cyan-800 font-medium">병합 방식</p>
                                <ul className="text-xs text-cyan-700 mt-1 space-y-0.5 list-disc list-inside">
                                    <li>기존 문서의 리비전 이력은 모두 보존됩니다</li>
                                    <li>빈 문서번호만 자동 채번됩니다</li>
                                    <li>사양서에서 새로 발견된 문서가 추가됩니다</li>
                                </ul>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">사양서 PDF (선택)</label>
                                <input ref={reanalyzeFileRef} type="file" accept=".pdf" className="w-full text-sm file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-cyan-50 file:text-cyan-700 file:font-medium file:cursor-pointer" />
                                <p className="text-xs text-slate-400 mt-1">새 사양서를 업로드하거나, 비워두면 기존 사양서로 재분석합니다</p>
                            </div>
                            {uploadProgress && (
                                <div className={`text-sm p-3 rounded-lg ${uploadProgress.startsWith('오류') ? 'bg-red-50 text-red-600' : uploadProgress.startsWith('완료') ? 'bg-green-50 text-green-600' : 'bg-blue-50 text-blue-600'}`}>
                                    {!uploadProgress.startsWith('오류') && !uploadProgress.startsWith('완료') && <Loader2 className="w-4 h-4 animate-spin inline mr-2" />}
                                    {uploadProgress}
                                </div>
                            )}
                            <button type="submit" disabled={isUploading} className="w-full py-2.5 bg-cyan-600 text-white rounded-lg font-medium hover:bg-cyan-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                                {isUploading ? <><Loader2 className="w-4 h-4 animate-spin" /> 분석 중...</> : <><RefreshCcw className="w-4 h-4" /> 재분석 시작</>}
                            </button>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};

export default RevisionMaster;
