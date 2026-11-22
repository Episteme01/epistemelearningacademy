import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Circle, Download, Eraser, Highlighter, Minus, Pencil, Redo2, Square, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, useToast } from '@/components/ui/overlay';
import { cn } from '@/lib/utils';
import {
  COLORS, PAD_H, PAD_W, PAPERS, SIZES, clampPoint, drawingFileName, emptyPad, extend, guideLines, isShape, packDraft,
  padReducer, unpackDraft, type Paper, type Stroke, type Tool,
} from '@/lib/drawing';

const TOOL_ICON: Record<Tool, typeof Pencil> = { pen: Pencil, highlighter: Highlighter, eraser: Eraser, line: Minus, rect: Square, ellipse: Circle };
const TOOL_LABEL: Record<Tool, string> = { pen: 'Pen', highlighter: 'Highlighter', eraser: 'Eraser', line: 'Line', rect: 'Box', ellipse: 'Circle' };
const draftKey = (k: string) => `ela.pad.v1.${k}`;

/** Forget an unsent draft (call after the work has been submitted). */
export function clearPadDraft(key: string) { try { localStorage.removeItem(draftKey(key)); } catch { /* storage unavailable */ } }

function paintPaper(ctx: CanvasRenderingContext2D, paper: Paper) {
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, PAD_W, PAD_H);
  const g = guideLines(paper);
  ctx.lineWidth = 1;
  if (g.dots) {
    ctx.fillStyle = '#B8C2BD';
    for (const y of g.ys) for (const x of g.xs) { ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill(); }
    return;
  }
  ctx.strokeStyle = paper === 'lined' || paper === 'handwriting' ? '#9DB7C9' : '#D5DDD9';
  ctx.beginPath();
  for (const y of g.ys) { ctx.moveTo(0, y + 0.5); ctx.lineTo(PAD_W, y + 0.5); }
  for (const x of g.xs) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, PAD_H); }
  ctx.stroke();
  if (g.mid.length) {
    ctx.strokeStyle = '#E6B4B4'; ctx.setLineDash([10, 8]); ctx.beginPath();
    for (const y of g.mid) { ctx.moveTo(0, y + 0.5); ctx.lineTo(PAD_W, y + 0.5); }
    ctx.stroke(); ctx.setLineDash([]);
  }
}

