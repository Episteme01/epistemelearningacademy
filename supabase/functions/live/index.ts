// ELA LIVE CLASSROOM — SINGLE-FILE SUPABASE EDGE FUNCTION
// Inlines policy.ts and livekit.ts so this can be deployed as one index.ts.
// Deploy: supabase functions deploy live --no-verify-jwt

// ELA Live Classroom gateway: one small Supabase Edge Function (free plan), same pattern as `files`, `records` and `notify`.
//
// What it does
//   token / start      verify the Firebase login, check the person is allowed in THIS lesson, return a short-lived LiveKit token
//   end / mute / remove / unblock / permit / participants / reconcile      teacher + admin controls (re-checked every time)
//   webhook (?hook=livekit)   LiveKit tells us who joined and left; we keep verified participation + attendance (signature checked)
//
// Deploy with JWT verification OFF (Firebase tokens are not Supabase tokens; we verify them below):
//   supabase functions deploy live --no-verify-jwt
// Secrets (Supabase dashboard > Edge Functions > Secrets), never in GitHub or the app:
//   FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT          (already set for the other functions)
//   LIVEKIT_URL (wss://...), LIVEKIT_API_KEY, LIVEKIT_API_SECRET
//   LIVE_ID_SECRET   a long random text; makes participant identities opaque
//   ALLOWED_ORIGINS  (optional) comma separated
// LiveKit dashboard > Settings > Webhooks: https://<project-ref>.supabase.co/functions/v1/live?hook=livekit
import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify } from 'npm:jose@5';

const env = (k: string) => Deno.env.get(k) ?? '';
const PROJECT = env('FIREBASE_PROJECT_ID');
const LK: LiveKitConfig = { url: env('LIVEKIT_URL'), key: env('LIVEKIT_API_KEY'), secret: env('LIVEKIT_API_SECRET') };
const ID_SECRET = env('LIVE_ID_SECRET');
const ORIGINS = (env('ALLOWED_ORIGINS') || 'https://episteme01.github.io').split(',').map((s) => s.trim()).filter(Boolean);
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const FS_ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

function cors(req: Request): Record<string, string> {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^http:\/\/localhost:\d+$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0]!, 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' };
}
const json = (req: Request, status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// Best-effort per-person throttle (resets when the function restarts).
const hits = new Map<string, { n: number; t: number }>();
function throttle(uid: string) {
  const now = Date.now(); const h = hits.get(uid);
  if (!h || now - h.t > 60_000) { hits.set(uid, { n: 1, t: now }); return; }
  if (++h.n > 90) throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
}

/* ------------------------------------------------------------------ Firebase login */
async function verify(req: Request): Promise<{ uid: string; token: string }> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Please sign in again.');
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://securetoken.google.com/${PROJECT}`, audience: PROJECT });
    if (!payload.sub) throw new Error('no sub');
    return { uid: payload.sub, token };
  } catch { throw new HttpError(401, 'Your session is not valid. Sign in again.'); }
}

/* ------------------------------------------------------------------ Firestore value encoding */
// deno-lint-ignore no-explicit-any
type Fs = any;
function toFs(v: unknown): Fs {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toFs(x)])) } };
}
function fromFs(v: Fs): unknown {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);   // milliseconds
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fromFs);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, fromFs(x)]));
  return null;
}
type Doc = Record<string, unknown> & { _updateTime?: string };
const decode = (d: { fields?: Record<string, Fs>; updateTime?: string }): Doc => ({ ...(Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, x]) => [k, fromFs(x)])) as Record<string, unknown>), _updateTime: d.updateTime });
const fieldsOf = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toFs(v)]));
const docName = (path: string) => `${FS_ROOT}/${path}`;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Reads a document AS THE USER: the existing Firestore security rules decide whether they may see it. */
async function readAs(token: string, path: string): Promise<Doc | null> {
  const r = await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (r.status === 403 || r.status === 401) throw new HttpError(403, 'You are not on the list for this live class.');
  if (!r.ok) throw new HttpError(502, 'Could not check your access. Try again.');
  return decode(await r.json());
}

