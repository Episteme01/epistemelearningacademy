// Pure sizing rules for writing on worksheets (pictures and PDF pages). No DOM here so they can be tested.

export const ANNOTATE_W = 1200;            // pen coordinates are in a canvas this wide; the height follows the page shape
export const MAX_ANNOTATE_PAGES = 8;       // phones and iPads run out of canvas memory beyond this
export const OUT_WIDTH = 1000;             // width of the finished picture
export const MAX_OUT_HEIGHT = 11000;       // stays under the canvas limit of iPads

/** Work canvas size for one page: always ANNOTATE_W wide, height follows the picture (never absurdly tall or flat). */
export function pageSize(w: number, h: number): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: ANNOTATE_W, h: Math.round(ANNOTATE_W * 1.414) };
  const ratio = Math.min(3, Math.max(0.25, h / w));
  return { w: ANNOTATE_W, h: Math.round(ANNOTATE_W * ratio) };
}

/** Where each page goes when all pages are joined top to bottom into one picture. Pages are scaled down together if too tall. */
export function stitchLayout(pages: { w: number; h: number }[]): { width: number; height: number; tops: number[]; heights: number[]; scale: number } {
  const raw = pages.map((p) => Math.round((OUT_WIDTH * p.h) / p.w));
  const total = raw.reduce((a, b) => a + b, 0);
  const scale = total > MAX_OUT_HEIGHT ? MAX_OUT_HEIGHT / total : 1;
  const width = Math.max(1, Math.round(OUT_WIDTH * scale));
  const heights = raw.map((h) => Math.max(1, Math.round(h * scale)));
  const tops: number[] = []; let y = 0;
  for (const h of heights) { tops.push(y); y += h; }
  return { width, height: Math.max(1, y), tops, heights, scale };
}

export const annotatedName = (name: string, now = new Date()) => {
  const base = name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'worksheet';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${base}-answers-${p(now.getHours())}${p(now.getMinutes())}.jpg`;
};
