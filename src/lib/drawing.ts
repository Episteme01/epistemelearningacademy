// Pure logic for the drawing pad: strokes, undo/redo, paper backgrounds and saving limits.
// No DOM access here so it can be unit-tested; the canvas drawing lives in features/pad.

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'line' | 'rect' | 'ellipse';
export interface Stroke { tool: Tool; color: string; size: number; /** flat [x0,y0,x1,y1,...] in canvas units */ pts: number[] }
export interface PadState { strokes: Stroke[]; redo: Stroke[] }
export type Paper = 'plain' | 'lined' | 'grid' | 'dots' | 'handwriting';

/** Fixed logical canvas size. The picture is always this big whatever the screen, so saved work looks the same everywhere. */
export const PAD_W = 1200;
export const PAD_H = 800;
export const MAX_STROKES = 1500;
export const MAX_POINTS = 4000;           // per stroke
export const MAX_SAVED_BYTES = 1_500_000; // draft kept in this browser only

export const COLORS = ['#111111', '#0B3D2E', '#1D4ED8', '#DC2626', '#EA580C', '#CA8A04', '#7C3AED', '#DB2777'] as const;
export const SIZES = [2, 4, 8, 14] as const;
export const PAPERS: { value: Paper; label: string }[] = [
  { value: 'plain', label: 'Plain' }, { value: 'lined', label: 'Lined' }, { value: 'grid', label: 'Squares' },
  { value: 'dots', label: 'Dots' }, { value: 'handwriting', label: 'Handwriting lines' },
];
export const TOOLS: { value: Tool; label: string }[] = [
  { value: 'pen', label: 'Pen' }, { value: 'highlighter', label: 'Highlighter' }, { value: 'eraser', label: 'Eraser' },
  { value: 'line', label: 'Line' }, { value: 'rect', label: 'Box' }, { value: 'ellipse', label: 'Circle' },
];
export const isShape = (t: Tool) => t === 'line' || t === 'rect' || t === 'ellipse';

export const emptyPad = (): PadState => ({ strokes: [], redo: [] });
export type PadAction = { type: 'add'; stroke: Stroke } | { type: 'undo' } | { type: 'redo' } | { type: 'clear' } | { type: 'load'; strokes: Stroke[] };

export function padReducer(s: PadState, a: PadAction): PadState {
  switch (a.type) {
    case 'add': {
      if (a.stroke.pts.length < 2) return s;
      const strokes = [...s.strokes, a.stroke];
      return { strokes: strokes.length > MAX_STROKES ? strokes.slice(strokes.length - MAX_STROKES) : strokes, redo: [] };
    }
    case 'undo': return s.strokes.length ? { strokes: s.strokes.slice(0, -1), redo: [...s.redo, s.strokes[s.strokes.length - 1]!] } : s;
    case 'redo': return s.redo.length ? { strokes: [...s.strokes, s.redo[s.redo.length - 1]!], redo: s.redo.slice(0, -1) } : s;
    case 'clear': return emptyPad();
    case 'load': return { strokes: a.strokes.slice(-MAX_STROKES), redo: [] };
  }
}

/** Adds a point unless it is practically on top of the last one (keeps drafts small). Shapes keep just start + current end. */
export function extend(stroke: Stroke, x: number, y: number): Stroke {
  const p = stroke.pts;
  if (isShape(stroke.tool)) return { ...stroke, pts: [p[0]!, p[1]!, x, y] };
  const lx = p[p.length - 2]!, ly = p[p.length - 1]!;
  if (Math.hypot(x - lx, y - ly) < 1.2 || p.length >= MAX_POINTS * 2) return stroke;
  return { ...stroke, pts: [...p, x, y] };
}

export const clampPoint = (v: number, max: number) => Math.min(max, Math.max(0, v));

/** Horizontal guide-line positions for each paper, so tests can check them and the canvas can draw them. */
export function guideLines(paper: Paper): { ys: number[]; xs: number[]; dots: boolean; mid: number[] } {
  const none = { ys: [] as number[], xs: [] as number[], dots: false, mid: [] as number[] };
  const range = (step: number, max: number, start = step) => { const out: number[] = []; for (let v = start; v < max; v += step) out.push(v); return out; };
  switch (paper) {
    case 'lined': return { ...none, ys: range(50, PAD_H) };
    case 'grid': return { ...none, ys: range(40, PAD_H), xs: range(40, PAD_W) };
    case 'dots': return { ...none, ys: range(40, PAD_H), xs: range(40, PAD_W), dots: true };
    case 'handwriting': {   // 4-line style: top, mid (dashed), base, descender, repeated in bands of 160
      const ys: number[] = [], mid: number[] = [];
      for (let top = 40; top + 120 < PAD_H; top += 160) { ys.push(top, top + 80, top + 120); mid.push(top + 40); }
      return { ...none, ys, mid };
    }
    default: return none;
  }
}

/** Draft stored in this browser only. Returns null when it is too big to keep. */
export function packDraft(strokes: Stroke[]): string | null {
  const text = JSON.stringify(strokes.map((s) => [s.tool, s.color, s.size, s.pts.map((n) => Math.round(n))]));
  return text.length > MAX_SAVED_BYTES ? null : text;
}
export function unpackDraft(text: string | null): Stroke[] {
  if (!text) return [];
  try {
    const raw = JSON.parse(text) as unknown;
    if (!Array.isArray(raw)) return [];
    const tools = TOOLS.map((t) => t.value) as string[];
    const out: Stroke[] = [];
    for (const r of raw.slice(0, MAX_STROKES)) {
      if (!Array.isArray(r) || r.length < 4) continue;
      const [tool, color, size, pts] = r as [unknown, unknown, unknown, unknown];
      if (typeof tool !== 'string' || !tools.includes(tool) || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) continue;
      if (typeof size !== 'number' || !(size > 0 && size <= 60) || !Array.isArray(pts) || pts.length < 2 || pts.length % 2 !== 0) continue;
      if (!pts.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      out.push({ tool: tool as Tool, color, size, pts: (pts as number[]).slice(0, MAX_POINTS * 2) });
    }
    return out;
  } catch { return []; }
}

export const drawingFileName = (now = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `drawing-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.png`;
};
