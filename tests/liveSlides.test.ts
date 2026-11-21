import { describe, expect, it } from 'vitest';
import { MAX_SLIDES } from '@/lib/live/protocol';
import { clampRange, defaultRange, pagesOf, pagesUsed, sourceKind } from '@/lib/live/slideSources';

describe('what can be shown', () => {
  it('recognises PDFs and pictures by type or by name', () => {
    expect(sourceKind('Lesson 1.PDF')).toBe('pdf');
    expect(sourceKind('x', 'application/pdf')).toBe('pdf');
    expect(sourceKind('photo.JPG')).toBe('image');
    expect(sourceKind('x', 'image/webp')).toBe('image');
  });
  it('recognises PowerPoint so the teacher is told to export it', () => {
    expect(sourceKind('deck.pptx')).toBe('office');
    expect(sourceKind('deck.ppt')).toBe('office');
    expect(sourceKind('x', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('office');
    expect(sourceKind('x', 'application/vnd.ms-powerpoint')).toBe('office');
  });
  it('rejects everything else', () => { expect(sourceKind('notes.docx')).toBe('other'); expect(sourceKind('clip.mp4', 'video/mp4')).toBe('other'); expect(sourceKind('x.svg', 'image/svg+xml')).toBe('other'); });
});

describe('page ranges and the 30-page limit', () => {
  it('counts a picture as one page and a PDF range as its length', () => {
    expect(pagesOf({ kind: 'image', pages: 1, from: 1, to: 1 })).toBe(1);
    expect(pagesUsed([{ kind: 'image', pages: 1, from: 1, to: 1 }, { kind: 'pdf', pages: 40, from: 3, to: 7 }])).toBe(6);
  });
  it('keeps a range inside the document', () => {
    expect(clampRange(0, 99, 10, 0)).toEqual({ from: 1, to: 10 });
    expect(clampRange(5, 2, 10, 0)).toEqual({ from: 5, to: 5 });
    expect(clampRange(NaN, NaN, 10, 0)).toEqual({ from: 1, to: 1 });
    expect(clampRange(3.9, 6.2, 10, 0)).toEqual({ from: 3, to: 6 });
  });
  it('keeps the total within the limit', () => {
    expect(clampRange(1, 40, 80, 0)).toEqual({ from: 1, to: MAX_SLIDES });
    expect(clampRange(1, 40, 80, 25)).toEqual({ from: 1, to: 5 });
    expect(clampRange(10, 40, 80, 25)).toEqual({ from: 10, to: 14 });
  });
  it('a new PDF starts with as many pages as still fit', () => {
    expect(defaultRange(8, 30)).toEqual({ from: 1, to: 8 });
    expect(defaultRange(80, 30)).toEqual({ from: 1, to: 30 });
    expect(defaultRange(80, 12)).toEqual({ from: 1, to: 12 });
    expect(defaultRange(80, 0)).toEqual({ from: 1, to: 1 });
  });
});
