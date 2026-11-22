import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Copy, Loader2, Mic, Share2, Video, Wifi } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, PageHeader } from '@/components/ui/card';
import { EmptyState, Spinner } from '@/components/ui/data';
import { Field, Input, Select } from '@/components/ui/form';
import { useToast } from '@/components/ui/overlay';
import { BRAND } from '@/config/brand';
import { fmtDate } from '@/lib/utils';
import { MEETING_PREFIX, liveConfigured, meetingClose, meetingCreate, meetingExtend, meetingList, type GuestInfo, type Meeting } from './api';
import { Classroom } from './Classroom';
import { useLiveRoom } from './useLiveRoom';

const linkFor = (code: string) => `${window.location.origin}${import.meta.env.BASE_URL}meet/${code}`;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-forest-50 px-4 py-8">
      <div className="w-full max-w-md rounded-xl border border-line bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-3"><img src={BRAND.logo} alt="" className="h-10 w-10 object-contain" /><div><p className="font-heading text-[15px] font-semibold text-forest-700">ELA Meeting</p><p className="text-xs text-muted">{BRAND.name}</p></div></div>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ teacher: make and manage meeting links */
export function MeetingsPage() {
  const toast = useToast();
  const [list, setList] = useState<Meeting[] | null>(null);
  const [title, setTitle] = useState(''); const [hours, setHours] = useState('24'); const [busy, setBusy] = useState(false);
  const load = useCallback(() => meetingList().then((r) => setList(r.meetings)).catch((e) => { setList([]); toast.error(e instanceof Error ? e.message : 'Could not load meetings.'); }), [toast]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true);
    try { const m = await meetingCreate(title.trim() || 'Meeting', Number(hours)); setTitle(''); toast.success('Meeting created. Copy the link and send it.'); setList((cur) => [m, ...(cur ?? [])]); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not create the meeting.'); } finally { setBusy(false); }
  };
  const copy = async (m: Meeting) => { try { await navigator.clipboard.writeText(linkFor(m.code)); toast.success('Link copied.'); } catch { window.prompt('Copy this link', linkFor(m.code)); } };
  const share = async (m: Meeting) => {
    const data = { title: m.title, text: `Join "${m.title}" on ${BRAND.name}. You do not need an account.`, url: linkFor(m.code) };
    if (typeof navigator.share === 'function') { try { await navigator.share(data); return; } catch { /* cancelled: fall back to copy */ } }
    await copy(m);
  };
  const extend = async (m: Meeting) => { try { await meetingExtend(m.code, 24); toast.success('Extended by 24 hours.'); await load(); } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not extend.'); } };
  const close = async (m: Meeting) => {
    if (!window.confirm(`Close "${m.title}"? The link stops working and anyone inside is removed.`)) return;
    try { await meetingClose(m.code); toast.success('Meeting closed.'); await load(); } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not close.'); }
  };

  if (!liveConfigured) return <><PageHeader title="Meetings" /><Card><CardBody><p className="text-sm">The live classroom is not switched on yet. Please ask the administrator.</p></CardBody></Card></>;
  return (
    <>
      <PageHeader title="Meetings" description="Make a link anyone can open, with no account. You approve each person before they come in." />
      <Card><CardBody className="flex flex-wrap items-end gap-3">
        <Field label="Meeting name" className="min-w-52 flex-1">{(a) => <Input {...a} value={title} maxLength={80} placeholder="e.g. Parents meeting" onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="Link stays valid for">{(a) => <Select {...a} value={hours} onChange={(e) => setHours(e.target.value)}><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option></Select>}</Field>
        <Button loading={busy} onClick={() => void create()}>Create link</Button>
      </CardBody></Card>
      <div className="mt-4 space-y-3">
        {list === null ? <Spinner /> : list.length === 0 ? <Card><EmptyState title="No meetings yet" description="Create a link above, then send it to your guests." /></Card> : list.map((m) => {
          const expired = (m.expiresAtMs ?? 0) < Date.now();
          return (
            <Card key={m.code}><CardBody>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0"><p className="font-medium">{m.title}</p><p className="text-xs text-muted">{expired ? 'Expired' : `Valid until ${fmtDate(m.expiresAtMs ? new Date(m.expiresAtMs) : null, true)}`}</p></div>
                <div className="flex flex-wrap gap-2">
                  {!expired && <Link to={`/app/meeting/${m.code}`}><Button size="sm"><Video className="h-4 w-4" /> Start</Button></Link>}
                  <Button size="sm" variant="outline" onClick={() => void share(m)}><Share2 className="h-4 w-4" /> Share</Button>
                  <Button size="sm" variant="outline" onClick={() => void copy(m)}><Copy className="h-4 w-4" /> Copy link</Button>
                  <Button size="sm" variant="outline" onClick={() => void extend(m)}>+24 h</Button>
                  <Button size="sm" variant="outline" onClick={() => void close(m)}>Close</Button>
                </div>
              </div>
              <p className="mt-2 break-all rounded bg-cream p-2 text-xs">{linkFor(m.code)}</p>
            </CardBody></Card>);
        })}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ the room, for the host and for guests */
function JoinOptions({ mic, cam, audioOnly, set }: { mic: boolean; cam: boolean; audioOnly: boolean; set: (k: 'mic' | 'cam' | 'audioOnly', v: boolean) => void }) {
  return (
    <fieldset className="mt-4 space-y-2 text-sm">
      <legend className="mb-1 text-xs font-medium text-muted">Join with</legend>
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={mic} onChange={(e) => set('mic', e.target.checked)} /><Mic className="h-4 w-4" aria-hidden /> Microphone on</label>
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={cam && !audioOnly} disabled={audioOnly} onChange={(e) => set('cam', e.target.checked)} /><Video className="h-4 w-4" aria-hidden /> Camera on</label>
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={audioOnly} onChange={(e) => set('audioOnly', e.target.checked)} /><Wifi className="h-4 w-4" aria-hidden /> Audio only (uses much less data)</label>
    </fieldset>
  );
}

function MeetingRoom({ code, isHost, guest, title, back }: { code: string; isHost: boolean; guest: GuestInfo | null; title: string; back: React.ReactNode }) {
  const sessionId = `${MEETING_PREFIX}${code}`;
  const room = useLiveRoom(sessionId, isHost, guest);
  const [o, setO] = useState({ mic: isHost, cam: isHost, audioOnly: false });
  const { phase } = room;
  if (phase === 'live' || phase === 'reconnecting') return <Classroom room={room} sessionId={sessionId} title={title} isHost={isHost} onEnded={() => { /* the hook moves to 'left' */ }} />;
  if (phase === 'starting' || phase === 'connecting') return <Shell><p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {phase === 'starting' ? 'Starting the meeting…' : 'Connecting…'}</p></Shell>;
  if (phase === 'waiting') return (
    <Shell><p className="font-medium">{title}</p>
      <p role="status" className="mt-4 flex items-center gap-2 rounded-md bg-forest-50 p-3 text-sm"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {room.waitMessage || 'Waiting for the host.'} You will go in automatically.</p>
      <Button variant="outline" className="mt-4 w-full" onClick={room.leave}>Not now</Button></Shell>);
  return (
    <Shell>
      <p className="font-medium">{title}</p>
      {room.error && <p role="alert" className={phase === 'ended' && room.error.message.startsWith('The meeting has ended') ? 'mt-3 rounded-md bg-forest-50 p-3 text-sm' : 'mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger'}>{room.error.message}</p>}
      {phase === 'left' && !room.error && <p className="mt-3 rounded-md bg-forest-50 p-3 text-sm">You left the meeting.</p>}
      {phase === 'ended' && !room.error?.message.startsWith('The meeting has ended') ? <div className="mt-4">{back}</div> : (
        <>
          <JoinOptions {...o} set={(k, v) => setO((cur) => ({ ...cur, [k]: v }))} />
          <Button className="mt-4 w-full" size="lg" onClick={() => room.join({ mic: o.mic, cam: o.cam && !o.audioOnly, audioOnly: o.audioOnly })}>{room.error?.retry ? 'Try again' : phase === 'left' ? 'Rejoin' : isHost ? 'Start meeting' : 'Ask to join'}</Button>
          <p className="mt-3 text-xs text-muted">{isHost ? 'Guests wait until you let them in. Leaving does not end the meeting.' : 'The host will let you in. Please allow the camera and microphone when asked.'}</p>
          <div className="mt-3">{back}</div>
        </>)}
    </Shell>
  );
}

/** /app/meeting/:code: the teacher or administrator who made the link. */
export function MeetingHostPage() {
  const { code = '' } = useParams();
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => { void meetingList().then((r) => setTitle(r.meetings.find((m) => m.code === code)?.title ?? '')).catch(() => setTitle('')); }, [code]);
  const back = <Link to="/app/meetings" className="text-sm text-forest-600 underline">Back to meetings</Link>;
  if (!liveConfigured) return <Shell><p className="text-sm">The live classroom is not switched on yet. Please ask the administrator.</p><div className="mt-3">{back}</div></Shell>;
  if (title === null) return <Spinner className="min-h-dvh" />;
  return <MeetingRoom code={code} isHost guest={null} title={title || 'Meeting'} back={back} />;
}

const newGuestId = () => { const b = crypto.getRandomValues(new Uint8Array(16)); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); };
function guestId(): string {
  try { const k = 'ela-guest-id'; let v = localStorage.getItem(k); if (!v || !/^[a-f0-9]{32}$/.test(v)) { v = newGuestId(); localStorage.setItem(k, v); } return v; } catch { return newGuestId(); }
}

/** /meet/:code: anyone with the link. No account: they give a name and wait for the host to let them in. */
export function MeetingGuestPage() {
  const { code = '' } = useParams();
  const [name, setName] = useState(() => { try { return localStorage.getItem('ela-guest-name') ?? ''; } catch { return ''; } });
  const [go, setGo] = useState(false);
  const id = useMemo(guestId, []);
  const guest = useMemo<GuestInfo | null>(() => (go ? { code: code.toLowerCase(), guestId: id, name: name.trim() } : null), [go, code, id, name]);
  if (!liveConfigured) return <Shell><p className="text-sm">Meetings are not switched on yet.</p></Shell>;
  if (!go) return (
    <Shell>
      <p className="font-medium">You are invited to a meeting</p>
      <p className="mt-1 text-sm text-muted">No account is needed. Enter your name so the host knows who you are.</p>
      <Field label="Your name" className="mt-4">{(a) => <Input {...a} value={name} maxLength={40} autoComplete="name" onChange={(e) => setName(e.target.value)} />}</Field>
      <Button className="mt-4 w-full" size="lg" disabled={name.trim().length < 2} onClick={() => { try { localStorage.setItem('ela-guest-name', name.trim()); } catch { /* fine */ } setGo(true); }}>Continue</Button>
    </Shell>);
  return <MeetingRoom key={guest?.guestId} code={code.toLowerCase()} isHost={false} guest={guest} title="Meeting" back={<a href={import.meta.env.BASE_URL} className="text-sm text-forest-600 underline">Go to {BRAND.name}</a>} />;
}
