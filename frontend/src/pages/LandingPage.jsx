import React from 'react';
import { useNavigate } from 'react-router-dom';
import { FileSearch, Database, ArrowRight, LogOut, ListChecks, BookOpen, ClipboardCheck, Landmark, MessageSquareText } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const APPS = [
    {
        title: '도면 분석 AI',
        desc: 'P&ID 및 엔지니어링 도면을 위한 AI 기반 분석. 태그 추출, 로직 해석, 교차 참조 검색.',
        link: '/drawing-ai',
        cta: '애플리케이션 실행',
        icon: FileSearch,
        gradient: 'from-emerald-500 to-teal-500',
        iconBg: 'from-emerald-500/20 to-teal-500/20',
        text: 'text-emerald-400', border: 'hover:border-emerald-500/50',
    },
    {
        title: 'Know-how DB',
        desc: '중앙 집중식 지식 저장소. 기술 사양, 교훈 및 엔지니어링 표준을 효율적으로 관리.',
        link: '/knowhow-db',
        cta: '데이터베이스 접속',
        icon: Database,
        gradient: 'from-blue-500 to-indigo-500',
        iconBg: 'from-blue-500/20 to-indigo-500/20',
        text: 'text-blue-400', border: 'hover:border-blue-500/50',
    },
    {
        title: 'P&ID Line List',
        desc: 'P&ID 도면에서 라인 넘버, 장비 연결 정보를 자동 추출하여 Line List 테이블 생성.',
        link: '/line-list',
        cta: '라인 리스트 추출',
        icon: ListChecks,
        gradient: 'from-amber-500 to-orange-500',
        iconBg: 'from-amber-500/20 to-orange-500/20',
        text: 'text-amber-400', border: 'hover:border-amber-500/50',
    },
    {
        title: 'Lessons Learned AI',
        desc: '프로젝트 경험과 교훈을 AI로 검색하고 분석. 과거 사례 기반 의사결정을 지원.',
        link: '/lessons-learned',
        cta: '레슨런 분석 시작',
        icon: BookOpen,
        gradient: 'from-purple-500 to-violet-500',
        iconBg: 'from-purple-500/20 to-violet-500/20',
        text: 'text-purple-400', border: 'hover:border-purple-500/50',
    },
    {
        title: 'Revision Master',
        desc: '준공 문서 리비전 관리. 사양서에서 문서 목록을 자동 추출하고 Phase별 진행률 추적.',
        link: '/revision-master',
        cta: '리비전 관리 시작',
        icon: ClipboardCheck,
        gradient: 'from-cyan-500 to-teal-500',
        iconBg: 'from-cyan-500/20 to-teal-500/20',
        text: 'text-cyan-400', border: 'hover:border-cyan-500/50',
    },
    {
        title: '국가건설기준 AI',
        desc: '국가건설기준(KDS/KCS) 실시간 검색 및 AI 해석. 설계·시공 기준 조항을 찾아 설명.',
        link: '/kcsc-standards',
        cta: '건설기준 검색',
        icon: Landmark,
        gradient: 'from-rose-500 to-pink-500',
        iconBg: 'from-rose-500/20 to-pink-500/20',
        text: 'text-rose-400', border: 'hover:border-rose-500/50',
    },
    {
        title: 'PDF 코멘트 추출',
        desc: 'PDF 주석(Annotation)을 자동 추출하여 테이블로 정리. 편집 후 Excel 내보내기.',
        link: '/comment-extractor',
        cta: '코멘트 추출 시작',
        icon: MessageSquareText,
        gradient: 'from-lime-500 to-green-500',
        iconBg: 'from-lime-500/20 to-green-500/20',
        text: 'text-lime-400', border: 'hover:border-lime-500/50',
    },
];

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
        <div className="h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex flex-col items-center justify-center p-4 relative overflow-hidden">
            {/* Background Ambient Effects */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-500/10 rounded-full blur-[120px] animate-pulse" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/10 rounded-full blur-[120px] animate-pulse delay-1000" />
            </div>

            {/* Header / User Info */}
            <div className="absolute top-4 right-6 flex items-center gap-3 z-10">
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
                <div className="text-center mb-8">
                    <h1 className="text-4xl md:text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-blue-500 mb-3 tracking-tight">
                        EPC 인사이트 <span className="text-slate-100">AI</span>
                    </h1>
                    <p className="text-slate-400 text-base md:text-lg max-w-2xl mx-auto font-light leading-relaxed">
                        작업 공간을 선택하여 시작하세요. 엔지니어링 문서를 분석하거나 지식 자산을 관리할 수 있습니다.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 px-2">
                    {APPS.map((app) => {
                        const Icon = app.icon;
                        return (
                            <div
                                key={app.link}
                                onClick={() => window.open(app.link, '_blank')}
                                className="group relative cursor-pointer"
                            >
                                <div className={`absolute -inset-0.5 bg-gradient-to-r ${app.gradient} rounded-xl opacity-20 group-hover:opacity-100 blur transition duration-500`}></div>
                                <div className={`relative h-full bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-xl p-5 ${app.border} transition-all duration-300 transform group-hover:-translate-y-1`}>
                                    <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${app.iconBg} flex items-center justify-center mb-3 group-hover:scale-110 transition-transform duration-300`}>
                                        <Icon className={`w-5 h-5 ${app.text}`} />
                                    </div>

                                    <h2 className="text-base font-bold text-slate-100 mb-1.5 transition-colors">
                                        {app.title}
                                    </h2>
                                    <p className="text-slate-400 text-xs mb-4 leading-relaxed line-clamp-2">
                                        {app.desc}
                                    </p>

                                    <div className={`flex items-center ${app.text} text-xs font-medium group-hover:translate-x-1 transition-transform`}>
                                        {app.cta} <ArrowRight className="w-3.5 h-3.5 ml-1" />
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Footer */}
            <div className="absolute bottom-4 text-slate-600 text-xs">
                &copy; {new Date().getFullYear()} EPC Insight AI System. All rights reserved.
            </div>
        </div>
    );
};

export default LandingPage;
