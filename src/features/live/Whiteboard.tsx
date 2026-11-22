import { useCallback, useEffect, useRef, useState } from 'react';
import { Circle, Eraser, Hand, Highlighter, Lock, Minus, Pencil, Redo2, Square, Trash2, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import { COLORS, PAD_H, PAD_W, SIZES, TOOLS, type Tool } from '@/lib/drawing';
import { createStrokeSender, newId, thin, type BStroke, type BoardMsg, type BoardState } from '@/lib/live/protocol';
import { cn } from '@/lib/utils';

const ICON: Record<Tool, typeof Pencil> = { pen: Pencil, highlighter: Highlighter, eraser: Eraser, line: Minus, rect: Square, ellipse: Circle };
const FLUSH_MS = 70;      // pointer movement is sent about 14 times a second, not once per pixel

type Draw = Pick<BStroke, 'tool' | 'color' | 'size' | 'pts'>;
function paint(ctx: CanvasRenderingContext2D, s: Draw, cut = false) {
  const p = s.pts; if (p.length < 2) return;
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.size;
  if (s.tool === 'eraser') { ctx.strokeStyle = '#FFFFFF'; ctx.fillStyle = '#FFFFFF'; ctx.lineWidth = s.size * 3; if (cut) ctx.globalCompositeOperation = 'destination-out'; }
  else if (s.tool === 'highlighter') { ctx.globalAlpha = 0.35; ctx.lineWidth = s.size * 3; ctx.lineCap = 'butt'; }
  if (s.tool === 'line' || s.tool === 'rect' || s.tool === 'ellipse') {
    if (p.length >= 4) {
      const [x0, y0, x1, y1] = [p[0]!, p[1]!, p[2]!, p[3]!];
      ctx.beginPath();
      if (s.tool === 'line') { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
      else if (s.tool === 'rect') ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      else ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (p.length === 2) { ctx.beginPath(); ctx.arc(p[0]!, p[1]!, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); }
  else {
    ctx.beginPath(); ctx.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length - 2; i += 2) ctx.quadraticCurveTo(p[i]!, p[i + 1]!, (p[i]! + p[i + 2]!) / 2, (p[i + 1]! + p[i + 3]!) / 2);
    ctx.lineTo(p[p.length - 2]!, p[p.length - 1]!); ctx.stroke();
  }
  ctx.restore();
}

/**
 * The shared board. What is drawn is exactly what the protocol accepted (board state), so a learner who is not allowed to draw
 * cannot even show a stroke on their own screen. Text and extra pages are not part of this version.
 */
export function Whiteboard({ board, isHost, meIdentity, send, bg }: { board: BoardState; isHost: boolean; meIdentity: string; send: (m: BoardMsg) => void; bg?: string }) {
  const main = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>(COLORS[0]);
  const [size, setSize] = useState<number>(SIZES[1]);
  const redo = useRef<Draw[]>([]);
  const live = useRef<{ sender: ReturnType<typeof createStrokeSender>; timer: number; pts: number[]; draw: Draw } | null>(null);
  const canDraw = isHost || board.open;
  const [hand, setHand] = useState(false); const [zoom, setZoom] = useState(1);
  const penSeen = useRef(false);
  const [pic, setPic] = useState<HTMLImageElement | null>(null);
  useEffect(() => {                         // a worksheet picture behind the writing (slides you can write on)
    setPic(null); if (!bg) return;
    let alive = true; const im = new Image();
    im.onload = () => { if (alive) setPic(im); }; im.src = bg;
    return () => { alive = false; };
  }, [bg]);

  useEffect(() => {
    const c = main.current; const ctx = c?.getContext('2d'); if (!c || !ctx) return;
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, PAD_W, PAD_H);
    if (!bg) { for (const s of board.strokes) paint(ctx, s); return; }
    if (pic) { const k = Math.min(PAD_W / pic.naturalWidth, PAD_H / pic.naturalHeight); const w = pic.naturalWidth * k, h = pic.naturalHeight * k; ctx.drawImage(pic, (PAD_W - w) / 2, (PAD_H - h) / 2, w, h); }
    const ink = document.createElement('canvas'); ink.width = PAD_W; ink.height = PAD_H;     // own layer so the eraser removes writing, not the picture
    const ictx = ink.getContext('2d'); if (ictx) { for (const s of board.strokes) paint(ictx, s, true); ctx.drawImage(ink, 0, 0); }
  }, [board, bg, pic]);

  const at = (e: React.PointerEvent) => { const r = over.current!.getBoundingClientRect(); return [Math.round(((e.clientX - r.left) * PAD_W) / r.width), Math.round(((e.clientY - r.top) * PAD_H) / r.height)] as const; };
  const clearOver = () => over.current?.getContext('2d')?.clearRect(0, 0, PAD_W, PAD_H);
  const stop = useCallback(() => { const l = live.current; if (!l) return; window.clearInterval(l.timer); l.sender.flush(true); live.current = null; clearOver(); }, []);
  useEffect(() => stop, [stop]);
  useEffect(() => { if (!canDraw) stop(); }, [canDraw, stop]);

  const down = (e: React.PointerEvent) => {
    if (!canDraw || hand || live.current) return;
    if (e.pointerType === 'pen') penSeen.current = true;
    if (e.pointerType === 'touch' && penSeen.current) return;       // palm resting while the pencil writes
    e.currentTarget.setPointerCapture(e.pointerId);
    const ink = tool === 'eraser' ? '#FFFFFF' : color; const [x, y] = at(e);
    const draw: Draw = { tool, color: ink, size, pts: [x, y] };
    const sender = createStrokeSender({ id: newId(), tool, color: ink, size }, send);
    sender.push(x, y);
    redo.current = [];
    live.current = { sender, draw, pts: [x, y], timer: window.setInterval(() => sender.flush(false), FLUSH_MS) };
    const ctx = over.current?.getContext('2d'); if (ctx) paint(ctx, draw);
  };
  const move = (e: React.PointerEvent) => {
    const l = live.current; if (!l) return;
    const [x, y] = at(e);
    l.sender.push(x, y);
    const ctx = over.current?.getContext('2d'); if (!ctx) return;
    if (tool === 'line' || tool === 'rect' || tool === 'ellipse') { ctx.clearRect(0, 0, PAD_W, PAD_H); paint(ctx, { ...l.draw, pts: [l.pts[0]!, l.pts[1]!, x, y] }); }
    else { const px = l.pts[l.pts.length - 2]!, py = l.pts[l.pts.length - 1]!; l.pts.push(x, y); paint(ctx, { ...l.draw, pts: [px, py, x, y] }); }
  };

  const mine = () => [...board.strokes].reverse().find((s) => s.owner === meIdentity);
  const undo = () => { const s = mine(); if (!s) return; redo.current.push({ tool: s.tool, color: s.color, size: s.size, pts: s.pts }); send({ t: 'undo', id: s.id }); };
  const redoOne = () => {
    const d = redo.current.pop(); if (!d) return;
    const sender = createStrokeSender({ id: newId(), tool: d.tool, color: d.color, size: d.size }, send);
    const pts = d.tool === 'pen' || d.tool === 'highlighter' || d.tool === 'eraser' ? thin(d.pts, 600) : d.pts;
    for (let i = 0; i < pts.length; i += 2) sender.push(pts[i]!, pts[i + 1]!);
    sender.flush(true);
  };

  const btn = 'flex h-11 w-11 items-center justify-center rounded-md border border-line bg-white text-ink disabled:opacity-40';
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-white p-1.5 text-ink">
        {TOOLS.map((t) => { const I = ICON[t.value]; return <button key={t.value} type="button" aria-label={t.label} aria-pressed={tool === t.value} disabled={!canDraw} onClick={() => setTool(t.value)} className={cn(btn, tool === t.value && 'border-gold-500 bg-gold-100 ring-2 ring-gold-500/40')}><I className="h-5 w-5" /></button>; })}
        <span className="mx-1 h-6 w-px bg-line" aria-hidden />
        {COLORS.map((c) => <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={color === c && tool !== 'eraser'} disabled={!canDraw} onClick={() => { setColor(c); if (tool === 'eraser') setTool('pen'); }} className={cn('h-8 w-8 rounded-full border-2 disabled:opacity-40', color === c && tool !== 'eraser' ? 'border-gold-500 ring-2 ring-gold-500/40' : 'border-white ring-1 ring-line')} style={{ background: c }} />)}
        <span className="mx-1 h-6 w-px bg-line" aria-hidden />
        {SIZES.map((s) => <button key={s} type="button" aria-label={`Thickness ${s}`} aria-pressed={size === s} disabled={!canDraw} onClick={() => setSize(s)} className={cn(btn, size === s && 'border-gold-500 ring-2 ring-gold-500/40')}><span className="rounded-full bg-ink" style={{ width: s + 4, height: s + 4 }} /></button>)}
        <span className="mx-1 h-6 w-px bg-line" aria-hidden />
        <button type="button" aria-label="Undo my last stroke" disabled={!canDraw || !mine()} onClick={undo} className={btn}><Undo2 className="h-5 w-5" /></button>
        <button type="button" aria-label="Redo" disabled={!canDraw} onClick={redoOne} className={btn}><Redo2 className="h-5 w-5" /></button>
        {bg && <><span className="mx-1 h-6 w-px bg-line" aria-hidden />
          <button type="button" aria-label="Move and zoom the page" aria-pressed={hand} onClick={() => setHand((m) => !m)} className={cn(btn, hand && 'border-gold-500 bg-gold-100 ring-2 ring-gold-500/40')}><Hand className="h-5 w-5" /></button>
          <button type="button" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z - 0.5))} className={btn}><ZoomOut className="h-5 w-5" /></button>
          <button type="button" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom((z) => Math.min(3, z + 0.5))} className={btn}><ZoomIn className="h-5 w-5" /></button></>}
        {isHost && <button type="button" aria-label="Clear the board for everyone" onClick={() => { if (window.confirm('Clear the whole board for everyone?')) send({ t: 'clear' }); }} className={btn}><Trash2 className="h-5 w-5" /></button>}
        {isHost && <label className="ml-auto flex min-h-11 items-center gap-2 px-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={board.open} onChange={(e) => send({ t: 'open', open: e.target.checked })} /> Learners can draw</label>}
        {!canDraw && <p className="ml-auto flex items-center gap-1.5 px-2 text-sm text-muted"><Lock className="h-4 w-4" aria-hidden /> Only the teacher can draw right now</p>}
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto rounded-lg bg-white">
        <div className={cn('relative max-w-full', zoom === 1 && 'mx-auto')} style={{ width: `${zoom * 100}%`, aspectRatio: `${PAD_W} / ${PAD_H}`, maxHeight: zoom === 1 ? '100%' : undefined }}>
          <canvas ref={main} width={PAD_W} height={PAD_H} className="absolute inset-0 h-full w-full" aria-label="Shared whiteboard" role="img" />
          <canvas ref={over} width={PAD_W} height={PAD_H} style={{ touchAction: hand || !canDraw ? 'auto' : 'none' }} className={cn('absolute inset-0 h-full w-full', hand ? 'cursor-grab' : canDraw ? 'cursor-crosshair' : 'cursor-not-allowed')}
            onPointerDown={down} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onPointerLeave={stop} />
        </div>
      </div>
    </div>
  );
}
