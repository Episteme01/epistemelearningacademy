import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Eraser, Hand, Highlighter, Loader2, Pencil, Redo2, Trash2, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, useToast } from '@/components/ui/overlay';
import { COLORS, SIZES, clampPoint, emptyPad, extend, padReducer, type PadAction, type PadState, type Stroke, type Tool } from '@/lib/drawing';
import { MAX_ANNOTATE_PAGES, annotatedName, pageSize, stitchLayout } from '@/lib/annotate';
import { OFFICE_HELP, OTHER_HELP, sourceKind } from '@/lib/live/slideSources';
import { openPdf } from '@/features/live/pdfPages';
import { cn } from '@/lib/utils';
import { paintStroke } from './DrawingPad';

export interface WorksheetSource { blob: Blob; name: string; type: string }
interface PageBg { bg: HTMLCanvasElement; w: number; h: number }

const mk = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

async function toPages(src: WorksheetSource, report: (n: number, total: number) => void): Promise<PageBg[]> {
  const kind = sourceKind(src.name, src.type);
  if (kind === 'office') throw new Error(OFFICE_HELP);
  if (kind === 'other') throw new Error(OTHER_HELP);
  const files: Blob[] = [];
  if (kind === 'image') files.push(src.blob);
  else {
    const doc = await openPdf(await src.blob.arrayBuffer(), src.name);
    try {
      const n = Math.min(doc.pages, MAX_ANNOTATE_PAGES);
      for (let i = 1; i <= n; i++) { files.push(await doc.render(i)); report(i, n); }
    } finally { doc.close(); }
  }
  const out: PageBg[] = [];
  for (const f of files) {
    const bmp = await createImageBitmap(f);
    const { w, h } = pageSize(bmp.width, bmp.height);
    const bg = mk(w, h); const ctx = bg.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
    out.push({ bg, w, h });
  }
  return out;
}

