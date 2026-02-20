import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    ArrowLeft, Send, Bot, User, Loader2, Search as SearchIcon,
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
        className="inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 text-xs font-medium bg-rose-500/20 text-rose-300 border border-rose-500/30 rounded-md hover:bg-rose-500/30 transition-colors cursor-pointer"
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
        <div className="prose prose-invert prose-sm max-w-none">
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
                                    <table className="min-w-full border border-slate-600 text-xs">{children}</table>
                                </div>
                            ),
                            th: ({ children }) => <th className="border border-slate-600 px-2 py-1 bg-slate-700">{children}</th>,
                            td: ({ children }) => <td className="border border-slate-600 px-2 py-1">{children}</td>,
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
    const chatEndRef = useRef(null);
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
        setLoadingStatus('키워드 추출 중...');

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

    // Auto-scroll chat
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isLoading]);

    // Enter key handler
    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="h-screen flex flex-col bg-slate-900 text-slate-100">
            {/* Highlight flash animation */}
            <style>{`
                @keyframes kcscFlash {
                    0% { background-color: rgba(234, 179, 8, 0.3); }
                    50% { background-color: rgba(234, 179, 8, 0.15); }
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
                    border: 1px solid #475569;
                    padding: 4px 8px;
                    text-align: left;
                }
                .kcsc-html-content th {
                    background-color: #334155;
                    font-weight: 600;
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
            <div className="flex items-center justify-between px-4 py-3 bg-slate-800/80 border-b border-slate-700/50 backdrop-blur-sm">
                <div className="flex items-center gap-3">
                    <button onClick={() => navigate('/')} className="p-2 hover:bg-slate-700 rounded-lg transition-colors">
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    <Landmark className="w-6 h-6 text-rose-400" />
                    <h1 className="text-lg font-bold">건설기준 AI</h1>
                    <span className="text-xs text-slate-400 hidden sm:inline">KDS/KCS/KWCS</span>
                </div>
                <div className="flex items-center gap-2">
                    {viewerSections.length > 0 && (
                        <button
                            onClick={() => setShowViewer(!showViewer)}
                            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${showViewer ? 'bg-rose-500/20 border-rose-500/50 text-rose-300' : 'border-slate-600 text-slate-400 hover:text-slate-200'}`}
                        >
                            <BookOpen className="w-4 h-4 inline mr-1" />
                            기준 뷰어
                        </button>
                    )}
                    <button onClick={logout} className="p-2 hover:bg-slate-700 rounded-lg transition-colors" title="로그아웃">
                        <LogOut className="w-4 h-4 text-slate-400" />
                    </button>
                </div>
            </div>

            {/* Main 3-panel layout */}
            <div className="flex flex-1 overflow-hidden">
                {/* Left Sidebar */}
                <div className="w-72 flex-shrink-0 bg-slate-800/50 border-r border-slate-700/50 flex flex-col overflow-hidden">
                    {/* Sidebar tabs */}
                    <div className="flex border-b border-slate-700/50">
                        <button
                            onClick={() => setSidebarTab('settings')}
                            className={`flex-1 py-2.5 text-xs font-medium transition-colors ${sidebarTab === 'settings' ? 'text-rose-400 border-b-2 border-rose-400' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            설정
                        </button>
                        <button
                            onClick={() => setSidebarTab('history')}
                            className={`flex-1 py-2.5 text-xs font-medium transition-colors ${sidebarTab === 'history' ? 'text-rose-400 border-b-2 border-rose-400' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            대화 기록
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-3">
                        {sidebarTab === 'settings' ? (
                            <div className="space-y-4">
                                {/* Doc type */}
                                <div>
                                    <label className="text-xs text-slate-400 mb-1 block">기준 종류</label>
                                    <select
                                        value={docType}
                                        onChange={e => setDocType(e.target.value)}
                                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-rose-500"
                                    >
                                        <option value="자동">자동 (KDS/KCS/KWCS 전체)</option>
                                        <option value="KDS">KDS (설계기준)</option>
                                        <option value="KCS">KCS (시공기준)</option>
                                        <option value="KWCS">KWCS (수자원기준)</option>
                                    </select>
                                </div>

                                {/* Top K */}
                                <div>
                                    <label className="text-xs text-slate-400 mb-1 block">검색 후보 개수: {topK}</label>
                                    <input
                                        type="range"
                                        min={3}
                                        max={30}
                                        value={topK}
                                        onChange={e => setTopK(Number(e.target.value))}
                                        className="w-full accent-rose-500"
                                    />
                                </div>

                                {/* Search candidates */}
                                {searchCandidates.length > 0 && (
                                    <div>
                                        <h3 className="text-xs text-slate-400 mb-2 font-medium">검색 후보 ({searchCandidates.length})</h3>
                                        <div className="space-y-1 max-h-80 overflow-y-auto">
                                            {searchCandidates.map((c, i) => (
                                                <button
                                                    key={i}
                                                    onClick={() => {
                                                        const type = c.Code?.match(/^[A-Z]+/) ? c.Code.match(/^[A-Z]+/)[0] : docType === '자동' ? 'KDS' : docType;
                                                        loadSectionsIntoViewer(c.Code, type, c.Name);
                                                    }}
                                                    className="w-full text-left p-2 text-xs bg-slate-700/50 hover:bg-slate-700 rounded-lg transition-colors"
                                                >
                                                    <span className="text-slate-200 block truncate">{c.Name}</span>
                                                    <span className="text-slate-500 text-[10px]">{c.Code}</span>
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
                                    className="w-full flex items-center gap-2 px-3 py-2 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 rounded-lg transition-colors text-sm"
                                >
                                    <Plus className="w-4 h-4" />
                                    새 대화
                                </button>
                                {sessions.map(s => (
                                    <div
                                        key={s.id}
                                        className={`group flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors text-xs ${currentSessionId === s.id ? 'bg-slate-700 text-slate-100' : 'hover:bg-slate-700/50 text-slate-400'}`}
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
                                            className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-all"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Center: Chat Panel */}
                <div className="flex-1 flex flex-col min-w-0">
                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                        {messages.length === 0 && !isLoading && (
                            <div className="flex flex-col items-center justify-center h-full text-center">
                                <Landmark className="w-16 h-16 text-rose-400/30 mb-4" />
                                <h2 className="text-2xl font-bold text-slate-300 mb-2">건설기준 AI</h2>
                                <p className="text-slate-500 max-w-md">
                                    국가건설기준(KDS/KCS)에 대해 질문하세요.<br />
                                    관련 기준을 검색하고 AI가 답변합니다.
                                </p>
                                <div className="mt-6 flex flex-wrap gap-2 justify-center">
                                    {['피복두께 기준은?', '철근콘크리트 내구성 설계', '콘크리트 양생 온도'].map(q => (
                                        <button
                                            key={q}
                                            onClick={() => setInputValue(q)}
                                            className="px-3 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded-full text-slate-400 hover:text-rose-300 hover:border-rose-500/50 transition-colors"
                                        >
                                            {q}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {messages.map((msg, i) => (
                            <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                {msg.role === 'assistant' && (
                                    <div className="w-8 h-8 rounded-lg bg-rose-500/20 flex items-center justify-center flex-shrink-0">
                                        <Bot className="w-5 h-5 text-rose-400" />
                                    </div>
                                )}
                                <div className={`max-w-[75%] rounded-2xl px-4 py-3 ${msg.role === 'user'
                                        ? 'bg-rose-500/20 border border-rose-500/30 text-slate-100'
                                        : 'bg-slate-800 border border-slate-700/50 text-slate-200'
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
                                        <div className="mt-2 pt-2 border-t border-slate-700/50 text-[10px] text-slate-500">
                                            출처: {msg.source_info}
                                        </div>
                                    )}
                                </div>
                                {msg.role === 'user' && (
                                    <div className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center flex-shrink-0">
                                        <User className="w-5 h-5 text-slate-400" />
                                    </div>
                                )}
                            </div>
                        ))}

                        {isLoading && (
                            <div className="flex gap-3">
                                <div className="w-8 h-8 rounded-lg bg-rose-500/20 flex items-center justify-center flex-shrink-0">
                                    <Bot className="w-5 h-5 text-rose-400" />
                                </div>
                                <div className="bg-slate-800 border border-slate-700/50 rounded-2xl px-4 py-3">
                                    <div className="flex items-center gap-2 text-sm text-slate-400">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        {loadingStatus || '분석 중...'}
                                    </div>
                                </div>
                            </div>
                        )}

                        <div ref={chatEndRef} />
                    </div>

                    {/* Input */}
                    <div className="p-4 border-t border-slate-700/50 bg-slate-800/30">
                        <div className="max-w-3xl mx-auto flex gap-2">
                            <textarea
                                ref={inputRef}
                                value={inputValue}
                                onChange={e => setInputValue(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="건설기준에 대해 질문하세요..."
                                rows={1}
                                className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:border-rose-500 placeholder-slate-500"
                            />
                            <button
                                onClick={handleSend}
                                disabled={!inputValue.trim() || isLoading}
                                className="px-4 py-3 bg-rose-500 hover:bg-rose-600 disabled:bg-slate-700 disabled:text-slate-500 rounded-xl transition-colors"
                            >
                                <Send className="w-5 h-5" />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Right: HTML Section Viewer */}
                {showViewer && viewerSections.length > 0 && (
                    <div className="w-[500px] flex-shrink-0 bg-slate-800/50 border-l border-slate-700/50 flex flex-col overflow-hidden">
                        {/* Viewer header */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/50 bg-slate-800/80">
                            <div className="min-w-0">
                                <h3 className="text-sm font-bold text-slate-200 truncate">{viewerTitle}</h3>
                                <span className="text-[10px] text-slate-500">{viewerCode}</span>
                            </div>
                            <button onClick={() => setShowViewer(false)} className="p-1 hover:bg-slate-700 rounded transition-colors">
                                <X className="w-4 h-4 text-slate-400" />
                            </button>
                        </div>

                        {/* TOC Toggle */}
                        <button
                            onClick={() => setShowToc(!showToc)}
                            className="flex items-center gap-2 px-4 py-2 text-xs text-slate-400 hover:text-slate-200 border-b border-slate-700/30 transition-colors"
                        >
                            <List className="w-3 h-3" />
                            목차
                            {showToc ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
                        </button>

                        {/* TOC */}
                        {showToc && (
                            <div className="max-h-48 overflow-y-auto border-b border-slate-700/30 px-3 py-2 bg-slate-900/30">
                                {viewerSections.filter(s => s.Title).map((sec) => (
                                    <button
                                        key={sec.section_id}
                                        onClick={() => handleCitationClick(sec.section_id)}
                                        className="w-full text-left py-1 px-2 text-[11px] text-slate-400 hover:text-rose-300 hover:bg-slate-800/50 rounded transition-colors truncate"
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
                                    className="rounded-lg border border-slate-700/30 p-4 transition-colors"
                                >
                                    {sec.Title && (
                                        <h4 className="text-sm font-bold text-rose-300 mb-3 pb-2 border-b border-slate-700/30">
                                            {sec.Title}
                                        </h4>
                                    )}
                                    <div
                                        className="kcsc-html-content text-xs text-slate-300 leading-relaxed"
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
