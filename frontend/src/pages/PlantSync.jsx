import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Layers, Plus, Upload, Search, Filter, ChevronDown, ChevronRight,
  ArrowLeft, X, Send, Check, CheckCircle2, XCircle, Clock, AlertTriangle,
  FileText, MapPin, MessageSquare, ClipboardList, BarChart3, Trash2,
  RotateCcw, Eye, Pencil, Shield, Loader2
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { auth } from '../firebase';
import PDFViewer from '../components/PDFViewer';

const API_BASE = (import.meta.env.VITE_API_URL || 'https://drawing-detector-backend-435353955407.us-central1.run.app').replace(/\/$/, '');
const getUrl = (path) => `${API_BASE}/api/v1/plantsync/${path}`;

const getToken = async () => {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');
  return user.getIdToken();
};

const DISCIPLINES = {
  process:     { label: '공정',    color: '#ef4444', bg: 'bg-red-500/20',    text: 'text-red-400' },
  mechanical:  { label: '기계',    color: '#3b82f6', bg: 'bg-blue-500/20',   text: 'text-blue-400' },
  piping:      { label: '배관',    color: '#22c55e', bg: 'bg-green-500/20',  text: 'text-green-400' },
  electrical:  { label: '전기',    color: '#eab308', bg: 'bg-yellow-500/20', text: 'text-yellow-400' },
  instrument:  { label: '계장',    color: '#a855f7', bg: 'bg-purple-500/20', text: 'text-purple-400' },
  civil:       { label: '토목',    color: '#f97316', bg: 'bg-orange-500/20', text: 'text-orange-400' },
};

const REVIEW_STATUSES = {
  not_started: { label: '미시작',   icon: Clock,          color: 'text-slate-400' },
  in_progress: { label: '진행중',   icon: Loader2,        color: 'text-blue-400' },
  completed:   { label: '완료',     icon: CheckCircle2,   color: 'text-green-400' },
  rejected:    { label: '반려',     icon: XCircle,         color: 'text-red-400' },
};

