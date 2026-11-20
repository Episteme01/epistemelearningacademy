import { describe, it, expect } from 'vitest';
import { liveDetail } from '@/lib/attendance';

describe('live attendance detail text', () => {
  it('is empty with no participation record', () => expect(liveDetail(undefined)).toBe(''));
  it('shows minutes and rejoins', () => expect(liveDetail({ totalSeconds: 1800, joinCount: 3 })).toBe('connected 30 min · joined 3 times'));
  it('marks someone still in the room', () => expect(liveDetail({ totalSeconds: 600, joinCount: 1, connected: true })).toBe('in the room now · connected 10 min'));
  it('says under 1 minute for a very short stay', () => expect(liveDetail({ totalSeconds: 20, joinCount: 1 })).toBe('connected under 1 min'));
});
