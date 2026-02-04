import React, { useState, useEffect } from 'react';
import { X, User, Send, Loader2, MessageSquare, AlertCircle } from 'lucide-react';
import { db } from '../firebase';
import { collection, query, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';

const MessageModal = ({ isOpen, onClose, shareData = null, initialRecipientId = null }) => {
    const { currentUser } = useAuth();
    const [users, setUsers] = useState([]);
    const [selectedUserId, setSelectedUserId] = useState(initialRecipientId || '');
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);
    const [fetchingUsers, setFetchingUsers] = useState(false);
    const [status, setStatus] = useState('idle'); // idle, sending, success, error

    useEffect(() => {
        if (isOpen) {
            fetchUsers();
        }
    }, [isOpen]);

    const fetchUsers = async () => {
        setFetchingUsers(true);
        try {
            const q = query(collection(db, 'users'));
            const snapshot = await getDocs(q);
            const userList = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(u => u.id !== currentUser?.uid);
            setUsers(userList);
        } catch (error) {
            console.error("Error fetching users:", error);
        } finally {
            setFetchingUsers(false);
        }
    };

    const handleSend = async (e) => {
        e.preventDefault();
        if (!selectedUserId || (!message.trim() && !shareData) || loading) return;

        setLoading(true);
        setStatus('sending');
        try {
            const selectedUser = users.find(u => u.id === selectedUserId);

            await addDoc(collection(db, 'messages'), {
                senderId: currentUser.uid,
                senderEmail: currentUser.email,
                senderName: currentUser.displayName || 'User',
                receiverId: selectedUserId,
                receiverEmail: selectedUser?.email || '',
                receiverName: selectedUser?.name || 'User',
                content: message.trim(),
                shareData: shareData ? {
                    query: shareData.query,
                    response: shareData.response,
                    filename: shareData.filename || null,
                    docId: shareData.docId || null
                } : null,
                timestamp: serverTimestamp(),
                read: false
            });

            setStatus('success');
            setMessage('');
            setTimeout(() => {
                setStatus('idle');
                onClose();
            }, 2000);
        } catch (error) {
            console.error("Error sending message:", error);
            setStatus('error');
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4">
            <div
                className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden animate-in fade-in zoom-in duration-200"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="p-4 border-b border-[#e5e1d8] bg-[#fcfaf7] flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div className="bg-[#fff0eb] p-2 rounded-lg text-[#d97757]">
                            <MessageSquare size={18} />
                        </div>
                        <div>
                            <h3 className="font-bold text-[#333333]">메세지 보내기</h3>
                            <p className="text-[10px] text-[#888888]">동료와 도면 검토 내용을 공유하세요</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-gray-100 rounded-full text-gray-400 hover:text-gray-600 transition-colors"
                    >
                        <X size={20} />
                    </button>
                </div>

                <form onSubmit={handleSend} className="p-6 space-y-5">
                    {/* Recipient Selection */}
                    <div>
                        <label className="block text-sm font-medium text-[#333333] mb-2 flex items-center gap-1.5">
                            <User size={14} className="text-[#a0a0a0]" />
                            받는 사람
                        </label>
                        <select
                            value={selectedUserId}
                            onChange={(e) => setSelectedUserId(e.target.value)}
                            required
                            className="w-full px-4 py-2.5 bg-white border border-[#dcd8d0] rounded-xl text-sm focus:ring-2 focus:ring-[#d97757]/20 focus:border-[#d97757] outline-none transition-all disabled:bg-gray-50"
                            disabled={fetchingUsers || loading || !!initialRecipientId}
                        >
                            <option value="">수신인 선택...</option>
                            {users.map(u => (
                                <option key={u.id} value={u.id}>
                                    {u.name} ({u.email})
                                </option>
                            ))}
                        </select>
                        {fetchingUsers && (
                            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[#888888]">
                                <Loader2 size={10} className="animate-spin" />
                                사용자 목록을 불러오는 중...
                            </div>
                        )}
                    </div>

                    {/* Shared Content Preview if available */}
                    {shareData && (
                        <div className="bg-[#fcfaf7] border border-[#e5e1d8] rounded-xl p-3">
                            <h4 className="text-[10px] font-bold text-[#d97757] uppercase tracking-wider mb-2 flex items-center gap-1">
                                <AlertCircle size={10} /> 공유되는 내용
                            </h4>
                            <div className="space-y-1.5">
                                <p className="text-xs font-bold text-[#333333] line-clamp-1 italic">"{shareData.query}"</p>
                                <p className="text-[10px] text-[#666666] line-clamp-2">{shareData.response.substring(0, 100)}...</p>
                            </div>
                        </div>
                    )}

                    {/* Message Content */}
                    <div>
                        <label className="block text-sm font-medium text-[#333333] mb-2 flex items-center gap-1.5">
                            <MessageSquare size={14} className="text-[#a0a0a0]" />
                            내용
                        </label>
                        <textarea
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder="전달하실 말씀을 입력해주세요..."
                            className="w-full h-32 px-4 py-3 bg-white border border-[#dcd8d0] rounded-xl text-sm focus:ring-2 focus:ring-[#d97757]/20 focus:border-[#d97757] outline-none transition-all resize-none placeholder:text-[#a0a0a0]"
                            required={!shareData}
                        />
                    </div>

                    {/* Status Messages */}
                    {status === 'success' && (
                        <div className="p-3 bg-green-50 text-green-700 text-xs rounded-lg border border-green-100 flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                            <div className="bg-green-100 p-1 rounded-full">
                                <Send size={12} />
                            </div>
                            메시지가 성공적으로 전송되었습니다!
                        </div>
                    )}
                    {status === 'error' && (
                        <div className="p-3 bg-red-50 text-red-700 text-xs rounded-lg border border-red-100 flex items-center gap-2">
                            <AlertCircle size={14} />
                            오류가 발생했습니다. 다시 시도해 주세요.
                        </div>
                    )}

                    {/* Footer / Buttons */}
                    <div className="flex gap-3 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 px-4 py-2.5 border border-[#dcd8d0] text-[#666666] rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
                        >
                            취소
                        </button>
                        <button
                            type="submit"
                            disabled={!selectedUserId || (!message.trim() && !shareData) || loading || status === 'success'}
                            className="flex-3 px-8 py-2.5 bg-[#d97757] hover:bg-[#c05535] text-white rounded-xl text-sm font-bold shadow-lg shadow-[#d97757]/20 transition-all disabled:opacity-50 disabled:shadow-none flex items-center justify-center gap-2"
                        >
                            {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                            보내기
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default MessageModal;
