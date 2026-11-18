import { useMemo, useState } from 'react';
import { Library, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Spinner } from '@/components/ui/data';
import { Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { useCollection } from '@/hooks/useFirestore';
import { C } from '@/config/collections';
import { MAX_WORK_RESOURCES } from '@/lib/resourceAccess';
import { KIND_LABEL } from '@/lib/resources';
import type { Resource, ResourceLite } from '@/types/models';

/** Pick items from the Resources library into a piece of work. Learners and parents get access when the work is saved. */
export function ResourcesField({ value, onChange }: { value: ResourceLite[]; onChange: (v: ResourceLite[]) => void }) {
  const list = Array.isArray(value) ? value : [];
  const [open, setOpen] = useState(false); const [q, setQ] = useState('');
  const res = useCollection<Resource>(C.resources, () => (open ? [] : null), open ? 'on' : 'off');
  const rows = useMemo(() => res.data.filter((r) => !q.trim() || `${r.title} ${r.subject ?? ''} ${r.className ?? ''} ${r.courseName ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => a.title.localeCompare(b.title)), [res.data, q]);
  const has = (id: string) => list.some((x) => x.id === id);
  const toggle = (r: { id: string; title: string; fileKind?: string }) => onChange(has(r.id) ? list.filter((x) => x.id !== r.id) : list.length >= MAX_WORK_RESOURCES ? list : [...list, { id: r.id, title: r.title, fileKind: r.fileKind }]);
  return (
    <div className="space-y-2">
      {list.length > 0 && (
        <ul className="space-y-1.5">{list.map((x) => (
          <li key={x.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-1.5 text-sm">
            <span className="min-w-0 truncate"><Library className="mr-1 inline h-4 w-4 text-forest-500" />{x.title}</span>
            <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${x.title}`} onClick={() => onChange(list.filter((y) => y.id !== x.id))}><Trash2 className="h-4 w-4" /></Button>
          </li>))}</ul>)}
      <Button type="button" variant="outline" size="sm" disabled={list.length >= MAX_WORK_RESOURCES} onClick={() => setOpen(true)}><Library className="h-4 w-4" /> Pick from Resources</Button>
      <p className="text-xs text-muted">Optional. Up to {MAX_WORK_RESOURCES}. Learners and parents of this work can open them; they cannot see other resources.</p>
      <Dialog open={open} onClose={() => setOpen(false)} title="Pick from Resources" size="lg" footer={<Button onClick={() => setOpen(false)}>Done ({list.length})</Button>}>
        <Input aria-label="Search resources" placeholder="Search by title, subject, class or course" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
        {res.loading ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-muted">No resources found. Add them on the Resources page first.</p> : (
          <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto">{rows.map((r) => (
            <li key={r.id}>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-line p-2 text-sm hover:bg-cream">
                <input type="checkbox" className="mt-1 accent-forest-700" checked={has(r.id)} onChange={() => toggle(r)} />
                <span className="min-w-0 flex-1"><span className="font-medium">{r.title}</span>
                  <span className="block text-xs text-muted">{[KIND_LABEL[r.fileKind], r.subject, r.className, r.courseName].filter(Boolean).join(' · ')}</span></span>
                {!r.published && <Badge tone="warn">Draft: publish it so learners can open it</Badge>}
              </label>
            </li>))}</ul>)}
      </Dialog>
    </div>
  );
}
