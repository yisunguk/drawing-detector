import React from 'react';
import { useNavigate } from 'react-router-dom';
import { FileSearch, Database, ArrowRight, LogOut, LayoutGrid, ListChecks } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const LandingPage = () => {
    const navigate = useNavigate();
    const { logout, currentUser } = useAuth();

    const handleLogout = async () => {
        try {
            await logout();
            navigate('/login');
        } catch (error) {
            console.error("Failed to log out", error);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex flex-col items-center justify-center p-6 relative overflow-hidden">
            {/* Background Ambient Effects */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-500/10 rounded-full blur-[120px] animate-pulse" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/10 rounded-full blur-[120px] animate-pulse delay-1000" />
            </div>

            {/* Header / User Info */}
            <div className="absolute top-6 right-8 flex items-center gap-4 z-10">
                <div className="text-right hidden sm:block">
                    <p className="text-slate-200 text-sm font-medium">{currentUser?.email}</p>
                    <p className="text-slate-400 text-xs">Admin User</p>
                </div>
                <button
                    onClick={handleLogout}
                    className="p-2 rounded-full bg-slate-800/50 hover:bg-slate-700/50 text-slate-300 hover:text-white transition-all border border-slate-700 hover:border-slate-500 backdrop-blur-sm"
                    title="Sign out"
                >
                    <LogOut className="w-5 h-5" />
                </button>
            </div>

            {/* Main Content */}
            <div className="z-10 w-full max-w-5xl">
                <div className="text-center mb-16">
                    <h1 className="text-5xl md:text-6xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-blue-500 mb-6 tracking-tight">
                        EPC 인사이트 <span className="text-slate-100">AI</span>
                    </h1>
                    <p className="text-slate-400 text-lg md:text-xl max-w-2xl mx-auto font-light leading-relaxed">
                        작업 공간을 선택하여 시작하세요. 엔지니어링 문서를 분석하거나 지식 자산을 관리할 수 있습니다.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-8 px-4">
                    {/* Card 1: Drawing Analysis AI */}
                    <div
                        onClick={() => navigate('/drawing-ai')}
                        className="group relative cursor-pointer"
                    >
                        <div className="absolute -inset-0.5 bg-gradient-to-r from-emerald-500 to-teal-500 rounded-2xl opacity-20 group-hover:opacity-100 blur transition duration-500"></div>
                        <div className="relative h-full bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 hover:border-emerald-500/50 transition-all duration-300 transform group-hover:-translate-y-1">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                <FileSearch className="w-8 h-8 text-emerald-400" />
                            </div>

                            <h2 className="text-2xl font-bold text-slate-100 mb-3 group-hover:text-emerald-400 transition-colors">
                                도면 분석 AI
                            </h2>
                            <p className="text-slate-400 mb-8 leading-relaxed">
                                P&ID 및 엔지니어링 도면을 위한 AI 기반 분석.
                                태그 추출, 로직 해석, 교차 참조 검색을 자동으로 수행합니다.
                            </p>

                            <div className="flex items-center text-emerald-400 font-medium group-hover:translate-x-2 transition-transform">
                                애플리케이션 실행 <ArrowRight className="w-4 h-4 ml-2" />
                            </div>
                        </div>
                    </div>

                    {/* Card 2: Know-how DB */}
                    <div
                        onClick={() => navigate('/knowhow-db')}
                        className="group relative cursor-pointer"
                    >
                        <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-500 to-indigo-500 rounded-2xl opacity-20 group-hover:opacity-100 blur transition duration-500"></div>
                        <div className="relative h-full bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 hover:border-blue-500/50 transition-all duration-300 transform group-hover:-translate-y-1">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500/20 to-indigo-500/20 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                <Database className="w-8 h-8 text-blue-400" />
                            </div>

                            <h2 className="text-2xl font-bold text-slate-100 mb-3 group-hover:text-blue-400 transition-colors">
                                Know-how DB
                            </h2>
                            <p className="text-slate-400 mb-8 leading-relaxed">
                                중앙 집중식 지식 저장소. 기술 사양,
                                교훈 및 엔지니어링 표준을 효율적으로 관리합니다.
                            </p>

                            <div className="flex items-center text-blue-400 font-medium group-hover:translate-x-2 transition-transform">
                                데이터베이스 접속 <ArrowRight className="w-4 h-4 ml-2" />
                            </div>
                        </div>
                    </div>

                    {/* Card 3: P&ID Line List */}
                    <div
                        onClick={() => navigate('/line-list')}
                        className="group relative cursor-pointer"
                    >
                        <div className="absolute -inset-0.5 bg-gradient-to-r from-amber-500 to-orange-500 rounded-2xl opacity-20 group-hover:opacity-100 blur transition duration-500"></div>
                        <div className="relative h-full bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 hover:border-amber-500/50 transition-all duration-300 transform group-hover:-translate-y-1">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                <ListChecks className="w-8 h-8 text-amber-400" />
                            </div>

                            <h2 className="text-2xl font-bold text-slate-100 mb-3 group-hover:text-amber-400 transition-colors">
                                P&ID Line List
                            </h2>
                            <p className="text-slate-400 mb-8 leading-relaxed">
                                P&ID 도면에서 라인 넘버, 장비 연결 정보를
                                자동 추출하여 Line List 테이블을 생성합니다.
                            </p>

                            <div className="flex items-center text-amber-400 font-medium group-hover:translate-x-2 transition-transform">
                                라인 리스트 추출 <ArrowRight className="w-4 h-4 ml-2" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Footer */}
            <div className="absolute bottom-6 text-slate-600 text-sm">
                &copy; {new Date().getFullYear()} EPC Insight AI System. All rights reserved.
            </div>
        </div>
    );
};

export default LandingPage;
