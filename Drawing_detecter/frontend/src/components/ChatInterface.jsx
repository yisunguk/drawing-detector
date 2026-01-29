import React, { useState, useEffect, useRef } from 'react';
import { Send, Bot, User, Loader2, Sparkles, AlertCircle } from 'lucide-react';

const ChatInterface = ({ activeDoc }) => {
    const [messages, setMessages] = useState([
        { role: 'assistant', content: '안녕하세요! 도면에 대해 궁금한 점을 물어보세요.' }
    ]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    // Reset chat when document changes
    useEffect(() => {
        setMessages([
            { role: 'assistant', content: `안녕하세요! "${activeDoc?.name || '도면'}"에 대해 궁금한 점을 물어보세요.` }
        ]);
    }, [activeDoc?.id]);

    const formatContext = () => {
        if (!activeDoc) return '';

        let context = `Document Name: ${activeDoc.name}\n`;

        if (activeDoc.ocrData) {
            // Use OCR data if available
            const pages = Array.isArray(activeDoc.ocrData) ? activeDoc.ocrData : [activeDoc.ocrData];
            pages.forEach((page, idx) => {
                context += `\nPage ${page.page_number || idx + 1}:\n`;
                if (page.layout?.lines) {
                    page.layout.lines.forEach(line => {
                        context += `${line.content}\n`;
                    });
                }
            });
        } else if (activeDoc.pdfTextData) {
            // Use PDF text data if available
            activeDoc.pdfTextData.forEach((page, idx) => {
                context += `\nPage ${page.page_number || idx + 1}:\n`;
                if (page.layout?.lines) {
                    page.layout.lines.forEach(line => {
                        context += `${line.content}\n`;
                    });
                }
            });
        }

        return context;
    };

    const handleSend = async () => {
        if (!input.trim() || isLoading) return;

        const userMessage = input.trim();
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
        setIsLoading(true);

        try {
            const context = formatContext();

            // Use environment variable for API URL
            // Development: http://127.0.0.1:8000
            // Production: Cloud Run backend URL (set in .env.production)
            const API_URL = `${import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'}/api/v1/chat/`;


            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: userMessage,
                    context: context,
                    filename: activeDoc?.name // Optional, for logging or fallback
                }),
            });

            if (!response.ok) {
                throw new Error('Network response was not ok');
            }

            const data = await response.json();
            setMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
        } catch (error) {
            console.error('Chat error:', error);
            setMessages(prev => [...prev, { role: 'assistant', content: '죄송합니다. 오류가 발생했습니다. 다시 시도해주세요.', isError: true }]);
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

    return (
        <div className="flex flex-col h-full bg-white">
            {/* Chat Header */}
            <div className="p-4 border-b border-[#e5e1d8] bg-[#fcfaf7] flex items-center gap-2">
                <div className="bg-[#fff0eb] p-1.5 rounded-lg">
                    <Sparkles size={18} className="text-[#d97757]" />
                </div>
                <div>
                    <h3 className="font-bold text-[#333333] text-sm">AI Assistant</h3>
                    <p className="text-[10px] text-[#888888]">Ask about the drawing</p>
                </div>
            </div>

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[#f9f8f6]">
                {messages.map((msg, idx) => (
                    <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === 'user' ? 'bg-[#333333]' : 'bg-[#d97757]'}`}>
                            {msg.role === 'user' ? <User size={14} className="text-white" /> : <Bot size={14} className="text-white" />}
                        </div>
                        <div className={`max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed shadow-sm ${msg.role === 'user'
                            ? 'bg-[#333333] text-white rounded-tr-none'
                            : msg.isError
                                ? 'bg-red-50 text-red-600 border border-red-100 rounded-tl-none'
                                : 'bg-white text-[#333333] border border-[#e5e1d8] rounded-tl-none'
                            }`}>
                            {msg.content}
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
            </div>

            {/* Input Area */}
            <div className="p-4 bg-white border-t border-[#e5e1d8]">
                <div className="relative">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Ask a question..."
                        className="w-full bg-[#f4f1ea] border border-[#e5e1d8] rounded-xl py-3 pl-4 pr-12 text-sm focus:outline-none focus:border-[#d97757] focus:ring-1 focus:ring-[#d97757] transition-all resize-none h-[50px] max-h-[120px] overflow-y-auto placeholder-[#a0a0a0]"
                        disabled={!activeDoc || isLoading}
                    />
                    <button
                        onClick={handleSend}
                        disabled={!input.trim() || isLoading || !activeDoc}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-[#d97757] text-white rounded-lg hover:bg-[#c05535] disabled:opacity-50 disabled:hover:bg-[#d97757] transition-colors"
                    >
                        <Send size={14} />
                    </button>
                </div>
                {!activeDoc && (
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
