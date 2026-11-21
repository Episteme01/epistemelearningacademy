import { describe, expect, it } from 'vitest';
import {
  MAX_CHAT_CHARS, MAX_PACKET_BYTES, RateLimiter, SnapshotAssembler, boardApply, cleanChat, createStrokeSender, decodeBoard, decodeChat, decodeHand, emptyBoard,
  encode, handApply, handRemove, newId, pickTiles, roleOfMetadata, snapshotMessages, thin, type BoardMsg, type BoardState, type Sender, type TilePerson,
} from '@/lib/live/protocol';

const host: Sender = { identity: 'hhhh', role: 'host' };
const kid: Sender = { identity: 'kid1', role: 'learner' };
const kid2: Sender = { identity: 'kid2', role: 'learner' };
const stranger: Sender = { identity: 'zzzz', role: null };
const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const stroke = (id: string, over: Partial<Extract<BoardMsg, { t: 'stroke' }>> = {}): Extract<BoardMsg, { t: 'stroke' }> =>
  ({ t: 'stroke', id, tool: 'pen', color: '#111111', size: 4, pts: [1, 1, 5, 5], mode: 'new', done: false, ...over });

describe('who sent it (role from the server-issued token)', () => {
  it('reads the role from token metadata, and nothing else', () => {
    expect(roleOfMetadata('{"r":"host"}')).toBe('host'); expect(roleOfMetadata('{"r":"learner"}')).toBe('learner');
    expect(roleOfMetadata('{"r":"admin"}')).toBeNull(); expect(roleOfMetadata('nope')).toBeNull(); expect(roleOfMetadata(undefined)).toBeNull(); expect(roleOfMetadata('')).toBeNull();
  });
  it('packets: size limit and round trip', () => {
    expect(encode({ a: 1 })).not.toBeNull();
    expect(encode({ a: 'x'.repeat(MAX_PACKET_BYTES) })).toBeNull();
    expect(newId()).toMatch(/^[a-z0-9]{14}$/);
  });
  it('rate limiter', () => {
    const r = new RateLimiter(3, 10_000);
    expect([0, 1, 2, 3].map((i) => r.allow('a', i * 100))).toEqual([true, true, true, false]);
    expect(r.allow('b', 300)).toBe(true);             // another sender has its own allowance
    expect(r.allow('a', 10_500)).toBe(true);          // the window has passed
  });
});

