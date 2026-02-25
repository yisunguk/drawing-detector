import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
import { parsePidTags } from '../utils/pidTagParser';
import PDFViewer from '../components/PDFViewer';
import DiffViewer from '../components/DiffViewer';

const API_BASE = (import.meta.env.VITE_API_URL ?? 'https://drawing-detector-backend-435353955407.us-central1.run.app').replace(/\/$/, '');
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

const ISSUE_CATEGORIES = {
  design_error:     { label: '설계 오류',   color: '#ef4444', bg: 'bg-red-50',    text: 'text-red-600' },
  spec_mismatch:    { label: '스펙 불일치', color: '#f97316', bg: 'bg-orange-50', text: 'text-orange-600' },
  clash:            { label: '간섭',         color: '#eab308', bg: 'bg-yellow-50', text: 'text-yellow-600' },
  constructability: { label: '시공성',       color: '#3b82f6', bg: 'bg-blue-50',   text: 'text-blue-600' },
  clarification:    { label: '확인 요청',   color: '#8b5cf6', bg: 'bg-purple-50', text: 'text-purple-600' },
};

const IMPACT_LEVELS = {
  normal:   { label: '일반', bg: 'bg-gray-100',  text: 'text-gray-600' },
  cost:     { label: '원가', bg: 'bg-red-50',    text: 'text-red-600' },
  schedule: { label: '공정', bg: 'bg-orange-50', text: 'text-orange-600' },
  safety:   { label: '안전', bg: 'bg-red-100',   text: 'text-red-700' },
};

