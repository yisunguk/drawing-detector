
import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { db, storage } from '../firebase';
import { doc, getDoc, updateDoc, collection, query, orderBy, getDocs, addDoc, serverTimestamp, where, writeBatch, onSnapshot } from 'firebase/firestore';
import { ref, uploadString, getDownloadURL } from 'firebase/storage';
import MessageModal from '../components/MessageModal';
import { updateProfile, updatePassword } from 'firebase/auth';
import { ArrowLeft, User, History, Save, Building, Mail, Loader2, MessageSquare, Lock, ChevronDown, ChevronUp, FileText, ChevronLeft, ChevronRight, Share2, Check, Send, X, List, Users } from 'lucide-react';
import html2canvas from 'html2canvas';
import { logActivity } from '../services/logging';

const UserProfile = () => {
    const { currentUser } = useAuth();
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState('history');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [expandedChatId, setExpandedChatId] = useState(null);
    const [sharingId, setSharingId] = useState(null);
    const [messages, setMessages] = useState([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [isMessageModalOpen, setIsMessageModalOpen] = useState(false);
    const [replyRecipientId, setReplyRecipientId] = useState(null);
    const [expandedMessageId, setExpandedMessageId] = useState(null);

    // Profile State
    const [profileData, setProfileData] = useState({
        name: '',
        company: '',
        email: ''
    });

    const [passwordData, setPasswordData] = useState({
        newPassword: '',
        confirmPassword: ''
    });

    // History State
    const [chatHistory, setChatHistory] = useState([]);
    const [currentPage, setCurrentPage] = useState(1);
    const itemsPerPage = 10;



    const [feedbackContent, setFeedbackContent] = useState('');
    const [feedbackAttachments, setFeedbackAttachments] = useState([]);
    const [feedbackStatus, setFeedbackStatus] = useState('idle');
    const [adminFeedbacks, setAdminFeedbacks] = useState([]);
    const [selectedFeedback, setSelectedFeedback] = useState(null); // For Admin Modal
    const [activityLogs, setActivityLogs] = useState([]); // For Admin Logs Tab

    // Fetch Admin Feedback
    useEffect(() => {
        if (activeTab === 'admin-feedback' && currentUser?.email === 'admin@poscoenc.com') {
            const fetchFeedback = async () => {
                try {
                    const q = query(collection(db, 'feedback'), orderBy('timestamp', 'desc'));
                    const snapshot = await getDocs(q);
                    setAdminFeedbacks(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
                } catch (error) {
                    console.error("Error fetching feedback:", error);
                }
            };
            fetchFeedback();
        }
    }, [activeTab, currentUser]);

    // Fetch Admin Logs
    useEffect(() => {
        if (activeTab === 'admin-logs' && currentUser?.email === 'admin@poscoenc.com') {
            const fetchLogs = async () => {
                try {
                    const q = query(collection(db, 'activity_logs'), orderBy('timestamp', 'desc'));
                    const snapshot = await getDocs(q);
                    setActivityLogs(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
                } catch (error) {
                    console.error("Error fetching logs:", error);
                }
            };
            fetchLogs();
        }
    }, [activeTab, currentUser]);

    const [messageView, setMessageView] = useState('inbox'); // 'inbox' or 'outbox'

    // Fetch Messages
    useEffect(() => {
        if (!currentUser) return;

        const q = query(
            collection(db, 'messages'),
            where(messageView === 'inbox' ? 'receiverId' : 'senderId', '==', currentUser.uid)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            let msgList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            // Sort in memory to avoid complex index requirements which might be failing
            msgList.sort((a, b) => {
                const timeA = a.timestamp?.toMillis ? a.timestamp.toMillis() : 0;
                const timeB = b.timestamp?.toMillis ? b.timestamp.toMillis() : 0;
                return timeB - timeA;
            });

            setMessages(msgList);
            if (messageView === 'inbox') {
                setUnreadCount(msgList.filter(m => !m.read).length);
            }
        }, (error) => {
            console.error(`Error fetching ${messageView} messages:`, error);
        });

        return () => unsubscribe();
    }, [currentUser, messageView]);

    const markAsRead = async (messageId) => {
        try {
            const msgRef = doc(db, 'messages', messageId);
            await updateDoc(msgRef, { read: true });
            setMessages(prev => prev.map(m => m.id === messageId ? { ...m, read: true } : m));
            setUnreadCount(prev => Math.max(0, prev - 1));
        } catch (error) {
            console.error("Error marking message as read:", error);
        }
    };

    const markAllAsRead = async () => {
        const unreadIds = messages.filter(m => !m.read).map(m => m.id);
        if (unreadIds.length === 0) return;

        try {
            const batch = writeBatch(db);
            unreadIds.forEach(id => {
                batch.update(doc(db, 'messages', id), { read: true });
            });
            await batch.commit();
            setMessages(prev => prev.map(m => ({ ...m, read: true })));
            setUnreadCount(0);
        } catch (error) {
            console.error("Error marking all as read:", error);
        }
    };

    const handleReply = (senderId) => {
        setReplyRecipientId(senderId);
        setIsMessageModalOpen(true);
    };

    const handlePaste = (e) => {
        const items = e.clipboardData.items;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                e.preventDefault();
                const blob = items[i].getAsFile();
                const reader = new FileReader();
                reader.onload = (event) => {
                    setFeedbackAttachments(prev => [...prev, {
                        file: blob,
                        preview: event.target.result,
                        type: 'image'
                    }]);
                };
                reader.readAsDataURL(blob);
            }
        }
    };

    const removeAttachment = (index) => {
        setFeedbackAttachments(prev => prev.filter((_, i) => i !== index));
    };

    const handleSubmitFeedback = async (e) => {
        e.preventDefault();
        if (!feedbackContent.trim() && feedbackAttachments.length === 0) return;

        setFeedbackStatus('submitting');
        try {
            // Try uploading attachments (may fail due to Storage CORS)
            const uploadedRefUrls = [];
            if (feedbackAttachments.length > 0) {
                for (const att of feedbackAttachments) {
                    try {
                        const filename = `feedback_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                        const storageRef = ref(storage, `feedback/${currentUser.uid}/${filename}`);
                        await uploadString(storageRef, att.preview, 'data_url');
                        const downloadURL = await getDownloadURL(storageRef);
                        uploadedRefUrls.push({
                            url: downloadURL,
                            type: 'image',
                            name: 'pasted_image.png'
                        });
                    } catch (uploadErr) {
                        console.warn("Attachment upload skipped (CORS or permission):", uploadErr.message);
                    }
                }
            }

            await addDoc(collection(db, 'feedback'), {
                content: feedbackContent.trim(),
                userId: currentUser.uid,
                userEmail: currentUser.email,
                timestamp: serverTimestamp(),
                status: 'unread',
                attachments: uploadedRefUrls
            });

            // Log Feedback Activity
            logActivity(currentUser.uid, currentUser.email, 'FEEDBACK', 'Submitted feedback');

            setFeedbackStatus('success');
            setFeedbackContent('');
            setFeedbackAttachments([]);
            setTimeout(() => setFeedbackStatus('idle'), 3000);
        } catch (error) {
            console.error("Error submitting feedback:", error);
            setFeedbackStatus('error');
        }
    };

    useEffect(() => {
        const fetchData = async () => {
            if (!currentUser) return;

            try {
                // Fetch Profile
                const userRef = doc(db, 'users', currentUser.uid);
                const userSnap = await getDoc(userRef);

                if (userSnap.exists()) {
                    setProfileData({
                        name: userSnap.data().name || currentUser.displayName || '',
                        company: userSnap.data().company || '',
                        email: currentUser.email || ''
                    });
                } else {
                    setProfileData({
                        name: currentUser.displayName || '',
                        company: '',
                        email: currentUser.email || ''
                    });
                }

                // Fetch History
                const historyRef = collection(db, 'users', currentUser.uid, 'chatHistory');
                const q = query(historyRef, orderBy('timestamp', 'desc'));
                const historySnap = await getDocs(q);

                const history = historySnap.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));
                setChatHistory(history);

                // Fetch Files (Initial fetch if tab is files, or just pre-fetch?)
                // Better to fetch when tab is active, but we can call it here too or in a separate effect
                // Let's rely on activeTab effect for files

            } catch (error) {
                console.error("Error fetching data:", error);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, [currentUser]);



    const handleSaveProfile = async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
            // Update Auth Profile
            if (currentUser.displayName !== profileData.name) {
                await updateProfile(currentUser, {
                    displayName: profileData.name
                });
            }

            // Update Firestore
            const userRef = doc(db, 'users', currentUser.uid);
            await updateDoc(userRef, {
                name: profileData.name,
                company: profileData.company
            });

            alert('프로필이 업데이트되었습니다.');
        } catch (error) {
            console.error("Error updating profile:", error);
            alert('업데이트 중 오류가 발생했습니다.');
        } finally {
            setSaving(false);
        }
    };

    const handlePasswordChange = async (e) => {
        e.preventDefault();

        if (passwordData.newPassword !== passwordData.confirmPassword) {
            alert('새 비밀번호가 일치하지 않습니다.');
            return;
        }

        if (passwordData.newPassword.length < 6) {
            alert('비밀번호는 6자 이상이어야 합니다.');
            return;
        }

        setSaving(true);
        try {
            await updatePassword(currentUser, passwordData.newPassword);
            alert('비밀번호가 성공적으로 변경되었습니다.');
            setPasswordData({ newPassword: '', confirmPassword: '' });
        } catch (error) {
            console.error("Error updating password:", error);
            if (error.code === 'auth/requires-recent-login') {
                alert('보안을 위해 로그인이 필요합니다. 로그아웃 후 다시 로그인하여 시도해주세요.');
            } else {
                alert('비밀번호 변경 중 오류가 발생했습니다: ' + error.message);
            }
        } finally {
            setSaving(false);
        }
    };

    const handleShare = async (e, chat) => {
        e.stopPropagation(); // Prevent toggling accordion
        setSharingId(chat.id);
        try {
            // Create a public shared document
            // We copy the relevant data to a 'shared_chats' collection
            const shareData = {
                query: chat.query,
                response: chat.response,
                filename: chat.filename || null,
                originalUser: profileData.name || currentUser.displayName || 'User',
                createdAt: serverTimestamp(),
                sharedAt: serverTimestamp()
            };

            const docRef = await addDoc(collection(db, 'shared_chats'), shareData);

            // Generate Link
            const shareUrl = `${window.location.origin}/share/${docRef.id}`;
            await navigator.clipboard.writeText(shareUrl);

            alert('공유 링크가 클립보드에 복사되었습니다!\n\n' + shareUrl);
        } catch (error) {
            console.error("Error sharing chat:", error);
            alert('공유 중 오류가 발생했습니다.');
        } finally {
            setSharingId(null);
        }
    };

    const handleSendDirectMessage = (chat) => {
        setReplyRecipientId(null); // Clear any stored recipient to allow selection
        setIsMessageModalOpen(true);
        // We'll pass the chat data to the modal
    };

    if (loading) return (
        <div className="min-h-screen flex items-center justify-center bg-[#fcfaf7]">
            <Loader2 className="animate-spin text-[#d97757]" size={32} />
        </div>
    );

    return (
        <div className="min-h-screen bg-[#fcfaf7] flex flex-col">
            {/* Header */}
            <div className="bg-white border-b border-[#e5e1d8] px-6 py-4 flex items-center gap-4 sticky top-0 z-10">
                <button onClick={() => navigate(-1)} className="p-2 hover:bg-[#f4f1ea] rounded-full transition-colors text-[#555555]">
                    <ArrowLeft size={20} />
                </button>
                <h1 className="text-xl font-bold text-[#333333]">사용자 설정</h1>
            </div>

            <div className="flex-1 max-w-4xl w-full mx-auto p-6">
                <div className="bg-white rounded-xl shadow-sm border border-[#e5e1d8] overflow-hidden flex flex-col md:flex-row min-h-[600px]">
                    <div className="w-full md:w-64 bg-[#f9f8f6] border-r border-[#e5e1d8] p-4 flex flex-col gap-2">
                        <button
                            onClick={() => setActiveTab('history')}
                            className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg text-sm font-medium transition-all ${activeTab === 'history' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#666666] hover:bg-[#e5e1d8]'}`}
                        >
                            <History size={18} />
                            채팅 히스토리
                        </button>
                        <button
                            onClick={() => setActiveTab('messages')}
                            className={`flex items-center justify-between w-full px-4 py-3 rounded-lg text-sm font-medium transition-all ${activeTab === 'messages' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#666666] hover:bg-[#e5e1d8]'}`}
                        >
                            <div className="flex items-center gap-3">
                                <MessageSquare size={18} />
                                받은 메시지
                            </div>
                            {unreadCount > 0 && (
                                <span className="bg-[#d97757] text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold min-w-[20px] text-center">
                                    {unreadCount}
                                </span>
                            )}
                        </button>
                        <button
                            onClick={() => setActiveTab('profile')}
                            className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg text-sm font-medium transition-all ${activeTab === 'profile' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#666666] hover:bg-[#e5e1d8]'}`}
                        >
                            <User size={18} />
                            프로필 편집
                        </button>

                        <div className="h-px bg-[#e5e1d8] my-2 mx-4"></div>

                        <button
                            onClick={() => setActiveTab('feedback')}
                            className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg text-sm font-medium transition-all ${activeTab === 'feedback' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#666666] hover:bg-[#e5e1d8]'}`}
                        >
                            <Send size={18} />
                            피드백 보내기
                        </button>

                        {currentUser && currentUser.email === 'admin@poscoenc.com' && (
                            <>
                                <button
                                    onClick={() => navigate('/admin/notice')}
                                    className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg text-sm font-medium transition-all text-[#666666] hover:bg-[#e5e1d8]`}
                                >
                                    <MessageSquare size={18} />
                                    공지사항 관리
                                </button>
                                <button
                                    onClick={() => navigate('/admin/users')}
                                    className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg text-sm font-medium transition-all text-[#666666] hover:bg-[#e5e1d8]`}
                                >
                                    <Users size={18} />
                                    사용자 관리
                                </button>
                                <button
                                    onClick={() => setActiveTab('admin-feedback')}
                                    className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg text-sm font-medium transition-all ${activeTab === 'admin-feedback' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#666666] hover:bg-[#e5e1d8]'}`}
                                >
                                    <Lock size={18} />
                                    피드백 관리
                                </button>
                                <button
                                    onClick={() => setActiveTab('admin-logs')}
                                    className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg text-sm font-medium transition-all ${activeTab === 'admin-logs' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#666666] hover:bg-[#e5e1d8]'}`}
                                >
                                    <List size={18} />
                                    사용자 로그
                                </button>
                            </>
                        )}

                    </div>

                    {/* Content */}
                    <div className="flex-1 p-8 overflow-y-auto max-h-[calc(100vh-140px)]">
                        {/* Profile Tab */}
                        {activeTab === 'profile' && (
                            <div className="max-w-md">
                                <h2 className="text-2xl font-bold text-[#333333] mb-6">프로필 정보</h2>
                                <form onSubmit={handleSaveProfile} className="space-y-6">
                                    {/* Email (Read Only) */}
                                    <div>
                                        <label className="block text-sm font-medium text-[#666666] mb-1.5">이메일</label>
                                        <div className="relative">
                                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a0a0a0]" size={18} />
                                            <input
                                                type="email"
                                                value={profileData.email}
                                                disabled
                                                className="w-full pl-10 pr-4 py-2.5 bg-[#f4f1ea] border border-[#e5e1d8] rounded-lg text-[#888888] cursor-not-allowed text-sm"
                                            />
                                        </div>
                                    </div>

                                    {/* Name */}
                                    <div>
                                        <label className="block text-sm font-medium text-[#333333] mb-1.5">이름</label>
                                        <div className="relative">
                                            <User className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a0a0a0]" size={18} />
                                            <input
                                                type="text"
                                                value={profileData.name}
                                                onChange={(e) => setProfileData({ ...profileData, name: e.target.value })}
                                                className="w-full pl-10 pr-4 py-2.5 bg-white border border-[#dcd8d0] rounded-lg text-[#333333] focus:ring-2 focus:ring-[#d97757]/20 focus:border-[#d97757] transition-all text-sm"
                                                placeholder="이름을 입력하세요"
                                            />
                                        </div>
                                    </div>

                                    {/* Company */}
                                    <div>
                                        <label className="block text-sm font-medium text-[#333333] mb-1.5">회사 / 소속</label>
                                        <div className="relative">
                                            <Building className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a0a0a0]" size={18} />
                                            <input
                                                type="text"
                                                value={profileData.company}
                                                onChange={(e) => setProfileData({ ...profileData, company: e.target.value })}
                                                className="w-full pl-10 pr-4 py-2.5 bg-white border border-[#dcd8d0] rounded-lg text-[#333333] focus:ring-2 focus:ring-[#d97757]/20 focus:border-[#d97757] transition-all text-sm"
                                                placeholder="회사명을 입력하세요"
                                            />
                                        </div>
                                    </div>

                                    {/* Password Change Section */}
                                    <div className="pt-6 mt-6 border-t border-[#e5e1d8]">
                                        <h3 className="text-lg font-bold text-[#333333] mb-4 flex items-center gap-2">
                                            <Lock size={18} /> 비밀번호 변경
                                        </h3>
                                        <div className="space-y-4">
                                            <div>
                                                <label className="block text-sm font-medium text-[#333333] mb-1.5">새 비밀번호</label>
                                                <input
                                                    type="password"
                                                    value={passwordData.newPassword}
                                                    onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })}
                                                    className="w-full px-4 py-2.5 bg-white border border-[#dcd8d0] rounded-lg text-[#333333] focus:ring-2 focus:ring-[#d97757]/20 focus:border-[#d97757] transition-all text-sm"
                                                    placeholder="변경할 비밀번호 (6자 이상)"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-sm font-medium text-[#333333] mb-1.5">새 비밀번호 확인</label>
                                                <input
                                                    type="password"
                                                    value={passwordData.confirmPassword}
                                                    onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
                                                    className="w-full px-4 py-2.5 bg-white border border-[#dcd8d0] rounded-lg text-[#333333] focus:ring-2 focus:ring-[#d97757]/20 focus:border-[#d97757] transition-all text-sm"
                                                    placeholder="비밀번호 재입력"
                                                />
                                            </div>
                                            <button
                                                type="button"
                                                onClick={handlePasswordChange}
                                                disabled={saving || !passwordData.newPassword}
                                                className="w-full py-2.5 bg-white border border-[#dcd8d0] hover:bg-[#f4f1ea] text-[#555555] rounded-lg font-medium transition-colors disabled:opacity-50 text-sm"
                                            >
                                                비밀번호 변경하기
                                            </button>
                                        </div>
                                    </div>

                                    <button
                                        type="submit"
                                        disabled={saving}
                                        className="flex items-center justify-center gap-2 w-full py-2.5 bg-[#d97757] hover:bg-[#c05535] text-white rounded-lg font-medium transition-colors disabled:opacity-70 mt-8"
                                    >
                                        {saving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
                                        변경사항 저장
                                    </button>
                                </form>
                            </div>
                        )}

                        {/* History Tab */}
                        {activeTab === 'history' && (
                            <div>
                                <h2 className="text-2xl font-bold text-[#333333] mb-6">지난 대화 기록</h2>

                                {chatHistory.length === 0 ? (
                                    <div className="text-center py-20 bg-[#f9f8f6] rounded-xl border border-dashed border-[#dcd8d0]">
                                        <MessageSquare size={48} className="text-[#dcd8d0] mx-auto mb-4" />
                                        <p className="text-[#888888] font-medium">저장된 대화 내역이 없습니다.</p>
                                    </div>
                                ) : (
                                    <div className="border border-[#e5e1d8] rounded-xl overflow-hidden bg-white shadow-sm flex flex-col">
                                        {chatHistory.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage).map((chat, idx) => (
                                            <div key={chat.id} className={`border-b border-[#f0ede6] last:border-0 ${expandedChatId === chat.id ? 'bg-[#fcfaf7]' : 'hover:bg-[#f9f8f6]'} transition-colors`}>
                                                <button
                                                    onClick={() => setExpandedChatId(expandedChatId === chat.id ? null : chat.id)}
                                                    className="w-full p-4 flex items-center gap-4 text-left"
                                                >
                                                    {/* Date */}
                                                    <div className="w-24 shrink-0 text-xs text-[#888888] font-mono">
                                                        {chat.timestamp?.toDate ? chat.timestamp.toDate().toLocaleDateString() : '-'}
                                                    </div>

                                                    {/* Query Preview */}
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2 mb-1">
                                                            <span className="font-bold text-[#333333] text-sm truncate">{chat.query}</span>
                                                            {chat.filename && (
                                                                <span className="text-[10px] text-[#888888] bg-[#f4f1ea] px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0">
                                                                    <FileText size={10} />
                                                                    {chat.filename.length > 20 ? chat.filename.substring(0, 20) + '...' : chat.filename}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {/* Share Button (Visible on Hover or Expanded) */}
                                                    <div className="shrink-0 mr-2">
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setSharingId(chat.id);
                                                                setIsMessageModalOpen(true);
                                                            }}
                                                            className="p-1.5 text-[#a0a0a0] hover:text-[#d97757] hover:bg-[#fff0eb] rounded-md transition-colors"
                                                            title="Direct Message to Colleague"
                                                        >
                                                            <Send size={16} />
                                                        </button>
                                                        <button
                                                            onClick={(e) => handleShare(e, chat)}
                                                            disabled={sharingId === chat.id}
                                                            className="p-1.5 text-[#a0a0a0] hover:text-[#d97757] hover:bg-[#fff0eb] rounded-md transition-colors"
                                                            title="Copy Share Link"
                                                        >
                                                            {sharingId === chat.id ? <Loader2 size={16} className="animate-spin" /> : <Share2 size={16} />}
                                                        </button>
                                                    </div>

                                                    {/* Toggle Icon */}
                                                    <div className="shrink-0 text-[#a0a0a0]">
                                                        {expandedChatId === chat.id ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                                                    </div>
                                                </button>

                                                {/* Expanded Content */}
                                                {expandedChatId === chat.id && (
                                                    <div className="px-4 pb-6 pt-0 pl-[calc(6rem+1rem)]">
                                                        <div className="text-sm text-[#555555] bg-white p-4 rounded-lg border border-[#e5e1d8] shadow-sm relative">
                                                            <div className="absolute top-4 left-0 -ml-2 w-2 h-2 bg-[#d97757] rounded-full"></div>
                                                            <h4 className="font-bold text-[#d97757] text-xs mb-2 flex items-center gap-1">
                                                                AI 답변
                                                                <span className="text-[#a0a0a0] font-normal ml-auto text-[10px]">{chat.timestamp?.toDate ? chat.timestamp.toDate().toLocaleTimeString() : ''}</span>
                                                            </h4>
                                                            <div className="prose prose-sm max-w-none text-[#333333] leading-relaxed">
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
                                                                    {chat.response.replace(/\[\[(.*?)\]\]/g, ' **📄 $1** ')}
                                                                </ReactMarkdown>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        ))}

                                        {/* Pagination Controls */}
                                        {chatHistory.length > itemsPerPage && (
                                            <div className="bg-[#f9f8f6] p-3 border-t border-[#e5e1d8] flex items-center justify-center gap-2">
                                                <button
                                                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                                    disabled={currentPage === 1}
                                                    className="p-1.5 rounded-md hover:bg-[#e5e1d8] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                                                >
                                                    <ChevronLeft size={16} />
                                                </button>

                                                <div className="flex gap-1">
                                                    {Array.from({ length: Math.ceil(chatHistory.length / itemsPerPage) }, (_, i) => i + 1).map(pageNum => (
                                                        <button
                                                            key={pageNum}
                                                            onClick={() => setCurrentPage(pageNum)}
                                                            className={`w-7 h-7 flex items-center justify-center rounded-md text-xs font-medium transition-colors ${currentPage === pageNum ? 'bg-[#d97757] text-white shadow-sm' : 'hover:bg-[#e5e1d8] text-[#555555]'}`}
                                                        >
                                                            {pageNum}
                                                        </button>
                                                    ))}
                                                </div>

                                                <button
                                                    onClick={() => setCurrentPage(p => Math.min(Math.ceil(chatHistory.length / itemsPerPage), p + 1))}
                                                    disabled={currentPage === Math.ceil(chatHistory.length / itemsPerPage)}
                                                    className="p-1.5 rounded-md hover:bg-[#e5e1d8] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                                                >
                                                    <ChevronRight size={16} />
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Messages Tab */}
                        {activeTab === 'messages' && (
                            <div className="flex flex-col h-full">
                                <div className="flex items-center justify-between mb-6">
                                    <div className="flex items-center gap-4">
                                        <h2 className="text-2xl font-bold text-[#333333]">
                                            {messageView === 'inbox' ? '받은 메시지' : '보낸 메시지'}
                                        </h2>
                                        <div className="flex items-center p-1 bg-[#f0ede6] rounded-xl">
                                            <button
                                                onClick={() => setMessageView('inbox')}
                                                className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${messageView === 'inbox' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#888888] hover:text-[#555555]'}`}
                                            >
                                                받은함 {unreadCount > 0 && <span className="ml-1 px-1.5 py-0.5 bg-[#d97757] text-white text-[8px] rounded-full">{unreadCount}</span>}
                                            </button>
                                            <button
                                                onClick={() => setMessageView('outbox')}
                                                className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${messageView === 'outbox' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#888888] hover:text-[#555555]'}`}
                                            >
                                                보낸함
                                            </button>
                                        </div>
                                    </div>
                                    {messageView === 'inbox' && unreadCount > 0 && (
                                        <button
                                            onClick={markAllAsRead}
                                            className="px-3 py-1.5 text-[10px] font-bold text-[#d97757] bg-[#fff0eb] hover:bg-[#ffe0d6] rounded-lg transition-all"
                                        >
                                            모두 읽음 처리
                                        </button>
                                    )}
                                </div>

                                {messages.length === 0 ? (
                                    <div className="text-center py-20 bg-[#f9f8f6] rounded-xl border border-dashed border-[#dcd8d0]">
                                        <MessageSquare size={48} className="text-[#dcd8d0] mx-auto mb-4" />
                                        <p className="text-[#888888] font-medium">
                                            {messageView === 'inbox' ? '받은 메시지가 없습니다.' : '보낸 메시지가 없습니다.'}
                                        </p>
                                    </div>
                                ) : (
                                    <div className="space-y-4">
                                        {messages.map((msg) => (
                                            <div
                                                key={msg.id}
                                                className={`group border ${msg.read ? 'border-[#e5e1d8] bg-white' : 'border-[#d97757]/30 bg-[#fffcfb] shadow-sm'} rounded-xl transition-all overflow-hidden`}
                                            >
                                                <div
                                                    className="p-4 cursor-pointer"
                                                    onClick={() => {
                                                        setExpandedMessageId(expandedMessageId === msg.id ? null : msg.id);
                                                        if (!msg.read) markAsRead(msg.id);
                                                    }}
                                                >
                                                    <div className="flex items-start gap-4">
                                                        <div className="w-10 h-10 rounded-full bg-[#f4f1ea] flex items-center justify-center text-[#555555] font-bold text-sm shrink-0">
                                                            {((messageView === 'inbox' ? msg.senderName : msg.receiverName) || 'U')[0].toUpperCase()}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center justify-between mb-0.5">
                                                                <h4 className={`text-sm font-bold truncate ${msg.read ? 'text-[#333333]' : 'text-[#d97757]'}`}>
                                                                    {messageView === 'inbox' ? msg.senderName : `To: ${msg.receiverName}`}
                                                                </h4>
                                                                <span className="text-[10px] text-[#a0a0a0] font-mono shrink-0">
                                                                    {msg.timestamp?.toDate ? msg.timestamp.toDate().toLocaleString() : '-'}
                                                                </span>
                                                            </div>
                                                            <p className={`text-sm line-clamp-1 ${msg.read ? 'text-[#666666]' : 'text-[#333333] font-medium'}`}>
                                                                {msg.content || (msg.shareData ? '도면 검토 내용을 공유했습니다.' : '새 메시지가 있습니다.')}
                                                            </p>
                                                        </div>
                                                        {messageView === 'inbox' && (
                                                            <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                                <button
                                                                    onClick={(e) => { e.stopPropagation(); handleReply(msg.senderId); }}
                                                                    className="p-1.5 text-[#d97757] hover:bg-[#fff0eb] rounded-md transition-colors"
                                                                    title="Reply"
                                                                >
                                                                    <Send size={16} />
                                                                </button>
                                                            </div>
                                                        )}
                                                    </div>

                                                    {/* Expanded Message Content */}
                                                    {expandedMessageId === msg.id && (
                                                        <div className="mt-4 pt-4 border-t border-[#f0ede6] animate-in fade-in slide-in-from-top-1">
                                                            <div className="text-sm text-[#333333] leading-relaxed whitespace-pre-wrap mb-4">
                                                                {msg.content}
                                                            </div>

                                                            {/* Attachments Display */}
                                                            {msg.attachments && msg.attachments.length > 0 && (
                                                                <div className="flex gap-2 mb-4 overflow-x-auto">
                                                                    {msg.attachments.map((att, idx) => (
                                                                        <a key={idx} href={att.url} target="_blank" rel="noopener noreferrer" className="block border border-[#e5e1d8] rounded-lg overflow-hidden shrink-0 hover:border-[#d97757] transition-colors">
                                                                            <img src={att.url} alt="attachment" className="w-24 h-24 object-cover" />
                                                                        </a>
                                                                    ))}
                                                                </div>
                                                            )}

                                                            {msg.shareData && (
                                                                <div className="bg-[#fcfaf7] border border-[#e5e1d8] rounded-xl p-4 mb-4">
                                                                    <div className="flex items-center gap-2 mb-3">
                                                                        <div className="bg-[#fff0eb] p-1.5 rounded-lg text-[#d97757]">
                                                                            <Share2 size={14} />
                                                                        </div>
                                                                        <h5 className="text-xs font-bold text-[#333333]">공유된 검토 내용</h5>
                                                                        {msg.shareData.filename && (
                                                                            <span className="text-[10px] text-[#888888] bg-white px-1.5 py-0.5 rounded border border-[#e5e1d8]">
                                                                                {msg.shareData.filename}
                                                                            </span>
                                                                        )}
                                                                    </div>

                                                                    <div className="space-y-3">
                                                                        <div className="flex gap-2">
                                                                            <span className="text-[10px] font-bold text-[#d97757] shrink-0 mt-0.5">Q.</span>
                                                                            <p className="text-xs font-bold text-[#333333] italic">{msg.shareData.query}</p>
                                                                        </div>
                                                                        <div className="flex gap-2">
                                                                            <span className="text-[10px] font-bold text-emerald-600 shrink-0 mt-0.5">A.</span>
                                                                            <div className="text-xs text-[#555555] prose-sm max-w-none">
                                                                                <ReactMarkdown
                                                                                    remarkPlugins={[remarkGfm]}
                                                                                    components={{
                                                                                        table: ({ node, ...props }) => <div className="overflow-x-auto my-2"><table className="border-collapse border border-gray-300 w-full text-[10px]" {...props} /></div>,
                                                                                        thead: ({ node, ...props }) => <thead className="bg-gray-100" {...props} />,
                                                                                        th: ({ node, ...props }) => <th className="border border-gray-300 px-2 py-1 font-semibold text-left" {...props} />,
                                                                                        td: ({ node, ...props }) => <td className="border border-gray-300 px-2 py-1" {...props} />,
                                                                                    }}
                                                                                >
                                                                                    {msg.shareData.response.replace(/\[\[(.*?)\]\]/g, ' **📄 $1** ')}
                                                                                </ReactMarkdown>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            )}

                                                            {messageView === 'inbox' && (
                                                                <div className="flex justify-end">
                                                                    <button
                                                                        onClick={(e) => { e.stopPropagation(); handleReply(msg.senderId); }}
                                                                        className="flex items-center gap-2 px-4 py-2 bg-[#d97757] text-white rounded-lg text-xs font-bold hover:bg-[#c05535] transition-all shadow-sm shadow-[#d97757]/20"
                                                                    >
                                                                        <Send size={14} /> 답장 보내기
                                                                    </button>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Feedback Tab (User) */}
                        {activeTab === 'feedback' && (
                            <div className="max-w-lg">
                                <h2 className="text-2xl font-bold text-[#333333] mb-6">피드백 보내기</h2>
                                <p className="text-[#666666] mb-6 text-sm">
                                    서비스 이용 중 불편한 점이나 건의사항이 있으시면 자유롭게 남겨주세요.<br />
                                    여러분의 소중한 의견은 서비스 개선에 큰 도움이 됩니다.
                                </p>

                                <form onSubmit={handleSubmitFeedback} className="space-y-4">
                                    <div>
                                        {/* Attachments Preview */}
                                        {feedbackAttachments.length > 0 && (
                                            <div className="flex gap-2 mb-2 overflow-x-auto pb-2">
                                                {feedbackAttachments.map((att, idx) => (
                                                    <div key={idx} className="relative w-20 h-20 border border-[#e5e1d8] rounded-lg overflow-hidden shrink-0 group">
                                                        <img src={att.preview} alt="attached" className="w-full h-full object-cover" />
                                                        <button
                                                            type="button"
                                                            onClick={() => removeAttachment(idx)}
                                                            className="absolute top-1 right-1 bg-black/50 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                                                        >
                                                            <X size={12} />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}

                                        <textarea
                                            value={feedbackContent}
                                            onChange={(e) => setFeedbackContent(e.target.value)}
                                            onPaste={handlePaste}
                                            placeholder="피드백 내용을 입력해주세요... (이미지를 붙여넣으려면 Ctrl+V)"
                                            className="w-full h-40 p-4 bg-white border border-[#dcd8d0] rounded-lg text-[#333333] focus:ring-2 focus:ring-[#d97757]/20 focus:border-[#d97757] transition-all resize-none text-sm placeholder:text-[#a0a0a0]"
                                            required={feedbackAttachments.length === 0}
                                        />
                                    </div>

                                    <button
                                        type="submit"
                                        disabled={feedbackStatus === 'submitting' || (!feedbackContent.trim() && feedbackAttachments.length === 0)}
                                        className="flex items-center justify-center gap-2 w-full py-2.5 bg-[#d97757] hover:bg-[#c05535] text-white rounded-lg font-medium transition-colors disabled:opacity-70"
                                    >
                                        {feedbackStatus === 'submitting' ? (
                                            <Loader2 size={18} className="animate-spin" />
                                        ) : feedbackStatus === 'success' ? (
                                            <>
                                                <Check size={18} /> 제출 완료
                                            </>
                                        ) : (
                                            <>
                                                <Send size={18} /> 피드백 제출하기
                                            </>
                                        )}
                                    </button>
                                </form>

                                {feedbackStatus === 'success' && (
                                    <div className="mt-4 p-3 bg-green-50 text-green-700 text-sm rounded-lg border border-green-200 flex items-center gap-2">
                                        <Check size={16} />
                                        소중한 의견 감사합니다. 성공적으로 전달되었습니다.
                                    </div>
                                )}
                                {feedbackStatus === 'error' && (
                                    <div className="mt-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-200">
                                        오류가 발생했습니다. 잠시 후 다시 시도해주세요.
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Admin Feedback Dashboard */}
                        {activeTab === 'admin-feedback' && currentUser?.email === 'admin@poscoenc.com' && (
                            <div className="min-h-full">
                                <h2 className="text-2xl font-bold text-[#333333] mb-6">사용자 피드백 관리</h2>

                                <div className="bg-white rounded-lg border border-[#e5e1d8] overflow-hidden shadow-sm">
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm text-left text-[#555555]">
                                            <thead className="text-xs text-[#888888] uppercase bg-[#f9f8f6] border-b border-[#e5e1d8]">
                                                <tr>
                                                    <th className="px-6 py-3 font-medium">Date</th>
                                                    <th className="px-6 py-3 font-medium">User</th>
                                                    <th className="px-6 py-3 font-medium">Feedback</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-[#f0ede6]">
                                                {adminFeedbacks.length === 0 ? (
                                                    <tr>
                                                        <td colSpan="3" className="px-6 py-10 text-center text-[#888888]">
                                                            등록된 피드백이 없습니다.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    adminFeedbacks.map((fb) => (
                                                        <tr
                                                            key={fb.id}
                                                            className="hover:bg-[#fcfaf7] cursor-pointer"
                                                            onClick={() => setSelectedFeedback(fb)}
                                                        >
                                                            <td className="px-6 py-4 whitespace-nowrap font-mono text-xs text-[#888888]">
                                                                {fb.timestamp?.toDate ? fb.timestamp.toDate().toLocaleString() : '-'}
                                                            </td>
                                                            <td className="px-6 py-4 whitespace-nowrap font-medium text-[#333333]">
                                                                {fb.userEmail}
                                                            </td>
                                                            <td className="px-6 py-4">
                                                                <p className="whitespace-pre-wrap max-w-xl truncate line-clamp-2">{fb.content}</p>
                                                            </td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                {/* Feedback Details Modal */}
                                {selectedFeedback && (
                                    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setSelectedFeedback(null)}>
                                        <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                                            <div className="p-4 border-b border-[#e5e1d8] flex items-center justify-between bg-[#f9f8f6]">
                                                <div className="flex flex-col">
                                                    <h3 className="font-bold text-[#333333]">피드백 상세</h3>
                                                    <span className="text-xs text-[#888888]">{selectedFeedback.userEmail} • {selectedFeedback.timestamp?.toDate ? selectedFeedback.timestamp.toDate().toLocaleString() : '-'}</span>
                                                </div>
                                                <button onClick={() => setSelectedFeedback(null)} className="p-2 hover:bg-[#e5e1d8] rounded-full text-[#666666] transition-colors">
                                                    <X size={20} />
                                                </button>
                                            </div>

                                            <div className="p-6 overflow-y-auto bg-[#fcfaf7]">
                                                {/* Screenshot */}
                                                {selectedFeedback.screenshot && (
                                                    <div className="mb-6">
                                                        <h4 className="text-sm font-bold text-[#555555] mb-2 flex items-center gap-2">
                                                            <FileText size={16} /> Attached Screen
                                                        </h4>
                                                        <div className="border border-[#e5e1d8] rounded-lg overflow-hidden bg-white shadow-sm">
                                                            <img
                                                                src={selectedFeedback.screenshot}
                                                                alt="User Screenshot"
                                                                className="w-full h-auto object-contain max-h-[500px]"
                                                            />
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Attachments */}
                                                {selectedFeedback.attachments && selectedFeedback.attachments.length > 0 && (
                                                    <div className="mb-6">
                                                        <h4 className="text-sm font-bold text-[#555555] mb-2 flex items-center gap-2">
                                                            <FileText size={16} /> 첨부 이미지
                                                        </h4>
                                                        <div className="flex flex-wrap gap-3">
                                                            {selectedFeedback.attachments.map((att, idx) => (
                                                                <div key={idx} className="border border-[#e5e1d8] rounded-lg overflow-hidden bg-white shadow-sm">
                                                                    <a href={att.url} target="_blank" rel="noopener noreferrer">
                                                                        <img
                                                                            src={att.url}
                                                                            alt={att.name || `attachment-${idx}`}
                                                                            referrerPolicy="no-referrer"
                                                                            crossOrigin="anonymous"
                                                                            className="max-w-full h-auto object-contain max-h-[400px]"
                                                                            onError={(e) => {
                                                                                e.target.style.display = 'none';
                                                                                e.target.parentElement.innerHTML = '<div style="padding:16px;color:#666;font-size:14px;">이미지를 불러올 수 없습니다. 클릭하여 새 탭에서 열기</div>';
                                                                            }}
                                                                        />
                                                                    </a>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Content */}
                                                <div>
                                                    <h4 className="text-sm font-bold text-[#555555] mb-2 flex items-center gap-2">
                                                        <MessageSquare size={16} /> Content
                                                    </h4>
                                                    <div className="bg-white p-4 rounded-lg border border-[#e5e1d8] text-[#333333] whitespace-pre-wrap leading-relaxed shadow-sm">
                                                        {selectedFeedback.content}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Admin Logs Dashboard */}
                        {activeTab === 'admin-logs' && currentUser?.email === 'admin@poscoenc.com' && (
                            <div className="min-h-full">
                                <h2 className="text-2xl font-bold text-[#333333] mb-6">사용자 로그 기록</h2>

                                <div className="bg-white rounded-lg border border-[#e5e1d8] overflow-hidden shadow-sm">
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm text-left text-[#555555]">
                                            <thead className="text-xs text-[#888888] uppercase bg-[#f9f8f6] border-b border-[#e5e1d8]">
                                                <tr>
                                                    <th className="px-6 py-3 font-medium">Time</th>
                                                    <th className="px-6 py-3 font-medium">User</th>
                                                    <th className="px-6 py-3 font-medium">Action</th>
                                                    <th className="px-6 py-3 font-medium max-w-xs">Details</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-[#f0ede6]">
                                                {activityLogs.length === 0 ? (
                                                    <tr>
                                                        <td colSpan="4" className="px-6 py-10 text-center text-[#888888]">
                                                            기록된 로그가 없습니다.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    activityLogs.map((log) => (
                                                        <tr key={log.id} className="hover:bg-[#fcfaf7]">
                                                            <td className="px-6 py-4 whitespace-nowrap font-mono text-xs text-[#888888]">
                                                                {log.timestamp?.toDate ? log.timestamp.toDate().toLocaleString() : '-'}
                                                            </td>
                                                            <td className="px-6 py-4 whitespace-nowrap font-medium text-[#333333]">
                                                                {log.userEmail}
                                                            </td>
                                                            <td className="px-6 py-4 whitespace-nowrap">
                                                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${log.action === 'LOGIN' ? 'bg-blue-100 text-blue-700' :
                                                                    log.action === 'CHAT' ? 'bg-green-100 text-green-700' :
                                                                        log.action === 'FEEDBACK' ? 'bg-purple-100 text-purple-700' :
                                                                            'bg-gray-100 text-gray-700'
                                                                    }`}>
                                                                    {log.action}
                                                                </span>
                                                            </td>
                                                            <td className="px-6 py-4 text-xs text-[#666666] truncate max-w-xs" title={log.details}>
                                                                {log.details}
                                                            </td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* End of Content - activeTab checks end here */}
                    </div>
                </div>
            </div>

            {/* Messaging Modal */}
            <MessageModal
                isOpen={isMessageModalOpen}
                onClose={() => {
                    setIsMessageModalOpen(false);
                    setReplyRecipientId(null);
                    setSharingId(null);
                }}
                shareData={sharingId ? chatHistory.find(c => c.id === sharingId) : null}
                initialRecipientId={replyRecipientId}
                senderName={profileData?.name}
            />
        </div>
    );
};

export default UserProfile;
