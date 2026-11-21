// Pure rules for the ELA Live Classroom gateway. No Deno, browser or network APIs here (only Web Crypto),
// so everything in this file is unit-tested in Node (tests/live.test.ts). The Edge Function (index.ts) only wires it up.
// KEEP IN SYNC with src/lib/attendance.ts `timingFrom` (tests/live.test.ts fails if they drift apart).

export const LIVE_PROVIDER = 'ela_live';
/** Learners and hosts may enter from this long before the scheduled start (same as the external-link window in firestore.rules). */
export const JOIN_BEFORE_MS = 15 * 60_000;
/** ...until this long after the scheduled end. */
export const JOIN_AFTER_MS = 30 * 60_000;
/** LiveKit access tokens are short-lived. The browser asks for a new one when it needs to reconnect later. */
export const TOKEN_TTL_SECONDS = 20 * 60;
/** A room with nobody in it closes after this long, so a teacher dropping off does not end the lesson at once. */
export const EMPTY_TIMEOUT_SECONDS = 10 * 60;
/** Never above the LiveKit free plan's 100 concurrent participants. */
export const MAX_ROOM_PARTICIPANTS = 100;
/** Connected for less than this share of the scheduled lesson = "left early" (teachers can still correct it). */
export const MIN_PRESENT_FRACTION = 0.5;
export const DEFAULT_GRACE_MINUTES = 5;

/** Who may host (start, moderate, end). A teacher can only host their own lesson. */
export const HOST_ROLES = ['super_admin', 'admin', 'principal'] as const;

export type LiveRole = 'host' | 'learner';

export interface SessionFacts {
  id: string;
  teacherUid: string;
  studentUids: string[];
  startMs: number;
  endMs: number;
  status: string;
  provider: string;
  online: boolean;
}

export type Decision =
  | { ok: true; as: LiveRole }
  | { ok: false; code: 'not_invited' | 'not_live_session' | 'session_closed' | 'too_early' | 'too_late'; message: string };

/** The person's part in this lesson, or null when they have none. Host wins when someone is both. */
export function roleIn(uid: string, roles: string[], s: Pick<SessionFacts, 'teacherUid' | 'studentUids'>): LiveRole | null {
  const leader = (HOST_ROLES as readonly string[]).some((r) => roles.includes(r));
  const ownsLesson = roles.includes('teacher') && s.teacherUid === uid;
  const learner = roles.includes('student') && s.studentUids.includes(uid);
  return leader || ownsLesson ? 'host' : learner ? 'learner' : null;
}

/**
 * May this signed-in person enter this lesson, and as what?
 * `roles` and `session` come from the server (users/{uid} and sessions/{id}), never from the browser.
 * Parents, directors and everyone not listed are refused (decision: no parent access to live rooms).
 * Learners are checked against `studentUids`, NOT `viewers` (viewers also contains parents).
 */
export function decideAccess(p: { uid: string; roles: string[]; session: SessionFacts; nowMs: number }): Decision {
  const { uid, roles, session: s, nowMs } = p;
  const as = roleIn(uid, roles, s);
  if (!as) return { ok: false, code: 'not_invited', message: 'You are not on the list for this live class.' };
  if (s.provider !== LIVE_PROVIDER || !s.online) return { ok: false, code: 'not_live_session', message: 'This class does not use the ELA Live Classroom.' };
  if (s.status !== 'scheduled') return { ok: false, code: 'session_closed', message: s.status === 'cancelled' ? 'This class was cancelled.' : 'This class has ended.' };
  if (nowMs < s.startMs - JOIN_BEFORE_MS) return { ok: false, code: 'too_early', message: 'The class room opens 15 minutes before the start time.' };
  if (nowMs > s.endMs + JOIN_AFTER_MS) return { ok: false, code: 'too_late', message: 'The time to join this class has passed.' };
  return { ok: true, as };
}

