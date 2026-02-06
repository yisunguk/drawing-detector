import React, { useState, useEffect } from 'react';
import { X, Mail, MessageSquare, Clock, User, CheckCircle2, Circle, Reply, Trash2, Loader2, Send, Plus } from 'lucide-react';
import { db } from '../firebase';
import { collection, query, where, orderBy, getDocs, doc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import MessageModal from './MessageModal';

const InboxModal = ({ isOpen, onClose }) => {
    const { currentUser } = useAuth();
    const [activeTab, setActiveTab] = useState('received'); // 'received' or 'sent'
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(false);
    const [selectedMessage, setSelectedMessage] = useState(null);
    const [replyModalOpen, setReplyModalOpen] = useState(false);
    const [composeModalOpen, setComposeModalOpen] = useState(false);

    useEffect(() => {
        if (isOpen && currentUser) {
            fetchMessages();
        } else {
            setMessages([]);
            setSelectedMessage(null);
        }
    }, [isOpen, currentUser, activeTab]);

    const fetchMessages = async () => {
        setLoading(true);
        try {
            const q = query(
                collection(db, 'messages'),
                where(activeTab === 'received' ? 'receiverId' : 'senderId', '==', currentUser.uid)
                // Removed orderBy to avoid index requirement for now
            );
            const snapshot = await getDocs(q);
            const msgList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            // Client-side sorting
            msgList.sort((a, b) => {
                const timeA = a.timestamp?.seconds || 0;
                const timeB = b.timestamp?.seconds || 0;
                return timeB - timeA;
            });

            setMessages(msgList);
        } catch (error) {
            console.error("Error fetching messages:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleMessageSelect = async (msg) => {
        setSelectedMessage(msg);

        // Mark as read if unread and it's a received message
        if (activeTab === 'received' && !msg.read) {
            try {
                await updateDoc(doc(db, 'messages', msg.id), { read: true });
                setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, read: true } : m));
            } catch (error) {
                console.error("Error marking read:", error);
            }
        }
    };

    const handleDelete = async (e, msgId) => {
        e.stopPropagation();
        if (!confirm("이 메시지를 삭제하시겠습니까?")) return;

        try {
            await deleteDoc(doc(db, 'messages', msgId));
            setMessages(prev => prev.filter(m => m.id !== msgId));
            if (selectedMessage?.id === msgId) setSelectedMessage(null);
        } catch (error) {
            console.error("Error deleting message:", error);
        }
    };

    const handleReplySuccess = () => {
        setReplyModalOpen(false);
        alert("답장이 전송되었습니다.");
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 z-[105] flex items-center justify-center p-4 backdrop-blur-sm">
            <div
                className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl h-[600px] flex overflow-hidden animate-in fade-in zoom-in duration-200 border border-[#e5e1d8]"
                onClick={e => e.stopPropagation()}
            >
                {/* Left Sidebar: Message List */}
                <div className="w-1/3 border-r border-[#e5e1d8] bg-[#fcfaf7] flex flex-col">
                    <div className="p-4 border-b border-[#e5e1d8] flex flex-col gap-3 bg-white sticky top-0 z-10 shrink-0">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 font-bold text-[#333333]">
                                <Mail size={18} className="text-[#d97757]" />
                                메시지함
                            </div>
                            <button
                                onClick={() => setComposeModalOpen(true)}
                                className="p-1.5 bg-[#d97757] hover:bg-[#c05535] text-white rounded-lg transition-colors shadow-sm flex items-center gap-1.5 text-xs font-bold px-2"
                                title="새 메시지 쓰기"
                            >
                                <Plus size={14} /> 작성
                            </button>
                        </div>

                        {/* Tabs */}
                        <div className="flex p-1 bg-[#f4f1ea] rounded-lg">
                            <button
                                onClick={() => setActiveTab('received')}
                                className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${activeTab === 'received' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#888888] hover:text-[#555555]'}`}
                            >
                                받은 편지함
                                {messages.filter(m => !m.read && activeTab === 'received').length > 0 && (
                                    <span className="ml-1 text-[9px] bg-[#d97757] text-white px-1.5 py-0 rounded-full">
                                        {messages.filter(m => !m.read && activeTab === 'received').length}
                                    </span>
                                )}
                            </button>
                            <button
                                onClick={() => setActiveTab('sent')}
                                className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${activeTab === 'sent' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#888888] hover:text-[#555555]'}`}
                            >
                                보낸 편지함
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto thin-scrollbar p-2 space-y-2">
                        {loading ? (
                            <div className="flex flex-col items-center justify-center h-40 text-[#888888] gap-2">
                                <Loader2 size={24} className="animate-spin text-[#d97757]" />
                                <span className="text-xs">메시지 로딩 중...</span>
                            </div>
                        ) : messages.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-40 text-[#a0a0a0] gap-2">
                                <MessageSquare size={32} className="opacity-20" />
                                <span className="text-xs">{activeTab === 'received' ? '받은 메시지가 없습니다.' : '보낸 메시지가 없습니다.'}</span>
                            </div>
                        ) : (
                            messages.map(msg => (
                                <div
                                    key={msg.id}
                                    onClick={() => handleMessageSelect(msg)}
                                    className={`p-3 rounded-xl cursor-pointer transition-all border ${selectedMessage?.id === msg.id
                                        ? 'bg-white border-[#d97757] shadow-md transform scale-[1.02]'
                                        : activeTab === 'received' && msg.read === false
                                            ? 'bg-white border-[#e5e1d8] border-l-4 border-l-[#d97757] shadow-sm'
                                            : 'bg-transparent border-transparent hover:bg-white hover:border-[#e5e1d8]'
                                        }`}
                                >
                                    <div className="flex justify-between items-start mb-1">
                                        <span className={`text-sm ${activeTab === 'received' && !msg.read ? 'font-bold text-[#333]' : 'font-medium text-[#555]'}`}>
                                            {activeTab === 'received' ? msg.senderName : `To: ${msg.receiverName || 'Unknown'}`}
                                        </span>
                                        <span className="text-[10px] text-[#888888] whitespace-nowrap">
                                            {msg.timestamp?.seconds ? new Date(msg.timestamp.seconds * 1000).toLocaleDateString() : 'Just now'}
                                        </span>
                                    </div>
                                    <p className={`text-xs line-clamp-2 ${activeTab === 'received' && !msg.read ? 'text-[#333]' : 'text-[#666]'}`}>
                                        {msg.content}
                                    </p>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Right Content: Message Detail */}
                <div className="flex-1 flex flex-col bg-white relative">
                    <button
                        onClick={onClose}
                        className="absolute top-4 right-4 p-2 hover:bg-gray-100 rounded-full text-gray-400 hover:text-gray-600 transition-colors z-20"
                    >
                        <X size={20} />
                    </button>

                    {selectedMessage ? (
                        <div className="flex-1 flex flex-col h-full">
                            {/* Header */}
                            <div className="p-6 border-b border-[#f0ede6] pr-12">
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="w-10 h-10 rounded-full bg-[#d97757] flex items-center justify-center text-white font-bold text-lg shadow-sm">
                                        {selectedMessage.senderName[0]}
                                    </div>
                                    <div>
                                        <h3 className="font-bold text-lg text-[#333333] flex items-center gap-2">
                                            {selectedMessage.senderName}
                                            <span className="text-xs font-normal text-[#888888] bg-[#f5f5f5] px-2 py-0.5 rounded-full">
                                                {selectedMessage.senderEmail}
                                            </span>
                                        </h3>
                                        <div className="flex items-center gap-2 text-xs text-[#888888] mt-1">
                                            <Clock size={12} />
                                            {selectedMessage.timestamp?.seconds
                                                ? new Date(selectedMessage.timestamp.seconds * 1000).toLocaleString()
                                                : 'Just now'}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Content */}
                            <div className="flex-1 p-6 overflow-y-auto">
                                {/* Shared Context Bubble */}
                                {selectedMessage.shareData && (
                                    <div className="mb-6 bg-[#fff8f0] border border-[#f5d0b5] rounded-xl p-4 relative group">
                                        <div className="absolute -left-1 top-6 w-2 h-8 bg-[#d97757] rounded-r-lg" />
                                        <h4 className="text-xs font-bold text-[#d97757] uppercase tracking-wider mb-2 flex items-center gap-1">
                                            <MessageSquare size={12} /> 공유된 컨텍스트
                                        </h4>
                                        <p className="text-sm font-bold text-[#333] mb-1">"{selectedMessage.shareData.query}"</p>
                                        <p className="text-xs text-[#666] bg-white/50 p-2 rounded-lg border border-white/50">
                                            {selectedMessage.shareData.response}
                                        </p>
                                    </div>
                                )}

                                <div className="whitespace-pre-wrap text-[#333333] leading-relaxed text-sm">
                                    {selectedMessage.content}
                                </div>

                                {/* Attachments Display */}
                                {selectedMessage.attachments && selectedMessage.attachments.length > 0 && (
                                    <div className="flex gap-2 mt-4 overflow-x-auto">
                                        {selectedMessage.attachments.map((att, idx) => (
                                            <a key={idx} href={att.url} target="_blank" rel="noopener noreferrer" className="block border border-[#e5e1d8] rounded-lg overflow-hidden shrink-0 hover:border-[#d97757] transition-colors">
                                                <img src={att.url} alt="attachment" className="w-32 h-32 object-cover" />
                                            </a>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Actions */}
                            <div className="p-4 border-t border-[#f0ede6] flex justify-between items-center bg-[#fcfaf7]">
                                <button
                                    onClick={(e) => handleDelete(e, selectedMessage.id)}
                                    className="px-4 py-2 text-red-500 hover:bg-red-50 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                                >
                                    <Trash2 size={16} /> 삭제
                                </button>
                                <button
                                    onClick={() => setReplyModalOpen(true)}
                                    className="px-6 py-2 bg-[#d97757] hover:bg-[#c05535] text-white rounded-lg text-sm font-bold shadow-md shadow-[#d97757]/20 flex items-center gap-2 transition-all"
                                >
                                    <Reply size={16} /> 답장하기
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-[#dcd8d0]">
                            <Mail size={64} className="mb-4 opacity-50" />
                            <p className="text-sm font-medium text-[#888888]">왼쪽 목록에서 메시지를 선택하세요</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Reply Modal */}
            {replyModalOpen && selectedMessage && (
                <MessageModal
                    isOpen={replyModalOpen}
                    onClose={() => setReplyModalOpen(false)}
                    initialRecipientId={selectedMessage.senderId}
                    senderName={currentUser.displayName}
                />
            )}

            {/* Compose Modal */}
            {composeModalOpen && (
                <MessageModal
                    isOpen={composeModalOpen}
                    onClose={() => setComposeModalOpen(false)}
                    senderName={currentUser.displayName}
                />
            )}
        </div>
    );
};

export default InboxModal;
