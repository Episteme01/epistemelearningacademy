import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Hand, Megaphone, Mic, MicOff, MonitorUp, Send, UserMinus, UserPlus, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/overlay';
import { MAX_CHAT_CHARS, type HandEntry } from '@/lib/live/protocol';
import { cn } from '@/lib/utils';
import { listParticipants, muteAll, muteOne, permitOne, removeOne, unblockOne, type PermState, type ServerParticipant } from './api';
import type { ChatLine, Person, Quality } from './useLiveRoom';

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/* ------------------------------------------------------------------ chat */
export function ChatPanel({ lines, isHost, onSend }: { lines: ChatLine[]; isHost: boolean; onSend: (text: string, announce: boolean) => 'sent' | 'slow' | 'empty' | 'failed' }) {
  const [text, setText] = useState(''); const [announce, setAnnounce] = useState(false); const [msg, setMsg] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lines.length]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = onSend(text, announce);
    if (r === 'sent') { setText(''); setMsg(''); } else if (r === 'slow') setMsg('You are sending messages too quickly. Wait a few seconds.'); else if (r === 'failed') setMsg('The message could not be sent.');
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" aria-live="polite">
        {lines.length === 0 && <p className="text-sm text-muted">Messages are not saved. They disappear when the class ends.</p>}
        {lines.map((l) => (
          <div key={l.id} className={cn('rounded-lg px-3 py-2 text-sm', l.ann ? 'border border-gold-400 bg-gold-50 text-ink' : l.mine ? 'bg-forest-50 text-ink' : 'bg-white text-ink ring-1 ring-line')}>
            <p className="mb-0.5 flex items-center gap-1.5 text-xs text-muted">
              {l.ann && <Megaphone className="h-3.5 w-3.5 text-gold-600" aria-label="Announcement" />}
              <span className="font-medium text-ink">{l.from}</span>{l.role === 'host' && <span className="rounded bg-forest-700 px-1 text-[10px] text-white">Teacher</span>}<span className="ml-auto">{time(l.at)}</span>
            </p>
            <p className="whitespace-pre-wrap break-words">{l.text}</p>
          </div>))}
        <div ref={end} />
      </div>
      <form onSubmit={submit} className="space-y-2 border-t border-line bg-white p-2 text-ink">
        {msg && <p role="alert" className="text-xs text-danger">{msg}</p>}
        {isHost && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} /> Send as announcement</label>}
        <div className="flex gap-2">
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={MAX_CHAT_CHARS} placeholder="Write a message" aria-label="Message" className="h-11 min-w-0 flex-1 rounded-md border border-line px-3 text-base" autoComplete="off" />
          <Button type="submit" className="h-11 w-11 px-0" aria-label="Send message"><Send className="h-5 w-5" /></Button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ people */
const QUALITY_LABEL: Record<Quality, string> = { excellent: 'Strong', good: 'Good', poor: 'Weak', lost: 'Lost', unknown: '' };

