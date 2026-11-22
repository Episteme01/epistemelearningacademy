// Pure logic for the live classroom's data channel: chat, hand raising and the shared whiteboard.
// No DOM and no LiveKit imports, so all of it is unit-tested in Node (tests/liveProtocol.test.ts).
//
// Trust model: LiveKit tells us WHO sent a data message (the sender's identity and the role the server put in their token).
// A message body is never trusted: every field is validated here, "host-only" messages are ignored from anyone whose
// server-issued role is not host, and learners can draw only while the teacher has opened the board.
import { MAX_POINTS, MAX_STROKES, PAD_H, PAD_W, TOOLS, type Tool } from '@/lib/drawing';

export type SenderRole = 'host' | 'learner';
export interface Sender { identity: string; role: SenderRole | null }

export const TOPIC = { chat: 'chat', hand: 'hand', board: 'board', slides: 'slides', spot: 'spot', poll: 'poll' } as const;
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


/* ------------------------------------------------------------------ teacher tools: slides, spotlight, poll */
// Every one of these is teacher-driven. "Host-only" messages are ignored from anyone whose server-issued role is not host.
const cleanLine = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Slides: pictures the teacher uploaded for this lesson, shown to everyone at the same page. */
export const MAX_SLIDES = 30;
/** `write`: everyone writes on the page being shown (it becomes the shared board with the picture behind it). */
export interface SlidesState { urls: string[]; page: number; write: boolean }
export type SlidesMsg = { t: 'show'; urls: string[]; page: number; write?: boolean } | { t: 'page'; page: number } | { t: 'write'; on: boolean } | { t: 'stop' };
/** Only https pictures from the school's image host: a message can never point the room at some other site. */
export const isSlideUrl = (v: unknown): v is string => typeof v === 'string' && v.length <= 300 && /^https:\/\/res\.cloudinary\.com\/[^\s"'<>\\]+$/.test(v);
const clampPage = (n: unknown, len: number) => (typeof n === 'number' && Number.isInteger(n) ? Math.min(Math.max(0, n), Math.max(0, len - 1)) : 0);
export function decodeSlides(bytes: Uint8Array): SlidesMsg | null {
  const m = parse(bytes); if (!m) return null;
  if (m.t === 'stop') return { t: 'stop' };
  if (m.t === 'write') return typeof m.on === 'boolean' ? { t: 'write', on: m.on } : null;
  if (m.t === 'page') return typeof m.page === 'number' && Number.isInteger(m.page) && m.page >= 0 && m.page < MAX_SLIDES ? { t: 'page', page: m.page } : null;
  if (m.t === 'show') {
    if (!Array.isArray(m.urls) || m.urls.length < 1 || m.urls.length > MAX_SLIDES || !m.urls.every(isSlideUrl)) return null;
    return { t: 'show', urls: m.urls as string[], page: clampPage(m.page, m.urls.length), write: m.write === true };
  }
  return null;
}
export function slidesApply(prev: SlidesState | null, msg: SlidesMsg, from: Sender): SlidesState | null {
  if (from.role !== 'host') return prev;
  if (msg.t === 'stop') return null;
  if (msg.t === 'show') return { urls: msg.urls, page: msg.page, write: msg.write === true };
  if (msg.t === 'write') return prev ? { ...prev, write: msg.on } : prev;
  return prev ? { ...prev, page: clampPage(msg.page, prev.urls.length) } : prev;
}

/** Spotlight: the teacher puts one person on everyone's big screen ('' = back to normal). */
export type SpotMsg = { t: 'spot'; who: string };
export function decodeSpot(bytes: Uint8Array): SpotMsg | null {
  const m = parse(bytes); return m && m.t === 'spot' && typeof m.who === 'string' && m.who.length <= 64 ? { t: 'spot', who: m.who } : null;
}
export const spotApply = (prev: string, msg: SpotMsg, from: Sender): string => (from.role === 'host' ? msg.who : prev);

/** Quick poll: the teacher asks, learners pick one option, the teacher sees the counts. One vote per person; a vote can be changed until the poll closes. */
export const MAX_POLL_OPTS = 6;
export interface PollState { id: string; q: string; opts: string[]; open: boolean; counts: number[] }
export type PollMsg =
  | { t: 'open'; id: string; q: string; opts: string[] }
  | { t: 'vote'; id: string; opt: number }
  | { t: 'tally'; id: string; counts: number[]; open: boolean }
  | { t: 'end'; id: string };
export function decodePoll(bytes: Uint8Array): PollMsg | null {
  const m = parse(bytes); if (!m || !isId(m.id)) return null;
  if (m.t === 'end') return { t: 'end', id: m.id };
  if (m.t === 'vote') return typeof m.opt === 'number' && Number.isInteger(m.opt) && m.opt >= 0 && m.opt < MAX_POLL_OPTS ? { t: 'vote', id: m.id, opt: m.opt } : null;
  if (m.t === 'open') {
    const q = cleanLine(m.q, 140); if (!q || !Array.isArray(m.opts)) return null;
    const opts = m.opts.slice(0, MAX_POLL_OPTS).map((o) => cleanLine(o, 60)).filter(Boolean);
    return opts.length >= 2 ? { t: 'open', id: m.id, q, opts } : null;
  }
  if (m.t === 'tally') {
    if (!Array.isArray(m.counts) || m.counts.length < 2 || m.counts.length > MAX_POLL_OPTS || typeof m.open !== 'boolean') return null;
    const counts = m.counts.map((c) => (typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 100_000 ? c : 0));
    return { t: 'tally', id: m.id, counts, open: m.open };
  }
  return null;
}
/** What everyone's screen shows. Only the host can open, update or end a poll. Votes are handled separately (the host counts them). */
export function pollApply(prev: PollState | null, msg: PollMsg, from: Sender): PollState | null {
  if (from.role !== 'host') return prev;
  if (msg.t === 'open') return { id: msg.id, q: msg.q, opts: msg.opts, open: true, counts: msg.opts.map(() => 0) };
  if (msg.t === 'end') return prev && prev.id === msg.id ? null : prev;
  if (msg.t === 'tally') return prev && prev.id === msg.id && msg.counts.length === prev.opts.length ? { ...prev, counts: msg.counts, open: msg.open } : prev;
  return prev;
}
/** The host's tally: identity -> option. Only learners vote, only while the poll is open, only for a real option; the latest vote from a person replaces their earlier one. */
export function recordVote(votes: Record<string, number>, poll: PollState | null, msg: PollMsg, from: Sender): Record<string, number> {
  if (msg.t !== 'vote' || !poll || !poll.open || msg.id !== poll.id || from.role !== 'learner' || msg.opt >= poll.opts.length) return votes;
  return votes[from.identity] === msg.opt ? votes : { ...votes, [from.identity]: msg.opt };
}
export const countVotes = (votes: Record<string, number>, nOpts: number): number[] => {
  const c = Array.from({ length: nOpts }, () => 0);
  for (const v of Object.values(votes)) if (v >= 0 && v < nOpts) c[v]! += 1;
  return c;
};
