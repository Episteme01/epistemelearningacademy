// Pure rules for what can be put in front of the class (no DOM, unit-tested in tests/liveSlides.test.ts).
import { MAX_SLIDES } from './protocol';

export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export type SourceKind = 'pdf' | 'image' | 'office' | 'other';

export function sourceKind(name: string, type = ''): SourceKind {
  const n = name.toLowerCase(); const t = type.toLowerCase();
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (/^image\/(jpeg|png|webp|gif)$/.test(t) || /\.(jpe?g|png|webp|gif)$/.test(n)) return 'image';
  if (/presentationml|ms-powerpoint|opendocument\.presentation/.test(t) || /\.(pptx?|ppsx?|pps|odp|key)$/.test(n)) return 'office';
  return 'other';
}

export const OFFICE_HELP = 'PowerPoint files cannot be shown directly. In PowerPoint choose File, then Export, then PDF (on a phone: Share or Save as, then PDF). Add that PDF here: every slide becomes a page.';
export const OTHER_HELP = 'Choose a PDF or a picture (JPG, PNG or WebP).';

export interface SlideSource { kind: 'image' | 'pdf'; pages: number; from: number; to: number }
/** Pages a source will contribute (a picture is one page). */
export const pagesOf = (s: SlideSource) => (s.kind === 'image' ? 1 : Math.max(0, s.to - s.from + 1));
export const pagesUsed = (list: SlideSource[]) => list.reduce((n, s) => n + pagesOf(s), 0);

/** Keeps a page range inside the document and inside what is left of the 30-page limit (`otherPages` = pages used by the other sources). */
export function clampRange(from: number, to: number, pages: number, otherPages: number, max = MAX_SLIDES): { from: number; to: number } {
  const int = (v: number, d: number) => (Number.isFinite(v) ? Math.trunc(v) : d);
  const f = Math.min(Math.max(int(from, 1), 1), Math.max(1, pages));
  let t = Math.min(Math.max(int(to, f), f), Math.max(1, pages));
  const allowed = Math.max(1, max - otherPages);
  if (t - f + 1 > allowed) t = f + allowed - 1;
  return { from: f, to: t };
}
/** First pages of a new PDF, as many as still fit. */
export const defaultRange = (pages: number, free: number) => ({ from: 1, to: Math.min(Math.max(1, pages), Math.max(1, free)) });