/* ------------------------------------------------------------------ Firestore as the service account */
let cached: { token: string; exp: number } | null = null;
async function adminToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  let sa: { client_email?: string; private_key?: string };
  try { sa = JSON.parse(env('FIREBASE_SERVICE_ACCOUNT')); } catch { throw new HttpError(500, 'FIREBASE_SERVICE_ACCOUNT is missing or not valid JSON.'); }
  if (!sa.client_email || !sa.private_key) throw new HttpError(500, 'FIREBASE_SERVICE_ACCOUNT is missing client_email or private_key.');
  const key = await importPKCS8(sa.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/cloud-platform' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuer(sa.client_email).setSubject(sa.client_email)
    .setAudience('https://oauth2.googleapis.com/token').setIssuedAt().setExpirationTime('55m').sign(key);
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  if (!r.ok) throw new HttpError(502, 'Could not sign in to Firebase with the service account.');
  const j = (await r.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}
const H = async () => ({ Authorization: `Bearer ${await adminToken()}`, 'Content-Type': 'application/json' });

async function getAdmin(path: string): Promise<Doc | null> {
  const r = await fetch(`${FS}/${path}`, { headers: await H() });
  if (r.status === 404) return null;
  if (!r.ok) throw new HttpError(502, `A database read failed (${path.split('/')[0]}).`);
  return decode(await r.json());
}
async function queryAdmin(collection: string, field: string, value: string, limit = 500): Promise<(Doc & { _id: string })[]> {
  const body = { structuredQuery: { from: [{ collectionId: collection }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: toFs(value) } }, limit } };
  const r = await fetch(`${FS}:runQuery`, { method: 'POST', headers: await H(), body: JSON.stringify(body) });
  if (!r.ok) throw new HttpError(502, `A database query failed (${collection}).`);
  return ((await r.json()) as { document?: { name: string; fields?: Record<string, Fs>; updateTime?: string } }[]).filter((x) => x.document).map((x) => ({ ...decode(x.document!), _id: x.document!.name.split('/').pop()! }));
}

interface W { path: string; data: Record<string, unknown>; mask?: string[]; times?: string[]; pre?: { exists?: boolean; updateTime?: string } }
const writeOf = (w: W) => ({
  update: { name: docName(w.path), fields: fieldsOf(w.data) },
  ...(w.mask ? { updateMask: { fieldPaths: w.mask } } : {}),
  ...(w.times?.length ? { updateTransforms: w.times.map((f) => ({ fieldPath: f, setToServerValue: 'REQUEST_TIME' })) } : {}),
  ...(w.pre ? { currentDocument: w.pre } : {}),
});
/** Atomic commit. Returns the Firestore error status ('ALREADY_EXISTS', 'FAILED_PRECONDITION', ...) instead of throwing, so callers can handle races. */
async function commit(writes: W[]): Promise<{ ok: true } | { ok: false; status: string }> {
  const r = await fetch(`${FS}:commit`, { method: 'POST', headers: await H(), body: JSON.stringify({ writes: writes.map(writeOf) }) });
  if (r.ok) return { ok: true };
  const e = (await r.json().catch(() => ({}))) as { error?: { status?: string } };
  return { ok: false, status: e.error?.status ?? `HTTP_${r.status}` };
}
async function commitOrThrow(writes: W[], what: string) {
  const r = await commit(writes);
  if (!r.ok) { console.error('commit failed', what, r.status); throw new HttpError(502, 'A database write failed. Try again.'); }
}

async function deleteAdmin(path: string): Promise<void> {
  const r = await fetch(`${FS}/${path}`, { method: 'DELETE', headers: await H() });
  if (!r.ok && r.status !== 404) throw new HttpError(502, `A database delete failed (${path.split('/')[0]}).`);
}

/* ------------------------------------------------------------------ people and lessons */
async function profile(uid: string, token: string): Promise<{ roles: string[]; name: string }> {
  const f = await readAs(token, `users/${uid}`);
  if (!f) throw new HttpError(403, 'No portal profile for this account.');
  if (str(f.status) !== 'active') throw new HttpError(403, 'This account is not active.');
  const roles = arr(f.roles); const primary = str(f.role); if (primary && !roles.includes(primary)) roles.push(primary);
  return { roles, name: str(f.displayName) };
}
const factsOf = (id: string, d: Doc): SessionFacts => ({
  id, teacherUid: str(d.teacherUid), studentUids: arr(d.studentUids), startMs: num(d.startAt) ?? 0, endMs: num(d.endAt) ?? 0,
  status: str(d.status), provider: str(d.provider), online: d.online === true,
});
async function lessonAs(token: string, sessionId: string) {
  const d = await readAs(token, `sessions/${sessionId}`);      // the rules say whether this person may even see the lesson
  if (!d) throw new HttpError(404, 'This class was not found.');
  return factsOf(sessionId, d);
}

