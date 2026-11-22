import { describe, expect, it } from 'vitest';
import { ANNOTATE_W, MAX_OUT_HEIGHT, annotatedName, pageSize, stitchLayout } from '@/lib/annotate';

describe('worksheet sizing', () => {
  it('keeps pages 1200 wide and follows the picture shape', () => {
    expect(pageSize(1000, 1414)).toEqual({ w: ANNOTATE_W, h: 1697 });
    expect(pageSize(0, 0).w).toBe(ANNOTATE_W);
    expect(pageSize(100, 100000).h <= ANNOTATE_W * 3).toBe(true);
  });
  it('joins pages top to bottom without overlap and stays within the canvas limit', () => {
    const l = stitchLayout([{ w: 1200, h: 1700 }, { w: 1200, h: 1700 }]);
    expect(l.tops[0]).toBe(0); expect(l.tops[1]).toBe(l.heights[0]); expect(l.height).toBe(l.heights[0]! + l.heights[1]!);
    const big = stitchLayout(Array(8).fill({ w: 1200, h: 3600 }));
    expect(big.height <= MAX_OUT_HEIGHT + 8).toBe(true);
    expect(big.scale < 1).toBe(true);
  });
  it('names the saved picture safely', () => {
    expect(annotatedName('Maths Test (1).pdf', new Date(2026, 10, 22, 9, 5))).toBe('Maths_Test_1_-answers-0905.jpg');
  });
});