export function paintStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  const p = s.pts;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
  if (s.tool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.lineWidth = s.size * 3; ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; }
  else if (s.tool === 'highlighter') { ctx.globalAlpha = 0.35; ctx.lineWidth = s.size * 3; ctx.lineCap = 'butt'; }
  else ctx.lineWidth = s.size;

  if (isShape(s.tool)) {
    const [x0, y0, x1, y1] = [p[0]!, p[1]!, p[2] ?? p[0]!, p[3] ?? p[1]!];
    ctx.beginPath();
    if (s.tool === 'line') { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
    else if (s.tool === 'rect') ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    else ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (p.length <= 2) {
    ctx.beginPath(); ctx.arc(p[0]!, p[1]!, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
  } else {
    // smooth the line through the midpoints of neighbouring points
    ctx.beginPath(); ctx.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length - 2; i += 2) ctx.quadraticCurveTo(p[i]!, p[i + 1]!, (p[i]! + p[i + 2]!) / 2, (p[i + 1]! + p[i + 3]!) / 2);
    ctx.lineTo(p[p.length - 2]!, p[p.length - 1]!);
    ctx.stroke();
  }
  ctx.restore();
}

export interface DrawingPadProps {
  /** Called with the finished picture as a PNG file. When omitted the pad is practice-only (download still works). */
  onSave?: (file: File) => void | Promise<void>;
  saveLabel?: string;
  /** Keep an unsent draft in this browser under this name (so a refresh or lost signal does not lose the work). */
  persistKey?: string;
  className?: string;
}

export function DrawingPad({ onSave, saveLabel = 'Save', persistKey, className }: DrawingPadProps) {
  const toast = useToast();
  const [pad, dispatch] = useReducer(padReducer, undefined, emptyPad);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>(COLORS[0]);
  const [size, setSize] = useState<number>(SIZES[1]);
  const [paper, setPaper] = useState<Paper>('lined');
  const [confirmClear, setConfirmClear] = useState(false);
  const [saving, setSaving] = useState(false);

  const canvas = useRef<HTMLCanvasElement>(null);
  const ink = useRef<HTMLCanvasElement | null>(null);     // finished strokes (transparent, so the eraser can cut through)
  const live = useRef<HTMLCanvasElement | null>(null);    // finished strokes + the stroke being drawn
  const current = useRef<Stroke | null>(null);
  const pointer = useRef<number | null>(null);
  const raf = useRef(0);
  const cfg = useRef({ tool, color, size }); cfg.current = { tool, color, size };
  const paperRef = useRef(paper); paperRef.current = paper;
  const padRef = useRef(pad); padRef.current = pad;

  const layer = (r: { current: HTMLCanvasElement | null }) => {
    if (!r.current) { const c = document.createElement('canvas'); c.width = PAD_W; c.height = PAD_H; r.current = c; }
    return r.current;
  };

  const paintNow = useCallback(() => {
    const c = canvas.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    const lv = layer(live); const lctx = lv.getContext('2d')!;
    lctx.clearRect(0, 0, PAD_W, PAD_H); lctx.drawImage(layer(ink), 0, 0);
    if (current.current) paintStroke(lctx, current.current);
    paintPaper(ctx, paperRef.current); ctx.drawImage(lv, 0, 0);
  }, []);
  const schedule = useCallback(() => { if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; paintNow(); }); }, [paintNow]);

  // committed strokes changed (add / undo / redo / clear / load): rebuild the ink layer
  useEffect(() => {
    const ctx = layer(ink).getContext('2d')!;
    ctx.clearRect(0, 0, PAD_W, PAD_H);
    for (const s of pad.strokes) paintStroke(ctx, s);
    paintNow();
  }, [pad.strokes, paintNow]);
  useEffect(() => { paintNow(); }, [paper, paintNow]);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  // restore / keep a draft in this browser (never sent anywhere)
  useEffect(() => {
    if (!persistKey) return;
    try { const strokes = unpackDraft(localStorage.getItem(draftKey(persistKey))); if (strokes.length) dispatch({ type: 'load', strokes }); } catch { /* storage unavailable */ }
  }, [persistKey]);
  useEffect(() => {
    if (!persistKey) return;
    const t = setTimeout(() => {
      try { const packed = pad.strokes.length ? packDraft(pad.strokes) : null; if (packed) localStorage.setItem(draftKey(persistKey), packed); else localStorage.removeItem(draftKey(persistKey)); } catch { /* storage unavailable */ }
    }, 600);
    return () => clearTimeout(t);
  }, [pad.strokes, persistKey]);

  const at = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return [clampPoint(((e.clientX - r.left) * PAD_W) / r.width, PAD_W), clampPoint(((e.clientY - r.top) * PAD_H) / r.height, PAD_H)] as const;
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;   // one finger / pen at a time
    e.preventDefault(); canvas.current!.setPointerCapture(e.pointerId); pointer.current = e.pointerId;
    const [x, y] = at(e); const c = cfg.current;
    current.current = { tool: c.tool, color: c.color, size: c.size, pts: isShape(c.tool) ? [x, y, x, y] : [x, y] };
    schedule();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== e.pointerId || !current.current) return;
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e.nativeEvent]) { const [x, y] = at(ev); current.current = extend(current.current!, x, y); }
    schedule();
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    const s = current.current; current.current = null;
    if (s && !(isShape(s.tool) && s.pts[0] === s.pts[2] && s.pts[1] === s.pts[3])) dispatch({ type: 'add', stroke: s }); else schedule();
  };

  // Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z for keyboards
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); dispatch({ type: e.shiftKey ? 'redo' : 'undo' }); }
  };

  const toBlob = () => new Promise<Blob | null>((res) => { paintNow(); canvas.current?.toBlob((b) => res(b), 'image/png'); });
  const empty = pad.strokes.length === 0;

  const download = async () => {
    const b = await toBlob(); if (!b) return toast.error('Could not make the picture. Try again.');
    const url = URL.createObjectURL(b); const a = document.createElement('a');
    a.href = url; a.download = drawingFileName(); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const save = async () => {
    if (!onSave || empty) return;
    setSaving(true);
    try {
      const b = await toBlob(); if (!b) throw new Error('Could not make the picture. Try again.');
      await onSave(new File([b], drawingFileName(), { type: 'image/png' }));
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save the drawing.'); } finally { setSaving(false); }
  };

  const chip = (on: boolean) => cn('inline-flex h-9 min-w-9 items-center justify-center rounded-md border px-2 text-sm transition', on ? 'border-forest-500 bg-forest-500 text-white' : 'border-line bg-white text-ink hover:bg-cream');
  return (
    <div className={cn('space-y-3', className)} onKeyDown={onKey}>
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Drawing tools">
        {(Object.keys(TOOL_ICON) as Tool[]).map((t) => { const I = TOOL_ICON[t]; return (
          <button key={t} type="button" className={chip(tool === t)} aria-pressed={tool === t} aria-label={TOOL_LABEL[t]} title={TOOL_LABEL[t]} onClick={() => setTool(t)}><I className="h-4 w-4" /></button>); })}
        <span className="mx-1 h-6 w-px bg-line" aria-hidden />
        {SIZES.map((s) => (
          <button key={s} type="button" className={chip(size === s)} aria-pressed={size === s} aria-label={`Thickness ${s}`} title={`Thickness ${s}`} onClick={() => setSize(s)}>
            <span className="rounded-full bg-current" style={{ width: Math.min(s + 2, 16), height: Math.min(s + 2, 16) }} />
          </button>))}
        <span className="mx-1 h-6 w-px bg-line" aria-hidden />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Colours">
          {COLORS.map((c) => (
            <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={color === c} onClick={() => { setColor(c); if (tool === 'eraser') setTool('pen'); }}
              className={cn('h-7 w-7 rounded-full border-2 transition', color === c && tool !== 'eraser' ? 'border-gold-500 ring-2 ring-gold-500/40' : 'border-white shadow ring-1 ring-line')} style={{ background: c }} />))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => dispatch({ type: 'undo' })} disabled={pad.strokes.length === 0}><Undo2 className="h-4 w-4" /> Undo</Button>
        <Button size="sm" variant="outline" onClick={() => dispatch({ type: 'redo' })} disabled={pad.redo.length === 0}><Redo2 className="h-4 w-4" /> Redo</Button>
        <Button size="sm" variant="outline" onClick={() => setConfirmClear(true)} disabled={empty}><Trash2 className="h-4 w-4" /> Clear</Button>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted">Paper
          <select className="h-9 rounded-md border border-line bg-white px-2 text-sm text-ink" value={paper} onChange={(e) => setPaper(e.target.value as Paper)}>
            {PAPERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-white shadow-sm">
        <canvas ref={canvas} width={PAD_W} height={PAD_H} aria-label="Drawing area" className="block w-full cursor-crosshair select-none" style={{ touchAction: 'none', aspectRatio: `${PAD_W} / ${PAD_H}` }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={(e) => e.preventDefault()} />
      </div>
      <p className="text-xs text-muted">Draw with your finger, a stylus or the mouse.{persistKey ? ' Your page is kept on this device until you send it.' : ''}</p>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => void download()} disabled={empty}><Download className="h-4 w-4" /> Download picture</Button>
        {onSave && <Button loading={saving} onClick={() => void save()} disabled={empty}>{saveLabel}</Button>}
      </div>

      <ConfirmDialog open={confirmClear} onClose={() => setConfirmClear(false)} title="Clear the whole page?" message="Everything you drew will be removed." confirmLabel="Clear page"
        onConfirm={() => { dispatch({ type: 'clear' }); setConfirmClear(false); }} />
    </div>
  );
}
