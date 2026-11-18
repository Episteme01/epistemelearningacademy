import { describe, expect, it } from 'vitest';
import { MAX_COURSE_LINKS, OTHERS, canLearnerOpen, groupResources, sameList, viewersFor, withCourseLink } from '@/lib/resourceAccess';
import { defaultWeekdays, effectiveRecurrence, planFor, termEndFor } from '@/lib/schedule/autoDays';
import { defaultRecurrence } from '@/lib/schedule/recurrence';
import { SELAR_URL } from '@/config/links';

describe('who can open a resource', () => {
  const work = [
    { resourceIds: ['r1', 'r2'], studentUids: ['s1', 's2'], parentViewers: ['p1'] },
    { resourceIds: ['r2'], studentUids: ['s3'], parentViewers: ['p3'] },
    { resourceIds: [], studentUids: ['s9'], parentViewers: ['p9'] },
  ];
  it('collects learners and parents of only the work that uses it', () => {
    expect(viewersFor('r1', work)).toEqual(['p1', 's1', 's2']);
    expect(viewersFor('r2', work)).toEqual(['p1', 'p3', 's1', 's2', 's3']);
  });
  it('is empty when no work uses it, so learners cannot see it', () => {
    expect(viewersFor('r7', work)).toEqual([]);
    expect(viewersFor('r1', [])).toEqual([]);
  });
  it('removing the resource from the work removes access', () => {
    expect(viewersFor('r1', [{ resourceIds: [], studentUids: ['s1'], parentViewers: [] }])).toEqual([]);
  });
  it('compares lists without caring about order', () => { expect(sameList(['a', 'b'], ['b', 'a'])).toBe(true); expect(sameList(['a'], ['a', 'b'])).toBe(false); expect(sameList(undefined, [])).toBe(true); });
  it('learner rule: published AND given access', () => {
    expect(canLearnerOpen({ published: true, viewerUids: ['s1'] }, 's1')).toBe(true);
    expect(canLearnerOpen({ published: true, viewerUids: ['s1'] }, 's2')).toBe(false);
    expect(canLearnerOpen({ published: false, viewerUids: ['s1'] }, 's1')).toBe(false);
    expect(canLearnerOpen({ published: true }, 's1')).toBe(false);
    expect(canLearnerOpen({ published: true, courseLinks: ['c1'] }, 's1', ['c1'])).toBe(true);
    expect(canLearnerOpen({ published: true, courseLinks: ['c1'] }, 's1', ['c2'])).toBe(false);
  });
  it('course links are unique and capped at 3', () => {
    let l: string[] = [];
    for (const c of ['a', 'a', 'b', 'c', 'd']) l = withCourseLink(l, c);
    expect(l).toEqual(['a', 'b', 'c']); expect(l.length).toBe(MAX_COURSE_LINKS);
    expect(withCourseLink(l, '')).toBe(l);
  });
});

describe('resource groups', () => {
  const r = (id: string, o: object = {}) => ({ id, title: id, classId: '', className: '', subject: '', courseId: '', courseName: '', ...o }) as never;
  const rows = [r('1', { className: 'Nursery 2', classId: 'n2' }), r('2', { subject: 'Maths' }), r('3', { subject: 'English', className: 'Nursery 2', classId: 'n2' }), r('4'), r('5', { courseName: 'Qur’an', courseId: 'q' })];
  it('groups by class, with Others last', () => {
    const g = groupResources(rows, 'class');
    expect(g.map((x) => x.name)).toEqual(['Nursery 2', OTHERS]);
    expect(g[0]!.rows.length).toBe(2); expect(g[1]!.rows.length).toBe(3);
  });
  it('groups by subject and by course', () => {
    expect(groupResources(rows, 'subject').map((x) => x.name)).toEqual(['English', 'Maths', OTHERS]);
    expect(groupResources(rows, 'course').map((x) => x.name)).toEqual(['Qur’an', OTHERS]);
  });
  it('never loses a resource', () => { expect(groupResources(rows, 'subject').reduce((n, g) => n + g.rows.length, 0)).toBe(5); });
});

describe('class days fill the calendar automatically', () => {
  const terms = [{ name: 'Term 1', startDate: '2026-09-14', endDate: '2026-12-11' }, { name: 'Term 2', startDate: '2027-01-11', endDate: '2027-04-02' }];
  const weekly = (days: number[]) => ({ ...defaultRecurrence(), freq: 'weekly' as const, weekdays: days });
  it('finds the term the first class falls in', () => {
    expect(termEndFor('2026-11-23', terms)?.endDate).toBe('2026-12-11');
    expect(termEndFor('2026-12-20', terms)).toBeNull();
  });
  it('Mon, Wed, Sat, Sun from Mon 23 Nov 2026 runs to the end of term', () => {
    const eff = effectiveRecurrence(weekly([1, 3, 6, 0]), true, termEndFor('2026-11-23', terms));
    const p = planFor('2026-11-23', eff);
    expect(p.dates.slice(0, 5)).toEqual(['2026-11-23', '2026-11-25', '2026-11-28', '2026-11-29', '2026-11-30']);
    expect(p.last <= '2026-12-11').toBe(true);
    expect(p.dates.every((d) => [1, 3, 6, 0].includes(new Date(d + 'T00:00:00Z').getUTCDay()))).toBe(true);
    expect(p.count).toBe(10); expect(p.last).toBe('2026-12-09');
  });
  it('a first date that is not a chosen day starts on the next chosen day', () => {
    const p = planFor('2026-11-24', effectiveRecurrence(weekly([1, 3]), true, termEndFor('2026-11-24', terms)));
    expect(p.first).toBe('2026-11-25');
  });
  it('without a term, or with auto off, the chosen count or date is used', () => {
    const r = weekly([1]);
    expect(effectiveRecurrence(r, true, null)).toBe(r);
    expect(effectiveRecurrence(r, false, terms[0]!)).toBe(r);
    expect(planFor('2026-11-23', r).count).toBe(10);
  });
  it('non-weekly repeats ignore the term', () => { const d = { ...defaultRecurrence(), freq: 'daily' as const }; expect(effectiveRecurrence(d, true, terms[0]!)).toBe(d); });
  it('pre-ticks the weekday of the first class', () => { expect(defaultWeekdays('2026-11-23')).toEqual([1]); expect(defaultWeekdays('')).toEqual([]); });
});

describe('Selar store link', () => {
  it('is the official https store link', () => { expect(SELAR_URL).toBe('https://selar.com/m/epistemelearningacademy'); });
});