export function PeoplePanel({ sessionId, people, hands, isHost, meIdentity, onAck, onClearHands, onEnd }: {
  sessionId: string; people: Person[]; hands: HandEntry[]; isHost: boolean; meIdentity: string; onAck: (who: string) => void; onClearHands: () => void; onEnd: () => void;
}) {
  const toast = useToast();
  const [server, setServer] = useState<Record<string, ServerParticipant>>({});
  const [hooks, setHooks] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const refresh = useCallback(async () => {
    if (!isHost) return;
    try { const r = await listParticipants(sessionId); setServer(Object.fromEntries(r.participants.map((p) => [p.identity, p]))); setHooks(r.webhookEvents ?? null); } catch { /* the live list still works without it */ }
  }, [isHost, sessionId]);
  useEffect(() => { void refresh(); }, [refresh, people.length]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast.success(ok); await refresh(); } catch (e) { toast.error(e instanceof Error ? e.message : 'That did not work.'); } finally { setBusy(''); }
  };
  const perm = (id: string): PermState => server[id]?.perm ?? {};
  const nameOf = (id: string) => people.find((p) => p.identity === id)?.name ?? 'Someone';
  const removed = Object.values(server).filter((p) => p.blocked);
  const learners = people.filter((p) => p.role !== 'host');

  return (
    <div className="h-full overflow-y-auto p-3 text-ink">
      {hands.length > 0 && (
        <section className="mb-4 rounded-lg border border-gold-400 bg-gold-50 p-3" aria-label="Raised hands">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Hand className="h-4 w-4" aria-hidden /> Raised hands ({hands.length})</p>
          <ol className="space-y-1.5">
            {hands.map((h, i) => (
              <li key={h.identity} className="flex items-center gap-2 text-sm"><span className="w-5 text-muted">{i + 1}.</span><span className="min-w-0 flex-1 truncate">{h.identity === meIdentity ? 'You' : nameOf(h.identity)}</span>
                {isHost && <Button size="sm" variant="outline" onClick={() => onAck(h.identity)}>Done</Button>}</li>))}
          </ol>
          {isHost && <Button size="sm" variant="ghost" className="mt-2" onClick={onClearHands}>Clear all hands</Button>}
        </section>)}

      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">In this class ({people.length})</h3>
        {isHost && learners.length > 0 && <Button size="sm" variant="outline" loading={busy === 'all'} onClick={() => void act('all', () => muteAll(sessionId), 'Everyone was muted')}><VolumeX className="h-4 w-4" /> Mute all</Button>}
      </div>
      <ul className="space-y-2">
        {people.map((p) => {
          const target = isHost && p.role !== 'host' && !p.isLocal; const pm = perm(p.identity);
          return (
            <li key={p.identity} className="rounded-lg bg-white p-2.5 ring-1 ring-line">
              <div className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}{p.isLocal ? ' (you)' : ''}</span>
                {p.role === 'host' && <span className="rounded bg-forest-700 px-1.5 text-[10px] font-medium text-white">Teacher</span>}
                {p.handUp && <Hand className="h-4 w-4 text-gold-600" aria-label="Hand raised" />}
                {p.sharing && <MonitorUp className="h-4 w-4 text-forest-600" aria-label="Sharing screen" />}
                {p.mic ? <Mic className="h-4 w-4 text-forest-600" aria-label="Microphone on" /> : <MicOff className="h-4 w-4 text-muted" aria-label="Microphone off" />}
                {p.cam ? <Camera className="h-4 w-4 text-forest-600" aria-label="Camera on" /> : <CameraOff className="h-4 w-4 text-muted" aria-label="Camera off" />}
                {QUALITY_LABEL[p.quality] && <span className={cn('text-[11px]', p.quality === 'poor' || p.quality === 'lost' ? 'text-danger' : 'text-muted')}>{QUALITY_LABEL[p.quality]}</span>}
              </div>
              {target && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" loading={busy === `m${p.identity}`} onClick={() => void act(`m${p.identity}`, () => muteOne(sessionId, p.identity), `${p.name} was muted`)}><VolumeX className="h-4 w-4" /> Mute</Button>
                  <Button size="sm" variant="outline" loading={busy === `s${p.identity}`} onClick={() => void act(`s${p.identity}`, () => permitOne(sessionId, p.identity, { screenShare: !pm.screenShare }), pm.screenShare ? 'Screen sharing turned off' : 'Screen sharing allowed')}><MonitorUp className="h-4 w-4" /> {pm.screenShare ? 'Stop allowing share' : 'Allow share'}</Button>
                  <Button size="sm" variant="outline" loading={busy === `d${p.identity}`} onClick={() => void act(`d${p.identity}`, () => permitOne(sessionId, p.identity, { data: pm.data === false }), pm.data === false ? 'Chat and drawing allowed' : 'Chat and drawing turned off')}>{pm.data === false ? 'Allow chat' : 'Turn off chat'}</Button>
                  <Button size="sm" variant="danger" loading={busy === `r${p.identity}`} onClick={() => { if (window.confirm(`Remove ${p.name} from the class? They will not be able to rejoin until you let them back in.`)) void act(`r${p.identity}`, () => removeOne(sessionId, p.identity), `${p.name} was removed`); }}><UserMinus className="h-4 w-4" /> Remove</Button>
                </div>)}
            </li>);
        })}
      </ul>

      {isHost && hooks === 0 && people.length > 1 && (
        <p role="status" className="mt-4 rounded-md bg-amber-100 p-2 text-xs text-amber-900">LiveKit has not sent any join/leave reports for this class yet. Attendance is still recorded by checking the room directly, but leave times are less exact. Check that the webhook is set up in LiveKit (Settings, Webhooks).</p>
      )}

      {isHost && removed.length > 0 && (
        <section className="mt-4"><h3 className="mb-2 text-sm font-semibold">Removed ({removed.length})</h3>
          <ul className="space-y-2">{removed.map((p) => (
            <li key={p.identity} className="flex items-center gap-2 rounded-lg bg-white p-2.5 text-sm ring-1 ring-line"><span className="min-w-0 flex-1 truncate">{p.name}</span>
              <Button size="sm" variant="outline" loading={busy === `u${p.identity}`} onClick={() => void act(`u${p.identity}`, () => unblockOne(sessionId, p.identity), `${p.name} can join again`)}><UserPlus className="h-4 w-4" /> Let back in</Button></li>))}</ul></section>)}

      {isHost && <div className="mt-6 border-t border-line pt-4"><Button variant="danger" className="w-full" onClick={onEnd}><Volume2 className="h-4 w-4" /> End class for everyone…</Button>
        <p className="mt-2 text-xs text-muted">Leaving does not end the class. Only “End class” closes it and settles attendance.</p></div>}
    </div>
  );
}
