import React, { useState, useEffect, useMemo } from 'react';
import { X, User, Send, Loader2, MessageSquare, AlertCircle, Search, CheckCircle2, Circle } from 'lucide-react';
import { db } from '../firebase';
import { collection, query, getDocs, addDoc, serverTimestamp, writeBatch, doc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';

const MessageModal = ({ isOpen, onClose, shareData = null, initialRecipientId = null, senderName = null }) => {
    const { currentUser } = useAuth();
    const [users, setUsers] = useState([]);
    const [selectedUserIds, setSelectedUserIds] = useState([]);
    const [userSearch, setUserSearch] = useState('');
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);
    const [fetchingUsers, setFetchingUsers] = useState(false);
    const [status, setStatus] = useState('idle'); // idle, sending, success, error
    const [sendProgress, setSendProgress] = useState({ current: 0, total: 0 });

    useEffect(() => {
        if (isOpen) {
            fetchUsers();
            if (initialRecipientId) {
                setSelectedUserIds([initialRecipientId]);
            } else {
                setSelectedUserIds([]);
            }
            setStatus('idle');
            setMessage('');
            setUserSearch('');
        }
    }, [isOpen, initialRecipientId]);

    const fetchUsers = async () => {
        setFetchingUsers(true);
        try {
            const q = query(collection(db, 'users'));
            const snapshot = await getDocs(q);
            const userList = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(u => u.id !== currentUser?.uid)
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            setUsers(userList);
        } catch (error) {
            console.error("Error fetching users:", error);
        } finally {
            setFetchingUsers(false);
        }
    };

    const filteredUsers = useMemo(() => {
        const search = userSearch.toLowerCase().trim();
        if (!search) return users;
        return users.filter(u =>
            (u.name || '').toLowerCase().includes(search) ||
            (u.email || '').toLowerCase().includes(search)
        );
    }, [users, userSearch]);

    const toggleUser = (userId) => {
        if (initialRecipientId) return; // Prevent changing if it's a direct reply/share to specific
        setSelectedUserIds(prev =>
            prev.includes(userId)
                ? prev.filter(id => id !== userId)
                : [...prev, userId]
        );
    };

    const toggleSelectAll = () => {
        if (selectedUserIds.length === filteredUsers.length) {
            setSelectedUserIds([]);
        } else {
            setSelectedUserIds(filteredUsers.map(u => u.id));
        }
    };

    const handleSend = async (e) => {
        e.preventDefault();
        if (selectedUserIds.length === 0 || (!message.trim() && !shareData) || loading) return;

        setLoading(true);
        setStatus('sending');
        setSendProgress({ current: 0, total: selectedUserIds.length });

        try {
            const batch = writeBatch(db);
            const finalSenderName = senderName || currentUser.displayName || 'User';

            // Iterate and send to each recipient
            let count = 0;
            for (const recipientId of selectedUserIds) {
                const recipient = users.find(u => u.id === recipientId);

                await addDoc(collection(db, 'messages'), {
                    senderId: currentUser.uid,
                    senderEmail: currentUser.email,
                    senderName: finalSenderName,
                    receiverId: recipientId,
                    receiverEmail: recipient?.email || '',
                    receiverName: recipient?.name || 'User',
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

                count++;
                setSendProgress({ current: count, total: selectedUserIds.length });
                if (count % 5 === 0) await new Promise(r => setTimeout(r, 0)); // Yield
            }

            setStatus('success');
            setMessage('');
            setTimeout(() => {
                setStatus('idle');
                onClose();
            }, 2000);
        } catch (error) {
            console.error("Error sending messages:", error);
            setStatus('error');
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4 backdrop-blur-sm">
            <div
                className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden animate-in fade-in zoom-in duration-200 border border-[#e5e1d8]"
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
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-sm font-bold text-[#333333] flex items-center gap-1.5">
                                <User size={14} className="text-[#d97757]" />
                                받는 사람 ({selectedUserIds.length}명 선택됨)
                            </label>
                            {!initialRecipientId && filteredUsers.length > 0 && (
                                <button
                                    type="button"
                                    onClick={toggleSelectAll}
                                    className="text-[10px] font-bold text-[#d97757] hover:underline"
                                >
                                    {selectedUserIds.length === filteredUsers.length ? '전체 해제' : '전체 선택'}
                                </button>
                            )}
                        </div>

                        {!initialRecipientId ? (
                            <div className="space-y-2">
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a0a0a0]" size={14} />
                                    <input
                                        type="text"
                                        placeholder="이름 또는 이메일 검색..."
                                        value={userSearch}
                                        onChange={(e) => setUserSearch(e.target.value)}
                                        className="w-full pl-9 pr-4 py-2 bg-[#f9f8f6] border border-[#dcd8d0] rounded-lg text-xs focus:ring-2 focus:ring-[#d97757]/20 focus:border-[#d97757] outline-none transition-all"
                                    />
                                </div>
                                <div className="border border-[#e5e1d8] rounded-xl max-h-40 overflow-y-auto bg-white thin-scrollbar">
                                    {fetchingUsers ? (
                                        <div className="p-4 text-center text-[10px] text-[#888888] flex items-center justify-center gap-2">
                                            <Loader2 size={12} className="animate-spin" /> 사용자 로딩 중...
                                        </div>
                                    ) : filteredUsers.length === 0 ? (
                                        <div className="p-4 text-center text-[10px] text-[#a0a0a0]">검색 결과가 없습니다.</div>
                                    ) : (
                                        <div className="divide-y divide-[#f0ede6]">
                                            {filteredUsers.map(u => {
                                                const isSelected = selectedUserIds.includes(u.id);
                                                return (
                                                    <div
                                                        key={u.id}
                                                        onClick={() => toggleUser(u.id)}
                                                        className={`flex items-center gap-3 p-2.5 cursor-pointer hover:bg-[#fff8f0] transition-colors ${isSelected ? 'bg-[#fffcfb]' : ''}`}
                                                    >
                                                        {isSelected ? (
                                                            <CheckCircle2 size={16} className="text-[#d97757]" />
                                                        ) : (
                                                            <Circle size={16} className="text-[#dcd8d0]" />
                                                        )}
                                                        <div className="flex flex-col min-w-0">
                                                            <span className={`text-xs font-bold ${isSelected ? 'text-[#d97757]' : 'text-[#333333]'}`}>{u.name || 'User'}</span>
                                                            <span className="text-[10px] text-[#888888] truncate">{u.email}</span>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="px-4 py-3 bg-[#fcfaf7] border border-[#e5e1d8] rounded-xl flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-[#d97757] flex items-center justify-center text-white text-xs font-bold shrink-0">
                                    {(users.find(u => u.id === initialRecipientId)?.name || 'U')[0]}
                                </div>
                                <div className="flex flex-col min-w-0">
                                    <span className="text-xs font-bold text-[#333333]">
                                        {users.find(u => u.id === initialRecipientId)?.name || 'Loading...'}
                                    </span>
                                    <span className="text-[10px] text-[#888888] truncate">
                                        {users.find(u => u.id === initialRecipientId)?.email || ''}
                                    </span>
                                </div>
                                <div className="ml-auto">
                                    <CheckCircle2 size={16} className="text-[#d97757]" />
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Shared Content Preview */}
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
                        <label className="block text-sm font-bold text-[#333333] mb-2 flex items-center gap-1.5">
                            <MessageSquare size={14} className="text-[#d97757]" />
                            메세지 내용
                        </label>
                        <textarea
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder="전달하실 말씀을 입력해주세요..."
                            className="w-full h-32 px-4 py-3 bg-white border border-[#dcd8d0] rounded-xl text-sm focus:ring-2 focus:ring-[#d97757]/20 focus:border-[#d97757] outline-none transition-all resize-none placeholder:text-[#a0a0a0] shadow-inner"
                            required={!shareData}
                        />
                    </div>

                    {/* Status Messages */}
                    {status === 'sending' && selectedUserIds.length > 1 && (
                        <div className="p-3 bg-blue-50 text-blue-700 text-xs rounded-lg border border-blue-100 space-y-2">
                            <div className="flex items-center justify-between font-bold">
                                <span>전송 중...</span>
                                <span>{sendProgress.current} / {sendProgress.total}</span>
                            </div>
                            <div className="w-full h-1 bg-blue-100 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-blue-500 transition-all duration-300"
                                    style={{ width: `${(sendProgress.current / sendProgress.total) * 100}%` }}
                                />
                            </div>
                        </div>
                    )}

                    {status === 'success' && (
                        <div className="p-3 bg-green-50 text-green-700 text-xs rounded-lg border border-green-100 flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                            <div className="bg-green-100 p-1 rounded-full text-green-600">
                                <Send size={12} />
                            </div>
                            메시지가 성공적으로 전송되었습니다!
                        </div>
                    )}
                    {status === 'error' && (
                        <div className="p-3 bg-red-50 text-red-700 text-xs rounded-lg border border-red-100 flex items-center gap-2 font-bold">
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
                            disabled={selectedUserIds.length === 0 || (!message.trim() && !shareData) || loading || status === 'success'}
                            className="flex-[2] px-8 py-2.5 bg-[#d97757] hover:bg-[#c05535] text-white rounded-xl text-sm font-bold shadow-lg shadow-[#d97757]/20 transition-all disabled:opacity-50 disabled:shadow-none flex items-center justify-center gap-2"
                        >
                            {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                            {selectedUserIds.length > 1 ? `${selectedUserIds.length}명에게 보내기` : '보내기'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default MessageModal;
