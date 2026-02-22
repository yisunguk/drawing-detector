import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Layers, Plus, Upload, Search, Filter, ChevronDown, ChevronRight,
  ArrowLeft, X, Send, Check, CheckCircle2, XCircle, Clock, AlertTriangle,
  FileText, MapPin, MessageSquare, ClipboardList, Trash2,
  RotateCcw, Eye, Pencil, Shield, Loader2, LogOut, GitCompare,
  Sparkles, ExternalLink, File, Download, History, ShieldCheck, FileDown,
  Inbox, UserCheck, GitMerge, Reply, Users, CalendarDays
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { auth } from '../firebase';
import PDFViewer from '../components/PDFViewer';
import DiffViewer from '../components/DiffViewer';

const API_BASE = (import.meta.env.VITE_API_URL || 'https://drawing-detector-backend-435353955407.us-central1.run.app').replace(/\/$/, '');
const getUrl = (path) => `${API_BASE}/api/v1/plantsync/${path}`;

const getToken = async () => {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');
  return user.getIdToken();
};

const DISCIPLINES = {
  process:     { label: '공정',    color: '#ef4444', bg: 'bg-red-50',    text: 'text-red-600' },
  mechanical:  { label: '기계',    color: '#3b82f6', bg: 'bg-blue-50',   text: 'text-blue-600' },
  piping:      { label: '배관',    color: '#22c55e', bg: 'bg-green-50',  text: 'text-green-600' },
  electrical:  { label: '전기',    color: '#eab308', bg: 'bg-yellow-50', text: 'text-yellow-600' },
  instrument:  { label: '계장',    color: '#a855f7', bg: 'bg-purple-50', text: 'text-purple-600' },
  civil:       { label: '토목',    color: '#f97316', bg: 'bg-orange-50', text: 'text-orange-600' },
};

const REVIEW_STATUSES = {
  not_started: { label: '미시작',   icon: Clock,          color: 'text-gray-400' },
  in_progress: { label: '진행중',   icon: Loader2,        color: 'text-blue-600' },
  completed:   { label: '완료',     icon: CheckCircle2,   color: 'text-green-600' },
  rejected:    { label: '반려',     icon: XCircle,         color: 'text-red-600' },
};

