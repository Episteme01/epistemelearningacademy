// Pure logic for the live classroom's data channel: chat, hand raising and the shared whiteboard.
// No DOM and no LiveKit imports, so all of it is unit-tested in Node (tests/liveProtocol.test.ts).
//
// Trust model: LiveKit tells us WHO sent a data message (the sender's identity and the role the server put in their token).
// A message body is never trusted: every field is validated here, "host-only" messages are ignored from anyone whose
// server-issued role is not host, and learners can draw only while the teacher has opened the board.
import { MAX_POINTS, MAX_STROKES, PAD_H, PAD_W, TOOLS, type Tool } from '@/lib/drawing';

export type SenderRole = 'host' | 'learner';
export interface Sender { identity: string; role: SenderRole | null }

export const TOPIC = { chat: 'chat', hand: 'hand', board: 'board' } as const;
export const MAX_PACKET_BYTES = 12_000;
export const MAX_CHAT_CHARS = 300;
export const MAX_HANDS = 200;
export const MAX_PTS_PER_MESSAGE = 150;            // points (x,y pairs) in one stroke message
export const SNAPSHOT_MAX_POINTS = 500;            // per stroke inside a snapshot (long strokes are thinned)

/** The role the server put in the participant's token metadata (`{"r":"host"}`). Anything else = unknown. */
export function roleOfMetadata(meta: string | undefined | null): SenderRole | null {
  if (!meta) return null;
  try { const r = (JSON.parse(meta) as { r?: unknown }).r; return r === 'host' || r === 'learner' ? r : null; } catch { return null; }
}

/* ------------------------------------------------------------------ packets */
const enc = new TextEncoder();
const dec = new TextDecoder();
export function encode(msg: unknown): Uint8Array<ArrayBuffer> | null {
  const bytes = enc.encode(JSON.stringify(msg));
  return bytes.length <= MAX_PACKET_BYTES ? bytes : null;
}
function parse(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.length === 0 || bytes.length > MAX_PACKET_BYTES * 2) return null;
  try { const v = JSON.parse(dec.decode(bytes)) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
}
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(v);
export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);

/** Sliding-window limiter: at most `max` events per `windowMs` for each key. Used for sending and for receiving. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  allow(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (recent.length >= this.max) { this.hits.set(key, recent); return false; }
    recent.push(nowMs); this.hits.set(key, recent); return true;
  }
}

/* ------------------------------------------------------------------ chat */
export interface ChatMsg { t: 'msg'; id: string; text: string; ann?: true }
/** Plain text only: control characters removed, spaces collapsed, length limited. Rendering uses React text nodes (never innerHTML). */
export function cleanChat(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CHAT_CHARS);
}
export function decodeChat(bytes: Uint8Array, sender: Sender): ChatMsg | null {
  const m = parse(bytes); if (!m || m.t !== 'msg' || !isId(m.id)) return null;
  const text = cleanChat(m.text); if (!text) return null;
  return m.ann === true && sender.role === 'host' ? { t: 'msg', id: m.id, text, ann: true } : { t: 'msg', id: m.id, text };   // only a host's message can be an announcement
}

