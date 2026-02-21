import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  Scale, Upload, FileText, Plus, Send, ChevronLeft, ChevronRight,
  X, Trash2, AlertCircle, CheckCircle2, MessageSquare, Filter,
  Search, Home, FolderOpen, RefreshCw, ArrowRight, Folder, File, Loader2
} from 'lucide-react';

const API_BASE = (import.meta.env.VITE_API_URL || 'https://drawing-detector-backend-435353955407.us-central1.run.app').replace(/\/$/, '');
const getUrl = (path) => `${API_BASE}/api/v1/contracts/${path}`;

const getToken = async () => {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');
  return user.getIdToken();
};

const ContractDeviation = () => {
  const navigate = useNavigate();
  const { currentUser } = useAuth();

  // State
  const [contracts, setContracts] = useState([]);
  const [selectedContractId, setSelectedContractId] = useState(null);
  const [contractData, setContractData] = useState(null);
  const [selectedArticleNo, setSelectedArticleNo] = useState(null);
  const [selectedDeviationId, setSelectedDeviationId] = useState(null);
  const [showDeviationPanel, setShowDeviationPanel] = useState(false);
  const [showNewDevForm, setShowNewDevForm] = useState(false);
  const [newDeviation, setNewDeviation] = useState({ subject: '', initial_comment: '', author_role: 'contractor', author_name: '' });
  const [newComment, setNewComment] = useState('');
  const [commentRole, setCommentRole] = useState('contractor');
  const [filterChapter, setFilterChapter] = useState(null);
  const [filterStatus, setFilterStatus] = useState(null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [showParseModal, setShowParseModal] = useState(false);
  const [parsePath, setParsePath] = useState('');
  const [parseName, setParseName] = useState('');
  const [browsePath, setBrowsePath] = useState('');
  const [browseItems, setBrowseItems] = useState([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [selectedBlobFile, setSelectedBlobFile] = useState(null);

  const fileInputRef = useRef(null);
  const commentEndRef = useRef(null);

  // Load contracts on mount
  useEffect(() => {
    loadContracts();
  }, []);

  // Auto-scroll comments
  useEffect(() => {
    if (commentEndRef.current) {
      commentEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [selectedDeviationId, contractData]);

  // ── API Functions ──

  const loadContracts = async () => {
    try {
      const token = await getToken();
      const res = await fetch(getUrl('list'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load contracts');
      const data = await res.json();
      setContracts(data.contracts || []);
    } catch (e) {
      console.error('Load contracts error:', e);
    }
  };

  const loadContractDetail = async (contractId) => {
    setLoading(true);
    setError('');
    try {
      const token = await getToken();
      const res = await fetch(getUrl(contractId), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load contract');
      const data = await res.json();
      setContractData(data);
      setSelectedContractId(contractId);
      setSelectedArticleNo(null);
      setSelectedDeviationId(null);
      setShowDeviationPanel(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleUploadContract = async (file) => {
    setUploading(true);
    setError('');
    try {
      const token = await getToken();
      const formData = new FormData();
      formData.append('file', file);
      formData.append('contract_name', file.name.replace(/\.pdf$/i, ''));
      const res = await fetch(getUrl('upload'), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Upload failed');
      }
      const data = await res.json();
      await loadContracts();
      await loadContractDetail(data.contract_id);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handleParseExisting = async (filePath, fileName) => {
    const jsonPath = filePath || parsePath.trim();
    if (!jsonPath) return;
    setUploading(true);
    setError('');
    setShowParseModal(false);
    try {
      const token = await getToken();
      const name = fileName || parseName.trim() || jsonPath.split('/').pop()?.replace(/\.json$/i, '') || '';
      const res = await fetch(getUrl('parse-existing'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ json_path: jsonPath, contract_name: name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Parse failed');
      }
      const data = await res.json();
      await loadContracts();
      await loadContractDetail(data.contract_id);
      setParsePath('');
      setParseName('');
      setSelectedBlobFile(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const isAdmin = currentUser?.email === 'admin@poscoenc.com';

  const getInitialBrowsePath = () => {
    if (isAdmin) return '';
    const userName = currentUser?.displayName || currentUser?.email?.split('@')[0] || '';
    return userName ? `${userName}/json/` : '';
  };

  const fetchBlobItems = async (path = '') => {
    setBrowseLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/azure/list?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error('Failed to browse files');
      const items = await res.json();
      setBrowseItems(items);
      setBrowsePath(path);
    } catch (e) {
      console.error('Browse error:', e);
      setBrowseItems([]);
    } finally {
      setBrowseLoading(false);
    }
  };

  const openBrowseModal = () => {
    setShowParseModal(true);
    setSelectedBlobFile(null);
    setParseName('');
    const initialPath = getInitialBrowsePath();
    fetchBlobItems(initialPath);
  };

  const handleBrowseNavigate = (item) => {
    if (item.type === 'folder') {
      fetchBlobItems(item.path);
      setSelectedBlobFile(null);
    } else {
      setSelectedBlobFile(item);
      setParsePath(item.path);
      setParseName(item.name.replace(/\.json$/i, ''));
    }
  };

  const handleBrowseUp = () => {
    const minPath = isAdmin ? '' : getInitialBrowsePath();
    if (!browsePath || browsePath === minPath) return;
    const parts = browsePath.replace(/\/$/, '').split('/');
    parts.pop();
    const parentPath = parts.length > 0 ? parts.join('/') + '/' : '';
    // Don't go above the user's root (for non-admin)
    if (!isAdmin && !parentPath.startsWith(minPath.split('/')[0])) return;
    fetchBlobItems(parentPath);
    setSelectedBlobFile(null);
  };

  const handleCreateDeviation = async () => {
    if (!selectedArticleNo || !newDeviation.subject.trim()) return;
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`${selectedContractId}/deviations`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          article_no: selectedArticleNo,
          subject: newDeviation.subject,
          initial_comment: newDeviation.initial_comment,
          author_role: newDeviation.author_role,
          author_name: newDeviation.author_name || currentUser?.displayName || '',
        }),
      });
      if (!res.ok) throw new Error('Failed to create deviation');
      setNewDeviation({ subject: '', initial_comment: '', author_role: 'contractor', author_name: '' });
      setShowNewDevForm(false);
      await loadContractDetail(selectedContractId);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleAddComment = async () => {
    if (!newComment.trim() || !selectedDeviationId) return;
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`${selectedContractId}/deviations/${selectedDeviationId}/comments`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          author: commentRole,
          author_name: currentUser?.displayName || '',
          content: newComment,
        }),
      });
      if (!res.ok) throw new Error('Failed to add comment');
      setNewComment('');
      await loadContractDetail(selectedContractId);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleToggleStatus = async (deviationId, currentStatus) => {
    const newStatus = currentStatus === 'open' ? 'closed' : 'open';
    try {
      const token = await getToken();
      const res = await fetch(getUrl(`${selectedContractId}/deviations/${deviationId}/status`), {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error('Failed to update status');
      await loadContractDetail(selectedContractId);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDeleteContract = async (contractId) => {
    if (!confirm('이 계약서를 삭제하시겠습니까? 모든 데이터가 삭제됩니다.')) return;
    try {
      const token = await getToken();
      const res = await fetch(getUrl(contractId), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Delete failed');
      if (selectedContractId === contractId) {
        setSelectedContractId(null);
        setContractData(null);
      }
      await loadContracts();
    } catch (e) {
      setError(e.message);
    }
  };

  // ── Computed Values ──

  const articles = contractData?.articles || [];
  const deviations = contractData?.deviations || [];
  const chapters = contractData?.chapters || [];
  const stats = contractData?.stats || {};

  const filteredArticles = articles.filter(art => {
    if (filterChapter && art.chapter !== filterChapter) return false;
    if (searchKeyword) {
      const kw = searchKeyword.toLowerCase();
      if (!(`제${art.no}조`.includes(kw) || art.title.toLowerCase().includes(kw) || (art.content || '').toLowerCase().includes(kw))) return false;
    }
    return true;
  });

  const getArticleDeviations = (articleNo) => deviations.filter(d => d.article_no === articleNo);
  const getFilteredDeviations = (articleNo) => {
    let devs = getArticleDeviations(articleNo);
    if (filterStatus) devs = devs.filter(d => d.status === filterStatus);
    return devs;
  };

  const selectedDeviation = deviations.find(d => d.deviation_id === selectedDeviationId);
  const articleDeviations = selectedArticleNo ? getFilteredDeviations(selectedArticleNo) : [];
  const selectedArticle = articles.find(a => a.no === selectedArticleNo);

  // ── Render ──
  return (
    <div className="h-screen flex bg-gray-50 overflow-hidden">
      {/* Sidebar */}
      <div className="w-72 bg-white border-r border-gray-200 flex flex-col shrink-0">
        {/* Sidebar Header */}
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center gap-2 mb-3">
            <Scale className="w-6 h-6 text-indigo-600" />
            <h1 className="text-lg font-bold text-gray-900">계약 Deviation 관리</h1>
          </div>
          <button
            onClick={() => navigate('/')}
            className="text-xs text-gray-500 hover:text-indigo-600 flex items-center gap-1"
          >
            <Home className="w-3 h-3" /> 메인으로
          </button>
        </div>

        {/* Upload Buttons */}
        <div className="p-3 border-b border-gray-200 space-y-2">
          <input
            type="file"
            ref={fileInputRef}
            accept=".pdf"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.[0]) handleUploadContract(e.target.files[0]);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm font-medium"
          >
            {uploading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? '처리 중...' : 'PDF 업로드'}
          </button>
          <button
            onClick={openBrowseModal}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
          >
            <FolderOpen className="w-4 h-4" />
            기존 JSON 파싱
          </button>
        </div>

        {/* Contract List */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-2">
            <p className="text-xs text-gray-500 px-2 py-1 font-medium">계약서 목록 ({contracts.length})</p>
            {contracts.map(c => (
              <div
                key={c.contract_id}
                onClick={() => loadContractDetail(c.contract_id)}
                className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer text-sm mb-1 transition-colors ${
                  selectedContractId === c.contract_id
                    ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                    : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                <FileText className="w-4 h-4 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="truncate font-medium">{c.contract_name}</p>
                  <p className="text-xs text-gray-400">{c.articles_count}개 조항</p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteContract(c.contract_id); }}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition-opacity"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {contracts.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-8">계약서를 업로드하세요</p>
            )}
          </div>
        </div>

        {/* Summary Dashboard */}
        {contractData && (
          <div className="p-3 border-t border-gray-200 bg-gray-50">
            <p className="text-xs font-semibold text-gray-600 mb-2">요약</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-white rounded-lg p-2 border">
                <p className="text-lg font-bold text-gray-800">{stats.total_articles || 0}</p>
                <p className="text-[10px] text-gray-500">전체 조항</p>
              </div>
              <div className="bg-white rounded-lg p-2 border">
                <p className="text-lg font-bold text-orange-500">{stats.open_deviations || 0}</p>
                <p className="text-[10px] text-gray-500">Open</p>
              </div>
              <div className="bg-white rounded-lg p-2 border">
                <p className="text-lg font-bold text-green-500">{stats.closed_deviations || 0}</p>
                <p className="text-[10px] text-gray-500">Closed</p>
              </div>
            </div>
          </div>
        )}

        {/* User Info */}
        <div className="p-3 border-t border-gray-200">
          <p className="text-xs text-gray-500 truncate">{currentUser?.email}</p>
        </div>
      </div>

      {/* Main Content: Articles Table */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!contractData ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <Scale className="w-16 h-16 mx-auto mb-4 opacity-30" />
              <p className="text-lg font-medium">계약서를 선택하거나 업로드하세요</p>
              <p className="text-sm mt-1">PDF에서 조항을 자동 추출합니다</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-200 bg-white">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">{contractData.contract_name}</h2>
                  <p className="text-sm text-gray-500">
                    {contractData.total_pages}페이지 | {chapters.length}개 장 | {articles.length}개 조항 | Deviation {stats.total_deviations || 0}건
                  </p>
                </div>
              </div>

              {/* Filters */}
              <div className="flex items-center gap-3 mt-3">
                <div className="relative flex-1 max-w-xs">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="조항 검색..."
                    value={searchKeyword}
                    onChange={e => setSearchKeyword(e.target.value)}
                    className="w-full pl-9 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
                <select
                  value={filterChapter || ''}
                  onChange={e => setFilterChapter(e.target.value ? parseInt(e.target.value) : null)}
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">전체 장</option>
                  {chapters.map(ch => (
                    <option key={ch.no} value={ch.no}>제{ch.no}장 {ch.title}</option>
                  ))}
                </select>
                <select
                  value={filterStatus || ''}
                  onChange={e => setFilterStatus(e.target.value || null)}
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">전체 상태</option>
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </select>
                {(filterChapter || filterStatus || searchKeyword) && (
                  <button
                    onClick={() => { setFilterChapter(null); setFilterStatus(null); setSearchKeyword(''); }}
                    className="text-xs text-gray-500 hover:text-indigo-600"
                  >
                    필터 초기화
                  </button>
                )}
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="mx-6 mt-3 p-3 bg-red-50 text-red-700 rounded-lg text-sm flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
                <button onClick={() => setError('')} className="ml-auto"><X className="w-4 h-4" /></button>
              </div>
            )}

            {/* Table */}
            <div className="flex-1 overflow-auto px-6 py-4">
              {loading ? (
                <div className="flex items-center justify-center py-20">
                  <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin" />
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Group by chapter */}
                  {(() => {
                    const chapterGroups = {};
                    filteredArticles.forEach(art => {
                      const ch = art.chapter || 0;
                      if (!chapterGroups[ch]) chapterGroups[ch] = [];
                      chapterGroups[ch].push(art);
                    });
                    const chapterNos = Object.keys(chapterGroups).map(Number).sort((a, b) => a - b);

                    return chapterNos.map(chNo => {
                      const chapterInfo = chapters.find(c => c.no === chNo);
                      const chArticles = chapterGroups[chNo];

                      return (
                        <div key={chNo}>
                          {chapterInfo && (
                            <div className="flex items-center gap-2 mb-2">
                              <div className="h-px flex-1 bg-indigo-200" />
                              <span className="text-sm font-semibold text-indigo-700 px-2">
                                제{chapterInfo.no}장 {chapterInfo.title}
                              </span>
                              <div className="h-px flex-1 bg-indigo-200" />
                            </div>
                          )}
                          <table className="w-full bg-white border border-gray-200 rounded-lg overflow-hidden text-sm">
                            <thead>
                              <tr className="bg-gray-50 text-gray-600">
                                <th className="px-3 py-2 text-left w-16">No</th>
                                <th className="px-3 py-2 text-left">조항명</th>
                                <th className="px-3 py-2 text-center w-16">페이지</th>
                                <th className="px-3 py-2 text-center w-16">항 수</th>
                                <th className="px-3 py-2 text-center w-24">Deviation</th>
                                <th className="px-3 py-2 text-center w-24">상태</th>
                                <th className="px-3 py-2 text-center w-20">액션</th>
                              </tr>
                            </thead>
                            <tbody>
                              {chArticles.map(art => {
                                const artDevs = getArticleDeviations(art.no);
                                const openCount = artDevs.filter(d => d.status === 'open').length;
                                const closedCount = artDevs.filter(d => d.status === 'closed').length;

                                return (
                                  <tr
                                    key={art.no}
                                    onClick={() => {
                                      setSelectedArticleNo(art.no);
                                      setShowDeviationPanel(true);
                                      setSelectedDeviationId(null);
                                      setShowNewDevForm(false);
                                    }}
                                    className={`border-t border-gray-100 cursor-pointer transition-colors ${
                                      selectedArticleNo === art.no ? 'bg-indigo-50' : 'hover:bg-gray-50'
                                    }`}
                                  >
                                    <td className="px-3 py-2.5 font-mono text-gray-600">제{art.no}조</td>
                                    <td className="px-3 py-2.5">
                                      <span className="font-medium text-gray-800">{art.title}</span>
                                    </td>
                                    <td className="px-3 py-2.5 text-center text-gray-500">{art.page}</td>
                                    <td className="px-3 py-2.5 text-center text-gray-500">{art.sub_clauses || '-'}</td>
                                    <td className="px-3 py-2.5 text-center">
                                      {artDevs.length > 0 ? (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-medium">
                                          <MessageSquare className="w-3 h-3" />
                                          {artDevs.length}
                                        </span>
                                      ) : (
                                        <span className="text-gray-300">-</span>
                                      )}
                                    </td>
                                    <td className="px-3 py-2.5 text-center">
                                      {openCount > 0 ? (
                                        <span className="inline-block px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 text-xs font-medium">
                                          Open {openCount}
                                        </span>
                                      ) : closedCount > 0 ? (
                                        <span className="inline-block px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-xs font-medium">
                                          Closed {closedCount}
                                        </span>
                                      ) : (
                                        <span className="text-gray-300">-</span>
                                      )}
                                    </td>
                                    <td className="px-3 py-2.5 text-center">
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedArticleNo(art.no);
                                          setShowDeviationPanel(true);
                                          setShowNewDevForm(true);
                                          setSelectedDeviationId(null);
                                        }}
                                        className="p-1 hover:bg-indigo-100 rounded text-indigo-600"
                                        title="Deviation 추가"
                                      >
                                        <Plus className="w-4 h-4" />
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      );
                    });
                  })()}

                  {filteredArticles.length === 0 && (
                    <div className="text-center py-12 text-gray-400">
                      <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
                      <p>조항이 없습니다</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Right Panel: Article Content + Deviation Detail */}
      {showDeviationPanel && selectedArticleNo && (
        <div className="w-[480px] bg-white border-l border-gray-200 flex flex-col shrink-0">
          {/* Panel Header */}
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-bold text-gray-900">
                제{selectedArticleNo}조 {selectedArticle?.title}
              </h3>
              <button onClick={() => { setShowDeviationPanel(false); setSelectedArticleNo(null); }}>
                <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
              </button>
            </div>
            <p className="text-xs text-gray-500">
              페이지 {selectedArticle?.page || '-'} | 항 {selectedArticle?.sub_clauses || 0}개 | Deviation {articleDeviations.length}건
            </p>
          </div>

          {/* Article Content */}
          <div className="border-b border-gray-200">
            <div className="px-4 py-2 bg-indigo-50/50 flex items-center justify-between">
              <span className="text-xs font-semibold text-indigo-700">조항 본문</span>
              <span className="text-[10px] text-indigo-400">제{selectedArticle?.chapter ? `${selectedArticle.chapter}장` : '-'}</span>
            </div>
            <div className="px-4 py-3 max-h-[35vh] overflow-y-auto">
              <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                {selectedArticle?.content || '(본문 내용 없음)'}
              </p>
            </div>
          </div>

          {/* Deviation List or Thread */}
          <div className="flex-1 overflow-y-auto">
            {!selectedDeviationId ? (
              // Deviation list for this article
              <div className="p-3 space-y-2">
                {articleDeviations.map(dev => (
                  <div
                    key={dev.deviation_id}
                    onClick={() => setSelectedDeviationId(dev.deviation_id)}
                    className="p-3 border border-gray-200 rounded-lg cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/50 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <p className="font-medium text-sm text-gray-800 flex-1">{dev.subject}</p>
                      <span className={`ml-2 shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${
                        dev.status === 'open'
                          ? 'bg-orange-100 text-orange-700'
                          : 'bg-green-100 text-green-700'
                      }`}>
                        {dev.status === 'open' ? 'Open' : 'Closed'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                      <span>{dev.created_by}</span>
                      <span>{new Date(dev.created_at).toLocaleDateString('ko-KR')}</span>
                      <span className="flex items-center gap-1">
                        <MessageSquare className="w-3 h-3" />
                        {dev.comments?.length || 0}
                      </span>
                    </div>
                  </div>
                ))}

                {articleDeviations.length === 0 && !showNewDevForm && (
                  <div className="text-center py-8 text-gray-400">
                    <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">등록된 Deviation이 없습니다</p>
                  </div>
                )}

                {/* New Deviation Form */}
                {showNewDevForm ? (
                  <div className="p-3 border-2 border-indigo-200 rounded-lg bg-indigo-50/50">
                    <p className="text-sm font-semibold text-indigo-700 mb-3">새 Deviation 등록</p>
                    <input
                      type="text"
                      placeholder="제목 (Deviation 사유)"
                      value={newDeviation.subject}
                      onChange={e => setNewDeviation(prev => ({ ...prev, subject: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                    <textarea
                      placeholder="초기 코멘트 (선택사항)"
                      value={newDeviation.initial_comment}
                      onChange={e => setNewDeviation(prev => ({ ...prev, initial_comment: e.target.value }))}
                      rows={3}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 resize-none"
                    />
                    <div className="flex items-center gap-2 mb-3">
                      <select
                        value={newDeviation.author_role}
                        onChange={e => setNewDeviation(prev => ({ ...prev, author_role: e.target.value }))}
                        className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
                      >
                        <option value="contractor">시공사</option>
                        <option value="client">발주처</option>
                      </select>
                      <input
                        type="text"
                        placeholder="작성자명"
                        value={newDeviation.author_name}
                        onChange={e => setNewDeviation(prev => ({ ...prev, author_name: e.target.value }))}
                        className="flex-1 px-2 py-1 border border-gray-300 rounded-lg text-sm"
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setShowNewDevForm(false)}
                        className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                      >
                        취소
                      </button>
                      <button
                        onClick={handleCreateDeviation}
                        disabled={!newDeviation.subject.trim()}
                        className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                      >
                        등록
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowNewDevForm(true)}
                    className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:border-indigo-400 hover:text-indigo-600 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Deviation 추가
                  </button>
                )}
              </div>
            ) : (
              // Comment thread view
              <div className="flex flex-col h-full">
                {/* Thread Header */}
                <div className="p-3 border-b border-gray-100">
                  <button
                    onClick={() => setSelectedDeviationId(null)}
                    className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 mb-2"
                  >
                    <ChevronLeft className="w-3 h-3" /> 목록으로
                  </button>
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-sm text-gray-800">{selectedDeviation?.subject}</p>
                    <button
                      onClick={() => handleToggleStatus(selectedDeviationId, selectedDeviation?.status)}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                        selectedDeviation?.status === 'open'
                          ? 'bg-orange-100 text-orange-700 hover:bg-orange-200'
                          : 'bg-green-100 text-green-700 hover:bg-green-200'
                      }`}
                    >
                      {selectedDeviation?.status === 'open' ? 'Open → Close' : 'Closed → Open'}
                    </button>
                  </div>
                </div>

                {/* Comments */}
                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                  {(selectedDeviation?.comments || []).map(comment => (
                    <div
                      key={comment.comment_id}
                      className={`flex ${comment.author === 'client' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div className={`max-w-[85%] rounded-xl px-3 py-2 ${
                        comment.author === 'client'
                          ? 'bg-orange-50 border border-orange-200'
                          : 'bg-blue-50 border border-blue-200'
                      }`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs font-semibold ${
                            comment.author === 'client' ? 'text-orange-700' : 'text-blue-700'
                          }`}>
                            {comment.author === 'client' ? '발주처' : '시공사'}
                            {comment.author_name ? ` (${comment.author_name})` : ''}
                          </span>
                          <span className="text-[10px] text-gray-400">
                            {new Date(comment.created_at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <p className="text-sm text-gray-800 whitespace-pre-wrap">{comment.content}</p>
                      </div>
                    </div>
                  ))}
                  <div ref={commentEndRef} />
                </div>

                {/* Comment Input */}
                <div className="p-3 border-t border-gray-200 bg-gray-50">
                  <div className="flex items-center gap-2 mb-2">
                    <select
                      value={commentRole}
                      onChange={e => setCommentRole(e.target.value)}
                      className="border border-gray-300 rounded-lg px-2 py-1 text-xs"
                    >
                      <option value="contractor">시공사</option>
                      <option value="client">발주처</option>
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="코멘트 입력..."
                      value={newComment}
                      onChange={e => setNewComment(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddComment(); } }}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                    <button
                      onClick={handleAddComment}
                      disabled={!newComment.trim()}
                      className="p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* File Browser Modal */}
      {showParseModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
            {/* Modal Header */}
            <div className="p-4 border-b border-gray-200">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-bold text-gray-900">JSON 파일 선택</h3>
                <button onClick={() => { setShowParseModal(false); setParsePath(''); setParseName(''); setSelectedBlobFile(null); }}>
                  <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
                </button>
              </div>
              {/* Breadcrumb */}
              <div className="flex items-center gap-1 text-sm text-gray-500 bg-gray-50 rounded-lg px-3 py-1.5">
                <button
                  onClick={() => { const p = getInitialBrowsePath(); fetchBlobItems(isAdmin ? '' : p); setSelectedBlobFile(null); }}
                  className="hover:text-indigo-600 font-medium"
                >
                  {isAdmin ? 'Root' : 'Home'}
                </button>
                {browsePath && browsePath.split('/').filter(Boolean).map((part, i, arr) => {
                  const pathUpTo = arr.slice(0, i + 1).join('/') + '/';
                  return (
                    <React.Fragment key={i}>
                      <span className="text-gray-300">/</span>
                      <button
                        onClick={() => { fetchBlobItems(pathUpTo); setSelectedBlobFile(null); }}
                        className="hover:text-indigo-600 truncate max-w-[120px]"
                        title={part}
                      >
                        {part}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>

            {/* File List */}
            <div className="flex-1 overflow-y-auto min-h-[300px]">
              {browseLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {/* Up button */}
                  {browsePath && (isAdmin || browsePath !== getInitialBrowsePath()) && (
                    <button
                      onClick={handleBrowseUp}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 text-sm text-gray-600"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      <span>상위 폴더</span>
                    </button>
                  )}
                  {browseItems.map((item, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleBrowseNavigate(item)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                        selectedBlobFile?.path === item.path
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'hover:bg-gray-50 text-gray-700'
                      }`}
                    >
                      {item.type === 'folder' ? (
                        <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                      ) : (
                        <File className={`w-4 h-4 shrink-0 ${item.name.endsWith('.json') ? 'text-indigo-500' : 'text-gray-400'}`} />
                      )}
                      <span className="truncate flex-1 text-left">{item.name}</span>
                      {item.type === 'file' && item.size && (
                        <span className="text-xs text-gray-400 shrink-0">
                          {item.size > 1048576 ? `${(item.size / 1048576).toFixed(1)}MB` : `${(item.size / 1024).toFixed(0)}KB`}
                        </span>
                      )}
                      {item.type === 'folder' && (
                        <ChevronRight className="w-4 h-4 text-gray-300 shrink-0" />
                      )}
                    </button>
                  ))}
                  {browseItems.length === 0 && !browseLoading && (
                    <div className="text-center py-12 text-gray-400 text-sm">
                      <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <p>파일이 없습니다</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Selected File & Action */}
            <div className="p-4 border-t border-gray-200 bg-gray-50">
              {selectedBlobFile ? (
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{selectedBlobFile.name}</p>
                    <p className="text-xs text-gray-400 truncate">{selectedBlobFile.path}</p>
                  </div>
                  <button
                    onClick={() => handleParseExisting(selectedBlobFile.path, selectedBlobFile.name.replace(/\.json$/i, ''))}
                    className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium shrink-0"
                  >
                    파싱 시작
                  </button>
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center">JSON 파일을 선택하세요</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContractDeviation;
