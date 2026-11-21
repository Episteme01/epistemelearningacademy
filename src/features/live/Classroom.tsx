import { useEffect, useState } from 'react';
import { Hand, LogOut, MessageSquare, Mic, MicOff, MonitorUp, PenLine, Users, Video, VideoOff, Volume2, WifiOff, X } from 'lucide-react';
import { Track } from 'livekit-client';
import { Button } from '@/components/ui/button';
import { Dialog, useToast } from '@/components/ui/overlay';
import { pickTiles } from '@/lib/live/protocol';
import { cn } from '@/lib/utils';
import { endClass } from './api';
import { ChatPanel, PeoplePanel } from './Panels';
import { AudioSinks, VideoTile } from './VideoTile';
import { Whiteboard } from './Whiteboard';
import type { useLiveRoom } from './useLiveRoom';

type Room = ReturnType<typeof useLiveRoom>;
type PanelId = 'chat' | 'people' | null;

function useSmallScreen() {
  const q = '(max-width: 640px)';
  const [small, setSmall] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const f = () => setSmall(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return small;
}

function Tb({ icon, label, onClick, active, danger, badge, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean; danger?: boolean; badge?: number; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={active} aria-label={label}
      className={cn('relative flex h-14 w-[4.25rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium transition disabled:opacity-40',
        danger ? 'bg-danger text-white' : active ? 'bg-gold-400 text-forest-900' : 'bg-white/10 text-white hover:bg-white/20')}>
      <span className="[&_svg]:h-6 [&_svg]:w-6">{icon}</span>{label}
      {!!badge && <span className="absolute right-1.5 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-gold-400 px-1 text-[11px] font-semibold text-forest-900">{badge > 9 ? '9+' : badge}</span>}
    </button>
  );
}

const GRID_COLS: Record<number, string> = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-2 sm:grid-cols-3', 4: 'grid-cols-2' };

/** The live room: video, controls and the side panels. Everything it shows comes from `useLiveRoom`. */
/** hours:minutes:seconds this person has been in the class so far (counts only while connected) */
function ClassTimer({ spent }: { spent: () => number }) {
  const [, setT] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setT((x) => x + 1), 1000); return () => window.clearInterval(t); }, []);
  const n = spent(); const h = Math.floor(n / 3600); const m = Math.floor((n % 3600) / 60); const sec = n % 60;
  const two = (x: number) => String(x).padStart(2, '0');
  return <span className="tabular-nums text-xs text-white/80" role="timer" aria-label="Time in class so far">{h}:{two(m)}:{two(sec)}</span>;
}

