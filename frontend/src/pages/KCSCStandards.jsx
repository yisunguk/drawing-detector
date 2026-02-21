import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
    Send, Bot, User, Loader2, Search as SearchIcon,
    ChevronRight, X, LogOut, MessageSquare, Plus, Trash2,
    Landmark, BookOpen, List, ChevronDown, ChevronUp, FileText
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../contexts/AuthContext';
import { auth, db } from '../firebase';
import {
    collection, addDoc, getDocs, deleteDoc, doc, updateDoc,
    serverTimestamp, query, orderBy, limit
} from 'firebase/firestore';

const API_BASE = (import.meta.env.VITE_API_URL || 'https://drawing-detector-backend-435353955407.us-central1.run.app').replace(/\/$/, '');

const getKcscChatUrl = () => `${API_BASE}/api/v1/kcsc/chat`;
const getKcscSectionsUrl = (code, type) => `${API_BASE}/api/v1/kcsc/sections?code=${encodeURIComponent(code)}&type=${encodeURIComponent(type)}`;

// ============================================================
// Citation button component for inline [[sec-N|Title]] links
// ============================================================
const CitationButton = ({ sectionId, title, onClick }) => (
    <button
        onClick={(e) => { e.preventDefault(); onClick(sectionId); }}
        className="inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 text-xs font-medium bg-[#f4f1ea] text-[#d97757] border border-[#e5e1d8] rounded-md hover:bg-[#e5e1d8] transition-colors cursor-pointer"
        title={`${title} 섹션으로 이동`}
    >
        <FileText className="w-3 h-3" />
        {title}
    </button>
);

// ============================================================
// Chat message content with citation parsing
// ============================================================
const ChatMessageContent = React.memo(({ content, onCitationClick }) => {
    // Split content by [[sec-N|Title]] patterns and render citation buttons
    const parts = [];
    let lastIndex = 0;
    const regex = /\[\[(sec-\d+)\|([^\]]+)\]\]/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
        if (match.index > lastIndex) {
            parts.push({ type: 'text', value: content.slice(lastIndex, match.index) });
        }
        parts.push({ type: 'citation', sectionId: match[1], title: match[2] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < content.length) {
        parts.push({ type: 'text', value: content.slice(lastIndex) });
    }

    return (
        <div className="prose prose-sm max-w-none">
            {parts.map((part, i) => {
                if (part.type === 'citation') {
                    return (
                        <CitationButton
                            key={i}
                            sectionId={part.sectionId}
                            title={part.title}
                            onClick={onCitationClick}
                        />
                    );
                }
                return (
                    <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}
                        components={{
                            table: ({ children }) => (
                                <div className="overflow-x-auto my-2">
                                    <table className="min-w-full border border-gray-300 text-xs">{children}</table>
                                </div>
                            ),
                            th: ({ children }) => <th className="border border-gray-300 px-2 py-1 bg-gray-100 font-semibold">{children}</th>,
                            td: ({ children }) => <td className="border border-gray-300 px-2 py-1">{children}</td>,
                            p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
                            strong: ({ children }) => <strong className="font-bold text-[#333333]">{children}</strong>,
                            ul: ({ children }) => <ul className="list-disc pl-4 my-2 space-y-1">{children}</ul>,
                            ol: ({ children }) => <ol className="list-decimal pl-4 my-2 space-y-1">{children}</ol>,
                            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                        }}
                    >
                        {part.value}
                    </ReactMarkdown>
                );
            })}
        </div>
    );
});

