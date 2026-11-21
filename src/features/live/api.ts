import { auth } from '@/config/firebase';
import { filesGatewayUrl } from '@/config/env';

/**
 * Client for the ELA live-class gateway (Supabase Edge Function `live`, see supabase/functions/live and docs/LIVE_CLASSROOM.md).
 * Lives next to the file gateway, so by default its URL is derived from it; VITE_LIVE_GATEWAY_URL overrides that.
 * No secret is ever in the browser: the gateway checks the Firebase login and the lesson, then hands back a short-lived LiveKit token.
 */
const override = ((import.meta.env.VITE_LIVE_GATEWAY_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
export const liveGatewayUrl = override || filesGatewayUrl.replace(/\/files$/, '/live');
export const liveConfigured = liveGatewayUrl !== '' && liveGatewayUrl !== filesGatewayUrl;

export class LiveApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
  /** The person is not allowed in (not invited, removed) or the class is over: retrying will not help. */
  get final() { return this.status === 403 || this.status === 404 || this.status === 409; }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  if (!liveConfigured) throw new LiveApiError(503, 'The live classroom is not switched on yet. Ask the administrator.');
  const u = auth().currentUser;
  if (!u) throw new LiveApiError(401, 'Sign in to continue.');
  let r: Response;
  try {
    r = await fetch(liveGatewayUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await u.getIdToken()}` }, body: JSON.stringify(body) });
  } catch { throw new LiveApiError(0, 'Could not reach the live-class service. Check your connection.'); }
  const data = (await r.json().catch(() => ({}))) as { error?: string } & T;
  if (!r.ok) throw new LiveApiError(r.status, data.error || `Live-class service error (${r.status}).`);
  return data;
}

export type LiveRole = 'host' | 'learner';
export type TokenResult = { status: 'waiting'; message: string } | { status: 'live'; token: string; url: string; identity: string; role: LiveRole; name: string; expiresInSeconds: number };
export interface PermState { screenShare?: boolean; publish?: boolean; data?: boolean }
export interface ServerParticipant { identity: string; name: string; role: string; connected: boolean; firstJoinAt: number | null; lastLeftAt: number | null; totalSeconds: number; joinCount: number; blocked: boolean; perm: PermState }

export const getToken = (sessionId: string) => call<TokenResult>({ action: 'token', sessionId });
export const startClass = (sessionId: string) => call<Extract<TokenResult, { status: 'live' }>>({ action: 'start', sessionId });
export const endClass = (sessionId: string) => call<{ ok: true }>({ action: 'end', sessionId });
export const muteOne = (sessionId: string, identity: string) => call<{ ok: true }>({ action: 'mute', sessionId, identity });
export const muteAll = (sessionId: string) => call<{ ok: true; muted: number }>({ action: 'mute-all', sessionId });
export const removeOne = (sessionId: string, identity: string) => call<{ ok: true }>({ action: 'remove', sessionId, identity });
export const unblockOne = (sessionId: string, identity: string) => call<{ ok: true }>({ action: 'unblock', sessionId, identity });
export const permitOne = (sessionId: string, identity: string, p: PermState) => call<{ ok: true; perm: PermState }>({ action: 'permit', sessionId, identity, ...p });
export const listParticipants = (sessionId: string) => call<{ participants: ServerParticipant[]; webhookEvents?: number }>({ action: 'participants', sessionId });
/** About once a minute while connected: the server checks with LiveKit who is in the room (backup for the webhook) and returns this person's connected seconds. */
export const syncPresence = (sessionId: string) => call<{ live: boolean; totalSeconds?: number; serverNowMs?: number }>({ action: 'sync', sessionId });
/** Removes a deleted class's live-room records on the server (the class must not be live). */
export const purgeClass = (sessionId: string) => call<{ ok: true }>({ action: 'purge', sessionId });