function cfgOk() {
  if (!PROJECT || !LK.url || !LK.key || !LK.secret || !ID_SECRET) throw new HttpError(503, 'The live classroom is not set up yet. Ask the administrator.');
}
const permOf = (d: Doc | null): Perm => { const p = (d?.perm ?? {}) as Record<string, unknown>; return { screenShare: p.screenShare === true, publish: p.publish === false ? false : undefined, data: p.data === false ? false : undefined }; };

/** Issues the LiveKit token and records (server-side) who this identity belongs to. */
async function issueToken(sessionId: string, s: SessionFacts, uid: string, as: LiveRole, fullName: string, room: Doc) {
  const identity = await identityFor(sessionId, uid, ID_SECRET);
  const pPath = `liveParticipation/${participationId(sessionId, identity)}`;
  const prior = await getAdmin(pPath);
  if (prior?.blocked === true) throw new HttpError(403, 'You were removed from this class. Ask your teacher to let you back in.');
  const name = displayName(fullName, as);
  await commitOrThrow([{ path: pPath, mask: ['sessionId', 'uid', 'identity', 'role', 'teacherUid', 'name', 'issuedAt'], times: ['issuedAt'], data: { sessionId, uid, identity, role: as, teacherUid: s.teacherUid, name } }], 'participation');
  const token = await accessToken(LK, { identity, name, metadata: JSON.stringify({ r: as }), grant: grantFor(str(room.roomName), as, permOf(prior)), ttlSeconds: TOKEN_TTL_SECONDS });
  return { status: 'live' as const, token, url: LK.url, identity, role: as, name, expiresInSeconds: TOKEN_TTL_SECONDS, startedAtMs: num(room.startedAtMs) };
}

/** Everything a host action needs: login, the lesson, and proof the caller may host it. */
async function hostContext(req: Request, b: Record<string, unknown>) {
  const { uid, token } = await verify(req); throttle(uid);
  const sessionId = b.sessionId; if (!validId(sessionId)) throw new HttpError(400, 'Invalid class.');
  const p = await profile(uid, token); const s = await lessonAs(token, sessionId);
  return { uid, token, p, s, sessionId };
}
function mustHost(uid: string, roles: string[], s: SessionFacts, nowMs: number, relaxWindow = false) {
  // Ending, reconciling and the participant list must still work after the join window closes or the lesson is completed.
  if (relaxWindow) { if (roleIn(uid, roles, s) !== 'host') throw new HttpError(403, 'Only the teacher or an administrator can do that.'); return; }
  const d = decideAccess({ uid, roles, session: s, nowMs });
  if (!d.ok) throw new HttpError(d.code === 'not_invited' ? 403 : 409, d.message);
  if (d.as !== 'host') throw new HttpError(403, 'Only the teacher or an administrator can do that.');
}
async function targetOf(sessionId: string, identity: unknown): Promise<{ doc: Doc; path: string }> {
  if (!validIdentity(identity)) throw new HttpError(400, 'Invalid participant.');
  const path = `liveParticipation/${participationId(sessionId, identity)}`;
  const doc = await getAdmin(path);
  if (!doc) throw new HttpError(404, 'That person has not joined this class.');
  if (!canModerate('host', str(doc.role) as LiveRole)) throw new HttpError(403, 'You cannot do that to a teacher or administrator.');
  return { doc, path };
}

/* ------------------------------------------------------------------ attendance + reconcile */
async function graceMinutes(): Promise<number> {
  const g = num((await getAdmin('settings/attendance'))?.onTimeGraceMinutes);
  return g != null && g >= 0 && g <= 60 ? Math.round(g) : DEFAULT_GRACE_MINUTES;
}
const stateOf = (d: Doc | null): Participation => ({
  firstJoinMs: num(d?.firstJoinMs), lastLeftMs: num(d?.lastLeftMs), openSinceMs: num(d?.openSinceMs), orphanLeftMs: num(d?.orphanLeftMs),
  totalSeconds: num(d?.totalSeconds) ?? 0, joinCount: num(d?.joinCount) ?? 0, reconnects: num(d?.reconnects) ?? 0,
});
const stateData = (p: Participation, extra: Record<string, unknown> = {}) => ({
  firstJoinMs: p.firstJoinMs, lastLeftMs: p.lastLeftMs, openSinceMs: p.openSinceMs, orphanLeftMs: p.orphanLeftMs,
  totalSeconds: p.totalSeconds, joinCount: p.joinCount, reconnects: p.reconnects, connected: p.openSinceMs != null,
  firstJoinAt: p.firstJoinMs != null ? new Date(p.firstJoinMs) : null, lastLeftAt: p.lastLeftMs != null ? new Date(p.lastLeftMs) : null, ...extra,
});
const STATE_MASK = ['firstJoinMs', 'lastLeftMs', 'openSinceMs', 'orphanLeftMs', 'totalSeconds', 'joinCount', 'reconnects', 'connected', 'firstJoinAt', 'lastLeftAt'];

