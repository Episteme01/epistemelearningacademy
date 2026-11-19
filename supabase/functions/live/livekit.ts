// LiveKit helpers for the `live` Edge Function: access tokens, server API calls, webhook verification.
// A LiveKit access token is an ordinary HS256 JWT, so `jose` (already used by every ELA function) is enough; no extra SDK.
// NOT unit-tested here (needs Deno and a real LiveKit project): see docs/LIVE_CLASSROOM.md "Verification status".
import { SignJWT, jwtVerify } from 'npm:jose@5';

export interface LiveKitConfig { url: string; key: string; secret: string }
const enc = new TextEncoder();

export class LiveKitError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** wss://x.livekit.cloud -> https://x.livekit.cloud (server API base) */
export const httpBase = (url: string) => url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');

type Grant = Record<string, unknown>;

/** Access token a participant's browser uses to connect. `identity` is opaque; `name` is the display name. */
export async function accessToken(cfg: LiveKitConfig, o: { identity: string; name: string; metadata: string; grant: Grant; ttlSeconds: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ name: o.name, metadata: o.metadata, video: o.grant })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(cfg.key).setSubject(o.identity)
    .setNotBefore(now - 10).setIssuedAt(now).setExpirationTime(now + o.ttlSeconds)
    .sign(enc.encode(cfg.secret));
}

/** One-minute token the gateway uses to call LiveKit's server API for a single room. Never leaves the function. */
async function serverToken(cfg: LiveKitConfig, room: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ video: { roomCreate: true, roomAdmin: true, roomList: true, room } })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(cfg.key).setSubject('ela-live-gateway').setIssuedAt(now).setExpirationTime(now + 60)
    .sign(enc.encode(cfg.secret));
}

/** Calls LiveKit RoomService (Twirp over HTTPS, JSON). `okStatuses` lets callers accept e.g. 404 on DeleteRoom. */
export async function roomService(cfg: LiveKitConfig, room: string, method: string, body: Record<string, unknown>, okStatuses: number[] = []): Promise<Record<string, unknown>> {
  let r: Response;
  try {
    r = await fetch(`${httpBase(cfg.url)}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await serverToken(cfg, room)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { throw new LiveKitError(503, 'The live-class service could not be reached. Try again in a moment.'); }
  if (okStatuses.includes(r.status)) return {};
  if (!r.ok) { console.error('livekit', method, r.status); throw new LiveKitError(r.status === 404 ? 404 : 502, 'The live-class service refused the request.'); }
  return (await r.json().catch(() => ({}))) as Record<string, unknown>;
}

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));

/**
 * Verifies a LiveKit webhook: the Authorization header is a JWT signed with the API secret (issuer = API key) whose
 * `sha256` claim is the base64 SHA-256 of the raw request body. Both must match, otherwise the call is not from our LiveKit project.
 */
export async function verifyWebhook(cfg: LiveKitConfig, authHeader: string | null, rawBody: string): Promise<boolean> {
  const token = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, enc.encode(cfg.secret), { issuer: cfg.key, algorithms: ['HS256'] });
    const claimed = String((payload as Record<string, unknown>).sha256 ?? '');
    const actual = b64(await crypto.subtle.digest('SHA-256', enc.encode(rawBody)));
    if (!claimed || claimed.length !== actual.length) return false;
    let diff = 0; for (let i = 0; i < actual.length; i++) diff |= claimed.charCodeAt(i) ^ actual.charCodeAt(i);
    return diff === 0;
  } catch { return false; }
}