const PlantSync = () => {
  const { currentUser, logout } = useAuth();
  const navigate = useNavigate();

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
  const [editingProjectId, setEditingProjectId] = useState(null);
  const [editProjectName, setEditProjectName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [disciplineFilter, setDisciplineFilter] = useState('all');
  const [isPlacingPin, setIsPlacingPin] = useState(false);
  const [pinDiscipline, setPinDiscipline] = useState('process');
  const [rightTab, setRightTab] = useState('intake'); // 'intake' | 'assign' | 'markup' | 'consolidate' | 'return'
  const [showTitleBlockModal, setShowTitleBlockModal] = useState(false);
  const [titleBlockData, setTitleBlockData] = useState(null);
  const [pendingDrawingId, setPendingDrawingId] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [newComment, setNewComment] = useState('');
  const [dashboard, setDashboard] = useState(null);
  const [editingDrawing, setEditingDrawing] = useState(null);
  const [editForm, setEditForm] = useState({ drawing_number: '', title: '', revision: '', discipline: '', vendor_name: '', issue_purpose: '' });

  // Collaboration
  const [reviewRequests, setReviewRequests] = useState([]);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [showNewRequest, setShowNewRequest] = useState(false);
  const [requestForm, setRequestForm] = useState({ to_name: '', discipline: 'process', title: '', message: '', priority: 'normal' });
  const [requestReplyText, setRequestReplyText] = useState('');
  const [activeRequestId, setActiveRequestId] = useState(null); // for linking markups to request

  // Feature 2: Staging Area
  const [stagingWords, setStagingWords] = useState([]);
  const [stagingLayout, setStagingLayout] = useState({ width: 0, height: 0 });
  const [stagedCount, setStagedCount] = useState(0);

  // Feature 3: Diff Viewer
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [diffRevisions, setDiffRevisions] = useState({ a: null, b: null });
  const [diffRevSelecting, setDiffRevSelecting] = useState(false);
  const [diffRevA, setDiffRevA] = useState('');
  const [diffRevB, setDiffRevB] = useState('');

  // Feature 4: Smart Markup Pin
  const [nearbyWords, setNearbyWords] = useState([]);
  const [nearbyLines, setNearbyLines] = useState([]);
  const [loadingNearby, setLoadingNearby] = useState(false);
  const [relatedResults, setRelatedResults] = useState({ markups: [], documents: [] });
  const [loadingRelated, setLoadingRelated] = useState(false);

  // Feature 6: Bulk Upload
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });

  // Feature 7: Activity Timeline
  const [activities, setActivities] = useState([]);

  // Feature 8: Review Gate
  const [reviewGate, setReviewGate] = useState(null);

  // Feature 9: Markup PDF Export
  const [exportingPdf, setExportingPdf] = useState(false);

  // EPC Workflow States
  const [assignForm, setAssignForm] = useState({ lead_reviewer: '', squad_reviewers: '', due_date: '' });
  const [conflicts, setConflicts] = useState([]);
  const [loadingConflicts, setLoadingConflicts] = useState(false);
  const [returnCodeSelection, setReturnCodeSelection] = useState('');
  const [transmittals, setTransmittals] = useState([]);
  const [showActivityDrawer, setShowActivityDrawer] = useState(false);
  const [intakeComment, setIntakeComment] = useState('');
  const [userList, setUserList] = useState([]);

  const fileInputRef = useRef(null);

  // Sidebar resize
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(360);
  const isResizingLeft = useRef(false);
  const isResizingRight = useRef(false);

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

  const loadUsers = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch(getUrl('users'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setUserList(data.users || []);
      }
    } catch (e) {
      console.error('Load users error:', e);
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

  // Feature 7: Load activity timeline
  const loadActivities = useCallback(async (projectId) => {
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${projectId}/activity?limit=50`), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setActivities(data.activities || []);
    } catch (e) {
      console.error('Load activities error:', e);
    }
  }, []);

  // Feature 8: Load review gate
  const loadReviewGate = useCallback(async (projectId, drawingId) => {
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${projectId}/drawings/${drawingId}/review-gate`), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setReviewGate(data);
    } catch (e) {
      console.error('Load review gate error:', e);
    }
  }, []);

  // ── EPC Workflow API Calls ──

  const handleIntakeDecision = async (requestId, drawingId, decision) => {
    if (!selectedProject) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/requests/${requestId}/intake-decision`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ drawing_id: drawingId, decision, comment: intakeComment }),
      });
      setIntakeComment('');
      await loadReviewRequests(selectedProject.project_id, selectedDrawing?.drawing_id);
      await loadProjectDetail(selectedProject.project_id);
    } catch (e) {
      console.error('Intake decision error:', e);
    }
  };

  const handleAssignReviewers = async (requestId) => {
    if (!selectedProject || !assignForm.lead_reviewer.trim()) return;
    try {
      const token = await getToken();
      const squadArr = assignForm.squad_reviewers.split(',').map(s => s.trim()).filter(Boolean);
      await fetch(getUrl(`projects/${selectedProject.project_id}/requests/${requestId}/assign`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_reviewer: assignForm.lead_reviewer.trim(),
          squad_reviewers: squadArr,
          due_date: assignForm.due_date || undefined,
        }),
      });
      setAssignForm({ lead_reviewer: '', squad_reviewers: '', due_date: '' });
      await loadReviewRequests(selectedProject.project_id, selectedDrawing?.drawing_id);
    } catch (e) {
      console.error('Assign reviewers error:', e);
    }
  };

  const loadConflicts = async (requestId) => {
    if (!selectedProject) return;
    setLoadingConflicts(true);
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${selectedProject.project_id}/requests/${requestId}/conflicts`), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setConflicts(data.conflicts || []);
      }
    } catch (e) {
      console.error('Load conflicts error:', e);
    } finally {
      setLoadingConflicts(false);
    }
  };

  const handleConsolidate = async (requestId, confirmedIds) => {
    if (!selectedProject) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/requests/${requestId}/consolidate`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed_markup_ids: confirmedIds }),
      });
      await loadReviewRequests(selectedProject.project_id, selectedDrawing?.drawing_id);
    } catch (e) {
      console.error('Consolidate error:', e);
      alert(e.message || '의견 종합 실패');
    }
  };

  const handleSetReturnCode = async (requestId, code) => {
    if (!selectedProject) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/requests/${requestId}/return-code`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ return_code: code }),
      });
      await loadReviewRequests(selectedProject.project_id, selectedDrawing?.drawing_id);
      if (selectedDrawing) {
        await loadProjectDetail(selectedProject.project_id);
        await loadReviewGate(selectedProject.project_id, selectedDrawing.drawing_id);
      }
    } catch (e) {
      console.error('Return code error:', e);
    }
  };

  const handleCreateTransmittal = async (requestId) => {
    if (!selectedProject) return;
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${selectedProject.project_id}/requests/${requestId}/transmittal`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error('Transmittal failed');
      const data = await res.json();
      alert(`Transmittal 생성 완료: ${data.transmittal_no}`);
      await loadReviewRequests(selectedProject.project_id, selectedDrawing?.drawing_id);
      await loadActivities(selectedProject.project_id);
    } catch (e) {
      console.error('Transmittal error:', e);
      alert('Transmittal 생성 실패');
    }
  };

  // ── Effects ──

  useEffect(() => { loadProjects(); loadUsers(); }, [loadProjects, loadUsers]);

  useEffect(() => {
    if (selectedProject) {
      loadProjectDetail(selectedProject.project_id);
      loadDashboard(selectedProject.project_id);
      loadReviewRequests(selectedProject.project_id);
      loadActivities(selectedProject.project_id);
    }
  }, [selectedProject, loadProjectDetail, loadDashboard, loadReviewRequests, loadActivities]);

  useEffect(() => {
    if (selectedProject && selectedDrawing) {
      loadPdfUrl(selectedProject.project_id, selectedDrawing.drawing_id);
      loadMarkups(selectedProject.project_id, selectedDrawing.drawing_id);
      loadReviewRequests(selectedProject.project_id, selectedDrawing.drawing_id);
      loadReviewGate(selectedProject.project_id, selectedDrawing.drawing_id);
    }
  }, [selectedProject, selectedDrawing, loadPdfUrl, loadMarkups, loadReviewRequests, loadReviewGate]);

  // ── Sidebar resize ──
  useEffect(() => {
    const onMouseMove = (e) => {
      if (isResizingLeft.current) {
        const newW = Math.min(500, Math.max(200, e.clientX));
        setLeftWidth(newW);
      }
      if (isResizingRight.current) {
        const newW = Math.min(600, Math.max(280, window.innerWidth - e.clientX));
        setRightWidth(newW);
      }
    };
    const onMouseUp = () => {
      isResizingLeft.current = false;
      isResizingRight.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

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

  const handleRenameProject = async (projectId) => {
    const name = editProjectName.trim();
    if (!name) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${projectId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ project_name: name }),
      });
      setEditingProjectId(null);
      setEditProjectName('');
      await loadProjects();
    } catch (e) {
      console.error('Rename error:', e);
    }
  };

  const handleFileUpload = async (e) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0 || !selectedProject) return;

    // Feature 6: Bulk upload for multiple files
    if (fileList.length > 1) {
      setBulkUploading(true);
      setBulkProgress({ current: 0, total: fileList.length });
      try {
        const token = await getToken();
        const formData = new FormData();
        for (let i = 0; i < fileList.length; i++) {
          formData.append('files', fileList[i]);
        }
        const res = await fetch(getUrl(`projects/${selectedProject.project_id}/bulk-upload`), {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: formData,
        });
        if (!res.ok) throw new Error('Bulk upload failed');
        const data = await res.json();
        setBulkProgress({ current: data.success_count, total: data.total });
        await loadProjectDetail(selectedProject.project_id);
        await loadActivities(selectedProject.project_id);
        alert(`일괄 업로드 완료: ${data.success_count}/${data.total}건 성공`);
      } catch (err) {
        console.error('Bulk upload error:', err);
        alert('일괄 업로드 실패: ' + err.message);
      } finally {
        setBulkUploading(false);
        setBulkProgress({ current: 0, total: 0 });
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
      return;
    }

    // Single file upload (existing flow)
    const file = fileList[0];
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

      // Show title block confirmation modal + staging data
      setTitleBlockData({
        ...data.title_block,
        vendor_drawing_number: '',
        issue_purpose: '',
        issue_date: '',
        receive_date: '',
        vendor_name: '',
        reviewer_name: '',
        has_dwg: false,
        related_drawings: [],
        change_log: '',
        remarks: '',
      });
      setPendingDrawingId(data.drawing?.drawing_id);
      setStagingWords(data.title_block_words || []);
      setStagingLayout(data.di_page_layout || { width: 0, height: 0 });
      setShowTitleBlockModal(true);

      await loadProjectDetail(selectedProject.project_id);
      await loadActivities(selectedProject.project_id);
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
      // Use register endpoint to move from staged → registered
      await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${pendingDrawingId}/register`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...titleBlockData,
          revision: titleBlockData.revision,
        }),
      });
      setShowTitleBlockModal(false);
      setStagingWords([]);
      setStagingLayout({ width: 0, height: 0 });
      await loadProjectDetail(selectedProject.project_id);
    } catch (e) {
      console.error('Confirm title block error:', e);
    }
  };

  const handlePinPlace = async (e) => {
    if (!isPlacingPin || !canvasSize.width || !canvasSize.height) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setNewComment('');
    setNearbyWords([]);
    setNearbyLines([]);
    setRelatedResults({ markups: [], documents: [] });
    setSelectedMarkup({ _pending: true, x, y, page: currentPage, discipline: pinDiscipline });

    // Feature 4: Fetch nearby text
    if (selectedProject && selectedDrawing) {
      setLoadingNearby(true);
      try {
        const token = await getToken();
        const res = await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${selectedDrawing.drawing_id}/nearby-text`), {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ page: currentPage, x, y, radius: 0.05 }),
        });
        if (res.ok) {
          const data = await res.json();
          setNearbyWords(data.words || []);
          setNearbyLines(data.lines || []);
        }
      } catch (err) {
        console.error('Nearby text error:', err);
      } finally {
        setLoadingNearby(false);
      }
    }
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
          request_id: activeRequestId || undefined,
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

  const handleConfirmMarkup = async (markupId) => {
    if (!selectedProject || !selectedDrawing) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${selectedDrawing.drawing_id}/markups/${markupId}`), {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      });
      await loadMarkups(selectedProject.project_id, selectedDrawing.drawing_id);
      if (selectedMarkup?.markup_id === markupId) {
        setSelectedMarkup(prev => prev ? { ...prev, status: 'confirmed' } : null);
      }
    } catch (e) {
      console.error('Confirm error:', e);
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
      if (activeRequestId === requestId) setActiveRequestId(null);
      await loadReviewRequests(selectedProject.project_id, selectedDrawing?.drawing_id);
    } catch (e) {
      console.error('Delete request error:', e);
    }
  };

  const handleStartMarkup = async (request) => {
    if (request.status === 'requested') {
      await handleUpdateRequestStatus(request.request_id, 'markup_in_progress');
    }
    setActiveRequestId(request.request_id);
    setPinDiscipline(request.discipline);
    setIsPlacingPin(true);
    const dwg = (projectDetail?.drawings || []).find(d => d.drawing_id === request.drawing_id);
    if (dwg && selectedDrawing?.drawing_id !== dwg.drawing_id) {
      setSelectedDrawing(dwg);
      setCurrentPage(1);
    }
    setRightTab('markup');
  };

  const handleStopMarkup = () => {
    setActiveRequestId(null);
    setIsPlacingPin(false);
  };

  // Feature 3: Diff Viewer
  const handleOpenDiff = async () => {
    if (!selectedProject || !selectedDrawing || !diffRevA || !diffRevB) return;
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${selectedDrawing.drawing_id}/diff-urls`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision_id_a: diffRevA, revision_id_b: diffRevB }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setDiffRevisions({ a: data.revision_a, b: data.revision_b });
      setShowDiffViewer(true);
      setDiffRevSelecting(false);
    } catch (e) {
      console.error('Diff URLs error:', e);
    }
  };

  // Feature 4: Related search
  const handleRelatedSearch = async (queryText) => {
    if (!selectedProject || !selectedDrawing || !queryText?.trim()) return;
    setLoadingRelated(true);
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${selectedDrawing.drawing_id}/related-search`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryText.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setRelatedResults({ markups: data.markups || [], documents: data.documents || [] });
      }
    } catch (err) {
      console.error('Related search error:', err);
    } finally {
      setLoadingRelated(false);
    }
  };

  // Feature 5: Excel Export
  const handleExportExcel = async () => {
    if (!selectedProject) return;
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${selectedProject.project_id}/export-excel`), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedProject.project_name || 'plantsync'}_도면대장.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export excel error:', e);
      alert('Excel 내보내기 실패');
    }
  };

  // Feature 9: Markup PDF Export
  const handleExportMarkupPdf = async () => {
    if (!selectedProject || !selectedDrawing) return;
    setExportingPdf(true);
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${selectedDrawing.drawing_id}/export-markup-pdf`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedDrawing.drawing_number || selectedDrawing.drawing_id}_markup.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export markup PDF error:', e);
      alert('마크업 PDF 내보내기 실패');
    } finally {
      setExportingPdf(false);
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
      vendor_name: d.vendor_name || '',
      issue_purpose: d.issue_purpose || '',
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

  // ── Filtered Drawings (exclude staged) ──
  const drawings = projectDetail?.drawings || [];
  const registeredDrawings = drawings.filter(d => d.staging_status !== 'staged');
  const filteredDrawings = registeredDrawings.filter(d => {
    if (disciplineFilter !== 'all' && d.discipline !== disciplineFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (d.drawing_number || '').toLowerCase().includes(q) ||
             (d.title || '').toLowerCase().includes(q);
    }
    return true;
  });
  const currentStagedCount = drawings.filter(d => d.staging_status === 'staged').length;

  // Current page markups
  const pageMarkups = markups.filter(m => m.page === currentPage);

  // ── Project Selection Screen ──
  if (!selectedProject) {
    return (
      <div className="h-screen bg-gradient-to-br from-gray-50 via-white to-gray-50 flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-100 to-cyan-100 flex items-center justify-center">
              <Layers className="w-5 h-5 text-sky-600" />
            </div>
            <h1 className="text-xl font-bold text-gray-900">도면 리비전 관리</h1>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-8">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">프로젝트</h2>
                <p className="text-gray-500 mt-1">프로젝트를 선택하거나 새로 생성하세요</p>
              </div>
              <button
                onClick={() => setShowNewProject(true)}
                className="flex items-center gap-2 px-4 py-2 bg-sky-500 hover:bg-sky-400 text-white rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" /> 새 프로젝트
              </button>
            </div>

            {showNewProject && (
              <div className="mb-6 bg-gray-100 border border-gray-200 rounded-xl p-4 flex gap-3">
                <input
                  type="text"
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateProject()}
                  placeholder="프로젝트명 입력..."
                  className="flex-1 px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-800 placeholder-gray-400 focus:outline-none focus:border-sky-500"
                  autoFocus
                />
                <button onClick={handleCreateProject} className="px-4 py-2 bg-sky-500 hover:bg-sky-400 text-white rounded-lg">생성</button>
                <button onClick={() => setShowNewProject(false)} className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-600 rounded-lg">취소</button>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {projects.map(p => (
                <div
                  key={p.project_id}
                  onClick={() => { if (editingProjectId !== p.project_id) setSelectedProject(p); }}
                  className="group relative cursor-pointer bg-gray-100 border border-gray-200 rounded-xl p-6 hover:border-sky-300 transition-all"
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1 min-w-0">
                      {editingProjectId === p.project_id ? (
                        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                          <input
                            type="text"
                            value={editProjectName}
                            onChange={e => setEditProjectName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleRenameProject(p.project_id); if (e.key === 'Escape') setEditingProjectId(null); }}
                            className="flex-1 px-2 py-1 bg-white border border-gray-300 rounded-lg text-gray-800 focus:outline-none focus:border-sky-500"
                            autoFocus
                          />
                          <button onClick={() => handleRenameProject(p.project_id)} className="p-1 text-green-600 hover:bg-green-50 rounded">
                            <Check className="w-4 h-4" />
                          </button>
                          <button onClick={() => setEditingProjectId(null)} className="p-1 text-gray-500 hover:bg-gray-200 rounded">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <h3 className="text-lg font-semibold text-gray-900 group-hover:text-sky-600 transition-colors truncate">{p.project_name}</h3>
                      )}
                      {p.project_code && <p className="text-sm text-gray-400 mt-1">{p.project_code}</p>}
                    </div>
                    {editingProjectId !== p.project_id && (
                      <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                        <button
                          onClick={e => { e.stopPropagation(); setEditingProjectId(p.project_id); setEditProjectName(p.project_name); }}
                          className="p-1.5 text-gray-400 hover:text-sky-600 hover:bg-sky-50 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); handleDeleteProject(p.project_id); }}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-4 mt-4 text-sm text-gray-500">
                    <span className="flex items-center gap-1"><FileText className="w-4 h-4" /> {p.drawing_count}건 도면</span>
                    <span>{new Date(p.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
              {projects.length === 0 && !showNewProject && (
                <div className="col-span-2 text-center py-16 text-gray-400">
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
    <div className="h-screen bg-gradient-to-br from-gray-50 via-white to-gray-50 flex flex-col overflow-hidden">
      {/* Main Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel - Drawing List (KnowhowDB style) */}
        <div className="border-r border-gray-200 flex flex-col flex-shrink-0 bg-white relative" style={{ width: leftWidth, minWidth: 200, maxWidth: 500 }}>
          {/* Header - Project Info */}
          <div className="p-4 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-sky-100 to-cyan-100 flex items-center justify-center flex-shrink-0">
                <Layers className="w-5 h-5 text-sky-600" />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm font-bold text-gray-900 truncate">{selectedProject.project_name}</h1>
                <p className="text-xs text-gray-400">{drawings.length}건 도면</p>
              </div>
            </div>
          </div>

          {/* Staging Badge + Upload Button */}
          <div className="px-3 pt-3 pb-1 space-y-1.5">
            {currentStagedCount > 0 && (
              <div className="flex items-center justify-between px-2.5 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                <span className="text-[10px] text-amber-600">대기 {currentStagedCount}건</span>
                <button
                  onClick={() => {
                    const staged = drawings.find(d => d.staging_status === 'staged');
                    if (staged) {
                      setTitleBlockData({
                        drawing_number: staged.drawing_number || '',
                        title: staged.title || '',
                        revision: staged.current_revision || '',
                        discipline: staged.discipline || '',
                        vendor_drawing_number: staged.vendor_drawing_number || '',
                        issue_purpose: staged.issue_purpose || '',
                        issue_date: staged.issue_date || '',
                        receive_date: staged.receive_date || '',
                        vendor_name: staged.vendor_name || '',
                        reviewer_name: staged.reviewer_name || '',
                        has_dwg: staged.has_dwg || false,
                        related_drawings: staged.related_drawings || [],
                        change_log: staged.change_log || '',
                        remarks: staged.remarks || '',
                      });
                      setPendingDrawingId(staged.drawing_id);
                      setShowTitleBlockModal(true);
                    }
                  }}
                  className="text-[10px] text-amber-600 hover:text-amber-600 underline"
                >확인하기</button>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept=".pdf" multiple onChange={handleFileUpload} className="hidden" />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || bulkUploading}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-gradient-to-r from-sky-500 to-cyan-500 hover:from-sky-400 hover:to-cyan-400 disabled:from-gray-300 disabled:to-gray-300 text-white rounded-lg text-sm font-medium transition-all shadow-sm"
            >
              {uploading || bulkUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {bulkUploading ? `업로드 중 ${bulkProgress.current}/${bulkProgress.total}` : uploading ? '업로드 중...' : 'PDF 업로드'}
            </button>
          </div>

          {/* Pin Controls (when drawing selected) */}
          {selectedDrawing && (
            <div className="px-3 py-2 border-b border-gray-200 flex items-center gap-2">
              <select
                value={pinDiscipline}
                onChange={e => setPinDiscipline(e.target.value)}
                className="flex-1 px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-600 focus:outline-none focus:border-sky-300"
              >
                {Object.entries(DISCIPLINES).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
              <button
                onClick={() => setIsPlacingPin(!isPlacingPin)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  isPlacingPin
                    ? 'bg-sky-500 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-300'
                }`}
              >
                <MapPin className="w-3.5 h-3.5" /> {isPlacingPin ? '배치중' : '핀'}
              </button>
              {activeRequestId && (
                <div className="flex items-center gap-1 px-1.5 py-1 bg-amber-50 border border-amber-200 rounded-lg">
                  <span className="text-[9px] text-amber-600">연결중</span>
                  <button onClick={handleStopMarkup} className="text-amber-600 hover:text-amber-600">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Search & Filter */}
          <div className="p-3 border-b border-gray-200 space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="도면 검색..."
                className="w-full pl-8 pr-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-600 placeholder-gray-400 focus:outline-none focus:border-sky-300"
              />
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setDisciplineFilter('all')}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  disciplineFilter === 'all' ? 'bg-sky-100 text-sky-600' : 'text-gray-400 hover:text-gray-600'
                }`}
              >전체</button>
              {Object.entries(DISCIPLINES).map(([k, v]) => (
                <button
                  key={k}
                  onClick={() => setDisciplineFilter(k)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    disciplineFilter === k ? `${v.bg} ${v.text}` : 'text-gray-400 hover:text-gray-600'
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
                className={`group/item px-3 py-2.5 cursor-pointer border-b border-gray-100 transition-colors ${
                  selectedDrawing?.drawing_id === d.drawing_id
                    ? 'bg-sky-50 border-l-2 border-l-sky-500'
                    : 'hover:bg-gray-50 border-l-2 border-l-transparent'
                }`}
              >
                {editingDrawing === d.drawing_id ? (
                  /* Inline Edit Mode */
                  <div className="space-y-1.5" onClick={e => e.stopPropagation()}>
                    {/* Row 1: Discipline + Title + Revision */}
                    <div className="flex gap-1.5">
                      <select
                        value={editForm.discipline}
                        onChange={e => setEditForm(f => ({ ...f, discipline: e.target.value }))}
                        className="w-16 px-1 py-1 bg-white border border-gray-300 rounded text-[10px] text-gray-800 focus:outline-none focus:border-sky-500"
                      >
                        <option value="">분야</option>
                        {Object.entries(DISCIPLINES).map(([k, v]) => (
                          <option key={k} value={k}>{v.label}</option>
                        ))}
                      </select>
                      <input
                        value={editForm.title}
                        onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                        placeholder="도면 타이틀"
                        className="flex-1 px-2 py-1 bg-white border border-gray-300 rounded text-xs text-gray-800 focus:outline-none focus:border-sky-500"
                      />
                      <input
                        value={editForm.revision}
                        onChange={e => setEditForm(f => ({ ...f, revision: e.target.value }))}
                        placeholder="Rev"
                        className="w-14 px-1.5 py-1 bg-white border border-gray-300 rounded text-xs text-gray-800 focus:outline-none focus:border-sky-500 text-center"
                      />
                    </div>
                    {/* Row 2: Drawing Number */}
                    <input
                      value={editForm.drawing_number}
                      onChange={e => setEditForm(f => ({ ...f, drawing_number: e.target.value }))}
                      placeholder="도면번호 (DWG No.)"
                      className="w-full px-2 py-1 bg-white border border-gray-300 rounded text-xs text-gray-800 focus:outline-none focus:border-sky-500"
                    />
                    {/* Row 3: Vendor + Issue Purpose */}
                    <div className="flex gap-1.5">
                      <input
                        value={editForm.vendor_name}
                        onChange={e => setEditForm(f => ({ ...f, vendor_name: e.target.value }))}
                        placeholder="Vendor명"
                        className="flex-1 px-2 py-1 bg-white border border-gray-300 rounded text-xs text-gray-800 focus:outline-none focus:border-sky-500"
                      />
                      <select
                        value={editForm.issue_purpose}
                        onChange={e => setEditForm(f => ({ ...f, issue_purpose: e.target.value }))}
                        className="w-20 px-1 py-1 bg-white border border-gray-300 rounded text-[10px] text-gray-800 focus:outline-none focus:border-sky-500"
                      >
                        <option value="">발행목적</option>
                        <option value="IFA">IFA</option>
                        <option value="IFI">IFI</option>
                        <option value="IFC">IFC</option>
                        <option value="As-Built">As-Built</option>
                      </select>
                    </div>
                    {/* Save / Cancel */}
                    <div className="flex gap-1.5 pt-0.5">
                      <button onClick={e => handleSaveDrawingEdit(d.drawing_id, e)}
                              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-sky-500 hover:bg-sky-400 text-white rounded text-[10px] font-medium">
                        <Check className="w-3 h-3" /> 저장
                      </button>
                      <button onClick={e => { e.stopPropagation(); setEditingDrawing(null); }}
                              className="px-2 py-1 bg-gray-200 hover:bg-gray-300 text-gray-600 rounded text-[10px]">
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Normal Display Mode */
                  <>
                    {/* Row 1: Discipline badge + Title + Rev badge + edit/delete */}
                    <div className="flex items-start justify-between gap-1">
                      <div className="min-w-0 flex-1 flex items-start gap-1.5">
                        {d.discipline && DISCIPLINES[d.discipline] && (
                          <span className={`text-[9px] px-1 py-0.5 rounded font-bold flex-shrink-0 ${DISCIPLINES[d.discipline].bg} ${DISCIPLINES[d.discipline].text}`}>
                            {DISCIPLINES[d.discipline].label}
                          </span>
                        )}
                        <p className="text-xs font-semibold text-gray-800 truncate leading-tight">{d.title || 'Untitled'}</p>
                      </div>
                      <div className="flex items-center gap-1 ml-1 flex-shrink-0">
                        <button onClick={e => handleEditDrawing(d, e)} title="Edit"
                                className="p-0.5 text-gray-400 hover:text-sky-600 opacity-0 group-hover/item:opacity-100 transition-all">
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button onClick={e => handleDeleteDrawing(d.drawing_id, e)} title="Delete"
                                className="p-0.5 text-gray-400 hover:text-red-600 opacity-0 group-hover/item:opacity-100 transition-all">
                          <Trash2 className="w-3 h-3" />
                        </button>
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500 font-medium">Rev.{d.current_revision || '-'}</span>
                      </div>
                    </div>
                    {/* Row 2: DWG No. label + drawing number */}
                    <p className="text-[11px] text-gray-400 truncate mt-1">
                      <span className="text-gray-400 font-medium">DWG No.</span> {d.drawing_number || 'No Number'}
                    </p>
                    {/* Row 3: Vendor + Issue Purpose + DWG badge */}
                    <div className="flex items-center gap-1.5 mt-1">
                      {d.vendor_name && (
                        <span className="text-[9px] text-gray-400 truncate max-w-[80px]">{d.vendor_name}</span>
                      )}
                      {d.vendor_name && (d.issue_purpose || d.has_dwg) && <span className="text-gray-300">│</span>}
                      {d.issue_purpose && (
                        <span className={`text-[8px] px-1 py-0.5 rounded font-bold ${
                          d.issue_purpose === 'IFC' ? 'bg-green-50 text-green-600' :
                          d.issue_purpose === 'IFA' ? 'bg-amber-50 text-amber-600' :
                          d.issue_purpose === 'IFI' ? 'bg-blue-50 text-blue-600' :
                          d.issue_purpose === 'As-Built' ? 'bg-purple-50 text-purple-600' :
                          'bg-gray-100 text-gray-500'
                        }`}>{d.issue_purpose}</span>
                      )}
                      {d.has_dwg && (
                        <span className="text-[8px] px-1 py-0.5 rounded bg-cyan-50 text-cyan-600 font-medium" title="DWG 파일 있음">DWG</span>
                      )}
                    </div>
                    {/* Row 4: Discipline review status with abbreviations + EM approval */}
                    <div className="flex items-center justify-between mt-1.5">
                      <div className="flex items-center gap-1">
                        {Object.entries(d.review_status || {}).map(([disc, rs]) => (
                          <span key={disc} className="flex items-center gap-0.5" title={`${DISCIPLINES[disc]?.label}: ${REVIEW_STATUSES[rs.status]?.label || rs.status}`}>
                            <span className={`w-2 h-2 rounded-full ${
                              rs.status === 'completed' ? 'bg-green-400' :
                              rs.status === 'in_progress' ? 'bg-blue-400' :
                              rs.status === 'rejected' ? 'bg-red-400' : 'bg-gray-300'
                            }`} />
                            <span className={`text-[9px] ${
                              rs.status === 'completed' ? 'text-green-600' :
                              rs.status === 'in_progress' ? 'text-blue-600' :
                              rs.status === 'rejected' ? 'text-red-600' : 'text-gray-400'
                            }`}>{DISCIPLINES[disc]?.label?.[0] || disc[0]}</span>
                          </span>
                        ))}
                      </div>
                      {d.em_approval?.status === 'approved' && (
                        <span className="flex items-center gap-0.5 text-[9px] text-green-600">
                          <CheckCircle2 className="w-3 h-3" /> 승인
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
            {filteredDrawings.length === 0 && (
              <div className="p-6 text-center text-gray-400 text-xs">
                {drawings.length === 0 ? '도면을 업로드해 주세요' : '검색 결과가 없습니다'}
              </div>
            )}
          </div>

          {/* User Profile Footer */}
          <div className="p-3 border-t border-gray-200 bg-gray-100 mt-auto">
            <div className="flex items-center justify-between gap-2">
              <Link to="/profile" className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer hover:bg-white p-1.5 -ml-1.5 rounded-lg transition-colors group">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-sky-500 to-cyan-500 flex items-center justify-center text-white font-bold shrink-0 group-hover:scale-105 transition-transform text-sm">
                  {(currentUser?.displayName || currentUser?.email || 'U')[0].toUpperCase()}
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium text-gray-800 truncate">{currentUser?.displayName || 'User'}</span>
                  <span className="text-[10px] text-gray-400 truncate">{currentUser?.email}</span>
                </div>
              </Link>
              <button
                onClick={async () => { try { await logout(); navigate('/login'); } catch {} }}
                className="p-2 hover:bg-white text-gray-400 hover:text-sky-600 rounded-md transition-colors"
                title="로그아웃"
              >
                <LogOut size={18} />
              </button>
            </div>
          </div>
          {/* Left resize handle */}
          <div
            className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-sky-200 transition-colors z-10"
            onMouseDown={(e) => { e.preventDefault(); isResizingLeft.current = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; }}
          />
        </div>

        {/* Center Panel - PDF Viewer */}
        <div className="flex-1 flex flex-col overflow-hidden bg-white/80">
          {/* Diff revision selector */}
          {diffRevSelecting && selectedDrawing && (selectedDrawing.revisions || []).length >= 2 && (
            <div className="px-3 py-2 bg-gray-100 border-b border-gray-200 flex items-center gap-2 flex-shrink-0">
              <GitCompare className="w-4 h-4 text-sky-600 flex-shrink-0" />
              <select value={diffRevA} onChange={e => setDiffRevA(e.target.value)}
                      className="px-2 py-1 bg-white border border-gray-300 rounded text-xs text-gray-800 focus:outline-none">
                <option value="">Before...</option>
                {(selectedDrawing.revisions || []).map(r => (
                  <option key={r.revision_id} value={r.revision_id}>Rev.{r.revision} ({r.revision_id})</option>
                ))}
              </select>
              <span className="text-xs text-gray-400">vs</span>
              <select value={diffRevB} onChange={e => setDiffRevB(e.target.value)}
                      className="px-2 py-1 bg-white border border-gray-300 rounded text-xs text-gray-800 focus:outline-none">
                <option value="">After...</option>
                {(selectedDrawing.revisions || []).map(r => (
                  <option key={r.revision_id} value={r.revision_id}>Rev.{r.revision} ({r.revision_id})</option>
                ))}
              </select>
              <button onClick={handleOpenDiff} disabled={!diffRevA || !diffRevB || diffRevA === diffRevB}
                      className="px-2.5 py-1 bg-sky-500 hover:bg-sky-400 disabled:bg-gray-300 text-white rounded text-xs font-medium">
                비교
              </button>
              <button onClick={() => setDiffRevSelecting(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Revision compare button */}
          {selectedDrawing && (selectedDrawing.revisions || []).length >= 2 && !diffRevSelecting && (
            <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
              <span className="text-[10px] text-gray-400">리비전 {(selectedDrawing.revisions || []).length}개</span>
              <button onClick={() => { setDiffRevSelecting(true); setDiffRevA(''); setDiffRevB(''); }}
                      className="flex items-center gap-1 px-2 py-1 bg-sky-100 text-sky-600 rounded text-[10px] hover:bg-sky-100 transition-colors">
                <GitCompare className="w-3 h-3" /> 리비전 비교
              </button>
            </div>
          )}

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
                      <g key={m.markup_id} onClick={(e) => { e.stopPropagation(); setSelectedMarkup(m); setRightTab('markup'); }}
                         style={{ cursor: 'pointer' }}>
                        {isSelected && (
                          <circle cx={cx} cy={cy} r="18" fill="none" stroke={discColor} strokeWidth="2" strokeDasharray="4" opacity="0.7">
                            <animate attributeName="r" values="16;20;16" dur="1.5s" repeatCount="indefinite" />
                          </circle>
                        )}
                        <circle cx={cx} cy={cy} r="10"
                                fill={discColor}
                                fillOpacity={m.status === 'resolved' ? 0.4 : m.status === 'confirmed' ? 1 : 0.85}
                                stroke={m.status === 'confirmed' ? '#22c55e' : 'white'} strokeWidth={m.status === 'confirmed' ? 3 : 2} />
                        {(m.status === 'resolved' || m.status === 'confirmed') && (
                          <path d={`M${cx-4} ${cy} L${cx-1} ${cy+3} L${cx+5} ${cy-3}`} stroke="white" strokeWidth="2" fill="none" />
                        )}
                        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle"
                              fill="white" fontSize="8" fontWeight="bold">
                          {m.status !== 'resolved' && m.status !== 'confirmed' ? (markups.indexOf(m) + 1) : ''}
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
            <div className="flex-1 flex items-center justify-center text-gray-400">
              <div className="text-center">
                <FileText className="w-16 h-16 mx-auto mb-4 opacity-30" />
                <p className="text-lg">도면을 선택하세요</p>
                <p className="text-sm mt-1">또는 새 PDF를 업로드하세요</p>
              </div>
            </div>
          )}
        </div>

        {/* Right Panel - Comments / Review */}
        <div className="border-l border-gray-200 flex flex-col flex-shrink-0 bg-gray-50 relative" style={{ width: rightWidth, minWidth: 280, maxWidth: 600 }}>
          {/* Right resize handle */}
          <div
            className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-sky-200 transition-colors z-10"
            onMouseDown={(e) => { e.preventDefault(); isResizingRight.current = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; }}
          />
          {/* Tabs - EPC 5-Step Workflow */}
          <div className="flex border-b border-gray-200 flex-shrink-0">
            {[
              { key: 'intake', label: '① 접수', icon: Inbox },
              { key: 'assign', label: '② 할당', icon: UserCheck },
              { key: 'markup', label: '③ 마크업', icon: MapPin },
              { key: 'consolidate', label: '④ 종합', icon: GitMerge },
              { key: 'return', label: '⑤ 회신', icon: Reply },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setRightTab(tab.key)}
                className={`flex-1 flex items-center justify-center gap-1 px-2 py-2.5 text-[10px] font-medium transition-colors ${
                  rightTab === tab.key
                    ? 'text-sky-600 border-b-2 border-sky-500'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                <tab.icon className="w-3 h-3" /> {tab.label}
              </button>
            ))}
            {/* Activity history icon button */}
            <button
              onClick={() => setShowActivityDrawer(!showActivityDrawer)}
              className={`px-2 py-2.5 transition-colors ${showActivityDrawer ? 'text-sky-600' : 'text-gray-400 hover:text-gray-600'}`}
              title="활동 이력"
            >
              <History className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-auto">

            {/* ── ① 접수 (Intake) Tab ── */}
            {rightTab === 'intake' && (
              <div className="flex flex-col h-full">
                <div className="p-3 border-b border-gray-200 flex-shrink-0">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-500">접수 대기 / 완료</p>
                    {selectedDrawing && (
                      <button onClick={() => setShowNewRequest(true)}
                              className="flex items-center gap-1 px-2 py-1 bg-sky-100 text-sky-600 rounded text-[10px] hover:bg-sky-100">
                        <Plus className="w-3 h-3" /> 요청 생성
                      </button>
                    )}
                  </div>
                </div>

                {/* New request form */}
                {showNewRequest && selectedDrawing && (
                  <div className="p-3 border-b border-gray-200 space-y-2 bg-white/80 flex-shrink-0">
                    <p className="text-xs font-medium text-gray-600">새 검토 요청</p>
                    <select
                      value={requestForm.to_name}
                      onChange={e => setRequestForm(f => ({ ...f, to_name: e.target.value }))}
                      className="w-full px-2 py-1.5 bg-white border border-gray-300 rounded text-xs text-gray-800 focus:outline-none focus:border-sky-500"
                    >
                      <option value="">담당자 선택</option>
                      {userList.map(u => (
                        <option key={u.uid} value={u.name || u.email}>{u.name}{u.email ? ` (${u.email})` : ''}</option>
                      ))}
                    </select>
                    <div className="flex gap-1.5">
                      <select
                        value={requestForm.discipline}
                        onChange={e => setRequestForm(f => ({ ...f, discipline: e.target.value }))}
                        className="flex-1 px-2 py-1.5 bg-white border border-gray-300 rounded text-xs text-gray-800 focus:outline-none"
                      >
                        {Object.entries(DISCIPLINES).map(([k, v]) => (
                          <option key={k} value={k}>{v.label}</option>
                        ))}
                      </select>
                      <select
                        value={requestForm.priority}
                        onChange={e => setRequestForm(f => ({ ...f, priority: e.target.value }))}
                        className="w-20 px-2 py-1.5 bg-white border border-gray-300 rounded text-xs text-gray-800 focus:outline-none"
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
                      className="w-full px-2 py-1.5 bg-white border border-gray-300 rounded text-xs text-gray-800 focus:outline-none focus:border-sky-500"
                    />
                    <textarea
                      value={requestForm.message}
                      onChange={e => setRequestForm(f => ({ ...f, message: e.target.value }))}
                      placeholder="상세 내용 (선택사항)"
                      className="w-full px-2 py-1.5 bg-white border border-gray-300 rounded text-xs text-gray-800 focus:outline-none focus:border-sky-500 resize-none"
                      rows={2}
                    />
                    <div className="flex gap-1.5">
                      <button onClick={handleCreateRequest}
                              className="flex-1 px-2 py-1.5 bg-sky-500 hover:bg-sky-400 text-white rounded text-xs font-medium">
                        요청 보내기
                      </button>
                      <button onClick={() => setShowNewRequest(false)}
                              className="px-2 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-600 rounded text-xs">
                        취소
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex-1 overflow-auto">
                  {/* Intake pending (newly created requests) */}
                  {(() => {
                    const intakeRequests = reviewRequests.filter(r => r.status === 'intake' || r.status === 'requested');
                    const acceptedRequests = reviewRequests.filter(r => !['intake', 'requested', 'rejected'].includes(r.status));
                    const rejectedRequests = reviewRequests.filter(r => r.status === 'rejected');
                    return (
                      <>
                        {intakeRequests.length > 0 && (
                          <div className="p-3 space-y-2">
                            <p className="text-[10px] font-medium text-amber-600">접수 대기 ({intakeRequests.length}건)</p>
                            {intakeRequests.map(r => {
                              const drawing = (projectDetail?.drawings || []).find(d => d.drawing_id === r.drawing_id);
                              return (
                                <div key={r.request_id} className="bg-gray-50 rounded-lg p-2.5 space-y-2">
                                  <div className="flex items-center gap-1.5">
                                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DISCIPLINES[r.discipline]?.color }} />
                                    <span className="text-xs font-medium text-gray-800 flex-1 truncate">{r.title}</span>
                                    {r.priority === 'urgent' && <AlertTriangle className="w-3 h-3 text-red-600" />}
                                  </div>
                                  <div className="text-[10px] text-gray-400 space-y-0.5">
                                    <p>도면: <span className="text-gray-600">{r.drawing_number || drawing?.drawing_number || '-'}</span></p>
                                    <p>리비전: <span className="text-gray-600">{drawing?.current_revision || '-'}</span></p>
                                    <p>Issue Purpose: <span className="text-gray-600">{drawing?.issue_purpose || '-'}</span></p>
                                    <p>VDRL: <span className={drawing?.vdrl_match ? 'text-green-600' : 'text-gray-400'}>{drawing?.vdrl_match ? '✓ 매치' : '— 미확인'}</span></p>
                                  </div>
                                  <input
                                    value={intakeComment}
                                    onChange={e => setIntakeComment(e.target.value)}
                                    placeholder="접수/반려 코멘트..."
                                    className="w-full px-2 py-1 bg-white border border-gray-300 rounded text-[10px] text-gray-800 focus:outline-none"
                                  />
                                  <div className="flex gap-1.5">
                                    <button onClick={() => handleIntakeDecision(r.request_id, r.drawing_id, 'accepted')}
                                            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-green-50 text-green-600 rounded text-[10px] hover:bg-green-100">
                                      <Check className="w-3 h-3" /> 접수
                                    </button>
                                    <button onClick={() => handleIntakeDecision(r.request_id, r.drawing_id, 'rejected_intake')}
                                            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-red-50 text-red-600 rounded text-[10px] hover:bg-red-100">
                                      <XCircle className="w-3 h-3" /> 반려
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {acceptedRequests.length > 0 && (
                          <div className="p-3 space-y-1.5 border-t border-gray-200">
                            <p className="text-[10px] font-medium text-green-600">접수 완료 ({acceptedRequests.length}건)</p>
                            {acceptedRequests.slice(0, 10).map(r => (
                              <div key={r.request_id} className="flex items-center gap-2 p-1.5 bg-white/80 rounded">
                                <CheckCircle2 className="w-3 h-3 text-green-600 flex-shrink-0" />
                                <span className="text-[10px] text-gray-600 flex-1 truncate">{r.title}</span>
                                <span className="text-[9px] text-gray-400">{r.drawing_number}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {rejectedRequests.length > 0 && (
                          <div className="p-3 space-y-1.5 border-t border-gray-200">
                            <p className="text-[10px] font-medium text-red-600">반려 ({rejectedRequests.length}건)</p>
                            {rejectedRequests.map(r => (
                              <div key={r.request_id} className="flex items-center gap-2 p-1.5 bg-white/80 rounded">
                                <XCircle className="w-3 h-3 text-red-600 flex-shrink-0" />
                                <span className="text-[10px] text-gray-500 flex-1 truncate">{r.title}</span>
                                <button onClick={() => handleUpdateRequestStatus(r.request_id, 'intake')}
                                        className="text-[9px] text-amber-600 hover:text-amber-600">재접수</button>
                              </div>
                            ))}
                          </div>
                        )}
                        {reviewRequests.length === 0 && (
                          <div className="p-6 text-center text-gray-400 text-xs">
                            {selectedDrawing ? '검토 요청이 없습니다' : '도면을 선택해 주세요'}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* ── ② 할당 (Assignment) Tab ── */}
            {rightTab === 'assign' && (
              <div className="flex flex-col h-full">
                <div className="p-3 border-b border-gray-200 flex-shrink-0">
                  <p className="text-xs text-gray-500">검토 할당</p>
                </div>
                <div className="flex-1 overflow-auto p-3 space-y-3">
                  {/* Requests ready for assignment (intake done, not yet assigned) */}
                  {(() => {
                    const assignableRequests = reviewRequests.filter(r => r.status === 'intake' || (r.status === 'requested' && !r.lead_reviewer));
                    const assignedRequests = reviewRequests.filter(r => r.status === 'assigned' || r.status === 'markup_in_progress' || r.status === 'markup_done');
                    return (
                      <>
                        {assignableRequests.length > 0 && (
                          <div className="space-y-2">
                            <p className="text-[10px] font-medium text-amber-600">할당 대기 ({assignableRequests.length}건)</p>
                            {assignableRequests.map(r => (
                              <div key={r.request_id} className="bg-gray-50 rounded-lg p-2.5 space-y-2">
                                <div className="flex items-center gap-1.5">
                                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DISCIPLINES[r.discipline]?.color }} />
                                  <span className="text-xs text-gray-800 flex-1 truncate">{r.title}</span>
                                </div>
                                <div className="space-y-1.5">
                                  <select
                                    value={assignForm.lead_reviewer}
                                    onChange={e => setAssignForm(f => ({ ...f, lead_reviewer: e.target.value }))}
                                    className="w-full px-2 py-1 bg-white border border-gray-300 rounded text-[10px] text-gray-800 focus:outline-none focus:border-sky-500"
                                  >
                                    <option value="">주 담당자 (Lead) 선택</option>
                                    {userList.map(u => (
                                      <option key={u.uid} value={u.name || u.email}>{u.name}{u.email ? ` (${u.email})` : ''}</option>
                                    ))}
                                  </select>
                                  <select
                                    value=""
                                    onChange={e => {
                                      const val = e.target.value;
                                      if (!val) return;
                                      const current = assignForm.squad_reviewers ? assignForm.squad_reviewers.split(',').map(s => s.trim()).filter(Boolean) : [];
                                      if (!current.includes(val)) {
                                        setAssignForm(f => ({ ...f, squad_reviewers: [...current, val].join(', ') }));
                                      }
                                    }}
                                    className="w-full px-2 py-1 bg-white border border-gray-300 rounded text-[10px] text-gray-800 focus:outline-none"
                                  >
                                    <option value="">협조 검토자 추가</option>
                                    {userList.filter(u => (u.name || u.email) !== assignForm.lead_reviewer).map(u => (
                                      <option key={u.uid} value={u.name || u.email}>{u.name}{u.email ? ` (${u.email})` : ''}</option>
                                    ))}
                                  </select>
                                  {assignForm.squad_reviewers && (
                                    <div className="flex flex-wrap gap-1">
                                      {assignForm.squad_reviewers.split(',').map(s => s.trim()).filter(Boolean).map(name => (
                                        <span key={name} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-gray-200 rounded text-[9px] text-gray-600">
                                          {name}
                                          <button onClick={() => {
                                            const updated = assignForm.squad_reviewers.split(',').map(s => s.trim()).filter(s => s && s !== name).join(', ');
                                            setAssignForm(f => ({ ...f, squad_reviewers: updated }));
                                          }} className="text-gray-400 hover:text-red-600 ml-0.5">×</button>
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  <input
                                    type="date"
                                    value={assignForm.due_date}
                                    onChange={e => setAssignForm(f => ({ ...f, due_date: e.target.value }))}
                                    className="w-full px-2 py-1 bg-white border border-gray-300 rounded text-[10px] text-gray-800 focus:outline-none"
                                  />
                                  <button onClick={() => handleAssignReviewers(r.request_id)}
                                          className="w-full flex items-center justify-center gap-1 px-2 py-1 bg-sky-100 text-sky-600 rounded text-[10px] hover:bg-sky-100">
                                    <UserCheck className="w-3 h-3" /> 할당
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {assignedRequests.length > 0 && (
                          <div className="space-y-2">
                            <p className="text-[10px] font-medium text-sky-600">할당 완료 ({assignedRequests.length}건)</p>
                            {assignedRequests.map(r => {
                              const dueDate = r.due_date;
                              let daysLeft = null;
                              if (dueDate) {
                                const diff = Math.ceil((new Date(dueDate) - new Date()) / (1000 * 60 * 60 * 24));
                                daysLeft = diff;
                              }
                              const reviewerStatuses = r.reviewer_statuses || {};
                              return (
                                <div key={r.request_id} className="bg-gray-50 rounded-lg p-2.5 space-y-1.5">
                                  <div className="flex items-center gap-1.5">
                                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DISCIPLINES[r.discipline]?.color }} />
                                    <span className="text-xs text-gray-800 flex-1 truncate">{r.title}</span>
                                    {daysLeft !== null && (
                                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                                        daysLeft <= 3 ? 'bg-red-50 text-red-600' :
                                        daysLeft <= 7 ? 'bg-amber-50 text-amber-600' :
                                        'bg-white text-gray-500'
                                      }`}>
                                        D{daysLeft > 0 ? `-${daysLeft}` : daysLeft === 0 ? '-Day' : `+${Math.abs(daysLeft)}`}
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[10px] text-gray-400">
                                    <span>Lead: <span className="text-sky-600">{r.lead_reviewer || r.to_name}</span></span>
                                    {(r.squad_reviewers || []).length > 0 && (
                                      <span className="ml-2">Squad: <span className="text-gray-600">{r.squad_reviewers.join(', ')}</span></span>
                                    )}
                                  </div>
                                  {/* Reviewer status dots */}
                                  {Object.keys(reviewerStatuses).length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 mt-1">
                                      {Object.entries(reviewerStatuses).map(([name, rs]) => (
                                        <span key={name} className="flex items-center gap-1 text-[9px]">
                                          <span className={`w-2 h-2 rounded-full ${
                                            rs.status === 'done' ? 'bg-green-400' :
                                            rs.status === 'in_progress' ? 'bg-blue-400' :
                                            'bg-gray-400'
                                          }`} />
                                          <span className="text-gray-500">{name}</span>
                                          {rs.role === 'lead' && <span className="text-[8px] text-sky-600">(L)</span>}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  <div className="flex gap-1 mt-1">
                                    <button onClick={() => handleStartMarkup(r)}
                                            className="flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-600 rounded text-[9px] hover:bg-blue-100">
                                      <MapPin className="w-2.5 h-2.5" /> 마크업
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {assignableRequests.length === 0 && assignedRequests.length === 0 && (
                          <div className="p-6 text-center text-gray-400 text-xs">
                            할당할 요청이 없습니다
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* ── ③ 마크업 (Markup) Tab ── */}
            {rightTab === 'markup' && (
              <div className="flex flex-col h-full">
                {/* Reviewer Progress Bar */}
                {(() => {
                  const activeReq = activeRequestId
                    ? reviewRequests.find(r => r.request_id === activeRequestId)
                    : reviewRequests.find(r => r.status === 'assigned' || r.status === 'markup_in_progress');
                  if (!activeReq?.reviewer_statuses || Object.keys(activeReq.reviewer_statuses).length === 0) return null;
                  const rs = activeReq.reviewer_statuses;
                  const total = Object.keys(rs).length;
                  const done = Object.values(rs).filter(s => s.status === 'done').length;
                  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                  return (
                    <div className="px-3 py-2 border-b border-gray-200 flex-shrink-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <Users className="w-3 h-3 text-gray-500" />
                        <span className="text-[10px] text-gray-500">검토 진행률</span>
                        <span className="text-[10px] text-sky-600 ml-auto">{done}/{total} ({pct}%)</span>
                      </div>
                      <div className="w-full h-1.5 bg-gray-200 rounded-full mb-1.5">
                        <div className="h-1.5 bg-sky-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(rs).map(([name, s]) => (
                          <span key={name} className="flex items-center gap-1 text-[9px]">
                            <span className={`w-2 h-2 rounded-full ${
                              s.status === 'done' ? 'bg-green-400' : s.status === 'in_progress' ? 'bg-blue-400 animate-pulse' : 'bg-gray-400'
                            }`} />
                            <span className="text-gray-500">{name}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Active Request Banner */}
                {activeRequestId && (() => {
                  const req = reviewRequests.find(r => r.request_id === activeRequestId);
                  return req ? (
                    <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 flex items-center justify-between flex-shrink-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <ClipboardList className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
                        <span className="text-[10px] text-amber-600 truncate">요청 연결중: {req.title}</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                        {(req.status === 'markup_in_progress') && (
                          <button onClick={() => { handleUpdateRequestStatus(req.request_id, 'markup_done'); handleStopMarkup(); setRightTab('consolidate'); }}
                                  className="flex items-center gap-1 px-2 py-0.5 bg-purple-50 text-purple-600 rounded text-[9px] hover:bg-purple-100">
                            <Check className="w-3 h-3" /> 마크업 완료
                          </button>
                        )}
                        <button onClick={handleStopMarkup} className="text-amber-600 hover:text-amber-600">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ) : null;
                })()}
                {selectedMarkup && !selectedMarkup._pending ? (
                  /* Selected Markup Detail */
                  <div className="flex flex-col h-full">
                    <div className="p-3 border-b border-gray-200">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: DISCIPLINES[selectedMarkup.discipline]?.color }} />
                          <span className="text-xs font-medium text-gray-600">{DISCIPLINES[selectedMarkup.discipline]?.label}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                            selectedMarkup.status === 'open' ? 'bg-amber-50 text-amber-600' : 'bg-green-50 text-green-600'
                          }`}>
                            {selectedMarkup.status}
                          </span>
                        </div>
                        <button onClick={() => setSelectedMarkup(null)} className="text-gray-400 hover:text-gray-600">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <p className="text-sm text-gray-800 mt-2">{selectedMarkup.comment}</p>
                      <p className="text-[10px] text-gray-400 mt-1">
                        작성자: <span className="text-sky-600">{selectedMarkup.author_name}</span> | P.{selectedMarkup.page} | {new Date(selectedMarkup.created_at).toLocaleString()}
                      </p>
                      {selectedMarkup.request_id && (
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          요청 연결: <span className="text-sky-600/70">{selectedMarkup.request_id}</span>
                        </p>
                      )}
                      <div className="flex gap-1.5 mt-2 flex-wrap">
                        {selectedMarkup.status === 'open' && (
                          <>
                            <button onClick={() => handleResolveMarkup(selectedMarkup.markup_id)}
                                    className="flex items-center gap-1 px-2 py-1 bg-green-50 text-green-600 rounded text-[10px] hover:bg-green-100">
                              <Check className="w-3 h-3" /> 해결
                            </button>
                            <button onClick={() => handleConfirmMarkup(selectedMarkup.markup_id)}
                                    className="flex items-center gap-1 px-2 py-1 bg-sky-100 text-sky-600 rounded text-[10px] hover:bg-sky-100">
                              <CheckCircle2 className="w-3 h-3" /> 확정
                            </button>
                          </>
                        )}
                        {selectedMarkup.status === 'resolved' && (
                          <>
                            <button onClick={() => handleConfirmMarkup(selectedMarkup.markup_id)}
                                    className="flex items-center gap-1 px-2 py-1 bg-sky-100 text-sky-600 rounded text-[10px] hover:bg-sky-100">
                              <CheckCircle2 className="w-3 h-3" /> 확정
                            </button>
                            <button onClick={() => handleReopenMarkup(selectedMarkup.markup_id)}
                                    className="flex items-center gap-1 px-2 py-1 bg-amber-50 text-amber-600 rounded text-[10px] hover:bg-amber-100">
                              <RotateCcw className="w-3 h-3" /> 재오픈
                            </button>
                          </>
                        )}
                        {selectedMarkup.status === 'confirmed' && (
                          <span className="flex items-center gap-1 px-2 py-1 bg-sky-100 text-sky-600 rounded text-[10px]">
                            <CheckCircle2 className="w-3 h-3" /> 확정됨
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Replies */}
                    <div className="flex-1 overflow-auto p-3 space-y-2">
                      {(selectedMarkup.replies || []).map(r => (
                        <div key={r.reply_id} className="bg-gray-50 rounded-lg p-2.5">
                          <p className="text-xs text-gray-600">{r.content}</p>
                          <p className="text-[10px] text-gray-400 mt-1"><span className="text-sky-600">{r.author_name}</span> | {new Date(r.created_at).toLocaleString()}</p>
                        </div>
                      ))}
                    </div>

                    {/* Reply Input */}
                    <div className="p-3 border-t border-gray-200 flex-shrink-0">
                      <div className="flex gap-2">
                        <input
                          value={replyText}
                          onChange={e => setReplyText(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleAddReply()}
                          placeholder="답글 입력..."
                          className="flex-1 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-600 placeholder-gray-400 focus:outline-none focus:border-sky-300"
                        />
                        <button onClick={handleAddReply} className="p-1.5 bg-sky-500 hover:bg-sky-400 text-white rounded-lg">
                          <Send className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ) : selectedMarkup?._pending ? (
                  /* New Pin Comment Input + AI Suggestion Chips (Feature 4) */
                  <div className="p-4 flex flex-col h-full overflow-auto">
                    <div className="flex items-center gap-2 mb-3">
                      <MapPin className="w-4 h-4 text-sky-600" />
                      <span className="text-sm font-medium text-gray-800">새 마크업</span>
                      <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: DISCIPLINES[selectedMarkup.discipline]?.color + '33', color: DISCIPLINES[selectedMarkup.discipline]?.color }}>
                        {DISCIPLINES[selectedMarkup.discipline]?.label}
                      </span>
                    </div>
                    <textarea
                      value={newComment}
                      onChange={e => setNewComment(e.target.value)}
                      placeholder="코멘트를 입력하세요..."
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-600 placeholder-gray-400 focus:outline-none focus:border-sky-300 resize-none"
                      rows={3}
                      autoFocus
                    />

                    {/* AI Suggestion Chips - nearby words */}
                    {(loadingNearby || nearbyWords.length > 0) && (
                      <div className="mt-2">
                        <div className="flex items-center gap-1.5 mb-1">
                          <Sparkles className="w-3 h-3 text-amber-600" />
                          <span className="text-[10px] text-amber-600 font-medium">AI 추천 텍스트</span>
                          {loadingNearby && <Loader2 className="w-3 h-3 text-amber-600 animate-spin" />}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {nearbyWords.map((w, i) => (
                            <button
                              key={i}
                              onClick={() => setNewComment(prev => prev + (prev ? ' ' : '') + w.content)}
                              className="px-1.5 py-0.5 bg-amber-50 border border-amber-200 text-amber-600 rounded text-[10px] hover:bg-amber-50 transition-colors"
                              title={`Confidence: ${Math.round(w.confidence * 100)}%`}
                            >
                              {w.content}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Nearby lines */}
                    {nearbyLines.length > 0 && (
                      <div className="mt-2">
                        <span className="text-[10px] text-gray-400 mb-1 block">주변 텍스트 라인</span>
                        <div className="space-y-0.5 max-h-24 overflow-auto">
                          {nearbyLines.map((l, i) => (
                            <button
                              key={i}
                              onClick={() => setNewComment(prev => prev + (prev ? '\n' : '') + l.content)}
                              className="block w-full text-left px-2 py-0.5 bg-gray-50 text-[10px] text-gray-500 rounded hover:bg-white hover:text-gray-800 truncate transition-colors"
                            >
                              {l.content}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Related search button */}
                    <div className="mt-2">
                      <button
                        onClick={() => handleRelatedSearch(newComment || nearbyWords.map(w => w.content).join(' '))}
                        disabled={loadingRelated || (!newComment.trim() && nearbyWords.length === 0)}
                        className="flex items-center gap-1 px-2 py-1 bg-purple-50 border border-purple-200 text-purple-600 rounded text-[10px] hover:bg-purple-50 disabled:opacity-40 transition-colors"
                      >
                        {loadingRelated ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                        관련 이력 조회
                      </button>
                    </div>

                    {/* Related results */}
                    {(relatedResults.markups.length > 0 || relatedResults.documents.length > 0) && (
                      <div className="mt-2 space-y-1.5 max-h-40 overflow-auto">
                        {relatedResults.markups.length > 0 && (
                          <>
                            <span className="text-[10px] text-purple-600 font-medium block">관련 마크업 ({relatedResults.markups.length}건)</span>
                            {relatedResults.markups.map((rm, i) => (
                              <div key={i} className="px-2 py-1 bg-purple-50 border border-purple-200 rounded text-[10px]">
                                <p className="text-gray-600 truncate">{rm.comment}</p>
                                <p className="text-[9px] text-gray-400">{rm.discipline} · {rm.author_name} · {rm.status}</p>
                              </div>
                            ))}
                          </>
                        )}
                        {relatedResults.documents.length > 0 && (
                          <>
                            <span className="text-[10px] text-purple-600 font-medium block">관련 문서 ({relatedResults.documents.length}건)</span>
                            {relatedResults.documents.map((doc, i) => (
                              <div key={i} className="px-2 py-1 bg-purple-50 border border-purple-200 rounded text-[10px]">
                                <div className="flex items-center gap-1">
                                  <File className="w-3 h-3 text-purple-600 flex-shrink-0" />
                                  <p className="text-gray-600 truncate">{doc.title || 'Document'}</p>
                                </div>
                                <p className="text-[9px] text-gray-400 truncate">{doc.content_snippet}</p>
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    )}

                    <div className="flex gap-2 mt-3">
                      <button onClick={handleSaveNewMarkup}
                              className="flex-1 px-3 py-1.5 bg-sky-500 hover:bg-sky-400 text-white rounded-lg text-xs font-medium">
                        마크업 저장
                      </button>
                      <button onClick={() => { setSelectedMarkup(null); setIsPlacingPin(false); setNearbyWords([]); setNearbyLines([]); setRelatedResults({ markups: [], documents: [] }); }}
                              className="px-3 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-600 rounded-lg text-xs">
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  /* All Markups List */
                  <div className="p-3 space-y-2">
                    {selectedDrawing ? (
                      <>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs text-gray-400">마크업 {markups.length}건</p>
                          {markups.length > 0 && (
                            <button
                              onClick={handleExportMarkupPdf}
                              disabled={exportingPdf}
                              className="flex items-center gap-1 px-2 py-1 bg-purple-50 text-purple-600 rounded text-[10px] hover:bg-purple-100 disabled:opacity-40 transition-colors"
                            >
                              {exportingPdf ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileDown className="w-3 h-3" />}
                              마크업 PDF
                            </button>
                          )}
                        </div>
                        {markups.map((m, i) => (
                          <div
                            key={m.markup_id}
                            onClick={() => { setSelectedMarkup(m); setCurrentPage(m.page); }}
                            className="flex items-start gap-2.5 p-2.5 bg-gray-50 rounded-lg cursor-pointer hover:bg-white transition-colors"
                          >
                            <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                                 style={{ backgroundColor: DISCIPLINES[m.discipline]?.color || '#888', opacity: m.status === 'resolved' ? 0.5 : 1 }}>
                              {i + 1}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className={`text-xs ${m.status === 'resolved' ? 'text-gray-400 line-through' : 'text-gray-600'}`}>
                                {m.comment}
                              </p>
                              <p className="text-[10px] text-gray-400 mt-0.5">
                                P.{m.page} | {m.author_name} | 답글 {(m.replies || []).length}건
                              </p>
                            </div>
                          </div>
                        ))}
                      </>
                    ) : (
                      <p className="text-xs text-gray-400 text-center py-8">도면을 선택하면 마크업을 확인할 수 있습니다</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── ④ 종합 (Consolidation) Tab ── */}
            {rightTab === 'consolidate' && (
              <div className="flex flex-col h-full">
                <div className="p-3 border-b border-gray-200 flex-shrink-0">
                  <p className="text-xs text-gray-500">의견 종합 (Lead 확정)</p>
                </div>
                <div className="flex-1 overflow-auto p-3 space-y-3">
                  {(() => {
                    const consolidationRequests = reviewRequests.filter(r =>
                      r.status === 'markup_done' || r.status === 'consolidation' || r.status === 'feedback'
                    );
                    if (consolidationRequests.length === 0) return (
                      <div className="p-6 text-center text-gray-400 text-xs">의견 종합 대기중인 요청이 없습니다</div>
                    );
                    return consolidationRequests.map(r => {
                      const linkedMarkups = markups.filter(m => m.request_id === r.request_id || m.drawing_id === r.drawing_id);
                      const reviewerStatuses = r.reviewer_statuses || {};
                      const allDone = Object.values(reviewerStatuses).every(rs => rs.status === 'done');
                      const notDone = Object.entries(reviewerStatuses).filter(([, rs]) => rs.status !== 'done');
                      return (
                        <div key={r.request_id} className="bg-gray-50 rounded-lg p-3 space-y-2">
                          <div className="flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DISCIPLINES[r.discipline]?.color }} />
                            <span className="text-xs font-medium text-gray-800 flex-1 truncate">{r.title}</span>
                            <span className={`text-[9px] px-1 py-0.5 rounded ${
                              r.status === 'consolidation' ? 'bg-purple-50 text-purple-600' : 'bg-amber-50 text-amber-600'
                            }`}>{r.status === 'consolidation' ? '종합중' : '마크업완료'}</span>
                          </div>

                          {/* Reviewer completion status */}
                          {Object.keys(reviewerStatuses).length > 0 && (
                            <div>
                              <p className="text-[9px] text-gray-400 mb-1">검토자 현황</p>
                              <div className="flex flex-wrap gap-1">
                                {Object.entries(reviewerStatuses).map(([name, rs]) => (
                                  <span key={name} className={`text-[9px] px-1.5 py-0.5 rounded ${
                                    rs.status === 'done' ? 'bg-green-50 text-green-600' :
                                    rs.status === 'in_progress' ? 'bg-blue-50 text-blue-600' :
                                    'bg-white text-gray-400'
                                  }`}>
                                    {name} {rs.role === 'lead' ? '(L)' : ''} — {rs.status === 'done' ? '완료' : rs.status === 'in_progress' ? '진행중' : '대기'}
                                  </span>
                                ))}
                              </div>
                              {notDone.length > 0 && (
                                <p className="text-[9px] text-amber-600 mt-1">미완료: {notDone.map(([n]) => n).join(', ')}</p>
                              )}
                            </div>
                          )}

                          {/* Conflict detection button */}
                          <button
                            onClick={() => loadConflicts(r.request_id)}
                            className="w-full flex items-center justify-center gap-1 px-2 py-1 bg-amber-50 text-amber-600 rounded text-[9px] hover:bg-amber-50"
                          >
                            <AlertTriangle className="w-3 h-3" /> 충돌 감지
                          </button>

                          {/* Conflicts display */}
                          {conflicts.length > 0 && (
                            <div className="space-y-1">
                              <p className="text-[9px] text-red-600 font-medium">충돌 마크업 ({conflicts.length}건)</p>
                              {conflicts.map((c, i) => (
                                <div key={i} className="bg-red-50 border border-red-200 rounded p-1.5 text-[9px]">
                                  <div className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DISCIPLINES[c.markup_a.discipline]?.color }} />
                                    <span className="text-gray-600">{c.markup_a.comment?.substring(0, 30)}</span>
                                  </div>
                                  <div className="flex items-center gap-1 mt-0.5">
                                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DISCIPLINES[c.markup_b.discipline]?.color }} />
                                    <span className="text-gray-600">{c.markup_b.comment?.substring(0, 30)}</span>
                                  </div>
                                  <p className="text-gray-400 mt-0.5">페이지 {c.page} · 거리 {(c.distance * 100).toFixed(1)}%</p>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Markup list for adoption/exclusion */}
                          {linkedMarkups.length > 0 && (
                            <div>
                              <p className="text-[9px] text-gray-400 mb-1">마크업 ({linkedMarkups.length}건) — 최종 채택/제외</p>
                              <div className="space-y-1 max-h-40 overflow-auto">
                                {linkedMarkups.map((m, i) => (
                                  <div key={m.markup_id} className="flex items-center gap-1.5 p-1 bg-gray-100 rounded">
                                    <div className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[7px] font-bold flex-shrink-0"
                                         style={{ backgroundColor: DISCIPLINES[m.discipline]?.color || '#888' }}>{i + 1}</div>
                                    <span className={`text-[9px] flex-1 truncate ${m.status === 'final' ? 'text-green-600' : 'text-gray-600'}`}>{m.comment}</span>
                                    <span className={`text-[8px] px-1 py-0.5 rounded ${
                                      m.status === 'final' ? 'bg-green-50 text-green-600' : 'bg-white text-gray-400'
                                    }`}>{m.status === 'final' ? '채택' : m.status}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Consolidate action */}
                          <button
                            onClick={() => {
                              const finalIds = linkedMarkups.filter(m => m.status === 'final' || m.status === 'confirmed').map(m => m.markup_id);
                              handleConsolidate(r.request_id, finalIds);
                            }}
                            disabled={!allDone}
                            className={`w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[10px] font-medium ${
                              allDone
                                ? 'bg-purple-50 text-purple-600 hover:bg-purple-100'
                                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            }`}
                          >
                            <GitMerge className="w-3 h-3" /> 의견 종합 완료
                          </button>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            )}

            {/* ── ⑤ 회신 (Return & Transmittal) Tab ── */}
            {rightTab === 'return' && (
              <div className="flex flex-col h-full">
                <div className="p-3 border-b border-gray-200 flex-shrink-0">
                  <p className="text-xs text-gray-500">코드 부여 / 회신</p>
                </div>
                <div className="flex-1 overflow-auto p-3 space-y-4">
                  {/* Return Code Cards */}
                  {(() => {
                    const returnRequests = reviewRequests.filter(r =>
                      r.status === 'consolidation' || r.status === 'return_decided' || r.status === 'transmitted'
                    );
                    const codeCards = [
                      { code: 'code_1', label: 'Approved', desc: '이대로 제작/시공 진행', color: 'green' },
                      { code: 'code_2', label: 'Approved w/ Comments', desc: '코멘트대로 수정 조건부 진행', color: 'sky' },
                      { code: 'code_3', label: 'Returned', desc: '제작 중지, 수정 후 재제출', color: 'red' },
                      { code: 'code_4', label: 'For Info', desc: '참고용 접수 완료', color: 'slate' },
                    ];
                    return (
                      <>
                        {/* Requests needing return code */}
                        {returnRequests.filter(r => r.status === 'consolidation').map(r => (
                          <div key={r.request_id} className="space-y-2">
                            <div className="flex items-center gap-1.5 mb-2">
                              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DISCIPLINES[r.discipline]?.color }} />
                              <span className="text-xs font-medium text-gray-800 flex-1">{r.title}</span>
                            </div>
                            <p className="text-[10px] text-gray-400 mb-1">Return Code 선택</p>
                            <div className="grid grid-cols-2 gap-1.5">
                              {codeCards.map(card => {
                                const colorMap = {
                                  green: { bg: 'bg-green-50 hover:bg-green-50 border-green-200', text: 'text-green-600', activeBg: 'bg-green-100' },
                                  sky: { bg: 'bg-sky-50 hover:bg-sky-100 border-sky-200', text: 'text-sky-600', activeBg: 'bg-sky-100' },
                                  red: { bg: 'bg-red-50 hover:bg-red-50 border-red-200', text: 'text-red-600', activeBg: 'bg-red-100' },
                                  slate: { bg: 'bg-gray-50 hover:bg-gray-100 border-gray-200', text: 'text-gray-500', activeBg: 'bg-gray-200' },
                                };
                                const cm = colorMap[card.color];
                                const isSelected = returnCodeSelection === card.code;
                                return (
                                  <button
                                    key={card.code}
                                    onClick={() => setReturnCodeSelection(card.code)}
                                    className={`p-2 rounded-lg border text-left transition-all ${isSelected ? cm.activeBg + ' border-2' : cm.bg} border-${card.color}-500/30`}
                                  >
                                    <p className={`text-[10px] font-bold ${cm.text}`}>{card.label}</p>
                                    <p className="text-[8px] text-gray-400 mt-0.5">{card.desc}</p>
                                  </button>
                                );
                              })}
                            </div>
                            {returnCodeSelection && (
                              <button
                                onClick={() => { handleSetReturnCode(r.request_id, returnCodeSelection); setReturnCodeSelection(''); }}
                                className="w-full flex items-center justify-center gap-1 px-2 py-1.5 bg-sky-100 text-sky-600 rounded text-[10px] font-medium hover:bg-sky-100"
                              >
                                <Check className="w-3 h-3" /> 코드 확정
                              </button>
                            )}
                          </div>
                        ))}

                        {/* Return decided - ready for transmittal */}
                        {returnRequests.filter(r => r.status === 'return_decided').map(r => {
                          const codeInfo = codeCards.find(c => c.code === r.return_code);
                          const colorMap = { code_1: 'text-green-600', code_2: 'text-sky-600', code_3: 'text-red-600', code_4: 'text-gray-500' };
                          return (
                            <div key={r.request_id} className="bg-gray-50 rounded-lg p-3 space-y-2">
                              <div className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DISCIPLINES[r.discipline]?.color }} />
                                <span className="text-xs text-gray-800 flex-1 truncate">{r.title}</span>
                                <span className={`text-[10px] font-bold ${colorMap[r.return_code] || 'text-gray-500'}`}>
                                  {codeInfo?.label || r.return_code}
                                </span>
                              </div>

                              {/* Final markup summary */}
                              {(() => {
                                const linked = markups.filter(m => m.request_id === r.request_id || m.drawing_id === r.drawing_id);
                                const finalCount = linked.filter(m => m.status === 'final' || m.status === 'confirmed').length;
                                const byDisc = {};
                                linked.forEach(m => { byDisc[m.discipline] = (byDisc[m.discipline] || 0) + 1; });
                                return (
                                  <div className="text-[9px] text-gray-400">
                                    <span>마크업 {linked.length}건 (채택 {finalCount}건)</span>
                                    {Object.entries(byDisc).length > 0 && (
                                      <span className="ml-1">
                                        [{Object.entries(byDisc).map(([d, c]) => `${DISCIPLINES[d]?.label || d}: ${c}`).join(', ')}]
                                      </span>
                                    )}
                                  </div>
                                );
                              })()}

                              {/* Review Gate */}
                              {selectedDrawing && reviewGate && (
                                <div className={`rounded p-2 text-[9px] ${reviewGate.all_completed ? 'bg-green-50 text-green-600' : 'bg-amber-50 text-amber-600'}`}>
                                  Review Gate: {reviewGate.completion_rate}% ({reviewGate.all_completed ? '통과' : '미통과'})
                                </div>
                              )}

                              <div className="flex gap-1.5">
                                <button
                                  onClick={() => handleCreateTransmittal(r.request_id)}
                                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-sky-500 text-white rounded text-[10px] font-medium hover:bg-sky-400"
                                >
                                  <Send className="w-3 h-3" /> 회신 발송
                                </button>
                                {selectedDrawing && (
                                  <button
                                    onClick={handleExportMarkupPdf}
                                    disabled={exportingPdf}
                                    className="flex items-center gap-1 px-2 py-1.5 bg-purple-50 text-purple-600 rounded text-[10px] hover:bg-purple-100"
                                  >
                                    <FileDown className="w-3 h-3" /> {exportingPdf ? '...' : 'PDF'}
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}

                        {/* Transmitted (history) */}
                        {returnRequests.filter(r => r.status === 'transmitted').length > 0 && (
                          <div className="border-t border-gray-200 pt-3">
                            <p className="text-[10px] font-medium text-gray-500 mb-2">Transmittal 이력</p>
                            <div className="space-y-1">
                              {returnRequests.filter(r => r.status === 'transmitted').map(r => {
                                const codeLabel = codeCards.find(c => c.code === r.return_code)?.label || '-';
                                return (
                                  <div key={r.request_id} className="flex items-center gap-2 p-1.5 bg-white/80 rounded text-[9px]">
                                    <CheckCircle2 className="w-3 h-3 text-green-600 flex-shrink-0" />
                                    <span className="text-sky-600 font-medium">{r.transmittal_no || '-'}</span>
                                    <span className="text-gray-500 flex-1 truncate">{r.title}</span>
                                    <span className="text-gray-400">{codeLabel}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {returnRequests.length === 0 && (
                          <div className="p-6 text-center text-gray-400 text-xs">
                            회신 대기중인 요청이 없습니다
                          </div>
                        )}

                        {/* Excel Export */}
                        <button
                          onClick={handleExportExcel}
                          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-green-50 text-green-600 border border-green-200 rounded-lg text-xs font-medium hover:bg-green-100 transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" /> 도면 대장 Excel 다운로드
                        </button>
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Activity Drawer */}
      {showActivityDrawer && (
        <div className="fixed right-0 top-0 bottom-0 w-[320px] bg-white border-l border-gray-200 z-40 flex flex-col shadow-2xl">
          <div className="p-3 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
            <p className="text-xs font-medium text-gray-600">활동 이력 {activities.length}건</p>
            <div className="flex items-center gap-2">
              <button onClick={() => selectedProject && loadActivities(selectedProject.project_id)}
                      className="text-[10px] text-sky-600 hover:text-sky-500">새로고침</button>
              <button onClick={() => setShowActivityDrawer(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            {activities.length > 0 ? (
              <div className="relative pl-6 p-3">
                <div className="absolute left-[11px] top-0 bottom-0 w-px bg-white" />
                {activities.map((ev, idx) => {
                  const actionConfig = {
                    drawing_uploaded:    { icon: Upload,        color: 'text-sky-600',    bg: 'bg-sky-100',    label: '도면 업로드' },
                    drawing_registered:  { icon: CheckCircle2,  color: 'text-green-600',  bg: 'bg-green-50',  label: '도면 등록' },
                    markup_created:      { icon: MapPin,        color: 'text-amber-600',  bg: 'bg-amber-50',  label: '마크업 생성' },
                    markup_resolved:     { icon: Check,         color: 'text-green-600',  bg: 'bg-green-50',  label: '마크업 해결' },
                    review_updated:      { icon: Eye,           color: 'text-blue-600',   bg: 'bg-blue-50',   label: '검토 업데이트' },
                    request_created:     { icon: ClipboardList, color: 'text-purple-600', bg: 'bg-purple-50', label: '요청 생성' },
                    request_confirmed:   { icon: CheckCircle2,  color: 'text-green-600',  bg: 'bg-green-50',  label: '요청 확정' },
                    approval_decided:    { icon: Shield,        color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'EM 승인' },
                    intake_decision:     { icon: Inbox,         color: 'text-sky-600',    bg: 'bg-sky-100',    label: '접수 결정' },
                    reviewers_assigned:  { icon: UserCheck,     color: 'text-blue-600',   bg: 'bg-blue-50',   label: '검토자 할당' },
                    review_consolidated: { icon: GitMerge,      color: 'text-purple-600', bg: 'bg-purple-50', label: '의견 종합' },
                    return_code_set:     { icon: Reply,         color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Return Code' },
                    transmittal_created: { icon: Send,          color: 'text-green-600',  bg: 'bg-green-50',  label: 'Transmittal' },
                  };
                  const cfg = actionConfig[ev.action] || { icon: History, color: 'text-gray-500', bg: 'bg-gray-100', label: ev.action };
                  const IconComp = cfg.icon;
                  const details = ev.details || {};
                  let detailText = '';
                  if (details.drawing_number) detailText += details.drawing_number;
                  if (details.filename) detailText += detailText ? ` (${details.filename})` : details.filename;
                  if (details.discipline) detailText += detailText ? ` · ${DISCIPLINES[details.discipline]?.label || details.discipline}` : (DISCIPLINES[details.discipline]?.label || details.discipline);
                  if (details.transmittal_no) detailText += detailText ? ` · ${details.transmittal_no}` : details.transmittal_no;
                  if (details.return_code) detailText += detailText ? ` · ${details.return_code}` : details.return_code;
                  if (details.bulk) detailText = `일괄 업로드 ${details.success}/${details.total}건`;
                  if (details.title) detailText += detailText ? ` | ${details.title}` : details.title;
                  if (details.to_name) detailText += ` → ${details.to_name}`;
                  const timeStr = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : '';
                  return (
                    <div key={ev.event_id || idx} className="relative pb-3">
                      <div className={`absolute -left-[13px] top-1 w-5 h-5 rounded-full flex items-center justify-center ${cfg.bg}`}>
                        <IconComp className={`w-3 h-3 ${cfg.color}`} />
                      </div>
                      <div className="pl-3 pt-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[10px] font-medium ${cfg.color}`}>{cfg.label}</span>
                          <span className="text-[9px] text-gray-400">{ev.actor}</span>
                        </div>
                        {detailText && <p className="text-[10px] text-gray-500 mt-0.5 truncate">{detailText}</p>}
                        <p className="text-[9px] text-gray-400 mt-0.5">{timeStr}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-6 text-center text-gray-400 text-xs">
                <History className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>활동 이력이 없습니다</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Split-View Staging Modal (Feature 1 + 2) */}
      {showTitleBlockModal && titleBlockData && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-gray-100 border border-gray-200 rounded-2xl w-[90vw] max-w-[1100px] h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 flex-shrink-0">
              <h3 className="text-lg font-bold text-gray-900">스테이징 - AI 추출 결과 확인</h3>
              <button onClick={() => setShowTitleBlockModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex flex-1 overflow-hidden">
              {/* Left 60% - PDF preview + DI word overlay */}
              <div className="w-[60%] border-r border-gray-200 bg-gray-100 flex flex-col">
                <div className="px-3 py-1.5 border-b border-gray-200 text-[10px] text-gray-400">
                  1페이지 미리보기 · DI Words confidence 오버레이
                </div>
                <div className="flex-1 overflow-auto p-3 relative">
                  {stagingWords.length > 0 && stagingLayout.width > 0 ? (
                    <div className="relative" style={{ width: '100%', paddingBottom: `${(stagingLayout.height / stagingLayout.width) * 100}%` }}>
                      {/* Word confidence overlay */}
                      {stagingWords.map((w, i) => {
                        if (!w.polygon || w.polygon.length < 4) return null;
                        const minX = Math.min(w.polygon[0], w.polygon[2], w.polygon[4] || w.polygon[0], w.polygon[6] || w.polygon[2]);
                        const minY = Math.min(w.polygon[1], w.polygon[3], w.polygon[5] || w.polygon[1], w.polygon[7] || w.polygon[3]);
                        const maxX = Math.max(w.polygon[0], w.polygon[2], w.polygon[4] || w.polygon[0], w.polygon[6] || w.polygon[2]);
                        const maxY = Math.max(w.polygon[1], w.polygon[3], w.polygon[5] || w.polygon[1], w.polygon[7] || w.polygon[3]);
                        const left = (minX / stagingLayout.width) * 100;
                        const top = (minY / stagingLayout.height) * 100;
                        const width = ((maxX - minX) / stagingLayout.width) * 100;
                        const height = ((maxY - minY) / stagingLayout.height) * 100;
                        const conf = w.confidence;
                        const borderColor = conf >= 0.9 ? 'border-green-400' : conf >= 0.7 ? 'border-yellow-400' : 'border-red-400';
                        const bgColor = conf >= 0.9 ? 'bg-green-50' : conf >= 0.7 ? 'bg-yellow-50' : 'bg-red-50';
                        return (
                          <div
                            key={i}
                            className={`absolute border ${borderColor} ${bgColor} cursor-default`}
                            style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
                            title={`"${w.content}" (${Math.round(conf * 100)}%)`}
                          >
                            <span className="absolute -top-3 left-0 text-[7px] text-gray-400 whitespace-nowrap">{w.content}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-full text-gray-400 text-xs">
                      DI 분석 데이터가 없습니다
                    </div>
                  )}
                </div>
              </div>

              {/* Right 40% - Metadata form */}
              <div className="w-[40%] flex flex-col">
                <div className="px-3 py-1.5 border-b border-gray-200 text-[10px] text-gray-400">
                  메타데이터 편집
                </div>
                <div className="flex-1 overflow-auto p-4 space-y-3">
                  {/* 기본 정보 */}
                  <p className="text-[10px] font-bold text-sky-600 uppercase tracking-wider">기본 정보</p>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">도면번호</label>
                    <input value={titleBlockData.drawing_number || ''} onChange={e => setTitleBlockData(p => ({ ...p, drawing_number: e.target.value }))}
                           className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-800 focus:outline-none focus:border-sky-500" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">타이틀</label>
                    <input value={titleBlockData.title || ''} onChange={e => setTitleBlockData(p => ({ ...p, title: e.target.value }))}
                           className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-800 focus:outline-none focus:border-sky-500" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-0.5">리비전</label>
                      <input value={titleBlockData.revision || ''} onChange={e => setTitleBlockData(p => ({ ...p, revision: e.target.value }))}
                             className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-800 focus:outline-none focus:border-sky-500" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-0.5">디시플린</label>
                      <select value={titleBlockData.discipline || ''} onChange={e => setTitleBlockData(p => ({ ...p, discipline: e.target.value }))}
                              className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-800 focus:outline-none focus:border-sky-500">
                        <option value="">선택...</option>
                        {Object.entries(DISCIPLINES).map(([k, v]) => (
                          <option key={k} value={k}>{v.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* EPC 관리 정보 */}
                  <div className="border-t border-gray-200 pt-3 mt-2">
                    <p className="text-[10px] font-bold text-sky-600 uppercase tracking-wider mb-2">EPC 관리 정보</p>
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">발행 목적 (Issue Purpose)</label>
                    <select value={titleBlockData.issue_purpose || ''} onChange={e => setTitleBlockData(p => ({ ...p, issue_purpose: e.target.value }))}
                            className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-800 focus:outline-none focus:border-sky-500">
                      <option value="">선택...</option>
                      <option value="IFA">IFA (Issued for Approval)</option>
                      <option value="IFI">IFI (Issued for Information)</option>
                      <option value="IFC">IFC (Issued for Construction)</option>
                      <option value="As-Built">As-Built</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-0.5">발행일 (Issue Date)</label>
                      <input type="date" value={titleBlockData.issue_date || ''} onChange={e => setTitleBlockData(p => ({ ...p, issue_date: e.target.value }))}
                             className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-800 focus:outline-none focus:border-sky-500" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-0.5">접수일 (Receive Date)</label>
                      <input type="date" value={titleBlockData.receive_date || ''} onChange={e => setTitleBlockData(p => ({ ...p, receive_date: e.target.value }))}
                             className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-800 focus:outline-none focus:border-sky-500" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">Vendor 도면번호</label>
                    <input value={titleBlockData.vendor_drawing_number || ''} onChange={e => setTitleBlockData(p => ({ ...p, vendor_drawing_number: e.target.value }))}
                           className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-800 focus:outline-none focus:border-sky-500" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-0.5">Vendor 이름</label>
                      <input value={titleBlockData.vendor_name || ''} onChange={e => setTitleBlockData(p => ({ ...p, vendor_name: e.target.value }))}
                             className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-800 focus:outline-none focus:border-sky-500" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-0.5">검토자</label>
                      <input value={titleBlockData.reviewer_name || ''} onChange={e => setTitleBlockData(p => ({ ...p, reviewer_name: e.target.value }))}
                             className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-800 focus:outline-none focus:border-sky-500" />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="has_dwg" checked={titleBlockData.has_dwg || false}
                           onChange={e => setTitleBlockData(p => ({ ...p, has_dwg: e.target.checked }))}
                           className="w-3.5 h-3.5 rounded border-gray-300 bg-white text-sky-500 focus:ring-sky-500" />
                    <label htmlFor="has_dwg" className="text-xs text-gray-600">DWG 파일 보유</label>
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">변경 이력 (Change Log)</label>
                    <textarea value={titleBlockData.change_log || ''} onChange={e => setTitleBlockData(p => ({ ...p, change_log: e.target.value }))}
                              className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-800 focus:outline-none focus:border-sky-500 resize-none" rows={2} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">비고 (Remarks)</label>
                    <textarea value={titleBlockData.remarks || ''} onChange={e => setTitleBlockData(p => ({ ...p, remarks: e.target.value }))}
                              className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-800 focus:outline-none focus:border-sky-500 resize-none" rows={2} />
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom actions */}
            <div className="flex gap-3 px-5 py-3 border-t border-gray-200 flex-shrink-0">
              <button onClick={handleConfirmTitleBlock}
                      className="flex-1 px-4 py-2.5 bg-sky-500 hover:bg-sky-400 text-white rounded-lg text-sm font-medium transition-colors">
                승인 및 등록
              </button>
              <button onClick={() => setShowTitleBlockModal(false)}
                      className="px-4 py-2.5 bg-gray-200 hover:bg-gray-300 text-gray-600 rounded-lg text-sm transition-colors">
                건너뛰기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Diff Viewer Modal (Feature 3) */}
      {showDiffViewer && diffRevisions.a && diffRevisions.b && (
        <DiffViewer
          revisionA={diffRevisions.a}
          revisionB={diffRevisions.b}
          onClose={() => { setShowDiffViewer(false); setDiffRevisions({ a: null, b: null }); }}
        />
      )}
    </div>
  );
};

export default PlantSync;