const PlantSync = () => {
  const { currentUser } = useAuth();

  // ── State ──
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [projectDetail, setProjectDetail] = useState(null);
  const [selectedDrawing, setSelectedDrawing] = useState(null);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [markups, setMarkups] = useState([]);
  const [selectedMarkup, setSelectedMarkup] = useState(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [currentPage, setCurrentPage] = useState(1);

  // UI states
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [disciplineFilter, setDisciplineFilter] = useState('all');
  const [isPlacingPin, setIsPlacingPin] = useState(false);
  const [pinDiscipline, setPinDiscipline] = useState('process');
  const [rightTab, setRightTab] = useState('markups'); // 'markups' | 'collab' | 'review' | 'dashboard'
  const [showTitleBlockModal, setShowTitleBlockModal] = useState(false);
  const [titleBlockData, setTitleBlockData] = useState(null);
  const [pendingDrawingId, setPendingDrawingId] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [newComment, setNewComment] = useState('');
  const [dashboard, setDashboard] = useState(null);
  const [editingDrawing, setEditingDrawing] = useState(null);
  const [editForm, setEditForm] = useState({ drawing_number: '', title: '', revision: '', discipline: '' });

  // Collaboration
  const [reviewRequests, setReviewRequests] = useState([]);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [showNewRequest, setShowNewRequest] = useState(false);
  const [requestForm, setRequestForm] = useState({ to_name: '', discipline: 'process', title: '', message: '', priority: 'normal' });
  const [requestReplyText, setRequestReplyText] = useState('');

  const fileInputRef = useRef(null);

  // ── API Calls ──

  const loadProjects = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch(getUrl('projects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (e) {
      console.error('Load projects error:', e);
    }
  }, []);

  const loadProjectDetail = useCallback(async (projectId) => {
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${projectId}`), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setProjectDetail(data.project);
    } catch (e) {
      console.error('Load detail error:', e);
    }
  }, []);

  const loadPdfUrl = useCallback(async (projectId, drawingId) => {
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${projectId}/drawings/${drawingId}/pdf-url`), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setPdfUrl(data.pdf_url);
    } catch (e) {
      console.error('Load PDF URL error:', e);
    }
  }, []);

  const loadMarkups = useCallback(async (projectId, drawingId) => {
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${projectId}/drawings/${drawingId}/markups`), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setMarkups(data.markups || []);
    } catch (e) {
      console.error('Load markups error:', e);
    }
  }, []);

  const loadDashboard = useCallback(async (projectId) => {
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${projectId}/dashboard`), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setDashboard(data.dashboard);
    } catch (e) {
      console.error('Load dashboard error:', e);
    }
  }, []);

  const loadReviewRequests = useCallback(async (projectId, drawingId) => {
    try {
      const token = await getToken();
      const url = drawingId
        ? getUrl(`projects/${projectId}/requests?drawing_id=${drawingId}`)
        : getUrl(`projects/${projectId}/requests`);
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setReviewRequests(data.requests || []);
    } catch (e) {
      console.error('Load requests error:', e);
    }
  }, []);

  // ── Effects ──

  useEffect(() => { loadProjects(); }, [loadProjects]);

  useEffect(() => {
    if (selectedProject) {
      loadProjectDetail(selectedProject.project_id);
      loadDashboard(selectedProject.project_id);
      loadReviewRequests(selectedProject.project_id);
    }
  }, [selectedProject, loadProjectDetail, loadDashboard, loadReviewRequests]);

  useEffect(() => {
    if (selectedProject && selectedDrawing) {
      loadPdfUrl(selectedProject.project_id, selectedDrawing.drawing_id);
      loadMarkups(selectedProject.project_id, selectedDrawing.drawing_id);
      loadReviewRequests(selectedProject.project_id, selectedDrawing.drawing_id);
    }
  }, [selectedProject, selectedDrawing, loadPdfUrl, loadMarkups, loadReviewRequests]);

  // ── Handlers ──

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    try {
      const token = await getToken();
      const res = await fetch(getUrl('projects'), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: newProjectName.trim() }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setNewProjectName('');
      setShowNewProject(false);
      await loadProjects();
      setSelectedProject(data.project);
    } catch (e) {
      console.error('Create project error:', e);
    }
  };

  const handleDeleteProject = async (projectId) => {
    if (!window.confirm('이 프로젝트와 모든 도면을 삭제하시겠습니까?')) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${projectId}`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      setSelectedProject(null);
      setProjectDetail(null);
      setSelectedDrawing(null);
      setPdfUrl(null);
      await loadProjects();
    } catch (e) {
      console.error('Delete error:', e);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !selectedProject) return;
    setUploading(true);
    try {
      const token = await getToken();
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(getUrl(`projects/${selectedProject.project_id}/upload`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();

      // Show title block confirmation modal
      setTitleBlockData(data.title_block);
      setPendingDrawingId(data.drawing?.drawing_id);
      setShowTitleBlockModal(true);

      await loadProjectDetail(selectedProject.project_id);
    } catch (e) {
      console.error('Upload error:', e);
      alert('Upload failed: ' + e.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleConfirmTitleBlock = async () => {
    if (!selectedProject || !pendingDrawingId || !titleBlockData) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${pendingDrawingId}/title-block`), {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(titleBlockData),
      });
      setShowTitleBlockModal(false);
      await loadProjectDetail(selectedProject.project_id);
    } catch (e) {
      console.error('Confirm title block error:', e);
    }
  };

  const handlePinPlace = (e) => {
    if (!isPlacingPin || !canvasSize.width || !canvasSize.height) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // Use rect.width/height (CSS-scaled actual size) instead of canvasSize (unscaled)
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    // Store coords, show comment input
    setNewComment('');
    setSelectedMarkup({ _pending: true, x, y, page: currentPage, discipline: pinDiscipline });
  };

  const handleSaveNewMarkup = async () => {
    if (!selectedMarkup?._pending || !newComment.trim() || !selectedProject || !selectedDrawing) return;
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${selectedDrawing.drawing_id}/markups`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: selectedMarkup.page,
          x: selectedMarkup.x,
          y: selectedMarkup.y,
          discipline: selectedMarkup.discipline,
          comment: newComment.trim(),
        }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setSelectedMarkup(data.markup);
      setIsPlacingPin(false);
      setNewComment('');
      await loadMarkups(selectedProject.project_id, selectedDrawing.drawing_id);
    } catch (e) {
      console.error('Save markup error:', e);
    }
  };

  const handleResolveMarkup = async (markupId) => {
    if (!selectedProject || !selectedDrawing) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${selectedDrawing.drawing_id}/markups/${markupId}`), {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
      });
      await loadMarkups(selectedProject.project_id, selectedDrawing.drawing_id);
      if (selectedMarkup?.markup_id === markupId) {
        setSelectedMarkup(prev => prev ? { ...prev, status: 'resolved' } : null);
      }
    } catch (e) {
      console.error('Resolve error:', e);
    }
  };

  const handleReopenMarkup = async (markupId) => {
    if (!selectedProject || !selectedDrawing) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${selectedDrawing.drawing_id}/markups/${markupId}`), {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'open' }),
      });
      await loadMarkups(selectedProject.project_id, selectedDrawing.drawing_id);
      if (selectedMarkup?.markup_id === markupId) {
        setSelectedMarkup(prev => prev ? { ...prev, status: 'open' } : null);
      }
    } catch (e) {
      console.error('Reopen error:', e);
    }
  };

  const handleAddReply = async () => {
    if (!replyText.trim() || !selectedMarkup?.markup_id || !selectedProject || !selectedDrawing) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${selectedDrawing.drawing_id}/markups/${selectedMarkup.markup_id}/replies`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: replyText.trim() }),
      });
      setReplyText('');
      await loadMarkups(selectedProject.project_id, selectedDrawing.drawing_id);
      // Update selected markup with new replies
      const updated = markups.find(m => m.markup_id === selectedMarkup.markup_id);
      if (updated) setSelectedMarkup(updated);
    } catch (e) {
      console.error('Reply error:', e);
    }
  };

  const handleUpdateReview = async (discipline, status) => {
    if (!selectedProject || !selectedDrawing) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${selectedDrawing.drawing_id}/review`), {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ discipline, status }),
      });
      await loadProjectDetail(selectedProject.project_id);
    } catch (e) {
      console.error('Review update error:', e);
    }
  };

  const handleApproval = async (decision) => {
    if (!selectedProject || !selectedDrawing) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${selectedDrawing.drawing_id}/approve`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      await loadProjectDetail(selectedProject.project_id);
    } catch (e) {
      console.error('Approval error:', e);
    }
  };

  // ── Collaboration Handlers ──

  const handleCreateRequest = async () => {
    if (!selectedProject || !selectedDrawing || !requestForm.to_name.trim() || !requestForm.title.trim()) return;
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${selectedProject.project_id}/requests`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestForm, drawing_id: selectedDrawing.drawing_id }),
      });
      if (!res.ok) throw new Error('Failed');
      setShowNewRequest(false);
      setRequestForm({ to_name: '', discipline: 'process', title: '', message: '', priority: 'normal' });
      await loadReviewRequests(selectedProject.project_id, selectedDrawing.drawing_id);
    } catch (e) {
      console.error('Create request error:', e);
    }
  };

  const handleUpdateRequestStatus = async (requestId, status) => {
    if (!selectedProject) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/requests/${requestId}`), {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      await loadReviewRequests(selectedProject.project_id, selectedDrawing?.drawing_id);
    } catch (e) {
      console.error('Update request status error:', e);
    }
  };

  const handleAddRequestReply = async () => {
    if (!requestReplyText.trim() || !selectedRequest?.request_id || !selectedProject) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/requests/${selectedRequest.request_id}/replies`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: requestReplyText.trim() }),
      });
      setRequestReplyText('');
      await loadReviewRequests(selectedProject.project_id, selectedDrawing?.drawing_id);
    } catch (e) {
      console.error('Reply request error:', e);
    }
  };

  const handleDeleteRequest = async (requestId) => {
    if (!selectedProject) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/requests/${requestId}`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (selectedRequest?.request_id === requestId) setSelectedRequest(null);
      await loadReviewRequests(selectedProject.project_id, selectedDrawing?.drawing_id);
    } catch (e) {
      console.error('Delete request error:', e);
    }
  };

  const handleEditDrawing = (d, e) => {
    e.stopPropagation();
    setEditingDrawing(d.drawing_id);
    setEditForm({
      drawing_number: d.drawing_number || '',
      title: d.title || '',
      revision: d.current_revision || '',
      discipline: d.discipline || '',
    });
  };

  const handleSaveDrawingEdit = async (drawingId, e) => {
    e.stopPropagation();
    if (!selectedProject) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${drawingId}/title-block`), {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });
      setEditingDrawing(null);
      await loadProjectDetail(selectedProject.project_id);
    } catch (e) {
      console.error('Edit drawing error:', e);
    }
  };

  const handleDeleteDrawing = async (drawingId, e) => {
    e.stopPropagation();
    if (!selectedProject || !window.confirm('이 도면과 모든 리비전을 삭제하시겠습니까?')) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${drawingId}`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (selectedDrawing?.drawing_id === drawingId) {
        setSelectedDrawing(null);
        setPdfUrl(null);
        setMarkups([]);
      }
      await loadProjectDetail(selectedProject.project_id);
    } catch (e) {
      console.error('Delete drawing error:', e);
    }
  };

  // Keep selected markup in sync when markups list updates
  useEffect(() => {
    if (selectedMarkup?.markup_id) {
      const updated = markups.find(m => m.markup_id === selectedMarkup.markup_id);
      if (updated) setSelectedMarkup(updated);
    }
  }, [markups]);

  // Keep selected request in sync
  useEffect(() => {
    if (selectedRequest?.request_id) {
      const updated = reviewRequests.find(r => r.request_id === selectedRequest.request_id);
      if (updated) setSelectedRequest(updated);
    }
  }, [reviewRequests]);

  // ── Filtered Drawings ──
  const drawings = projectDetail?.drawings || [];
  const filteredDrawings = drawings.filter(d => {
    if (disciplineFilter !== 'all' && d.discipline !== disciplineFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (d.drawing_number || '').toLowerCase().includes(q) ||
             (d.title || '').toLowerCase().includes(q);
    }
    return true;
  });

  // Current page markups
  const pageMarkups = markups.filter(m => m.page === currentPage);

  // ── Project Selection Screen ──
  if (!selectedProject) {
    return (
      <div className="h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500/20 to-cyan-500/20 flex items-center justify-center">
              <Layers className="w-5 h-5 text-sky-400" />
            </div>
            <h1 className="text-xl font-bold text-slate-100">도면 리비전 관리</h1>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-8">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl font-bold text-slate-100">프로젝트</h2>
                <p className="text-slate-400 mt-1">프로젝트를 선택하거나 새로 생성하세요</p>
              </div>
              <button
                onClick={() => setShowNewProject(true)}
                className="flex items-center gap-2 px-4 py-2 bg-sky-500 hover:bg-sky-400 text-white rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" /> 새 프로젝트
              </button>
            </div>

            {showNewProject && (
              <div className="mb-6 bg-slate-800/80 border border-slate-700/50 rounded-xl p-4 flex gap-3">
                <input
                  type="text"
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateProject()}
                  placeholder="프로젝트명 입력..."
                  className="flex-1 px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500"
                  autoFocus
                />
                <button onClick={handleCreateProject} className="px-4 py-2 bg-sky-500 hover:bg-sky-400 text-white rounded-lg">생성</button>
                <button onClick={() => setShowNewProject(false)} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg">취소</button>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {projects.map(p => (
                <div
                  key={p.project_id}
                  onClick={() => setSelectedProject(p)}
                  className="group relative cursor-pointer bg-slate-800/80 border border-slate-700/50 rounded-xl p-6 hover:border-sky-500/50 transition-all"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-100 group-hover:text-sky-400 transition-colors">{p.project_name}</h3>
                      {p.project_code && <p className="text-sm text-slate-500 mt-1">{p.project_code}</p>}
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); handleDeleteProject(p.project_id); }}
                      className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex items-center gap-4 mt-4 text-sm text-slate-400">
                    <span className="flex items-center gap-1"><FileText className="w-4 h-4" /> {p.drawing_count}건 도면</span>
                    <span>{new Date(p.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
              {projects.length === 0 && !showNewProject && (
                <div className="col-span-2 text-center py-16 text-slate-500">
                  <Layers className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>프로젝트가 없습니다. 새로 생성해 주세요.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 3-Panel Layout ──
  return (
    <div className="h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex flex-col overflow-hidden">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700/50 bg-slate-900/80 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => { setSelectedProject(null); setProjectDetail(null); setSelectedDrawing(null); setPdfUrl(null); }}
                  className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500/20 to-cyan-500/20 flex items-center justify-center">
            <Layers className="w-4 h-4 text-sky-400" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-100">{selectedProject.project_name}</h1>
            <p className="text-xs text-slate-500">{drawings.length}건 도면</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Pin placement toggle */}
          {selectedDrawing && (
            <div className="flex items-center gap-2 mr-4">
              <select
                value={pinDiscipline}
                onChange={e => setPinDiscipline(e.target.value)}
                className="px-2 py-1 bg-slate-700/50 border border-slate-600 rounded text-xs text-slate-300 focus:outline-none"
              >
                {Object.entries(DISCIPLINES).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
              <button
                onClick={() => setIsPlacingPin(!isPlacingPin)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  isPlacingPin
                    ? 'bg-sky-500 text-white'
                    : 'bg-slate-700/50 text-slate-300 hover:bg-slate-600/50'
                }`}
              >
                <MapPin className="w-3.5 h-3.5" /> {isPlacingPin ? '배치중...' : '핀 추가'}
              </button>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-sky-500 hover:bg-sky-400 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          >
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            {uploading ? '업로드 중...' : 'PDF 업로드'}
          </button>
        </div>
      </div>

      {/* Main 3-Panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel - Drawing List */}
        <div className="w-[280px] border-r border-slate-700/50 flex flex-col flex-shrink-0 bg-slate-900/40">
          {/* Search & Filter */}
          <div className="p-3 border-b border-slate-700/50 space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="도면 검색..."
                className="w-full pl-8 pr-3 py-1.5 bg-slate-800/50 border border-slate-700/50 rounded-lg text-xs text-slate-300 placeholder-slate-500 focus:outline-none focus:border-sky-500/50"
              />
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setDisciplineFilter('all')}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  disciplineFilter === 'all' ? 'bg-sky-500/20 text-sky-400' : 'text-slate-500 hover:text-slate-300'
                }`}
              >전체</button>
              {Object.entries(DISCIPLINES).map(([k, v]) => (
                <button
                  key={k}
                  onClick={() => setDisciplineFilter(k)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    disciplineFilter === k ? `${v.bg} ${v.text}` : 'text-slate-500 hover:text-slate-300'
                  }`}
                  title={v.label}
                >
                  {v.label.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>

          {/* Drawing Items */}
          <div className="flex-1 overflow-auto">
            {filteredDrawings.map(d => (
              <div
                key={d.drawing_id}
                onClick={() => { if (editingDrawing !== d.drawing_id) { setSelectedDrawing(d); setSelectedMarkup(null); setCurrentPage(1); } }}
                className={`group/item px-3 py-2.5 cursor-pointer border-b border-slate-800/50 transition-colors ${
                  selectedDrawing?.drawing_id === d.drawing_id
                    ? 'bg-sky-500/10 border-l-2 border-l-sky-500'
                    : 'hover:bg-slate-800/50 border-l-2 border-l-transparent'
                }`}
              >
                {editingDrawing === d.drawing_id ? (
                  /* Inline Edit Mode */
                  <div className="space-y-1.5" onClick={e => e.stopPropagation()}>
                    <input
                      value={editForm.drawing_number}
                      onChange={e => setEditForm(f => ({ ...f, drawing_number: e.target.value }))}
                      placeholder="도면번호"
                      className="w-full px-2 py-1 bg-slate-700/50 border border-slate-600 rounded text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                    />
                    <input
                      value={editForm.title}
                      onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                      placeholder="도면 타이틀"
                      className="w-full px-2 py-1 bg-slate-700/50 border border-slate-600 rounded text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                    />
                    <div className="flex gap-1.5">
                      <input
                        value={editForm.revision}
                        onChange={e => setEditForm(f => ({ ...f, revision: e.target.value }))}
                        placeholder="리비전"
                        className="w-16 px-2 py-1 bg-slate-700/50 border border-slate-600 rounded text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                      />
                      <select
                        value={editForm.discipline}
                        onChange={e => setEditForm(f => ({ ...f, discipline: e.target.value }))}
                        className="flex-1 px-2 py-1 bg-slate-700/50 border border-slate-600 rounded text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                      >
                        <option value="">디시플린</option>
                        {Object.entries(DISCIPLINES).map(([k, v]) => (
                          <option key={k} value={k}>{v.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-1.5 pt-0.5">
                      <button onClick={e => handleSaveDrawingEdit(d.drawing_id, e)}
                              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-sky-500 hover:bg-sky-400 text-white rounded text-[10px] font-medium">
                        <Check className="w-3 h-3" /> 저장
                      </button>
                      <button onClick={e => { e.stopPropagation(); setEditingDrawing(null); }}
                              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded text-[10px]">
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Normal Display Mode */
                  <>
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-slate-200 truncate">{d.drawing_number || 'No Number'}</p>
                        <p className="text-[11px] text-slate-500 truncate mt-0.5">{d.title || 'Untitled'}</p>
                      </div>
                      <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                        {/* Edit/Delete buttons - show on hover */}
                        <button onClick={e => handleEditDrawing(d, e)} title="Edit"
                                className="p-0.5 text-slate-600 hover:text-sky-400 opacity-0 group-hover/item:opacity-100 transition-all">
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button onClick={e => handleDeleteDrawing(d.drawing_id, e)} title="Delete"
                                className="p-0.5 text-slate-600 hover:text-red-400 opacity-0 group-hover/item:opacity-100 transition-all">
                          <Trash2 className="w-3 h-3" />
                        </button>
                        {d.discipline && DISCIPLINES[d.discipline] && (
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DISCIPLINES[d.discipline]?.color }} />
                        )}
                        <span className="text-[10px] text-slate-500">Rev.{d.current_revision || '-'}</span>
                      </div>
                    </div>
                    {/* Mini review status dots */}
                    <div className="flex items-center gap-1 mt-1.5">
                      {Object.entries(d.review_status || {}).map(([disc, rs]) => (
                        <span
                          key={disc}
                          className={`w-1.5 h-1.5 rounded-full ${
                            rs.status === 'completed' ? 'bg-green-400' :
                            rs.status === 'in_progress' ? 'bg-blue-400' :
                            rs.status === 'rejected' ? 'bg-red-400' : 'bg-slate-600'
                          }`}
                          title={`${DISCIPLINES[disc]?.label}: ${rs.status}`}
                        />
                      ))}
                      {d.em_approval?.status === 'approved' && <CheckCircle2 className="w-3 h-3 text-green-400 ml-1" />}
                    </div>
                  </>
                )}
              </div>
            ))}
            {filteredDrawings.length === 0 && (
              <div className="p-6 text-center text-slate-500 text-xs">
                {drawings.length === 0 ? '도면을 업로드해 주세요' : '검색 결과가 없습니다'}
              </div>
            )}
          </div>
        </div>

        {/* Center Panel - PDF Viewer */}
        <div className="flex-1 flex flex-col overflow-hidden bg-slate-800/30">
          {selectedDrawing && pdfUrl ? (
            <PDFViewer
              doc={{ page: currentPage, docId: pdfUrl }}
              documents={[{ id: pdfUrl, name: selectedDrawing.drawing_number || selectedDrawing.title || 'PDF', pdfUrl }]}
              onClose={() => { setSelectedDrawing(null); setPdfUrl(null); }}
              onCanvasSizeChange={(size) => setCanvasSize(size)}
              overlay={(cs) => (
                <svg
                  className="absolute top-0 left-0"
                  style={{ width: cs.width, height: cs.height, zIndex: 20, cursor: isPlacingPin ? 'crosshair' : 'default' }}
                  viewBox={`0 0 ${cs.width} ${cs.height}`}
                  onClick={isPlacingPin ? handlePinPlace : undefined}
                >
                  {pageMarkups.map(m => {
                    const cx = m.x * cs.width;
                    const cy = m.y * cs.height;
                    const isSelected = selectedMarkup?.markup_id === m.markup_id;
                    const discColor = DISCIPLINES[m.discipline]?.color || '#888';
                    return (
                      <g key={m.markup_id} onClick={(e) => { e.stopPropagation(); setSelectedMarkup(m); setRightTab('markups'); }}
                         style={{ cursor: 'pointer' }}>
                        {isSelected && (
                          <circle cx={cx} cy={cy} r="18" fill="none" stroke={discColor} strokeWidth="2" strokeDasharray="4" opacity="0.7">
                            <animate attributeName="r" values="16;20;16" dur="1.5s" repeatCount="indefinite" />
                          </circle>
                        )}
                        <circle cx={cx} cy={cy} r="10" fill={discColor} fillOpacity={m.status === 'resolved' ? 0.4 : 0.85}
                                stroke="white" strokeWidth="2" />
                        {m.status === 'resolved' && (
                          <path d={`M${cx-4} ${cy} L${cx-1} ${cy+3} L${cx+5} ${cy-3}`} stroke="white" strokeWidth="2" fill="none" />
                        )}
                        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle"
                              fill="white" fontSize="8" fontWeight="bold">
                          {m.status !== 'resolved' ? (markups.indexOf(m) + 1) : ''}
                        </text>
                      </g>
                    );
                  })}
                  {/* Pending pin preview */}
                  {selectedMarkup?._pending && (
                    <circle cx={selectedMarkup.x * cs.width} cy={selectedMarkup.y * cs.height} r="10"
                            fill={DISCIPLINES[selectedMarkup.discipline]?.color || '#888'} fillOpacity="0.6"
                            stroke="white" strokeWidth="2" strokeDasharray="4" />
                  )}
                </svg>
              )}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-500">
              <div className="text-center">
                <FileText className="w-16 h-16 mx-auto mb-4 opacity-30" />
                <p className="text-lg">도면을 선택하세요</p>
                <p className="text-sm mt-1">또는 새 PDF를 업로드하세요</p>
              </div>
            </div>
          )}
        </div>

        {/* Right Panel - Comments / Review */}
        <div className="w-[360px] border-l border-slate-700/50 flex flex-col flex-shrink-0 bg-slate-900/40">
          {/* Tabs */}
          <div className="flex border-b border-slate-700/50 flex-shrink-0">
            {[
              { key: 'markups', label: '마크업', icon: MapPin },
              { key: 'collab', label: '협업', icon: Send },
              { key: 'review', label: '검토', icon: ClipboardList },
              { key: 'dashboard', label: '통계', icon: BarChart3 },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setRightTab(tab.key)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
                  rightTab === tab.key
                    ? 'text-sky-400 border-b-2 border-sky-400'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <tab.icon className="w-3.5 h-3.5" /> {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-auto">
            {/* Comments Tab */}
            {rightTab === 'markups' && (
              <div className="flex flex-col h-full">
                {selectedMarkup && !selectedMarkup._pending ? (
                  /* Selected Markup Detail */
                  <div className="flex flex-col h-full">
                    <div className="p-3 border-b border-slate-700/50">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: DISCIPLINES[selectedMarkup.discipline]?.color }} />
                          <span className="text-xs font-medium text-slate-300">{DISCIPLINES[selectedMarkup.discipline]?.label}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                            selectedMarkup.status === 'open' ? 'bg-amber-500/20 text-amber-400' : 'bg-green-500/20 text-green-400'
                          }`}>
                            {selectedMarkup.status}
                          </span>
                        </div>
                        <button onClick={() => setSelectedMarkup(null)} className="text-slate-500 hover:text-slate-300">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <p className="text-sm text-slate-200 mt-2">{selectedMarkup.comment}</p>
                      <p className="text-[10px] text-slate-500 mt-1">
                        작성자: <span className="text-sky-400">{selectedMarkup.author_name}</span> | P.{selectedMarkup.page} | {new Date(selectedMarkup.created_at).toLocaleString()}
                      </p>
                      <div className="flex gap-2 mt-2">
                        {selectedMarkup.status === 'open' ? (
                          <button onClick={() => handleResolveMarkup(selectedMarkup.markup_id)}
                                  className="flex items-center gap-1 px-2 py-1 bg-green-500/20 text-green-400 rounded text-[10px] hover:bg-green-500/30">
                            <Check className="w-3 h-3" /> 해결
                          </button>
                        ) : (
                          <button onClick={() => handleReopenMarkup(selectedMarkup.markup_id)}
                                  className="flex items-center gap-1 px-2 py-1 bg-amber-500/20 text-amber-400 rounded text-[10px] hover:bg-amber-500/30">
                            <RotateCcw className="w-3 h-3" /> 재오픈
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Replies */}
                    <div className="flex-1 overflow-auto p-3 space-y-2">
                      {(selectedMarkup.replies || []).map(r => (
                        <div key={r.reply_id} className="bg-slate-800/50 rounded-lg p-2.5">
                          <p className="text-xs text-slate-300">{r.content}</p>
                          <p className="text-[10px] text-slate-500 mt-1"><span className="text-sky-400">{r.author_name}</span> | {new Date(r.created_at).toLocaleString()}</p>
                        </div>
                      ))}
                    </div>

                    {/* Reply Input */}
                    <div className="p-3 border-t border-slate-700/50 flex-shrink-0">
                      <div className="flex gap-2">
                        <input
                          value={replyText}
                          onChange={e => setReplyText(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleAddReply()}
                          placeholder="답글 입력..."
                          className="flex-1 px-3 py-1.5 bg-slate-800/50 border border-slate-700/50 rounded-lg text-xs text-slate-300 placeholder-slate-500 focus:outline-none focus:border-sky-500/50"
                        />
                        <button onClick={handleAddReply} className="p-1.5 bg-sky-500 hover:bg-sky-400 text-white rounded-lg">
                          <Send className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ) : selectedMarkup?._pending ? (
                  /* New Pin Comment Input */
                  <div className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <MapPin className="w-4 h-4 text-sky-400" />
                      <span className="text-sm font-medium text-slate-200">새 마크업</span>
                      <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: DISCIPLINES[selectedMarkup.discipline]?.color + '33', color: DISCIPLINES[selectedMarkup.discipline]?.color }}>
                        {DISCIPLINES[selectedMarkup.discipline]?.label}
                      </span>
                    </div>
                    <textarea
                      value={newComment}
                      onChange={e => setNewComment(e.target.value)}
                      placeholder="코멘트를 입력하세요..."
                      className="w-full px-3 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-xs text-slate-300 placeholder-slate-500 focus:outline-none focus:border-sky-500/50 resize-none"
                      rows={4}
                      autoFocus
                    />
                    <div className="flex gap-2 mt-2">
                      <button onClick={handleSaveNewMarkup}
                              className="flex-1 px-3 py-1.5 bg-sky-500 hover:bg-sky-400 text-white rounded-lg text-xs font-medium">
                        마크업 저장
                      </button>
                      <button onClick={() => { setSelectedMarkup(null); setIsPlacingPin(false); }}
                              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-xs">
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  /* All Markups List */
                  <div className="p-3 space-y-2">
                    {selectedDrawing ? (
                      <>
                        <p className="text-xs text-slate-500 mb-2">마크업 {markups.length}건</p>
                        {markups.map((m, i) => (
                          <div
                            key={m.markup_id}
                            onClick={() => { setSelectedMarkup(m); setCurrentPage(m.page); }}
                            className="flex items-start gap-2.5 p-2.5 bg-slate-800/50 rounded-lg cursor-pointer hover:bg-slate-700/50 transition-colors"
                          >
                            <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                                 style={{ backgroundColor: DISCIPLINES[m.discipline]?.color || '#888', opacity: m.status === 'resolved' ? 0.5 : 1 }}>
                              {i + 1}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className={`text-xs ${m.status === 'resolved' ? 'text-slate-500 line-through' : 'text-slate-300'}`}>
                                {m.comment}
                              </p>
                              <p className="text-[10px] text-slate-500 mt-0.5">
                                P.{m.page} | {m.author_name} | 답글 {(m.replies || []).length}건
                              </p>
                            </div>
                          </div>
                        ))}
                      </>
                    ) : (
                      <p className="text-xs text-slate-500 text-center py-8">도면을 선택하면 마크업을 확인할 수 있습니다</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Collaboration Tab */}
            {rightTab === 'collab' && (
              <div className="flex flex-col h-full">
                {selectedRequest ? (
                  /* Request Detail */
                  <div className="flex flex-col h-full">
                    <div className="p-3 border-b border-slate-700/50">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: DISCIPLINES[selectedRequest.discipline]?.color }} />
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            selectedRequest.status === 'pending' ? 'bg-amber-500/20 text-amber-400' :
                            selectedRequest.status === 'in_review' ? 'bg-blue-500/20 text-blue-400' :
                            selectedRequest.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                            selectedRequest.status === 'rejected' ? 'bg-red-500/20 text-red-400' :
                            'bg-slate-500/20 text-slate-400'
                          }`}>
                            {selectedRequest.status === 'pending' ? '요청됨' :
                             selectedRequest.status === 'in_review' ? '검토중' :
                             selectedRequest.status === 'completed' ? '완료' :
                             selectedRequest.status === 'rejected' ? '반려' : '보류'}
                          </span>
                          {selectedRequest.priority === 'urgent' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-medium">긴급</span>
                          )}
                        </div>
                        <button onClick={() => setSelectedRequest(null)} className="text-slate-500 hover:text-slate-300">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <p className="text-sm font-medium text-slate-200">{selectedRequest.title}</p>
                      {selectedRequest.message && (
                        <p className="text-xs text-slate-400 mt-1">{selectedRequest.message}</p>
                      )}
                      <div className="flex items-center gap-3 mt-2 text-[10px] text-slate-500">
                        <span>요청: <span className="text-slate-300">{selectedRequest.from_name}</span></span>
                        <span>담당: <span className="text-sky-400">{selectedRequest.to_name}</span></span>
                      </div>
                      <p className="text-[10px] text-slate-600 mt-1">
                        {selectedRequest.drawing_number} | {new Date(selectedRequest.created_at).toLocaleString()}
                      </p>

                      {/* Status actions */}
                      <div className="flex gap-1.5 mt-2.5">
                        {selectedRequest.status === 'pending' && (
                          <button onClick={() => handleUpdateRequestStatus(selectedRequest.request_id, 'in_review')}
                                  className="px-2 py-1 bg-blue-500/20 text-blue-400 rounded text-[10px] hover:bg-blue-500/30">
                            검토 시작
                          </button>
                        )}
                        {(selectedRequest.status === 'pending' || selectedRequest.status === 'in_review') && (
                          <>
                            <button onClick={() => handleUpdateRequestStatus(selectedRequest.request_id, 'completed')}
                                    className="px-2 py-1 bg-green-500/20 text-green-400 rounded text-[10px] hover:bg-green-500/30">
                              <Check className="w-3 h-3 inline mr-0.5" />완료
                            </button>
                            <button onClick={() => handleUpdateRequestStatus(selectedRequest.request_id, 'rejected')}
                                    className="px-2 py-1 bg-red-500/20 text-red-400 rounded text-[10px] hover:bg-red-500/30">
                              반려
                            </button>
                          </>
                        )}
                        {(selectedRequest.status === 'completed' || selectedRequest.status === 'rejected') && (
                          <button onClick={() => handleUpdateRequestStatus(selectedRequest.request_id, 'pending')}
                                  className="px-2 py-1 bg-amber-500/20 text-amber-400 rounded text-[10px] hover:bg-amber-500/30">
                            <RotateCcw className="w-3 h-3 inline mr-0.5" />재요청
                          </button>
                        )}
                        <button onClick={() => handleDeleteRequest(selectedRequest.request_id)}
                                className="px-2 py-1 bg-slate-700/50 text-slate-400 rounded text-[10px] hover:bg-slate-600/50 ml-auto">
                          <Trash2 className="w-3 h-3 inline" />
                        </button>
                      </div>
                    </div>

                    {/* Reply thread */}
                    <div className="flex-1 overflow-auto p-3 space-y-2">
                      {(selectedRequest.replies || []).map(r => (
                        <div key={r.reply_id} className="bg-slate-800/50 rounded-lg p-2.5">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-medium text-sky-400">{r.author_name}</span>
                            <span className="text-[10px] text-slate-600">{new Date(r.created_at).toLocaleString()}</span>
                          </div>
                          <p className="text-xs text-slate-300">{r.content}</p>
                        </div>
                      ))}
                      {(selectedRequest.replies || []).length === 0 && (
                        <p className="text-xs text-slate-600 text-center py-4">아직 답변이 없습니다</p>
                      )}
                    </div>

                    {/* Reply input */}
                    <div className="p-3 border-t border-slate-700/50 flex-shrink-0">
                      <div className="flex gap-2">
                        <input
                          value={requestReplyText}
                          onChange={e => setRequestReplyText(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleAddRequestReply()}
                          placeholder="답변 입력..."
                          className="flex-1 px-3 py-1.5 bg-slate-800/50 border border-slate-700/50 rounded-lg text-xs text-slate-300 placeholder-slate-500 focus:outline-none focus:border-sky-500/50"
                        />
                        <button onClick={handleAddRequestReply} className="p-1.5 bg-sky-500 hover:bg-sky-400 text-white rounded-lg">
                          <Send className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Request List */
                  <div className="flex flex-col h-full">
                    <div className="p-3 border-b border-slate-700/50 flex-shrink-0">
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-slate-400">검토 요청 {reviewRequests.length}건</p>
                        {selectedDrawing && (
                          <button onClick={() => setShowNewRequest(true)}
                                  className="flex items-center gap-1 px-2 py-1 bg-sky-500/20 text-sky-400 rounded text-[10px] hover:bg-sky-500/30">
                            <Plus className="w-3 h-3" /> 요청 생성
                          </button>
                        )}
                      </div>
                    </div>

                    {/* New request form */}
                    {showNewRequest && selectedDrawing && (
                      <div className="p-3 border-b border-slate-700/50 space-y-2 bg-slate-800/30 flex-shrink-0">
                        <p className="text-xs font-medium text-slate-300">새 검토 요청</p>
                        <input
                          value={requestForm.to_name}
                          onChange={e => setRequestForm(f => ({ ...f, to_name: e.target.value }))}
                          placeholder="담당자 이름"
                          className="w-full px-2 py-1.5 bg-slate-700/50 border border-slate-600 rounded text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                        />
                        <div className="flex gap-1.5">
                          <select
                            value={requestForm.discipline}
                            onChange={e => setRequestForm(f => ({ ...f, discipline: e.target.value }))}
                            className="flex-1 px-2 py-1.5 bg-slate-700/50 border border-slate-600 rounded text-xs text-slate-200 focus:outline-none"
                          >
                            {Object.entries(DISCIPLINES).map(([k, v]) => (
                              <option key={k} value={k}>{v.label}</option>
                            ))}
                          </select>
                          <select
                            value={requestForm.priority}
                            onChange={e => setRequestForm(f => ({ ...f, priority: e.target.value }))}
                            className="w-20 px-2 py-1.5 bg-slate-700/50 border border-slate-600 rounded text-xs text-slate-200 focus:outline-none"
                          >
                            <option value="low">낮음</option>
                            <option value="normal">보통</option>
                            <option value="urgent">긴급</option>
                          </select>
                        </div>
                        <input
                          value={requestForm.title}
                          onChange={e => setRequestForm(f => ({ ...f, title: e.target.value }))}
                          placeholder="요청 제목"
                          className="w-full px-2 py-1.5 bg-slate-700/50 border border-slate-600 rounded text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                        />
                        <textarea
                          value={requestForm.message}
                          onChange={e => setRequestForm(f => ({ ...f, message: e.target.value }))}
                          placeholder="상세 내용 (선택사항)"
                          className="w-full px-2 py-1.5 bg-slate-700/50 border border-slate-600 rounded text-xs text-slate-200 focus:outline-none focus:border-sky-500 resize-none"
                          rows={2}
                        />
                        <div className="flex gap-1.5">
                          <button onClick={handleCreateRequest}
                                  className="flex-1 px-2 py-1.5 bg-sky-500 hover:bg-sky-400 text-white rounded text-xs font-medium">
                            요청 보내기
                          </button>
                          <button onClick={() => setShowNewRequest(false)}
                                  className="px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded text-xs">
                            취소
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Request items */}
                    <div className="flex-1 overflow-auto">
                      {reviewRequests.map(r => (
                        <div
                          key={r.request_id}
                          onClick={() => setSelectedRequest(r)}
                          className="px-3 py-2.5 border-b border-slate-800/50 cursor-pointer hover:bg-slate-800/50 transition-colors"
                        >
                          <div className="flex items-start justify-between">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 mb-0.5">
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DISCIPLINES[r.discipline]?.color }} />
                                <span className={`text-[9px] px-1 py-0.5 rounded ${
                                  r.status === 'pending' ? 'bg-amber-500/20 text-amber-400' :
                                  r.status === 'in_review' ? 'bg-blue-500/20 text-blue-400' :
                                  r.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                                  r.status === 'rejected' ? 'bg-red-500/20 text-red-400' :
                                  'bg-slate-500/20 text-slate-400'
                                }`}>
                                  {r.status === 'pending' ? '요청됨' :
                                   r.status === 'in_review' ? '검토중' :
                                   r.status === 'completed' ? '완료' :
                                   r.status === 'rejected' ? '반려' : '보류'}
                                </span>
                                {r.priority === 'urgent' && (
                                  <AlertTriangle className="w-3 h-3 text-red-400" />
                                )}
                              </div>
                              <p className="text-xs font-medium text-slate-200 truncate">{r.title}</p>
                              <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500">
                                <span>{r.from_name} → <span className="text-sky-400">{r.to_name}</span></span>
                                <span>| 답변 {(r.replies || []).length}건</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                      {reviewRequests.length === 0 && (
                        <div className="p-6 text-center text-slate-500 text-xs">
                          {selectedDrawing ? '검토 요청이 없습니다' : '도면을 선택해 주세요'}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Review Tab */}
            {rightTab === 'review' && selectedDrawing && (
              <div className="p-3 space-y-4">
                {/* Drawing Info */}
                <div className="bg-slate-800/50 rounded-lg p-3">
                  <p className="text-xs font-medium text-slate-200">{selectedDrawing.drawing_number}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{selectedDrawing.title}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5">Rev. {selectedDrawing.current_revision}</p>
                </div>

                {/* Discipline Reviews */}
                <div>
                  <p className="text-xs font-medium text-slate-300 mb-2">디시플린 검토</p>
                  <div className="space-y-1.5">
                    {Object.entries(DISCIPLINES).map(([disc, info]) => {
                      const reviewData = selectedDrawing.review_status?.[disc] || { status: 'not_started' };
                      const StatusIcon = REVIEW_STATUSES[reviewData.status]?.icon || Clock;
                      return (
                        <div key={disc} className="flex items-center justify-between p-2 bg-slate-800/50 rounded-lg">
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: info.color }} />
                            <span className="text-xs text-slate-300">{info.label}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <select
                              value={reviewData.status}
                              onChange={e => handleUpdateReview(disc, e.target.value)}
                              className="px-1.5 py-0.5 bg-slate-700/50 border border-slate-600/50 rounded text-[10px] text-slate-400 focus:outline-none cursor-pointer"
                            >
                              <option value="not_started">미시작</option>
                              <option value="in_progress">진행중</option>
                              <option value="completed">완료</option>
                              <option value="rejected">반려</option>
                            </select>
                            <StatusIcon className={`w-3.5 h-3.5 ${REVIEW_STATUSES[reviewData.status]?.color || 'text-slate-500'}`} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* EM Final Approval */}
                <div>
                  <p className="text-xs font-medium text-slate-300 mb-2">EM 최종 승인</p>
                  <div className="bg-slate-800/50 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className={`text-sm font-medium ${
                        selectedDrawing.em_approval?.status === 'approved' ? 'text-green-400' :
                        selectedDrawing.em_approval?.status === 'rejected' ? 'text-red-400' :
                        selectedDrawing.em_approval?.status === 'conditionally_approved' ? 'text-amber-400' :
                        'text-slate-400'
                      }`}>
                        {selectedDrawing.em_approval?.status === 'approved' ? '승인됨' :
                         selectedDrawing.em_approval?.status === 'rejected' ? '반려됨' :
                         selectedDrawing.em_approval?.status === 'conditionally_approved' ? '조건부 승인' :
                         '대기중'}
                      </span>
                      <Shield className="w-4 h-4 text-slate-500" />
                    </div>
                    <div className="flex gap-1.5">
                      <button onClick={() => handleApproval('approved')}
                              className="flex-1 px-2 py-1 bg-green-500/20 text-green-400 rounded text-[10px] hover:bg-green-500/30 transition-colors">
                        승인
                      </button>
                      <button onClick={() => handleApproval('conditionally_approved')}
                              className="flex-1 px-2 py-1 bg-amber-500/20 text-amber-400 rounded text-[10px] hover:bg-amber-500/30 transition-colors">
                        조건부
                      </button>
                      <button onClick={() => handleApproval('rejected')}
                              className="flex-1 px-2 py-1 bg-red-500/20 text-red-400 rounded text-[10px] hover:bg-red-500/30 transition-colors">
                        반려
                      </button>
                    </div>
                  </div>
                </div>

                {/* Revisions History */}
                {selectedDrawing.revisions?.length > 1 && (
                  <div>
                    <p className="text-xs font-medium text-slate-300 mb-2">리비전 이력</p>
                    <div className="space-y-1">
                      {selectedDrawing.revisions.map(rev => (
                        <div key={rev.revision_id} className="flex items-center justify-between p-2 bg-slate-800/50 rounded-lg text-[10px]">
                          <span className="text-slate-300">Rev. {rev.revision}</span>
                          <span className="text-slate-500">{new Date(rev.uploaded_at).toLocaleDateString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {rightTab === 'review' && !selectedDrawing && (
              <div className="p-6 text-center text-slate-500 text-xs">도면을 선택하면 검토 상태를 확인할 수 있습니다</div>
            )}

            {/* Dashboard Tab */}
            {rightTab === 'dashboard' && dashboard && (
              <div className="p-3 space-y-4">
                {/* Overview */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-slate-100">{dashboard.total_drawings}</p>
                    <p className="text-[10px] text-slate-500">전체 도면</p>
                  </div>
                  <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-slate-100">{dashboard.total_markups}</p>
                    <p className="text-[10px] text-slate-500">전체 마크업</p>
                  </div>
                  <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-sky-400">{dashboard.total_requests || 0}</p>
                    <p className="text-[10px] text-slate-500">검토 요청</p>
                  </div>
                  <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-amber-400">{dashboard.pending_requests || 0}</p>
                    <p className="text-[10px] text-slate-500">대기중 요청</p>
                  </div>
                  <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-amber-400">{dashboard.open_markups}</p>
                    <p className="text-[10px] text-slate-500">미해결</p>
                  </div>
                  <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-green-400">{dashboard.resolved_markups}</p>
                    <p className="text-[10px] text-slate-500">해결됨</p>
                  </div>
                </div>

                {/* By Discipline */}
                <div>
                  <p className="text-xs font-medium text-slate-300 mb-2">디시플린별 도면</p>
                  <div className="space-y-1">
                    {Object.entries(dashboard.drawings_by_discipline || {}).map(([disc, count]) => (
                      <div key={disc} className="flex items-center justify-between p-2 bg-slate-800/50 rounded-lg">
                        <div className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: DISCIPLINES[disc]?.color || '#888' }} />
                          <span className="text-xs text-slate-300">{DISCIPLINES[disc]?.label || disc}</span>
                        </div>
                        <span className="text-xs font-medium text-slate-200">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Markups by Discipline */}
                {Object.keys(dashboard.markups_by_discipline || {}).length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-slate-300 mb-2">디시플린별 마크업</p>
                    <div className="space-y-1">
                      {Object.entries(dashboard.markups_by_discipline).map(([disc, count]) => (
                        <div key={disc} className="flex items-center justify-between p-2 bg-slate-800/50 rounded-lg">
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: DISCIPLINES[disc]?.color || '#888' }} />
                            <span className="text-xs text-slate-300">{DISCIPLINES[disc]?.label || disc}</span>
                          </div>
                          <span className="text-xs font-medium text-slate-200">{count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Approval Stats */}
                <div>
                  <p className="text-xs font-medium text-slate-300 mb-2">승인 현황</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {Object.entries(dashboard.approval_stats || {}).map(([status, count]) => (
                      <div key={status} className="bg-slate-800/50 rounded-lg p-2 text-center">
                        <p className={`text-lg font-bold ${
                          status === 'approved' ? 'text-green-400' :
                          status === 'rejected' ? 'text-red-400' :
                          status === 'conditionally_approved' ? 'text-amber-400' : 'text-slate-400'
                        }`}>{count}</p>
                        <p className="text-[9px] text-slate-500 capitalize">{status.replace('_', ' ')}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {rightTab === 'dashboard' && !dashboard && (
              <div className="p-6 text-center text-slate-500 text-xs">대시보드 로딩중...</div>
            )}
          </div>
        </div>
      </div>

      {/* Title Block Confirmation Modal */}
      {showTitleBlockModal && titleBlockData && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 w-[500px] max-h-[80vh] overflow-auto shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-100">타이틀 블록 - AI 추출 결과</h3>
              <button onClick={() => setShowTitleBlockModal(false)} className="text-slate-500 hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-4">AI가 추출한 타이틀 블록 정보를 확인하고 수정하세요.</p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">도면번호</label>
                <input
                  value={titleBlockData.drawing_number || ''}
                  onChange={e => setTitleBlockData(prev => ({ ...prev, drawing_number: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">타이틀</label>
                <input
                  value={titleBlockData.title || ''}
                  onChange={e => setTitleBlockData(prev => ({ ...prev, title: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-sky-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">리비전</label>
                  <input
                    value={titleBlockData.revision || ''}
                    onChange={e => setTitleBlockData(prev => ({ ...prev, revision: e.target.value }))}
                    className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">디시플린</label>
                  <select
                    value={titleBlockData.discipline || ''}
                    onChange={e => setTitleBlockData(prev => ({ ...prev, discipline: e.target.value }))}
                    className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-sky-500"
                  >
                    <option value="">선택...</option>
                    {Object.entries(DISCIPLINES).map(([k, v]) => (
                      <option key={k} value={k}>{v.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button onClick={handleConfirmTitleBlock}
                      className="flex-1 px-4 py-2 bg-sky-500 hover:bg-sky-400 text-white rounded-lg text-sm font-medium transition-colors">
                확인
              </button>
              <button onClick={() => setShowTitleBlockModal(false)}
                      className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-sm transition-colors">
                건너뛰기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PlantSync;