/** Creates the learner's attendance record from a VERIFIED join. Never overwrites an existing record (a teacher's decision wins). */
async function createAttendance(sessionId: string, uid: string, firstJoinMs: number, session: Doc) {
  const startMs = num(session.startAt) ?? 0; const grace = await graceMinutes();
  const u = await getAdmin(`users/${uid}`);
  await commit([{
    path: `sessionAttendance/${attendanceId(sessionId, uid)}`, pre: { exists: false }, times: ['createdAt', 'updatedAt'],
    data: {
      sessionId, seriesId: str(session.seriesId), studentUid: uid, studentId: str(u?.studentId), studentName: str(u?.displayName) || 'Learner',
      parentUids: arr(session.parentUids), teacherUid: str(session.teacherUid), courseId: str(session.courseId), classId: str(session.classId),
      monthKey: str(session.monthKey), scheduledStart: new Date(startMs), scheduledEnd: new Date(num(session.endAt) ?? 0),
      checkInAt: new Date(firstJoinMs), status: 'present', timing: timingFrom(firstJoinMs, startMs, grace), method: 'live_webhook',
      verified: true, verifiedByName: 'ELA Live Classroom (automatic)', note: 'Joined the live classroom. Recorded automatically.',
    },
  }]);   // a failed precondition just means a record already exists: that is fine
}

/**
 * Settles attendance once a lesson is over: closes connections still open at `endMs`, then (only for records this system made)
 * marks "left early" when a learner was connected for less than half the lesson. Idempotent: safe to run again and again.
 * Learners who never joined get NO record here (the teacher's existing "Finalise" marks absences). No attendance is ever invented.
 */
async function reconcile(sessionId: string, endMs: number) {
  const session = await getAdmin(`sessions/${sessionId}`); if (!session) return { updated: 0 };
  const start = num(session.startAt) ?? 0; const end = num(session.endAt) ?? 0;
  const cap = Math.min(endMs, end + JOIN_AFTER_MS);
  let updated = 0;
  for (const row of await queryAdmin('liveParticipation', 'sessionId', sessionId)) {
    if (row.role !== 'learner') continue;
    const state = closeAt(stateOf(row), cap);
    await commit([{ path: `liveParticipation/${row._id}`, mask: [...STATE_MASK, 'reconciledAt'], times: ['reconciledAt'], data: stateData(state) }]);
    const uid = str(row.uid); if (!uid || state.firstJoinMs == null) continue;
    const aPath = `sessionAttendance/${attendanceId(sessionId, uid)}`;
    const att = await getAdmin(aPath);
    if (!att) { await createAttendance(sessionId, uid, state.firstJoinMs, session); continue; }
    if (att.method !== 'live_webhook' || att.verifiedByName !== 'ELA Live Classroom (automatic)') continue;     // a person touched it: leave it alone
    const status = finalStatus(state.totalSeconds, start, end);
    await commit([{ path: aPath, mask: ['status', 'note', 'updatedAt'], times: ['updatedAt'], data: { status, note: attendanceNote(state.totalSeconds, state.joinCount) }, pre: { updateTime: att._updateTime } }]);
    updated += 1;
  }
  return { updated };
}

/* ------------------------------------------------------------------ presence check (backup for the webhook) */
/**
 * Asks LiveKit who is in the room right now. `only` = one identity (GetParticipant), otherwise everyone (ListParticipants).
 * Returns identity -> LiveKit's own join time (ms), or null when LiveKit could not be reached (then nothing is changed).
 * This is verified by the LiveKit server, not by the browser, so it respects the rule "no attendance from a button press".
 */