// ============================================================
// Main Page Component
// ============================================================
const KCSCStandards = () => {
    const navigate = useNavigate();
    const { currentUser, logout } = useAuth();
    const inputRef = useRef(null);
    const viewerRef = useRef(null);

    // Chat state
    const [messages, setMessages] = useState([]);
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [loadingStatus, setLoadingStatus] = useState('');

    // Settings
    const [docType, setDocType] = useState('자동');
    const [topK, setTopK] = useState(18);

    // Viewer state
    const [viewerSections, setViewerSections] = useState([]);
    const [viewerTitle, setViewerTitle] = useState('');
    const [viewerCode, setViewerCode] = useState('');
    const [highlightedSection, setHighlightedSection] = useState(null);
    const [showToc, setShowToc] = useState(true);

    // Search candidates
    const [searchCandidates, setSearchCandidates] = useState([]);

    // Session management
    const [sessions, setSessions] = useState([]);
    const [currentSessionId, setCurrentSessionId] = useState(null);
    const [sidebarTab, setSidebarTab] = useState('settings'); // 'settings' | 'history'

    // Mobile panel toggle
    const [showViewer, setShowViewer] = useState(false);

    // ---- Firestore sessions ----
    const sessionsCollectionPath = currentUser
        ? `users/${currentUser.uid}/kcsc_sessions`
        : null;

    const loadSessions = useCallback(async () => {
        if (!sessionsCollectionPath) return;
        try {
            const q = query(
                collection(db, sessionsCollectionPath),
                orderBy('createdAt', 'desc'),
                limit(50)
            );
            const snapshot = await getDocs(q);
            const list = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            setSessions(list);
        } catch (err) {
            console.error('Failed to load sessions:', err);
        }
    }, [sessionsCollectionPath]);

    useEffect(() => {
        loadSessions();
    }, [loadSessions]);

    const createNewSession = useCallback(async () => {
        if (!sessionsCollectionPath) return;
        const docRef = await addDoc(collection(db, sessionsCollectionPath), {
            title: '새 대화',
            messages: [],
            createdAt: serverTimestamp(),
        });
        setCurrentSessionId(docRef.id);
        setMessages([]);
        setSearchCandidates([]);
        setViewerSections([]);
        setViewerTitle('');
        loadSessions();
    }, [sessionsCollectionPath, loadSessions]);

    const loadSession = useCallback(async (sessionId) => {
        if (!sessionsCollectionPath) return;
        try {
            const snap = await getDocs(collection(db, sessionsCollectionPath));
            const sessionDoc = snap.docs.find(d => d.id === sessionId);
            if (sessionDoc) {
                const data = sessionDoc.data();
                setCurrentSessionId(sessionId);
                setMessages(data.messages || []);
                setSearchCandidates([]);
                setViewerSections([]);
                setViewerTitle('');
            }
        } catch (err) {
            console.error('Failed to load session:', err);
        }
    }, [sessionsCollectionPath]);

    const deleteSession = useCallback(async (sessionId) => {
        if (!sessionsCollectionPath) return;
        try {
            await deleteDoc(doc(db, sessionsCollectionPath, sessionId));
            if (currentSessionId === sessionId) {
                setCurrentSessionId(null);
                setMessages([]);
            }
            loadSessions();
        } catch (err) {
            console.error('Failed to delete session:', err);
        }
    }, [sessionsCollectionPath, currentSessionId, loadSessions]);

    const saveSessionMessages = useCallback(async (sessionId, msgs, title) => {
        if (!sessionsCollectionPath || !sessionId) return;
        try {
            await updateDoc(doc(db, sessionsCollectionPath, sessionId), {
                messages: msgs.map(m => ({
                    role: m.role,
                    content: m.content,
                    ...(m.source_info ? { source_info: m.source_info } : {}),
                })),
                title: title || msgs.find(m => m.role === 'user')?.content?.slice(0, 25) + '...' || '대화',
            });
        } catch (err) {
            console.error('Failed to save session:', err);
        }
    }, [sessionsCollectionPath]);

    // ---- Citation click handler ----
    const handleCitationClick = useCallback((sectionId) => {
        setShowViewer(true);
        setHighlightedSection(sectionId);

        setTimeout(() => {
            const el = document.getElementById(sectionId);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('kcsc-highlight-flash');
                setTimeout(() => el.classList.remove('kcsc-highlight-flash'), 2500);
            }
        }, 100);
    }, []);

    // ---- Load sections into viewer ----
    const loadSectionsIntoViewer = useCallback(async (code, type, name) => {
        try {
            const res = await fetch(getKcscSectionsUrl(code, type));
            if (res.ok) {
                const data = await res.json();
                setViewerSections(data.sections || []);
                setViewerTitle(data.name || name);
                setViewerCode(`${type} ${code}`);
                setShowViewer(true);
            }
        } catch (err) {
            console.error('Failed to load sections:', err);
        }
    }, []);

    // ---- Send message ----
    const handleSend = useCallback(async () => {
        const text = inputValue.trim();
        if (!text || isLoading) return;

        let sessionId = currentSessionId;
        if (!sessionId) {
            if (!sessionsCollectionPath) return;
            const docRef = await addDoc(collection(db, sessionsCollectionPath), {
                title: text.slice(0, 25) + '...',
                messages: [],
                createdAt: serverTimestamp(),
            });
            sessionId = docRef.id;
            setCurrentSessionId(sessionId);
            loadSessions();
        }

        const userMsg = { role: 'user', content: text };
        const newMsgs = [...messages, userMsg];
        setMessages(newMsgs);
        setInputValue('');
        setIsLoading(true);
        setLoadingStatus('국가건설기준 DB와 연결 중입니다...');

        try {
            const history = messages.map(m => ({ role: m.role, content: m.content }));

            const res = await fetch(getKcscChatUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: text,
                    doc_type: docType,
                    top_k: topK,
                    history,
                    stream: false,
                }),
            });

            if (!res.ok) {
                throw new Error(`API 오류: ${res.status}`);
            }

            const data = await res.json();

            const assistantMsg = {
                role: 'assistant',
                content: data.answer,
                source_info: data.source_code
                    ? `${data.source_name} (${data.source_type} ${data.source_code})`
                    : null,
            };

            const updatedMsgs = [...newMsgs, assistantMsg];
            setMessages(updatedMsgs);
            setSearchCandidates(data.search_candidates || []);

            // Load sections into viewer if available
            if (data.sections && data.sections.length > 0) {
                setViewerSections(data.sections);
                setViewerTitle(data.source_name);
                setViewerCode(`${data.source_type} ${data.source_code}`);
            }

            // Save to Firestore
            saveSessionMessages(sessionId, updatedMsgs, text.slice(0, 25) + '...');
            loadSessions();

        } catch (err) {
            const errMsg = { role: 'assistant', content: `오류가 발생했습니다: ${err.message}` };
            setMessages(prev => [...prev, errMsg]);
        } finally {
            setIsLoading(false);
            setLoadingStatus('');
        }
    }, [inputValue, isLoading, messages, currentSessionId, docType, topK, sessionsCollectionPath, loadSessions, saveSessionMessages]);

    // Auto-scroll: scroll to latest user message so the question stays visible
    const lastUserMsgRef = useRef(null);
    useEffect(() => {
        if (lastUserMsgRef.current) {
            lastUserMsgRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, [messages, isLoading]);

    // Enter key handler
    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="h-screen flex flex-col bg-[#fcfaf7] text-gray-800">
            {/* Highlight flash animation */}
            <style>{`
                @keyframes kcscFlash {
                    0% { background-color: rgba(217, 119, 87, 0.25); }
                    50% { background-color: rgba(217, 119, 87, 0.12); }
                    100% { background-color: transparent; }
                }
                .kcsc-highlight-flash {
                    animation: kcscFlash 2.5s ease-out;
                }
                .kcsc-html-content table {
                    border-collapse: collapse;
                    width: 100%;
                    margin: 8px 0;
                    font-size: 0.8rem;
                }
                .kcsc-html-content th,
                .kcsc-html-content td {
                    border: 1px solid #e5e1d8;
                    padding: 4px 8px;
                    text-align: left;
                }
                .kcsc-html-content th {
                    background-color: #f4f1ea;
                    font-weight: 600;
                    color: #333;
                }
                .kcsc-html-content img {
                    max-width: 100%;
                    height: auto;
                    margin: 8px 0;
                    border-radius: 4px;
                }
                .kcsc-html-content p {
                    margin: 4px 0;
                    line-height: 1.6;
                }
                .kcsc-html-content ul, .kcsc-html-content ol {
                    padding-left: 1.5rem;
                    margin: 4px 0;
                }
            `}</style>

            {/* Top Bar */}
            <div className="flex items-center justify-between px-4 h-12 bg-white border-b border-[#e5e1d8]">
                <div className="flex items-center gap-3">
                    <Landmark className="w-5 h-5 text-[#d97757]" />
                    <h1 className="text-base font-bold text-gray-800">국가건설기준 AI</h1>
                </div>
                <div className="flex items-center gap-2">
                    {viewerSections.length > 0 && (
                        <button
                            onClick={() => setShowViewer(!showViewer)}
                            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${showViewer ? 'bg-[#d97757] text-white border-[#d97757]' : 'border-[#e5e1d8] text-gray-500 hover:bg-gray-100'}`}
                        >
                            <BookOpen className="w-4 h-4 inline mr-1" />
                            기준 뷰어
                        </button>
                    )}
                </div>
            </div>

            {/* Main 3-panel layout */}
            <div className="flex flex-1 overflow-hidden">
                {/* Left Sidebar */}
                <div className="w-72 flex-shrink-0 bg-[#f0f4f9] border-r border-gray-200 flex flex-col overflow-hidden">
                    {/* Sidebar tabs */}
                    <div className="flex border-b border-gray-200 bg-white">
                        <button
                            onClick={() => setSidebarTab('settings')}
                            className={`flex-1 py-2.5 text-xs font-medium transition-colors ${sidebarTab === 'settings' ? 'text-[#d97757] border-b-2 border-[#d97757]' : 'text-gray-400 hover:text-gray-600'}`}
                        >
                            설정
                        </button>
                        <button
                            onClick={() => setSidebarTab('history')}
                            className={`flex-1 py-2.5 text-xs font-medium transition-colors ${sidebarTab === 'history' ? 'text-[#d97757] border-b-2 border-[#d97757]' : 'text-gray-400 hover:text-gray-600'}`}
                        >
                            대화 기록
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-3">
                        {sidebarTab === 'settings' ? (
                            <div className="space-y-4">
                                {/* Doc type */}
                                <div>
                                    <label className="text-xs text-gray-500 mb-1 block">기준 종류</label>
                                    <select
                                        value={docType}
                                        onChange={e => setDocType(e.target.value)}
                                        className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:border-[#d97757]"
                                    >
                                        <option value="자동">자동 (KDS/KCS/KWCS 전체)</option>
                                        <option value="KDS">KDS (설계기준)</option>
                                        <option value="KCS">KCS (시공기준)</option>
                                        <option value="KWCS">KWCS (수자원기준)</option>
                                    </select>
                                </div>

                                {/* Top K */}
                                <div>
                                    <label className="text-xs text-gray-500 mb-1 block">검색 DB: {topK}</label>
                                    <input
                                        type="range"
                                        min={3}
                                        max={30}
                                        value={topK}
                                        onChange={e => setTopK(Number(e.target.value))}
                                        className="w-full accent-[#d97757]"
                                    />
                                </div>

                                {/* Search candidates */}
                                {searchCandidates.length > 0 && (
                                    <div>
                                        <h3 className="text-xs text-gray-500 mb-2 font-medium">검색 기준 리스트 ({searchCandidates.length})</h3>
                                        <div className="space-y-1 max-h-80 overflow-y-auto">
                                            {searchCandidates.map((c, i) => (
                                                <button
                                                    key={i}
                                                    onClick={() => {
                                                        const type = c.Code?.match(/^[A-Z]+/) ? c.Code.match(/^[A-Z]+/)[0] : docType === '자동' ? 'KDS' : docType;
                                                        loadSectionsIntoViewer(c.Code, type, c.Name);
                                                    }}
                                                    className="w-full text-left p-2 text-xs bg-white hover:bg-gray-50 rounded-lg transition-colors border border-gray-100"
                                                >
                                                    <span className="text-gray-700 block truncate">{c.Name}</span>
                                                    <span className="text-gray-400 text-[10px]">{c.Code}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <button
                                    onClick={createNewSession}
                                    className="w-full flex items-center gap-2 px-3 py-2 bg-[#d97757] hover:bg-[#c05535] text-white rounded-lg transition-colors text-sm"
                                >
                                    <Plus className="w-4 h-4" />
                                    새 대화
                                </button>
                                {sessions.map(s => (
                                    <div
                                        key={s.id}
                                        className={`group flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors text-xs ${currentSessionId === s.id ? 'bg-white text-gray-800 shadow-sm' : 'hover:bg-white/60 text-gray-500'}`}
                                    >
                                        <button
                                            onClick={() => loadSession(s.id)}
                                            className="flex-1 text-left truncate"
                                        >
                                            <MessageSquare className="w-3 h-3 inline mr-1" />
                                            {s.title || '대화'}
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                                            className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition-all"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* User Profile Footer */}
                    <div className="p-3 border-t border-[#e5e1d8] bg-[#f4f1ea]">
                        <div className="flex items-center justify-between gap-2">
                            <Link to="/profile" className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer hover:bg-[#e5e1d8] p-1.5 -ml-1.5 rounded-lg transition-colors group">
                                <div className="w-8 h-8 rounded-full bg-[#d97757] flex items-center justify-center text-white font-bold shrink-0 group-hover:scale-105 transition-transform">
                                    {(currentUser?.displayName || currentUser?.email || 'U')[0].toUpperCase()}
                                </div>
                                <div className="flex flex-col min-w-0">
                                    <span className="text-sm font-medium text-[#333333] truncate">{currentUser?.displayName || currentUser?.email?.split('@')[0] || 'User'}</span>
                                    <span className="text-[10px] text-[#666666] truncate">{currentUser?.email}</span>
                                </div>
                            </Link>
                            <button
                                onClick={async () => { try { await logout(); navigate('/login'); } catch {} }}
                                className="p-2 hover:bg-[#ffe0d6] text-[#555555] hover:text-[#c05535] rounded-md transition-colors"
                                title="로그아웃"
                            >
                                <LogOut size={18} />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Center: Chat Panel */}
                <div className="flex-1 flex flex-col min-w-0 bg-[#f9f8f6]">
                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto p-4">
                        <div className="max-w-3xl mx-auto space-y-4">
                        {messages.length === 0 && !isLoading && (
                            <div className="flex flex-col items-center justify-center h-full text-center pt-24">
                                <Landmark className="w-16 h-16 text-[#d97757]/30 mb-4" />
                                <h2 className="text-2xl font-bold text-gray-400 mb-2">국가건설기준 AI</h2>
                                <p className="text-gray-400 max-w-md">
                                    국가건설기준(KDS/KCS)에 대해 질문하세요.<br />
                                    관련 기준을 검색하고 AI가 답변합니다.
                                </p>
                                <div className="mt-6 flex flex-wrap gap-2 justify-center">
                                    {['내진설계 시 중요도계수 적용 기준', '철골 구조물 볼트 접합 설계기준', '콘크리트 균열 폭 허용 기준'].map(q => (
                                        <button
                                            key={q}
                                            onClick={() => setInputValue(q)}
                                            className="px-3 py-1.5 text-xs bg-white border border-[#e5e1d8] rounded-full text-gray-500 hover:text-[#d97757] hover:border-[#d97757]/50 transition-colors shadow-sm"
                                        >
                                            {q}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {messages.map((msg, i) => {
                            // Attach ref to the last user message
                            const isLastUser = msg.role === 'user' && !messages.slice(i + 1).some(m => m.role === 'user');
                            return (
                            <div key={i} ref={isLastUser ? lastUserMsgRef : null} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                                {msg.role === 'assistant' ? (
                                    <div className="w-8 h-8 rounded-full bg-[#d97757] flex items-center justify-center flex-shrink-0">
                                        <Bot className="w-5 h-5 text-white" />
                                    </div>
                                ) : (
                                    <div className="w-8 h-8 rounded-full bg-[#333333] flex items-center justify-center flex-shrink-0">
                                        <User className="w-5 h-5 text-white" />
                                    </div>
                                )}
                                <div className={`max-w-[85%] rounded-2xl p-3 ${msg.role === 'user'
                                        ? 'bg-[#333333] text-white rounded-tr-none'
                                        : 'bg-white border border-[#e5e1d8] text-[#333333] rounded-tl-none shadow-sm'
                                    }`}>
                                    {msg.role === 'user' ? (
                                        <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                                    ) : (
                                        <ChatMessageContent
                                            content={msg.content}
                                            onCitationClick={handleCitationClick}
                                        />
                                    )}
                                    {msg.source_info && (
                                        <div className={`mt-2 pt-2 border-t text-[10px] ${msg.role === 'user' ? 'border-white/20 text-white/60' : 'border-[#e5e1d8] text-gray-400'}`}>
                                            출처: {msg.source_info}
                                        </div>
                                    )}
                                </div>
                            </div>
                            );
                        })}

                        {isLoading && (
                            <div className="flex gap-3">
                                <div className="w-8 h-8 rounded-full bg-[#d97757] flex items-center justify-center flex-shrink-0">
                                    <Bot className="w-5 h-5 text-white" />
                                </div>
                                <div className="bg-white border border-[#e5e1d8] rounded-2xl rounded-tl-none px-4 py-3 shadow-sm">
                                    <div className="flex items-center gap-2 text-sm text-gray-500">
                                        <Loader2 className="w-4 h-4 animate-spin text-[#d97757]" />
                                        {loadingStatus || '분석 중...'}
                                    </div>
                                </div>
                            </div>
                        )}

                        <div />
                        </div>
                    </div>

                    {/* Input */}
                    <div className="p-4 border-t border-[#e5e1d8] bg-white">
                        <div className="max-w-3xl mx-auto relative">
                            <textarea
                                ref={inputRef}
                                value={inputValue}
                                onChange={e => setInputValue(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="건설기준에 대해 질문하세요..."
                                rows={1}
                                className="w-full bg-[#f4f1ea] border border-[#e5e1d8] rounded-xl py-3 pl-4 pr-12 text-sm resize-none focus:outline-none focus:border-[#d97757] focus:ring-1 focus:ring-[#d97757] placeholder-[#a0a0a0] h-[50px] max-h-[120px]"
                            />
                            <button
                                onClick={handleSend}
                                disabled={!inputValue.trim() || isLoading}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-[#d97757] hover:bg-[#c05535] disabled:opacity-50 rounded-lg transition-colors text-white"
                            >
                                <Send className="w-5 h-5" />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Right: HTML Section Viewer */}
                {showViewer && viewerSections.length > 0 && (
                    <div className="w-[500px] flex-shrink-0 bg-white border-l border-[#e5e1d8] flex flex-col overflow-hidden">
                        {/* Viewer header */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-[#e5e1d8] bg-white">
                            <div className="min-w-0">
                                <h3 className="text-sm font-bold text-gray-800 truncate">{viewerTitle}</h3>
                                <span className="text-[10px] text-gray-400">{viewerCode}</span>
                            </div>
                            <button onClick={() => setShowViewer(false)} className="p-1 hover:bg-gray-100 rounded transition-colors">
                                <X className="w-4 h-4 text-gray-400" />
                            </button>
                        </div>

                        {/* TOC Toggle */}
                        <button
                            onClick={() => setShowToc(!showToc)}
                            className="flex items-center gap-2 px-4 py-2 text-xs text-gray-500 hover:text-gray-700 border-b border-[#e5e1d8]/50 transition-colors"
                        >
                            <List className="w-3 h-3" />
                            목차
                            {showToc ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
                        </button>

                        {/* TOC */}
                        {showToc && (
                            <div className="max-h-48 overflow-y-auto border-b border-[#e5e1d8]/50 px-3 py-2 bg-[#f9f8f6]">
                                {viewerSections.filter(s => s.Title).map((sec) => (
                                    <button
                                        key={sec.section_id}
                                        onClick={() => handleCitationClick(sec.section_id)}
                                        className="w-full text-left py-1 px-2 text-[11px] text-gray-500 hover:text-[#d97757] hover:bg-white rounded transition-colors truncate"
                                    >
                                        {sec.Title}
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Section content */}
                        <div ref={viewerRef} className="flex-1 overflow-y-auto p-4 space-y-6">
                            {viewerSections.map((sec) => (
                                <div
                                    key={sec.section_id}
                                    id={sec.section_id}
                                    className="rounded-lg border border-[#e5e1d8] p-4 transition-colors bg-white"
                                >
                                    {sec.Title && (
                                        <h4 className="text-sm font-bold text-[#d97757] mb-3 pb-2 border-b border-[#e5e1d8]">
                                            {sec.Title}
                                        </h4>
                                    )}
                                    <div
                                        className="kcsc-html-content text-xs text-gray-600 leading-relaxed"
                                        dangerouslySetInnerHTML={{ __html: sec.Contents }}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default KCSCStandards;
