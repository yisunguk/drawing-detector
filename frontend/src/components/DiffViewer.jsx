import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Columns, SlidersHorizontal, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from 'lucide-react';

// Use the global pdfjsLib from CDN (loaded in index.html) to avoid version mismatch
const pdfjsLib = window.pdfjsLib;

const DiffViewer = ({ revisionA, revisionB, onClose }) => {
  const [mode, setMode] = useState('side'); // 'side' | 'slider'
  const [page, setPage] = useState(1);
  const [maxPage, setMaxPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [sliderPos, setSliderPos] = useState(50);
  const [dragging, setDragging] = useState(false);

  const canvasARef = useRef(null);
  const canvasBRef = useRef(null);
  const pdfARef = useRef(null);
  const pdfBRef = useRef(null);
  const containerRef = useRef(null);

  // Load PDFs
  useEffect(() => {
    let cancelled = false;
    const loadPdfs = async () => {
      try {
        const [docA, docB] = await Promise.all([
          pdfjsLib.getDocument(revisionA.pdf_url).promise,
          pdfjsLib.getDocument(revisionB.pdf_url).promise,
        ]);
        if (cancelled) return;
        pdfARef.current = docA;
        pdfBRef.current = docB;
        setMaxPage(Math.max(docA.numPages, docB.numPages));
        setPage(1);
      } catch (e) {
        console.error('DiffViewer: PDF load error', e);
      }
    };
    loadPdfs();
    return () => { cancelled = true; };
  }, [revisionA.pdf_url, revisionB.pdf_url]);

  // Render pages
  const renderPage = useCallback(async (pdfDoc, canvas, pageNum, scale) => {
    if (!pdfDoc || !canvas || pageNum > pdfDoc.numPages) return;
    try {
      const pg = await pdfDoc.getPage(pageNum);
      const viewport = pg.getViewport({ scale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await pg.render({ canvasContext: ctx, viewport }).promise;
    } catch (e) {
      console.error('DiffViewer: render error', e);
    }
  }, []);

  useEffect(() => {
    const scale = zoom * 1.2;
    if (pdfARef.current && canvasARef.current) renderPage(pdfARef.current, canvasARef.current, page, scale);
    if (pdfBRef.current && canvasBRef.current) renderPage(pdfBRef.current, canvasBRef.current, page, scale);
  }, [page, zoom, renderPage]);

  // Sync scroll for side-by-side
  const scrollARef = useRef(null);
  const scrollBRef = useRef(null);
  const syncing = useRef(false);

  const handleSyncScroll = (source) => {
    if (syncing.current) return;
    syncing.current = true;
    const a = scrollARef.current;
    const b = scrollBRef.current;
    if (source === 'a' && a && b) {
      b.scrollTop = a.scrollTop;
      b.scrollLeft = a.scrollLeft;
    } else if (source === 'b' && a && b) {
      a.scrollTop = b.scrollTop;
      a.scrollLeft = b.scrollLeft;
    }
    requestAnimationFrame(() => { syncing.current = false; });
  };

  // Slider drag
  const handleSliderMove = useCallback((e) => {
    if (!dragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pos = ((e.clientX - rect.left) / rect.width) * 100;
    setSliderPos(Math.max(5, Math.min(95, pos)));
  }, [dragging]);

  useEffect(() => {
    if (dragging) {
      const up = () => setDragging(false);
      window.addEventListener('mousemove', handleSliderMove);
      window.addEventListener('mouseup', up);
      return () => { window.removeEventListener('mousemove', handleSliderMove); window.removeEventListener('mouseup', up); };
    }
  }, [dragging, handleSliderMove]);

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex flex-col z-50">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-700/50 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-slate-200">
            Rev.{revisionA.revision || '?'} vs Rev.{revisionB.revision || '?'}
          </span>
          <div className="flex items-center bg-slate-800 rounded-lg p-0.5">
            <button
              onClick={() => setMode('side')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                mode === 'side' ? 'bg-sky-500 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Columns className="w-3.5 h-3.5" /> Side-by-Side
            </button>
            <button
              onClick={() => setMode('slider')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                mode === 'slider' ? 'bg-sky-500 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" /> Slider
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                  className="p-1.5 text-slate-400 hover:text-white disabled:opacity-30 rounded hover:bg-slate-700">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs text-slate-300">{page} / {maxPage}</span>
          <button onClick={() => setPage(p => Math.min(maxPage, p + 1))} disabled={page >= maxPage}
                  className="p-1.5 text-slate-400 hover:text-white disabled:opacity-30 rounded hover:bg-slate-700">
            <ChevronRight className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-slate-700 mx-1" />
          <button onClick={() => setZoom(z => Math.max(0.3, z - 0.2))}
                  className="p-1.5 text-slate-400 hover:text-white rounded hover:bg-slate-700">
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-slate-400 w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(3, z + 0.2))}
                  className="p-1.5 text-slate-400 hover:text-white rounded hover:bg-slate-700">
            <ZoomIn className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-slate-700 mx-1" />
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-white rounded hover:bg-slate-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      {mode === 'side' ? (
        <div className="flex flex-1 overflow-hidden">
          {/* Left */}
          <div className="flex-1 flex flex-col border-r border-slate-700/50">
            <div className="px-3 py-1.5 bg-slate-800/50 text-xs text-slate-400 flex-shrink-0">
              Rev.{revisionA.revision || '?'} (Before)
            </div>
            <div ref={scrollARef} onScroll={() => handleSyncScroll('a')} className="flex-1 overflow-auto bg-slate-950 flex items-start justify-center p-4">
              <canvas ref={canvasARef} className="max-w-full" />
            </div>
          </div>
          {/* Right */}
          <div className="flex-1 flex flex-col">
            <div className="px-3 py-1.5 bg-slate-800/50 text-xs text-slate-400 flex-shrink-0">
              Rev.{revisionB.revision || '?'} (After)
            </div>
            <div ref={scrollBRef} onScroll={() => handleSyncScroll('b')} className="flex-1 overflow-auto bg-slate-950 flex items-start justify-center p-4">
              <canvas ref={canvasBRef} className="max-w-full" />
            </div>
          </div>
        </div>
      ) : (
        /* Slider mode */
        <div ref={containerRef} className="flex-1 overflow-auto bg-slate-950 relative" onMouseMove={handleSliderMove}>
          <div className="relative inline-block min-w-full min-h-full flex items-start justify-center p-4">
            {/* Canvas B (full, underneath) */}
            <canvas ref={canvasBRef} className="max-w-full" />
            {/* Canvas A (clipped, on top) */}
            <canvas
              ref={canvasARef}
              className="absolute top-4 max-w-full"
              style={{ clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}
            />
            {/* Slider handle */}
            <div
              className="absolute top-0 bottom-0 w-1 bg-sky-500 cursor-ew-resize z-10"
              style={{ left: `${sliderPos}%` }}
              onMouseDown={() => setDragging(true)}
            >
              <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-8 h-8 bg-sky-500 rounded-full flex items-center justify-center shadow-lg">
                <SlidersHorizontal className="w-4 h-4 text-white" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DiffViewer;