async function livePresence(roomName: string, only?: string): Promise<Map<string, number | null> | null> {
  // deno-lint-ignore no-explicit-any
  const joinedMs = (p: any): number | null => { const ms = Number(p?.joinedAtMs); if (ms > 0) return ms; const sec = Number(p?.joinedAt); return sec > 0 ? sec * 1000 : null; };
  try {
    const out = new Map<string, number | null>();
    if (only) {
      // deno-lint-ignore no-explicit-any
      const p = (await roomService(LK, roomName, 'GetParticipant', { room: roomName, identity: only }, [404])) as any;
      if (p?.identity && p.state !== 'DISCONNECTED') out.set(String(p.identity), joinedMs(p));
      return out;
    }
    // deno-lint-ignore no-explicit-any
    const r = (await roomService(LK, roomName, 'ListParticipants', { room: roomName }, [404])) as { participants?: any[] };
    for (const p of r.participants ?? []) if (p?.identity && p.state !== 'DISCONNECTED') out.set(String(p.identity), joinedMs(p));
    return out;
  } catch (e) { console.error('presence check failed', e instanceof Error ? e.message : e); return null; }
}

/** Applies a presence check to one person. Creates the learner's attendance the first time they are seen in the room. */
async function syncParticipant(sessionId: string, identity: string, present: Map<string, number | null>, nowMs: number, session?: Doc | null): Promise<void> {
  const pPath = `liveParticipation/${participationId(sessionId, identity)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await getAdmin(pPath); if (!cur) return;
    const before = stateOf(cur);
    const after = syncPresence(before, { present: present.has(identity), joinedAtMs: present.get(identity) ?? null, nowMs });
    if (after === before) return;                                             // nothing to change
    const r = await commit([{ path: pPath, mask: [...STATE_MASK, 'lastEventAt'], times: ['lastEventAt'], data: stateData(after), pre: { updateTime: cur._updateTime } }]);
    if (r.ok) {
      if (cur.role === 'learner' && before.firstJoinMs == null && after.firstJoinMs != null) {
        const sess = session ?? await getAdmin(`sessions/${sessionId}`);
        if (sess) await createAttendance(sessionId, str(cur.uid), after.firstJoinMs, sess);
      }
      return;
    }
  }
}

/** Everyone in the lesson: those LiveKit shows as present are marked connected, those it no longer shows are closed. */
async function syncAll(sessionId: string, room: Doc, nowMs: number): Promise<boolean> {
  const present = await livePresence(str(room.roomName)); if (!present) return false;
  const session = await getAdmin(`sessions/${sessionId}`);
  for (const row of await queryAdmin('liveParticipation', 'sessionId', sessionId)) {
    const identity = str(row.identity); if (!validIdentity(identity)) continue;
    if (!present.has(identity) && row.connected !== true) continue;           // not in the room and not counted as connected: nothing to do
    await syncParticipant(sessionId, identity, present, nowMs, session);
  }
  return true;
}

/* ------------------------------------------------------------------ webhook */
// deno-lint-ignore no-explicit-any
async function handleWebhook(e: any) {
  const type = String(e?.event ?? ''); const eventId = String(e?.id ?? '');
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(eventId)) return { ignored: 'no id' };
  const atMs = Number(e.createdAt) > 0 ? Number(e.createdAt) * 1000 : Date.now();
  const roomName = String(e?.room?.name ?? '');
  if (!['participant_joined', 'participant_left', 'room_finished'].includes(type) || !roomName) return { ignored: type };
  const rooms = await queryAdmin('liveRooms', 'roomName', roomName, 1);
  const room = rooms[0]; if (!room) return { ignored: 'unknown room' };
  const sessionId = room._id;

  if (type === 'room_finished') {
    if (room.status === 'live') await commitOrThrow([{ path: `liveRooms/${sessionId}`, mask: ['status', 'endedAt', 'endReason'], times: ['endedAt'], data: { status: 'ended', endReason: 'empty' }, pre: { updateTime: room._updateTime } }], 'room');
    await reconcile(sessionId, atMs);
    await commit([{ path: `liveEvents/${eventId}`, pre: { exists: false }, times: ['at'], data: { type, sessionId } }]);
    return { ok: true };
  }

  const identity = String(e?.participant?.identity ?? '');
  if (!validIdentity(identity)) return { ignored: 'not a classroom participant' };      // e.g. recorder or ingress participants
  const pPath = `liveParticipation/${participationId(sessionId, identity)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await getAdmin(pPath); if (!cur) return { ignored: 'unknown participant' };
    const before = stateOf(cur);
    const after = applyEvent(before, { type: type === 'participant_joined' ? 'joined' : 'left', atMs });
    const r = await commit([
      { path: pPath, mask: [...STATE_MASK, 'lastEventAt'], times: ['lastEventAt'], data: stateData(after), pre: { updateTime: cur._updateTime } },
      { path: `liveEvents/${eventId}`, pre: { exists: false }, times: ['at'], data: { type, sessionId } },
    ]);
    if (r.ok) {
      if (type === 'participant_joined' && cur.role === 'learner' && before.firstJoinMs == null && after.firstJoinMs != null) {
        const session = await getAdmin(`sessions/${sessionId}`);
        if (session) await createAttendance(sessionId, str(cur.uid), after.firstJoinMs, session);
      }
      return { ok: true };
    }
    if (await getAdmin(`liveEvents/${eventId}`)) return { duplicate: true };           // delivered twice: already counted
    // otherwise the participant document changed under us: read it again and retry
  }
  throw new HttpError(503, 'Busy, please retry.');
}

