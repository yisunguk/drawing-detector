import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2, Columns, Maximize } from 'lucide-react';

/**
 * SharedPDFViewer — zoom/pan/render logic copied verbatim from PDFViewer.jsx.
 * Drop-in for KnowhowDB & LineList so behaviour is 100 % identical.
 *
 * Props
 * ─────
 *  pdfDoc            pdf.js PDFDocumentProxy (already loaded)
 *  page              current page number (1-based)
 *  totalPages        total page count
 *  onPageChange      (newPage) => void
 *  overlay           (canvasSize) => ReactNode   – optional SVG highlights etc.
 *  onViewportChange  (viewport) => void          – called after each render
 *  onCanvasSizeChange({w,h}) => void
 *  showFitButtons    boolean – Fit Width / Fit Page buttons
 *  loading           boolean – external "fetching PDF" indicator
 *  theme             'light' | 'dark'
 */
const SharedPDFViewer = ({
    pdfDoc,
    page = 1,
    totalPages = 0,
    onPageChange,
    overlay,
    onViewportChange,
    onCanvasSizeChange,
    showFitButtons = false,
    loading = false,
    theme = 'light',
}) => {
    // ── state (identical to PDFViewer) ──────────────────────────
    const [zoom, setZoom] = useState(1.2);
    const [renderZoom, setRenderZoom] = useState(1.2);
    const [isLoading, setIsLoading] = useState(false);
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

    const canvasRef = useRef(null);
    const containerRef = useRef(null);
    const renderTaskRef = useRef(null);
    const viewportRef = useRef(null);
    const baseViewportRef = useRef(null);

    // stable refs for callbacks so loadAndRenderPage has [] deps
    const onViewportChangeRef = useRef(onViewportChange);
    const onCanvasSizeChangeRef = useRef(onCanvasSizeChange);
    useEffect(() => { onViewportChangeRef.current = onViewportChange; }, [onViewportChange]);
    useEffect(() => { onCanvasSizeChangeRef.current = onCanvasSizeChange; }, [onCanvasSizeChange]);

    // ── debounce zoom (identical to PDFViewer) ──────────────────
    useEffect(() => {
        const timer = setTimeout(() => {
            setRenderZoom(zoom);
        }, 300);
        return () => clearTimeout(timer);
    }, [zoom]);

    // ── render (identical to PDFViewer.loadAndRenderPage) ───────
    const loadAndRenderPage = useCallback(async (doc, pageNum, renderScale) => {
        if (!doc || !canvasRef.current) return;
        setIsLoading(true);

        try {
            const pdfPage = await doc.getPage(pageNum);

            // store base viewport for fit-width / fit-page
            baseViewportRef.current = pdfPage.getViewport({ scale: 1 });

            const viewport = pdfPage.getViewport({ scale: renderScale });
            viewportRef.current = viewport;
            onViewportChangeRef.current?.(viewport);

            const offscreenCanvas = document.createElement('canvas');
            offscreenCanvas.width = viewport.width;
            offscreenCanvas.height = viewport.height;
            const offscreenCtx = offscreenCanvas.getContext('2d');

            const renderContext = { canvasContext: offscreenCtx, viewport };

            if (renderTaskRef.current) {
                try { renderTaskRef.current.cancel(); } catch (e) { }
            }

            const renderTask = pdfPage.render(renderContext);
            renderTaskRef.current = renderTask;

            try {
                await renderTask.promise;
                if (renderTaskRef.current === renderTask) {
                    const mainCanvas = canvasRef.current;
                    if (mainCanvas) {
                        mainCanvas.width = viewport.width;
                        mainCanvas.height = viewport.height;
                        const mainCtx = mainCanvas.getContext('2d');
                        if (mainCtx) {
                            mainCtx.drawImage(offscreenCanvas, 0, 0);
                        }
                    }
                    const newSize = { width: viewport.width, height: viewport.height };
                    setCanvasSize(newSize);
                    onCanvasSizeChangeRef.current?.(newSize);
                    renderTaskRef.current = null;
                }
            } catch (err) {
                if (err.name === 'RenderingCancelledException') return;
                throw err;
            }

            setIsLoading(false);
        } catch (err) {
            console.error('[SharedPDFViewer] Render error:', err);
            setIsLoading(false);
        }
    }, []);   // ← [] like PDFViewer's [rotation] but we don't have rotation

    // re-render when page or renderZoom changes
    useEffect(() => {
        if (pdfDoc) {
            loadAndRenderPage(pdfDoc, page, renderZoom);
        }
    }, [pdfDoc, page, renderZoom, loadAndRenderPage]);

    // ── wheel zoom (identical to PDFViewer) ─────────────────────
    const handleWheel = useCallback((e) => {
        e.preventDefault();
        const delta = -e.deltaY;
        setZoom(prevZoom => {
            let newZoom = prevZoom + (delta > 0 ? 0.1 : -0.1);
            return Math.min(Math.max(0.5, newZoom), 5.0);
        });
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (container) {
            const preventDefaultWheel = (e) => e.preventDefault();
            container.addEventListener('wheel', preventDefaultWheel, { passive: false });
            return () => container.removeEventListener('wheel', preventDefaultWheel);
        }
    }, []);

    // ── mouse pan/drag (identical to PDFViewer – plain functions) ─
    const [isDragging, setIsDragging] = useState(false);
    const dragStart = useRef({ x: 0, y: 0, left: 0, top: 0 });

    const handleMouseDown = (e) => {
        setIsDragging(true);
        const container = containerRef.current;
        dragStart.current = {
            x: e.clientX,
            y: e.clientY,
            left: container.scrollLeft,
            top: container.scrollTop
        };
        container.style.cursor = 'grabbing';
    };

    const handleMouseMove = (e) => {
        if (!isDragging) return;
        const container = containerRef.current;
        const dx = e.clientX - dragStart.current.x;
        const dy = e.clientY - dragStart.current.y;
        container.scrollLeft = dragStart.current.left - dx;
        container.scrollTop = dragStart.current.top - dy;
    };

    const handleMouseUp = () => {
        setIsDragging(false);
        if (containerRef.current) containerRef.current.style.cursor = 'grab';
    };

    const handleMouseLeave = () => {
        setIsDragging(false);
        if (containerRef.current) containerRef.current.style.cursor = 'default';
    };

    // ── fit-width / fit-page ────────────────────────────────────
    const handleFitWidth = useCallback(() => {
        if (!containerRef.current || !baseViewportRef.current) return;
        const containerWidth = containerRef.current.clientWidth - 96;
        const baseWidth = baseViewportRef.current.width;
        setZoom(Math.max(0.3, Math.min(5, +(containerWidth / baseWidth).toFixed(2))));
    }, []);

    const handleFitPage = useCallback(() => {
        if (!containerRef.current || !baseViewportRef.current) return;
        const cw = containerRef.current.clientWidth - 96;
        const ch = containerRef.current.clientHeight - 96;
        const bw = baseViewportRef.current.width;
        const bh = baseViewportRef.current.height;
        setZoom(Math.max(0.3, Math.min(5, +(Math.min(cw / bw, ch / bh)).toFixed(2))));
    }, []);

    // ── CSS scale (identical to PDFViewer) ──────────────────────
    const cssScale = zoom / renderZoom;

    // ── theme classes ───────────────────────────────────────────
    const isLight = theme === 'light';
    const toolbarCls = isLight
        ? 'border-b border-[#e5e1d8] bg-[#fcfaf7]'
        : 'border-b border-slate-700 bg-slate-800/80';
    const btnCls = isLight
        ? 'p-1 hover:bg-gray-200 rounded disabled:opacity-30'
        : 'p-1 hover:bg-slate-700 rounded disabled:opacity-30 transition-colors';
    const textCls = isLight ? 'text-xs text-gray-600 font-medium' : 'text-xs text-slate-400 font-medium';
    const zoomTextCls = isLight ? 'text-xs text-gray-500 w-10 text-center' : 'text-xs text-slate-400 w-10 text-center';
    const dividerCls = isLight ? 'w-px h-4 bg-gray-300 mx-1' : 'w-px h-4 bg-slate-600 mx-1';
    const containerBg = isLight ? 'bg-[#f4f1ea]' : 'bg-slate-900';

    // ── JSX (identical structure to PDFViewer) ──────────────────
    return (
        <>
            {/* Toolbar */}
            <div className={`h-10 flex items-center justify-center gap-3 px-4 flex-shrink-0 ${toolbarCls}`}>
                <button onClick={() => onPageChange?.(Math.max(1, page - 1))} disabled={page <= 1} className={btnCls}>
                    <ChevronLeft size={14} />
                </button>
                <span className={`${textCls} min-w-[60px] text-center`}>{page} / {totalPages}</span>
                <button onClick={() => onPageChange?.(Math.min(totalPages, page + 1))} disabled={page >= totalPages} className={btnCls}>
                    <ChevronRight size={14} />
                </button>
                <div className={dividerCls} />
                <button onClick={() => setZoom(z => Math.max(0.3, +(z - 0.2).toFixed(1)))} className={btnCls}>
                    <ZoomOut size={14} />
                </button>
                <span className={zoomTextCls}>{Math.round(zoom * 100)}%</span>
                <button onClick={() => setZoom(z => Math.min(5, +(z + 0.2).toFixed(1)))} className={btnCls}>
                    <ZoomIn size={14} />
                </button>
                {showFitButtons && (
                    <>
                        <div className={dividerCls} />
                        <button onClick={handleFitWidth} className={btnCls} title="너비 맞춤"><Columns size={14} /></button>
                        <button onClick={handleFitPage} className={btnCls} title="페이지 맞춤"><Maximize size={14} /></button>
                    </>
                )}
            </div>

            {/* Scrollable Container — identical to PDFViewer */}
            <div
                ref={containerRef}
                className={`relative w-full h-full ${containerBg} overflow-auto cursor-grab p-12`}
                onWheel={handleWheel}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
            >
                {(loading || isLoading) && (
                    <div className={`absolute inset-0 flex flex-col items-center justify-center ${containerBg}/80 z-20 transition-opacity`}>
                        <Loader2 className="w-8 h-8 animate-spin text-[#d97757] mb-2" />
                        <span className="text-xs text-[#d97757] font-medium">Loading...</span>
                    </div>
                )}

                {/* Scaling Layer — identical to PDFViewer */}
                <div
                    className="relative mx-auto mb-8 shadow-2xl transition-transform duration-100 ease-out"
                    style={{
                        width: canvasSize.width,
                        height: canvasSize.height,
                        transform: `scale(${cssScale})`,
                        transformOrigin: '0 0'
                    }}
                >
                    <canvas
                        ref={canvasRef}
                        className="block bg-white"
                        style={{ width: canvasSize.width, height: canvasSize.height }}
                    />
                    {overlay?.(canvasSize)}
                </div>
            </div>
        </>
    );
};

export default SharedPDFViewer;
