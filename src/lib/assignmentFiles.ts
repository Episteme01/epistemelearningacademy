import type { FileRef } from '@/lib/fileRef';

/** Most files a teacher can attach to one assignment (keeps the document small and the page quick). */
export const MAX_ATTACHMENTS = 5;

export const fileSizeLabel = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Returns a new list with `ref` added (ignored when the list is already full or the file is already there). */
export function withAttachment(list: FileRef[], ref: FileRef): FileRef[] {
  if (list.length >= MAX_ATTACHMENTS) return list;
  if (ref.path && list.some((f) => f.path === ref.path)) return list;
  return [...list, ref];
}

export const withoutAttachment = (list: FileRef[], index: number): FileRef[] => list.filter((_, i) => i !== index);