export function Classroom({ room, sessionId, title, isHost, onEnded }: { room: Room; sessionId: string; title: string; isHost: boolean; onEnded: () => void }) {
  const toast = useToast();
  const small = useSmallScreen();
  const [panel, setPanel] = useState<PanelId>(null);
  const [showBoard, setShowBoard] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState<'end' | 'leave' | null>(null);
  const [ending, setEnding] = useState(false);
  const [seen, setSeen] = useState(0);
  const { people, me, phase } = room;
  const meId = me?.identity ?? '';
  const unread = panel === 'chat' ? 0 : Math.max(0, room.chat.filter((c) => !c.mine).length - seen);
  useEffect(() => { if (panel === 'chat') setSeen(room.chat.filter((c) => !c.mine).length); }, [panel, room.chat]);

  const local = people.find((p) => p.isLocal);
  const sharer = people.find((p) => p.sharing);
  const stage = sharer || showBoard;
  const tiles = pickTiles(people, stage ? (small ? 3 : 6) : small ? 4 : 9);
  const poor = room.localQuality === 'poor' || room.localQuality === 'lost';
  const myHand = !!local?.handUp;

  const doEnd = async () => {
    setEnding(true);
    try { await endClass(sessionId); room.leave(); onEnded(); } catch (e) { toast.error(e instanceof Error ? e.message : 'The class could not be ended.'); setEnding(false); }
  };

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-forest-900 text-white" style={{ paddingTop: 'env(safe-area-inset-top)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
      <AudioSinks people={people} />

      <header className="flex items-center gap-2 px-3 py-2 text-sm">
        <span className="flex items-center gap-1.5 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"><span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden /> Live</span>
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <ClassTimer spent={room.spentSeconds} />
        <span className="text-xs text-white/70">{people.length} in class</span>
      </header>

      {(phase === 'reconnecting' || room.needsAudioTap || room.notice || poor) && (
        <div className="space-y-1 px-3 pb-2 text-sm">
          {phase === 'reconnecting' && <p role="status" className="flex items-center gap-2 rounded-md bg-amber-500/90 px-3 py-2 text-forest-900"><WifiOff className="h-4 w-4" aria-hidden /> Connection lost. Trying to reconnect…</p>}
          {room.needsAudioTap && <button type="button" onClick={room.startAudio} className="flex w-full items-center gap-2 rounded-md bg-gold-400 px-3 py-2 text-left font-medium text-forest-900"><Volume2 className="h-4 w-4" aria-hidden /> Tap here to hear the class</button>}
          {room.notice && <p role="alert" className="flex items-start gap-2 rounded-md bg-white/15 px-3 py-2"><span className="flex-1">{room.notice}</span><button type="button" onClick={room.clearNotice} aria-label="Dismiss"><X className="h-4 w-4" /></button></p>}
          {poor && !room.audioOnly && <p className="flex flex-wrap items-center gap-2 rounded-md bg-white/15 px-3 py-2">Your connection is weak. <button type="button" className="font-semibold underline" onClick={() => room.setAudioOnly(true)}>Switch to audio only</button></p>}
        </div>)}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2">
          {stage ? (
            <>
              <div className="min-h-0 flex-1">
                {sharer && !showBoard ? <VideoTile person={sharer} source={Track.Source.ScreenShare} fit="contain" className="h-full w-full" />
                  : <Whiteboard board={room.board} isHost={isHost} meIdentity={meId} send={room.sendBoard} />}
              </div>
              <div className="flex shrink-0 gap-2 overflow-x-auto">{tiles.map((p) => <VideoTile key={p.identity} person={p} className="h-24 w-36 shrink-0 sm:h-28 sm:w-44" />)}</div>
            </>
          ) : (
            <div className={cn('grid min-h-0 flex-1 auto-rows-fr gap-2', GRID_COLS[Math.min(tiles.length, 4)] ?? 'grid-cols-2 md:grid-cols-3')}>
              {tiles.map((p) => <VideoTile key={p.identity} person={p} className="min-h-0" />)}
            </div>)}
          {people.length > tiles.length && <p className="shrink-0 text-center text-xs text-white/70">Showing {tiles.length} of {people.length}. Everyone is listed under People.</p>}
        </main>

        {panel && (
          <aside className="fixed inset-0 z-40 flex flex-col bg-forest-50 text-ink md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-white/10" style={{ paddingTop: 'env(safe-area-inset-top)' }} aria-label={panel === 'chat' ? 'Chat' : 'People'}>
            <div className="flex items-center justify-between border-b border-line bg-white px-3 py-2"><p className="font-heading text-[15px] font-semibold text-forest-700">{panel === 'chat' ? 'Chat' : 'People'}</p>
              <Button variant="ghost" size="icon" aria-label="Close panel" onClick={() => setPanel(null)}><X className="h-5 w-5" /></Button></div>
            <div className="min-h-0 flex-1">
              {panel === 'chat'
                ? <ChatPanel lines={room.chat} isHost={isHost} onSend={room.sendChat} />
                : <PeoplePanel sessionId={sessionId} people={people} hands={room.hands} isHost={isHost} meIdentity={meId} onAck={room.ackHand} onClearHands={room.clearHands} onEnd={() => setConfirmEnd('end')} />}
            </div>
          </aside>)}
      </div>

      <footer className="flex flex-wrap items-center justify-center gap-2 px-2 pt-2" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
        <Tb icon={local?.mic ? <Mic /> : <MicOff />} label={local?.mic ? 'Mute' : 'Unmute'} active={!!local?.mic} onClick={room.toggleMic} />
        <Tb icon={local?.cam ? <Video /> : <VideoOff />} label="Camera" active={!!local?.cam} onClick={room.toggleCam} disabled={room.audioOnly} />
        {room.canShare && <Tb icon={<MonitorUp />} label={local?.sharing ? 'Stop' : 'Share'} active={!!local?.sharing} onClick={room.toggleShare} />}
        <Tb icon={<Hand />} label={isHost ? `Hands${room.hands.length ? ` (${room.hands.length})` : ''}` : myHand ? 'Lower' : 'Raise'} active={isHost ? false : myHand} badge={isHost ? room.hands.length : 0} onClick={isHost ? () => setPanel('people') : room.toggleHand} />
        <Tb icon={<MessageSquare />} label="Chat" active={panel === 'chat'} badge={unread} onClick={() => setPanel(panel === 'chat' ? null : 'chat')} />
        <Tb icon={<Users />} label="People" active={panel === 'people'} onClick={() => setPanel(panel === 'people' ? null : 'people')} />
        <Tb icon={<PenLine />} label="Board" active={showBoard} onClick={() => setShowBoard((v) => !v)} />
        <Tb icon={<LogOut />} label="Leave" danger onClick={() => setConfirmEnd('leave')} />
      </footer>

      <Dialog open={confirmEnd === 'leave'} onClose={() => setConfirmEnd(null)} title="Leave the class?" size="sm"
        footer={<><Button variant="outline" onClick={() => setConfirmEnd(null)}>Stay</Button><Button variant="danger" onClick={() => { setConfirmEnd(null); room.leave(); }}>Leave</Button></>}>
        <p className="text-sm">{isHost ? 'The class keeps running for everyone else. To close it for everyone, use “End class” under People.' : 'You can come back in while the class is still on.'}</p>
      </Dialog>
      <Dialog open={confirmEnd === 'end'} onClose={() => setConfirmEnd(null)} title="End the class for everyone?" size="sm"
        footer={<><Button variant="outline" onClick={() => setConfirmEnd(null)}>Keep going</Button><Button variant="danger" loading={ending} onClick={() => void doEnd()}>End class</Button></>}>
        <p className="text-sm">Everyone is disconnected, the lesson is marked completed, and attendance is settled. This cannot be undone.</p>
      </Dialog>
    </div>
  );
}
