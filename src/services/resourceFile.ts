import { publicUrl, refOf } from '@/lib/fileRef';
import { signedUrlFor } from '@/services/files';
import { getById } from '@/services/db';
import { C } from '@/config/collections';
import type { Resource, WithId } from '@/types/models';

export interface Downloaded { blob: Blob; name: string; type: string }

async function grab(url: string, name: string, type: string): Promise<Downloaded> {
  let resp: Response;
  try { resp = await fetch(url, { credentials: 'omit' }); } catch { throw new Error('This file could not be downloaded here (its host does not allow it). Download it and use "From my device" instead.'); }
  if (!resp.ok) throw new Error('This file could not be downloaded. Try again.');
  const blob = await resp.blob();
  return { blob, name, type: type || blob.type };
}

/** Downloads the file behind a resource (private uploads through a short-lived link, library files by their public link). */
export async function fetchResourceFile(r: WithId<Resource>): Promise<Downloaded> {
  const ref = refOf(r.fileRef, r.url);
  const url = ref?.provider === 'supabase' ? await signedUrlFor('resources', r.id) : publicUrl(ref) ?? (r.url || null);
  if (!url) throw new Error('This resource has no file that can be opened.');
  return grab(url, r.fileName ?? ref?.name ?? r.title, r.contentType ?? ref?.contentType ?? '');
}

export async function fetchResourceById(id: string): Promise<Downloaded> {
  const r = await getById<Resource>(C.resources, id);
  if (!r) throw new Error('This material is no longer available.');
  return fetchResourceFile(r);
}

/** A file the teacher attached to an assignment (index i in its attachments). */
export async function fetchAttachment(assignmentId: string, i: number, f: { provider?: string; url?: string; name?: string; contentType?: string }): Promise<Downloaded> {
  const url = f.provider === 'supabase' ? await signedUrlFor('assignments', assignmentId, i) : f.url ?? null;
  if (!url) throw new Error('This file could not be opened.');
  return grab(url, f.name ?? 'worksheet', f.contentType ?? '');
}
