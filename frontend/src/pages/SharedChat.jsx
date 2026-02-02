import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useParams, Link } from 'react-router-dom';
import { db } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { Loader2, MessageSquare, AlertCircle, FileText, Calendar, User } from 'lucide-react';

const SharedChat = () => {
    const { shareId } = useParams();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const fetchSharedChat = async () => {
            try {
                if (!shareId) return;

                const docRef = doc(db, 'shared_chats', shareId);
                const docSnap = await getDoc(docRef);

                if (docSnap.exists()) {
                    setData({ id: docSnap.id, ...docSnap.data() });
                } else {
                    setError("Shared content not found or has been deleted.");
                }
            } catch (err) {
                console.error("Error fetching shared chat:", err);
                setError("Failed to load shared content. Please try again later.");
            } finally {
                setLoading(false);
            }
        };

        fetchSharedChat();
    }, [shareId]);

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#fcfaf7]">
                <Loader2 className="animate-spin text-[#d97757]" size={32} />
            </div>
        );
    }

    if (error) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-[#fcfaf7] p-4 text-center">
                <AlertCircle size={48} className="text-red-400 mb-4" />
                <h2 className="text-xl font-bold text-[#333333] mb-2">Error</h2>
                <p className="text-[#666666] mb-6">{error}</p>
                <Link to="/" className="px-4 py-2 bg-[#d97757] text-white rounded-lg hover:bg-[#c05535] transition-colors">
                    Go to Home
                </Link>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#fcfaf7] flex flex-col">
            {/* Header */}
            <div className="bg-white border-b border-[#e5e1d8] px-6 py-4 sticky top-0 z-10 shadow-sm flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[#fff0eb] flex items-center justify-center text-[#d97757]">
                        <MessageSquare size={18} />
                    </div>
                    <div>
                        <h1 className="text-sm font-bold text-[#333333]">Shared Conversation</h1>
                        <p className="text-[10px] text-[#888888]">Read-only view</p>
                    </div>
                </div>
                <Link to="/" className="text-xs font-medium text-[#d97757] hover:underline">
                    Drawings Analyzer AI
                </Link>
            </div>

            {/* Content */}
            <div className="flex-1 max-w-3xl w-full mx-auto p-4 md:p-8">
                <div className="bg-white rounded-xl shadow-sm border border-[#e5e1d8] overflow-hidden">
                    {/* Meta Info */}
                    <div className="bg-[#f9f8f6] px-6 py-4 border-b border-[#e5e1d8] flex flex-wrap gap-4 items-center">
                        <div className="flex items-center gap-1.5 text-xs text-[#666666]">
                            <User size={14} className="text-[#a0a0a0]" />
                            <span>Shared by <b>{data.originalUser}</b></span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-[#666666]">
                            <Calendar size={14} className="text-[#a0a0a0]" />
                            <span>{data.createdAt?.toDate ? data.createdAt.toDate().toLocaleDateString() : 'Unknown Date'}</span>
                        </div>
                        {data.filename && (
                            <div className="flex items-center gap-1.5 text-xs text-[#666666] bg-[#e5e1d8] px-2 py-0.5 rounded-full">
                                <FileText size={12} />
                                <span className="truncate max-w-[200px]">{data.filename}</span>
                            </div>
                        )}
                    </div>

                    {/* Q&A */}
                    <div className="p-6 md:p-8 space-y-8">
                        {/* Question */}
                        <div>
                            <h3 className="text-xs font-bold text-[#888888] uppercase tracking-wider mb-2">Question</h3>
                            <div className="text-lg font-medium text-[#333333] leading-relaxed">
                                {data.query}
                            </div>
                        </div>

                        {/* Divider */}
                        <div className="h-px bg-[#e5e1d8]"></div>

                        {/* Answer */}
                        <div>
                            <h3 className="text-xs font-bold text-[#d97757] uppercase tracking-wider mb-3 flex items-center gap-2">
                                AI Response
                            </h3>
                            <div className="prose prose-sm md:prose-base max-w-none text-[#333333] leading-relaxed bg-[#fffbf7] p-6 rounded-lg border border-[#f5efe6]">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        table: ({ node, ...props }) => <div className="overflow-x-auto my-2"><table className="border-collapse border border-gray-300 w-full text-xs" {...props} /></div>,
                                        thead: ({ node, ...props }) => <thead className="bg-gray-100" {...props} />,
                                        th: ({ node, ...props }) => <th className="border border-gray-300 px-3 py-2 font-semibold text-left" {...props} />,
                                        td: ({ node, ...props }) => <td className="border border-gray-300 px-3 py-2" {...props} />,
                                        ul: ({ node, ...props }) => <ul className="list-disc pl-4 my-2 space-y-1" {...props} />,
                                        ol: ({ node, ...props }) => <ol className="list-decimal pl-4 my-2 space-y-1" {...props} />,
                                    }}
                                >
                                    {data.response.replace(/\[\[(.*?)\]\]/g, ' **📄 $1** ')}
                                </ReactMarkdown>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="mt-8 text-center">
                    <p className="text-xs text-[#888888] mb-4">
                        This is a shared conversation from <b>Drawings Analyzer AI</b>.
                    </p>
                    <Link to="/" className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#333333] text-white rounded-lg hover:bg-black transition-colors text-sm font-medium">
                        Try Drawings Analyzer AI
                    </Link>
                </div>
            </div>
        </div>
    );
};

export default SharedChat;