/** A host may moderate learners only (a teacher cannot remove an administrator). */
export const canModerate = (actor: LiveRole, target: LiveRole) => actor === 'host' && target === 'learner';

/* ------------------------------------------------------------------ names and identities */

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();

/**
 * What other people in the room see. Learners (children): first name + initial of the last name ("Aisha B.").
 * Hosts: full name. Never an email address or phone number, even if one was typed into the name field.
 */
export function displayName(full: string, as: LiveRole): string {
  let n = clean(full ?? '');
  if (n.includes('@') || /\d{6,}/.test(n)) n = '';          // looks like an email / phone: never show it
  if (!n) return as === 'host' ? 'Teacher' : 'Learner';
  if (as === 'host') return n.slice(0, 60);
  const parts = n.split(' ');
  const first = parts[0]!.slice(0, 20);
  const last = parts.length > 1 ? parts[parts.length - 1]![0]!.toUpperCase() : '';
  return last ? `${first} ${last}.` : first;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Opaque LiveKit identity: HMAC(secret, sessionId:uid). Stable inside one lesson (reconnects), unlinkable across lessons, reveals no uid. */
export async function identityFor(sessionId: string, uid: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${sessionId}:${uid}`))).slice(0, 24);
}

/** Random, opaque room name (128 bits). Contains no class, teacher or learner information. */
export function newRoomName(): string {
  return `ela-${hex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer)}`;
}

export const participationId = (sessionId: string, identity: string) => `${sessionId}_${identity}`;
export const attendanceId = (sessionId: string, studentUid: string) => `${sessionId}_${studentUid}`;
export const validId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(s);
export const validIdentity = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{24}$/.test(s);

/* ------------------------------------------------------------------ LiveKit grants */

export interface Perm { screenShare?: boolean; publish?: boolean; data?: boolean }
export type Source = 'camera' | 'microphone' | 'screen_share' | 'screen_share_audio';

/**
 * Least-privilege LiveKit video grant for one person in one room.
 * Nobody gets `roomAdmin`, `roomCreate` or `roomRecord` on a browser token: every moderation action goes through the
 * gateway, which re-checks who is asking. A learner can publish camera + microphone (unless the teacher turned that off),
 * screen sharing only when the teacher allowed it, and data messages (chat, hands, whiteboard) unless chat was turned off.
 */
export function grantFor(room: string, as: LiveRole, perm: Perm = {}) {
  const sources: Source[] = as === 'host'
    ? ['camera', 'microphone', 'screen_share', 'screen_share_audio']
    : perm.publish === false ? [] : ['camera', 'microphone', ...(perm.screenShare ? (['screen_share', 'screen_share_audio'] as Source[]) : [])];
  return {
    room, roomJoin: true,
    canSubscribe: true,
    canPublish: sources.length > 0,
    canPublishSources: sources,
    canPublishData: as === 'host' ? true : perm.data !== false,
    canUpdateOwnMetadata: false,
    roomAdmin: false, roomCreate: false, roomList: false, roomRecord: false, hidden: false, recorder: false,
  };
}

/** Same permission, in the enum spelling LiveKit's server API (UpdateParticipant) expects. */
export function permissionForApi(as: LiveRole, perm: Perm) {
  const g = grantFor('', as, perm);
  return { canSubscribe: true, canPublish: g.canPublish, canPublishData: g.canPublishData, canPublishSources: g.canPublishSources.map((s) => s.toUpperCase()) };
}

/* ------------------------------------------------------------------ timing + attendance */

export type Timing = 'early' | 'on_time' | 'late';
export function timingFrom(checkInMs: number, startMs: number, graceMin: number): Timing {
  if (checkInMs < startMs) return 'early';
  if (checkInMs <= startMs + graceMin * 60_000) return 'on_time';
  return 'late';
}

export interface Participation {
  firstJoinMs: number | null; lastLeftMs: number | null;
  /** when the current connection began (null when not connected) */
  openSinceMs: number | null;
  /** a "left" event that arrived before its "joined" event (webhooks can be reordered) */
  orphanLeftMs: number | null;
  totalSeconds: number; joinCount: number; reconnects: number;
}
export const emptyParticipation = (): Participation => ({ firstJoinMs: null, lastLeftMs: null, openSinceMs: null, orphanLeftMs: null, totalSeconds: 0, joinCount: 0, reconnects: 0 });

/**
 * Folds one verified LiveKit event into a person's participation.
 * Duplicates are handled upstream (event id). Here the aim is "never over-count":
 *  - a second "joined" while already connected (the "left" was lost) restarts the interval and counts a reconnect;
 *  - a "left" with no open connection is remembered, and pairs with a late-arriving earlier "joined".
 */
export function applyEvent(prev: Participation, e: { type: 'joined' | 'left'; atMs: number }): Participation {
  const s = { ...prev };
  if (e.type === 'joined') {
    // the same join reported twice, once by the webhook and once by a presence check: count it once
    if (s.openSinceMs != null && Math.abs(e.atMs - s.openSinceMs) <= 3000) return prev;
    s.joinCount += 1;
    if (s.firstJoinMs != null) s.reconnects += 1;
    s.firstJoinMs = s.firstJoinMs == null ? e.atMs : Math.min(s.firstJoinMs, e.atMs);
    if (s.openSinceMs == null && s.orphanLeftMs != null && e.atMs <= s.orphanLeftMs) {
      s.totalSeconds += Math.round((s.orphanLeftMs - e.atMs) / 1000);   // reordered pair: credit exactly the interval between them
      s.orphanLeftMs = null;
    } else {
      s.openSinceMs = e.atMs;
    }
    return s;
  }
  s.lastLeftMs = s.lastLeftMs == null ? e.atMs : Math.max(s.lastLeftMs, e.atMs);
  if (s.openSinceMs == null) { s.orphanLeftMs = e.atMs; return s; }
  s.totalSeconds += Math.max(0, Math.round((e.atMs - s.openSinceMs) / 1000));
  s.openSinceMs = null;
  return s;
}

/** Ends any still-open connection at `endMs` (the lesson ended or the room closed). */
export function closeAt(p: Participation, endMs: number): Participation {
  if (p.openSinceMs == null) return p;
  return { ...p, totalSeconds: p.totalSeconds + Math.max(0, Math.round((endMs - p.openSinceMs) / 1000)), openSinceMs: null, lastLeftMs: Math.max(p.lastLeftMs ?? 0, endMs) };
}

/**
 * Brings a person's participation in line with what the LiveKit server says RIGHT NOW (used when webhooks are late or missing).
 * present + not yet counted as connected  -> a join (at LiveKit's own join time when known)
 * not present + counted as connected      -> a leave (at `nowMs`)
 * anything else changes nothing, so calling this again and again is safe.
 */
export function syncPresence(prev: Participation, o: { present: boolean; joinedAtMs?: number | null; nowMs: number }): Participation {
  if (o.present) {
    if (prev.openSinceMs != null) return prev;
    const at = o.joinedAtMs != null && o.joinedAtMs > 0 && o.joinedAtMs <= o.nowMs ? o.joinedAtMs : o.nowMs;
    return applyEvent(prev, { type: 'joined', atMs: at });
  }
  if (prev.openSinceMs == null) return prev;
  return applyEvent(prev, { type: 'left', atMs: o.nowMs });
}

export function finalStatus(totalSeconds: number, startMs: number, endMs: number): 'present' | 'left_early' {
  const scheduled = Math.max(1, (endMs - startMs) / 1000);
  return totalSeconds / scheduled < MIN_PRESENT_FRACTION ? 'left_early' : 'present';
}

export function attendanceNote(totalSeconds: number, joinCount: number): string {
  const min = Math.round(totalSeconds / 60);
  return `Connected ${min} min in ELA Live Classroom (${joinCount} ${joinCount === 1 ? 'join' : 'joins'}). Recorded automatically.`;
}