/* ------------------------------------------------------------------ actions */
// deno-lint-ignore no-explicit-any
async function handle(req: Request, b: any): Promise<unknown> {
  const action = String(b.action ?? '');
  cfgOk();
  const now = Date.now();

  if (action === 'token') {
    const { uid, p, s, sessionId } = await hostContext(req, b);
    const d = decideAccess({ uid, roles: p.roles, session: s, nowMs: now });
    if (!d.ok) throw new HttpError(d.code === 'not_invited' ? 403 : 409, d.message);
    const room = await getAdmin(`liveRooms/${sessionId}`);
    if (!room || room.status !== 'live') {
      if (d.as === 'host') throw new HttpError(409, 'Start the class first.');
      return { status: 'waiting', message: 'Waiting for your teacher to start the class.' };      // learners: no token until the teacher starts
    }
    return await issueToken(sessionId, s, uid, d.as, p.name, room);
  }

  if (action === 'purge') {
    // Used when a class is deleted from the timetable: removes the live-room bookkeeping (room, join/leave records, webhook markers) for it.
    const { uid, p, s, sessionId } = await hostContext(req, b);
    mustHost(uid, p.roles, s, now, true);
    const room = await getAdmin(`liveRooms/${sessionId}`);
    if (room && room.status === 'live') throw new HttpError(409, 'The class is live right now. End it first.');
    for (const r of await queryAdmin('liveParticipation', 'sessionId', sessionId)) await deleteAdmin(`liveParticipation/${r._id}`);
    for (const r of await queryAdmin('liveEvents', 'sessionId', sessionId)) await deleteAdmin(`liveEvents/${r._id}`);
    if (room) await deleteAdmin(`liveRooms/${sessionId}`);
    return { ok: true };
  }

  if (action === 'sync') {
    // Called by every connected browser about once a minute. Learners sync only themselves; the host syncs the whole room.
    const { uid } = await verify(req); throttle(uid);
    const sessionId = b.sessionId; if (!validId(sessionId)) throw new HttpError(400, 'Invalid class.');
    const room = await getAdmin(`liveRooms/${sessionId}`);
    if (!room || room.status !== 'live') return { live: false };
    const identity = await identityFor(sessionId, uid, ID_SECRET);
    const pPath = `liveParticipation/${participationId(sessionId, identity)}`;
    const mine = await getAdmin(pPath); if (!mine) throw new HttpError(404, 'Join the class first.');
    if (mine.role === 'host') await syncAll(sessionId, room, now);
    else { const present = await livePresence(str(room.roomName), identity); if (present) await syncParticipant(sessionId, identity, present, now); }
    const after = stateOf(await getAdmin(pPath));
    return { live: true, totalSeconds: closeAt(after, now).totalSeconds, serverNowMs: now };
  }

  if (action === 'start') {
    const { uid, p, s, sessionId } = await hostContext(req, b);
    mustHost(uid, p.roles, s, now);
    let room = await getAdmin(`liveRooms/${sessionId}`);
    if (!room || room.status !== 'live') {
      const roomName = newRoomName();
      await roomService(LK, roomName, 'CreateRoom', { name: roomName, emptyTimeout: EMPTY_TIMEOUT_SECONDS, maxParticipants: Math.min(MAX_ROOM_PARTICIPANTS, s.studentUids.length + 8) });
      const gen = (num(room?.generation) ?? 0) + 1;
      const w: W = { path: `liveRooms/${sessionId}`, times: ['startedAt'], pre: room ? { updateTime: room._updateTime } : { exists: false },
        data: { sessionId, roomName, status: 'live', generation: gen, teacherUid: s.teacherUid, startedBy: uid, endedAt: null, endReason: '', recordingEnabled: false, recordingStatus: 'off', startedAtMs: now } };
      const r = await commit([w]);
      if (!r.ok) { room = await getAdmin(`liveRooms/${sessionId}`); if (!room || room.status !== 'live') throw new HttpError(409, 'The class is being started. Try again.'); }
      else room = await getAdmin(`liveRooms/${sessionId}`);
    }
    return await issueToken(sessionId, s, uid, 'host', p.name, room!);
  }

  if (action === 'end') {
    const { uid, p, s, sessionId } = await hostContext(req, b);
    mustHost(uid, p.roles, s, now, true);
    const room = await getAdmin(`liveRooms/${sessionId}`);
    if (room && room.status === 'live') {
      await syncAll(sessionId, room, now);                       // record who is in the room before it is closed
      await roomService(LK, str(room.roomName), 'DeleteRoom', { room: str(room.roomName) }, [404]);
      await commitOrThrow([
        { path: `liveRooms/${sessionId}`, mask: ['status', 'endedAt', 'endReason', 'endedBy'], times: ['endedAt'], data: { status: 'ended', endReason: 'host', endedBy: uid } },
        { path: `sessions/${sessionId}`, mask: ['status', 'updatedBy', 'updatedAt'], times: ['updatedAt'], data: { status: 'completed', updatedBy: uid } },
      ], 'end');
    }
    return { ok: true, ...(await reconcile(sessionId, now)) };
  }

  if (action === 'reconcile') {
    const { uid, p, s, sessionId } = await hostContext(req, b);
    mustHost(uid, p.roles, s, now, true);
    return { ok: true, ...(await reconcile(sessionId, now)) };
  }

  if (action === 'participants') {
    const { uid, p, s, sessionId } = await hostContext(req, b);
    mustHost(uid, p.roles, s, now, true);
    const liveRoom = await getAdmin(`liveRooms/${sessionId}`);
    if (liveRoom && liveRoom.status === 'live') await syncAll(sessionId, liveRoom, now);
    const webhookEvents = (await queryAdmin('liveEvents', 'sessionId', sessionId, 3)).length;
    const rows = await queryAdmin('liveParticipation', 'sessionId', sessionId);
    return { webhookEvents, participants: rows.map((r) => ({ identity: str(r.identity), name: str(r.name), role: str(r.role), connected: r.connected === true, firstJoinAt: num(r.firstJoinMs), lastLeftAt: num(r.lastLeftMs), totalSeconds: closeAt(stateOf(r), now).totalSeconds, joinCount: num(r.joinCount) ?? 0, blocked: r.blocked === true, perm: permOf(r) })) };
  }

  if (action === 'mute' || action === 'remove' || action === 'unblock' || action === 'permit' || action === 'mute-all') {
    const { uid, p, s, sessionId } = await hostContext(req, b);
    mustHost(uid, p.roles, s, now);
    const room = await getAdmin(`liveRooms/${sessionId}`);
    if (!room || room.status !== 'live') throw new HttpError(409, 'The class is not live.');
    const rn = str(room.roomName);

    if (action === 'mute-all') {
      const rows = (await queryAdmin('liveParticipation', 'sessionId', sessionId)).filter((r) => r.role === 'learner' && r.connected === true);
      for (const r of rows) await muteMic(rn, str(r.identity));
      return { ok: true, muted: rows.length };
    }
    const { doc, path } = await targetOf(sessionId, b.identity);
    const identity = str(doc.identity);
    if (action === 'mute') { await muteMic(rn, identity); return { ok: true }; }
    if (action === 'remove') {
      await roomService(LK, rn, 'RemoveParticipant', { room: rn, identity }, [404]);
      await commitOrThrow([{ path, mask: ['blocked', 'removedBy', 'removedAt'], times: ['removedAt'], data: { blocked: true, removedBy: uid } }], 'remove');
      return { ok: true };
    }
    if (action === 'unblock') { await commitOrThrow([{ path, mask: ['blocked'], data: { blocked: false } }], 'unblock'); return { ok: true }; }
    // permit: merge the teacher's choice into the stored permission (so a reconnect keeps it) and apply it to the live connection
    const cur = (doc.perm ?? {}) as Record<string, unknown>;
    const next: Record<string, boolean> = { screenShare: cur.screenShare === true, publish: cur.publish !== false, data: cur.data !== false };
    for (const k of ['screenShare', 'publish', 'data'] as const) if (typeof b[k] === 'boolean') next[k] = b[k];
    await commitOrThrow([{ path, mask: ['perm'], data: { perm: next } }], 'permit');
    await roomService(LK, rn, 'UpdateParticipant', { room: rn, identity, permission: permissionForApi('learner', { screenShare: next.screenShare, publish: next.publish, data: next.data }) }, [404]);
    return { ok: true, perm: next };
  }

  throw new HttpError(400, 'Unknown action.');
}

