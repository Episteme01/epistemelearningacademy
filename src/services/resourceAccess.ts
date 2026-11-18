import { where } from 'firebase/firestore';
import { C } from '@/config/collections';
import { batchSet, getById, listDocs, patchDoc } from '@/services/db';
import { sameList, viewersFor, withCourseLink, type WorkLike } from '@/lib/resourceAccess';
import type { Resource } from '@/types/models';

/**
 * Recomputes who can open each of these resources from the assignments / homework / classwork / projects / presentations
 * that use them. Exact, so removing a resource from work (or deleting the work) also removes access.
 * Needs a teacher or school-leader login. Never throws: returns false when something could not be saved.
 */
export async function rebuildResourceAccess(resourceIds: string[]): Promise<boolean> {
  const ids = [...new Set(resourceIds.filter(Boolean))];
  if (!ids.length) return true;
  try {
    for (const id of ids) {
      const [work, res] = await Promise.all([listDocs<WorkLike>(C.assignments, [where('resourceIds', 'array-contains', id)]), getById<Resource>(C.resources, id)]);
      if (!res) continue;
      const next = viewersFor(id, work);
      if (!sameList(res.viewerUids, next)) await patchDoc(C.resources, id, { viewerUids: next });
    }
    return true;
  } catch (e) { console.warn('resource access update failed', e); return false; }
}

/** Every resource, in one pass (the "Refresh who can see" button). Also records course links from lessons. */
export async function rebuildAllResourceAccess(): Promise<{ checked: number; changed: number }> {
  const [work, resources, lessons] = await Promise.all([listDocs<WorkLike>(C.assignments, []), listDocs<Resource>(C.resources, []), listDocs<{ resourceId?: string; courseId?: string }>(C.lessons, [])]);
  const ops: { col: string; id: string; data: object; merge: boolean }[] = [];
  for (const r of resources) {
    const viewers = viewersFor(r.id, work);
    let links = r.courseLinks ?? [];
    for (const l of lessons) if (l.resourceId === r.id && l.courseId) links = withCourseLink(links, l.courseId);
    if (!sameList(r.viewerUids, viewers) || !sameList(r.courseLinks, links)) ops.push({ col: C.resources, id: r.id, merge: true, data: { viewerUids: viewers, courseLinks: links } });
  }
  for (let i = 0; i < ops.length; i += 400) await batchSet(ops.slice(i, i + 400));
  return { checked: resources.length, changed: ops.length };
}

/** A lesson uses this resource: let learners enrolled in the course open it. */
export async function linkResourceToCourse(resourceId: string, courseId: string): Promise<void> {
  if (!resourceId || !courseId) return;
  try {
    const r = await getById<Resource>(C.resources, resourceId); if (!r) return;
    const next = withCourseLink(r.courseLinks ?? [], courseId);
    if (next !== (r.courseLinks ?? []) && !sameList(next, r.courseLinks ?? [])) await patchDoc(C.resources, resourceId, { courseLinks: next });
  } catch (e) { console.warn('course link failed', e); }
}