/* ------------------------------------------------------------------ hands */
export interface HandEntry { identity: string; since: number }
export type HandMsg = { t: 'hand'; up: boolean } | { t: 'ack'; who: string } | { t: 'clear' } | { t: 'state'; up: HandEntry[] };
export function decodeHand(bytes: Uint8Array): HandMsg | null {
  const m = parse(bytes); if (!m) return null;
  if (m.t === 'hand' && typeof m.up === 'boolean') return { t: 'hand', up: m.up };
  if (m.t === 'ack' && typeof m.who === 'string' && m.who.length <= 64) return { t: 'ack', who: m.who };
  if (m.t === 'clear') return { t: 'clear' };
  if (m.t === 'state' && Array.isArray(m.up)) {
    const up: HandEntry[] = [];
    for (const e of m.up.slice(0, MAX_HANDS)) { const x = e as Record<string, unknown>; if (x && typeof x.identity === 'string' && x.identity.length <= 64 && typeof x.since === 'number' && Number.isFinite(x.since)) up.push({ identity: x.identity, since: x.since }); }
    return { t: 'state', up };
  }
  return null;
}
/** The raised-hand queue, oldest first. Anyone can raise or lower their OWN hand; acknowledging, clearing and syncing are host-only. */
export function handApply(list: HandEntry[], msg: HandMsg, from: Sender, nowMs: number): HandEntry[] {
  const host = from.role === 'host';
  switch (msg.t) {
    case 'hand':
      if (!msg.up) return list.filter((h) => h.identity !== from.identity);
      return list.some((h) => h.identity === from.identity) || list.length >= MAX_HANDS ? list : [...list, { identity: from.identity, since: nowMs }];
    case 'ack': return host ? list.filter((h) => h.identity !== msg.who) : list;
    case 'clear': return host ? [] : list;
    case 'state': return host ? msg.up : list;
  }
}
export const handRemove = (list: HandEntry[], identity: string) => list.filter((h) => h.identity !== identity);

/* ------------------------------------------------------------------ whiteboard */
export interface BStroke { id: string; owner: string; tool: Tool; color: string; size: number; pts: number[]; done: boolean }
export interface BoardState { strokes: BStroke[]; /** may learners draw? (teacher-controlled) */ open: boolean }
export const emptyBoard = (): BoardState => ({ strokes: [], open: false });

export interface SnapStroke { id: string; owner: string; tool: Tool; color: string; size: number; pts: number[] }
export type BoardMsg =
  | { t: 'stroke'; id: string; tool: Tool; color: string; size: number; pts: number[]; mode: 'new' | 'append' | 'replace'; done: boolean }
  | { t: 'clear' } | { t: 'undo'; id: string } | { t: 'open'; open: boolean } | { t: 'req' }
  | { t: 'snap'; sid: string; i: number; n: number; open: boolean; strokes: SnapStroke[] };

const TOOL_VALUES = TOOLS.map((t) => t.value) as string[];
const isTool = (v: unknown): v is Tool => typeof v === 'string' && TOOL_VALUES.includes(v);
const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const isSize = (v: unknown): v is number => typeof v === 'number' && v > 0 && v <= 60;
/** Even-length list of finite numbers, clamped to the board and rounded (keeps packets small). */
function cleanPts(v: unknown, maxPts: number): number[] | null {
  if (!Array.isArray(v) || v.length < 2 || v.length % 2 !== 0 || v.length > maxPts * 2) return null;
  const out: number[] = [];
  for (let i = 0; i < v.length; i += 2) {
    const x = v[i], y = v[i + 1];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push(Math.round(Math.min(PAD_W, Math.max(0, x))), Math.round(Math.min(PAD_H, Math.max(0, y))));
  }
  return out;
}

export function decodeBoard(bytes: Uint8Array): BoardMsg | null {
  const m = parse(bytes); if (!m) return null;
  switch (m.t) {
    case 'stroke': {
      const pts = cleanPts(m.pts, MAX_PTS_PER_MESSAGE);
      if (!isId(m.id) || !isTool(m.tool) || !isColor(m.color) || !isSize(m.size) || !pts || (m.mode !== 'new' && m.mode !== 'append' && m.mode !== 'replace') || typeof m.done !== 'boolean') return null;
      return { t: 'stroke', id: m.id, tool: m.tool, color: m.color, size: m.size, pts, mode: m.mode, done: m.done };
    }
    case 'clear': case 'req': return { t: m.t };
    case 'undo': return isId(m.id) ? { t: 'undo', id: m.id } : null;
    case 'open': return typeof m.open === 'boolean' ? { t: 'open', open: m.open } : null;
    case 'snap': {
      if (!isId(m.sid) || typeof m.i !== 'number' || typeof m.n !== 'number' || !Number.isInteger(m.i) || !Number.isInteger(m.n) || m.n < 1 || m.n > 200 || m.i < 0 || m.i >= m.n || typeof m.open !== 'boolean' || !Array.isArray(m.strokes)) return null;
      const strokes: SnapStroke[] = [];
      for (const s of m.strokes.slice(0, 200)) {
        const x = s as Record<string, unknown>; const pts = cleanPts(x?.pts, SNAPSHOT_MAX_POINTS);
        if (!x || !isId(x.id) || typeof x.owner !== 'string' || x.owner.length > 64 || !isTool(x.tool) || !isColor(x.color) || !isSize(x.size) || !pts) continue;
        strokes.push({ id: x.id, owner: x.owner, tool: x.tool, color: x.color, size: x.size, pts });
      }
      return { t: 'snap', sid: m.sid, i: m.i, n: m.n, open: m.open, strokes };
    }
    default: return null;
  }
}

