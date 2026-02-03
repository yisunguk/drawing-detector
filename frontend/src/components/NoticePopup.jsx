import React, { useState, useEffect } from 'react';
import { X, Bell } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { db } from '../firebase';
import { collection, query, where, orderBy, limit, onSnapshot } from 'firebase/firestore';

const NoticePopup = () => {
    const [isOpen, setIsOpen] = useState(false);
    const [notice, setNotice] = useState({ content: '', is_active: false });
    const [dontShowToday, setDontShowToday] = useState(false);

    useEffect(() => {
        // Listen to real-time updates for the active notice
        const q = query(
            collection(db, 'notices'),
            where('is_active', '==', true),
            orderBy('created_at', 'desc'),
            limit(1)
        );

        const unsubscribe = onSnapshot(q, (querySnapshot) => {
            if (!querySnapshot.empty) {
                const docSnap = querySnapshot.docs[0];
                const data = docSnap.data();
                setNotice(data);

                // Logic to check localStorage
                checkVisibility(data, docSnap.id);
            } else {
                setNotice({ content: '', is_active: false });
                setIsOpen(false);
            }
        });

        return () => unsubscribe();
    }, []);

    const checkVisibility = (data, id) => {
        const today = new Date().toISOString().split('T')[0];
        const hiddenNoticeData = JSON.parse(localStorage.getItem('hide_notice_data') || '{}');

        // If this specific notice ID was hidden today, don't show
        if (hiddenNoticeData.id === id && hiddenNoticeData.date === today) {
            setIsOpen(false);
        } else {
            // Otherwise show it (since we already filtered for active in the query)
            setIsOpen(true);
            // Store current ID for handleClose to use
            setNotice(prev => ({ ...prev, id }));
        }
    };

    const handleClose = () => {
        if (dontShowToday && notice.id) {
            const today = new Date().toISOString().split('T')[0];
            localStorage.setItem('hide_notice_data', JSON.stringify({
                id: notice.id,
                date: today
            }));
        }
        setIsOpen(false);
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[85vh]">

                {/* Header */}
                <div className="bg-[#d97757] px-6 py-4 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2 text-white">
                        <Bell className="w-5 h-5" />
                        <h3 className="font-semibold text-lg">공지사항</h3>
                    </div>
                    <button
                        onClick={() => setIsOpen(false)}
                        className="text-white/80 hover:text-white transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto">
                    <div className="prose dark:prose-invert max-w-none text-sm text-gray-600 dark:text-gray-300">
                        <ReactMarkdown>{notice.content}</ReactMarkdown>
                    </div>
                </div>

                {/* Footer */}
                <div className="bg-gray-50 dark:bg-gray-900/50 px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-gray-100 dark:border-gray-700 shrink-0">
                    <label className="flex items-center gap-2 text-sm text-gray-500 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300 transition-colors">
                        <input
                            type="checkbox"
                            checked={dontShowToday}
                            onChange={(e) => setDontShowToday(e.target.checked)}
                            className="rounded border-gray-300 text-[#d97757] focus:ring-[#d97757] w-4 h-4"
                        />
                        오늘 하루 보지 않기
                    </label>

                    <button
                        onClick={handleClose}
                        className="w-full sm:w-auto px-6 py-2 bg-[#d97757] hover:bg-[#c05535] text-white rounded-lg font-medium text-sm transition-colors shadow-sm"
                    >
                        닫기
                    </button>
                </div>
            </div>
        </div>
    );
};

export default NoticePopup;
