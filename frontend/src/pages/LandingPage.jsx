import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileSearch, Database, ArrowRight, LogOut, ListChecks, BookOpen, ClipboardCheck, Landmark, MessageSquareText, Scale, Layers, Settings, ChevronUp, ChevronDown, Save, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';

// ── 9개 앱 카드 데이터 정의 ──
const APP_CARDS = [
    {
        id: 'drawing-ai',
        title: '도면 분석 AI',
        path: '/drawing-ai',
        icon: FileSearch,
        gradient: 'from-emerald-500 to-teal-500',
        iconBg: 'from-emerald-500/20 to-teal-500/20',
        iconColor: 'text-emerald-400',
        hoverBorder: 'hover:border-emerald-500/50',
        description: 'P&ID 및 엔지니어링 도면을 위한 AI 기반 분석.\n태그 추출, 로직 해석, 교차 참조 검색을 자동으로 수행합니다.',
        cta: '애플리케이션 실행',
    },
    {
        id: 'knowhow-db',
        title: 'Know-how DB',
        path: '/knowhow-db',
        icon: Database,
        gradient: 'from-blue-500 to-indigo-500',
        iconBg: 'from-blue-500/20 to-indigo-500/20',
        iconColor: 'text-blue-400',
        hoverBorder: 'hover:border-blue-500/50',
        description: '중앙 집중식 지식 저장소. 기술 사양,\n레슨런 및 엔지니어링 표준을 효율적으로 관리합니다.',
        cta: '데이터베이스 접속',
    },
    {
        id: 'line-list',
        title: 'P&ID Line List',
        path: '/line-list',
        icon: ListChecks,
        gradient: 'from-amber-500 to-orange-500',
        iconBg: 'from-amber-500/20 to-orange-500/20',
        iconColor: 'text-amber-400',
        hoverBorder: 'hover:border-amber-500/50',
        description: 'P&ID 도면에서 라인 넘버, 장비 연결 정보를\n자동 추출하여 Line List 테이블을 생성합니다.',
        cta: '라인 리스트 추출',
    },
    {
        id: 'lessons-learned',
        title: 'DOC-Master AI 분석',
        path: '/lessons-learned',
        icon: BookOpen,
        gradient: 'from-purple-500 to-violet-500',
        iconBg: 'from-purple-500/20 to-violet-500/20',
        iconColor: 'text-purple-400',
        hoverBorder: 'hover:border-purple-500/50',
        description: '프로젝트 경험과 교훈을 AI로 검색하고 분석합니다.\n과거 사례 기반 의사결정을 지원합니다.',
        cta: '레슨런 분석 시작',
    },
    {
        id: 'revision-master',
        title: '발주처 제출 문서관리',
        path: '/revision-master',
        icon: ClipboardCheck,
        gradient: 'from-cyan-500 to-teal-500',
        iconBg: 'from-cyan-500/20 to-teal-500/20',
        iconColor: 'text-cyan-400',
        hoverBorder: 'hover:border-cyan-500/50',
        description: '발주처 제출 문서 관리. 사양서에서 문서 목록을\n자동 추출하고 Phase별 진행률을 추적합니다.',
        cta: '문서관리 시작',
    },
    {
        id: 'kcsc-standards',
        title: '국가건설기준 AI',
        path: '/kcsc-standards',
        icon: Landmark,
        gradient: 'from-rose-500 to-pink-500',
        iconBg: 'from-rose-500/20 to-pink-500/20',
        iconColor: 'text-rose-400',
        hoverBorder: 'hover:border-rose-500/50',
        description: '국가건설기준(KDS/KCS) 실시간 검색 및 AI 해석.\n설계·시공 기준을 질문하면 관련 조항을 찾아 설명합니다.',
        cta: '건설기준 검색',
    },
    {
        id: 'comment-extractor',
        title: '설계 코멘트 관리',
        path: '/comment-extractor',
        icon: MessageSquareText,
        gradient: 'from-lime-500 to-green-500',
        iconBg: 'from-lime-500/20 to-green-500/20',
        iconColor: 'text-lime-400',
        hoverBorder: 'hover:border-lime-500/50',
        description: 'PDF 주석(Annotation)을 자동 추출하여 테이블로 정리합니다.\n코멘트 편집, 답변 입력 후 Excel로 내보내기합니다.',
        cta: '코멘트 관리 시작',
    },
    {
        id: 'contract-deviation',
        title: '계약 Deviation 관리',
        path: '/contract-deviation',
        icon: Scale,
        gradient: 'from-indigo-500 to-sky-500',
        iconBg: 'from-indigo-500/20 to-sky-500/20',
        iconColor: 'text-indigo-400',
        hoverBorder: 'hover:border-indigo-500/50',
        description: '계약서 PDF에서 조항을 자동 추출하고 발주처-시공사 간\nDeviation 협의 이력을 체계적으로 관리합니다.',
        cta: 'Deviation 관리 시작',
    },
    {
        id: 'plantsync',
        title: '도면 마크업 관리',
        path: '/plantsync',
        icon: Layers,
        gradient: 'from-sky-500 to-cyan-500',
        iconBg: 'from-sky-500/20 to-cyan-500/20',
        iconColor: 'text-sky-400',
        hoverBorder: 'hover:border-sky-500/50',
        description: '플랜트 도면 마크업 관리 및 디시플린별 협업 마크업.\nTitle Block AI 추출, 리뷰 워크플로우, EM 승인을 지원합니다.',
        cta: '도면 관리 시작',
    },
];