describe('chat', () => {
  it('is plain text, trimmed and limited', () => {
    expect(cleanChat('  hello \u0007 world  ')).toBe('hello world');
    expect(cleanChat('a'.repeat(1000)).length).toBe(MAX_CHAT_CHARS);
    expect(cleanChat('   ')).toBe(''); expect(cleanChat(42)).toBe('');
    expect(cleanChat('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');   // kept as text; rendered as a text node, never as HTML
  });
  it('only a host can send an announcement', () => {
    const m = bytes({ t: 'msg', id: 'abcd1234', text: 'Homework!', ann: true });
    expect(decodeChat(m, host)).toEqual({ t: 'msg', id: 'abcd1234', text: 'Homework!', ann: true });
    expect(decodeChat(m, kid)).toEqual({ t: 'msg', id: 'abcd1234', text: 'Homework!' });
  });
  it('rejects malformed packets', () => {
    expect(decodeChat(bytes({ t: 'msg', id: 'x', text: 'hi' }), kid)).toBeNull();            // bad id
    expect(decodeChat(bytes({ t: 'msg', id: 'abcd1234', text: '' }), kid)).toBeNull();
    expect(decodeChat(new TextEncoder().encode('not json'), kid)).toBeNull();
    expect(decodeChat(bytes([1, 2]), kid)).toBeNull();
  });
});

describe('hand raising', () => {
  it('raise, lower, queue order, no duplicates', () => {
    let q = handApply([], { t: 'hand', up: true }, kid, 1);
    q = handApply(q, { t: 'hand', up: true }, kid2, 2); q = handApply(q, { t: 'hand', up: true }, kid, 3);
    expect(q.map((h) => h.identity)).toEqual(['kid1', 'kid2']);
    q = handApply(q, { t: 'hand', up: false }, kid, 4);
    expect(q.map((h) => h.identity)).toEqual(['kid2']);
  });
  it('only the teacher can acknowledge, clear or sync the queue', () => {
    const q = [{ identity: 'kid1', since: 1 }, { identity: 'kid2', since: 2 }];
    expect(handApply(q, { t: 'ack', who: 'kid1' }, kid2, 5)).toBe(q);
    expect(handApply(q, { t: 'clear' }, kid, 5)).toBe(q);
    expect(handApply(q, { t: 'state', up: [] }, stranger, 5)).toBe(q);
    expect(handApply(q, { t: 'ack', who: 'kid1' }, host, 5).map((h) => h.identity)).toEqual(['kid2']);
    expect(handApply(q, { t: 'clear' }, host, 5)).toEqual([]);
  });
  it('decodes and validates; people who leave are removed', () => {
    expect(decodeHand(bytes({ t: 'hand', up: true }))).toEqual({ t: 'hand', up: true });
    expect(decodeHand(bytes({ t: 'hand', up: 'yes' }))).toBeNull();
    expect(decodeHand(bytes({ t: 'state', up: [{ identity: 'a', since: 1 }, { identity: 5, since: 1 }] }))).toEqual({ t: 'state', up: [{ identity: 'a', since: 1 }] });
    expect(handRemove([{ identity: 'a', since: 1 }, { identity: 'b', since: 2 }], 'a')).toEqual([{ identity: 'b', since: 2 }]);
  });
});

describe('whiteboard: who may draw', () => {
  const apply = (s: BoardState, m: BoardMsg, from: Sender) => boardApply(s, m, from);
  it('the teacher can always draw; learners only while the board is open', () => {
    let s = apply(emptyBoard(), stroke('s1aa'), host); expect(s.strokes).toHaveLength(1);
    expect(apply(s, stroke('s2aa'), kid)).toBe(s);                       // closed: ignored
    s = apply(s, { t: 'open', open: true }, host);
    s = apply(s, stroke('s2aa'), kid); expect(s.strokes.map((x) => x.owner)).toEqual(['hhhh', 'kid1']);
    s = apply(s, { t: 'open', open: false }, host);
    expect(apply(s, stroke('s3aa'), kid)).toBe(s);
  });
  it('a learner cannot open the board, clear it, or draw as someone unidentified', () => {
    const s = apply(emptyBoard(), stroke('s1aa'), host);
    expect(apply(s, { t: 'open', open: true }, kid)).toBe(s);
    expect(apply(s, { t: 'clear' }, kid)).toBe(s);
    const open = { ...s, open: true };
    expect(apply(open, stroke('s9aa'), stranger)).toBe(open);
    expect(apply(s, { t: 'clear' }, host).strokes).toEqual([]);
  });
  it('strokes can only be extended by their owner, and not once finished', () => {
    let s: BoardState = { strokes: [], open: true };
    s = apply(s, stroke('s1aa', { pts: [0, 0, 1, 1] }), kid);
    expect(apply(s, stroke('s1aa', { mode: 'append', pts: [9, 9] }), kid2)).toBe(s);          // someone else
    s = apply(s, stroke('s1aa', { mode: 'append', pts: [9, 9], done: true }), kid);
    expect(s.strokes[0]!.pts).toEqual([0, 0, 1, 1, 9, 9]); expect(s.strokes[0]!.done).toBe(true);
    expect(apply(s, stroke('s1aa', { mode: 'append', pts: [7, 7] }), kid)).toBe(s);          // finished
  });
  it('shapes keep only a start and an end point; replace updates them', () => {
    let s = apply(emptyBoard(), stroke('r1aa', { tool: 'rect', pts: [1, 1, 2, 2] }), host);
    s = apply(s, stroke('r1aa', { tool: 'rect', mode: 'replace', pts: [1, 1, 50, 60], done: true }), host);
    expect(s.strokes[0]!.pts).toEqual([1, 1, 50, 60]);
  });
  it('undo: own stroke for learners (while open), any stroke for the teacher', () => {
    let s: BoardState = { strokes: [], open: true };
    s = apply(s, stroke('k1aa'), kid); s = apply(s, stroke('k2aa'), kid2);
    expect(apply(s, { t: 'undo', id: 'k2aa' }, kid)).toBe(s);
    expect(apply(s, { t: 'undo', id: 'k1aa' }, kid).strokes.map((x) => x.id)).toEqual(['k2aa']);
    expect(apply(s, { t: 'undo', id: 'k2aa' }, host).strokes.map((x) => x.id)).toEqual(['k1aa']);
  });
  it('is capped (stroke count)', () => {
    let s: BoardState = { strokes: [], open: true };
    for (let i = 0; i < 1510; i++) s = apply(s, stroke(`id${String(i).padStart(5, '0')}`), host);
    expect(s.strokes.length).toBe(1500); expect(s.strokes[0]!.id).toBe('id00010');
  });
});

describe('whiteboard packets are validated', () => {
  it('accepts a good stroke and rounds/clamps points', () => {
    const m = decodeBoard(bytes({ t: 'stroke', id: 'abcd', tool: 'pen', color: '#0B3D2E', size: 4, pts: [-5, 10.4, 5000, 9999], mode: 'new', done: false }));
    expect(m).toMatchObject({ t: 'stroke', pts: [0, 10, 1200, 800] });
  });
  it('rejects bad tool, colour, size, odd point list, NaN, too many points', () => {
    const ok = { t: 'stroke', id: 'abcd', tool: 'pen', color: '#111111', size: 4, pts: [1, 1], mode: 'new', done: false };
    expect(decodeBoard(bytes(ok))).not.toBeNull();
    for (const bad of [{ tool: 'laser' }, { color: 'red' }, { size: 500 }, { size: 0 }, { pts: [1] }, { pts: [1, 'a'] }, { pts: [] }, { mode: 'x' }, { id: '../' }, { pts: new Array(400).fill(1) }])
      expect(decodeBoard(bytes({ ...ok, ...bad }))).toBeNull();
    expect(decodeBoard(bytes({ t: 'whatever' }))).toBeNull();
  });
});

describe('whiteboard: snapshot for people who join late', () => {
  const longStroke = (i: number) => ({ id: `s${String(i).padStart(5, '0')}`, owner: 'hhhh', tool: 'pen' as const, color: '#111111', size: 4, pts: Array.from({ length: 2000 }, (_, k) => (k * 7 + i) % 1100), done: true });
  it('thins long strokes but keeps the first and last point', () => {
    const t = thin([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9], 4);
    expect(t.length).toBe(8); expect(t.slice(0, 2)).toEqual([0, 0]); expect(t.slice(-2)).toEqual([9, 9]);
    expect(thin([1, 2, 3, 4], 10)).toEqual([1, 2, 3, 4]);
  });
  it('splits into packets that fit, and reassembles in any order', () => {
    const board: BoardState = { open: true, strokes: Array.from({ length: 30 }, (_, i) => longStroke(i)) };
    const msgs = snapshotMessages(board, 'snap01');
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(encode(m)).not.toBeNull();
    const asm = new SnapshotAssembler(); let out = null as ReturnType<SnapshotAssembler['add']>;
    for (const m of [...msgs].reverse()) { const dec = decodeBoard(encode(m)!); expect(dec).not.toBeNull(); out = asm.add(dec as Extract<BoardMsg, { t: 'snap' }>); }
    expect(out).not.toBeNull(); expect(out!.open).toBe(true); expect(out!.strokes.length).toBe(30);
    expect(out!.strokes.every((s) => s.done && s.pts.length <= 1000)).toBe(true);
  });
  it('an incomplete snapshot yields nothing', () => {
    const board: BoardState = { open: false, strokes: Array.from({ length: 30 }, (_, i) => longStroke(i)) };
    const msgs = snapshotMessages(board, 'snap02'); const asm = new SnapshotAssembler();
    expect(msgs.slice(0, -1).map((m) => asm.add(m as Extract<BoardMsg, { t: 'snap' }>)).every((x) => x === null)).toBe(true);
  });
});

describe('batching pointer movement', () => {
  it('freehand: points go out in chunks; the last message is marked done', () => {
    const out: Extract<BoardMsg, { t: 'stroke' }>[] = []; const s = createStrokeSender({ id: 'abcd', tool: 'pen', color: '#111111', size: 4 }, (m) => out.push(m));
    for (let i = 0; i < 400; i++) s.push(i, i);
    s.flush(false); s.push(500, 500); s.flush(true);
    expect(out[0]!.mode).toBe('new'); expect(out.slice(1).every((m) => m.mode === 'append')).toBe(true);
    expect(out.every((m) => m.pts.length <= 300)).toBe(true);
    expect(out.map((m) => m.pts.length / 2).reduce((a, b) => a + b, 0)).toBe(401);
    expect(out.filter((m) => m.done).length).toBe(1); expect(out[out.length - 1]!.done).toBe(true);
  });
  it('shapes: only start and latest end are sent', () => {
    const out: Extract<BoardMsg, { t: 'stroke' }>[] = []; const s = createStrokeSender({ id: 'abcd', tool: 'rect', color: '#111111', size: 4 }, (m) => out.push(m));
    s.push(10, 10); s.push(20, 20); s.push(30, 40); s.flush(false); s.flush(false); s.push(50, 60); s.flush(true);
    expect(out.map((m) => [m.mode, m.pts.join(','), m.done])).toEqual([['new', '10,10,30,40', false], ['replace', '10,10,50,60', true]]);
  });
});

describe('which people get a video tile', () => {
  const p = (name: string, o: Partial<TilePerson> = {}): TilePerson => ({ identity: name, role: 'learner', isLocal: false, speaking: false, sharing: false, handUp: false, name, ...o });
  it('teacher, sharer, speaker, raised hand, then you, then alphabetical', () => {
    const people = [p('Zed'), p('Amy'), p('Me', { isLocal: true }), p('Hand', { handUp: true }), p('Talk', { speaking: true }), p('Share', { sharing: true }), p('Teacher', { role: 'host' })];
    expect(pickTiles(people, 4).map((x) => x.name)).toEqual(['Teacher', 'Share', 'Talk', 'Hand']);
    expect(pickTiles(people, 99).map((x) => x.name)).toEqual(['Teacher', 'Share', 'Talk', 'Hand', 'Me', 'Amy', 'Zed']);
    expect(pickTiles(people, 0)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ slides, spotlight, poll */
import { MAX_SLIDES, countVotes, decodePoll, decodeSlides, decodeSpot, isSlideUrl, pollApply, recordVote, slidesApply, spotApply, type PollState } from '@/lib/live/protocol';
const raw = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const HOST_S = { identity: 'h', role: 'host' as const }; const LEARN_S = { identity: 'l1', role: 'learner' as const };
const U1 = 'https://res.cloudinary.com/demo/image/upload/v1/ela/staff/a.jpg';
const U2 = 'https://res.cloudinary.com/demo/image/upload/v1/ela/staff/b.jpg';

describe('slides', () => {
  it('only pictures from the school image host are accepted', () => {
    expect(isSlideUrl(U1)).toBe(true);
    for (const bad of ['http://res.cloudinary.com/a.jpg', 'https://evil.example/a.jpg', 'https://res.cloudinary.com.evil.example/a.jpg', 'javascript:alert(1)', 'https://res.cloudinary.com/a b.jpg', 42]) expect(isSlideUrl(bad)).toBe(false);
  });
  it('decodes show/page/stop and rejects bad input', () => {
    expect(decodeSlides(raw({ t: 'show', urls: [U1, U2], page: 1 }))).toEqual({ t: 'show', urls: [U1, U2], page: 1 });
    expect(decodeSlides(raw({ t: 'show', urls: [U1, 'https://evil.example/x.png'], page: 0 }))).toBeNull();
    expect(decodeSlides(raw({ t: 'show', urls: [], page: 0 }))).toBeNull();
    expect(decodeSlides(raw({ t: 'show', urls: Array(MAX_SLIDES + 1).fill(U1), page: 0 }))).toBeNull();
    expect(decodeSlides(raw({ t: 'page', page: -1 }))).toBeNull();
    expect(decodeSlides(raw({ t: 'stop' }))).toEqual({ t: 'stop' });
  });
  it('a bad page number is clamped into range', () => expect(decodeSlides(raw({ t: 'show', urls: [U1, U2], page: 99 }))).toMatchObject({ page: 1 }));
  it('only the teacher can show, turn pages or stop', () => {
    const shown = slidesApply(null, { t: 'show', urls: [U1, U2], page: 0 }, HOST_S)!;
    expect(shown.page).toBe(0);
    expect(slidesApply(null, { t: 'show', urls: [U1], page: 0 }, LEARN_S)).toBeNull();
    expect(slidesApply(shown, { t: 'page', page: 1 }, LEARN_S)).toBe(shown);
    expect(slidesApply(shown, { t: 'page', page: 1 }, HOST_S)!.page).toBe(1);
    expect(slidesApply(shown, { t: 'page', page: 9 }, HOST_S)!.page).toBe(1);
    expect(slidesApply(shown, { t: 'stop' }, LEARN_S)).toBe(shown);
    expect(slidesApply(shown, { t: 'stop' }, HOST_S)).toBeNull();
  });
});

describe('spotlight', () => {
  it('only the teacher can spotlight', () => {
    const m = decodeSpot(raw({ t: 'spot', who: 'abc' }))!;
    expect(spotApply('', m, HOST_S)).toBe('abc');
    expect(spotApply('', m, LEARN_S)).toBe('');
    expect(spotApply('abc', { t: 'spot', who: '' }, HOST_S)).toBe('');
  });
  it('rejects a huge or non-text target', () => { expect(decodeSpot(raw({ t: 'spot', who: 'x'.repeat(65) }))).toBeNull(); expect(decodeSpot(raw({ t: 'spot', who: 5 }))).toBeNull(); });
});

describe('poll', () => {
  const open = decodePoll(raw({ t: 'open', id: 'poll1', q: ' Which is right? ', opts: ['A', 'B', ' ', 'C'] }))!;
  it('cleans the question, drops empty options, needs at least two', () => {
    expect(open).toEqual({ t: 'open', id: 'poll1', q: 'Which is right?', opts: ['A', 'B', 'C'] });
    expect(decodePoll(raw({ t: 'open', id: 'poll1', q: 'Q', opts: ['only one'] }))).toBeNull();
    expect(decodePoll(raw({ t: 'open', id: 'poll1', q: '', opts: ['a', 'b'] }))).toBeNull();
  });
  it('only the teacher can open, update or end a poll', () => {
    expect(pollApply(null, open, LEARN_S)).toBeNull();
    const st = pollApply(null, open, HOST_S)!; expect(st.counts).toEqual([0, 0, 0]); expect(st.open).toBe(true);
    expect(pollApply(st, { t: 'tally', id: 'poll1', counts: [3, 1, 0], open: true }, LEARN_S)).toBe(st);
    expect(pollApply(st, { t: 'tally', id: 'poll1', counts: [3, 1, 0], open: false }, HOST_S)).toMatchObject({ counts: [3, 1, 0], open: false });
    expect(pollApply(st, { t: 'tally', id: 'other', counts: [3, 1, 0], open: false }, HOST_S)).toBe(st);
    expect(pollApply(st, { t: 'tally', id: 'poll1', counts: [3, 1], open: false }, HOST_S)).toBe(st);
    expect(pollApply(st, { t: 'end', id: 'poll1' }, LEARN_S)).toBe(st);
    expect(pollApply(st, { t: 'end', id: 'poll1' }, HOST_S)).toBeNull();
  });
  const st: PollState = { id: 'poll1', q: 'Q', opts: ['A', 'B', 'C'], open: true, counts: [0, 0, 0] };
  it('counts one vote per learner and lets them change it', () => {
    let v: Record<string, number> = {};
    v = recordVote(v, st, { t: 'vote', id: 'poll1', opt: 0 }, LEARN_S);
    v = recordVote(v, st, { t: 'vote', id: 'poll1', opt: 2 }, LEARN_S);
    v = recordVote(v, st, { t: 'vote', id: 'poll1', opt: 2 }, { identity: 'l2', role: 'learner' });
    expect(countVotes(v, 3)).toEqual([0, 0, 2]);
  });
  it('ignores votes from the teacher or unknown people, for another poll, a closed poll, or a missing option', () => {
    const none: Record<string, number> = {};
    expect(recordVote(none, st, { t: 'vote', id: 'poll1', opt: 0 }, HOST_S)).toBe(none);
    expect(recordVote(none, st, { t: 'vote', id: 'poll1', opt: 0 }, { identity: 'x', role: null })).toBe(none);
    expect(recordVote(none, st, { t: 'vote', id: 'nope', opt: 0 }, LEARN_S)).toBe(none);
    expect(recordVote(none, { ...st, open: false }, { t: 'vote', id: 'poll1', opt: 0 }, LEARN_S)).toBe(none);
    expect(recordVote(none, st, { t: 'vote', id: 'poll1', opt: 3 }, LEARN_S)).toBe(none);
    expect(recordVote(none, null, { t: 'vote', id: 'poll1', opt: 0 }, LEARN_S)).toBe(none);
  });
});
