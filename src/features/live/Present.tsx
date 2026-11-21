import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, FileText, ImagePlus, Library, Loader2, Search, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlay';
import { useAuth } from '@/features/auth/AuthContext';
import { C } from '@/config/collections';
import { useCollection } from '@/hooks/useFirestore';
import { publicUrl, refOf } from '@/lib/fileRef';
import { MAX_SLIDES } from '@/lib/live/protocol';
import { MAX_SOURCE_BYTES, OFFICE_HELP, OTHER_HELP, clampRange, defaultRange, pagesUsed, sourceKind, type SlideSource } from '@/lib/live/slideSources';
import { signedUrlFor, uploadFor } from '@/services/files';
import type { Resource, WithId } from '@/types/models';
import { openPdf, type PdfDoc } from './pdfPages';

/** Makes a photo small enough for phones on weak data: longest side 1600 px, JPEG. Anything it cannot read is sent as it is. */
async function shrink(file: File, maxEdge = 1600): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)); const h = Math.max(1, Math.round(bmp.height * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); if (!ctx) { bmp.close(); return file; }
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.82));
    return blob ? new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'slide'}.jpg`, { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

/** Downloads the file behind a resource (private uploads through a short-lived link, library files by their public link). */
async function fetchResourceFile(r: WithId<Resource>): Promise<{ blob: Blob; name: string; type: string }> {
  const ref = refOf(r.fileRef, r.url);
  const url = ref?.provider === 'supabase' ? await signedUrlFor('resources', r.id) : publicUrl(ref) ?? (r.url || null);
  if (!url) throw new Error('This resource has no file that can be opened.');
  let resp: Response;
  try { resp = await fetch(url, { credentials: 'omit' }); } catch { throw new Error('This resource could not be downloaded here (its host does not allow it). Download it and add it from your device instead.'); }
  if (!resp.ok) throw new Error('This resource could not be downloaded. Try again.');
  const blob = await resp.blob();
  return { blob, name: r.fileName ?? ref?.name ?? r.title, type: r.contentType ?? ref?.contentType ?? blob.type };
}

interface Src extends SlideSource { id: string; name: string; file?: File; pdf?: PdfDoc; thumb?: string }

/** A number box that accepts typing freely and is corrected when you leave it. */
function PageBox({ value, label, onCommit }: { value: number; label: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => onCommit(Number(text));
  return <input value={text} inputMode="numeric" aria-label={label} onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 4))} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} className="h-10 w-16 rounded-md border border-line bg-white px-2 text-center text-base text-ink" />;
}

/** Pick something from Resources. Only PDFs and pictures can be shown; PowerPoint files are listed with how to export them. */
function ResourceList({ onPick, onBack, busy }: { onPick: (r: WithId<Resource>) => void; onBack: () => void; busy: boolean }) {
  const res = useCollection<Resource>(C.resources, () => [], 'present');
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return res.data
      .filter((r) => r.kind === 'file' || r.fileRef)
      .map((r) => ({ r, kind: sourceKind(r.fileName ?? r.fileRef?.name ?? r.title, r.contentType ?? r.fileRef?.contentType ?? '') }))
      .filter((x) => x.kind !== 'other')
      .filter((x) => !needle || `${x.r.title} ${x.r.subject ?? ''} ${(x.r.tags ?? []).join(' ')}`.toLowerCase().includes(needle))
      .sort((a, b) => a.r.title.localeCompare(b.r.title));
  }, [res.data, q]);
  return (
    <div className="space-y-3 text-sm">
      <Button variant="outline" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back</Button>
      <label className="flex items-center gap-2 rounded-md border border-line bg-white px-3"><Search className="h-4 w-4 text-muted" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Resources" aria-label="Search Resources" className="h-11 min-w-0 flex-1 bg-transparent text-base text-ink outline-none" /></label>
      {res.loading ? <p className="flex items-center gap-2 text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        : res.error ? <p role="alert" className="text-danger">Resources could not be loaded.</p>
        : rows.length === 0 ? <p className="text-muted">No PDFs or pictures found in Resources.</p>
        : (
          <ul className="space-y-2">
            {rows.map(({ r, kind }) => (
              <li key={r.id}>
                <button type="button" disabled={busy || kind === 'office'} onClick={() => onPick(r)} className="flex w-full items-center gap-3 rounded-lg bg-white p-3 text-left ring-1 ring-line enabled:hover:bg-forest-50 disabled:opacity-60">
                  <FileText className="h-5 w-5 shrink-0 text-forest-700" aria-hidden />
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium text-ink">{r.title}</span>
                    <span className="block truncate text-xs text-muted">{kind === 'pdf' ? 'PDF' : kind === 'image' ? 'Picture' : 'PowerPoint: export it as a PDF first'}{r.subject ? ` · ${r.subject}` : ''}</span></span>
                </button>
              </li>))}
          </ul>)}
    </div>
  );
}

export function PresentDialog({ open, onClose, onShow }: { open: boolean; onClose: () => void; onShow: (urls: string[]) => boolean }) {
  const { roles } = useAuth();
  const [srcs, setSrcs] = useState<Src[]>([]);
  const [view, setView] = useState<'main' | 'library'>('main');
  const [adding, setAdding] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const live = useRef<Src[]>([]); live.current = srcs;
  const used = pagesUsed(srcs); const free = MAX_SLIDES - used;
  const working = adding || !!progress;

  const dispose = (list: Src[]) => { for (const s of list) { s.pdf?.close(); if (s.thumb) URL.revokeObjectURL(s.thumb); } };
  useEffect(() => { if (!open) { dispose(live.current); setSrcs([]); setView('main'); setError(''); setProgress(null); setAdding(false); } }, [open]);
  useEffect(() => () => dispose(live.current), []);

  /** Adds a PDF or picture. Throws a plain-words message when it cannot be used. */
  const addBlob = async (name: string, type: string, data: Blob) => {
    const kind = sourceKind(name, type);
    if (kind === 'office') throw new Error(OFFICE_HELP);
    if (kind === 'other') throw new Error(OTHER_HELP);
    if (data.size > MAX_SOURCE_BYTES) throw new Error('This file is too large (the limit is 40 MB).');
    if (free < 1) throw new Error(`You already have ${MAX_SLIDES} pages. Remove some first.`);
    const id = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    if (kind === 'image') {
      const file = data instanceof File ? data : new File([data], name, { type: type || data.type });
      setSrcs((cur) => [...cur, { id, name, kind: 'image', pages: 1, from: 1, to: 1, file, thumb: URL.createObjectURL(file) }]);
    } else {
      const pdf = await openPdf(await data.arrayBuffer(), name);
      const r = defaultRange(pdf.pages, free);
      setSrcs((cur) => [...cur, { id, name, kind: 'pdf', pages: pdf.pages, ...r, pdf }]);
    }
  };
  const addFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError(''); setAdding(true);
    try { for (const f of Array.from(list)) await addBlob(f.name, f.type, f); } catch (e) { setError(e instanceof Error ? e.message : 'That file could not be added.'); }
    finally { setAdding(false); if (input.current) input.current.value = ''; }
  };
  const addResource = async (r: WithId<Resource>) => {
    setError(''); setAdding(true);
    try { const f = await fetchResourceFile(r); await addBlob(f.name, f.type, f.blob); setView('main'); } catch (e) { setError(e instanceof Error ? e.message : 'That resource could not be added.'); setView('main'); }
    finally { setAdding(false); }
  };
  const setRange = (s: Src, from: number, to: number) => setSrcs((cur) => cur.map((x) => (x.id === s.id ? { ...x, ...clampRange(from, to, x.pages, pagesUsed(cur.filter((y) => y.id !== x.id))) } : x)));
  const remove = (s: Src) => { dispose([s]); setSrcs((cur) => cur.filter((x) => x.id !== s.id)); };

  const go = async () => {
    setError(''); const total = used; setProgress({ done: 0, total });
    try {
      const urls: string[] = [];
      const send = async (f: File) => {
        const ref = await uploadFor('staff_image', f, roles, {});
        if (!ref.url) throw new Error('A page could not be stored. Try again.');
        urls.push(ref.url); setProgress({ done: urls.length, total });
      };
      for (const s of srcs) {
        if (s.kind === 'image' && s.file) await send(await shrink(s.file));
        else if (s.pdf) for (let n = s.from; n <= s.to; n++) await send(await s.pdf.render(n));
      }
      if (onShow(urls)) onClose(); else setError('The pages were uploaded but could not be shown. Try fewer pages.');
    } catch (e) { setError(e instanceof Error ? e.message : 'The upload failed. Check your connection and try again.'); } finally { setProgress(null); }
  };

  return (
    <Dialog open={open} onClose={working ? () => undefined : onClose} title="Show slides to the class" size="md"
      footer={view === 'main' ? <><Button variant="outline" onClick={onClose} disabled={working}>Cancel</Button><Button onClick={() => void go()} loading={!!progress} disabled={srcs.length === 0 || adding}>{progress ? `Preparing ${progress.done}/${progress.total}` : `Show ${used} page${used === 1 ? '' : 's'}`}</Button></> : undefined}>
      {view === 'library' ? <ResourceList onPick={(r) => void addResource(r)} onBack={() => setView('main')} busy={adding} /> : (
        <div className="space-y-3 text-sm">
          <p className="text-muted">Add PDFs or pictures (up to {MAX_SLIDES} pages in all). Each page is turned into a picture that is quick to load on phones, and you turn the pages for everyone.</p>
          <input ref={input} type="file" accept="application/pdf,.pdf,image/*,.ppt,.pptx" multiple className="hidden" onChange={(e) => void addFiles(e.target.files)} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => input.current?.click()} disabled={working || free < 1}><Upload className="h-4 w-4" /> From this device</Button>
            <Button variant="outline" onClick={() => setView('library')} disabled={working || free < 1}><Library className="h-4 w-4" /> From Resources</Button>
          </div>
          {adding && <p className="flex items-center gap-2 text-muted" role="status"><Loader2 className="h-4 w-4 animate-spin" /> Opening…</p>}
          {srcs.length > 0 && (
            <ul className="space-y-2">
              {srcs.map((s) => (
                <li key={s.id} className="flex items-center gap-3 rounded-lg bg-white p-2.5 ring-1 ring-line">
                  {s.thumb ? <img src={s.thumb} alt="" className="h-12 w-16 shrink-0 rounded object-cover" /> : <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded bg-forest-50"><FileText className="h-6 w-6 text-forest-700" aria-hidden /></span>}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-ink">{s.name}</p>
                    {s.kind === 'pdf' ? (
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">PDF, {s.pages} page{s.pages === 1 ? '' : 's'}. Show pages
                        <PageBox value={s.from} label="First page" onCommit={(n) => setRange(s, n, s.to)} /> to <PageBox value={s.to} label="Last page" onCommit={(n) => setRange(s, s.from, n)} /></p>
                    ) : <p className="text-xs text-muted"><ImagePlus className="mr-1 inline h-3.5 w-3.5" aria-hidden />Picture</p>}
                  </div>
                  {!progress && <button type="button" aria-label={`Remove ${s.name}`} onClick={() => remove(s)} className="rounded-md p-2 text-muted hover:bg-forest-50"><Trash2 className="h-4 w-4" /></button>}
                </li>))}
            </ul>)}
          {srcs.length > 0 && <p className="text-xs text-muted">{used} of {MAX_SLIDES} pages</p>}
          {error && <p role="alert" className="rounded-md bg-danger/10 p-2 text-danger">{error}</p>}
        </div>)}
    </Dialog>
  );
}
