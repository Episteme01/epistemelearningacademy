// Keeps a timetable audience in step when a learner changes class (pure, so it can be tested).
// Sessions store a snapshot of who they are for (studentUids, parentUids). Without this, a learner who moves from
// Nursery 1 to Nursery 2 would keep getting Nursery 1's class notices and reminders, and miss Nursery 2's.

export interface AudienceLike { studentUids: string[]; parentUids: string[] }
export interface Learner { id: string; uid: string; parentUids: string[] }

const uniq = (a: string[]) => [...new Set(a.filter(Boolean))];

/** Takes the learner out. A parent is removed only when none of the remaining learners is also their child. */
export function withoutLearner<T extends AudienceLike>(a: T, child: Learner, parentsOf: (uid: string) => string[]): T {
  const studentUids = a.studentUids.filter((u) => u !== child.uid);
  const stillNeeded = new Set(studentUids.flatMap(parentsOf));
  const drop = new Set(child.parentUids.filter((p) => !stillNeeded.has(p)));
  return { ...a, studentUids, parentUids: a.parentUids.filter((p) => !drop.has(p)) };
}

/** Puts the learner (and their own parents) in. */
export function withLearner<T extends AudienceLike>(a: T, child: Learner): T {
  return { ...a, studentUids: uniq([...a.studentUids, child.uid]), parentUids: uniq([...a.parentUids, ...child.parentUids]) };
}

export const hasLearner = (a: AudienceLike, uid: string) => a.studentUids.includes(uid);
