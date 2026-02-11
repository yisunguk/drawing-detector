import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCw, Loader2 } from 'lucide-react';

const PDFViewer = ({ doc, documents, activeDocData, onClose }) => {
    const [currentPage, setCurrentPage] = useState(doc?.page || 1);
    const [zoom, setZoom] = useState(1);
    const [renderZoom, setRenderZoom] = useState(1); // Debounced zoom for high-quality render
    const [rotation, setRotation] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [totalPages, setTotalPages] = useState(0);
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

    const canvasRef = useRef(null);
    const containerRef = useRef(null);
    const pdfCacheRef = useRef({});
    const renderTaskRef = useRef(null);
    const viewportRef = useRef(null);

    // Debounce zoom for rendering to prevent "dizzy" flicker
    useEffect(() => {
        const timer = setTimeout(() => {
            setRenderZoom(zoom);
        }, 300); // 300ms debounce
        return () => clearTimeout(timer);
    }, [zoom]);

    // Find document data
    const documentData = documents?.find(d => d.id === doc?.docId);

    // --- Highlighting Helpers ---
    const calculateScore = useCallback((content, search) => {
        if (!content || !search) return 0;
        const cleanContent = content.toLowerCase().trim();
        const cleanSearch = search.toLowerCase().trim();

        if (cleanContent === cleanSearch) return 100;
        if (cleanContent.includes(cleanSearch)) return 90;

        // Word-level matching
        const contentWords = cleanContent.split(/[^a-zA-Z0-9가-힣]+/).filter(w => w.length > 1);
        const searchWords = cleanSearch.split(/[^a-zA-Z0-9가-힣]+/).filter(w => w.length > 1);

        if (searchWords.length > 0) {
            const matches = searchWords.filter(sw => contentWords.some(cw => cw.includes(sw) || sw.includes(cw)));
            if (matches.length === searchWords.length) return 85;
            if (matches.length > 0) return 40 + (matches.length / searchWords.length * 40);
        }

        return 0;
    }, []);

    // Perform search on the current page
    const bestMatch = useMemo(() => {
        if (!doc?.term || !documentData) return null;

        const dataSource = activeDocData || documentData.ocrData || documentData.pdfTextData;
        if (!dataSource) return null;

        let pages = [];
        if (dataSource.analyzeResult?.pages) {
            pages = dataSource.analyzeResult.pages;
        } else if (Array.isArray(dataSource.pages)) {
            pages = dataSource.pages;
        } else if (Array.isArray(dataSource.ocrData)) {
            pages = dataSource.ocrData;
        } else if (Array.isArray(dataSource)) {
            pages = dataSource;
        } else {
            return null;
        }

        const pageData = pages.find(p => (p.page_number || p.pageIndex + 1) === currentPage) || pages[currentPage - 1];
        if (!pageData) return null;

        const lines = pageData.layout?.lines || pageData.lines || [];

        let topResult = null;
        let highestScore = 0;

        // 0. High-Precision Fallback: Use direct coordinates from index if available
        // This is extremely reliable for RAG results
        if (doc.coords && Array.isArray(doc.coords)) {
            const meta = pageData.metadata || {};
            console.log(`[PDFViewer] Using direct coordinates from index for "${doc.term}"`);
            return {
                content: doc.term,
                polygon: doc.coords,
                layoutWidth: meta.width || pageData.layout?.width || pageData.width || 1,
                layoutHeight: meta.height || pageData.layout?.height || pageData.height || 1,
                unit: meta.unit || pageData.unit || 'pixel',
                isDirectMatch: true
            };
        }

        // 1. Search in Lines (Preferred for general phrases)
        lines.forEach(line => {
            const lineContent = line.content || line.text;
            const score = calculateScore(lineContent, doc.term);
            if (score > highestScore) {
                highestScore = score;
                const meta = pageData.metadata || {};
                topResult = {
                    ...line,
                    content: lineContent,
                    polygon: line.polygon || line.boundingBox,
                    layoutWidth: meta.width || pageData.layout?.width || pageData.width || 0,
                    layoutHeight: meta.height || pageData.layout?.height || pageData.height || 0,
                    unit: meta.unit || pageData.unit || 'pixel'
                };
            }
        });

        // 2. Search in Words (Higher precision for technical tags)
        const words = pageData.layout?.words || pageData.words || [];
        words.forEach(word => {
            const wordContent = word.content || word.text;
            const score = calculateScore(wordContent, doc.term);
            if (score >= highestScore && score > 0) { // Prefer words if same score (usually more precise)
                highestScore = score;
                const meta = pageData.metadata || {};
                topResult = {
                    ...word,
                    content: wordContent,
                    polygon: word.polygon,
                    layoutWidth: meta.width || pageData.layout?.width || pageData.width || 0,
                    layoutHeight: meta.height || pageData.layout?.height || pageData.height || 0,
                    unit: meta.unit || pageData.unit || 'pixel'
                };
            }
        });

        // 3. Search in Table Cells (Crucial for spreadsheet-style docs)
        const tables = pageData.tables || [];
        tables.forEach(table => {
            const cells = table.cells || [];
            cells.forEach(cell => {
                const cellContent = cell.content;
                const score = calculateScore(cellContent, doc.term);
                if (score > highestScore) {
                    highestScore = score;
                    const meta = pageData.metadata || {};
                    topResult = {
                        ...cell,
                        content: cellContent,
                        polygon: cell.polygon,
                        layoutWidth: meta.width || pageData.layout?.width || pageData.width || 0,
                        layoutHeight: meta.height || pageData.layout?.height || pageData.height || 0,
                        unit: meta.unit || pageData.unit || 'pixel'
                    };
                }
            });
        });

        return highestScore > 60 ? topResult : null;
    }, [doc?.term, documentData, activeDocData, currentPage, calculateScore]);

    // Enhanced Coordinate Mapping
    const transformPoint = useCallback((x, y, layoutWidth, layoutHeight) => {
        if (!viewportRef.current) {
            const sx = canvasSize.width / (layoutWidth || canvasSize.width || 1);
            const sy = canvasSize.height / (layoutHeight || canvasSize.height || 1);
            return [x * sx, y * sy];
        }

        const viewport = viewportRef.current;
        const nx = x / (layoutWidth || 1);
        const ny = y / (layoutHeight || 1);

        // Map to PDF page view coordinates (internal PDF units, usually points)
        // viewBox is [x1, y1, x2, y2]
        const vX1 = viewport.viewBox[0];
        const vY1 = viewport.viewBox[1];
        const vX2 = viewport.viewBox[2];
        const vY2 = viewport.viewBox[3];

        const vWidth = vX2 - vX1;
        const vHeight = vY2 - vY1;

        // Correcting Y-flip: OCR (top-left) to PDF (bottom-left)
        // Ensure we account for non-zero viewBox origins (common in large drawings)
        const pdfX = vX1 + (nx * vWidth);
        const pdfY = vY2 - (ny * vHeight);

        return viewport.convertToViewportPoint(pdfX, pdfY);
    }, [canvasSize]);

    const getPolygonPoints = useCallback((result) => {
        if (!result || !result.polygon) return "";
        let p = result.polygon;
        if (Array.isArray(p[0])) p = p.flat();

        const lw = result.layoutWidth;
        const lh = result.layoutHeight;

        const points = [];
        for (let i = 0; i < p.length; i += 2) {
            const [px, py] = transformPoint(p[i], p[i + 1], lw, lh);
            points.push(`${px},${py}`);
        }
        return points.join(' ');
    }, [transformPoint]);

    const getSelectedCenter = useCallback((result) => {
        if (!result || !result.polygon) return null;
        let p = result.polygon;
        if (Array.isArray(p[0])) p = p.flat();

        const lw = result.layoutWidth;
        const lh = result.layoutHeight;

        let sumX = 0, sumY = 0;
        const count = p.length / 2;
        for (let i = 0; i < p.length; i += 2) {
            const [px, py] = transformPoint(p[i], p[i + 1], lw, lh);
            sumX += px;
            sumY += py;
        }

        return { cx: sumX / count, cy: sumY / count };
    }, [transformPoint]);

    const selectedCenter = useMemo(() => getSelectedCenter(bestMatch), [bestMatch, getSelectedCenter]);

    // Auto-scroll to highlight
    useEffect(() => {
        if (selectedCenter && containerRef.current) {
            const container = containerRef.current;
            // Immediate centering
            container.scrollTo({
                left: selectedCenter.cx - container.clientWidth / 2,
                top: selectedCenter.cy - container.clientHeight / 2,
                behavior: 'smooth'
            });
        }
    }, [selectedCenter]);

    const loadAndRenderPage = useCallback(async (docData, pageNum, renderScale) => {
        if (!window.pdfjsLib) return;
        if (!canvasRef.current || (!docData?.pdfData && !docData?.pdfUrl)) return;

        // We set loading true ONLY if we are doing a major scale/page change
        // to prevent stroboscopic effect during small zoom adjustments
        setIsLoading(true);

        try {
            let pdf = pdfCacheRef.current[docData.id];
            if (!pdf) {
                if (docData.pdfUrl) {
                    try {
                        const loadingTask = window.pdfjsLib.getDocument({
                            url: docData.pdfUrl,
                            cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
                            cMapPacked: true,
                            rangeChunkSize: 65536,
                        });
                        pdf = await loadingTask.promise;
                    } catch (e) {
                        const response = await fetch(docData.pdfUrl);
                        const arrayBuffer = await response.arrayBuffer();
                        pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                    }
                } else {
                    const data = docData.pdfData.slice(0);
                    pdf = await window.pdfjsLib.getDocument({ data }).promise;
                }
                pdfCacheRef.current[docData.id] = pdf;
                setTotalPages(pdf.numPages);
            }

            const page = await pdf.getPage(pageNum);
            const effectiveRotation = (page.rotate + rotation) % 360;
            const viewport = page.getViewport({ scale: renderScale, rotation: effectiveRotation });
            viewportRef.current = viewport;

            const offscreenCanvas = document.createElement('canvas');
            offscreenCanvas.width = viewport.width;
            offscreenCanvas.height = viewport.height;
            const offscreenCtx = offscreenCanvas.getContext('2d');

            const renderContext = { canvasContext: offscreenCtx, viewport };

            if (renderTaskRef.current) {
                try { renderTaskRef.current.cancel(); } catch (e) { }
            }

            const renderTask = page.render(renderContext);
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
                    setCanvasSize({ width: viewport.width, height: viewport.height });
                    renderTaskRef.current = null;
                }
            } catch (err) {
                if (err.name === 'RenderingCancelledException') return;
                throw err;
            }

            setIsLoading(false);
        } catch (err) {
            console.error('[PDFViewer] Render error:', err);
            setIsLoading(false);
        }
    }, [rotation]);

    // Re-render when page or render-ready zoom changes
    useEffect(() => {
        if (documentData) {
            loadAndRenderPage(documentData, currentPage, renderZoom);
        }
    }, [documentData, currentPage, renderZoom, loadAndRenderPage]);

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

    useEffect(() => {
        if (doc?.page && doc.page !== currentPage) {
            setCurrentPage(doc.page);
        }
    }, [doc?.page]);

    const goToPage = (pageNum) => {
        if (totalPages && pageNum >= 1 && pageNum <= totalPages) {
            setCurrentPage(pageNum);
        }
    };

    if (!doc || !documentData) {
        return (
            <div className="h-full flex flex-col items-center justify-center p-6 text-[#888888]">
                <X size={48} className="mb-4 opacity-30" />
                <p className="text-sm">No document selected</p>
            </div>
        );
    }

    // CSS scaling factor for smooth zoom interaction
    const cssScale = zoom / renderZoom;

    return (
        <div className="h-full flex flex-col bg-white">
            {/* Header with Title and Page Info */}
            <div className="px-4 py-3 border-b border-[#e5e1d8] bg-[#f4f1ea] flex items-center justify-between shrink-0">
                <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-bold text-[#333333] truncate">{documentData.name}</h3>
                    <p className="text-xs text-[#888888]">Page {currentPage} of {totalPages || '...'}</p>
                </div>
                <button onClick={onClose} className="p-1.5 hover:bg-[#e5e1d8] rounded-md text-[#555555] transition-colors"><X size={18} /></button>
            </div>

            {/* Viewer Controls */}
            <div className="px-4 py-2 border-b border-[#e5e1d8] bg-white flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                    <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} className="p-1.5 hover:bg-[#f4f1ea] rounded-md text-[#555555] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"><ChevronLeft size={16} /></button>
                    <span className="text-xs font-mono text-[#333333] min-w-[60px] text-center">{currentPage} / {totalPages || 0}</span>
                    <button onClick={() => goToPage(currentPage + 1)} disabled={!totalPages || currentPage >= totalPages} className="p-1.5 hover:bg-[#f4f1ea] rounded-md text-[#555555] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"><ChevronRight size={16} /></button>
                </div>

                <div className="flex items-center gap-1">
                    <button onClick={() => setZoom(z => Math.max(z - 0.2, 0.3))} className="p-1.5 hover:bg-[#f4f1ea] rounded-md text-[#555555] transition-colors"><ZoomOut size={14} /></button>
                    <span className="text-xs font-mono text-[#333333] min-w-[50px] text-center">{Math.round(zoom * 100)}%</span>
                    <button onClick={() => setZoom(z => Math.min(z + 0.2, 5))} className="p-1.5 hover:bg-[#f4f1ea] rounded-md text-[#555555] transition-colors"><ZoomIn size={14} /></button>
                    <button onClick={() => setRotation(r => (r + 90) % 360)} className="p-1.5 hover:bg-[#f4f1ea] rounded-md text-[#555555] transition-colors ml-1"><RotateCw size={14} /></button>
                </div>
            </div>

            {/* Scrollable Container with Pan & Zoom */}
            <div
                ref={containerRef}
                className="relative w-full h-full bg-[#f4f1ea] overflow-auto cursor-grab p-12"
                onWheel={handleWheel}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
            >
                {isLoading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#f4f1ea]/80 z-20 transition-opacity">
                        <Loader2 className="w-8 h-8 animate-spin text-[#d97757] mb-2" />
                        <span className="text-xs text-[#d97757] font-medium">Updating...</span>
                    </div>
                )}

                {/* Scaling Layer: Both Canvas and Highlights scale together via CSS */}
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

                    {/* SVG Content Highlight Overlay */}
                    {!isLoading && bestMatch && (
                        <svg
                            className="absolute top-0 left-0 pointer-events-none"
                            style={{
                                width: canvasSize.width,
                                height: canvasSize.height,
                                zIndex: 10
                            }}
                            viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
                        >
                            {/* Precise Document Highlight (No artificial labels) */}
                            <polygon
                                points={getPolygonPoints(bestMatch)}
                                fill="rgba(255, 235, 59, 0.45)"
                                stroke="#f59e0b"
                                strokeWidth="2"
                                style={{ strokeLinejoin: 'round' }}
                            />

                            {/* Subtle Target Crosshair */}
                            {selectedCenter && (
                                <>
                                    <line x1={selectedCenter.cx - 15} y1={selectedCenter.cy} x2={selectedCenter.cx + 15} y2={selectedCenter.cy} stroke="#f59e0b" strokeWidth="1" strokeDasharray="3" />
                                    <line x1={selectedCenter.cx} y1={selectedCenter.cy - 15} x2={selectedCenter.cx} y2={selectedCenter.cy + 15} stroke="#f59e0b" strokeWidth="1" strokeDasharray="3" />
                                </>
                            )}
                        </svg>
                    )}
                </div>
            </div>
        </div>
    );
};

export default PDFViewer;
