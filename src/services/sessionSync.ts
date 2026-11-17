import { where } from 'firebase/firestore';
import { C } from '@/config/collections';
import { batchSet, listDocs } from '@/services/db';
import { viewersOf } from '@/services/schedule';
import { hasLearner, withLearner, withoutLearner } from '@/lib/schedule/audienceSync';
import { toDate } from '@/lib/utils';
import type { Session, Student, TimetableSeries, WithId } from '@/types/models';

/**
 * When a learner changes class (or leaves), bring the UPCOMING timetable in line, so the learner and their parents
 * get the new class's notices and stop getting the old class's. Past sessions and attendance history are never touched.
 * Needs an admin or principal login (those are the people who can edit every session). Never throws: returns whether it worked.
 */
export async function syncLearnerClass(student: WithId<Student>, fromClassId: string | undefined, toClassId: string | undefined): Promise<boolean> {
  const uid = student.studentUid;
  if (!uid) return true;                                   // no login yet, so nobody to notify
  if ((fromClassId ?? '') === (toClassId ?? '')) return true;
  try {
    const child = { id: student.id, uid, parentUids: student.parentUids ?? [] };
    const everyone = await listDocs<Student>(C.students, []);
    const byUid = new Map(everyone.filter((s) => s.studentUid).map((s) => [String(s.studentUid), s.parentUids ?? []]));
    const parentsOf = (u: string) => byUid.get(u) ?? [];
    const now = Date.now();
    const ops: { col: string; id: string; data: object; merge: boolean }[] = [];

    if (fromClassId) {
      const [sessions, series] = await Promise.all([listDocs<Session>(C.sessions, [where('classId', '==', fromClassId)]), listDocs<TimetableSeries>(C.timetableSeries, [where('classId', '==', fromClassId)])]);
      for (const s of sessions) {
        if (s.status !== 'scheduled' || (toDate(s.startAt)?.getTime() ?? 0) <= now || !hasLearner(s, uid)) continue;
        const a = withoutLearner(s, child, parentsOf);
        ops.push({ col: C.sessions, id: s.id, merge: true, data: { studentUids: a.studentUids, parentUids: a.parentUids, viewers: viewersOf(s.teacherUid, a.studentUids, a.parentUids) } });
      }
      for (const r of series) {
        if (r.status !== 'active' || !hasLearner(r, uid)) continue;
        const a = withoutLearner(r, child, parentsOf);
        ops.push({ col: C.timetableSeries, id: r.id, merge: true, data: { studentUids: a.studentUids, parentUids: a.parentUids, studentIds: (r.studentIds ?? []).filter((x) => x !== student.id), viewers: viewersOf(r.teacherUid, a.studentUids, a.parentUids) } });
      }
    }
    if (toClassId && student.status === 'active') {
      const [sessions, series] = await Promise.all([listDocs<Session>(C.sessions, [where('classId', '==', toClassId)]), listDocs<TimetableSeries>(C.timetableSeries, [where('classId', '==', toClassId)])]);
      const skip = new Set(series.filter((r) => (r.excludedStudentIds ?? []).includes(student.id)).map((r) => r.id));   // left out on purpose by the teacher
      for (const s of sessions) {
        if (s.status !== 'scheduled' || (toDate(s.startAt)?.getTime() ?? 0) <= now || skip.has(s.seriesId) || hasLearner(s, uid)) continue;
        const a = withLearner(s, child);
        ops.push({ col: C.sessions, id: s.id, merge: true, data: { studentUids: a.studentUids, parentUids: a.parentUids, viewers: viewersOf(s.teacherUid, a.studentUids, a.parentUids) } });
      }
      for (const r of series) {
        if (r.status !== 'active' || skip.has(r.id) || hasLearner(r, uid)) continue;
        const a = withLearner(r, child);
        ops.push({ col: C.timetableSeries, id: r.id, merge: true, data: { studentUids: a.studentUids, parentUids: a.parentUids, studentIds: [...new Set([...(r.studentIds ?? []), student.id])], viewers: viewersOf(r.teacherUid, a.studentUids, a.parentUids) } });
      }
    }
    if (ops.length) await batchSet(ops);
    return true;
  } catch (e) { console.warn('timetable sync failed', e); return false; }
}

export interface RepairReport { sessions: number; removed: number; added: number }

/**
 * One-off clean-up for audiences that were already out of date: for every upcoming class that belongs to a class (e.g. Nursery 2),
 * learners whose CURRENT class is different are taken out, and current class members who are missing (and were not left out on purpose) are put in.
 * Classes that are not tied to a class (individual or mixed groups) are not touched.
 */
export async function repairTimetableAudiences(): Promise<RepairReport> {
  const now = Date.now();
  const [students, sessions, series] = await Promise.all([listDocs<Student>(C.students, []), listDocs<Session>(C.sessions, [where('status', '==', 'scheduled')]), listDocs<TimetableSeries>(C.timetableSeries, [])]);
  const byUid = new Map(students.filter((s) => s.studentUid).map((s) => [String(s.studentUid), s]));
  const parentsOf = (u: string) => byUid.get(u)?.parentUids ?? [];
  const excluded = new Map(series.map((r) => [r.id, new Set(r.excludedStudentIds ?? [])]));
  const ops: { col: string; id: string; data: object; merge: boolean }[] = [];
  const rep: RepairReport = { sessions: 0, removed: 0, added: 0 };
  for (const s of sessions) {
    if (!s.classId || (toDate(s.startAt)?.getTime() ?? 0) <= now) continue;
    let a = { studentUids: s.studentUids ?? [], parentUids: s.parentUids ?? [] };
    let changed = false;
    for (const u of a.studentUids) {
      const st = byUid.get(u);
      if (st && st.classId !== s.classId) { a = withoutLearner(a, { id: st.id, uid: u, parentUids: st.parentUids ?? [] }, parentsOf); rep.removed += 1; changed = true; }
    }
    for (const st of students) {
      if (st.status !== 'active' || !st.studentUid || st.classId !== s.classId || hasLearner(a, st.studentUid) || excluded.get(s.seriesId)?.has(st.id)) continue;
      a = withLearner(a, { id: st.id, uid: st.studentUid, parentUids: st.parentUids ?? [] }); rep.added += 1; changed = true;
    }
    if (!changed) continue;
    rep.sessions += 1;
    ops.push({ col: C.sessions, id: s.id, merge: true, data: { studentUids: a.studentUids, parentUids: a.parentUids, viewers: viewersOf(s.teacherUid, a.studentUids, a.parentUids) } });
  }
  if (ops.length) await batchSet(ops);
  return rep;
}
