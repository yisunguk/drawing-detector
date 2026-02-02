
import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { db } from '../firebase';
import { doc, getDoc, updateDoc, collection, query, orderBy, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { updateProfile, updatePassword } from 'firebase/auth';
import { ArrowLeft, User, History, Save, Building, Mail, Loader2, MessageSquare, Lock, ChevronDown, ChevronUp, FileText, ChevronLeft, ChevronRight, Share2, Check, FolderOpen, Download } from 'lucide-react';

const UserProfile = () => {
    const { currentUser } = useAuth();
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState('history');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [expandedChatId, setExpandedChatId] = useState(null);
    const [sharingId, setSharingId] = useState(null);

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

    // Files State
    const [userFiles, setUserFiles] = useState([]);
    const [filesLoading, setFilesLoading] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');

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

    // Fetch Files when tab changes to 'files'
    useEffect(() => {
        if (activeTab === 'files') {
            fetchUserFiles();
        }
    }, [activeTab]);

    const fetchUserFiles = async () => {
        setFilesLoading(true);
        try {
            const PRODUCTION_API_URL = 'https://drawing-detector-backend-kr7kyy4mza-uc.a.run.app';
            const API_URL = import.meta.env.VITE_API_URL || PRODUCTION_API_URL;

            const response = await fetch(`${API_URL}/api/v1/files/list`);
            if (!response.ok) throw new Error('Failed to fetch files');

            const data = await response.json();
            if (data.success) {
                setUserFiles(data.files);
            }
        } catch (error) {
            console.error("Error fetching files:", error);
        } finally {
            setFilesLoading(false);
        }
    };

    const handleDownloadFile = async (file) => {
        try {
            const PRODUCTION_API_URL = 'https://drawing-detector-backend-kr7kyy4mza-uc.a.run.app';
            const API_URL = import.meta.env.VITE_API_URL || PRODUCTION_API_URL;

            // Request SAS URL
            const response = await fetch(`${API_URL}/api/v1/files/download?path=${encodeURIComponent(file.fullPath)}`);
            if (!response.ok) throw new Error('Failed to get download URL');

            const data = await response.json();
            if (data.success && data.downloadUrl) {
                // Open in new tab to download
                window.open(data.downloadUrl, '_blank');
            }
        } catch (error) {
            console.error("Error downloading file:", error);
            alert("파일 다운로드 중 오류가 발생했습니다.");
        }
    };


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

    if (loading) return (
        <div className="min-h-screen flex items-center justify-center bg-[#fcfaf7]">
            <Loader2 className="animate-spin text-[#d97757]" size={32} />
        </div>
    );

    return (
        <div className="min-h-screen bg-[#fcfaf7] flex flex-col">
            {/* Header */}
            <div className="bg-white border-b border-[#e5e1d8] px-6 py-4 flex items-center gap-4 sticky top-0 z-10">
                <button onClick={() => navigate('/')} className="p-2 hover:bg-[#f4f1ea] rounded-full transition-colors text-[#555555]">
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
                            onClick={() => setActiveTab('profile')}
                            className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg text-sm font-medium transition-all ${activeTab === 'profile' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#666666] hover:bg-[#e5e1d8]'}`}
                        >
                            <User size={18} />
                            프로필 편집
                        </button>
                        <button
                            onClick={() => setActiveTab('files')}
                            className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg text-sm font-medium transition-all ${activeTab === 'files' ? 'bg-white text-[#d97757] shadow-sm' : 'text-[#666666] hover:bg-[#e5e1d8]'}`}
                        >
                            <FolderOpen size={18} />
                            등록된 파일
                        </button>
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
                                                            onClick={(e) => handleShare(e, chat)}
                                                            disabled={sharingId === chat.id}
                                                            className="p-1.5 text-[#a0a0a0] hover:text-[#d97757] hover:bg-[#fff0eb] rounded-md transition-colors"
                                                            title="Share this conversation"
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

                        {/* Files Tab (Dark Theme) */}
                        {activeTab === 'files' && (
                            <div className="min-h-full">
                                <h2 className="text-2xl font-bold text-[#333333] mb-6">Files</h2>

                                <div className="bg-[#0e1117] text-white rounded-lg overflow-hidden shadow-lg border border-[#262730]">
                                    {/* Search Bar */}
                                    <div className="p-4 border-b border-[#262730]">
                                        <div className="relative">
                                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                                <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                                </svg>
                                            </div>
                                            <input
                                                type="text"
                                                className="block w-full pl-10 pr-3 py-2 border border-[#262730] rounded-md leading-5 bg-[#262730] text-gray-300 placeholder-gray-500 focus:outline-none focus:bg-[#0e1117] focus:border-gray-500 focus:ring-0 sm:text-sm transition-colors"
                                                placeholder="Type filename..."
                                                value={searchTerm}
                                                onChange={(e) => setSearchTerm(e.target.value)}
                                            />
                                        </div>
                                        <div className="mt-2 text-xs font-mono text-gray-500">
                                            {filesLoading ? 'Loading files...' : `Files (${userFiles.filter(f => f.filename.toLowerCase().includes(searchTerm.toLowerCase())).length})`}
                                        </div>
                                    </div>

                                    {/* File List Table */}
                                    <div className="overflow-x-auto">
                                        <table className="min-w-full divide-y divide-[#262730]">
                                            <thead className="bg-[#0e1117]">
                                                <tr>
                                                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-10">
                                                        Select
                                                    </th>
                                                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Name
                                                    </th>
                                                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Size
                                                    </th>
                                                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Last Modified
                                                    </th>
                                                    <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Action
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody className="bg-[#0e1117] divide-y divide-[#262730]">
                                                {filesLoading ? (
                                                    <tr>
                                                        <td colSpan="5" className="px-6 py-10 text-center text-gray-500">
                                                            <Loader2 className="animate-spin mx-auto mb-2" />
                                                            Server connecting...
                                                        </td>
                                                    </tr>
                                                ) : userFiles.length === 0 ? (
                                                    <tr>
                                                        <td colSpan="5" className="px-6 py-10 text-center text-gray-500">
                                                            No files found.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    userFiles.filter(file => file.filename.toLowerCase().includes(searchTerm.toLowerCase())).map((file, idx) => (
                                                        <tr key={idx} className="hover:bg-[#262730] transition-colors group">
                                                            <td className="px-6 py-4 whitespace-nowrap">
                                                                <input type="checkbox" className="h-4 w-4 text-[#d97757] focus:ring-[#d97757] border-gray-500 rounded bg-[#262730]" />
                                                            </td>
                                                            <td className="px-6 py-4 whitespace-nowrap">
                                                                <div className="flex items-center">
                                                                    <div className="flex-shrink-0 h-8 w-8 flex items-center justify-center bg-[#262730] rounded-md text-gray-400">
                                                                        <FileText size={16} />
                                                                    </div>
                                                                    <div className="ml-4">
                                                                        <div className="text-sm font-medium text-white">{file.filename}</div>
                                                                        <div className="text-xs text-gray-500">{file.category}</div>
                                                                    </div>
                                                                </div>
                                                            </td>
                                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400 font-mono">
                                                                {file.size}
                                                            </td>
                                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400 font-mono">
                                                                {file.lastModified ? new Date(file.lastModified).toLocaleString() : '-'}
                                                            </td>
                                                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                                                <button
                                                                    onClick={() => handleDownloadFile(file)}
                                                                    className="text-[#d97757] hover:text-[#ff8d6b] flex items-center justify-end gap-1 ml-auto"
                                                                >
                                                                    <Download size={16} />
                                                                    <span className="hidden group-hover:inline">Download</span>
                                                                </button>
                                                            </td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div className="bg-[#0e1117] px-4 py-3 border-t border-[#262730] text-xs text-gray-600 flex justify-between">
                                        <span>Azure Blob Storage Manager | Built with Drawing Detector</span>
                                    </div>
                                </div>
                            </div>
                        )}
                        {/* End of Content - activeTab checks end here */}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default UserProfile;
