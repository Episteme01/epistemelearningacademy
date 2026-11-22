import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionQuality, ConnectionState, DisconnectReason, Room, RoomEvent, Track, VideoPresets, type Participant } from 'livekit-client';
import {
  RateLimiter, SnapshotAssembler, TOPIC, boardApply, countVotes, decodeBoard, decodeChat, decodeHand, decodePoll, decodeSlides, decodeSpot, emptyBoard, encode, handApply, handRemove, newId, pollApply, recordVote, roleOfMetadata, slidesApply, snapshotMessages, spotApply,
  type BoardMsg, type BoardState, type HandEntry, type HandMsg, type PollState, type Sender, type SenderRole, type SlidesMsg, type SlidesState,
} from '@/lib/live/protocol';
import { LiveApiError, getToken, guestToken, startClass, syncPresence, type GuestInfo, type TokenResult } from './api';

export type Phase = 'idle' | 'starting' | 'waiting' | 'connecting' | 'live' | 'reconnecting' | 'left' | 'ended' | 'error';
export type Quality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
export interface Person {
  identity: string; name: string; role: SenderRole | null; isLocal: boolean; speaking: boolean; mic: boolean; cam: boolean; sharing: boolean;
  quality: Quality; handUp: boolean; mirror: boolean; participant: Participant;
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
export function useLiveRoom(sessionId: string, isHost: boolean, guest?: GuestInfo | null) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);
  const [waitMessage, setWaitMessage] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [me, setMe] = useState<{ identity: string; role: SenderRole; name: string } | null>(null);
  const [tick, setTick] = useState(0);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [hands, setHands] = useState<HandEntry[]>([]);
  const [board, setBoard] = useState<BoardState>(emptyBoard());
  const [audioOnly, setAudioOnlyState] = useState(false);
  const [slides, setSlides] = useState<SlidesState | null>(null);
  const [spot, setSpot] = useState('');
  const [poll, setPoll] = useState<PollState | null>(null);
  const [myVote, setMyVote] = useState<number | null>(null);

  const roomRef = useRef<Room | null>(null);
  const meRef = useRef<{ identity: string; role: SenderRole } | null>(null);
  const leftRef = useRef(false);
  const joinOpts = useRef<JoinOptions>({ mic: false, cam: false, audioOnly: false });
  const handsRef = useRef<HandEntry[]>([]);
  const boardRef = useRef<BoardState>(emptyBoard());
  const audioOnlyRef = useRef(false);
  const slidesRef = useRef<SlidesState | null>(null);
  const spotRef = useRef('');
  const pollRef = useRef<PollState | null>(null);
  const votesRef = useRef<Record<string, number>>({});
  const tallyTimer = useRef<number | null>(null);
  const facing = useRef<'user' | 'environment'>('user');
  const timers = useRef<number[]>([]);
  const assembler = useRef(new SnapshotAssembler());
  const rx = useRef(new RateLimiter(8, 10_000));
  const tx = useRef(new RateLimiter(5, 10_000));
  const wake = useRef<{ release(): Promise<void> } | null>(null);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  /* Time spent in class: seconds already banked + the stretch since the connection last came up. Seeded by the server so a reload does not reset it. */
  const bank = useRef(0);
  const since = useRef<number | null>(null);
  /* The class clock: runs from the moment the teacher started the class until the class is ended (or you leave). Old rooms without a start time fall back to your own time. */
  const classStart = useRef<number | null>(null);
  const endedRef = useRef<() => void>(() => {});
  const stoppedAt = useRef<number | null>(null);
  const joinedAt = useRef<number | null>(null);
  const markLive = useCallback(() => { stoppedAt.current = null; if (since.current == null) since.current = Date.now(); if (joinedAt.current == null) joinedAt.current = Date.now(); }, []);
  const markDown = useCallback(() => { if (since.current != null) { bank.current += (Date.now() - since.current) / 1000; since.current = null; } }, []);
  const spentSeconds = useCallback(() => Math.floor(bank.current + (since.current != null ? (Date.now() - since.current) / 1000 : 0)), []);
  const classSeconds = useCallback(() => {
    // no start time from the server (a class begun before this update): count from the moment you came in, never from older visits
    const from = classStart.current ?? joinedAt.current; if (from == null) return 0;
    return Math.max(0, Math.floor(((stoppedAt.current ?? Date.now()) - from) / 1000));
  }, [spentSeconds]);
  const stopClock = useCallback(() => { if (stoppedAt.current == null) stoppedAt.current = Date.now(); }, []);

  const putHands = useCallback((h: HandEntry[]) => { handsRef.current = h; setHands(h); }, []);
  const putBoard = useCallback((b: BoardState) => { boardRef.current = b; setBoard(b); }, []);
  const putSlides = useCallback((v: SlidesState | null) => { slidesRef.current = v; setSlides(v); }, []);
  const putSpot = useCallback((v: string) => { spotRef.current = v; setSpot(v); }, []);
  const putPoll = useCallback((v: PollState | null) => { pollRef.current = v; setPoll(v); }, []);
  const clearTimers = () => { for (const t of timers.current) window.clearTimeout(t); timers.current = []; tallyTimer.current = null; };

  /** Sends a data message to everyone (or only `to`). */
  const publish = useCallback((topic: string, msg: unknown, to?: string[]): boolean => {
    const bytes = encode(msg); const room = roomRef.current;
    if (!bytes || !room) return false;
    room.localParticipant.publishData(bytes, { reliable: true, topic, ...(to ? { destinationIdentities: to } : {}) }).catch(() => setNotice('That could not be sent. The teacher may have turned it off for you.'));
    return true;
  }, []);

  /** The teacher counts the votes and tells everyone the totals (batched, so a burst of answers is one message). */
  const sendTally = useCallback(() => {
    tallyTimer.current = null;
    const p = pollRef.current; if (!p || meRef.current?.role !== 'host') return;
    const counts = countVotes(votesRef.current, p.opts.length);
    putPoll({ ...p, counts }); publish(TOPIC.poll, { t: 'tally', id: p.id, counts, open: p.open });
  }, [publish, putPoll]);
  const scheduleTally = useCallback(() => { if (tallyTimer.current == null) tallyTimer.current = window.setTimeout(sendTally, 400); }, [sendTally]);

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
        const sl = slidesRef.current; if (sl) publish(TOPIC.slides, { t: 'show', urls: sl.urls, page: sl.page, write: sl.write } satisfies SlidesMsg, [from.identity]);
        if (spotRef.current) publish(TOPIC.spot, { t: 'spot', who: spotRef.current }, [from.identity]);
        const pl = pollRef.current; if (pl) { publish(TOPIC.poll, { t: 'open', id: pl.id, q: pl.q, opts: pl.opts }, [from.identity]); publish(TOPIC.poll, { t: 'tally', id: pl.id, counts: pl.counts, open: pl.open }, [from.identity]); }
      } else if (m.t === 'snap') {
        if (from.role !== 'host') return;
        const whole = assembler.current.add(m); if (whole) putBoard({ strokes: whole.strokes, open: whole.open });
      } else {
        const next = boardApply(boardRef.current, m, from); if (next !== boardRef.current) putBoard(next);
      }
    } else if (topic === TOPIC.slides) {
      const m = decodeSlides(payload); if (!m) return;
      const next = slidesApply(slidesRef.current, m, from); if (next !== slidesRef.current) putSlides(next);
    } else if (topic === TOPIC.spot) {
      const m = decodeSpot(payload); if (m) putSpot(spotApply(spotRef.current, m, from));
    } else if (topic === TOPIC.poll) {
      const m = decodePoll(payload); if (!m) return;
      if (m.t === 'vote') {
        if (meRef.current?.role !== 'host' || !rx.current.allow(`v:${from.identity}`, now)) return;     // only a teacher counts votes
        const v = recordVote(votesRef.current, pollRef.current, m, from);
        if (v !== votesRef.current) { votesRef.current = v; scheduleTally(); }
        return;
      }
      const next = pollApply(pollRef.current, m, from);
      if (next !== pollRef.current) { if (m.t === 'open') { setMyVote(null); votesRef.current = {}; } putPoll(next); }
    }
  }, [publish, putBoard, putHands, putSlides, putSpot, putPoll, scheduleTally]);

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
      publishDefaults: { audioPreset: { maxBitrate: 48_000 }, dtx: false, red: true },
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
    room.on(RoomEvent.Disconnected, (reason) => {
      markDown();
      if (reason === DisconnectReason.ROOM_DELETED && !leftRef.current) { endedRef.current(); return; }   // the teacher ended the class: stop, do not try to reconnect
      if (!leftRef.current) void recoverRef.current();
    });

    if (typeof r.startedAtMs === 'number' && r.startedAtMs > 0) classStart.current = r.startedAtMs;
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

  const guestKey = guest ? `${guest.code}|${guest.guestId}|${guest.name}` : '';
  const fetchToken = useCallback(() => (guest ? guestToken(guest) : isHost ? startClass(sessionId) : getToken(sessionId)), [isHost, sessionId, guestKey]); // eslint-disable-line react-hooks/exhaustive-deps
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
      if (r.status === 'waiting') { setWaitMessage(r.message); setPhase('waiting'); timers.current.push(window.setTimeout(() => { void enter(first); }, POLL_MS)); return; }
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
        if (r.status === 'waiting') { setWaitMessage(r.message); setPhase('waiting'); timers.current.push(window.setTimeout(() => { void enter(false); }, POLL_MS)); return; }
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
    leftRef.current = true; clearTimers(); markDown(); stopClock();
    roomRef.current?.removeAllListeners(); void roomRef.current?.disconnect(); roomRef.current = null;
    void wake.current?.release().catch(() => {}); wake.current = null;
    setPhase('left');
  }, [markDown, stopClock]);
  /** The teacher ended the class: stop the clock and the reconnect attempts, and say so. Attendance is closed by the server. */
  endedRef.current = () => {
    leftRef.current = true; clearTimers(); markDown(); stopClock();
    roomRef.current?.removeAllListeners(); roomRef.current = null;
    void wake.current?.release().catch(() => {}); wake.current = null;
    setError({ message: guestKey ? 'The meeting has ended. Thank you for joining.' : 'The class has ended. Thank you for joining. Your attendance has been recorded.', retry: false });
    setPhase('ended');
  };
  useEffect(() => () => { leftRef.current = true; clearTimers(); void roomRef.current?.disconnect(); void wake.current?.release().catch(() => {}); }, []);

  /* Backup attendance check + time seed: while connected, ask the server about once a minute (it verifies with LiveKit, not with this browser). */
  useEffect(() => {
    if (phase !== 'live' || guestKey) return;             // guests have no attendance to keep
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
  }, [phase, sessionId, spentSeconds, guestKey]);

  /* ------------------------------------------------ controls */
  const lp = () => roomRef.current?.localParticipant;
  const toggleMic = useCallback(() => { const p = lp(); if (p) void media('microphone', () => p.setMicrophoneEnabled(!p.isMicrophoneEnabled)); }, [media]);
  const toggleCam = useCallback(() => {
    const p = lp(); if (!p) return;
    if (audioOnlyRef.current && !p.isCameraEnabled) { setNotice('You are in audio-only mode. Turn it off to use the camera.'); return; }
    void media('camera', () => p.setCameraEnabled(!p.isCameraEnabled));
  }, [media]);
  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function';
  const toggleShare = useCallback(() => {
    const p = lp(); if (!p) return;
    if (!canShare) { setNotice('This phone’s browser cannot share the screen (Android browsers do not allow it). Use Flip to show a page or the board with the back camera, or use the Whiteboard. Screen sharing works from a computer, a tablet with a supporting browser, or an iPhone with iOS 27 or newer.'); return; }
    void media('screen', () => p.setScreenShareEnabled(!p.isScreenShareEnabled, { audio: true }));
  }, [media, canShare]);
  /** Switches between the front and back camera (show a book, a board or an experiment to the class). */
  const flipCamera = useCallback(() => {
    const t = lp()?.getTrackPublication(Track.Source.Camera)?.videoTrack;
    if (!t) { setNotice('Turn the camera on first.'); return; }
    const next = facing.current === 'user' ? 'environment' : 'user';
    void media('camera', async () => { await t.restartTrack({ facingMode: next }); facing.current = next; });
  }, [media]);
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

  /* ------------------------------------------------ teacher tools */
  const hostSender = (): Sender | null => (meRef.current?.role === 'host' ? { identity: meRef.current.identity, role: 'host' } : null);
  const presentSlides = useCallback((urls: string[]): boolean => {
    const h = hostSender(); if (!h) return false;
    const msg: SlidesMsg = { t: 'show', urls, page: 0 };
    const ok = decodeSlides(encode(msg) ?? new Uint8Array());
    if (!ok || !publish(TOPIC.slides, msg)) { setNotice('Those pictures could not be shown. Try fewer pictures.'); return false; }
    putSlides(slidesApply(null, ok, h)); return true;
  }, [publish, putSlides]);
  const setSlidePage = useCallback((n: number) => {
    const cur = slidesRef.current; if (!cur || !hostSender()) return;
    const page = Math.min(Math.max(0, n), cur.urls.length - 1); if (page === cur.page) return;
    if (cur.write) sendBoard({ t: 'clear' });                                   // writing belongs to the page it was written on
    publish(TOPIC.slides, { t: 'page', page }); putSlides({ ...cur, page });
  }, [publish, putSlides, sendBoard]);
  /** Turn on writing on the page being shown: the board is cleared, opened to learners, and shown over the picture. */
  const setSlideWrite = useCallback((on: boolean) => {
    const cur = slidesRef.current; if (!cur || !hostSender() || cur.write === on) return;
    if (on) { sendBoard({ t: 'clear' }); sendBoard({ t: 'open', open: true }); }
    publish(TOPIC.slides, { t: 'write', on }); putSlides({ ...cur, write: on });
  }, [publish, putSlides, sendBoard]);
  const stopSlides = useCallback(() => { if (!hostSender()) return; publish(TOPIC.slides, { t: 'stop' }); putSlides(null); }, [publish, putSlides]);
  const setSpotlight = useCallback((who: string) => { if (!hostSender()) return; publish(TOPIC.spot, { t: 'spot', who }); putSpot(who); }, [publish, putSpot]);

  const launchPoll = useCallback((q: string, opts: string[]): boolean => {
    const h = hostSender(); if (!h) return false;
    const clean = decodePoll(encode({ t: 'open', id: newId(), q, opts }) ?? new Uint8Array());
    if (!clean || clean.t !== 'open') { setNotice('Write a question and at least two options.'); return false; }
    publish(TOPIC.poll, clean); votesRef.current = {}; setMyVote(null); putPoll(pollApply(null, clean, h)); return true;
  }, [publish, putPoll]);
  const closePoll = useCallback(() => {
    const p = pollRef.current; if (!p || !hostSender()) return;
    const counts = countVotes(votesRef.current, p.opts.length);
    putPoll({ ...p, counts, open: false }); publish(TOPIC.poll, { t: 'tally', id: p.id, counts, open: false });
  }, [publish, putPoll]);
  const dismissPoll = useCallback(() => { const p = pollRef.current; if (!p || !hostSender()) return; publish(TOPIC.poll, { t: 'end', id: p.id }); votesRef.current = {}; putPoll(null); }, [publish, putPoll]);
  const castVote = useCallback((opt: number) => {
    const p = pollRef.current; const room = roomRef.current;
    if (!p || !p.open || !room || meRef.current?.role !== 'learner') return;
    const hosts = [...room.remoteParticipants.values()].filter((x) => roleOfMetadata(x.metadata) === 'host').map((x) => x.identity);
    if (hosts.length === 0) { setNotice('Your teacher is not connected right now.'); return; }
    publish(TOPIC.poll, { t: 'vote', id: p.id, opt }, hosts); setMyVote(opt);
  }, [publish]);

  /* ------------------------------------------------ derived */
  const people = useMemo<Person[]>(() => {
    const room = roomRef.current; if (!room) return [];
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    return all.map((p) => ({
      identity: p.identity, name: p.name || 'Participant', role: roleOfMetadata(p.metadata), isLocal: p.isLocal, speaking: p.isSpeaking, mic: p.isMicrophoneEnabled, cam: p.isCameraEnabled,
      sharing: p.isScreenShareEnabled, quality: qualityOf(p.connectionQuality), handUp: hands.some((h) => h.identity === p.identity), mirror: p.isLocal && facing.current === 'user', participant: p,
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, hands, phase]);
  const localQuality: Quality = people.find((p) => p.isLocal)?.quality ?? 'unknown';
  const needsAudioTap = !!roomRef.current && !roomRef.current.canPlaybackAudio;

  return {
    spentSeconds, classSeconds, phase, error, waitMessage, notice, clearNotice: () => setNotice(null), me, people, chat, hands, board, audioOnly, localQuality, needsAudioTap,
    join, leave, toggleMic, toggleCam, toggleShare, setAudioOnly, startAudio, sendChat, toggleHand, sendBoard,
    ackHand: (who: string) => sendHand({ t: 'ack', who }), clearHands: () => sendHand({ t: 'clear' }),
    canShare, flipCamera, rearCamera: facing.current === 'environment',
    slides, spot, poll, myVote, presentSlides, setSlidePage, setSlideWrite, stopSlides, setSpotlight, launchPoll, closePoll, dismissPoll, castVote,
  };
}