/** Server-side mute of a person's microphone tracks (they can unmute themselves again, unless the teacher turned publishing off). */
async function muteMic(room: string, identity: string) {
  const info = (await roomService(LK, room, 'GetParticipant', { room, identity }, [404])) as { tracks?: { sid?: string; source?: string; type?: string }[] };
  for (const t of info.tracks ?? []) if (t.sid && (t.source === 'MICROPHONE' || (t.type === 'AUDIO' && t.source !== 'SCREEN_SHARE_AUDIO'))) await roomService(LK, room, 'MutePublishedTrack', { room, identity, trackSid: t.sid, muted: true }, [404]);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'Use POST.' });
  try {
    if (new URL(req.url).searchParams.get('hook') === 'livekit') {
      // LiveKit -> us. Not a browser call: authenticated by the signed Authorization header, never by CORS.
      cfgOk();
      const raw = await req.text();
      if (!(await verifyWebhook(LK, req.headers.get('authorization'), raw))) return new Response(JSON.stringify({ error: 'Bad signature.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(await handleWebhook(JSON.parse(raw))), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return json(req, 200, await handle(req, await req.json().catch(() => ({}))));
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.message });
    if (e instanceof LiveKitError) return json(req, e.status === 404 ? 404 : 502, { error: e.message });
    console.error(e); return json(req, 500, { error: 'Something went wrong.' });
  }
});

