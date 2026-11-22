import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ListOrdered, Loader2, Megaphone, PenLine, Plus, Presentation, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlay';
import { MAX_POLL_OPTS, type BoardMsg, type BoardState, type PollState, type SlidesState } from '@/lib/live/protocol';
import { Whiteboard } from './Whiteboard';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ teacher tools menu */
export function ToolsDialog({ open, onClose, onPresent, onPoll, spotlighting, onClearSpot, slidesOn, onStopSlides, writing, onWrite }: {
  open: boolean; onClose: () => void; onPresent: () => void; onPoll: () => void; spotlighting: boolean; onClearSpot: () => void; slidesOn: boolean; onStopSlides: () => void; writing: boolean; onWrite: (on: boolean) => void;
}) {
  const big = 'flex w-full items-center gap-3 rounded-xl bg-forest-50 p-4 text-left text-ink ring-1 ring-line hover:bg-forest-100';
  return (
    <Dialog open={open} onClose={onClose} title="Teacher tools" size="sm" footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      <div className="space-y-2">
        <button type="button" className={big} onClick={onPresent}><Presentation className="h-6 w-6 text-forest-700" aria-hidden /><span><span className="block font-medium">{slidesOn ? 'Change the slides' : 'Show slides to the class'}</span><span className="block text-xs text-muted">Lesson pictures or photos of pages, turned together for everyone.</span></span></button>
        {slidesOn && <button type="button" className={big} onClick={() => onWrite(!writing)}><PenLine className="h-6 w-6 text-forest-700" aria-hidden /><span><span className="block font-medium">{writing ? 'Stop writing on the page' : 'Let everyone write on this page'}</span><span className="block text-xs text-muted">{writing ? 'Back to plain slides.' : 'You and the learners write on the picture together with a pen. Turning the page clears the writing.'}</span></span></button>}
        {slidesOn && <button type="button" className={big} onClick={onStopSlides}><X className="h-6 w-6 text-danger" aria-hidden /><span className="font-medium">Stop showing slides</span></button>}
        <button type="button" className={big} onClick={onPoll}><ListOrdered className="h-6 w-6 text-forest-700" aria-hidden /><span><span className="block font-medium">Ask a quick question</span><span className="block text-xs text-muted">Learners pick A, B, C or D. You see the counts.</span></span></button>
        {spotlighting && <button type="button" className={big} onClick={onClearSpot}><Megaphone className="h-6 w-6 text-gold-600" aria-hidden /><span className="font-medium">End the spotlight</span></button>}
        <p className="text-xs text-muted">To spotlight a learner, open People and tap Spotlight under their name.</p>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ slides (the picker is in Present.tsx) */
export function SlidesStage({ slides, isHost, onPage, onStop, board, meIdentity, send }: { slides: SlidesState; isHost: boolean; onPage: (n: number) => void; onStop: () => void; board: BoardState; meIdentity: string; send: (m: BoardMsg) => void }) {
  const n = slides.urls.length; const url = slides.urls[slides.page];
  const [loading, setLoading] = useState(true); const [failed, setFailed] = useState(false);
  useEffect(() => { setLoading(true); setFailed(false); }, [url]);
  useEffect(() => { for (const i of [slides.page + 1, slides.page - 1]) { const u = slides.urls[i]; if (u) { const im = new Image(); im.src = u; } } }, [slides.page, slides.urls]);
  const nav = 'flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white disabled:opacity-30';
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg bg-black">
      {slides.write && url ? <div className="min-h-0 flex-1"><Whiteboard board={board} isHost={isHost} meIdentity={meIdentity} send={send} bg={url} /></div> : (
      <div className="relative min-h-0 flex-1 overflow-auto" style={{ touchAction: 'pan-x pan-y pinch-zoom' }}>
        {url && <img key={url} src={url} alt={`Slide ${slides.page + 1} of ${n}`} onLoad={() => setLoading(false)} onError={() => { setLoading(false); setFailed(true); }} className="mx-auto h-full w-full object-contain" />}
        {loading && !failed && <div className="absolute inset-0 flex items-center justify-center text-white" role="status"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading picture" /></div>}
        {failed && <p role="alert" className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white">This picture could not be loaded. Check your connection.</p>}
      </div>)}
      <div className="flex items-center justify-center gap-3 bg-black/70 px-3 py-2 text-white">
        {isHost ? <button type="button" className={nav} aria-label="Previous picture" disabled={slides.page === 0} onClick={() => onPage(slides.page - 1)}><ChevronLeft className="h-6 w-6" /></button> : null}
        <span className="min-w-16 text-center text-sm tabular-nums">{slides.page + 1} / {n}</span>
        {isHost ? <button type="button" className={nav} aria-label="Next picture" disabled={slides.page >= n - 1} onClick={() => onPage(slides.page + 1)}><ChevronRight className="h-6 w-6" /></button> : <span className="text-xs text-white/70">Your teacher turns the pages</span>}
        {isHost && <Button size="sm" variant="outline" className="ml-2 border-white/40 text-white hover:bg-white/10" onClick={onStop}>Stop</Button>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ poll */
const PRESETS: { label: string; opts: string[] }[] = [
  { label: 'A B C D', opts: ['A', 'B', 'C', 'D'] }, { label: 'True / False', opts: ['True', 'False'] }, { label: 'Yes / No', opts: ['Yes', 'No'] },
];

export function PollComposer({ open, onClose, onLaunch }: { open: boolean; onClose: () => void; onLaunch: (q: string, opts: string[]) => boolean }) {
  const [q, setQ] = useState(''); const [opts, setOpts] = useState<string[]>(['A', 'B', 'C', 'D']);
  useEffect(() => { if (open) { setQ(''); setOpts(['A', 'B', 'C', 'D']); } }, [open]);
  const field = 'h-11 w-full rounded-md border border-line bg-white px-3 text-base text-ink';
  const ready = q.trim().length > 0 && opts.filter((o) => o.trim()).length >= 2;
  return (
    <Dialog open={open} onClose={onClose} title="Ask a quick question" size="md"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!ready} onClick={() => { if (onLaunch(q, opts)) onClose(); }}>Ask the class</Button></>}>
      <div className="space-y-3 text-sm">
        <label className="block"><span className="mb-1 block font-medium">Question</span><input className={field} value={q} maxLength={140} onChange={(e) => setQ(e.target.value)} placeholder="Which answer is correct?" /></label>
        <div className="flex flex-wrap gap-2" aria-label="Quick choices">{PRESETS.map((p) => <Button key={p.label} size="sm" variant="outline" onClick={() => setOpts(p.opts)}>{p.label}</Button>)}</div>
        <ul className="space-y-2">
          {opts.map((o, i) => (
            <li key={i} className="flex items-center gap-2">
              <input className={field} value={o} maxLength={60} aria-label={`Option ${i + 1}`} onChange={(e) => setOpts((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))} />
              {opts.length > 2 && <button type="button" aria-label={`Remove option ${i + 1}`} onClick={() => setOpts((cur) => cur.filter((_, j) => j !== i))} className="rounded-md p-2 text-muted hover:bg-forest-50"><Trash2 className="h-4 w-4" /></button>}
            </li>))}
        </ul>
        {opts.length < MAX_POLL_OPTS && <Button size="sm" variant="outline" onClick={() => setOpts((cur) => [...cur, ''])}><Plus className="h-4 w-4" /> Add option</Button>}
        <p className="text-xs text-muted">Learners see only the question and the choices. Results are shown to them when you close the question.</p>
      </div>
    </Dialog>
  );
}

/** Floating card at the top of the stage: the question for learners, the live counts for the teacher. */
export function PollCard({ poll, isHost, myVote, onVote, onClose, onDismiss }: { poll: PollState; isHost: boolean; myVote: number | null; onVote: (i: number) => void; onClose: () => void; onDismiss: () => void }) {
  const [hidden, setHidden] = useState<string | null>(null);
  const total = poll.counts.reduce((a, b) => a + b, 0);
  const showBars = isHost || !poll.open;
  if (hidden === poll.id && !isHost) return null;
  return (
    <section aria-label="Quick question" className="absolute inset-x-2 top-2 z-20 mx-auto max-w-md rounded-xl bg-white p-3 text-ink shadow-xl ring-1 ring-line">
      <div className="mb-2 flex items-start gap-2">
        <p className="flex-1 font-medium">{poll.q}</p>
        {!isHost && !poll.open && <button type="button" aria-label="Hide results" onClick={() => setHidden(poll.id)} className="rounded p-1 text-muted"><X className="h-4 w-4" /></button>}
      </div>
      <ul className="space-y-1.5">
        {poll.opts.map((o, i) => {
          const pct = total ? Math.round(((poll.counts[i] ?? 0) / total) * 100) : 0;
          const mine = myVote === i;
          return (
            <li key={i}>
              {!isHost && poll.open ? (
                <button type="button" onClick={() => onVote(i)} aria-pressed={mine} className={cn('flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ring-1', mine ? 'bg-forest-700 text-white ring-forest-700' : 'bg-white ring-line hover:bg-forest-50')}>
                  <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', mine ? 'bg-white text-forest-700' : 'bg-forest-100 text-forest-700')}>{String.fromCharCode(65 + i)}</span>{o}
                </button>
              ) : (
                <div className="relative overflow-hidden rounded-lg ring-1 ring-line">
                  <div className={cn('absolute inset-y-0 left-0', mine ? 'bg-gold-200' : 'bg-forest-100')} style={{ width: showBars ? `${pct}%` : '0%' }} aria-hidden />
                  <p className="relative flex items-center gap-2 px-3 py-2 text-sm"><span className="font-semibold">{String.fromCharCode(65 + i)}</span><span className="flex-1">{o}</span>{showBars && <span className="tabular-nums text-xs">{poll.counts[i] ?? 0} · {pct}%</span>}</p>
                </div>)}
            </li>);
        })}
      </ul>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted">
        <span className="flex-1">{isHost ? `${total} answered${poll.open ? '' : ' · closed'}` : poll.open ? (myVote == null ? 'Tap your answer.' : 'Answer sent. You can change it until the teacher closes the question.') : `Closed · ${total} answered`}</span>
        {isHost && (poll.open ? <Button size="sm" onClick={onClose}>Close question</Button> : <Button size="sm" variant="outline" onClick={onDismiss}>Hide for everyone</Button>)}
      </div>
    </section>
  );
}
