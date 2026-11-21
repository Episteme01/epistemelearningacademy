import { useEffect, useRef } from 'react';
import { Hand, MicOff, WifiOff } from 'lucide-react';
import { Track, type Participant } from 'livekit-client';
import { cn } from '@/lib/utils';
import type { Person } from './useLiveRoom';

/** One person's picture. Video is attached only while the tile is on screen, so tiles that are not shown cost no bandwidth (adaptive stream). */
export function VideoTile({ person, source = Track.Source.Camera, className, fit = 'cover', onClick, compact, big }: { person: Person; source?: Track.Source; className?: string; fit?: 'cover' | 'contain'; onClick?: () => void; compact?: boolean; big?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const pub = person.participant.getTrackPublication(source);
  const track = pub?.track && !pub.isMuted ? pub.track : undefined;
  useEffect(() => {
    const el = ref.current; if (!el || !track) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);
  const shareTile = source === Track.Source.ScreenShare;
  const weak = person.quality === 'poor' || person.quality === 'lost';
  return (
    <div onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
      className={cn('relative overflow-hidden rounded-lg bg-forest-800 ring-2', onClick && 'cursor-pointer', person.speaking && !shareTile ? 'ring-gold-400' : 'ring-transparent', className)}>
      {track ? <video ref={ref} autoPlay playsInline muted className={cn('h-full w-full', fit === 'contain' ? 'object-contain bg-black' : 'object-cover', person.mirror && !shareTile && 'scale-x-[-1]')} aria-label={`${person.name}${shareTile ? ' screen' : ' video'}`} />
        : <div className="flex h-full w-full items-center justify-center"><span className={cn('flex items-center justify-center rounded-full bg-forest-600 font-heading font-semibold text-white', compact ? 'h-9 w-9 text-sm' : big ? 'h-24 w-24 text-4xl' : 'h-14 w-14 text-xl')} aria-hidden>{person.name.slice(0, 1).toUpperCase()}</span></div>}
      <div className={cn('absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 text-xs text-white', compact ? 'pt-3 text-[10px]' : 'pt-6')}>
        {!person.mic && !shareTile && <MicOff className="h-3.5 w-3.5 shrink-0 text-red-300" aria-label="Microphone off" />}
        <span className="truncate">{shareTile ? `${person.name} is sharing` : `${person.name}${person.isLocal ? ' (you)' : ''}`}</span>
        {person.role === 'host' && !shareTile && !compact && <span className="rounded bg-gold-400 px-1 text-[10px] font-semibold text-forest-900">Teacher</span>}
        {weak && !shareTile && <WifiOff className="ml-auto h-3.5 w-3.5 shrink-0 text-amber-300" aria-label="Weak connection" />}
      </div>
      {person.handUp && <span className="absolute left-2 top-2 rounded-full bg-gold-400 p-1.5 text-forest-900" aria-label="Hand raised"><Hand className="h-4 w-4" /></span>}
    </div>
  );
}

/** Plays everyone else's audio. Browsers may block this until the first tap: the classroom shows a button for that. */
function AudioSink({ participant }: { participant: Participant }) {
  const box = useRef<HTMLDivElement>(null);
  const mic = participant.getTrackPublication(Track.Source.Microphone)?.track;
  const shareAudio = participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
  useEffect(() => {
    const host = box.current; if (!host) return;
    const made: { t: Track; el: HTMLMediaElement }[] = [];
    for (const t of [mic, shareAudio]) { if (!t) continue; const el = t.attach(); host.appendChild(el); made.push({ t, el }); }
    return () => { for (const { t, el } of made) { t.detach(el); el.remove(); } };
  }, [mic, shareAudio]);
  return <div ref={box} hidden />;
}
export function AudioSinks({ people }: { people: Person[] }) {
  return <>{people.filter((p) => !p.isLocal).map((p) => <AudioSink key={p.identity} participant={p.participant} />)}</>;
}
