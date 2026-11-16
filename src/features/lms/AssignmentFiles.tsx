import { useRef, useState } from 'react';
import { FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, useToast } from '@/components/ui/overlay';
import { useAuth } from '@/features/auth/AuthContext';
import { C } from '@/config/collections';
import { flags } from '@/config/env';
import { patchDoc } from '@/services/db';
import { audit } from '@/services/audit';
import { UPLOADS_OFF_MESSAGE, deleteFileRef, signedUrlFor, uploadFor } from '@/services/files';
import type { FileRef } from '@/lib/fileRef';
import { MAX_ATTACHMENTS, fileSizeLabel, withAttachment, withoutAttachment } from '@/lib/assignmentFiles';
import { errorMessage } from '@/lib/utils';

/** Teacher-attached files for one assignment. Each button fetches a short-lived signed link. */
export function AttachmentList({ assignmentId, files }: { assignmentId: string; files?: FileRef[] }) {
  const toast = useToast();
  if (!files?.length) return null;
  const open = (i: number, f: FileRef) => {
    if (f.provider !== 'supabase') { if (f.url) window.open(f.url, '_blank', 'noopener'); return; }
    const w = window.open('', '_blank');
    void signedUrlFor('assignments', assignmentId, i).then((u) => { if (u && w) w.location.href = u; else { w?.close(); toast.error('Could not open this file. Try again.'); } });
  };
  return (
    <div className="mt-3">
      <p className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted"><Paperclip className="h-3.5 w-3.5" /> Files from your teacher</p>
      <ul className="flex flex-wrap gap-2">
        {files.map((f, i) => (
          <li key={`${f.path ?? f.url}-${i}`}>
            <Button size="sm" variant="outline" onClick={() => open(i, f)}><FileText className="h-3.5 w-3.5" /> {f.name ?? 'File'}{f.size ? <span className="text-xs text-muted"> · {fileSizeLabel(f.size)}</span> : null}</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Staff dialog: add or remove the files attached to an assignment. */
export function AttachmentsEditor({ assignment, onClose }: { assignment: { id: string; title: string; attachments?: FileRef[] } | null; onClose: () => void }) {
  const { roles } = useAuth();
  const toast = useToast();
  const [files, setFiles] = useState<FileRef[] | null>(null);
  const [busy, setBusy] = useState(false); const [pct, setPct] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const current = files ?? assignment?.attachments ?? [];
  const reset = () => { setFiles(null); onClose(); };

  const add = async (list: FileList | null) => {
    if (!assignment || !list?.length) return;
    if (!flags.uploads) return toast.error(UPLOADS_OFF_MESSAGE);
    setBusy(true);
    let next = current;
    try {
      for (const file of Array.from(list)) {
        if (next.length >= MAX_ATTACHMENTS) { toast.error(`You can attach up to ${MAX_ATTACHMENTS} files.`); break; }
        const ref = await uploadFor('assignment_file', file, roles, {}, setPct);
        next = withAttachment(next, ref);
        await patchDoc(C.assignments, assignment.id, { attachments: next });   // save after each file so nothing is lost
        setFiles(next);
      }
      void audit('assignment.attach', `assignments/${assignment.id}`, `${next.length} files`);
      toast.success('Attachment saved');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); setPct(0); if (input.current) input.current.value = ''; }
  };
  const remove = async (i: number) => {
    if (!assignment) return;
    const gone = current[i]; const next = withoutAttachment(current, i);
    setBusy(true);
    try {
      await patchDoc(C.assignments, assignment.id, { attachments: next }); setFiles(next);
      void deleteFileRef(gone).catch(() => undefined);   // best effort; the record is already updated
      toast.success('Removed');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={!!assignment} onClose={reset} title="Assignment files" description={assignment?.title ?? ''}
      footer={<Button variant="outline" onClick={reset}>Done</Button>}>
      <p className="mb-3 text-sm text-muted">Learners assigned this work can open these files (worksheets, PDFs, pictures, audio). Up to {MAX_ATTACHMENTS} files; images 10 MB, documents and audio 20 MB.</p>
      {current.length === 0 ? <p className="rounded-md border border-dashed border-line p-4 text-center text-sm text-muted">No files attached yet.</p> : (
        <ul className="space-y-2">
          {current.map((f, i) => (
            <li key={`${f.path ?? f.url}-${i}`} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
              <span className="min-w-0 truncate"><FileText className="mr-1 inline h-4 w-4 text-forest-500" />{f.name ?? 'File'}{f.size ? <span className="text-xs text-muted"> · {fileSizeLabel(f.size)}</span> : null}</span>
              <Button size="sm" variant="ghost" aria-label={`Remove ${f.name ?? 'file'}`} disabled={busy} onClick={() => void remove(i)}><Trash2 className="h-4 w-4" /></Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <Button variant="outline" loading={busy} disabled={current.length >= MAX_ATTACHMENTS} onClick={() => input.current?.click()}><Upload className="h-4 w-4" /> {busy && pct ? `Uploading ${pct}%` : 'Add files'}</Button>
        <input ref={input} type="file" multiple hidden onChange={(e) => void add(e.target.files)} />
      </div>
    </Dialog>
  );
}