const ROOT_CAUSES = {
  vendor_error:           { label: '업체 오류' },
  spec_change:            { label: '스펙 변경' },
  prior_drawing_mismatch: { label: '이전 도면 불일치' },
  design_omission:        { label: '설계 누락' },
  coordination_gap:       { label: '협의 누락' },
  other:                  { label: '기타' },
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
  const [markupForm, setMarkupForm] = useState({
    comment: '', extracted_tags: [], target_disciplines: [],
    issue_category: '', impact_level: 'normal',
    related_tag_no: '', custom_tags: [],
  });
  const [tagInput, setTagInput] = useState('');
  const [resolveForm, setResolveForm] = useState({
    resolution_comment: '', root_cause: '', linked_rfi_id: '',
  });
  const [showResolveForm, setShowResolveForm] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [dashboardFilter, setDashboardFilter] = useState({ status: 'all', discipline: 'all' });
  const [dashboardExpanded, setDashboardExpanded] = useState(true);
  const [contentResults, setContentResults] = useState([]);
  const [contentSearching, setContentSearching] = useState(false);
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
  const [intakeComments, setIntakeComments] = useState({});
  const [userList, setUserList] = useState([]);

  // Member management
  const [showMemberPanel, setShowMemberPanel] = useState(false);
  const [projectMembers, setProjectMembers] = useState([]);
  const [projectOwner, setProjectOwner] = useState('');

  const fileInputRef = useRef(null);

  // Sidebar resize
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(360);
  const isResizingLeft = useRef(false);
  const isResizingRight = useRef(false);

  // Resolve current user's display name (for intake permission check)
  const currentName = useMemo(() => {
    const found = userList.find(u => u.uid === currentUser?.uid);
    return found?.name || currentUser?.displayName || currentUser?.email || '';
  }, [userList, currentUser]);

  // Parse nearby OCR words into categorized P&ID tags
  const parsedTags = useMemo(() => {
    if (nearbyWords.length === 0) return { equipment: [], lines: [], specs: [] };
    return parsePidTags(nearbyWords.map(w => w.content));
  }, [nearbyWords]);

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

  const loadMembers = useCallback(async (projectId) => {
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${projectId}/members`), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setProjectMembers(data.members || []);
        setProjectOwner(data.owner || '');
      }
    } catch (e) {
      console.error('Load members error:', e);
    }
  }, []);

  const handleAddMember = async (memberUid, memberName, memberEmail) => {
    if (!selectedProject) return;
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${selectedProject.project_id}/members`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_uid: memberUid, member_name: memberName, member_email: memberEmail || '' }),
      });
      if (res.ok) {
        const data = await res.json();
        setProjectMembers(data.members || []);
      }
    } catch (e) {
      console.error('Add member error:', e);
    }
  };

  const handleRemoveMember = async (memberName) => {
    if (!selectedProject || !window.confirm(`${memberName}님을 프로젝트에서 제거하시겠습니까?`)) return;
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`projects/${selectedProject.project_id}/members/${encodeURIComponent(memberName)}`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setProjectMembers(data.members || []);
      }
    } catch (e) {
      console.error('Remove member error:', e);
    }
  };

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
        body: JSON.stringify({ drawing_id: drawingId, decision, comment: intakeComments[requestId] || '' }),
      });
      setIntakeComments(prev => { const next = { ...prev }; delete next[requestId]; return next; });
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

  // Restore selected project from localStorage after projects load
  useEffect(() => {
    if (projects.length > 0 && !selectedProject) {
      const savedId = localStorage.getItem('plantsync_selected_project');
      if (savedId) {
        const found = projects.find(p => p.project_id === savedId);
        if (found) setSelectedProject(found);
      }
    }
  }, [projects]);

  useEffect(() => {
    if (selectedProject) {
      loadProjectDetail(selectedProject.project_id);
      loadDashboard(selectedProject.project_id);
      loadReviewRequests(selectedProject.project_id);
      loadActivities(selectedProject.project_id);
      loadMembers(selectedProject.project_id);
    }
  }, [selectedProject, loadProjectDetail, loadDashboard, loadReviewRequests, loadActivities, loadMembers]);

  useEffect(() => {
    if (selectedProject && selectedDrawing) {
      loadPdfUrl(selectedProject.project_id, selectedDrawing.drawing_id);
      loadMarkups(selectedProject.project_id, selectedDrawing.drawing_id);
      loadReviewRequests(selectedProject.project_id, selectedDrawing.drawing_id);
      loadReviewGate(selectedProject.project_id, selectedDrawing.drawing_id);
    }
  }, [selectedProject, selectedDrawing, loadPdfUrl, loadMarkups, loadReviewRequests, loadReviewGate]);

  // ── Content search (debounced Azure AI Search) ──
  useEffect(() => {
    if (!selectedProject || searchQuery.length < 2) {
      setContentResults([]);
      return;
    }
    setContentSearching(true);
    const timer = setTimeout(async () => {
      try {
        const token = await getToken();
        const res = await fetch(getUrl(`projects/${selectedProject.project_id}/search-content?q=${encodeURIComponent(searchQuery)}`), {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setContentResults(data.results || []);
        }
      } catch (e) {
        console.error('Content search error:', e);
      } finally {
        setContentSearching(false);
      }
    }, 400);
    return () => { clearTimeout(timer); setContentSearching(false); };
  }, [searchQuery, selectedProject]);

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
      localStorage.setItem('plantsync_selected_project', data.project.project_id);
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
      localStorage.removeItem('plantsync_selected_project');
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
      // Merge: title_block (DI extracted) + drawing (has receive_date, defaults)
      const d = data.drawing || {};
      setTitleBlockData({
        ...data.title_block,
        vendor_drawing_number: data.title_block?.vendor_drawing_number || d.vendor_drawing_number || '',
        issue_purpose: data.title_block?.issue_purpose || d.issue_purpose || '',
        issue_date: data.title_block?.issue_date || d.issue_date || '',
        receive_date: d.receive_date || '',
        vendor_name: data.title_block?.vendor_name || d.vendor_name || '',
        reviewer_name: d.reviewer_name || '',
        has_dwg: d.has_dwg || false,
        related_drawings: d.related_drawings || [],
        change_log: d.change_log || '',
        remarks: d.remarks || '',
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

  const handleCancelUpload = async () => {
    if (!selectedProject || !pendingDrawingId) {
      setShowTitleBlockModal(false);
      return;
    }
    if (!window.confirm('업로드한 도면을 삭제하시겠습니까?')) return;
    try {
      const token = await getToken();
      await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${pendingDrawingId}`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      setShowTitleBlockModal(false);
      setPendingDrawingId(null);
      setTitleBlockData(null);
      setStagingWords([]);
      setStagingLayout({ width: 0, height: 0 });
      await loadProjectDetail(selectedProject.project_id);
    } catch (e) {
      console.error('Cancel upload error:', e);
      setShowTitleBlockModal(false);
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
    setMarkupForm({ comment: '', extracted_tags: [], target_disciplines: [], issue_category: '', impact_level: 'normal', related_tag_no: '', custom_tags: [] }); setTagInput('');
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
    if (!selectedMarkup?._pending || !markupForm.comment.trim() || !selectedProject || !selectedDrawing) return;
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
          comment: markupForm.comment.trim(),
          request_id: activeRequestId || undefined,
          extracted_tags: markupForm.extracted_tags,
          target_disciplines: markupForm.target_disciplines,
          issue_category: markupForm.issue_category || undefined,
          impact_level: markupForm.impact_level || undefined,
          related_tag_no: markupForm.related_tag_no || undefined,
          custom_tags: markupForm.custom_tags.length > 0 ? markupForm.custom_tags : undefined,
        }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setSelectedMarkup(data.markup);
      setIsPlacingPin(false);
      setMarkupForm({ comment: '', extracted_tags: [], target_disciplines: [], issue_category: '', impact_level: 'normal', related_tag_no: '', custom_tags: [] }); setTagInput('');
      await loadMarkups(selectedProject.project_id, selectedDrawing.drawing_id);
    } catch (e) {
      console.error('Save markup error:', e);
    }
  };

  const handleResolveMarkup = async (markupId, resolveData = {}) => {
    if (!selectedProject || !selectedDrawing) return;
    try {
      const token = await getToken();
      const payload = {
        status: 'resolved',
        ...( resolveData.resolution_comment ? { resolution_comment: resolveData.resolution_comment } : {}),
        ...( resolveData.root_cause ? { root_cause: resolveData.root_cause } : {}),
        ...( resolveData.linked_rfi_id ? { linked_rfi_id: resolveData.linked_rfi_id } : {}),
      };
      await fetch(getUrl(`projects/${selectedProject.project_id}/drawings/${selectedDrawing.drawing_id}/markups/${markupId}`), {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await loadMarkups(selectedProject.project_id, selectedDrawing.drawing_id);
      if (selectedMarkup?.markup_id === markupId) {
        setSelectedMarkup(prev => prev ? { ...prev, status: 'resolved', ...payload } : null);
      }
      setShowResolveForm(null);
      setResolveForm({ resolution_comment: '', root_cause: '', linked_rfi_id: '' });
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
    setSelectedMarkup(null);
    setMarkupForm({ comment: '', extracted_tags: [], target_disciplines: [], issue_category: '', impact_level: 'normal', related_tag_no: '', custom_tags: [] }); setTagInput('');
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

  // Dashboard filtered markups
  const filteredDashboardMarkups = useMemo(() => {
    if (!dashboard?.all_markups) return [];
    return dashboard.all_markups.filter(m => {
      if (dashboardFilter.status !== 'all' && m.status !== dashboardFilter.status) return false;
      if (dashboardFilter.discipline !== 'all' && m.discipline !== dashboardFilter.discipline) return false;
      return true;
    });
  }, [dashboard, dashboardFilter]);

  // Dashboard: click markup → navigate to drawing + markup
  const handleDashboardNavigate = (markup) => {
    const dwg = (projectDetail?.drawings || []).find(d => d.drawing_id === markup.drawing_id);
    if (dwg) {
      setSelectedDrawing(dwg);
      setCurrentPage(markup.page || 1);
    }
    const fullMarkup = markups.find(m => m.markup_id === markup.markup_id);
    if (fullMarkup) setSelectedMarkup(fullMarkup);
    setRightTab('markup');
  };

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
            <h1 className="text-xl font-bold text-gray-900">도면 마크업 관리</h1>
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
                  onClick={() => { if (editingProjectId !== p.project_id) { setSelectedProject(p); localStorage.setItem('plantsync_selected_project', p.project_id); } }}
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
                      {p.is_shared && <span className="text-xs text-sky-600 mt-1 block">공유 · {p.owner_name}</span>}
                    </div>
                    {editingProjectId !== p.project_id && !p.is_shared && (
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
              <div className="min-w-0 flex-1">
                <h1 className="text-sm font-bold text-gray-900 truncate">{selectedProject.project_name}</h1>
                <p className="text-xs text-gray-400">{drawings.length}건 도면</p>
              </div>
              <button
                onClick={() => setShowMemberPanel(!showMemberPanel)}
                className={`p-1.5 rounded-lg transition-colors flex-shrink-0 ${showMemberPanel ? 'bg-sky-100 text-sky-600' : 'text-gray-400 hover:text-sky-600 hover:bg-sky-50'}`}
                title="멤버 관리"
              >
                <Users className="w-4 h-4" />
              </button>
            </div>
            {/* Member Panel */}
            {showMemberPanel && (
              <div className="mt-3 p-2.5 bg-gray-50 border border-gray-200 rounded-lg space-y-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-medium text-gray-500">소유자:</span>
                  <span className="text-[10px] text-sky-600 font-medium">{projectOwner || selectedProject.owner_name || '-'}</span>
                </div>
                {projectMembers.length > 0 && (
                  <div>
                    <span className="text-[10px] font-medium text-gray-500 block mb-1">멤버 ({projectMembers.length}명)</span>
                    <div className="space-y-1">
                      {projectMembers.map(m => (
                        <div key={m.uid || m.name} className="flex items-center justify-between gap-1 px-2 py-1 bg-white rounded">
                          <span className="text-[10px] text-gray-700 truncate">{m.name} {m.email ? `(${m.email})` : ''}</span>
                          {(projectOwner === currentName || !selectedProject.is_shared) && (
                            <button onClick={() => handleRemoveMember(m.name)} className="text-gray-400 hover:text-red-500 flex-shrink-0">
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <select
                  value=""
                  onChange={e => {
                    const uid = e.target.value;
                    if (!uid) return;
                    const user = userList.find(u => u.uid === uid);
                    if (user) handleAddMember(user.uid, user.name || user.email, user.email);
                  }}
                  className="w-full px-2 py-1 bg-white border border-gray-200 rounded text-[10px] text-gray-600 focus:outline-none focus:border-sky-400"
                >
                  <option value="">멤버 추가...</option>
                  {userList
                    .filter(u => (u.name || u.email) !== projectOwner && !projectMembers.some(m => m.uid === u.uid))
                    .map(u => (
                      <option key={u.uid} value={u.uid}>{u.name}{u.email ? ` (${u.email})` : ''}</option>
                    ))}
                </select>
              </div>
            )}
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

          {/* Content Search Results */}
          {searchQuery.length >= 2 && (
            <div className="border-b border-gray-200">
              <div className="px-3 py-1.5 flex items-center justify-between bg-amber-50/50">
                <span className="text-[9px] font-medium text-amber-700">
                  {contentSearching ? '검색 중...' : `도면 내 검색 (${contentResults.length}건)`}
                </span>
                {contentResults.length > 0 && (
                  <button onClick={() => { setContentResults([]); setSearchQuery(''); }} className="text-[9px] text-gray-400 hover:text-gray-600">닫기</button>
                )}
              </div>
              {!contentSearching && contentResults.length > 0 && (
                <div className="max-h-48 overflow-auto">
                  {contentResults.map((r, i) => (
                    <button
                      key={`${r.drawing_id}-${r.page}-${i}`}
                      onClick={() => {
                        const dwg = (projectDetail?.drawings || []).find(d => d.drawing_id === r.drawing_id);
                        if (dwg) { setSelectedDrawing(dwg); setCurrentPage(r.page); setSelectedMarkup(null); }
                      }}
                      className={`w-full px-3 py-1.5 text-left hover:bg-sky-50 flex items-center gap-1.5 border-b border-gray-50 transition-colors ${
                        selectedDrawing?.drawing_id === r.drawing_id ? 'bg-sky-50' : ''
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: DISCIPLINES[r.discipline]?.color || '#888' }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] font-medium text-gray-700 truncate">{r.drawing_number || r.title || '-'}</span>
                          <span className="text-[9px] text-gray-400 flex-shrink-0">p.{r.page}</span>
                        </div>
                        <p className="text-[9px] text-gray-400 truncate" dangerouslySetInnerHTML={{ __html: r.snippet }} />
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {!contentSearching && contentResults.length === 0 && filteredDrawings.length === 0 && (
                <div className="px-3 py-2 text-center">
                  <p className="text-[9px] text-gray-400 mb-1">검색 결과가 없습니다</p>
                  <button
                    onClick={async () => {
                      if (!selectedProject) return;
                      try {
                        const token = await getToken();
                        const res = await fetch(getUrl(`projects/${selectedProject.project_id}/reindex-content`), {
                          method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
                        });
                        if (res.ok) {
                          const data = await res.json();
                          alert(`인덱싱 완료: ${data.indexed}건 처리 (${data.skipped}건 스킵)`);
                        }
                      } catch (e) { console.error('Reindex error:', e); }
                    }}
                    className="text-[9px] text-sky-600 hover:text-sky-500 underline"
                  >도면 검색 인덱싱 실행</button>
                </div>
              )}
            </div>
          )}

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
                    const intakeRequests = reviewRequests.filter(r => r.status === 'requested');
                    const acceptedRequests = reviewRequests.filter(r => !['requested', 'rejected'].includes(r.status));
                    const rejectedRequests = reviewRequests.filter(r => r.status === 'rejected');
                    return (
                      <>
                        {intakeRequests.length > 0 && (
                          <div className="p-3 space-y-2">
                            <p className="text-[10px] font-medium text-amber-600">접수 대기 ({intakeRequests.length}건)</p>
                            {intakeRequests.map(r => {
                              const drawing = (projectDetail?.drawings || []).find(d => d.drawing_id === r.drawing_id);
                              const isRecipient = r.to_name === currentName;
                              return (
                                <div key={r.request_id} className="bg-gray-50 rounded-lg p-2.5 space-y-2">
                                  <div className="flex items-center gap-1.5">
                                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DISCIPLINES[r.discipline]?.color }} />
                                    <span className="text-xs font-medium text-gray-800 flex-1 truncate">{r.title}</span>
                                    {r.priority === 'urgent' && <AlertTriangle className="w-3 h-3 text-red-600" />}
                                  </div>
                                  <div className="text-[10px] text-gray-400 space-y-0.5">
                                    <p>요청: <span className="text-sky-600">{r.from_name}</span> → <span className="text-sky-600">{r.to_name}</span></p>
                                    <p>도면: <span className="text-gray-600">{r.drawing_number || drawing?.drawing_number || '-'}</span></p>
                                    <p>리비전: <span className="text-gray-600">{drawing?.current_revision || '-'}</span></p>
                                    <p>Issue Purpose: <span className="text-gray-600">{drawing?.issue_purpose || '-'}</span></p>
                                    <p>VDRL: <span className={drawing?.vdrl_match ? 'text-green-600' : 'text-gray-400'}>{drawing?.vdrl_match ? '✓ 매치' : '— 미확인'}</span></p>
                                  </div>
                                  {isRecipient ? (
                                    <>
                                      <input
                                        value={intakeComments[r.request_id] || ''}
                                        onChange={e => setIntakeComments(prev => ({ ...prev, [r.request_id]: e.target.value }))}
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
                                    </>
                                  ) : (
                                    <div className="px-2 py-1.5 bg-gray-100 rounded text-[10px] text-gray-500 text-center">
                                      <Clock className="w-3 h-3 inline mr-1" />접수 대기 중
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {acceptedRequests.length > 0 && (
                          <div className="p-3 space-y-1.5 border-t border-gray-200">
                            <p className="text-[10px] font-medium text-green-600">접수 완료 ({acceptedRequests.length}건)</p>
                            {acceptedRequests.slice(0, 10).map(r => (
                              <div key={r.request_id} className="p-1.5 bg-white/80 rounded space-y-0.5">
                                <div className="flex items-center gap-2">
                                  <CheckCircle2 className="w-3 h-3 text-green-600 flex-shrink-0" />
                                  <span className="text-[10px] text-gray-600 flex-1 truncate">{r.title}</span>
                                  <span className="text-[9px] text-gray-400">{r.drawing_number}</span>
                                </div>
                                {r.intake_comment && (
                                  <p className="ml-5 text-[9px] text-gray-500 bg-green-50 px-2 py-0.5 rounded">{r.intake_comment}</p>
                                )}
                                {r.intake_decided_by && (
                                  <p className="ml-5 text-[9px] text-gray-400">{r.intake_decided_by} · {r.intake_decided_at ? new Date(r.intake_decided_at).toLocaleDateString() : ''}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {rejectedRequests.length > 0 && (
                          <div className="p-3 space-y-1.5 border-t border-gray-200">
                            <p className="text-[10px] font-medium text-red-600">반려 ({rejectedRequests.length}건)</p>
                            {rejectedRequests.map(r => (
                              <div key={r.request_id} className="p-1.5 bg-white/80 rounded space-y-0.5">
                                <div className="flex items-center gap-2">
                                  <XCircle className="w-3 h-3 text-red-600 flex-shrink-0" />
                                  <span className="text-[10px] text-gray-500 flex-1 truncate">{r.title}</span>
                                  <button onClick={() => handleUpdateRequestStatus(r.request_id, 'intake')}
                                          className="text-[9px] text-amber-600 hover:text-amber-600">재접수</button>
                                </div>
                                {r.intake_comment && (
                                  <p className="ml-5 text-[9px] text-gray-500 bg-red-50 px-2 py-0.5 rounded">반려 사유: {r.intake_comment}</p>
                                )}
                                {r.intake_decided_by && (
                                  <p className="ml-5 text-[9px] text-gray-400">{r.intake_decided_by} · {r.intake_decided_at ? new Date(r.intake_decided_at).toLocaleDateString() : ''}</p>
                                )}
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
                            {assignableRequests.map(r => {
                              const isAssigner = (r.intake_decided_by || r.to_name) === currentName;
                              return (
                                <div key={r.request_id} className="bg-gray-50 rounded-lg p-2.5 space-y-2">
                                  <div className="flex items-center gap-1.5">
                                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DISCIPLINES[r.discipline]?.color }} />
                                    <span className="text-xs text-gray-800 flex-1 truncate">{r.title}</span>
                                  </div>
                                  <p className="text-[9px] text-gray-400">접수: {r.intake_decided_by || r.to_name || '-'}</p>
                                  {isAssigner ? (
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
                                      <div className="relative">
                                        <label className="text-[9px] text-gray-400">업무 종료일</label>
                                        <input
                                          type="date"
                                          value={assignForm.due_date}
                                          onChange={e => setAssignForm(f => ({ ...f, due_date: e.target.value }))}
                                          className="w-full px-2 py-1 bg-white border border-gray-300 rounded text-[10px] text-gray-800 focus:outline-none"
                                        />
                                      </div>
                                      <button onClick={() => handleAssignReviewers(r.request_id)}
                                              className="w-full flex items-center justify-center gap-1 px-2 py-1 bg-sky-100 text-sky-600 rounded text-[10px] hover:bg-sky-100">
                                        <UserCheck className="w-3 h-3" /> 할당
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="px-2 py-1.5 bg-amber-50 rounded text-[10px] text-amber-600 text-center">
                                      <Clock className="w-3 h-3 inline mr-1" />접수자 할당 대기 중
                                    </div>
                                  )}
                                </div>
                              );
                            })}
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
                                  <div className="text-[10px] text-gray-400 space-y-0.5">
                                    <p>Lead: <span className="text-sky-600">{r.lead_reviewer || r.to_name}</span>
                                    {(r.squad_reviewers || []).length > 0 && (
                                      <span className="ml-2">Squad: <span className="text-gray-600">{r.squad_reviewers.join(', ')}</span></span>
                                    )}</p>
                                    {dueDate && <p>종료일: <span className="text-gray-600">{dueDate}</span></p>}
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

                      {/* Structured fields display */}
                      {(selectedMarkup.issue_category || selectedMarkup.impact_level) && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {selectedMarkup.issue_category && ISSUE_CATEGORIES[selectedMarkup.issue_category] && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${ISSUE_CATEGORIES[selectedMarkup.issue_category].bg} ${ISSUE_CATEGORIES[selectedMarkup.issue_category].text}`}>
                              {ISSUE_CATEGORIES[selectedMarkup.issue_category].label}
                            </span>
                          )}
                          {selectedMarkup.impact_level && selectedMarkup.impact_level !== 'normal' && IMPACT_LEVELS[selectedMarkup.impact_level] && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${IMPACT_LEVELS[selectedMarkup.impact_level].bg} ${IMPACT_LEVELS[selectedMarkup.impact_level].text}`}>
                              {IMPACT_LEVELS[selectedMarkup.impact_level].label}
                            </span>
                          )}
                        </div>
                      )}
                      {selectedMarkup.target_disciplines?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          <span className="text-[9px] text-gray-400">대상:</span>
                          {selectedMarkup.target_disciplines.map(d => (
                            <span key={d} className="text-[9px] px-1 py-0.5 bg-gray-100 text-gray-600 rounded">
                              {DISCIPLINES[d]?.label || d}
                            </span>
                          ))}
                        </div>
                      )}
                      {selectedMarkup.related_tag_no && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          <span className="text-[9px] px-1.5 py-0.5 bg-sky-50 text-sky-700 border border-sky-200 rounded">
                            {selectedMarkup.related_tag_no}
                          </span>
                        </div>
                      )}
                      {selectedMarkup.custom_tags?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {selectedMarkup.custom_tags.map((tag, i) => (
                            <span key={i} className="text-[9px] px-1.5 py-0.5 bg-sky-100 text-sky-700 rounded">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      {selectedMarkup.extracted_tags?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {selectedMarkup.extracted_tags.map((tag, i) => (
                            <span key={i} className="text-[9px] px-1 py-0.5 bg-amber-50 text-amber-600 rounded">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Resolution info (if resolved) */}
                      {selectedMarkup.resolution_comment && (
                        <div className="mt-2 p-2 bg-green-50 rounded border border-green-100">
                          <span className="text-[10px] text-green-700 font-medium block">해결 내용</span>
                          <p className="text-[10px] text-green-600 mt-0.5">{selectedMarkup.resolution_comment}</p>
                          {selectedMarkup.root_cause && ROOT_CAUSES[selectedMarkup.root_cause] && (
                            <p className="text-[9px] text-green-500 mt-0.5">근본 원인: {ROOT_CAUSES[selectedMarkup.root_cause].label}</p>
                          )}
                          {selectedMarkup.linked_rfi_id && (
                            <p className="text-[9px] text-green-500 mt-0.5">RFI: {selectedMarkup.linked_rfi_id}</p>
                          )}
                        </div>
                      )}

                      <div className="flex gap-1.5 mt-2 flex-wrap">
                        {selectedMarkup.status === 'open' && (
                          <>
                            <button onClick={() => { setShowResolveForm(selectedMarkup.markup_id); setResolveForm({ resolution_comment: '', root_cause: '', linked_rfi_id: '' }); }}
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

                      {/* Inline Resolve Form */}
                      {showResolveForm === selectedMarkup.markup_id && (
                        <div className="mt-2 p-2 bg-green-50 rounded-lg border border-green-200 space-y-2">
                          <textarea
                            value={resolveForm.resolution_comment}
                            onChange={e => setResolveForm(f => ({ ...f, resolution_comment: e.target.value }))}
                            placeholder="해결 내용을 입력하세요..."
                            className="w-full px-2 py-1.5 bg-white border border-green-200 rounded text-xs text-gray-600 placeholder-gray-400 focus:outline-none focus:border-green-400 resize-none"
                            rows={2}
                            autoFocus
                          />
                          <div>
                            <span className="text-[10px] text-gray-500 block mb-1">근본 원인</span>
                            <div className="flex flex-wrap gap-1">
                              {Object.entries(ROOT_CAUSES).map(([key, rc]) => (
                                <button
                                  key={key}
                                  onClick={() => setResolveForm(f => ({ ...f, root_cause: f.root_cause === key ? '' : key }))}
                                  className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                    resolveForm.root_cause === key
                                      ? 'bg-green-100 border-green-400 text-green-700 font-medium'
                                      : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                                  }`}
                                >
                                  {rc.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <input
                            value={resolveForm.linked_rfi_id}
                            onChange={e => setResolveForm(f => ({ ...f, linked_rfi_id: e.target.value }))}
                            placeholder="RFI 번호 (선택)"
                            className="w-full px-2 py-1 bg-white border border-green-200 rounded text-[10px] text-gray-600 placeholder-gray-400 focus:outline-none focus:border-green-400"
                          />
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => handleResolveMarkup(selectedMarkup.markup_id, resolveForm)}
                              className="flex-1 px-2 py-1 bg-green-500 hover:bg-green-400 text-white rounded text-[10px] font-medium"
                            >
                              해결 확인
                            </button>
                            <button
                              onClick={() => setShowResolveForm(null)}
                              className="px-2 py-1 bg-gray-200 hover:bg-gray-300 text-gray-600 rounded text-[10px]"
                            >
                              취소
                            </button>
                          </div>
                        </div>
                      )}
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
                  /* New Pin – Structured Markup Form */
                  <div className="p-4 flex flex-col h-full overflow-auto">
                    {/* Header */}
                    <div className="flex items-center gap-2 mb-3">
                      <MapPin className="w-4 h-4 text-sky-600" />
                      <span className="text-sm font-medium text-gray-800">새 마크업</span>
                      <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: DISCIPLINES[selectedMarkup.discipline]?.color + '33', color: DISCIPLINES[selectedMarkup.discipline]?.color }}>
                        {DISCIPLINES[selectedMarkup.discipline]?.label}
                      </span>
                    </div>

                    {/* Issue Category */}
                    <div className="mb-2">
                      <span className="text-[10px] text-gray-500 font-medium block mb-1">이슈 유형</span>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(ISSUE_CATEGORIES).map(([key, cat]) => (
                          <button
                            key={key}
                            onClick={() => setMarkupForm(f => ({ ...f, issue_category: f.issue_category === key ? '' : key }))}
                            className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                              markupForm.issue_category === key
                                ? `${cat.bg} ${cat.text} border-current font-medium`
                                : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                            }`}
                          >
                            {cat.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Impact Level */}
                    <div className="mb-2">
                      <span className="text-[10px] text-gray-500 font-medium block mb-1">영향도</span>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(IMPACT_LEVELS).map(([key, lvl]) => (
                          <button
                            key={key}
                            onClick={() => setMarkupForm(f => ({ ...f, impact_level: key }))}
                            className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                              markupForm.impact_level === key
                                ? `${lvl.bg} ${lvl.text} border-current font-medium`
                                : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                            }`}
                          >
                            {lvl.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Related Tag / Equipment Number */}
                    <div className="mb-2">
                      <span className="text-[10px] text-gray-500 font-medium block mb-1">관련 기기/태그번호</span>
                      <input
                        value={markupForm.related_tag_no}
                        onChange={e => setMarkupForm(f => ({ ...f, related_tag_no: e.target.value }))}
                        placeholder="예: PSV-0905A, PIPE-2001"
                        className="w-full px-2 py-1 bg-gray-50 border border-gray-200 rounded text-[10px] text-gray-600 placeholder-gray-400 focus:outline-none focus:border-sky-300 mb-1"
                      />
                      {/* Equipment/Line chips rendered in AI 추천 데이터 section below */}
                    </div>

                    {/* Target Disciplines (multi-select checkboxes) */}
                    <div className="mb-2">
                      <span className="text-[10px] text-gray-500 font-medium block mb-1">대상 공종</span>
                      <div className="grid grid-cols-3 gap-1">
                        {Object.entries(DISCIPLINES).map(([key, disc]) => (
                          <label key={key} className="flex items-center gap-1 cursor-pointer text-[10px] text-gray-600">
                            <input
                              type="checkbox"
                              checked={markupForm.target_disciplines.includes(key)}
                              onChange={() => setMarkupForm(f => ({
                                ...f,
                                target_disciplines: f.target_disciplines.includes(key)
                                  ? f.target_disciplines.filter(d => d !== key)
                                  : [...f.target_disciplines, key],
                              }))}
                              className="w-3 h-3 rounded border-gray-300"
                            />
                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: disc.color }} />
                            {disc.label}
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Custom Tags (Hashtags) */}
                    <div className="mb-2">
                      <span className="text-[10px] text-gray-500 font-medium block mb-1">사용자 태그</span>
                      {markupForm.custom_tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-1">
                          {markupForm.custom_tags.map((tag, i) => (
                            <span key={i} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-sky-100 text-sky-700 rounded text-[10px]">
                              {tag}
                              <button
                                onClick={() => setMarkupForm(f => ({ ...f, custom_tags: f.custom_tags.filter((_, idx) => idx !== i) }))}
                                className="text-sky-400 hover:text-sky-600 ml-0.5"
                              >×</button>
                            </span>
                          ))}
                        </div>
                      )}
                      <input
                        value={tagInput}
                        onChange={e => setTagInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && tagInput.trim()) {
                            e.preventDefault();
                            const newTag = tagInput.trim().startsWith('#') ? tagInput.trim() : `#${tagInput.trim()}`;
                            if (!markupForm.custom_tags.includes(newTag)) {
                              setMarkupForm(f => ({ ...f, custom_tags: [...f.custom_tags, newTag] }));
                            }
                            setTagInput('');
                          }
                        }}
                        placeholder="#태그 입력 후 Enter"
                        className="w-full px-2 py-1 bg-gray-50 border border-gray-200 rounded text-[10px] text-gray-600 placeholder-gray-400 focus:outline-none focus:border-sky-300"
                      />
                    </div>

                    {/* AI 추천 데이터 — 3-group contextual display */}
                    {(loadingNearby || parsedTags.lines.length > 0 || parsedTags.specs.length > 0 || parsedTags.equipment.length > 0) && (
                      <div className="mb-2 p-2 bg-purple-50/50 rounded-lg border border-purple-100">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Sparkles className="w-3 h-3 text-purple-600" />
                          <span className="text-[10px] text-purple-600 font-medium">AI 추천 데이터</span>
                          {loadingNearby && <Loader2 className="w-3 h-3 text-purple-600 animate-spin" />}
                          <span className="text-[9px] text-purple-400 ml-auto">클릭 시 자동 입력</span>
                        </div>

                        {/* ⚙️ 대상 기기 → click fills related_tag_no */}
                        {parsedTags.equipment.length > 0 && (
                          <div className="mb-1.5">
                            <span className="text-[9px] text-sky-600 font-medium block mb-0.5">⚙️ 대상 기기</span>
                            <div className="flex flex-wrap gap-1">
                              {parsedTags.equipment.map((tag, i) => (
                                <button
                                  key={i}
                                  onClick={() => setMarkupForm(f => ({ ...f, related_tag_no: tag }))}
                                  className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                    markupForm.related_tag_no === tag
                                      ? 'bg-sky-100 border-sky-400 text-sky-700 font-medium'
                                      : 'bg-white border-sky-200 text-sky-600 hover:bg-sky-50'
                                  }`}
                                  title="클릭: 관련 기기/태그번호에 입력"
                                >
                                  {tag}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* 🔀 관련 배관 → click appends to related_tag_no */}
                        {parsedTags.lines.length > 0 && (
                          <div className="mb-1.5">
                            <span className="text-[9px] text-emerald-600 font-medium block mb-0.5">🔀 관련 배관</span>
                            <div className="flex flex-wrap gap-1">
                              {parsedTags.lines.map((line, i) => (
                                <button
                                  key={i}
                                  onClick={() => setMarkupForm(f => ({
                                    ...f,
                                    related_tag_no: f.related_tag_no
                                      ? (f.related_tag_no.includes(line) ? f.related_tag_no : `${f.related_tag_no}, ${line}`)
                                      : line,
                                  }))}
                                  className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                    markupForm.related_tag_no?.includes(line)
                                      ? 'bg-emerald-100 border-emerald-400 text-emerald-700 font-medium'
                                      : 'bg-white border-emerald-200 text-emerald-600 hover:bg-emerald-50'
                                  }`}
                                  title="클릭: 관련 기기/태그번호에 추가"
                                >
                                  {line}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* 📊 주요 속성 → click adds to custom_tags */}
                        {parsedTags.specs.length > 0 && (
                          <div className="mb-0.5">
                            <span className="text-[9px] text-amber-600 font-medium block mb-0.5">📊 주요 속성</span>
                            <div className="flex flex-wrap gap-1">
                              {parsedTags.specs.map((spec, i) => {
                                const isAdded = markupForm.custom_tags.includes(spec.tag);
                                return (
                                  <button
                                    key={i}
                                    onClick={() => {
                                      if (isAdded) {
                                        setMarkupForm(f => ({ ...f, custom_tags: f.custom_tags.filter(t => t !== spec.tag) }));
                                      } else {
                                        setMarkupForm(f => ({ ...f, custom_tags: [...f.custom_tags, spec.tag] }));
                                      }
                                    }}
                                    className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                      isAdded
                                        ? 'bg-amber-100 border-amber-400 text-amber-700 font-medium'
                                        : 'bg-white border-amber-200 text-amber-600 hover:bg-amber-50'
                                    }`}
                                    title={`클릭: 사용자 태그에 ${spec.tag} 추가`}
                                  >
                                    {spec.label && <span className="text-amber-400 mr-0.5">{spec.label}:</span>}
                                    <span className="font-medium">{spec.value}</span>
                                    {spec.unit && <span className="text-amber-400 ml-0.5">{spec.unit}</span>}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Nearby lines (click to append to comment) */}
                    {nearbyLines.length > 0 && (
                      <div className="mb-2">
                        <span className="text-[10px] text-gray-400 mb-1 block">주변 텍스트 라인</span>
                        <div className="space-y-0.5 max-h-24 overflow-auto">
                          {nearbyLines.map((l, i) => (
                            <button
                              key={i}
                              onClick={() => setMarkupForm(f => ({ ...f, comment: f.comment + (f.comment ? '\n' : '') + l.content }))}
                              className="block w-full text-left px-2 py-0.5 bg-gray-50 text-[10px] text-gray-500 rounded hover:bg-white hover:text-gray-800 truncate transition-colors"
                            >
                              {l.content}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Comment textarea (compact) */}
                    <textarea
                      value={markupForm.comment}
                      onChange={e => setMarkupForm(f => ({ ...f, comment: e.target.value }))}
                      placeholder="코멘트를 입력하세요..."
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-600 placeholder-gray-400 focus:outline-none focus:border-sky-300 resize-none mb-2"
                      rows={2}
                      autoFocus
                    />

                    {/* Related search button */}
                    <div className="mb-2">
                      <button
                        onClick={() => handleRelatedSearch(markupForm.comment || nearbyWords.map(w => w.content).join(' '))}
                        disabled={loadingRelated || (!markupForm.comment.trim() && nearbyWords.length === 0)}
                        className="flex items-center gap-1 px-2 py-1 bg-purple-50 border border-purple-200 text-purple-600 rounded text-[10px] hover:bg-purple-100 disabled:opacity-40 transition-colors"
                      >
                        {loadingRelated ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                        관련 이력 조회
                      </button>
                    </div>

                    {/* Related results */}
                    {(relatedResults.markups.length > 0 || relatedResults.documents.length > 0) && (
                      <div className="mb-2 space-y-1.5 max-h-40 overflow-auto">
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

                    <div className="flex gap-2 mt-auto pt-2">
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
                    {isPlacingPin && (
                      <div className="flex items-center gap-2 p-2.5 bg-sky-50 border border-sky-200 rounded-lg mb-2">
                        <MapPin className="w-4 h-4 text-sky-600 animate-bounce" />
                        <span className="text-xs text-sky-700">도면에서 마크업 위치를 클릭하세요</span>
                      </div>
                    )}
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
                              <div className="flex items-center gap-1">
                                <p className={`text-xs truncate ${m.status === 'resolved' ? 'text-gray-400 line-through' : 'text-gray-600'}`}>
                                  {m.comment}
                                </p>
                                {m.related_tag_no && (
                                  <span className="text-[9px] px-1 py-0.5 bg-sky-50 text-sky-600 border border-sky-200 rounded flex-shrink-0">
                                    {m.related_tag_no}
                                  </span>
                                )}
                              </div>
                              {(m.issue_category || (m.impact_level && m.impact_level !== 'normal') || m.target_disciplines?.length > 0) && (
                                <div className="flex flex-wrap items-center gap-1 mt-0.5">
                                  {m.issue_category && ISSUE_CATEGORIES[m.issue_category] && (
                                    <span className={`text-[9px] px-1 py-0.5 rounded ${ISSUE_CATEGORIES[m.issue_category].bg} ${ISSUE_CATEGORIES[m.issue_category].text}`}>
                                      {ISSUE_CATEGORIES[m.issue_category].label}
                                    </span>
                                  )}
                                  {m.impact_level && m.impact_level !== 'normal' && IMPACT_LEVELS[m.impact_level] && (
                                    <span className={`text-[9px] px-1 py-0.5 rounded ${IMPACT_LEVELS[m.impact_level].bg} ${IMPACT_LEVELS[m.impact_level].text}`}>
                                      {IMPACT_LEVELS[m.impact_level].label}
                                    </span>
                                  )}
                                  {m.target_disciplines?.length > 0 && (
                                    <span className="text-[9px] text-gray-400">
                                      {m.target_disciplines.map(d => DISCIPLINES[d]?.label || d).join(', ')}
                                    </span>
                                  )}
                                </div>
                              )}
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

                  {/* ── PM Dashboard Section ── */}
                  {dashboard && (
                    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                      {/* Header with toggle */}
                      <button
                        onClick={() => setDashboardExpanded(e => !e)}
                        className="w-full flex items-center justify-between px-3 py-2 bg-gradient-to-r from-sky-50 to-cyan-50 hover:from-sky-100 hover:to-cyan-100 transition-colors"
                      >
                        <span className="text-xs font-semibold text-sky-700 flex items-center gap-1.5">
                          <span>📊</span> PM 대시보드
                        </span>
                        {dashboardExpanded ? <ChevronDown className="w-3.5 h-3.5 text-sky-500" /> : <ChevronRight className="w-3.5 h-3.5 text-sky-500" />}
                      </button>

                      {dashboardExpanded && (
                        <div className="p-3 space-y-3">

                          {/* ① Stats Cards (2×2) */}
                          <div className="grid grid-cols-2 gap-2">
                            <div className="bg-gray-50 rounded-lg p-2.5 text-center">
                              <p className="text-lg font-bold text-gray-700">{dashboard.total_markups || 0}</p>
                              <p className="text-[9px] text-gray-400">전체 마크업</p>
                            </div>
                            <div className="bg-red-50 rounded-lg p-2.5 text-center">
                              <p className="text-lg font-bold text-red-600">{dashboard.open_markups || 0}</p>
                              <p className="text-[9px] text-red-400">미해결</p>
                            </div>
                            <div className="bg-blue-50 rounded-lg p-2.5 text-center">
                              <p className="text-lg font-bold text-blue-600">{dashboard.resolved_markups || 0}</p>
                              <p className="text-[9px] text-blue-400">해결됨</p>
                            </div>
                            <div className="bg-green-50 rounded-lg p-2.5 text-center">
                              <p className="text-lg font-bold text-green-600">{dashboard.confirmed_markups || 0}</p>
                              <p className="text-[9px] text-green-400">확정</p>
                            </div>
                          </div>

                          {/* ② Progress Bar */}
                          {dashboard.total_markups > 0 && (() => {
                            const done = (dashboard.resolved_markups || 0) + (dashboard.confirmed_markups || 0) + (dashboard.final_markups || 0);
                            const pct = Math.round(done / dashboard.total_markups * 100);
                            return (
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-[9px] text-gray-400">진행률</span>
                                  <span className="text-[10px] font-semibold text-gray-600">{pct}%</span>
                                </div>
                                <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                                  <div
                                    className="h-full rounded-full transition-all duration-500"
                                    style={{ width: `${pct}%`, background: 'linear-gradient(90deg, #3b82f6, #22c55e)' }}
                                  />
                                </div>
                              </div>
                            );
                          })()}

                          {/* ③ Discipline Distribution */}
                          {dashboard.markups_by_discipline && Object.keys(dashboard.markups_by_discipline).length > 0 && (
                            <div>
                              <p className="text-[9px] text-gray-400 mb-1.5">공종별 분포</p>
                              <div className="space-y-1">
                                {Object.entries(dashboard.markups_by_discipline).map(([disc, count]) => {
                                  const maxCount = Math.max(...Object.values(dashboard.markups_by_discipline));
                                  const barWidth = maxCount > 0 ? (count / maxCount * 100) : 0;
                                  return (
                                    <button
                                      key={disc}
                                      onClick={() => setDashboardFilter(f => ({ ...f, discipline: f.discipline === disc ? 'all' : disc }))}
                                      className={`w-full flex items-center gap-2 p-1 rounded text-left hover:bg-gray-50 transition-colors ${
                                        dashboardFilter.discipline === disc ? 'ring-1 ring-sky-300 bg-sky-50' : ''
                                      }`}
                                    >
                                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: DISCIPLINES[disc]?.color || '#888' }} />
                                      <span className="text-[9px] text-gray-600 w-8 flex-shrink-0">{DISCIPLINES[disc]?.label || disc}</span>
                                      <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                                        <div className="h-full rounded-full" style={{ width: `${barWidth}%`, backgroundColor: DISCIPLINES[disc]?.color || '#888' }} />
                                      </div>
                                      <span className="text-[9px] font-medium text-gray-500 w-5 text-right">{count}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* ④ Drawings Summary Table */}
                          {dashboard.drawings_summary && (() => {
                            const withMarkups = dashboard.drawings_summary.filter(d => d.markup_count > 0);
                            if (withMarkups.length === 0) return null;
                            return (
                              <div>
                                <p className="text-[9px] text-gray-400 mb-1.5">도면별 요약</p>
                                <div className="border border-gray-200 rounded-lg overflow-hidden">
                                  <table className="w-full text-[9px]">
                                    <thead>
                                      <tr className="bg-gray-50 text-gray-500">
                                        <th className="px-2 py-1 text-left font-medium">도면번호</th>
                                        <th className="px-1 py-1 text-left font-medium">공종</th>
                                        <th className="px-1 py-1 text-center font-medium">마크업</th>
                                        <th className="px-1 py-1 text-center font-medium">미해결</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {withMarkups.map(d => (
                                        <tr
                                          key={d.drawing_id}
                                          onClick={() => {
                                            const dwg = (projectDetail?.drawings || []).find(dd => dd.drawing_id === d.drawing_id);
                                            if (dwg) setSelectedDrawing(dwg);
                                          }}
                                          className="border-t border-gray-100 hover:bg-sky-50 cursor-pointer transition-colors"
                                        >
                                          <td className="px-2 py-1 text-gray-700 truncate max-w-[100px]">{d.drawing_number || '-'}</td>
                                          <td className="px-1 py-1">
                                            <span className="inline-flex items-center gap-0.5">
                                              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: DISCIPLINES[d.discipline]?.color || '#888' }} />
                                              <span className="text-gray-500">{DISCIPLINES[d.discipline]?.label || d.discipline}</span>
                                            </span>
                                          </td>
                                          <td className="px-1 py-1 text-center text-gray-600">{d.markup_count}</td>
                                          <td className="px-1 py-1 text-center">
                                            {d.open_count > 0
                                              ? <span className="inline-block px-1.5 py-0.5 bg-red-50 text-red-600 rounded-full text-[8px] font-medium">{d.open_count}</span>
                                              : <span className="text-gray-300">0</span>
                                            }
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            );
                          })()}

                          {/* ⑤ Full Markup List (filterable) */}
                          <div>
                            <p className="text-[9px] text-gray-400 mb-1.5">전체 마크업 리스트</p>
                            {/* Filter Bar */}
                            <div className="flex gap-1.5 mb-2">
                              <select
                                value={dashboardFilter.status}
                                onChange={e => setDashboardFilter(f => ({ ...f, status: e.target.value }))}
                                className="flex-1 text-[9px] px-1.5 py-1 border border-gray-200 rounded bg-white text-gray-600"
                              >
                                <option value="all">상태: 전체</option>
                                <option value="open">미해결</option>
                                <option value="resolved">해결됨</option>
                                <option value="confirmed">확정</option>
                                <option value="final">최종</option>
                              </select>
                              <select
                                value={dashboardFilter.discipline}
                                onChange={e => setDashboardFilter(f => ({ ...f, discipline: e.target.value }))}
                                className="flex-1 text-[9px] px-1.5 py-1 border border-gray-200 rounded bg-white text-gray-600"
                              >
                                <option value="all">공종: 전체</option>
                                {Object.entries(DISCIPLINES).map(([k, v]) => (
                                  <option key={k} value={k}>{v.label}</option>
                                ))}
                              </select>
                            </div>
                            {/* List */}
                            <div className="space-y-1 max-h-60 overflow-auto">
                              {filteredDashboardMarkups.length === 0 ? (
                                <p className="text-[9px] text-gray-300 text-center py-4">해당 조건의 마크업이 없습니다</p>
                              ) : filteredDashboardMarkups.map(m => (
                                <button
                                  key={m.markup_id}
                                  onClick={() => handleDashboardNavigate(m)}
                                  className={`w-full flex items-center gap-1.5 p-1.5 rounded text-left hover:bg-sky-50 transition-colors ${
                                    m.impact_level === 'critical' ? 'border border-red-300 bg-red-50/30' : 'bg-gray-50'
                                  }`}
                                >
                                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: DISCIPLINES[m.discipline]?.color || '#888' }} />
                                  <span className="text-[9px] text-gray-500 flex-shrink-0 w-16 truncate">{m.drawing_number || '-'}</span>
                                  <span className="text-[9px] text-gray-700 flex-1 truncate">{m.comment || '(코멘트 없음)'}</span>
                                  <span className={`text-[8px] px-1 py-0.5 rounded flex-shrink-0 ${
                                    m.status === 'open' ? 'bg-red-50 text-red-600' :
                                    m.status === 'resolved' ? 'bg-blue-50 text-blue-600' :
                                    m.status === 'confirmed' ? 'bg-green-50 text-green-600' :
                                    m.status === 'final' ? 'bg-purple-50 text-purple-600' :
                                    'bg-gray-100 text-gray-400'
                                  }`}>{m.status}</span>
                                  {m.impact_level === 'critical' && (
                                    <AlertTriangle className="w-2.5 h-2.5 text-red-500 flex-shrink-0" />
                                  )}
                                </button>
                              ))}
                            </div>
                          </div>

                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Existing Consolidation Content ── */}
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
              <button onClick={handleCancelUpload}
                      className="px-4 py-2.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 rounded-lg text-sm font-medium transition-colors">
                취소 (삭제)
              </button>
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