const isShapeTool = (t: Tool) => t === 'line' || t === 'rect' || t === 'ellipse';

/**
 * Applies one board message from `from`. Host-only: clear, open/close, snapshots. A learner may draw only while the board is open,
 * can only extend their OWN strokes, and can only undo their own. Returns the same object when nothing changed.
 */
export function boardApply(s: BoardState, msg: BoardMsg, from: Sender): BoardState {
  const host = from.role === 'host';
  switch (msg.t) {
    case 'open': return host && s.open !== msg.open ? { ...s, open: msg.open } : s;
    case 'clear': return host && s.strokes.length ? { ...s, strokes: [] } : s;
    case 'undo': {
      const st = s.strokes.find((x) => x.id === msg.id);
      if (!st || !(host || (s.open && st.owner === from.identity))) return s;
      return { ...s, strokes: s.strokes.filter((x) => x.id !== msg.id) };
    }
    case 'stroke': {
      if (!host && !s.open) return s;
      if (from.role == null) return s;
      const i = s.strokes.findIndex((x) => x.id === msg.id);
      if (msg.mode === 'new') {
        if (i >= 0) return s;
        const pts = isShapeTool(msg.tool) ? msg.pts.slice(0, 4) : msg.pts;
        const next = [...s.strokes, { id: msg.id, owner: from.identity, tool: msg.tool, color: msg.color, size: msg.size, pts, done: msg.done }];
        return { ...s, strokes: next.length > MAX_STROKES ? next.slice(next.length - MAX_STROKES) : next };
      }
      if (i < 0) return s;
      const cur = s.strokes[i]!;
      if (cur.owner !== from.identity || cur.done) return s;
      const pts = msg.mode === 'replace' ? (isShapeTool(cur.tool) && msg.pts.length >= 4 ? msg.pts.slice(0, 4) : cur.pts) : [...cur.pts, ...msg.pts].slice(0, MAX_POINTS * 2);
      const strokes = s.strokes.slice(); strokes[i] = { ...cur, pts, done: msg.done };
      return { ...s, strokes };
    }
    default: return s;      // 'req' and 'snap' are handled by the room code, not here
  }
}

/** Thins a long point list to at most `maxPts` points, always keeping the first and last. */
export function thin(pts: number[], maxPts: number): number[] {
  const n = pts.length / 2; if (n <= maxPts) return pts;
  const out: number[] = []; const step = (n - 1) / (maxPts - 1);
  for (let k = 0; k < maxPts; k++) { const i = Math.round(k * step); out.push(pts[i * 2]!, pts[i * 2 + 1]!); }
  return out;
}

/** Splits the whole board into packets that each fit the size limit (for people who join late). */
export function snapshotMessages(s: BoardState, sid: string): BoardMsg[] {
  const strokes: SnapStroke[] = s.strokes.map((x) => ({ id: x.id, owner: x.owner, tool: x.tool, color: x.color, size: x.size, pts: thin(x.pts, SNAPSHOT_MAX_POINTS) }));
  const groups: SnapStroke[][] = [[]];
  for (const st of strokes) {
    const cur = groups[groups.length - 1]!;
    const probe = encode({ t: 'snap', sid, i: 0, n: 99, open: s.open, strokes: [...cur, st] });
    if (probe === null && cur.length > 0) groups.push([st]); else cur.push(st);
  }
  return groups.map((g, i) => ({ t: 'snap', sid, i, n: groups.length, open: s.open, strokes: g }));
}

