import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionQuality, ConnectionState, Room, RoomEvent, Track, VideoPresets, type Participant } from 'livekit-client';
import {
  RateLimiter, SnapshotAssembler, TOPIC, boardApply, decodeBoard, decodeChat, decodeHand, emptyBoard, encode, handApply, handRemove, newId, roleOfMetadata, snapshotMessages,
  type BoardMsg, type BoardState, type HandEntry, type HandMsg, type Sender, type SenderRole,
} from '@/lib/live/protocol';
import { LiveApiError, getToken, startClass, syncPresence, type TokenResult } from './api';

export type Phase = 'idle' | 'starting' | 'waiting' | 'connecting' | 'live' | 'reconnecting' | 'left' | 'ended' | 'error';
export type Quality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
export interface Person {
  identity: string; name: string; role: SenderRole | null; isLocal: boolean; speaking: boolean; mic: boolean; cam: boolean; sharing: boolean;
  quality: Quality; handUp: boolean; participant: Participant;
}
export interface ChatLine { id: string; from: string; role: SenderRole | null; text: string; ann: boolean; at: number; mine: boolean }
export interface JoinOptions { mic: boolean; cam: boolean; audioOnly: boolean }

const qualityOf = (q: ConnectionQuality): Quality => (q === ConnectionQuality.Excellent ? 'excellent' : q === ConnectionQuality.Good ? 'good' : q === ConnectionQuality.Poor ? 'poor' : q === ConnectionQuality.Lost ? 'lost' : 'unknown');
const RETRY_DELAYS_MS = [2000, 4000, 8000, 12000, 16000];
const POLL_MS = 5000;
const SYNC_MS = 60_000;

