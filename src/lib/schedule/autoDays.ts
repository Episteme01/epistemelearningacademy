// "Pick the class days once; the calendar fills in the rest." Pure helpers for the schedule form.
import { MAX_OCCURRENCES, generateDates, weekdayOf, type Recurrence } from './recurrence';

export interface TermLike { startDate: string; endDate: string; name?: string }

/** End date of the term that contains `startDate` (null when it falls outside every term). */
export function termEndFor(startDate: string, terms: TermLike[]): TermLike | null {
  return terms.filter((t) => t.startDate <= startDate && startDate <= t.endDate).sort((a, b) => a.endDate.localeCompare(b.endDate))[0] ?? null;
}

/** The recurrence that will really be saved: weekly classes on automatic end run to the end of the term. */
export function effectiveRecurrence(rec: Recurrence, auto: boolean, term: TermLike | null): Recurrence {
  if (rec.freq !== 'weekly' || !auto || !term) return rec;
  return { ...rec, end: { type: 'date', until: term.endDate } };
}

/** Days to pre-tick when the person switches to a weekly class: the weekday of the first class date. */
export const defaultWeekdays = (startDate: string): number[] => (startDate ? [weekdayOf(startDate)] : []);

export interface Plan { count: number; first: string; last: string; capped: boolean; dates: string[] }

/** What a save would create, for the "These sessions will be created" preview. */
export function planFor(startDate: string, rec: Recurrence): Plan {
  const dates = startDate ? generateDates(startDate, rec) : [];
  return { count: dates.length, first: dates[0] ?? '', last: dates[dates.length - 1] ?? '', capped: dates.length >= MAX_OCCURRENCES, dates };
}
