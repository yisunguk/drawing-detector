import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Save, AlertCircle, Plus, ArrowLeft, Trash2, ToggleLeft, ToggleRight, Edit2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { db } from '../firebase';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, query, orderBy } from 'firebase/firestore';

const AdminNotice = () => {
    const { currentUser } = useAuth();
    const navigate = useNavigate();

    const [view, setView] = useState('list'); // 'list' | 'create' | 'edit'
    const [notices, setNotices] = useState([]);
    const [editingId, setEditingId] = useState(null);

    const [content, setContent] = useState('');
    const [isActive, setIsActive] = useState(true);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState({ type: '', text: '' });

    useEffect(() => {
        if (!currentUser || currentUser.email !== 'admin@poscoenc.com') {
            navigate('/');
            return;
        }
        fetchNotices();
    }, [currentUser, navigate]);

    const fetchNotices = async () => {
        try {
            setLoading(true);
            const q = query(collection(db, 'notices'), orderBy('created_at', 'desc'));
            const querySnapshot = await getDocs(q);
            const noticesData = querySnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            setNotices(noticesData);
        } catch (error) {
            console.error('Failed to fetch notices:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        if (!content.trim()) {
            setMessage({ type: 'error', text: 'Content is required' });
            return;
        }
        setLoading(true);
        setMessage({ type: '', text: '' });

        try {
            const noticeData = {
                content,
                is_active: isActive,
                updated_at: serverTimestamp(),
                updated_by: currentUser.email
            };

            if (view === 'create') {
                await addDoc(collection(db, 'notices'), {
                    ...noticeData,
                    created_at: serverTimestamp()
                });
                setMessage({ type: 'success', text: 'Notice created successfully!' });
            } else if (view === 'edit' && editingId) {
                await updateDoc(doc(db, 'notices', editingId), noticeData);
                setMessage({ type: 'success', text: 'Notice updated successfully!' });
            }

            await fetchNotices();
            setTimeout(() => {
                setView('list');
                setContent('');
                setIsActive(true);
                setEditingId(null);
                setMessage({ type: '', text: '' });
            }, 1000);
        } catch (error) {
            console.error("Error saving notice:", error);
            setMessage({ type: 'error', text: 'Failed to save notice. Please try again.' });
        } finally {
            setLoading(false);
        }
    };

    const handleToggleActive = async (id, currentStatus) => {
        try {
            await updateDoc(doc(db, 'notices', id), {
                is_active: !currentStatus,
                updated_at: serverTimestamp()
            });
            // Optimistic update or refetch
            setNotices(prev => prev.map(n => n.id === id ? { ...n, is_active: !currentStatus } : n));
        } catch (error) {
            console.error("Error toggling status:", error);
        }
    };

    const handleDelete = async (id) => {
        if (!window.confirm("Are you sure you want to delete this notice?")) return;
        try {
            await deleteDoc(doc(db, 'notices', id));
            setNotices(prev => prev.filter(n => n.id !== id));
        } catch (error) {
            console.error("Error deleting notice:", error);
        }
    };

    const startEdit = (notice) => {
        setEditingId(notice.id);
        setContent(notice.content);
        setIsActive(notice.is_active);
        setView('edit');
    };

    return (
        <div className="p-6 max-w-4xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <button
                        onClick={() => view === 'list' ? navigate(-1) : setView('list')}
                        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                    >
                        <ArrowLeft className="w-6 h-6 text-gray-600 dark:text-gray-300" />
                    </button>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                        {view === 'list' ? 'Notice Management' : view === 'create' ? 'Create Notice' : 'Edit Notice'}
                    </h1>
                </div>
                <div className="flex items-center gap-2 px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-medium">
                    <AlertCircle className="w-4 h-4" />
                    Admin Only
                </div>
            </div>

            {view === 'list' ? (
                <div className="space-y-4">
                    <div className="flex justify-end">
                        <button
                            onClick={() => {
                                setContent('');
                                setIsActive(true);
                                setView('create');
                            }}
                            className="flex items-center gap-2 px-4 py-2 bg-[#d97757] hover:bg-[#c05535] text-white rounded-lg font-medium transition-colors"
                        >
                            <Plus className="w-5 h-5" />
                            New Notice
                        </button>
                    </div>

                    <div className="space-y-4">
                        {loading && notices.length === 0 ? (
                            <div className="text-center py-8 text-gray-500">Loading...</div>
                        ) : notices.map(notice => (
                            <div key={notice.id} className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 transition-all hover:shadow-md">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-2">
                                            {notice.is_active ? (
                                                <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full font-medium">Active</span>
                                            ) : (
                                                <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full font-medium">Inactive</span>
                                            )}
                                            <span className="text-xs text-gray-400">
                                                {notice.created_at?.toDate().toLocaleDateString()}
                                            </span>
                                        </div>
                                        <p className="text-sm text-gray-600 dark:text-gray-300 line-clamp-2 font-mono bg-gray-50 dark:bg-gray-900/50 p-2 rounded">
                                            {notice.content}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => handleToggleActive(notice.id, notice.is_active)}
                                            className={`p-2 rounded-lg transition-colors ${notice.is_active ? 'text-green-600 hover:bg-green-50' : 'text-gray-400 hover:bg-gray-100'}`}
                                            title={notice.is_active ? "Deactivate" : "Activate"}
                                        >
                                            {notice.is_active ? <ToggleRight className="w-6 h-6" /> : <ToggleLeft className="w-6 h-6" />}
                                        </button>
                                        <button
                                            onClick={() => startEdit(notice)}
                                            className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                            title="Edit"
                                        >
                                            <Edit2 className="w-5 h-5" />
                                        </button>
                                        <button
                                            onClick={() => handleDelete(notice.id)}
                                            className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                            title="Delete"
                                        >
                                            <Trash2 className="w-5 h-5" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                        {!loading && notices.length === 0 && (
                            <div className="text-center py-12 bg-gray-50 dark:bg-gray-900/30 rounded-xl border border-dashed border-gray-300">
                                <p className="text-gray-500">No notices found</p>
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 space-y-6 animate-in slide-in-from-right duration-200">

                    {/* Status Toggle */}
                    <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg">
                        <div>
                            <h3 className="font-medium text-gray-900 dark:text-white">Popup Status</h3>
                            <p className="text-sm text-gray-500">Enable or disable this notice immediately</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input
                                type="checkbox"
                                checked={isActive}
                                onChange={(e) => setIsActive(e.target.checked)}
                                className="sr-only peer"
                            />
                            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                        </label>
                    </div>

                    {/* Content Editor */}
                    <div className="space-y-2">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                            Notice Content (Markdown Supported)
                        </label>
                        <textarea
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            rows={12}
                            className="w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-900 dark:border-gray-700 dark:text-white font-mono text-sm"
                            placeholder="# Important Announcement&#10;&#10;Write your notice content here..."
                        />
                    </div>

                    {/* Actions */}
                    <div className="flex items-center justify-between pt-4 border-t border-gray-100 dark:border-gray-700">
                        <div className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                            {message.text}
                        </div>

                        <div className="flex gap-3">
                            <button
                                onClick={() => setView('list')}
                                className="px-6 py-2.5 bg-gray-100 text-gray-700 hover:bg-gray-200 rounded-lg font-medium transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={loading}
                                className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {loading ? (
                                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                ) : (
                                    <Save className="w-4 h-4" />
                                )}
                                {view === 'create' ? 'Create Notice' : 'Update Notice'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AdminNotice;
