import { where } from 'firebase/firestore';
import { C } from '@/config/collections';
import { getById, listDocs } from '@/services/db';

export interface Audience { studentUids: string[]; parentViewers: string[] }

interface StudentLite { studentUid?: string; parentUids?: string[]; status?: string }
interface EnrolLite { uid?: string; parentUids?: string[] }

/**
 * Works out who an assignment is for, so reminders reach the right learners and
 * security rules can let their parents read it. Stored on the assignment when it is saved.
 * A learner or parent linked later is picked up with "Refresh audience".
 */
export async function resolveAudience(a: { classId?: string; courseId?: string; studentId?: string }): Promise<Audience> {
  const students = new Set<string>(); const parents = new Set<string>();
  if (a.studentId) {
    // one learner only: the class and course are ignored
    const s = await getById<StudentLite>(C.students, a.studentId);
    if (!s?.studentUid) throw new Error('This learner has no login yet, so work cannot be given to them alone. Create their login first.');
    return { studentUids: [s.studentUid], parentViewers: (s.parentUids ?? []).slice(0, 500) };
  }
  if (a.classId) {
    const rows = await listDocs<StudentLite>(C.students, [where('classId', '==', a.classId)]);
    for (const s of rows) {
      if (s.status === 'withdrawn' || s.status === 'graduated') continue;
      if (s.studentUid) students.add(s.studentUid);
      (s.parentUids ?? []).forEach((p) => parents.add(p));
    }
  }
  if (a.courseId) {
    const rows = await listDocs<EnrolLite>(C.courseEnrollments, [where('courseId', '==', a.courseId)]);
    for (const e of rows) {
      if (e.uid) students.add(e.uid);
      (e.parentUids ?? []).forEach((p) => parents.add(p));
    }
  }
  return { studentUids: [...students].slice(0, 500), parentViewers: [...parents].slice(0, 500) };
}
