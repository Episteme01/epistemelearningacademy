import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, UserCheck, X } from 'lucide-react';
import { admitAll, admitOne, denyOne, getLobby, setAutoAdmit, type LobbyEntry } from './api';

/** The teacher's waiting room: learners ask to come in and the teacher lets them in (or switches on automatic admission). */
export function LobbyBar({ sessionId, onError }: { sessionId: string; onError: (m: string) => void }) {
  const [waiting, setWaiting] = useState<LobbyEntry[]>([]);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const refresh = useCallback(() => getLobby(sessionId).then((r) => { if (alive.current) { setWaiting(r.waiting); setAuto(r.auto); } }).catch(() => { /* the next poll tries again */ }), [sessionId]);
  useEffect(() => {
    alive.current = true; void refresh();
    const t = window.setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    return () => { alive.current = false; window.clearInterval(t); };
  }, [refresh]);

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try { await f(); await refresh(); } catch (e) { onError(e instanceof Error ? e.message : 'That did not work. Try again.'); } finally { setBusy(false); }
  };
  const btn = 'inline-flex h-9 items-center gap-1 rounded-md px-2.5 text-xs font-medium disabled:opacity-50';
  return (
    <div className="px-3 pb-1" aria-live="polite">
      {waiting.length > 0 && (
        <div className="mb-1 rounded-lg bg-gold-500/95 p-2 text-ink" role="status">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold"><UserCheck className="h-4 w-4" aria-hidden /> {waiting.length} waiting to join</p>
            {waiting.length > 1 && <button type="button" disabled={busy} className={`${btn} bg-ink text-white`} onClick={() => void run(() => admitAll(sessionId))}>Admit all</button>}
          </div>
          <ul className="mt-1 space-y-1">
            {waiting.slice(0, 6).map((w) => (
              <li key={w.identity} className="flex items-center justify-between gap-2 rounded bg-white/70 px-2 py-1">
                <span className="min-w-0 truncate text-sm">{w.name || 'Learner'}</span>
                <span className="flex shrink-0 gap-1">
                  <button type="button" disabled={busy} aria-label={`Admit ${w.name}`} className={`${btn} bg-forest-700 text-white`} onClick={() => void run(() => admitOne(sessionId, w.identity))}><Check className="h-4 w-4" /> Admit</button>
                  <button type="button" disabled={busy} aria-label={`Do not admit ${w.name}`} className={`${btn} border border-ink/30 bg-white`} onClick={() => void run(() => denyOne(sessionId, w.identity))}><X className="h-4 w-4" /> No</button>
                </span>
              </li>))}
          </ul>
          {waiting.length > 6 && <p className="mt-1 text-xs">and {waiting.length - 6} more…</p>}
        </div>)}
      {!sessionId.startsWith('m-') && <button type="button" disabled={busy} className="text-xs text-white/70 underline underline-offset-2" onClick={() => void run(() => setAutoAdmit(sessionId, !auto))}>
        {auto ? 'Everyone is let in automatically. Tap to approve each person instead.' : 'You approve each learner. Tap to let everyone in automatically.'}
      </button>}
    </div>
  );
}