/** A message a person can act on, whatever the browser threw. */
export function deviceMessage(e: unknown, what: 'camera' | 'microphone' | 'screen'): string {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return what === 'screen' ? 'Screen sharing was not allowed. Sharing may not be switched on for you, or this browser does not support it.' : `The ${what} is blocked. Allow it for this site in your browser settings, then try again.`;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${what} was found on this device.`;
  if (name === 'NotReadableError' || name === 'AbortError') return `The ${what} could not be started. Another app may be using it.`;
  return what === 'screen' ? 'Screen sharing is not available on this device.' : `The ${what} could not be turned on.`;
}

/**
 * Owns the LiveKit room for one lesson: joining (with a wait for the teacher), reconnecting, media controls, and the data channel
 * (chat, hands, whiteboard). All rules about who may do what live in src/lib/live/protocol.ts (unit-tested); the server decides who gets a token.
 */
export function useLiveRoom(sessionId: string, isHost: boolean) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [me, setMe] = useState<{ identity: string; role: SenderRole; name: string } | null>(null);
  const [tick, setTick] = useState(0);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [hands, setHands] = useState<HandEntry[]>([]);
  const [board, setBoard] = useState<BoardState>(emptyBoard());
  const [audioOnly, setAudioOnlyState] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const meRef = useRef<{ identity: string; role: SenderRole } | null>(null);
  const leftRef = useRef(false);
  const joinOpts = useRef<JoinOptions>({ mic: false, cam: false, audioOnly: false });
  const handsRef = useRef<HandEntry[]>([]);
  const boardRef = useRef<BoardState>(emptyBoard());
  const audioOnlyRef = useRef(false);
  const timers = useRef<number[]>([]);
  const assembler = useRef(new SnapshotAssembler());
  const rx = useRef(new RateLimiter(8, 10_000));
  const tx = useRef(new RateLimiter(5, 10_000));
  const wake = useRef<{ release(): Promise<void> } | null>(null);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  /* Time spent in class: seconds already banked + the stretch since the connection last came up. Seeded by the server so a reload does not reset it. */
  const bank = useRef(0);
  const since = useRef<number | null>(null);
  const markLive = useCallback(() => { if (since.current == null) since.current = Date.now(); }, []);
  const markDown = useCallback(() => { if (since.current != null) { bank.current += (Date.now() - since.current) / 1000; since.current = null; } }, []);
  const spentSeconds = useCallback(() => Math.floor(bank.current + (since.current != null ? (Date.now() - since.current) / 1000 : 0)), []);

  const putHands = useCallback((h: HandEntry[]) => { handsRef.current = h; setHands(h); }, []);
  const putBoard = useCallback((b: BoardState) => { boardRef.current = b; setBoard(b); }, []);
  const clearTimers = () => { for (const t of timers.current) window.clearTimeout(t); timers.current = []; };

  /** Sends a data message to everyone (or only `to`). */
  const publish = useCallback((topic: string, msg: unknown, to?: string[]): boolean => {
    const bytes = encode(msg); const room = roomRef.current;
    if (!bytes || !room) return false;
    room.localParticipant.publishData(bytes, { reliable: true, topic, ...(to ? { destinationIdentities: to } : {}) }).catch(() => setNotice('That could not be sent. The teacher may have turned it off for you.'));
    return true;
  }, []);

  const onData = useCallback((payload: Uint8Array, p: Participant | undefined, topic: string | undefined) => {
    if (!p || p.isLocal) return;
    const from: Sender = { identity: p.identity, role: roleOfMetadata(p.metadata) };
    const now = Date.now();
    if (topic === TOPIC.chat) {
      if (!rx.current.allow(`c:${from.identity}`, now)) return;
      const m = decodeChat(payload, from); if (!m) return;
      setChat((c) => (c.some((x) => x.id === m.id) ? c : [...c, { id: m.id, from: p.name || 'Someone', role: from.role, text: m.text, ann: m.ann === true, at: now, mine: false }].slice(-200)));
    } else if (topic === TOPIC.hand) {
      const m = decodeHand(payload); if (m) putHands(handApply(handsRef.current, m, from, now));
    } else if (topic === TOPIC.board) {
      const m = decodeBoard(payload); if (!m) return;
      if (m.t === 'req') {
        if (meRef.current?.role !== 'host') return;                            // a teacher answers: board snapshot + raised hands
        for (const s of snapshotMessages(boardRef.current, newId())) publish(TOPIC.board, s, [from.identity]);
        if (handsRef.current.length) publish(TOPIC.hand, { t: 'state', up: handsRef.current } satisfies HandMsg, [from.identity]);
      } else if (m.t === 'snap') {
        if (from.role !== 'host') return;
        const whole = assembler.current.add(m); if (whole) putBoard({ strokes: whole.strokes, open: whole.open });
      } else {
        const next = boardApply(boardRef.current, m, from); if (next !== boardRef.current) putBoard(next);
      }
    }
  }, [publish, putBoard, putHands]);

  const applyAudioOnly = useCallback((room: Room, on: boolean) => {
    for (const rp of room.remoteParticipants.values()) for (const pub of rp.trackPublications.values()) if (pub.kind === Track.Kind.Video && pub.source === Track.Source.Camera) pub.setSubscribed(!on);
  }, []);

  const media = useCallback(async (what: 'camera' | 'microphone' | 'screen', fn: () => Promise<unknown>) => {
    try { await fn(); setNotice(null); } catch (e) { setNotice(deviceMessage(e, what)); }
    bump();
  }, [bump]);

  const connectWith = useCallback(async (r: Extract<TokenResult, { status: 'live' }>, first: boolean) => {
    roomRef.current?.removeAllListeners(); void roomRef.current?.disconnect();
    const room = new Room({
      adaptiveStream: true, dynacast: true,
      videoCaptureDefaults: { resolution: VideoPresets.h360.resolution },
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    roomRef.current = room; meRef.current = { identity: r.identity, role: r.role }; setMe({ identity: r.identity, role: r.role, name: r.name });
    room.on(RoomEvent.ParticipantConnected, bump);
    room.on(RoomEvent.ParticipantDisconnected, (p) => { putHands(handRemove(handsRef.current, p.identity)); bump(); });
    room.on(RoomEvent.TrackPublished, (pub) => { if (audioOnlyRef.current && pub.kind === Track.Kind.Video && pub.source === Track.Source.Camera) pub.setSubscribed(false); bump(); });
    room.on(RoomEvent.TrackSubscribed, bump);
    room.on(RoomEvent.TrackUnsubscribed, bump);
    room.on(RoomEvent.TrackMuted, bump);
    room.on(RoomEvent.TrackUnmuted, bump);
    room.on(RoomEvent.LocalTrackPublished, bump);
    room.on(RoomEvent.LocalTrackUnpublished, bump);
    room.on(RoomEvent.ActiveSpeakersChanged, bump);
    room.on(RoomEvent.ConnectionQualityChanged, bump);
    room.on(RoomEvent.ParticipantPermissionsChanged, bump);
    room.on(RoomEvent.ParticipantMetadataChanged, bump);
    room.on(RoomEvent.AudioPlaybackStatusChanged, bump);
    room.on(RoomEvent.DataReceived, (payload, p, _kind, topic) => onData(payload, p, topic));
    room.on(RoomEvent.MediaDevicesError, (e) => setNotice(deviceMessage(e, 'camera')));
    room.on(RoomEvent.ConnectionStateChanged, (s) => { if (s === ConnectionState.Reconnecting) { markDown(); setPhase('reconnecting'); } else if (s === ConnectionState.Connected) { markLive(); setPhase('live'); } bump(); });
    room.on(RoomEvent.Disconnected, () => { markDown(); if (!leftRef.current) void recoverRef.current(); });

    setPhase('connecting');
    await room.connect(r.url, r.token);
    markLive(); setPhase('live'); setError(null);
    try { wake.current = await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null; } catch { /* optional */ }
    if (first) {
      const o = joinOpts.current;
      if (o.audioOnly) { audioOnlyRef.current = true; setAudioOnlyState(true); }
      if (o.mic) await media('microphone', () => room.localParticipant.setMicrophoneEnabled(true));
      if (o.cam && !o.audioOnly) await media('camera', () => room.localParticipant.setCameraEnabled(true));
    } else if (audioOnlyRef.current) applyAudioOnly(room, true);
    publish(TOPIC.board, { t: 'req' });                                          // late joiners / reconnects ask the teacher for the current board
    bump();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bump, media, onData, publish, putHands, applyAudioOnly, markDown, markLive]);

  const fetchToken = useCallback(() => (isHost ? startClass(sessionId) : getToken(sessionId)), [isHost, sessionId]);
  const failWith = useCallback((e: unknown) => {
    const err = e instanceof LiveApiError ? e : null;
    setError({ message: err?.message ?? (e instanceof Error ? e.message : 'Could not join the class.'), retry: !err?.final });
    setPhase(err?.final ? 'ended' : 'error');
  }, []);

  /** Asks the server for a token: learners wait (and keep asking) until the teacher has started the class. */
  const enter = useCallback(async (first: boolean) => {
    try {
      const r = await fetchToken();
      if (leftRef.current) return;
      if (r.status === 'waiting') { setPhase('waiting'); timers.current.push(window.setTimeout(() => { void enter(first); }, POLL_MS)); return; }
      await connectWith(r, first);
    } catch (e) { if (!leftRef.current) failWith(e); }
  }, [connectWith, failWith, fetchToken]);

  const recoverRef = useRef<() => Promise<void>>(async () => {});
  recoverRef.current = async () => {
    setPhase('reconnecting');
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      await new Promise<void>((res) => { timers.current.push(window.setTimeout(res, RETRY_DELAYS_MS[i])); });
      if (leftRef.current) return;
      try {
        const r = await fetchToken(); if (leftRef.current) return;
        if (r.status === 'waiting') { setPhase('waiting'); timers.current.push(window.setTimeout(() => { void enter(false); }, POLL_MS)); return; }
        await connectWith(r, false); return;
      } catch (e) { if (e instanceof LiveApiError && e.final) { failWith(e); return; } }
    }
    setError({ message: 'The connection was lost and could not be restored.', retry: true }); setPhase('error');
  };

  const join = useCallback((o: JoinOptions) => {
    leftRef.current = false; clearTimers(); joinOpts.current = o; setError(null); setPhase(isHost ? 'starting' : 'connecting');
    void enter(true);
  }, [enter, isHost]);

  const leave = useCallback(() => {
    leftRef.current = true; clearTimers(); markDown();
    roomRef.current?.removeAllListeners(); void roomRef.current?.disconnect(); roomRef.current = null;
    void wake.current?.release().catch(() => {}); wake.current = null;
    setPhase('left');
  }, [markDown]);
  useEffect(() => () => { leftRef.current = true; clearTimers(); void roomRef.current?.disconnect(); void wake.current?.release().catch(() => {}); }, []);

  /* Backup attendance check + time seed: while connected, ask the server about once a minute (it verifies with LiveKit, not with this browser). */
  useEffect(() => {
    if (phase !== 'live') return;
    let stop = false;
    const beat = () => {
      void syncPresence(sessionId).then((r) => {
        if (stop || !r.live || r.totalSeconds == null) return;
        const local = spentSeconds();
        if (r.totalSeconds > local) { bank.current = r.totalSeconds; since.current = Date.now(); }   // the server knows more (e.g. after a reload)
      }).catch(() => { /* the class carries on; the next beat tries again */ });
    };
    beat();
    const t = window.setInterval(beat, SYNC_MS);
    return () => { stop = true; window.clearInterval(t); };
  }, [phase, sessionId, spentSeconds]);

  /* ------------------------------------------------ controls */
  const lp = () => roomRef.current?.localParticipant;
  const toggleMic = useCallback(() => { const p = lp(); if (p) void media('microphone', () => p.setMicrophoneEnabled(!p.isMicrophoneEnabled)); }, [media]);
  const toggleCam = useCallback(() => {
    const p = lp(); if (!p) return;
    if (audioOnlyRef.current && !p.isCameraEnabled) { setNotice('You are in audio-only mode. Turn it off to use the camera.'); return; }
    void media('camera', () => p.setCameraEnabled(!p.isCameraEnabled));
  }, [media]);
  const toggleShare = useCallback(() => { const p = lp(); if (p) void media('screen', () => p.setScreenShareEnabled(!p.isScreenShareEnabled, { audio: true })); }, [media]);
  const setAudioOnly = useCallback((on: boolean) => {
    audioOnlyRef.current = on; setAudioOnlyState(on);
    const room = roomRef.current; if (!room) return;
    applyAudioOnly(room, on);
    if (on && room.localParticipant.isCameraEnabled) void media('camera', () => room.localParticipant.setCameraEnabled(false));
  }, [applyAudioOnly, media]);
  const startAudio = useCallback(() => { void roomRef.current?.startAudio().then(bump).catch(() => {}); }, [bump]);

  const meSender = (): Sender | null => (meRef.current ? { identity: meRef.current.identity, role: meRef.current.role } : null);

  const sendChat = useCallback((text: string, announce = false): 'sent' | 'slow' | 'empty' | 'failed' => {
    const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 300); const m = meRef.current;
    if (!clean || !m) return 'empty';
    if (!tx.current.allow('me', Date.now())) return 'slow';
    const id = newId(); const ann = announce && m.role === 'host';
    if (!publish(TOPIC.chat, { t: 'msg', id, text: clean, ...(ann ? { ann: true } : {}) })) return 'failed';
    setChat((c) => [...c, { id, from: 'You', role: m.role, text: clean, ann, at: Date.now(), mine: true }].slice(-200));
    return 'sent';
  }, [publish]);

  const sendHand = useCallback((msg: HandMsg) => {
    const s = meSender(); if (!s) return;
    if (publish(TOPIC.hand, msg)) putHands(handApply(handsRef.current, msg, s, Date.now()));
  }, [publish, putHands]);
  const toggleHand = useCallback(() => { const id = meRef.current?.identity; if (id) sendHand({ t: 'hand', up: !handsRef.current.some((h) => h.identity === id) }); }, [sendHand]);

  /** Applies a whiteboard message locally and sends it to everyone else. */
  const sendBoard = useCallback((msg: BoardMsg) => {
    const s = meSender(); if (!s) return;
    const next = boardApply(boardRef.current, msg, s);
    if (next === boardRef.current) return;                                       // not allowed (e.g. board closed to learners): do not send either
    putBoard(next); publish(TOPIC.board, msg);
  }, [publish, putBoard]);

  /* ------------------------------------------------ derived */
  const people = useMemo<Person[]>(() => {
    const room = roomRef.current; if (!room) return [];
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    return all.map((p) => ({
      identity: p.identity, name: p.name || 'Participant', role: roleOfMetadata(p.metadata), isLocal: p.isLocal, speaking: p.isSpeaking, mic: p.isMicrophoneEnabled, cam: p.isCameraEnabled,
      sharing: p.isScreenShareEnabled, quality: qualityOf(p.connectionQuality), handUp: hands.some((h) => h.identity === p.identity), participant: p,
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, hands, phase]);
  const localQuality: Quality = people.find((p) => p.isLocal)?.quality ?? 'unknown';
  const needsAudioTap = !!roomRef.current && !roomRef.current.canPlaybackAudio;

  return {
    spentSeconds, phase, error, notice, clearNotice: () => setNotice(null), me, people, chat, hands, board, audioOnly, localQuality, needsAudioTap,
    join, leave, toggleMic, toggleCam, toggleShare, setAudioOnly, startAudio, sendChat, toggleHand, sendBoard,
    ackHand: (who: string) => sendHand({ t: 'ack', who }), clearHands: () => sendHand({ t: 'clear' }),
    canShare: typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function',
  };
}
