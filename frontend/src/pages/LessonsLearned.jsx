import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    ArrowLeft, Search as SearchIcon, Send, Bot, User, Loader2,
    ChevronRight, ChevronDown, ChevronLeft, X, Upload, Trash2,
    BookOpen, MessageSquare, FileText, FolderTree, RefreshCcw, Check, ExternalLink, LogOut
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../contexts/AuthContext';
import { auth } from '../firebase';

// Config
const API_BASE = (import.meta.env.VITE_API_URL || 'https://drawing-detector-backend-435353955407.us-central1.run.app').replace(/\/$/, '');

const getLessonsApiUrl = (path) => {
    const base = API_BASE.endsWith('/api') ? `${API_BASE}/v1/lessons` : `${API_BASE}/api/v1/lessons`;
    return `${base}/${path}`;
};

// ── sessionStorage helpers ──
const SS_KEY = 'lessons-learned-state';
const _loadSS = () => { try { return JSON.parse(sessionStorage.getItem(SS_KEY)) || {}; } catch { return {}; } };

const LessonsLearned = () => {
    const navigate = useNavigate();
    const { currentUser, logout } = useAuth();
    const username = currentUser?.displayName || currentUser?.email?.split('@')[0];
    const isAdmin = currentUser?.email === 'admin@poscoenc.com';

    // Restore saved state once
    const saved = useRef(_loadSS()).current;
    const defaultChat = [{ role: 'assistant', content: '안녕하세요! Lessons Learned에 대해 궁금한 점을 물어보세요.' }];

    // === Left Sidebar State ===
    const [categoryTree, setCategoryTree] = useState([]);
    const [totalDocs, setTotalDocs] = useState(0);
    const [expandedGroups, setExpandedGroups] = useState(() => new Set(saved.expandedGroups || []));
    const [selectedCategory, setSelectedCategory] = useState(saved.selectedCategory || null);
    const [categoryDocs, setCategoryDocs] = useState([]);
    const [loadingDocs, setLoadingDocs] = useState(false);
    const [selectedDoc, setSelectedDoc] = useState(saved.selectedDoc || null);

    // === Upload State ===
    const [uploadedFiles, setUploadedFiles] = useState([]);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState('');
    const fileInputRef = useRef(null);

    // === Center State ===
    const [mode, setMode] = useState(saved.mode || 'search');
    const [query, setQuery] = useState(saved.query || '');
    const [searchResults, setSearchResults] = useState(saved.searchResults || []);
    const [isSearching, setIsSearching] = useState(false);
    const [hasSearched, setHasSearched] = useState(saved.hasSearched || false);
    const [searchError, setSearchError] = useState(null);
    const [chatMessages, setChatMessages] = useState(
        saved.chatMessages && saved.chatMessages.length > 0 ? saved.chatMessages : defaultChat
    );
    const [isChatLoading, setIsChatLoading] = useState(false);

    // === Search Scope State ===
    const [selectedSourceFile, setSelectedSourceFile] = useState(saved.selectedSourceFile || null);

    // === Project Modal State ===
    const [showProjectModal, setShowProjectModal] = useState(false);
    const [allProjects, setAllProjects] = useState([]);
    const [loadingAllProjects, setLoadingAllProjects] = useState(false);

    // === Right Panel State ===
    const [previewDoc, setPreviewDoc] = useState(saved.previewDoc || null);
    const [viewerPage, setViewerPage] = useState(saved.viewerPage || 0);

    // === Layout State ===
    const [leftWidth, setLeftWidth] = useState(saved.leftWidth || 300);
    const leftResizingRef = useRef(false);
    const [rightWidth, setRightWidth] = useState(saved.rightWidth || 384);
    const rightResizingRef = useRef(false);

    // === Refs ===
    const messagesEndRef = useRef(null);

    // ── Persist state to sessionStorage on change ──
    useEffect(() => {
        const state = {
            mode, query, searchResults, hasSearched, chatMessages,
            selectedCategory, selectedSourceFile, selectedDoc,
            previewDoc, viewerPage,
            expandedGroups: [...expandedGroups],
            leftWidth, rightWidth,
        };
        try { sessionStorage.setItem(SS_KEY, JSON.stringify(state)); } catch {}
    }, [mode, query, searchResults, hasSearched, chatMessages,
        selectedCategory, selectedSourceFile, selectedDoc,
        previewDoc, viewerPage, expandedGroups, leftWidth, rightWidth]);

    // =============================================
    // UTILITY: Parse content into pages by ..PAGE:N markers
    // =============================================
    const parseContentPages = useCallback((content) => {
        if (!content) return [{ pageNum: 1, text: '' }];

        const regex = /\.\.PAGE:(\d+)/g;
        const markers = [];
        let match;
        while ((match = regex.exec(content)) !== null) {
            markers.push({ pageNum: parseInt(match[1], 10), end: match.index + match[0].length, start: match.index });
        }
        if (markers.length === 0) return [{ pageNum: 1, text: content }];

        const pages = [];
        // Text before the first marker → page 1
        const before = content.substring(0, markers[0].start).trim();
        if (before.length > 0) pages.push({ pageNum: 1, text: before });

        for (let i = 0; i < markers.length; i++) {
            const textStart = markers[i].end;
            const textEnd = i + 1 < markers.length ? markers[i + 1].start : content.length;
            const text = content.substring(textStart, textEnd).trim();
            if (text.length > 0) pages.push({ pageNum: markers[i].pageNum, text });
        }
        return pages.length > 0 ? pages : [{ pageNum: 1, text: content }];
    }, []);

    // =============================================
    // UTILITY: Highlight keywords in text (for document viewer)
    // =============================================
    const highlightTextInViewer = useCallback((text, keywords) => {
        if (!text || !keywords || keywords.length === 0) return text;
        const escaped = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
        return text.replace(pattern, '<mark>$1</mark>');
    }, []);

    // =============================================
    // UTILITY: Format content for document viewer HTML
    // Preserves line breaks, handles SHEET markers, bullets, and basic structure
    // =============================================
    const formatContentForViewer = useCallback((text) => {
        if (!text) return '<p class="text-gray-400 italic">내용 없음</p>';

        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const lines = text.split('\n');
        let html = '';
        let bulletBuf = [];
        let codeBuf = [];
        let numListBuf = [];
        let tableBuf = [];

        // SQL/code detection
        const sqlStartRe = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|DECLARE|EXEC|SET\s|BEGIN|USE\s|GRANT|REVOKE|MERGE|TRUNCATE|GO\b|IF\s|PRINT\s|RETURN\b)\b/i;
        const sqlContRe = /^\s*(FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|GROUP\s+BY|ORDER\s+BY|HAVING|UNION|AND|OR|ON|AS|INTO|VALUES|SET|WHEN|THEN|ELSE|END|CASE|LIMIT|OFFSET|TOP|DISTINCT|BETWEEN|LIKE|IN\s*\(|NOT|EXISTS|NULL|IS\s|OVER\s*\(|PARTITION|FETCH|PIVOT)\b/i;
        const isSqlStart = (line) => sqlStartRe.test(line);
        const isSqlContinue = (line) => {
            const t = line.trim();
            return sqlContRe.test(t) || /^\s{2,}\S/.test(line) || /[,;(]$/.test(t) || /^\)/.test(t) || /^--/.test(t) || t === '';
        };

        // Table detection: 3+ tab-separated columns or 3+ pipe-separated columns
        const isTableLine = (line) => {
            const t = line.trim();
            return (t.split('\t').length >= 3) || (/\|/.test(t) && t.split('|').filter(c => c.trim()).length >= 2);
        };

        const flushBullets = () => {
            if (!bulletBuf.length) return;
            html += '<ul class="rpt-list">' + bulletBuf.map(b => `<li>${esc(b)}</li>`).join('') + '</ul>';
            bulletBuf = [];
        };
        const flushCode = () => {
            if (!codeBuf.length) return;
            // Remove trailing blank lines
            while (codeBuf.length && !codeBuf[codeBuf.length - 1].trim()) codeBuf.pop();
            html += `<pre class="rpt-code"><code>${codeBuf.map(l => esc(l)).join('\n')}</code></pre>`;
            codeBuf = [];
        };
        const flushNumList = () => {
            if (!numListBuf.length) return;
            html += '<ol class="rpt-numlist">' + numListBuf.map(item => `<li>${esc(item)}</li>`).join('') + '</ol>';
            numListBuf = [];
        };
        const flushTable = () => {
            if (!tableBuf.length) return;
            const delim = tableBuf[0].includes('\t') ? '\t' : '|';
            const rows = tableBuf.map(line => {
                let cells = line.split(delim).map(c => c.trim());
                if (delim === '|') cells = cells.filter(c => c !== ''); // strip empty edge cells from |col|col|
                return cells;
            });
            html += '<div class="rpt-table-wrap"><table class="rpt-table">';
            rows.forEach((row, i) => {
                const tag = i === 0 ? 'th' : 'td';
                html += '<tr>' + row.map(cell => `<${tag}>${esc(cell)}</${tag}>`).join('') + '</tr>';
            });
            html += '</table></div>';
            tableBuf = [];
        };
        const flushAll = () => { flushBullets(); flushCode(); flushNumList(); flushTable(); };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const t = line.trim();

            // Empty line → spacer (but keep blank lines inside code blocks)
            if (!t) {
                if (codeBuf.length > 0) { codeBuf.push(''); continue; }
                flushAll();
                html += '<div class="h-2"></div>';
                continue;
            }

            // ..SHEET:N marker → section header
            const sheetMatch = t.match(/^\.\.SHEET:(\d+)/);
            if (sheetMatch) {
                flushAll();
                html += `<div class="rpt-sheet">SHEET ${esc(sheetMatch[1])}</div>`;
                continue;
            }

            // SQL/Code block detection
            if (isSqlStart(t)) {
                flushBullets(); flushNumList(); flushTable();
                codeBuf.push(line);
                continue;
            }
            if (codeBuf.length > 0 && isSqlContinue(line)) {
                codeBuf.push(line);
                continue;
            }
            flushCode();

            // Table detection
            if (isTableLine(t)) {
                flushBullets(); flushNumList();
                tableBuf.push(t);
                continue;
            }
            flushTable();

            // Bullet line
            if (/^[-·•●]\s/.test(t)) {
                flushNumList();
                bulletBuf.push(t.replace(/^[-·•●]\s*/, ''));
                continue;
            }
            flushBullets();

            // Numbered list: 1. / 1) / (1)
            const numMatch = t.match(/^(?:(\d+)[.)]\s+|\((\d+)\)\s+)(.+)/);
            if (numMatch) {
                numListBuf.push(numMatch[3]);
                continue;
            }
            flushNumList();

            // Section-like header (Korean NCR sections + generic)
            if (/^(PART\s*[IⅠⅡⅢⅣⅤVvi]+|부적합\s?내용|조치\s?내용|조치\s?결과|재발\s?방지|시정\s?조치|원인\s?분석|첨부\s?파일|NCR\s*(REPORT|내용)|개요|목적|범위|적용\s?범위|참고\s?사항|비고|결론|요약|배경|절차|방법|내용|결과|조건|기준|특이\s?사항)/i.test(t)) {
                html += `<div class="rpt-section">${esc(t)}</div>`;
                continue;
            }

            // Generic section header: short line ending with :/：
            if ((t.endsWith(':') || t.endsWith('：')) && t.length <= 50 && !/^(https?|ftp):/.test(t)) {
                html += `<div class="rpt-section">${esc(t)}</div>`;
                continue;
            }

            // All-caps English header (4+ chars, no lowercase)
            if (/^[A-Z][A-Z\s_\-/]{3,}$/.test(t) && t.length <= 60) {
                html += `<div class="rpt-section">${esc(t)}</div>`;
                continue;
            }

            // Key: Value pattern (generic — key up to 30 chars, not a URL)
            const kvMatch = t.match(/^([^\s:：]{1,30})\s*[:：]\s+(.+)/);
            if (kvMatch && !/^(https?|ftp)/i.test(kvMatch[1])) {
                html += `<div class="rpt-kv"><span class="rpt-key">${esc(kvMatch[1])}</span><span class="rpt-val">${esc(kvMatch[2])}</span></div>`;
                continue;
            }

            // Regular line — preserve as-is
            html += `<div style="line-height:1.7;font-size:12.5px;color:#374151;">${esc(t)}</div>`;
        }
        flushAll();
        return html;
    }, []);

    // =============================================
    // UTILITY: Score badge color
    // =============================================
    const getScoreBadge = useCallback((score) => {
        if (score >= 10) return { bg: 'bg-green-100', text: 'text-green-700', label: '높음' };
        if (score >= 3) return { bg: 'bg-blue-100', text: 'text-blue-700', label: '보통' };
        return { bg: 'bg-gray-100', text: 'text-gray-500', label: '낮음' };
    }, []);

    // =============================================
    // AUTH HELPER
    // =============================================
    const getIdToken = async () => {
        const user = auth.currentUser;
        if (!user) throw new Error('로그인이 필요합니다.');
        return await user.getIdToken();
    };

    // =============================================
    // LOAD CATEGORIES ON MOUNT
    // =============================================
    useEffect(() => {
        loadCategories();
        loadUploadedFiles();
        // Restore category docs if a category was selected before refresh
        if (saved.selectedCategory) {
            (async () => {
                try {
                    const token = await getIdToken();
                    const res = await fetch(getLessonsApiUrl(`documents?category=${encodeURIComponent(saved.selectedCategory)}`), {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    if (res.ok) {
                        const data = await res.json();
                        setCategoryDocs(data.documents || []);
                    }
                } catch {}
            })();
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const loadCategories = async () => {
        try {
            const token = await getIdToken();
            const res = await fetch(getLessonsApiUrl('categories'), {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error('Failed to load categories');
            const data = await res.json();
            setCategoryTree(data.tree || []);
            setTotalDocs(data.total || 0);
        } catch (e) {
            console.error('Failed to load categories:', e);
        }
    };

    const loadUploadedFiles = async () => {
        try {
            const token = await getIdToken();
            const res = await fetch(getLessonsApiUrl('files'), {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error('Failed to load files');
            const data = await res.json();
            setUploadedFiles(data.files || []);
        } catch (e) {
            console.error('Failed to load uploaded files:', e);
        }
    };

    // =============================================
    // OPEN PROJECT MODAL — load all registered projects
    // =============================================
    const handleOpenProjectModal = async () => {
        setShowProjectModal(true);
        setLoadingAllProjects(true);
        try {
            const token = await getIdToken();
            const res = await fetch(getLessonsApiUrl('files?all=true'), {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error('Failed to load all projects');
            const data = await res.json();
            setAllProjects(data.files || []);
        } catch (e) {
            console.error('Failed to load all projects:', e);
            setAllProjects([]);
        } finally {
            setLoadingAllProjects(false);
        }
    };

    const handleSelectProject = (project) => {
        setSelectedSourceFile(project.filename);
        setSelectedCategory(null);
        setCategoryDocs([]);
        setShowProjectModal(false);
        // Add to uploadedFiles if not already present (for sidebar display)
        setUploadedFiles(prev => {
            if (prev.some(f => f.filename === project.filename)) return prev;
            return [...prev, project];
        });
    };

    // =============================================
    // LOAD DOCUMENTS BY CATEGORY
    // =============================================
    const handleCategoryClick = async (categoryName) => {
        if (selectedCategory === categoryName) {
            setSelectedCategory(null);
            setCategoryDocs([]);
            return;
        }
        setSelectedCategory(categoryName);
        setSelectedSourceFile(null);
        setLoadingDocs(true);
        try {
            const token = await getIdToken();
            const res = await fetch(getLessonsApiUrl(`documents?category=${encodeURIComponent(categoryName)}`), {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error('Failed to load documents');
            const data = await res.json();
            setCategoryDocs(data.documents || []);
        } catch (e) {
            console.error('Failed to load documents:', e);
            setCategoryDocs([]);
        } finally {
            setLoadingDocs(false);
        }
    };

    // =============================================
    // FILE UPLOAD
    // =============================================
    const handleFileUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const ext = file.name.toLowerCase();
        if (!ext.endsWith('.txt') && !ext.endsWith('.json')) {
            alert('TXT 또는 JSON 파일만 업로드 가능합니다.');
            return;
        }

        setIsUploading(true);
        setUploadProgress('파일 업로드 중...');

        try {
            const token = await getIdToken();
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch(getLessonsApiUrl('upload'), {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Upload failed');
            }

            const data = await res.json();
            setUploadProgress(`완료! ${data.documents_indexed}개 문서 인덱싱됨`);

            // Refresh categories and files
            await loadCategories();
            await loadUploadedFiles();

            setTimeout(() => setUploadProgress(''), 3000);
        } catch (e) {
            console.error('Upload failed:', e);
            setUploadProgress(`업로드 실패: ${e.message}`);
            setTimeout(() => setUploadProgress(''), 5000);
        } finally {
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    // =============================================
    // DELETE FILE
    // =============================================
    const handleDeleteFile = async (filename) => {
        if (!confirm(`"${filename}" 파일의 모든 인덱스 데이터를 삭제하시겠습니까?`)) return;

        try {
            const token = await getIdToken();
            const res = await fetch(getLessonsApiUrl(`files?filename=${encodeURIComponent(filename)}`), {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error('Delete failed');

            await loadCategories();
            await loadUploadedFiles();
        } catch (e) {
            console.error('Delete failed:', e);
            alert(`삭제 실패: ${e.message}`);
        }
    };

    // =============================================
    // SEARCH HANDLER
    // =============================================
    const handleSearch = async () => {
        if (!query.trim() || isSearching) return;
        setIsSearching(true);
        setSearchResults([]);
        setSearchError(null);
        setHasSearched(true);

        try {
            const token = await getIdToken();
            const res = await fetch(getLessonsApiUrl('search'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=UTF-8',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    query: query.trim(),
                    category: selectedCategory,
                    source_file: selectedSourceFile,
                    mode: 'search',
                    top: 20
                })
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                setSearchError(`검색 실패 (${res.status}): ${errText.substring(0, 100)}`);
                return;
            }

            const data = await res.json();
            setSearchResults(data.results || []);
        } catch (e) {
            console.error('Search error:', e);
            setSearchError(`검색 중 오류: ${e.message}`);
        } finally {
            setIsSearching(false);
        }
    };

    // =============================================
    // CHAT HANDLER
    // =============================================
    const handleChat = async () => {
        if (!query.trim() || isChatLoading) return;
        const userMessage = query.trim();
        setQuery('');
        setChatMessages(prev => [...prev, { role: 'user', content: userMessage }]);
        setIsChatLoading(true);

        try {
            const token = await getIdToken();
            const history = chatMessages
                .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.isError))
                .slice(-20)
                .map(m => ({ role: m.role, content: m.content }));

            const res = await fetch(getLessonsApiUrl('search'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=UTF-8',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    query: userMessage,
                    category: selectedCategory,
                    source_file: selectedSourceFile,
                    mode: 'chat',
                    history: history.length > 0 ? history : null
                })
            });

            if (!res.ok) throw new Error('Chat request failed');
            const data = await res.json();

            if (data.response) {
                setChatMessages(prev => [...prev, {
                    role: 'assistant',
                    content: data.response,
                    sources: data.results
                }]);
            } else {
                setChatMessages(prev => [...prev, { role: 'assistant', content: '답변을 생성하지 못했습니다.' }]);
            }
        } catch (e) {
            console.error('Chat error:', e);
            setChatMessages(prev => [...prev, { role: 'assistant', content: '죄송합니다. 오류가 발생했습니다.', isError: true }]);
        } finally {
            setIsChatLoading(false);
        }
    };

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatMessages]);

    // Reset viewer page when preview doc changes
    useEffect(() => {
        setViewerPage(0);
    }, [previewDoc]);

    // =============================================
    // SUBMIT / KEY HANDLER
    // =============================================
    const handleSubmit = () => {
        if (mode === 'search') handleSearch();
        else handleChat();
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleResetChat = () => {
        if (!confirm('대화 내용을 초기화 하시겠습니까?')) return;
        setChatMessages([{ role: 'assistant', content: '안녕하세요! Lessons Learned에 대해 궁금한 점을 물어보세요.' }]);
        setQuery('');
        setPreviewDoc(null);
        setSelectedSourceFile(null);
        setSelectedCategory(null);
        setCategoryDocs([]);
    };

    // =============================================
    // LEFT RESIZE
    // =============================================
    const startLeftResize = useCallback((e) => {
        e.preventDefault();
        leftResizingRef.current = true;
        const startX = e.clientX;
        const startWidth = leftWidth;
        const onMove = (ev) => {
            if (!leftResizingRef.current) return;
            const delta = ev.clientX - startX;
            setLeftWidth(Math.max(220, Math.min(500, startWidth + delta)));
        };
        const onUp = () => {
            leftResizingRef.current = false;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [leftWidth]);

    // =============================================
    // RIGHT RESIZE
    // =============================================
    const startRightResize = useCallback((e) => {
        e.preventDefault();
        rightResizingRef.current = true;
        const startX = e.clientX;
        const startWidth = rightWidth;
        const onMove = (ev) => {
            if (!rightResizingRef.current) return;
            const delta = startX - ev.clientX;
            setRightWidth(Math.max(280, Math.min(700, startWidth + delta)));
        };
        const onUp = () => {
            rightResizingRef.current = false;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [rightWidth]);

    // =============================================
    // MARKDOWN COMPONENTS (for chat)
    // =============================================
    const baseMarkdownComponents = {
        table: ({ node, ...props }) => <div className="overflow-x-auto my-2"><table className="border-collapse border border-gray-300 w-full text-xs" {...props} /></div>,
        thead: ({ node, ...props }) => <thead className="bg-gray-100" {...props} />,
        th: ({ node, ...props }) => <th className="border border-gray-300 px-3 py-2 font-semibold text-left" {...props} />,
        td: ({ node, ...props }) => <td className="border border-gray-300 px-3 py-2" {...props} />,
        ul: ({ node, ...props }) => <ul className="list-disc pl-4 my-2 space-y-1" {...props} />,
        ol: ({ node, ...props }) => <ol className="list-decimal pl-4 my-2 space-y-1" {...props} />,
        li: ({ node, ...props }) => <li className="leading-relaxed" {...props} />,
        p: ({ node, ...props }) => <p className="mb-2 last:mb-0 leading-relaxed" {...props} />,
        strong: ({ node, ...props }) => <strong className="font-bold text-[#333333]" {...props} />,
        code: ({ node, inline, ...props }) => inline
            ? <code className="bg-gray-100 px-1 py-0.5 rounded font-mono text-xs" {...props} />
            : <code className="block bg-gray-100 p-2 rounded font-mono text-xs overflow-x-auto my-2" {...props} />,
    };

    // Pre-process chat markdown: replace source filenames with markdown links
    // Escapes _ to \_ so markdown parser doesn't treat them as emphasis
    const linkDocReferences = useCallback((text, sources) => {
        if (!text || !sources?.length) return text;
        const fnames = sources.map(s => s.file_nm).filter(Boolean);
        if (!fnames.length) return text;

        let result = text;
        // Sort by length descending to match longer filenames first
        const indexed = fnames.map((fn, i) => ({ fn, i })).sort((a, b) => b.fn.length - a.fn.length);

        for (const { fn, i } of indexed) {
            const escapedRe = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Truncate display name: max 30 chars
            const ext = fn.lastIndexOf('.') > 0 ? fn.slice(fn.lastIndexOf('.')) : '';
            const base = fn.lastIndexOf('.') > 0 ? fn.slice(0, fn.lastIndexOf('.')) : fn;
            const displayName = base.length > 28 ? base.slice(0, 28) + '..' + ext : fn;
            // Safe display: escape underscores for markdown
            const safeDisplay = displayName.replace(/_/g, '\\_');
            // Use hash-based href — always safe from URL sanitization
            const mdLink = `[${safeDisplay}](#doc-${i})`;

            // 1) Replace [filename] (bracketed references)
            result = result.replace(new RegExp(`\\[${escapedRe}\\](?!\\()`, 'g'), mdLink);
            // 2) Replace standalone filename not already inside a link
            result = result.replace(new RegExp(`(?<!\\[)(?<!\\]\\()${escapedRe}(?!\\])(?!\\))`, 'g'), mdLink);
        }
        return result;
    }, []);

    // Chat markdown components with doc link handler → opens right sidebar viewer
    const getChatComponents = useCallback((sources) => ({
        ...baseMarkdownComponents,
        a: ({ href, children }) => {
            const docMatch = href?.match(/^#doc-(\d+)$/);
            if (docMatch) {
                const idx = parseInt(docMatch[1], 10);
                const source = sources?.[idx];
                if (source) {
                    return (
                        <button
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPreviewDoc(source); }}
                            className="inline text-purple-600 hover:text-purple-800 underline decoration-purple-300 hover:decoration-purple-500 cursor-pointer font-medium transition-colors"
                            title={source.file_nm}
                        >
                            {children}
                        </button>
                    );
                }
            }
            return <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{children}</a>;
        },
    }), [baseMarkdownComponents]);

    // =============================================
    // RENDER
    // =============================================
    return (
        <div className="flex h-screen bg-[#fcfaf7] overflow-hidden font-sans">
            {/* ===== LEFT SIDEBAR ===== */}
            <div className="bg-[#f0f4f9] border-r border-gray-200 flex flex-col flex-shrink-0 h-full relative" style={{ width: leftWidth }}>
                {/* Left Resize Handle */}
                <div
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-purple-400 z-50 transition-colors"
                    onMouseDown={startLeftResize}
                />

                {/* Header */}
                <div className="p-4 border-b border-gray-200">
                    <div className="flex items-center justify-between">
                        <h1 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                            <BookOpen className="w-5 h-5 text-purple-600" />
                            Lessons Learned
                        </h1>
                        <button
                            onClick={() => navigate('/')}
                            className="p-1.5 rounded-lg hover:bg-gray-200 transition-colors text-gray-500 hover:text-gray-700"
                            title="홈으로"
                        >
                            <ArrowLeft className="w-4 h-4" />
                        </button>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">DOC-Master 문서를 검색해서 답변을 제공합니다.</p>
                </div>

                {/* Upload Section */}
                <div className="px-3 py-2 border-b border-gray-200">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".txt,.json"
                        className="hidden"
                        onChange={handleFileUpload}
                    />
                    <button
                        onClick={handleOpenProjectModal}
                        disabled={isUploading}
                        className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                        {isUploading ? (
                            <><Loader2 className="w-4 h-4 animate-spin" /> 처리 중...</>
                        ) : (
                            <><SearchIcon className="w-4 h-4" /> DOC-Master 프로젝트 검색</>
                        )}
                    </button>
                    {uploadProgress && (
                        <p className={`text-xs mt-1.5 px-1 ${uploadProgress.includes('실패') ? 'text-red-500' : 'text-green-600'}`}>
                            {uploadProgress}
                        </p>
                    )}
                </div>

                {/* Project List (Search Scope) */}
                {uploadedFiles.length > 0 && (
                    <div className="px-3 py-2 border-b border-gray-200">
                        <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5 px-1">프로젝트</div>
                        <button
                            onClick={() => { setSelectedSourceFile(null); setSelectedCategory(null); setCategoryDocs([]); }}
                            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors ${
                                !selectedSourceFile
                                    ? 'bg-purple-100 text-purple-700 font-medium'
                                    : 'text-gray-600 hover:bg-gray-200'
                            }`}
                        >
                            {!selectedSourceFile && <Check className="w-3 h-3 flex-shrink-0" />}
                            {selectedSourceFile && <div className="w-3 h-3 flex-shrink-0" />}
                            <span>전체 프로젝트 ({uploadedFiles.reduce((s, f) => s + f.document_count, 0)}건)</span>
                        </button>
                        {uploadedFiles.map((f) => {
                            const displayName = f.filename.replace(/\.(txt|json)$/i, '') + (f.pjt_cd ? ` (${f.pjt_cd})` : '');
                            return (
                            <div key={f.filename} className="flex items-center group">
                                <button
                                    onClick={() => { setSelectedSourceFile(f.filename); setSelectedCategory(null); setCategoryDocs([]); }}
                                    className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors min-w-0 ${
                                        selectedSourceFile === f.filename
                                            ? 'bg-purple-100 text-purple-700 font-medium'
                                            : 'text-gray-600 hover:bg-gray-200'
                                    }`}
                                >
                                    {selectedSourceFile === f.filename && <Check className="w-3 h-3 flex-shrink-0" />}
                                    {selectedSourceFile !== f.filename && <div className="w-3 h-3 flex-shrink-0" />}
                                    <span className="truncate">{displayName}</span>
                                    <span className="text-[10px] text-gray-400 ml-auto flex-shrink-0">{f.document_count}</span>
                                </button>
                                {isAdmin && (
                                <button
                                    onClick={() => handleDeleteFile(f.filename)}
                                    className="opacity-0 group-hover:opacity-100 p-1 text-red-400 hover:text-red-600 transition-opacity flex-shrink-0"
                                    title="삭제"
                                >
                                    <Trash2 className="w-3 h-3" />
                                </button>
                                )}
                            </div>
                            );
                        })}
                    </div>
                )}

                {/* Category Tree — scrollable middle section */}
                <div className="flex-1 overflow-y-auto px-3 py-2 min-h-0">
                    <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">분류 (Categories)</div>
                    {categoryTree.length === 0 ? (
                        <div className="text-xs text-gray-400 italic px-3 py-4">
                            {totalDocs === 0 ? '파일을 업로드하면 카테고리가 표시됩니다.' : 'Loading...'}
                        </div>
                    ) : (
                        <div className="space-y-0.5">
                            {categoryTree.map((group) => (
                                <div key={group.name}>
                                    {/* Group Header */}
                                    <button
                                        onClick={() => {
                                            setExpandedGroups(prev => {
                                                const next = new Set(prev);
                                                if (next.has(group.name)) next.delete(group.name);
                                                else next.add(group.name);
                                                return next;
                                            });
                                        }}
                                        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors"
                                    >
                                        {expandedGroups.has(group.name) ? (
                                            <ChevronDown className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                                        ) : (
                                            <ChevronRight className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                                        )}
                                        <FolderTree className="w-3.5 h-3.5 text-purple-500 flex-shrink-0" />
                                        <span className="truncate">{group.name}</span>
                                        <span className="text-xs text-gray-400 ml-auto">{group.count}</span>
                                    </button>

                                    {/* Subcategories */}
                                    {expandedGroups.has(group.name) && group.children.map((child) => (
                                        <div key={child.name}>
                                            <button
                                                onClick={() => handleCategoryClick(child.name)}
                                                className={`w-full flex items-center gap-2 pl-8 pr-3 py-1.5 rounded-lg text-xs transition-colors ${
                                                    selectedCategory === child.name
                                                        ? 'bg-purple-100 text-purple-700 font-medium'
                                                        : 'text-gray-600 hover:bg-gray-200'
                                                }`}
                                            >
                                                <FileText className="w-3 h-3 flex-shrink-0" />
                                                <span className="truncate">{child.name}</span>
                                                {child.count > 0 && (
                                                    <span className="text-[10px] text-gray-400 ml-auto">{child.count}</span>
                                                )}
                                            </button>

                                            {/* Documents in category */}
                                            {selectedCategory === child.name && (
                                                <div className="ml-10 mt-0.5 mb-1">
                                                    {loadingDocs ? (
                                                        <div className="flex items-center gap-1 text-[10px] text-gray-400 py-1">
                                                            <Loader2 className="w-2.5 h-2.5 animate-spin" /> Loading...
                                                        </div>
                                                    ) : categoryDocs.length === 0 ? (
                                                        <div className="text-[10px] text-gray-400 italic py-1">문서 없음</div>
                                                    ) : (
                                                        <div className="space-y-px max-h-40 overflow-y-auto">
                                                            {categoryDocs.map((doc, i) => (
                                                                <button
                                                                    key={doc.doc_id || i}
                                                                    onClick={() => {
                                                                        setSelectedDoc(doc);
                                                                        setPreviewDoc(doc);
                                                                    }}
                                                                    className={`w-full text-left px-2 py-1 rounded text-[11px] truncate transition-colors ${
                                                                        selectedDoc?.doc_id === doc.doc_id
                                                                            ? 'bg-purple-50 text-purple-700 font-medium'
                                                                            : 'text-gray-500 hover:bg-gray-100'
                                                                    }`}
                                                                    title={doc.file_nm}
                                                                >
                                                                    {doc.file_nm}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* User Profile (bottom) */}
                <div className="px-3 py-3 border-t border-gray-200 flex-shrink-0">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                            {currentUser?.photoURL ? (
                                <img src={currentUser.photoURL} alt="" className="w-8 h-8 rounded-full object-cover" />
                            ) : (
                                <User className="w-4 h-4 text-purple-600" />
                            )}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-800 truncate">
                                {currentUser?.displayName || currentUser?.email?.split('@')[0] || '사용자'}
                            </div>
                            <div className="text-[10px] text-gray-400 truncate">
                                {currentUser?.email || ''}
                            </div>
                        </div>
                        <button
                            onClick={async () => {
                                if (!confirm('로그아웃 하시겠습니까?')) return;
                                try { await logout(); navigate('/'); } catch {}
                            }}
                            className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
                            title="로그아웃"
                        >
                            <LogOut className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>

            {/* ===== CENTER PANEL ===== */}
            <div className="flex-1 flex flex-col min-w-0">
                {/* Mode Toggle + Category Filter */}
                <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 bg-white">
                    <button
                        onClick={() => setMode('search')}
                        className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                            mode === 'search'
                                ? 'bg-purple-600 text-white'
                                : 'text-gray-500 hover:bg-gray-100'
                        }`}
                    >
                        <SearchIcon className="w-4 h-4" />
                        AI 검색
                    </button>
                    <button
                        onClick={() => setMode('chat')}
                        className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                            mode === 'chat'
                                ? 'bg-purple-600 text-white'
                                : 'text-gray-500 hover:bg-gray-100'
                        }`}
                    >
                        <MessageSquare className="w-4 h-4" />
                        AI 분석
                    </button>

                    {selectedCategory && (
                        <div className="flex items-center gap-1 ml-2 px-2 py-1 bg-purple-50 text-purple-700 rounded-lg text-xs">
                            <span className="font-medium">{selectedCategory}</span>
                            <button onClick={() => { setSelectedCategory(null); setCategoryDocs([]); }} className="p-0.5 hover:bg-purple-100 rounded">
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    )}

                    {selectedSourceFile && (() => {
                        const sf = uploadedFiles.find(f => f.filename === selectedSourceFile);
                        const sfDisplay = selectedSourceFile.replace(/\.(txt|json)$/i, '') + (sf?.pjt_cd ? ` (${sf.pjt_cd})` : '');
                        return (
                        <div className="flex items-center gap-1 ml-1 px-2 py-1 bg-blue-50 text-blue-700 rounded-lg text-xs">
                            <FileText className="w-3 h-3" />
                            <span className="font-medium truncate max-w-[200px]">{sfDisplay}</span>
                            <button onClick={() => setSelectedSourceFile(null)} className="p-0.5 hover:bg-blue-100 rounded">
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                        );
                    })()}

                    {mode === 'search' && hasSearched && (
                        <button
                            onClick={() => { setSearchResults([]); setHasSearched(false); setQuery(''); setSearchError(null); setPreviewDoc(null); setSelectedSourceFile(null); setSelectedCategory(null); setCategoryDocs([]); }}
                            className="ml-auto flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
                            title="검색 초기화"
                        >
                            <RefreshCcw className="w-3 h-3" />
                            초기화
                        </button>
                    )}
                    {mode === 'chat' && chatMessages.length > 1 && (
                        <button
                            onClick={handleResetChat}
                            className="ml-auto flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
                            title="대화 초기화"
                        >
                            <RefreshCcw className="w-3 h-3" />
                            초기화
                        </button>
                    )}
                </div>

                {/* Results / Chat Area */}
                <div className="flex-1 overflow-y-auto px-4 py-4">
                    {mode === 'search' ? (
                        /* Search Results */
                        <>
                            {isSearching && (
                                <div className="flex items-center gap-2 text-gray-500 py-8 justify-center">
                                    <Loader2 className="w-5 h-5 animate-spin" />
                                    <span className="text-sm">검색 중...</span>
                                </div>
                            )}
                            {searchError && (
                                <div className="text-red-500 text-sm bg-red-50 px-4 py-3 rounded-lg">{searchError}</div>
                            )}
                            {!isSearching && hasSearched && searchResults.length === 0 && !searchError && (
                                <div className="text-gray-400 text-sm text-center py-8">검색 결과가 없습니다.</div>
                            )}
                            {!hasSearched && !isSearching && (
                                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                                    <BookOpen className="w-16 h-16 mb-4 text-gray-300" />
                                    <p className="text-lg font-medium text-gray-500 mb-2">Lessons Learned 검색</p>
                                    <p className="text-sm">프로젝트 경험과 교훈을 키워드로 검색하세요.</p>
                                </div>
                            )}
                            <div className="space-y-3">
                                {searchResults.map((r, i) => {
                                    const badge = getScoreBadge(r.score);
                                    const rawText = (r.content || r.content_preview || '').replace(/\.\.PAGE:\d+/g, '').trim();
                                    const isEmptyContent = rawText.length < 10;
                                    const searchKws = query.trim() ? query.trim().split(/\s+/).filter(w => w.length >= 2) : [];
                                    const highlightedName = searchKws.length > 0
                                        ? highlightTextInViewer(r.file_nm?.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') || '', searchKws)
                                        : null;
                                    return (
                                        <div
                                            key={r.doc_id || i}
                                            className="bg-white border border-gray-200 rounded-lg p-4 hover:border-purple-300 hover:shadow-sm cursor-pointer transition-all"
                                            onClick={() => setPreviewDoc(r)}
                                        >
                                            <div className="flex items-start justify-between mb-1.5">
                                                {highlightedName ? (
                                                    <h3 className="font-semibold text-sm text-gray-800 flex-1 truncate [&_mark]:bg-yellow-200 [&_mark]:px-0.5 [&_mark]:rounded" dangerouslySetInnerHTML={{ __html: highlightedName }} />
                                                ) : (
                                                    <h3 className="font-semibold text-sm text-gray-800 flex-1 truncate">{r.file_nm}</h3>
                                                )}
                                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ml-2 flex-shrink-0 ${badge.bg} ${badge.text}`}>
                                                    {badge.label} {r.score?.toFixed(1)}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className="px-1.5 py-0.5 bg-purple-50 text-purple-700 text-[10px] rounded font-medium">{r.category}</span>
                                                <span className="text-[10px] text-gray-400">{r.mclass} / {r.dclass}</span>
                                                {r.pjt_nm && <span className="text-[10px] text-gray-400 truncate max-w-[200px]">{r.pjt_nm}</span>}
                                                {isEmptyContent && (
                                                    <span className="px-1.5 py-0.5 bg-orange-100 text-orange-600 text-[10px] rounded font-medium">OCR 미처리</span>
                                                )}
                                            </div>
                                            {isEmptyContent ? (
                                                <p className="text-xs text-orange-400 italic">문서 본문이 추출되지 않았습니다 (OCR 미처리)</p>
                                            ) : r.highlight ? (
                                                <p
                                                    className="text-xs text-gray-600 line-clamp-3 leading-relaxed [&_mark]:bg-yellow-200 [&_mark]:px-0.5 [&_mark]:rounded"
                                                    dangerouslySetInnerHTML={{ __html: r.highlight }}
                                                />
                                            ) : (
                                                <p className="text-xs text-gray-600 line-clamp-3 leading-relaxed">
                                                    {r.content_preview}
                                                </p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    ) : (
                        /* Chat Messages */
                        <div className="space-y-4 max-w-3xl mx-auto">
                            {chatMessages.map((msg, i) => (
                                <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                                    {msg.role === 'assistant' && (
                                        <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                                            <Bot className="w-4 h-4 text-purple-600" />
                                        </div>
                                    )}
                                    <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
                                        msg.role === 'user'
                                            ? 'bg-purple-600 text-white'
                                            : msg.isError
                                                ? 'bg-red-50 text-red-700'
                                                : 'bg-white border border-gray-200 text-gray-800'
                                    }`}>
                                        {msg.role === 'assistant' ? (
                                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={getChatComponents(msg.sources)}>
                                                {linkDocReferences(msg.content, msg.sources)}
                                            </ReactMarkdown>
                                        ) : (
                                            <p className="whitespace-pre-wrap">{msg.content}</p>
                                        )}

                                        {/* Sources */}
                                        {msg.sources && msg.sources.length > 0 && (
                                            <div className="mt-3 pt-2 border-t border-gray-100">
                                                <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1.5">참고 문서</p>
                                                <div className="space-y-1">
                                                    {msg.sources.slice(0, 5).map((s, j) => (
                                                        <button
                                                            key={j}
                                                            onClick={() => setPreviewDoc(s)}
                                                            className="w-full text-left px-2 py-1 bg-gray-50 hover:bg-purple-50 rounded text-[11px] text-gray-600 hover:text-purple-700 truncate transition-colors"
                                                        >
                                                            [{s.category}] {s.file_nm}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    {msg.role === 'user' && (
                                        <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                                            <User className="w-4 h-4 text-gray-600" />
                                        </div>
                                    )}
                                </div>
                            ))}
                            {isChatLoading && (
                                <div className="flex gap-3">
                                    <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                                        <Bot className="w-4 h-4 text-purple-600" />
                                    </div>
                                    <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 text-sm text-gray-400 flex items-center gap-2">
                                        <Loader2 className="w-4 h-4 animate-spin" /> 분석 중...
                                    </div>
                                </div>
                            )}
                            <div ref={messagesEndRef} />
                        </div>
                    )}
                </div>

                {/* Input Area */}
                <div className="px-4 py-3 border-t border-gray-200 bg-white">
                    <div className="flex items-center gap-2 max-w-3xl mx-auto">
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={mode === 'search' ? '키워드로 검색... (예: NCR, 품질개선, 가열로)' : '질문을 입력하세요...'}
                            className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-colors"
                            disabled={isSearching || isChatLoading}
                        />
                        <button
                            onClick={handleSubmit}
                            disabled={!query.trim() || isSearching || isChatLoading}
                            className="p-2.5 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 text-white rounded-xl transition-colors"
                        >
                            {mode === 'search' ? <SearchIcon className="w-4 h-4" /> : <Send className="w-4 h-4" />}
                        </button>
                    </div>
                </div>
            </div>

            {/* ===== PROJECT MODAL ===== */}
            {showProjectModal && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center">
                    {/* Overlay */}
                    <div className="absolute inset-0 bg-black/40" onClick={() => setShowProjectModal(false)} />
                    {/* Modal */}
                    <div className="relative bg-white rounded-xl shadow-2xl w-[520px] max-h-[70vh] flex flex-col overflow-hidden">
                        {/* Modal Header */}
                        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
                            <h2 className="text-base font-bold text-gray-800 flex items-center gap-2">
                                <FolderTree className="w-5 h-5 text-purple-600" />
                                DOC-Master의 프로젝트 검색
                            </h2>
                            <button
                                onClick={() => setShowProjectModal(false)}
                                className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Modal Body */}
                        <div className="flex-1 overflow-y-auto px-5 py-4">
                            {/* Admin-only: Upload new project */}
                            {isAdmin && (
                                <div className="mb-5">
                                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">신규 프로젝트 등록</div>
                                    <button
                                        onClick={() => { fileInputRef.current?.click(); }}
                                        disabled={isUploading}
                                        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 border-2 border-dashed border-purple-300 hover:border-purple-500 hover:bg-purple-50 disabled:border-gray-300 disabled:bg-gray-50 rounded-lg text-sm text-purple-600 hover:text-purple-700 disabled:text-gray-400 font-medium transition-colors"
                                    >
                                        {isUploading ? (
                                            <><Loader2 className="w-4 h-4 animate-spin" /> 처리 중...</>
                                        ) : (
                                            <><Upload className="w-4 h-4" /> TXT / JSON 파일 업로드</>
                                        )}
                                    </button>
                                    {uploadProgress && (
                                        <p className={`text-xs mt-1.5 ${uploadProgress.includes('실패') ? 'text-red-500' : 'text-green-600'}`}>
                                            {uploadProgress}
                                        </p>
                                    )}
                                </div>
                            )}

                            {/* Registered projects list */}
                            <div>
                                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                                    등록된 프로젝트 {allProjects.length > 0 && `(${allProjects.length})`}
                                </div>
                                {loadingAllProjects ? (
                                    <div className="flex items-center justify-center gap-2 py-8 text-gray-400">
                                        <Loader2 className="w-5 h-5 animate-spin" />
                                        <span className="text-sm">프로젝트 목록 로딩 중...</span>
                                    </div>
                                ) : allProjects.length === 0 ? (
                                    <div className="text-sm text-gray-400 text-center py-8">
                                        등록된 프로젝트가 없습니다.
                                    </div>
                                ) : (
                                    <div className="space-y-1">
                                        {allProjects.map((p) => {
                                            const displayName = p.filename.replace(/\.(txt|json)$/i, '');
                                            const isSelected = selectedSourceFile === p.filename;
                                            return (
                                                <button
                                                    key={p.filename}
                                                    onClick={() => handleSelectProject(p)}
                                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${
                                                        isSelected
                                                            ? 'bg-purple-100 text-purple-700 font-medium ring-1 ring-purple-300'
                                                            : 'hover:bg-gray-100 text-gray-700'
                                                    }`}
                                                >
                                                    <FileText className={`w-4 h-4 flex-shrink-0 ${isSelected ? 'text-purple-600' : 'text-gray-400'}`} />
                                                    <div className="flex-1 min-w-0">
                                                        <div className="font-medium truncate">{displayName}</div>
                                                        <div className="text-[11px] text-gray-400 truncate">
                                                            {p.pjt_cd && <span className="mr-2">{p.pjt_cd}</span>}
                                                            {p.pjt_nm && <span>{p.pjt_nm}</span>}
                                                        </div>
                                                    </div>
                                                    <span className={`text-xs flex-shrink-0 ${isSelected ? 'text-purple-500' : 'text-gray-400'}`}>
                                                        {p.document_count}건
                                                    </span>
                                                    {isSelected && <Check className="w-4 h-4 text-purple-600 flex-shrink-0" />}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ===== RIGHT PANEL (Document Viewer) ===== */}
            {previewDoc && (() => {
                const fullContent = previewDoc.content || previewDoc.content_preview || '';
                const viewerEmpty = fullContent.replace(/\.\.PAGE:\d+/g, '').trim().length < 10;
                const pages = parseContentPages(fullContent);
                const currentPage = pages[viewerPage] || pages[0];
                const searchKeywords = (() => {
                    // In search mode: use search query
                    if (mode === 'search' && query.trim()) {
                        return query.trim().split(/\s+/).filter(w => w.length >= 2);
                    }
                    // In chat mode: use last user message as keywords
                    if (mode === 'chat') {
                        const lastUserMsg = chatMessages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
                        return lastUserMsg.trim() ? lastUserMsg.trim().split(/\s+/).filter(w => w.length >= 2) : [];
                    }
                    return query.trim() ? query.trim().split(/\s+/).filter(w => w.length >= 2) : [];
                })();
                const reportHtml = formatContentForViewer(currentPage?.text || '');
                const highlightedContent = searchKeywords.length > 0
                    ? highlightTextInViewer(reportHtml, searchKeywords)
                    : reportHtml;
                const highlightedTitle = searchKeywords.length > 0
                    ? highlightTextInViewer(
                        (previewDoc.file_nm || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
                        searchKeywords
                      )
                    : null;

                return (
                    <div className="border-l border-gray-200 bg-white flex flex-col flex-shrink-0 h-full relative" style={{ width: rightWidth }}>
                        {/* Right Resize Handle */}
                        <div
                            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-purple-400 z-50 transition-colors"
                            onMouseDown={startRightResize}
                        />
                        {/* Preview Header */}
                        <div className="p-4 border-b border-gray-200 flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                                {highlightedTitle ? (
                                    <h2 className="font-bold text-sm text-gray-800 truncate [&_mark]:bg-yellow-200 [&_mark]:px-0.5 [&_mark]:rounded" title={previewDoc.file_nm} dangerouslySetInnerHTML={{ __html: highlightedTitle }} />
                                ) : (
                                    <h2 className="font-bold text-sm text-gray-800 truncate" title={previewDoc.file_nm}>
                                        {previewDoc.file_nm}
                                    </h2>
                                )}
                                <div className="flex items-center gap-2 mt-1">
                                    <span className="px-1.5 py-0.5 bg-purple-50 text-purple-700 text-[10px] rounded font-medium">{previewDoc.category}</span>
                                    <span className="text-[10px] text-gray-400">{previewDoc.mclass} / {previewDoc.dclass}</span>
                                </div>
                                {previewDoc.pjt_nm && (
                                    <p className="text-[10px] text-gray-400 mt-1 truncate">{previewDoc.pjt_nm}</p>
                                )}
                                {previewDoc.creator_name && (
                                    <p className="text-[10px] text-gray-400">작성자: {previewDoc.creator_name} | {previewDoc.reg_date}</p>
                                )}
                                {previewDoc.source_file && (
                                    <p className="text-[10px] text-gray-400 mt-0.5">소스: {previewDoc.source_file}</p>
                                )}
                                {previewDoc.file_path && (
                                    <a
                                        href={previewDoc.file_path}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 mt-1.5 px-2.5 py-1 bg-purple-600 hover:bg-purple-700 text-white text-[11px] font-medium rounded-md transition-colors"
                                    >
                                        <ExternalLink className="w-3 h-3" />
                                        DOC-Master 문서열기
                                    </a>
                                )}
                            </div>
                            <button
                                onClick={() => setPreviewDoc(null)}
                                className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {/* Page Navigation (if multiple pages) */}
                        {pages.length > 1 && (
                            <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-100 bg-gray-50">
                                <button
                                    onClick={() => setViewerPage(p => Math.max(0, p - 1))}
                                    disabled={viewerPage === 0}
                                    className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                >
                                    <ChevronLeft className="w-4 h-4" />
                                </button>
                                <div className="flex-1 flex items-center gap-1 overflow-x-auto px-1">
                                    {pages.map((p, idx) => (
                                        <button
                                            key={idx}
                                            onClick={() => setViewerPage(idx)}
                                            className={`min-w-[28px] h-7 px-1.5 rounded text-xs font-medium transition-colors ${
                                                viewerPage === idx
                                                    ? 'bg-purple-600 text-white'
                                                    : 'bg-white text-gray-600 hover:bg-gray-200 border border-gray-200'
                                            }`}
                                        >
                                            {p.pageNum}
                                        </button>
                                    ))}
                                </div>
                                <button
                                    onClick={() => setViewerPage(p => Math.min(pages.length - 1, p + 1))}
                                    disabled={viewerPage === pages.length - 1}
                                    className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                >
                                    <ChevronRight className="w-4 h-4" />
                                </button>
                                <span className="text-[10px] text-gray-400 ml-1 flex-shrink-0">
                                    {viewerPage + 1}/{pages.length}
                                </span>
                            </div>
                        )}

                        {/* Document Content — Report Style */}
                        <div className="flex-1 overflow-y-auto p-5">
                            {viewerEmpty ? (
                                <div className="flex flex-col items-center justify-center h-full text-center">
                                    <div className="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center mb-3">
                                        <FileText className="w-6 h-6 text-orange-400" />
                                    </div>
                                    <span className="px-2 py-1 bg-orange-100 text-orange-600 text-xs rounded font-medium mb-2">OCR 미처리</span>
                                    <p className="text-sm text-gray-500">문서 본문이 추출되지 않았습니다.</p>
                                    <p className="text-xs text-gray-400 mt-1">SDC 시스템에서 OCR 처리가 되지 않은 문서입니다.</p>
                                </div>
                            ) : (
                                <div
                                    className="report-viewer text-[13px] text-gray-700 leading-relaxed"
                                    dangerouslySetInnerHTML={{ __html: highlightedContent }}
                                />
                            )}
                        </div>
                    </div>
                );
            })()}
        </div>
    );
};

export default LessonsLearned;
