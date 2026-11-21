import { useEffect, useRef, useState } from 'react';
import { LayoutGrid, Pin, UserRound } from 'lucide-react';
import { pickTiles } from '@/lib/live/protocol';
import { cn } from '@/lib/utils';
import { VideoTile } from './VideoTile';
import type { Person } from './useLiveRoom';

type Corner = 'tl' | 'tr' | 'bl' | 'br';
const CORNER_CLASS: Record<Corner, string> = { tl: 'left-2 top-2', tr: 'right-2 top-2', bl: 'bottom-2 left-2', br: 'bottom-2 right-2' };

/**
 * The people view, in the style of a phone video call: one person large on the stage, you in a small floating picture you can drag
 * to any corner, everyone else in a strip you can scroll. Tap your small picture to swap it with the big one; tap anyone in the strip to
 * put them on the stage. Portrait: the strip runs along the bottom. Landscape (and wide screens): it runs down the right side.
 */
export function CallView({ people, onStageTap }: { people: Person[]; onStageTap?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [selfOnStage, setSelfOnStage] = useState(false);
  const [grid, setGrid] = useState(false);
  const [corner, setCorner] = useState<Corner>('br');
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const lastSpeaker = useRef<string | null>(null);

  const local = people.find((p) => p.isLocal);
  const remotes = people.filter((p) => !p.isLocal);
  const speaking = remotes.find((p) => p.speaking);
  if (speaking) lastSpeaker.current = speaking.identity;
  useEffect(() => { if (pinned && !people.some((p) => p.identity === pinned)) setPinned(null); }, [people, pinned]);

  // Who is large when nobody is pinned: the teacher; for the teacher, whoever spoke last, then a raised hand, then the first person.
  const byId = (id: string | null) => remotes.find((p) => p.identity === id);
  const auto = byId(pinned) ?? remotes.find((p) => p.role === 'host') ?? byId(lastSpeaker.current) ?? remotes.find((p) => p.handUp) ?? remotes[0];

  if (!local && !auto) return null;
  const useSelf = (!auto || selfOnStage) && !!local;
  const stage = useSelf ? local! : auto ?? local!;
  const small = !auto ? null : useSelf ? auto : local ?? null;
  const strip = pickTiles(remotes.filter((p) => p.identity !== auto?.identity), 12);

  if (grid && remotes.length > 0) {
    const tiles = pickTiles(people, 9);
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className={cn('grid min-h-0 flex-1 auto-rows-fr gap-2', tiles.length <= 1 ? 'grid-cols-1' : tiles.length <= 4 ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-3')}>
          {tiles.map((p) => <VideoTile key={p.identity} person={p} className="min-h-0" onClick={() => { setPinned(p.isLocal ? null : p.identity); setSelfOnStage(p.isLocal); setGrid(false); }} />)}
        </div>
        <button type="button" onClick={() => setGrid(false)} className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white"><UserRound className="h-3.5 w-3.5" aria-hidden /> Speaker view</button>
      </div>);
  }

  const onDown = (e: React.PointerEvent) => { e.currentTarget.setPointerCapture(e.pointerId); press.current = { x: e.clientX, y: e.clientY, moved: false }; };
  const onMove = (e: React.PointerEvent) => {
    const p = press.current; if (!p) return;
    const dx = e.clientX - p.x; const dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) > 8) p.moved = true;
    if (p.moved) setDrag({ x: dx, y: dy });
  };
  const onUp = (e: React.PointerEvent) => {
    const p = press.current; press.current = null; if (!p) return;
    if (!p.moved) { setSelfOnStage((v) => !v); return; }                        // a tap swaps the big and small pictures
    const me = e.currentTarget.getBoundingClientRect(); const c = box.current?.getBoundingClientRect();
    if (c) { const right = me.left + me.width / 2 - c.left > c.width / 2; const bottom = me.top + me.height / 2 - c.top > c.height / 2; setCorner(`${bottom ? 'b' : 't'}${right ? 'r' : 'l'}` as Corner); }
    setDrag(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 landscape:flex-row">
      <div ref={box} className="relative min-h-0 min-w-0 flex-1">
        <VideoTile person={stage} className="h-full w-full" onClick={onStageTap} big />
        {pinned && stage.identity === pinned && (
          <button type="button" onClick={() => setPinned(null)} className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white"><Pin className="h-3.5 w-3.5" aria-hidden /> Unpin</button>)}
        {remotes.length > 0 && (
          <button type="button" onClick={() => setGrid(true)} className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white"><LayoutGrid className="h-3.5 w-3.5" aria-hidden /> Grid</button>)}
        {small && (
          <div role="button" tabIndex={0} aria-label={selfOnStage ? 'Swap: bring the other person to the front' : 'Your picture. Tap to enlarge, drag to move'}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { press.current = null; setDrag(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelfOnStage((v) => !v); }}
            style={{ touchAction: 'none', transform: drag ? `translate(${drag.x}px, ${drag.y}px)` : undefined }}
            className={cn('absolute z-10 aspect-[3/4] w-24 cursor-grab select-none shadow-lg shadow-black/40 landscape:aspect-[4/3] landscape:w-32 sm:w-28', CORNER_CLASS[corner], !drag && 'transition-[top,left,right,bottom] duration-200')}>
            <VideoTile person={small} className="pointer-events-none h-full w-full" compact />
          </div>)}
      </div>
      {strip.length > 0 && (
        <div className="flex shrink-0 gap-2 overflow-x-auto landscape:w-36 landscape:flex-col landscape:overflow-y-auto landscape:overflow-x-hidden md:landscape:w-44">
          {strip.map((p) => <VideoTile key={p.identity} person={p} compact onClick={() => { setPinned(p.identity); setSelfOnStage(false); }} className="h-20 w-28 shrink-0 landscape:h-24 landscape:w-full" />)}
        </div>)}
    </div>
  );
}
