// Pure rules for who can open a resource, and how the Resources page groups them.
import type { Resource, WithId } from '@/types/models';

export const MAX_VIEWERS = 3000;
export const MAX_COURSE_LINKS = 3;
export const MAX_WORK_RESOURCES = 6;

export interface WorkLike { resourceIds?: string[]; studentUids?: string[]; parentViewers?: string[] }

/** Everyone (learners and their parents) who should be able to open `resourceId`, from the work that uses it. */
export function viewersFor(resourceId: string, work: WorkLike[]): string[] {
  const out = new Set<string>();
  for (const w of work) {
    if (!(w.resourceIds ?? []).includes(resourceId)) continue;
    (w.studentUids ?? []).forEach((u) => u && out.add(u));
    (w.parentViewers ?? []).forEach((u) => u && out.add(u));
  }
  return [...out].sort().slice(0, MAX_VIEWERS);
}

export const sameList = (a: string[] = [], b: string[] = []) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Adds a course to a resource's course list (at most 3, no duplicates). Returns the same list when nothing changes. */
export function withCourseLink(list: string[] = [], courseId: string): string[] {
  if (!courseId || list.includes(courseId) || list.length >= MAX_COURSE_LINKS) return list;
  return [...list, courseId];
}

export type GroupBy = 'class' | 'subject' | 'course';
export const OTHERS = 'Others';

/** Groups resources under a class, subject or course heading; anything without one goes to "Others", which is always last. */
export function groupResources<T extends Pick<Resource, 'classId' | 'className' | 'subject' | 'courseId' | 'courseName'>>(rows: WithId<T>[], by: GroupBy): { name: string; rows: WithId<T>[] }[] {
  const key = (r: T) => (by === 'class' ? r.className || (r.classId ? 'Class' : '') : by === 'subject' ? (r.subject ?? '').trim() : r.courseName || (r.courseId ? 'Course' : ''));
  const map = new Map<string, WithId<T>[]>();
  for (const r of rows) { const k = key(r) || OTHERS; map.set(k, [...(map.get(k) ?? []), r]); }
  return [...map.entries()].map(([name, rs]) => ({ name, rows: rs })).sort((a, b) => (a.name === OTHERS ? 1 : b.name === OTHERS ? -1 : a.name.localeCompare(b.name)));
}

/** A learner or parent may only open published resources they have been given. Used for the Resources page query and tests. */
export const canLearnerOpen = (r: Pick<Resource, 'published' | 'viewerUids' | 'courseLinks'>, uid: string, enrolledCourses: string[] = []) =>
  r.published && ((r.viewerUids ?? []).includes(uid) || (r.courseLinks ?? []).slice(0, MAX_COURSE_LINKS).some((c) => enrolledCourses.includes(c)));
