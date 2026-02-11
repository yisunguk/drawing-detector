import React, { useState, useEffect, useRef } from 'react';
import { Send, Bot, User, Loader2, Sparkles, AlertCircle, RefreshCcw, Search, MessageSquare, List, ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { db, auth } from '../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { logActivity } from '../services/logging';

const ChatInterface = ({ activeDoc, documents = [], chatScope = 'active', onCitationClick }) => {
    const [messages, setMessages] = useState([
        { role: 'assistant', content: '안녕하세요! 도면에 대해 궁금한 점을 물어보세요.' }
    ]);
    const [searchResults, setSearchResults] = useState([]); // NEW: Store raw search results
    const [searchMode, setSearchMode] = useState('chat'); // NEW: 'chat' or 'search'
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef(null);
    const { currentUser } = useAuth();

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    const prevMessagesLength = useRef(messages.length);

    useEffect(() => {
        if (messages.length > prevMessagesLength.current) {
            scrollToBottom();
        }
        prevMessagesLength.current = messages.length;
    }, [messages]);

    // Reset chat when document changes or scope changes
    // Load messages from LocalStorage when doc changes
    useEffect(() => {
        const loadMessages = () => {
            const contextKey = chatScope === 'active' ? activeDoc?.id : 'all_docs';
            if (!contextKey) return;

            const savedKey = `chat_history_${contextKey}`;
            const savedMessages = localStorage.getItem(savedKey);

            if (savedMessages) {
                try {
                    setMessages(JSON.parse(savedMessages));
                } catch (e) {
                    console.error("Failed to parse chat history", e);
                }
            } else {
                // Initialize default greeting if no history
                if (chatScope === 'active') {
                    setMessages([
                        { role: 'assistant', content: `안녕하세요! "${activeDoc?.name || '도면'}"에 대해 궁금한 점을 물어보세요.` }
                    ]);
                } else {
                    setMessages([
                        { role: 'assistant', content: `안녕하세요! 현재 열려있는 ${documents.length}개의 모든 문서에 대해 물어보세요.` }
                    ]);
                }
            }
        };

        loadMessages();
    }, [activeDoc?.id, chatScope, documents.length]);

    // Save messages to LocalStorage
    useEffect(() => {
        const contextKey = chatScope === 'active' ? activeDoc?.id : 'all_docs';
        if (contextKey && messages.length > 0) {
            // Avoid saving just the instruction message if we want, but saving everything is safer for state consistency
            localStorage.setItem(`chat_history_${contextKey}`, JSON.stringify(messages));
        }
    }, [messages, activeDoc?.id, chatScope]);

    const formatContext = () => {
        // Decide which docs to include
        const docsToInclude = chatScope === 'active'
            ? (activeDoc ? [activeDoc] : [])
            : documents;

        console.log(`[ChatContext] Generating context. Scope: ${chatScope}, Docs: ${docsToInclude.length}`);

        if (docsToInclude.length === 0) return '';

        let context = '';

        docsToInclude.forEach(doc => {
            let docContext = `\n=== Document Name: ${doc.name} ===\n`;

            if (doc.ocrData) {
                // Check if it's the standard OCR structure (Array or Object with layout.lines)
                const pages = Array.isArray(doc.ocrData) ? doc.ocrData : [doc.ocrData];
                const hasOcrStructure = pages.some(p => p?.layout?.lines || p?.lines || (p?.tables && p.tables.length > 0));

                console.log(`[ChatContext] Processing ${doc.name}: Has OCR Data (Pages: ${pages.length}, Structured: ${hasOcrStructure})`);

                if (hasOcrStructure) {
                    // Use OCR data if available
                    pages.forEach((page, idx) => {
                        docContext += `\n[Page ${page.page_number || idx + 1}]\n`;

                        // Add line-based content first
                        const lines = page.layout?.lines || page.lines;
                        if (lines) {
                            lines.forEach(line => {
                                docContext += `${line.content || line.text}\n`;
                            });
                        }

                        // Add structured table content if available
                        if (page.tables && page.tables.length > 0) {
                            docContext += `\n[Structured Tables from Page ${page.page_number || idx + 1}]\n`;
                            page.tables.forEach((table, tIdx) => {
                                docContext += `\nTable ${tIdx + 1}:\n`;

                                // Initialize grid
                                let grid = [];

                                if (table.rows && Array.isArray(table.rows)) {
                                    // Backend already constructed the 2D grid
                                    grid = table.rows;
                                } else {
                                    // Fallback: Construct from cells (Direct Azure DI response)
                                    for (let r = 0; r < table.row_count; r++) {
                                        grid[r] = new Array(table.column_count).fill("");
                                    }

                                    // Fill grid
                                    if (table.cells) {
                                        table.cells.forEach(cell => {
                                            if (cell.row_index < table.row_count && cell.column_index < table.column_count) {
                                                grid[cell.row_index][cell.column_index] = (cell.content || "").replace(/\n/g, " ");
                                            }
                                        });
                                    }
                                }

                                // Render Markdown Table
                                if (grid.length > 0) {
                                    // Header
                                    docContext += "| " + grid[0].join(" | ") + " |\n";
                                    docContext += "| " + grid[0].map(() => "---").join(" | ") + " |\n";

                                    // Body
                                    for (let r = 1; r < grid.length; r++) {
                                        docContext += "| " + grid[r].join(" | ") + " |\n";
                                    }
                                }
                                docContext += "\n";
                            });
                        }
                    });
                } else {
                    // Fallback: Dump the entire JSON as context (for custom metadata)
                    console.log(`[ChatContext] ${doc.name}: Using JSON dump fallback`);
                    docContext += `\n[Metadata / JSON Content]\n${JSON.stringify(doc.ocrData, null, 2)}\n`;
                }
            } else if (doc.pdfTextData) {
                console.log(`[ChatContext] ${doc.name}: Using PDF Text Data`);
                // Use PDF text data if available
                doc.pdfTextData.forEach((page, idx) => {
                    docContext += `\n[Page ${page.page_number || idx + 1}]\n`;
                    if (page.layout?.lines) {
                        page.layout.lines.forEach(line => {
                            docContext += `${line.content}\n`;
                        });
                    }
                });
            } else {
                console.warn(`[ChatContext] ${doc.name}: No text data found!`);
            }
            docContext += `\n=== End of ${doc.name} ===\n`;
            console.log(`[ChatContext] Added ${docContext.length} chars for ${doc.name}`);
            context += docContext;
        });

        console.log(`[ChatContext] Total context length: ${context.length}`);
        return context;
    };

    const handleSend = async () => {
        if (!input.trim() || isLoading) return;

        // Capture current mode and ensure we switch to chat UI if sending a message
        // If the user types in the chat box, we nearly always want a chat response.
        const targetMode = searchMode;
        if (targetMode === 'search') {
            setSearchMode('chat'); // Switch UI to chat
        }

        const userMessage = input.trim();
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
        setIsLoading(true);

        // Log Chat Activity
        if (currentUser) {
            logActivity(currentUser.uid, currentUser.email, 'CHAT', `Query: ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`);
        }

        try {
            let context = null;
            if (chatScope === 'active') {
                context = formatContext();
            }

            const PRODUCTION_API_URL = 'https://drawing-detector-backend-kr7kyy4mza-uc.a.run.app';
            const rawBase = import.meta.env.VITE_API_URL || PRODUCTION_API_URL;
            const baseApi = rawBase.replace(/\/$/, "");
            const apiPath = baseApi.endsWith('/api') ? '/v1/chat/' : '/api/v1/chat/';
            const API_URL = `${baseApi}${apiPath}`;

            const headers = { 'Content-Type': 'application/json; charset=UTF-8' };

            if (chatScope === 'all') {
                const user = auth.currentUser;
                if (!user) {
                    setMessages(prev => [...prev, { role: 'assistant', content: '❌ 인증이 필요합니다.' }]);
                    setIsLoading(false);
                    return;
                }
                const idToken = await user.getIdToken();
                headers['Authorization'] = `Bearer ${idToken}`;
            }

            let docIds = null;
            if (activeDoc) {
                docIds = [activeDoc.name];
            } else if (documents && documents.length > 0) {
                docIds = documents.map(d => d.name);
            }

            const response = await fetch(API_URL, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    query: userMessage,
                    context: context,
                    filename: activeDoc?.name,
                    doc_ids: docIds,
                    mode: targetMode
                }),
            });

            if (!response.ok) throw new Error('Network response was not ok');

            const data = await response.json();

            if (targetMode === 'search') {
                setSearchResults(data.results || []);
                // If we were in search mode, we might want to switch BACK to search mode 
                // if the user sent a search query. But since we forced UI to 'chat', 
                // maybe we should have stayed in 'search'?
                // For now, if it was search mode, we set search results and stay in search.
                setSearchMode('search');
                setIsLoading(false);
                return;
            }

            // Chat Mode Handling
            if (data.response) {
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: data.response,
                    results: data.results // Save sources for chat too
                }]);
            } else {
                setMessages(prev => [...prev, { role: 'assistant', content: '답변을 생성하지 못했습니다.' }]);
            }

            if (currentUser) {
                try {
                    await addDoc(collection(db, 'users', currentUser.uid, 'chatHistory'), {
                        query: userMessage,
                        response: data.response || '',
                        timestamp: serverTimestamp(),
                        filename: activeDoc?.name || 'All Documents',
                        docId: activeDoc?.id || null
                    });
                } catch (historyErr) {
                    console.error("Failed to save history:", historyErr);
                }
            }
        } catch (error) {
            console.error('Chat error:', error);
            setMessages(prev => [...prev, { role: 'assistant', content: '죄송합니다. 오류가 발생했습니다.', isError: true }]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleReset = () => {
        if (confirm('대화 내용을 초기화 하시겠습니까?')) {
            const contextKey = chatScope === 'active' ? activeDoc?.id : 'all_docs';
            if (contextKey) {
                localStorage.removeItem(`chat_history_${contextKey}`);
            }

            if (chatScope === 'active') {
                setMessages([
                    { role: 'assistant', content: `안녕하세요! "${activeDoc?.name || '도면'}"에 대해 궁금한 점을 물어보세요.` }
                ]);
            } else {
                setMessages([
                    { role: 'assistant', content: `안녕하세요! 현재 열려있는 ${documents.length}개의 모든 문서에 대해 물어보세요.` }
                ]);
            }
        }
    };

    return (
        <div className="flex flex-col h-full bg-white">
            {/* Chat Header with Tabs */}
            <div className="p-3 border-b border-[#e5e1d8] bg-[#fcfaf7] flex items-center justify-between">
                <div className="flex bg-[#f0eee6] p-1 rounded-lg">
                    <button
                        onClick={() => setSearchMode('chat')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${searchMode === 'chat'
                            ? 'bg-white text-[#d97757] shadow-sm'
                            : 'text-gray-500 hover:text-gray-700'
                            }`}
                    >
                        <MessageSquare size={14} />
                        AI 질의응답
                    </button>
                    <button
                        onClick={() => setSearchMode('search')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${searchMode === 'search'
                            ? 'bg-white text-[#d97757] shadow-sm'
                            : 'text-gray-500 hover:text-gray-700'
                            }`}
                    >
                        <Search size={14} />
                        키워드 검색
                    </button>
                </div>

                <div className="flex items-center gap-2">
                    {/* Reset Button */}
                    <button
                        onClick={handleReset}
                        className="p-1.5 hover:bg-gray-100 rounded-md text-gray-500 hover:text-[#d97757] transition-colors"
                        title="초기화"
                    >
                        <RefreshCcw size={16} />
                    </button>
                </div>
            </div>

            {/* Content Area */}
            <div className={`flex-1 overflow-y-auto p-4 space-y-4 ${searchMode === 'chat' ? 'bg-[#f9f8f6]' : 'bg-white'}`}>
                {searchMode === 'chat' ? (
                    <>
                        {messages.map((msg, idx) => (
                            <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === 'user' ? 'bg-[#333333]' : 'bg-[#d97757]'}`}>
                                    {msg.role === 'user' ? <User size={14} className="text-white" /> : <Bot size={14} className="text-white" />}
                                </div>
                                <div className={`max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed shadow-sm ${msg.role === 'user'
                                    ? '!bg-[#333333] !text-white rounded-tr-none'
                                    : msg.isError
                                        ? 'bg-red-50 text-red-600 border border-red-100 rounded-tl-none'
                                        : 'bg-white text-[#333333] border border-[#e5e1d8] rounded-tl-none'
                                    }`}>
                                    {msg.role === 'user' ? (
                                        msg.content
                                    ) : (
                                        <ReactMarkdown
                                            remarkPlugins={[remarkGfm]}
                                            components={{
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
                                                a: ({ node, href, children, ...props }) => {
                                                    if (href?.startsWith('#citation-')) {
                                                        const keyword = decodeURIComponent(href.replace('#citation-', ''));
                                                        return (
                                                            <button
                                                                onClick={(e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    console.log(`Citation clicked: ${keyword}`);
                                                                    if (onCitationClick) {
                                                                        onCitationClick(keyword);
                                                                    } else {
                                                                        console.warn('onCitationClick prop is missing');
                                                                    }
                                                                }}
                                                                className="mx-1 px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded cursor-pointer hover:bg-blue-100 font-medium inline-flex items-center gap-0.5 text-xs transition-colors border border-blue-200 relative z-10"
                                                                title={`Locate "${keyword}" in drawing`}
                                                            >
                                                                <Sparkles size={10} />
                                                                {children}
                                                            </button>
                                                        );
                                                    }
                                                    return <a href={href} className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
                                                }
                                            }}
                                        >
                                            {msg.content.replace(/(`*)\[\[(.*?)\]\]\1/g, (match, backticks, p1) => {
                                                // Handle pipe character for table safety and cleaner display
                                                // [[Keyword|Page]] -> Keyword (Page)
                                                const cleanText = p1.includes('|') ? p1.split('|')[0].trim() + " (" + p1.split('|')[1].trim() + ")" : p1;
                                                // The link itself uses the original p1 (encoded) to preserve it for the click handler
                                                return `[${cleanText.replace(/\|/g, '\\|')}](#citation-${encodeURIComponent(p1)})`;
                                            })}
                                        </ReactMarkdown>
                                    )}

                                    {/* Sources / Citations list for Q&A */}
                                    {msg.role === 'assistant' && msg.results && msg.results.length > 0 && (
                                        <div className="mt-4 pt-3 border-t border-gray-100">
                                            <div className="flex items-center gap-1.5 text-[10px] font-bold text-gray-400 mb-2 uppercase tracking-wider">
                                                <List size={10} />
                                                출처 (Sources)
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {msg.results.map((res, rIdx) => (
                                                    <button
                                                        key={rIdx}
                                                        onClick={() => {
                                                            if (onCitationClick) {
                                                                // Pass the actual matched content for better highlighting
                                                                // We use a pipe-delimited format that handleCitationClick can parse
                                                                onCitationClick(`${res.content}|${res.page}|${res.filename}|${res.coords || ''}|${res.type || ''}`);
                                                            }
                                                        }}
                                                        className="flex items-center gap-1 px-2 py-1 bg-[#f4f1ea] hover:bg-[#e5e1d8] text-[#d97757] text-[10px] font-medium rounded-md border border-[#e5e1d8]/50 transition-colors max-w-[150px] truncate"
                                                        title={`${res.filename} - Page ${res.page}`}
                                                    >
                                                        <Sparkles size={8} />
                                                        <span className="truncate">{res.filename}</span>
                                                        <span className="text-gray-400 font-normal ml-0.5">p.{res.page}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex gap-3">
                                <div className="w-8 h-8 rounded-full bg-[#d97757] flex items-center justify-center flex-shrink-0">
                                    <Bot size={14} className="text-white" />
                                </div>
                                <div className="bg-white border border-[#e5e1d8] p-3 rounded-2xl rounded-tl-none shadow-sm flex items-center gap-2">
                                    <Loader2 size={14} className="animate-spin text-[#d97757]" />
                                    <span className="text-xs text-[#666666]">Thinking...</span>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </>
                ) : (
                    // START SEARCH RESULTS (List View)
                    <div className="space-y-4 max-w-3xl mx-auto">
                        <div className="flex items-center justify-between mb-4 border-b border-gray-100 pb-2">
                            <h3 className="text-sm font-bold text-gray-700 flex items-center gap-2">
                                <List size={16} className="text-[#d97757]" />
                                검색 결과 {searchResults.length > 0 && `(${searchResults.length})`}
                            </h3>
                        </div>

                        {searchResults.length === 0 && !isLoading && (
                            <div className="flex flex-col items-center justify-center h-64 text-gray-400 text-sm">
                                <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mb-4">
                                    <Search size={32} className="opacity-10 text-gray-900" />
                                </div>
                                <p className="font-medium text-gray-500">검색결과가 없습니다.</p>
                                <p className="text-xs mt-1">키워드를 입력하고 검색을 시작하세요.</p>
                            </div>
                        )}

                        <div className="grid gap-3">
                            {searchResults.map((res, idx) => (
                                <div
                                    key={idx}
                                    className="bg-white p-4 rounded-xl border border-[#e5e1d8] hover:border-[#d97757] hover:shadow-md transition-all cursor-pointer group relative overflow-hidden"
                                    onClick={() => {
                                        if (onCitationClick) {
                                            onCitationClick(`${res.content}|${res.page}|${res.filename}|${res.coords || ''}|${res.type || ''}`);
                                        }
                                    }}
                                >
                                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-[#d97757] opacity-0 group-hover:opacity-100 transition-opacity" />

                                    <div className="flex justify-between items-start mb-2">
                                        <div className="flex items-center gap-2">
                                            <div className="w-6 h-6 rounded bg-orange-50 flex items-center justify-center text-[#d97757]">
                                                <Sparkles size={12} />
                                            </div>
                                            <h4 className="font-bold text-gray-800 text-sm truncate max-w-[200px]">
                                                {res.filename}
                                            </h4>
                                        </div>
                                        <span className="text-[10px] font-bold bg-[#d97757]/10 text-[#d97757] px-2 py-0.5 rounded-full border border-[#d97757]/20">
                                            Page {res.page}
                                        </span>
                                    </div>

                                    <p className="text-xs text-[#555555] line-clamp-3 leading-relaxed mb-3">
                                        {res.content}
                                    </p>

                                    <div className="flex justify-between items-center pt-2 border-t border-gray-50">
                                        <div className="flex items-center gap-1.5">
                                            <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                                            <span className="text-[10px] text-gray-400 uppercase tracking-tighter">Match Score: {res.score?.toFixed(2)}</span>
                                        </div>
                                        <button className="text-[10px] font-bold text-blue-600 flex items-center gap-1 group-hover:translate-x-1 transition-transform">
                                            도면 보기 <ChevronRight size={10} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {isLoading && (
                            <div className="flex flex-col items-center justify-center py-12">
                                <Loader2 size={28} className="animate-spin text-[#d97757] mb-3" />
                                <p className="text-xs text-gray-500 animate-pulse">검색 중입니다...</p>
                            </div>
                        )}
                    </div>
                )}
            </div>


            {/* Input Area */}
            <div className="p-4 bg-white border-t border-[#e5e1d8]">
                {searchMode === 'chat' ? (
                    <div className="relative">
                        <textarea
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={activeDoc ? "Ask about this document..." : "Ask about all your documents..."}
                            className="w-full bg-[#f4f1ea] border border-[#e5e1d8] rounded-xl py-3 pl-4 pr-12 text-sm focus:outline-none focus:border-[#d97757] focus:ring-1 focus:ring-[#d97757] transition-all resize-none h-[50px] max-h-[120px] overflow-y-auto placeholder-[#a0a0a0]"
                            disabled={isLoading || (!activeDoc && chatScope !== 'all')}
                        />
                        <button
                            onClick={handleSend}
                            disabled={!input.trim() || isLoading || (!activeDoc && chatScope !== 'all')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-[#d97757] text-white rounded-lg hover:bg-[#c05535] disabled:opacity-50 disabled:hover:bg-[#d97757] transition-colors"
                        >
                            <Send size={14} />
                        </button>
                    </div>
                ) : (
                    <div className="max-w-3xl mx-auto flex items-center gap-2">
                        <div className="relative flex-1">
                            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">
                                <Search size={16} />
                            </div>
                            <input
                                type="text"
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="키워드를 입력하여 관련 도면을 찾으세요..."
                                className="w-full bg-white border-2 border-gray-100 rounded-full py-2.5 pl-11 pr-4 text-sm focus:outline-none focus:border-[#d97757] focus:ring-4 focus:ring-[#d97757]/10 transition-all placeholder-gray-400 shadow-sm"
                                disabled={isLoading}
                            />
                        </div>
                        <button
                            onClick={handleSend}
                            disabled={!input.trim() || isLoading}
                            className="px-6 py-2.5 bg-[#d97757] text-white text-xs font-bold rounded-full hover:bg-[#c05535] disabled:opacity-50 shadow-md shadow-[#d97757]/20 transition-all flex items-center gap-2"
                        >
                            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                            검색하기
                        </button>
                    </div>
                )}

                {searchMode === 'chat' && (!activeDoc && chatScope !== 'all') && (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-amber-600 bg-amber-50 px-2 py-1 rounded-md border border-amber-100">
                        <AlertCircle size={12} />
                        <span>Please select a document to start chatting</span>
                    </div>
                )}
            </div>

        </div>
    );
};

export default ChatInterface;