/** Collects snapshot packets (they can arrive in any order) and yields the whole board once complete. */
export class SnapshotAssembler {
  private parts = new Map<string, { n: number; open: boolean; got: Map<number, SnapStroke[]> }>();
  add(m: Extract<BoardMsg, { t: 'snap' }>): { strokes: BStroke[]; open: boolean } | null {
    let e = this.parts.get(m.sid);
    if (!e) { if (this.parts.size >= 4) this.parts.delete(this.parts.keys().next().value as string); e = { n: m.n, open: m.open, got: new Map() }; this.parts.set(m.sid, e); }
    if (m.n !== e.n) return null;
    e.got.set(m.i, m.strokes);
    if (e.got.size < e.n) return null;
    this.parts.delete(m.sid);
    const strokes: BStroke[] = [];
    for (let i = 0; i < e.n; i++) for (const s of e.got.get(i) ?? []) strokes.push({ ...s, done: true });
    return { strokes: strokes.slice(-MAX_STROKES), open: e.open };
  }
}

/**
 * Turns pointer movement into a few small messages per second instead of one per pixel.
 * Freehand: new points are sent in chunks. Shapes: only the latest start/end pair. The last call has done = true.
 */
export function createStrokeSender(o: { id: string; tool: Tool; color: string; size: number }, emit: (m: Extract<BoardMsg, { t: 'stroke' }>) => void) {
  const shape = isShapeTool(o.tool);
  let pending: number[] = []; let first: number[] | null = null; let last: number[] | null = null; let started = false; let sentEnd = '';
  const send = (pts: number[], done: boolean) => { emit({ t: 'stroke', id: o.id, tool: o.tool, color: o.color, size: o.size, pts, mode: started ? (shape ? 'replace' : 'append') : 'new', done }); started = true; };
  return {
    push(x: number, y: number) { if (!first) first = [x, y]; last = [x, y]; if (!shape) pending.push(x, y); },
    flush(done: boolean) {
      if (shape) {
        if (!first || !last) return;
        const end = `${last[0]},${last[1]}`;
        if (!started || done || end !== sentEnd) { send([first[0]!, first[1]!, last[0]!, last[1]!], done); sentEnd = end; }      // nothing new since the last send: stay quiet
        return;
      }
      if (pending.length === 0) { if (done && started) send(last ? [last[0]!, last[1]!] : [0, 0], true); return; }
      for (let i = 0; i < pending.length; i += MAX_PTS_PER_MESSAGE * 2) {
        const chunk = pending.slice(i, i + MAX_PTS_PER_MESSAGE * 2); const lastChunk = i + MAX_PTS_PER_MESSAGE * 2 >= pending.length;
        send(chunk, done && lastChunk);
      }
      pending = [];
    },
  };
}

/* ------------------------------------------------------------------ video tiles */
export interface TilePerson { identity: string; role: SenderRole | null; isLocal: boolean; speaking: boolean; sharing: boolean; handUp: boolean; name: string }
/**
 * Which people get a video tile when there is room for only `max`. Everyone else stays in the participants list and (because their
 * video is not shown) is not downloaded: this is the "video prioritisation" for weak connections.
 * Order: the teacher, whoever is sharing, whoever is speaking, raised hands, you, then by name.
 */
export function pickTiles<T extends TilePerson>(people: T[], max: number): T[] {
  const score = (p: T) => (p.role === 'host' ? 0 : p.sharing ? 1 : p.speaking ? 2 : p.handUp ? 3 : p.isLocal ? 4 : 5);
  return [...people].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name)).slice(0, Math.max(1, max));
}
