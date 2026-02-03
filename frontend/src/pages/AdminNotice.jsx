import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Save, AlertCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { db } from '../firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';

const AdminNotice = () => {
    const { currentUser } = useAuth();
    const navigate = useNavigate();
    const [content, setContent] = useState('');
    const [isActive, setIsActive] = useState(true);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState({ type: '', text: '' });

    useEffect(() => {
        // Basic protection
        if (!currentUser || currentUser.email !== 'admin@poscoenc.com') {
            navigate('/');
            return;
        }
        fetchNotice();
    }, [currentUser, navigate]);

    const fetchNotice = async () => {
        try {
            const docRef = doc(db, 'settings', 'notice');
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                const data = docSnap.data();
                setContent(data.content || '');
                setIsActive(data.is_active ?? true);
            }
        } catch (error) {
            console.error('Failed to fetch notice:', error);
        }
    };

    const handleSave = async () => {
        setLoading(true);
        setMessage({ type: '', text: '' });

        try {
            const docRef = doc(db, 'settings', 'notice');
            await setDoc(docRef, {
                content,
                is_active: isActive,
                updated_at: serverTimestamp(),
                updated_by: currentUser.email
            });

            setMessage({ type: 'success', text: 'Notice updated successfully!' });
        } catch (error) {
            console.error("Error saving notice:", error);
            setMessage({ type: 'error', text: 'Failed to update notice. Please try again.' });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-6 max-w-4xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Notice Management</h1>
                <div className="flex items-center gap-2 px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-medium">
                    <AlertCircle className="w-4 h-4" />
                    Admin Only
                </div>
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 space-y-6">

                {/* Status Toggle */}
                <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg">
                    <div>
                        <h3 className="font-medium text-gray-900 dark:text-white">Popup Status</h3>
                        <p className="text-sm text-gray-500">Enable or disable the notice popup for all users</p>
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
                        Save Changes
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AdminNotice;
