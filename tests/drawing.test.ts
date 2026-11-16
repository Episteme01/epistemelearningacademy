import { describe, expect, it } from 'vitest';
import { MAX_STROKES, PAD_H, PAD_W, emptyPad, extend, guideLines, packDraft, padReducer, unpackDraft, drawingFileName, type Stroke } from '@/lib/drawing';
import { MAX_ATTACHMENTS, fileSizeLabel, withAttachment, withoutAttachment } from '@/lib/assignmentFiles';

const stroke = (n = 1): Stroke => ({ tool: 'pen', color: '#111111', size: 4, pts: [n, n, n + 5, n + 5] });

describe('pad undo / redo', () => {
  it('adds, undoes and redoes strokes', () => {
    let s = padReducer(emptyPad(), { type: 'add', stroke: stroke(1) });
    s = padReducer(s, { type: 'add', stroke: stroke(2) });
    expect(s.strokes.length).toBe(2);
    s = padReducer(s, { type: 'undo' });
    expect(s.strokes.length).toBe(1); expect(s.redo.length).toBe(1);
    s = padReducer(s, { type: 'redo' });
    expect(s.strokes.length).toBe(2); expect(s.redo.length).toBe(0);
  });
  it('a new stroke after undo drops the redo list', () => {
    let s = padReducer(emptyPad(), { type: 'add', stroke: stroke(1) });
    s = padReducer(s, { type: 'undo' });
    s = padReducer(s, { type: 'add', stroke: stroke(3) });
    expect(s.redo.length).toBe(0);
  });
  it('undo / redo on empty lists change nothing; clear empties both', () => {
    const e = emptyPad();
    expect(padReducer(e, { type: 'undo' })).toBe(e);
    expect(padReducer(e, { type: 'redo' })).toBe(e);
    const s = padReducer(padReducer(e, { type: 'add', stroke: stroke() }), { type: 'clear' });
    expect(s.strokes.length).toBe(0); expect(s.redo.length).toBe(0);
  });
  it('keeps at most MAX_STROKES', () => {
    let s = emptyPad();
    for (let i = 0; i < MAX_STROKES + 5; i++) s = padReducer(s, { type: 'add', stroke: stroke(i) });
    expect(s.strokes.length).toBe(MAX_STROKES);
  });
  it('ignores a stroke with no points', () => {
    const e = emptyPad();
    expect(padReducer(e, { type: 'add', stroke: { ...stroke(), pts: [] } })).toBe(e);
  });
});

describe('extending a stroke', () => {
  it('skips points that barely moved, keeps others', () => {
    const s = stroke(10);
    expect(extend(s, 15.3, 15.3)).toBe(s);
    expect(extend(s, 40, 40).pts.length).toBe(6);
  });
  it('shapes keep only a start and the current end', () => {
    const r: Stroke = { tool: 'rect', color: '#111111', size: 4, pts: [10, 10, 10, 10] };
    expect(extend(extend(r, 50, 60), 80, 90).pts).toEqual([10, 10, 80, 90]);
  });
});

describe('paper', () => {
  it('guide lines stay inside the page', () => {
    for (const p of ['plain', 'lined', 'grid', 'dots', 'handwriting'] as const) {
      const g = guideLines(p);
      expect(g.ys.every((y) => y > 0 && y < PAD_H)).toBe(true);
      expect(g.xs.every((x) => x > 0 && x < PAD_W)).toBe(true);
    }
    expect(guideLines('plain').ys.length).toBe(0);
    expect(guideLines('lined').ys.length > 10).toBe(true);
  });
  it('handwriting paper has three solid lines and one dashed middle line per band', () => {
    const g = guideLines('handwriting');
    expect(g.ys.length).toBe(g.mid.length * 3);
  });
});

describe('local draft', () => {
  it('round-trips', () => {
    const packed = packDraft([stroke(1), { ...stroke(2), tool: 'eraser' }])!;
    const back = unpackDraft(packed);
    expect(back.length).toBe(2); expect(back[1]!.tool).toBe('eraser'); expect(back[0]!.pts).toEqual([1, 1, 6, 6]);
  });
  it('rejects damaged or hostile drafts without throwing', () => {
    expect(unpackDraft(null)).toEqual([]);
    expect(unpackDraft('not json')).toEqual([]);
    expect(unpackDraft('{"a":1}')).toEqual([]);
    expect(unpackDraft(JSON.stringify([['pen', 'url(x)', 4, [1, 2]]]))).toEqual([]);          // bad colour
    expect(unpackDraft(JSON.stringify([['laser', '#111111', 4, [1, 2]]]))).toEqual([]);       // unknown tool
    expect(unpackDraft(JSON.stringify([['pen', '#111111', 4, [1, 2, 3]]]))).toEqual([]);      // odd number of coordinates
    expect(unpackDraft(JSON.stringify([['pen', '#111111', 9999, [1, 2]]]))).toEqual([]);      // absurd size
  });
  it('file name is a dated png', () => { expect(drawingFileName(new Date(2026, 10, 16, 9, 5))).toBe('drawing-20261116-0905.png'); });
});

describe('assignment attachments', () => {
  const f = (n: string) => ({ provider: 'supabase' as const, bucket: 'resources', path: `assignments/u1/${n}`, name: n });
  it('adds, de-duplicates, caps and removes', () => {
    let l = withAttachment([], f('a.pdf'));
    expect(withAttachment(l, f('a.pdf')).length).toBe(1);
    for (let i = 0; i < 10; i++) l = withAttachment(l, f(`x${i}.pdf`));
    expect(l.length).toBe(MAX_ATTACHMENTS);
    expect(withoutAttachment(l, 0).length).toBe(MAX_ATTACHMENTS - 1);
    expect(withoutAttachment(l, 0)[0]!.name).toBe('x0.pdf');
  });
  it('size labels', () => { expect(fileSizeLabel(500)).toBe('1 KB'); expect(fileSizeLabel(2048)).toBe('2 KB'); expect(fileSizeLabel(3 * 1024 * 1024)).toBe('3.0 MB'); });
});
