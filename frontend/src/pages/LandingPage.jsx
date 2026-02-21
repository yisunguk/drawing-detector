import React from 'react';
import { useNavigate } from 'react-router-dom';
import { FileSearch, Database, ArrowRight, LogOut, LayoutGrid, ListChecks, BookOpen, ClipboardCheck, Landmark, MessageSquareText, Scale, Layers } from 'lucide-react';
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
            <div className="z-10 w-full max-w-7xl">
                <div className="text-center mb-16">
                    <h1 className="text-5xl md:text-6xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-blue-500 mb-6 tracking-tight">
                        EPC 인사이트 <span className="text-slate-100">AI</span>
                    </h1>
                    <p className="text-slate-400 text-lg md:text-xl max-w-2xl mx-auto font-light leading-relaxed">
                        작업 공간을 선택하여 시작하세요. 엔지니어링 문서를 분석하거나 지식 자산을 관리할 수 있습니다.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 px-4">
                    {/* Card 1: Drawing Analysis AI */}
                    <div
                        onClick={() => window.open('/drawing-ai', '_blank')}
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
                        onClick={() => window.open('/knowhow-db', '_blank')}
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
                                레슨런 및 엔지니어링 표준을 효율적으로 관리합니다.
                            </p>

                            <div className="flex items-center text-blue-400 font-medium group-hover:translate-x-2 transition-transform">
                                데이터베이스 접속 <ArrowRight className="w-4 h-4 ml-2" />
                            </div>
                        </div>
                    </div>

                    {/* Card 3: P&ID Line List */}
                    <div
                        onClick={() => window.open('/line-list', '_blank')}
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

                    {/* Card 4: Lessons Learned AI */}
                    <div
                        onClick={() => window.open('/lessons-learned', '_blank')}
                        className="group relative cursor-pointer"
                    >
                        <div className="absolute -inset-0.5 bg-gradient-to-r from-purple-500 to-violet-500 rounded-2xl opacity-20 group-hover:opacity-100 blur transition duration-500"></div>
                        <div className="relative h-full bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 hover:border-purple-500/50 transition-all duration-300 transform group-hover:-translate-y-1">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500/20 to-violet-500/20 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                <BookOpen className="w-8 h-8 text-purple-400" />
                            </div>

                            <h2 className="text-2xl font-bold text-slate-100 mb-3 group-hover:text-purple-400 transition-colors">
                                Lessons Learned AI
                            </h2>
                            <p className="text-slate-400 mb-8 leading-relaxed">
                                프로젝트 경험과 교훈을 AI로 검색하고 분석합니다.
                                과거 사례 기반 의사결정을 지원합니다.
                            </p>

                            <div className="flex items-center text-purple-400 font-medium group-hover:translate-x-2 transition-transform">
                                레슨런 분석 시작 <ArrowRight className="w-4 h-4 ml-2" />
                            </div>
                        </div>
                    </div>

                    {/* Card 5: Revision Master */}
                    <div
                        onClick={() => window.open('/revision-master', '_blank')}
                        className="group relative cursor-pointer"
                    >
                        <div className="absolute -inset-0.5 bg-gradient-to-r from-cyan-500 to-teal-500 rounded-2xl opacity-20 group-hover:opacity-100 blur transition duration-500"></div>
                        <div className="relative h-full bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 hover:border-cyan-500/50 transition-all duration-300 transform group-hover:-translate-y-1">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-teal-500/20 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                <ClipboardCheck className="w-8 h-8 text-cyan-400" />
                            </div>

                            <h2 className="text-2xl font-bold text-slate-100 mb-3 group-hover:text-cyan-400 transition-colors">
                                발주처 제출 문서관리
                            </h2>
                            <p className="text-slate-400 mb-8 leading-relaxed">
                                발주처 제출 문서 관리. 사양서에서 문서 목록을
                                자동 추출하고 Phase별 진행률을 추적합니다.
                            </p>

                            <div className="flex items-center text-cyan-400 font-medium group-hover:translate-x-2 transition-transform">
                                문서관리 시작 <ArrowRight className="w-4 h-4 ml-2" />
                            </div>
                        </div>
                    </div>

                    {/* Card 6: KCSC 건설기준 AI */}
                    <div
                        onClick={() => window.open('/kcsc-standards', '_blank')}
                        className="group relative cursor-pointer"
                    >
                        <div className="absolute -inset-0.5 bg-gradient-to-r from-rose-500 to-pink-500 rounded-2xl opacity-20 group-hover:opacity-100 blur transition duration-500"></div>
                        <div className="relative h-full bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 hover:border-rose-500/50 transition-all duration-300 transform group-hover:-translate-y-1">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-rose-500/20 to-pink-500/20 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                <Landmark className="w-8 h-8 text-rose-400" />
                            </div>

                            <h2 className="text-2xl font-bold text-slate-100 mb-3 group-hover:text-rose-400 transition-colors">
                                국가건설기준 AI
                            </h2>
                            <p className="text-slate-400 mb-8 leading-relaxed">
                                국가건설기준(KDS/KCS) 실시간 검색 및 AI 해석.
                                설계·시공 기준을 질문하면 관련 조항을 찾아 설명합니다.
                            </p>

                            <div className="flex items-center text-rose-400 font-medium group-hover:translate-x-2 transition-transform">
                                건설기준 검색 <ArrowRight className="w-4 h-4 ml-2" />
                            </div>
                        </div>
                    </div>
                    {/* Card 7: PDF 코멘트 추출 */}
                    <div
                        onClick={() => window.open('/comment-extractor', '_blank')}
                        className="group relative cursor-pointer"
                    >
                        <div className="absolute -inset-0.5 bg-gradient-to-r from-lime-500 to-green-500 rounded-2xl opacity-20 group-hover:opacity-100 blur transition duration-500"></div>
                        <div className="relative h-full bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 hover:border-lime-500/50 transition-all duration-300 transform group-hover:-translate-y-1">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-lime-500/20 to-green-500/20 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                <MessageSquareText className="w-8 h-8 text-lime-400" />
                            </div>

                            <h2 className="text-2xl font-bold text-slate-100 mb-3 group-hover:text-lime-400 transition-colors">
                                설계 코멘트 관리
                            </h2>
                            <p className="text-slate-400 mb-8 leading-relaxed">
                                PDF 주석(Annotation)을 자동 추출하여 테이블로 정리합니다.
                                코멘트 편집, 답변 입력 후 Excel로 내보내기합니다.
                            </p>

                            <div className="flex items-center text-lime-400 font-medium group-hover:translate-x-2 transition-transform">
                                코멘트 관리 시작 <ArrowRight className="w-4 h-4 ml-2" />
                            </div>
                        </div>
                    </div>
                    {/* Card 8: 계약 Deviation 관리 */}
                    <div
                        onClick={() => window.open('/contract-deviation', '_blank')}
                        className="group relative cursor-pointer"
                    >
                        <div className="absolute -inset-0.5 bg-gradient-to-r from-indigo-500 to-sky-500 rounded-2xl opacity-20 group-hover:opacity-100 blur transition duration-500"></div>
                        <div className="relative h-full bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 hover:border-indigo-500/50 transition-all duration-300 transform group-hover:-translate-y-1">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-sky-500/20 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                <Scale className="w-8 h-8 text-indigo-400" />
                            </div>

                            <h2 className="text-2xl font-bold text-slate-100 mb-3 group-hover:text-indigo-400 transition-colors">
                                계약 Deviation 관리
                            </h2>
                            <p className="text-slate-400 mb-8 leading-relaxed">
                                계약서 PDF에서 조항을 자동 추출하고 발주처-시공사 간
                                Deviation 협의 이력을 체계적으로 관리합니다.
                            </p>

                            <div className="flex items-center text-indigo-400 font-medium group-hover:translate-x-2 transition-transform">
                                Deviation 관리 시작 <ArrowRight className="w-4 h-4 ml-2" />
                            </div>
                        </div>
                    </div>
                    {/* Card 9: 도면 리비전 관리 */}
                    <div
                        onClick={() => window.open('/plantsync', '_blank')}
                        className="group relative cursor-pointer"
                    >
                        <div className="absolute -inset-0.5 bg-gradient-to-r from-sky-500 to-cyan-500 rounded-2xl opacity-20 group-hover:opacity-100 blur transition duration-500"></div>
                        <div className="relative h-full bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 hover:border-sky-500/50 transition-all duration-300 transform group-hover:-translate-y-1">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-sky-500/20 to-cyan-500/20 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                <Layers className="w-8 h-8 text-sky-400" />
                            </div>

                            <h2 className="text-2xl font-bold text-slate-100 mb-3 group-hover:text-sky-400 transition-colors">
                                도면 리비전 관리
                            </h2>
                            <p className="text-slate-400 mb-8 leading-relaxed">
                                플랜트 도면 리비전 관리 및 디시플린별 협업 마크업.
                                Title Block AI 추출, 리뷰 워크플로우, EM 승인을 지원합니다.
                            </p>

                            <div className="flex items-center text-sky-400 font-medium group-hover:translate-x-2 transition-transform">
                                도면 관리 시작 <ArrowRight className="w-4 h-4 ml-2" />
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
