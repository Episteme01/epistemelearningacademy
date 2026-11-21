import { describe, it, expect } from 'vitest';
import { liveDetail } from '@/lib/attendance';

describe('live attendance detail text', () => {
  it('is empty with no participation record', () => expect(liveDetail(undefined)).toBe(''));
  it('shows minutes and rejoins', () => expect(liveDetail({ totalSeconds: 1800, joinCount: 3 })).toBe('connected 30 min · joined 3 times'));
  it('marks someone still in the room', () => expect(liveDetail({ totalSeconds: 600, joinCount: 1, connected: true })).toBe('in the room now · connected 10 min'));
  it('says under 1 minute for a very short stay', () => expect(liveDetail({ totalSeconds: 20, joinCount: 1 })).toBe('connected under 1 min'));
  it('shows join and leave times in the class time zone', () => {
    const j = Date.UTC(2026, 10, 20, 9, 5); const l = Date.UTC(2026, 10, 20, 9, 50);
    expect(liveDetail({ totalSeconds: 2700, joinCount: 1, firstJoinMs: j, lastLeftMs: l }, 'UTC')).toBe('joined 9:05 AM · left 9:50 AM · connected 45 min');
    expect(liveDetail({ totalSeconds: 2700, joinCount: 1, firstJoinMs: j, lastLeftMs: l }, 'Africa/Lagos')).toBe('joined 10:05 AM · left 10:50 AM · connected 45 min');
  });
  it('while still connected it says so instead of a leave time', () => {
    const j = Date.UTC(2026, 10, 20, 9, 5);
    expect(liveDetail({ totalSeconds: 600, joinCount: 1, connected: true, firstJoinMs: j, lastLeftMs: j + 1000 }, 'UTC')).toBe('joined 9:05 AM · in the room now · connected 10 min');
  });
});