function Writer({ source, onClose, onUse, useLabel }: { source: WorksheetSource; onClose: () => void; onUse?: (f: File) => void | Promise<void>; useLabel: string }) {
  const toast = useToast();
  const [pages, setPages] = useState<PageBg[] | null>(null);
  const [error, setError] = useState(''); const [progress, setProgress] = useState('');
  const [pads, setPads] = useState<PadState[]>([]);
  const [idx, setIdx] = useState(0);
  const [tool, setTool] = useState<Tool>('pen'); const [color, setColor] = useState<string>(COLORS[2]); const [size, setSize] = useState<number>(SIZES[1]);
  const [move, setMove] = useState(false); const [zoom, setZoom] = useState(1); const [busy, setBusy] = useState(false);

  const canvas = useRef<HTMLCanvasElement>(null);
  const inks = useRef<(HTMLCanvasElement | null)[]>([]);
  const current = useRef<Stroke | null>(null); const pointer = useRef<number | null>(null); const penSeen = useRef(false); const raf = useRef(0);
  const cfg = useRef({ tool, color, size }); cfg.current = { tool, color, size };
  const padsRef = useRef(pads); padsRef.current = pads;

  useEffect(() => {
    let alive = true;
    toPages(source, (n, t) => { if (alive) setProgress(`Preparing page ${n} of ${t}`); })
      .then((p) => { if (alive) { setPages(p); setPads(p.map(emptyPad)); inks.current = p.map(() => null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'This file could not be opened.'); });
    return () => { alive = false; };
  }, [source]);

  const inkOf = useCallback((i: number) => {
    const p = pages![i]!; let c = inks.current[i];
    if (!c) { c = mk(p.w, p.h); inks.current[i] = c; }
    return c;
  }, [pages]);

  const paint = useCallback(() => {
    const c = canvas.current; if (!c || !pages) return;
    const p = pages[idx]!; const ctx = c.getContext('2d'); if (!ctx) return;
    const lv = mk(p.w, p.h); const lctx = lv.getContext('2d')!;
    lctx.drawImage(inkOf(idx), 0, 0);
    if (current.current) paintStroke(lctx, current.current);
    ctx.clearRect(0, 0, p.w, p.h); ctx.drawImage(p.bg, 0, 0); ctx.drawImage(lv, 0, 0);
  }, [pages, idx, inkOf]);
  const schedule = useCallback(() => { if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; paint(); }); }, [paint]);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  // rebuild the ink of the page being shown whenever its strokes change
  useEffect(() => {
    if (!pages || !pads[idx]) return;
    const ink = inkOf(idx); const ictx = ink.getContext('2d')!;
    ictx.clearRect(0, 0, ink.width, ink.height);
    for (const s of pads[idx]!.strokes) paintStroke(ictx, s);
    paint();
  }, [pages, pads, idx, inkOf, paint]);

  const act = (a: PadAction) => setPads((cur) => cur.map((p, i) => (i === idx ? padReducer(p, a) : p)));
  const pg = pages?.[idx];
  const at = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return [clampPoint(((e.clientX - r.left) * pg!.w) / r.width, pg!.w), clampPoint(((e.clientY - r.top) * pg!.h) / r.height, pg!.h)] as const;
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (move || !pg || pointer.current !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.pointerType === 'pen') penSeen.current = true;
    if (e.pointerType === 'touch' && penSeen.current) return;          // resting palm while the pencil is in use
    e.preventDefault(); canvas.current!.setPointerCapture(e.pointerId); pointer.current = e.pointerId;
    const [x, y] = at(e); const c = cfg.current;
    current.current = { tool: c.tool, color: c.color, size: c.size, pts: [x, y] }; schedule();
  };
  const moveEv = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== e.pointerId || !current.current) return;
    const evs = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [e.nativeEvent]) { const [x, y] = at(ev); current.current = extend(current.current!, x, y); }
    schedule();
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null; const s = current.current; current.current = null;
    if (s) act({ type: 'add', stroke: s }); else schedule();
  };

  const makeFile = async (): Promise<File> => {
    if (!pages) throw new Error('Nothing to save yet.');
    const lay = stitchLayout(pages.map((p) => ({ w: p.w, h: p.h })));
    const out = mk(lay.width, lay.height); const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, out.width, out.height);
    pages.forEach((p, i) => {
      const ink = mk(p.w, p.h); const ictx = ink.getContext('2d')!;
      for (const s of padsRef.current[i]?.strokes ?? []) paintStroke(ictx, s);
      ctx.drawImage(p.bg, 0, lay.tops[i]!, lay.width, lay.heights[i]!); ctx.drawImage(ink, 0, lay.tops[i]!, lay.width, lay.heights[i]!);
    });
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Could not make the picture. Try again.');
    return new File([blob], annotatedName(source.name), { type: 'image/jpeg' });
  };
  const download = async () => {
    setBusy(true);
    try { const f = await makeFile(); const url = URL.createObjectURL(f); const a = document.createElement('a'); a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  };
  const use = async () => {
    if (!onUse) return; setBusy(true);
    try { await onUse(await makeFile()); } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not use this picture.'); } finally { setBusy(false); }
  };

  if (error) return <div className="space-y-3"><p role="alert" className="text-sm text-danger">{error}</p><Button variant="outline" onClick={onClose}>Close</Button></div>;
  if (!pages || !pg) return <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted" role="status"><Loader2 className="h-5 w-5 animate-spin" /> {progress || 'Opening…'}</div>;

  const chip = (on: boolean) => cn('inline-flex h-11 min-w-11 items-center justify-center rounded-md border px-2 text-sm', on ? 'border-forest-500 bg-forest-500 text-white' : 'border-line bg-white text-ink');
  const edited = pads.some((p) => p.strokes.length > 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Writing tools">
        <button type="button" className={chip(!move && tool === 'pen')} aria-label="Pen" aria-pressed={!move && tool === 'pen'} onClick={() => { setMove(false); setTool('pen'); }}><Pencil className="h-5 w-5" /></button>
        <button type="button" className={chip(!move && tool === 'highlighter')} aria-label="Highlighter" aria-pressed={!move && tool === 'highlighter'} onClick={() => { setMove(false); setTool('highlighter'); }}><Highlighter className="h-5 w-5" /></button>
        <button type="button" className={chip(!move && tool === 'eraser')} aria-label="Eraser" aria-pressed={!move && tool === 'eraser'} onClick={() => { setMove(false); setTool('eraser'); }}><Eraser className="h-5 w-5" /></button>
        <button type="button" className={chip(move)} aria-label="Move and scroll the page" aria-pressed={move} onClick={() => setMove((m) => !m)}><Hand className="h-5 w-5" /></button>
        <span className="mx-1 h-6 w-px bg-line" aria-hidden />
        {COLORS.map((c) => <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={color === c} onClick={() => { setColor(c); if (tool === 'eraser') setTool('pen'); setMove(false); }} className={cn('h-8 w-8 rounded-full border-2', color === c && tool !== 'eraser' ? 'border-gold-500 ring-2 ring-gold-500/40' : 'border-white ring-1 ring-line')} style={{ background: c }} />)}
        <span className="mx-1 h-6 w-px bg-line" aria-hidden />
        {SIZES.map((s) => <button key={s} type="button" aria-label={`Thickness ${s}`} aria-pressed={size === s} onClick={() => setSize(s)} className={chip(size === s)}><span className="rounded-full bg-current" style={{ width: Math.min(s + 2, 16), height: Math.min(s + 2, 16) }} /></button>)}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={() => act({ type: 'undo' })} disabled={!pads[idx]?.strokes.length}><Undo2 className="h-4 w-4" /> Undo</Button>
        <Button size="sm" variant="outline" onClick={() => act({ type: 'redo' })} disabled={!pads[idx]?.redo.length}><Redo2 className="h-4 w-4" /> Redo</Button>
        <Button size="sm" variant="outline" onClick={() => { if (window.confirm('Clear everything you wrote on this page?')) act({ type: 'clear' }); }} disabled={!pads[idx]?.strokes.length}><Trash2 className="h-4 w-4" /> Clear page</Button>
        <span className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z - 0.5))}><ZoomOut className="h-4 w-4" /></Button>
          <Button size="sm" variant="outline" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom((z) => Math.min(3, z + 0.5))}><ZoomIn className="h-4 w-4" /></Button>
        </span>
      </div>
      <div className="max-h-[62vh] overflow-auto rounded-lg border border-line bg-white" style={{ touchAction: move ? 'auto' : 'pan-x pan-y pinch-zoom' }}>
        <canvas ref={canvas} width={pg.w} height={pg.h} aria-label={`Worksheet page ${idx + 1}`} className={cn('block select-none', move ? 'cursor-grab' : 'cursor-crosshair')}
          style={{ width: `${zoom * 100}%`, aspectRatio: `${pg.w} / ${pg.h}`, touchAction: move ? 'auto' : 'none' }}
          onPointerDown={down} onPointerMove={moveEv} onPointerUp={up} onPointerCancel={up} onContextMenu={(e) => e.preventDefault()} />
      </div>
      <p className="text-xs text-muted">Write with your Apple Pencil, stylus, finger or mouse. Tap the hand to scroll or zoom the page, then tap the pen to write again.{pages.length > 1 ? ' Your answers on every page are joined into one picture.' : ''}</p>
      {pages.length > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button size="sm" variant="outline" aria-label="Previous page" disabled={idx === 0} onClick={() => setIdx(idx - 1)}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-sm tabular-nums">Page {idx + 1} / {pages.length}</span>
          <Button size="sm" variant="outline" aria-label="Next page" disabled={idx >= pages.length - 1} onClick={() => setIdx(idx + 1)}><ChevronRight className="h-4 w-4" /></Button>
        </div>)}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Close</Button>
        <Button variant="outline" onClick={() => void download()} loading={busy} disabled={!edited}><Download className="h-4 w-4" /> Save picture</Button>
        {onUse && <Button onClick={() => void use()} loading={busy} disabled={!edited}>{useLabel}</Button>}
      </div>
    </div>
  );
}

/** Write on a worksheet (picture or PDF) with a pen. Works on iPads and phones, where the browser's own PDF viewer has no pen. */
export function WorksheetWriter({ source, onClose, onUse, useLabel = 'Use as my answer', title = 'Write on the worksheet' }: {
  source: WorksheetSource | null; onClose: () => void; onUse?: (f: File) => void | Promise<void>; useLabel?: string; title?: string;
}) {
  return (
    <Dialog open={!!source} onClose={onClose} title={title} description={source?.name} size="xl">
      {source && <Writer key={source.name + source.blob.size} source={source} onClose={onClose} onUse={onUse} useLabel={useLabel} />}
    </Dialog>
  );
}
