import { useRef, useState } from 'react';
import { FileText, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/overlay';
import { useAuth } from '@/features/auth/AuthContext';
import { flags } from '@/config/env';
import { UPLOADS_OFF_MESSAGE, deleteFileRef, uploadFor } from '@/services/files';
import type { FileRef } from '@/lib/fileRef';
import { MAX_ATTACHMENTS, fileSizeLabel, withAttachment, withoutAttachment } from '@/lib/assignmentFiles';
import { errorMessage } from '@/lib/utils';

/** Form field for a few attached files (worksheets, PDFs, pictures, audio). Files upload as soon as they are chosen. */
export function FilesField({ value, onChange }: { value: FileRef[]; onChange: (v: FileRef[]) => void }) {
  const { roles } = useAuth();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false); const [pct, setPct] = useState(0);
  const list = Array.isArray(value) ? value : [];

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    if (!flags.uploads) return toast.error(UPLOADS_OFF_MESSAGE);
    setBusy(true);
    let next = list;
    try {
      for (const file of Array.from(files)) {
        if (next.length >= MAX_ATTACHMENTS) { toast.error(`You can attach up to ${MAX_ATTACHMENTS} files.`); break; }
        next = withAttachment(next, await uploadFor('assignment_file', file, roles, {}, setPct));
        onChange(next);
      }
    } catch (e) { toast.error(errorMessage(e)); onChange(next); } finally { setBusy(false); setPct(0); if (input.current) input.current.value = ''; }
  };
  const remove = (i: number) => { const gone = list[i]; onChange(withoutAttachment(list, i)); void deleteFileRef(gone).catch(() => undefined); };

  return (
    <div className="space-y-2">
      {list.length > 0 && (
        <ul className="space-y-1.5">
          {list.map((f, i) => (
            <li key={`${f.path ?? f.url}-${i}`} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-1.5 text-sm">
              <span className="min-w-0 truncate"><FileText className="mr-1 inline h-4 w-4 text-forest-500" />{f.name ?? 'File'}{f.size ? <span className="text-xs text-muted"> · {fileSizeLabel(f.size)}</span> : null}</span>
              <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${f.name ?? 'file'}`} disabled={busy} onClick={() => remove(i)}><Trash2 className="h-4 w-4" /></Button>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="outline" size="sm" loading={busy} disabled={list.length >= MAX_ATTACHMENTS} onClick={() => input.current?.click()}><Upload className="h-4 w-4" /> {busy && pct ? `Uploading ${pct}%` : 'Attach files'}</Button>
      <input ref={input} type="file" multiple hidden onChange={(e) => void add(e.target.files)} />
      <p className="text-xs text-muted">Optional. Up to {MAX_ATTACHMENTS} files for learners to open (images 10 MB, documents and audio 20 MB).</p>
    </div>
  );
}