// =========================== INLINED POLICY ===============================
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

// ========================= INLINED LIVEKIT HELPERS ========================
// -----------------------------------------------------------------------------
// Inlined from livekit.ts — LiveKit access tokens, RoomService calls and webhook verification.

export interface LiveKitConfig { url: string; key: string; secret: string }
const enc = new TextEncoder();

export class LiveKitError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

/** wss://x.livekit.cloud -> https://x.livekit.cloud (server API base) */
export const httpBase = (url: string) =>
  url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');

type Grant = Record<string, unknown>;

/** Access token a participant's browser uses to connect. */
export async function accessToken(
  cfg: LiveKitConfig,
  o: { identity: string; name: string; metadata: string; grant: Grant; ttlSeconds: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ name: o.name, metadata: o.metadata, video: o.grant })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(cfg.key).setSubject(o.identity)
    .setNotBefore(now - 10).setIssuedAt(now).setExpirationTime(now + o.ttlSeconds)
    .sign(enc.encode(cfg.secret));
}

/** One-minute token used only by this function to call LiveKit's server API. */
async function serverToken(cfg: LiveKitConfig, room: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ video: { roomCreate: true, roomAdmin: true, roomList: true, room } })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(cfg.key).setSubject('ela-live-gateway').setIssuedAt(now).setExpirationTime(now + 60)
    .sign(enc.encode(cfg.secret));
}

export async function roomService(
  cfg: LiveKitConfig,
  room: string,
  method: string,
  body: Record<string, unknown>,
  okStatuses: number[] = [],
): Promise<Record<string, unknown>> {
  let r: Response;
  try {
    r = await fetch(`${httpBase(cfg.url)}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await serverToken(cfg, room)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new LiveKitError(503, 'The live-class service could not be reached. Try again in a moment.');
  }
  if (okStatuses.includes(r.status)) return {};
  if (!r.ok) {
    console.error('livekit', method, r.status);
    throw new LiveKitError(r.status === 404 ? 404 : 502, 'The live-class service refused the request.');
  }
  return (await r.json().catch(() => ({}))) as Record<string, unknown>;
}

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));

/** Verifies the LiveKit webhook JWT and its SHA-256 body claim. */
export async function verifyWebhook(
  cfg: LiveKitConfig,
  authHeader: string | null,
  rawBody: string,
): Promise<boolean> {
  const token = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, enc.encode(cfg.secret), {
      issuer: cfg.key,
      algorithms: ['HS256'],
    });
    const claimed = String((payload as Record<string, unknown>).sha256 ?? '');
    const actual = b64(await crypto.subtle.digest('SHA-256', enc.encode(rawBody)));
    if (!claimed || claimed.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= claimed.charCodeAt(i) ^ actual.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
