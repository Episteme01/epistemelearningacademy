import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Loader2, Mic, Video, Wifi } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/data';
import { BRAND } from '@/config/brand';
import { C } from '@/config/collections';
import { useAuth } from '@/features/auth/AuthContext';
import { useDocument } from '@/hooks/useFirestore';
import { format12, utcToZoned } from '@/lib/schedule/tz';
import { fmtDate, toDate } from '@/lib/utils';
import type { Session } from '@/types/models';
import { liveConfigured } from './api';
import { Classroom } from './Classroom';
import { useLiveRoom } from './useLiveRoom';

const HOST_ROLES = ['super_admin', 'admin', 'principal'];

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-forest-50 px-4 py-8">
      <div className="w-full max-w-md rounded-xl border border-line bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-3"><img src={BRAND.logo} alt="" className="h-10 w-10 object-contain" /><div><p className="font-heading text-[15px] font-semibold text-forest-700">ELA Live Classroom</p><p className="text-xs text-muted">{BRAND.motto}</p></div></div>
        {children}
      </div>
    </div>
  );
}

/** /app/live/:sessionId. The server decides who may enter; this page only prepares the person and shows the room. */
export function LiveClassroomPage() {
  const { sessionId = '' } = useParams();
  const { uid, roles } = useAuth();
  const sess = useDocument<Session>(C.sessions, sessionId);
  const s = sess.data;
  const isHost = !!s && (roles.some((r) => HOST_ROLES.includes(r)) || (roles.includes('teacher') && s.teacherUid === uid));
  const room = useLiveRoom(sessionId, isHost);
  const [mic, setMic] = useState(false);
  const [cam, setCam] = useState(false);
  const [audioOnly, setAudioOnly] = useState(false);
  const [initialised, setInitialised] = useState(false);
  if (s && !initialised) { setInitialised(true); setMic(isHost); setCam(isHost); }

  const back = <Link to="/app/schedule" className="text-sm text-forest-600 underline">Back to the timetable</Link>;
  if (!liveConfigured) return <Shell><p className="text-sm">The live classroom is not switched on yet. Please ask the administrator.</p><div className="mt-3">{back}</div></Shell>;
  if (sess.loading) return <Spinner className="min-h-dvh" />;
  if (!s) return <Shell><p className="text-sm">This class was not found, or you are not on its list.</p><div className="mt-3">{back}</div></Shell>;

  const tz = s.timezone;
  const when = `${fmtDate(s.startAt)} · ${format12(utcToZoned(toDate(s.startAt)!, tz).time)} – ${format12(utcToZoned(toDate(s.endAt)!, tz).time)}`;
  const { phase } = room;

  if (phase === 'live' || phase === 'reconnecting') return <Classroom room={room} sessionId={sessionId} title={s.title} isHost={isHost} onEnded={() => { /* the room hook moves to 'left' */ }} />;

  if (phase === 'starting' || phase === 'connecting') return <Shell><p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {phase === 'starting' ? 'Starting the class…' : 'Connecting…'}</p></Shell>;
  if (phase === 'waiting') return (
    <Shell><p className="font-medium">{s.title}</p><p className="mt-1 text-sm text-muted">{when}</p>
      <p role="status" className="mt-4 flex items-center gap-2 rounded-md bg-forest-50 p-3 text-sm"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Waiting for your teacher to start the class. You will go in automatically.</p>
      <Button variant="outline" className="mt-4 w-full" onClick={room.leave}>Not now</Button></Shell>);

  const finished = phase === 'ended' || phase === 'left';
  return (
    <Shell>
      <p className="font-medium">{s.title}</p>
      <p className="mt-1 text-sm text-muted">{when}</p>
      {s.provider !== 'ela_live' && <p className="mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger">This class does not use the ELA Live Classroom. Open it from the timetable to see how to join.</p>}
      {room.error && <p role="alert" className="mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger">{room.error.message}</p>}
      {phase === 'left' && !room.error && <p className="mt-3 rounded-md bg-forest-50 p-3 text-sm">You left the class.</p>}
      {phase === 'ended' ? <div className="mt-4">{back}</div> : s.provider === 'ela_live' && (
        <>
          <fieldset className="mt-4 space-y-2 text-sm">
            <legend className="mb-1 text-xs font-medium text-muted">Join with</legend>
            <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={mic} onChange={(e) => setMic(e.target.checked)} /><Mic className="h-4 w-4" aria-hidden /> Microphone on</label>
            <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={cam && !audioOnly} disabled={audioOnly} onChange={(e) => setCam(e.target.checked)} /><Video className="h-4 w-4" aria-hidden /> Camera on</label>
            <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={audioOnly} onChange={(e) => setAudioOnly(e.target.checked)} /><Wifi className="h-4 w-4" aria-hidden /> Audio only (uses much less data)</label>
          </fieldset>
          <Button className="mt-4 w-full" size="lg" onClick={() => room.join({ mic, cam: cam && !audioOnly, audioOnly })}>{room.error?.retry ? 'Try again' : phase === 'left' ? 'Rejoin' : isHost ? 'Start class' : 'Join class'}</Button>
          <p className="mt-3 text-xs text-muted">{isHost ? 'You can go in from 15 minutes before the start. Leaving does not end the class.' : 'You can go in from 15 minutes before the start, once your teacher has started the class.'}</p>
          <div className="mt-3">{back}</div>
        </>)}
    </Shell>
  );
}
