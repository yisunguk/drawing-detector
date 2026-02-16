import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Register from './pages/Register';
import UserProfile from './pages/UserProfile';
import AdminNotice from './pages/AdminNotice';
import AdminUsers from './pages/AdminUsers';
import NoticePopup from './components/NoticePopup';
import { Loader2 } from 'lucide-react';

// Private Route Component
const PrivateRoute = ({ children }) => {
    const { currentUser, loading } = useAuth();
    const location = useLocation();

    if (loading) {
        return (
            <div className="h-screen w-screen flex items-center justify-center bg-gray-50">
                <div className="text-center">
                    <Loader2 className="w-10 h-10 text-emerald-600 animate-spin mx-auto mb-4" />
                    <p className="text-gray-500 font-medium">Loading...</p>
                </div>
            </div>
        );
    }

    if (!currentUser) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    return children;
};

// Public Route Component (redirects to dashboard if already logged in)
const PublicRoute = ({ children }) => {
    const { currentUser, loading } = useAuth();

    if (loading) {
        return null; // Or loading spinner
    }

    if (currentUser) {
        return <Navigate to="/" replace />;
    }

    return children;
};

// Import new pages
import LandingPage from './pages/LandingPage';
import KnowhowDB from './pages/KnowhowDB';
import LineList from './pages/LineList';
import LessonsLearned from './pages/LessonsLearned';
import RevisionMaster from './pages/RevisionMaster';

const App = () => {
    return (
        <Router>
            <AuthProvider>
                <div className="App font-sans text-gray-900">
                    <Routes>
                        <Route
                            path="/login"
                            element={
                                <PublicRoute>
                                    <Login />
                                </PublicRoute>
                            }
                        />
                        <Route
                            path="/register"
                            element={
                                <PublicRoute>
                                    <Register />
                                </PublicRoute>
                            }
                        />
                        {/* Root: Landing Hub */}
                        <Route
                            path="/"
                            element={
                                <PrivateRoute>
                                    <LandingPage />
                                </PrivateRoute>
                            }
                        />
                        {/* Drawing Analysis AI (Formerly Dashboard) */}
                        <Route
                            path="/drawing-ai"
                            element={
                                <PrivateRoute>
                                    <Dashboard />
                                </PrivateRoute>
                            }
                        />
                        {/* Know-how DB */}
                        <Route
                            path="/knowhow-db"
                            element={
                                <PrivateRoute>
                                    <KnowhowDB />
                                </PrivateRoute>
                            }
                        />
                        {/* P&ID Line List */}
                        <Route
                            path="/line-list"
                            element={
                                <PrivateRoute>
                                    <LineList />
                                </PrivateRoute>
                            }
                        />
                        {/* Lessons Learned AI */}
                        <Route
                            path="/lessons-learned"
                            element={
                                <PrivateRoute>
                                    <LessonsLearned />
                                </PrivateRoute>
                            }
                        />
                        {/* Revision Master */}
                        <Route
                            path="/revision-master"
                            element={
                                <PrivateRoute>
                                    <RevisionMaster />
                                </PrivateRoute>
                            }
                        />
                        <Route
                            path="/profile"
                            element={
                                <PrivateRoute>
                                    <UserProfile />
                                </PrivateRoute>
                            }
                        />
                        <Route
                            path="/admin/notice"
                            element={
                                <PrivateRoute>
                                    <AdminNotice />
                                </PrivateRoute>
                            }
                        />
                        <Route
                            path="/admin/users"
                            element={
                                <PrivateRoute>
                                    <AdminUsers />
                                </PrivateRoute>
                            }
                        />
                        {/* Fallback route */}
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                    <NoticePopup />
                </div>
            </AuthProvider>
        </Router >
    );
};

export default App;
