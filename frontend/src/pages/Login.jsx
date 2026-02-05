import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Link, useNavigate } from 'react-router-dom';
import { User, Lock, Loader2, AlertCircle } from 'lucide-react';
import { db } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { logActivity } from '../services/logging';

const Login = () => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const { login, logout } = useAuth();
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        try {
            setError('');
            setLoading(true);

            // 1. Firebase Auth Login
            const userCred = await login(email, password);
            const user = userCred.user;

            // 2. Check Admin Bypass
            if (user.email === 'admin@poscoenc.com') {
                logActivity(user.uid, user.email, 'LOGIN', 'Admin logged in');
                navigate('/');
                return;
            }

            // 3. Check User Status in Firestore
            const userDocRef = doc(db, "users", user.uid);
            const userDoc = await getDoc(userDocRef);

            if (userDoc.exists()) {
                const userData = userDoc.data();
                if (userData.status !== 'approved') {
                    await logout(); // Logout immediately
                    if (userData.status === 'rejected') {
                        throw new Error('가입이 거절되었습니다. 관리자에게 문의하세요.');
                    } else {
                        throw new Error('가입 승인 대기 중입니다. 관리자 승인 후 이용 가능합니다.');
                    }
                }
            } else {
                // Legacy users might not have status, allow or defaulted? 
                // Let's assume strict mode, or maybe allow legacy users if no status field?
                // For now, let's treat no-doc as valid or create one? 
                // Safest is to allow if "status" is undefined (for existing users) OR check logic.
                // But requirement implies "New users". Legacy users don't have "status" field likely.
                // Let's allow ONLY if status is explicitly NOT 'approved' AND status exists.
                // Actually user requested "Member Join Approval", implies new workflow.
                // Let's assume legacy users are fine. Only block if status === 'pending' | 'rejected'.
                // If status is undefined, we could assume 'approved' (legacy) or update them. 
                // Let's be strict: if status is explicitly pending/rejected block. Else allow.
                if (userData.status === 'pending') {
                    await logout();
                    throw new Error('가입 승인 대기 중입니다. 관리자 승인 후 이용 가능합니다.');
                }
            }

            logActivity(user.uid, user.email, 'LOGIN', 'User logged in');
            navigate('/');

        } catch (err) {
            console.error(err);
            // Handle specific error messages
            setError(err.message || '로그인에 실패했습니다. 이메일과 비밀번호를 확인해주세요.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-8">
                <div className="text-center mb-8">
                    <h2 className="text-3xl font-bold text-gray-900">Drawing Analyzer</h2>
                    <p className="text-gray-600 mt-2">사용자 계정에 로그인하세요</p>
                </div>

                {error && (
                    <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex items-center gap-2">
                        <AlertCircle className="w-5 h-5" />
                        <span>{error}</span>
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-6">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">이메일 주소</label>
                        <div className="relative">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                <User className="h-5 w-5 text-gray-400" />
                            </div>
                            <input
                                type="email"
                                required
                                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-emerald-500 focus:border-emerald-500 transition-colors"
                                placeholder="name@example.com"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">비밀번호</label>
                        <div className="relative">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                <Lock className="h-5 w-5 text-gray-400" />
                            </div>
                            <input
                                type="password"
                                required
                                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-emerald-500 focus:border-emerald-500 transition-colors"
                                placeholder="••••••••"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                        </div>
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                        {loading ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                            '로그인'
                        )}
                    </button>
                </form>

                <div className="mt-6 text-center text-sm text-gray-600">
                    계정이 없으신가요?{' '}
                    <Link to="/register" className="font-medium text-emerald-600 hover:text-emerald-500 hover:underline">
                        회원가입
                    </Link>
                </div>
            </div>
        </div>
    );
};

export default Login;
