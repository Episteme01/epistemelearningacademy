import { useState } from 'react';
import { Library, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlay';
import { ResourceViewer } from '@/features/learning/LessonMedia';
import type { ResourceLite } from '@/types/models';

/** Resources a teacher attached to this work. Each opens in the in-page viewer (PDF, slides, video, picture…) with a download link. */
export function ResourceLinks({ items, onWrite }: { items?: ResourceLite[]; onWrite?: (r: ResourceLite) => void }) {
  const [open, setOpen] = useState<ResourceLite | null>(null);
  if (!items?.length) return null;
  return (
    <div className="mt-3">
      <p className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted"><Library className="h-3.5 w-3.5" /> Learning materials</p>
      <ul className="flex flex-wrap gap-2">{items.map((x) => <li key={x.id} className="flex gap-1"><Button size="sm" variant="outline" onClick={() => setOpen(x)}>{x.title}</Button>{onWrite && (x.fileKind === 'image' || x.fileKind === 'document' || !x.fileKind) && <Button size="sm" variant="outline" aria-label={`Write on ${x.title}`} onClick={() => onWrite(x)}><Pencil className="h-3.5 w-3.5" /> Write on it</Button>}</li>)}</ul>
      {open && <Dialog open onClose={() => setOpen(null)} title={open.title} size="xl"><ResourceViewer resourceId={open.id} fallbackTitle={open.title} /></Dialog>}
    </div>
  );
}