const DEFAULT_ORDER = APP_CARDS.map(c => c.id);

const LandingPage = () => {
    const navigate = useNavigate();
    const { logout, currentUser } = useAuth();
    const isAdmin = currentUser?.email === 'admin@poscoenc.com';

    const [cardOrder, setCardOrder] = useState(DEFAULT_ORDER);
    const [isEditing, setIsEditing] = useState(false);
    const [editOrder, setEditOrder] = useState(DEFAULT_ORDER);
    const [saving, setSaving] = useState(false);

    // Firestore에서 앱 순서 로드
    useEffect(() => {
        const loadOrder = async () => {
            try {
                const snap = await getDoc(doc(db, 'settings', 'appOrder'));
                if (snap.exists() && Array.isArray(snap.data().order)) {
                    const saved = snap.data().order;
                    // 저장된 순서에 없는 새 앱은 뒤에 추가
                    const allIds = new Set(DEFAULT_ORDER);
                    const validSaved = saved.filter(id => allIds.has(id));
                    const missing = DEFAULT_ORDER.filter(id => !validSaved.includes(id));
                    setCardOrder([...validSaved, ...missing]);
                }
            } catch (err) {
                console.error('Failed to load app order:', err);
            }
        };
        loadOrder();
    }, []);

    // 순서에 따라 카드 배열 정렬
    const orderedCards = cardOrder.map(id => APP_CARDS.find(c => c.id === id)).filter(Boolean);
    const editOrderedCards = editOrder.map(id => APP_CARDS.find(c => c.id === id)).filter(Boolean);

    const handleLogout = async () => {
        try {
            await logout();
            navigate('/login');
        } catch (error) {
            console.error("Failed to log out", error);
        }
    };

    const startEditing = () => {
        setEditOrder([...cardOrder]);
        setIsEditing(true);
    };

    const cancelEditing = () => {
        setIsEditing(false);
    };

    const moveCard = useCallback((index, direction) => {
        setEditOrder(prev => {
            const next = [...prev];
            const targetIndex = index + direction;
            if (targetIndex < 0 || targetIndex >= next.length) return prev;
            [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
            return next;
        });
    }, []);

    const saveOrder = async () => {
        setSaving(true);
        try {
            await setDoc(doc(db, 'settings', 'appOrder'), { order: editOrder });
            setCardOrder(editOrder);
            setIsEditing(false);
        } catch (err) {
            console.error('Failed to save app order:', err);
            alert('순서 저장에 실패했습니다.');
        } finally {
            setSaving(false);
        }
    };

    const displayCards = isEditing ? editOrderedCards : orderedCards;

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex flex-col items-center justify-center p-6 relative overflow-hidden">
            {/* Background Ambient Effects */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-500/10 rounded-full blur-[120px] animate-pulse" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/10 rounded-full blur-[120px] animate-pulse delay-1000" />
            </div>

            {/* Header / User Info */}
            <div className="absolute top-6 right-8 flex items-center gap-4 z-10">
                {isAdmin && !isEditing && (
                    <button
                        onClick={startEditing}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/50 hover:bg-slate-700/50 text-slate-300 hover:text-white transition-all border border-slate-700 hover:border-slate-500 backdrop-blur-sm text-sm"
                        title="앱 순서 편집"
                    >
                        <Settings className="w-4 h-4" />
                        순서 편집
                    </button>
                )}
                {isEditing && (
                    <div className="flex items-center gap-2">
                        <button
                            onClick={saveOrder}
                            disabled={saving}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-all text-sm disabled:opacity-50"
                        >
                            <Save className="w-4 h-4" />
                            {saving ? '저장 중...' : '저장'}
                        </button>
                        <button
                            onClick={cancelEditing}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white transition-all text-sm"
                        >
                            <X className="w-4 h-4" />
                            취소
                        </button>
                    </div>
                )}
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
                        P&ID 설계지원 <span className="text-slate-100">AI</span>
                    </h1>
                    <p className="text-slate-400 text-lg md:text-xl max-w-2xl mx-auto font-light leading-relaxed">
                        P&ID 도면을 기반으로 설계 정보의 추출, 분석, 검증 및
                        <br className="hidden md:inline" />
                        지식 자산화를 통합 지원하는 엔지니어링 전문 AI 플랫폼입니다.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 px-4">
                    {displayCards.map((card, index) => {
                        const Icon = card.icon;
                        return (
                            <div
                                key={card.id}
                                onClick={isEditing ? undefined : () => window.open(card.path, '_blank')}
                                className={`group relative ${isEditing ? '' : 'cursor-pointer'}`}
                            >
                                <div className={`absolute -inset-0.5 bg-gradient-to-r ${card.gradient} rounded-2xl opacity-20 ${isEditing ? '' : 'group-hover:opacity-100'} blur transition duration-500`}></div>
                                <div className={`relative h-full bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 ${isEditing ? '' : `${card.hoverBorder} transition-all duration-300 transform group-hover:-translate-y-1`}`}>
                                    {/* 편집 모드: 위/아래 화살표 */}
                                    {isEditing && (
                                        <div className="absolute top-3 right-3 flex flex-col gap-1">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); moveCard(index, -1); }}
                                                disabled={index === 0}
                                                className="p-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                                title="위로 이동"
                                            >
                                                <ChevronUp className="w-4 h-4" />
                                            </button>
                                            <span className="text-xs text-slate-500 text-center">{index + 1}</span>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); moveCard(index, 1); }}
                                                disabled={index === displayCards.length - 1}
                                                className="p-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                                title="아래로 이동"
                                            >
                                                <ChevronDown className="w-4 h-4" />
                                            </button>
                                        </div>
                                    )}

                                    <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${card.iconBg} flex items-center justify-center mb-6 ${isEditing ? '' : 'group-hover:scale-110'} transition-transform duration-300`}>
                                        <Icon className={`w-8 h-8 ${card.iconColor}`} />
                                    </div>

                                    <h2 className={`text-2xl font-bold text-slate-100 mb-3 ${isEditing ? '' : `group-hover:${card.iconColor}`} transition-colors`}>
                                        {card.title}
                                    </h2>
                                    <p className="text-slate-400 mb-8 leading-relaxed">
                                        {card.description}
                                    </p>

                                    {!isEditing && (
                                        <div className={`flex items-center ${card.iconColor} font-medium group-hover:translate-x-2 transition-transform`}>
                                            {card.cta} <ArrowRight className="w-4 h-4 ml-2" />
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Footer */}
            <div className="absolute bottom-6 text-slate-600 text-sm">
                &copy; {new Date().getFullYear()} P&ID Design Support AI. All rights reserved.
            </div>
        </div>
    );
};

export default LandingPage;
