import { describe, expect, it } from 'vitest';
import {
  JOIN_AFTER_MS, JOIN_BEFORE_MS, LIVE_PROVIDER, applyEvent, attendanceId, canModerate, closeAt, decideAccess, displayName, emptyParticipation,
  finalStatus, grantFor, identityFor, newRoomName, participationId, permissionForApi, roleIn, timingFrom, validId, validIdentity, type SessionFacts,
} from '../supabase/functions/live/policy';
import { timingFrom as clientTiming } from '@/lib/attendance';

const MIN = 60_000;
const START = Date.UTC(2026, 10, 20, 9, 0);
const END = START + 45 * MIN;
const session = (o: Partial<SessionFacts> = {}): SessionFacts => ({
  id: 'ser1_1', teacherUid: 'T1', studentUids: ['S1', 'S2'], startMs: START, endMs: END, status: 'scheduled', provider: LIVE_PROVIDER, online: true, ...o,
});
const ask = (uid: string, roles: string[], o: Partial<SessionFacts> = {}, nowMs = START) => decideAccess({ uid, roles, session: session(o), nowMs });

describe('who may enter a live lesson', () => {
  it('the lesson’s own teacher hosts; another teacher is refused', () => {
    expect(ask('T1', ['teacher'])).toEqual({ ok: true, as: 'host' });
    expect(ask('T2', ['teacher'])).toMatchObject({ ok: false, code: 'not_invited' });
  });
  it('admin, super admin and principal can host any lesson', () => {
    for (const r of ['admin', 'super_admin', 'principal']) expect(ask('X', [r])).toEqual({ ok: true, as: 'host' });
  });
  it('a listed learner joins as learner; an unlisted learner is refused', () => {
    expect(ask('S1', ['student'])).toEqual({ ok: true, as: 'learner' });
    expect(ask('S9', ['student'])).toMatchObject({ ok: false, code: 'not_invited' });
  });
  it('parents and directors get no access, even if they are in the audience', () => {
    expect(ask('P1', ['parent'], { studentUids: ['S1', 'P1'] })).toMatchObject({ ok: false, code: 'not_invited' });
    expect(ask('D1', ['director'])).toMatchObject({ ok: false, code: 'not_invited' });
  });
  it('a student role alone does not make someone a host, and role claims are only ever read from the server', () => {
    expect(roleIn('S1', ['student'], session())).toBe('learner');
    expect(roleIn('S1', ['student', 'teacher'], session())).toBe('learner');   // teacher of a different lesson
    expect(roleIn('T1', ['teacher', 'student'], session({ studentUids: ['T1'] }))).toBe('host');
  });
  it('only ELA Live lessons that are online', () => {
    expect(ask('S1', ['student'], { provider: 'zoom' })).toMatchObject({ ok: false, code: 'not_live_session' });
    expect(ask('S1', ['student'], { online: false })).toMatchObject({ ok: false, code: 'not_live_session' });
  });
  it('cancelled and completed lessons are closed', () => {
    expect(ask('S1', ['student'], { status: 'cancelled' })).toMatchObject({ ok: false, code: 'session_closed' });
    expect(ask('S1', ['student'], { status: 'completed' })).toMatchObject({ ok: false, code: 'session_closed' });
  });
  it('join window: opens 15 min before the start, closes 30 min after the end', () => {
    expect(ask('S1', ['student'], {}, START - JOIN_BEFORE_MS - 1)).toMatchObject({ ok: false, code: 'too_early' });
    expect(ask('S1', ['student'], {}, START - JOIN_BEFORE_MS).ok).toBe(true);
    expect(ask('S1', ['student'], {}, END + JOIN_AFTER_MS).ok).toBe(true);
    expect(ask('S1', ['student'], {}, END + JOIN_AFTER_MS + 1)).toMatchObject({ ok: false, code: 'too_late' });
  });
  it('who may moderate whom', () => {
    expect(canModerate('host', 'learner')).toBe(true);
    expect(canModerate('host', 'host')).toBe(false);
    expect(canModerate('learner', 'learner')).toBe(false);
  });
});

describe('LiveKit grants are least-privilege', () => {
  it('nobody gets room admin / create / record on a browser token', () => {
    for (const as of ['host', 'learner'] as const) {
      const g = grantFor('ela-room', as);
      expect(g).toMatchObject({ room: 'ela-room', roomJoin: true, roomAdmin: false, roomCreate: false, roomList: false, roomRecord: false, hidden: false, recorder: false });
    }
  });
  it('learner: camera + microphone only by default; hosts may share the screen', () => {
    expect(grantFor('r', 'learner').canPublishSources).toEqual(['camera', 'microphone']);
    expect(grantFor('r', 'host').canPublishSources).toContain('screen_share');
  });
  it('screen share for a learner only when the teacher allowed it', () => {
    expect(grantFor('r', 'learner', { screenShare: true }).canPublishSources).toEqual(['camera', 'microphone', 'screen_share', 'screen_share_audio']);
  });
  it('a learner the teacher silenced cannot publish media, and chat can be switched off', () => {
    const g = grantFor('r', 'learner', { publish: false, data: false });
    expect(g.canPublish).toBe(false); expect(g.canPublishSources).toEqual([]); expect(g.canPublishData).toBe(false);
  });
  it('hosts always keep data messaging', () => { expect(grantFor('r', 'host', { data: false }).canPublishData).toBe(true); });
  it('server-API permission uses LiveKit enum names', () => {
    expect(permissionForApi('learner', { screenShare: true }).canPublishSources).toEqual(['CAMERA', 'MICROPHONE', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO']);
  });
});

describe('names and identities', () => {
  it('learners show as first name + initial; hosts show in full', () => {
    expect(displayName('Aisha Bello', 'learner')).toBe('Aisha B.');
    expect(displayName('  aisha   olamide   bello ', 'learner')).toBe('aisha B.');
    expect(displayName('Chidi', 'learner')).toBe('Chidi');
    expect(displayName('Mrs Folake Adeyemi', 'host')).toBe('Mrs Folake Adeyemi');
  });
  it('never reveals an email or phone number, and strips markup characters', () => {
    expect(displayName('aisha@example.com', 'learner')).toBe('Learner');
    expect(displayName('08012345678', 'host')).toBe('Teacher');
    expect(displayName('<b>Ada</b> Obi', 'learner')).toBe('bAda/b O.');
    expect(displayName('', 'learner')).toBe('Learner');
  });
  it('identities are opaque, stable within a lesson, different across lessons and people', async () => {
    const a = await identityFor('ser1_1', 'S1', 'secret-one'); const again = await identityFor('ser1_1', 'S1', 'secret-one');
    expect(a).toBe(again); expect(a).toMatch(/^[a-f0-9]{24}$/); expect(validIdentity(a)).toBe(true);
    expect(await identityFor('ser1_2', 'S1', 'secret-one')).not.toBe(a);
    expect(await identityFor('ser1_1', 'S2', 'secret-one')).not.toBe(a);
    expect(await identityFor('ser1_1', 'S1', 'secret-two')).not.toBe(a);
    expect(a).not.toContain('S1');
  });
  it('room names are random and reveal nothing', () => {
    const a = newRoomName(); const b = newRoomName();
    expect(a).not.toBe(b); expect(a).toMatch(/^ela-[a-f0-9]{32}$/);
  });
  it('id helpers', () => {
    expect(participationId('ser1_1', 'abc')).toBe('ser1_1_abc'); expect(attendanceId('ser1_1', 'S1')).toBe('ser1_1_S1');
    expect(validId('ser1_1')).toBe(true); expect(validId('../x')).toBe(false); expect(validId('a')).toBe(false); expect(validId(5)).toBe(false);
    expect(validIdentity('ABC')).toBe(false);
  });
});

describe('timing matches the existing attendance rules', () => {
  it('same answer as src/lib/attendance.ts', () => {
    for (const offset of [-20, -1, 0, 3, 5, 6, 30]) {
      for (const grace of [0, 5, 10]) expect(timingFrom(START + offset * MIN, START, grace)).toBe(clientTiming(START + offset * MIN, START, grace));
    }
  });
});

describe('verified participation', () => {
  const j = (atMs: number) => ({ type: 'joined' as const, atMs });
  const l = (atMs: number) => ({ type: 'left' as const, atMs });
  const run = (...e: { type: 'joined' | 'left'; atMs: number }[]) => e.reduce(applyEvent, emptyParticipation());

  it('one visit', () => {
    const p = run(j(START + 2 * MIN), l(START + 32 * MIN));
    expect(p).toMatchObject({ firstJoinMs: START + 2 * MIN, lastLeftMs: START + 32 * MIN, openSinceMs: null, totalSeconds: 30 * 60, joinCount: 1, reconnects: 0 });
  });
  it('a reconnection adds the connected time and counts one reconnect', () => {
    const p = run(j(START), l(START + 10 * MIN), j(START + 12 * MIN), l(START + 40 * MIN));
    expect(p.totalSeconds).toBe(38 * 60); expect(p.joinCount).toBe(2); expect(p.reconnects).toBe(1); expect(p.firstJoinMs).toBe(START);
  });
  it('a lost "left" never over-counts: the new join restarts the interval', () => {
    const p = run(j(START), j(START + 20 * MIN), l(START + 30 * MIN));
    expect(p.totalSeconds).toBe(10 * 60); expect(p.reconnects).toBe(1);
  });
  it('a "left" that arrives before its "joined" still pairs up correctly', () => {
    const p = run(l(START + 30 * MIN), j(START + 5 * MIN));
    expect(p.totalSeconds).toBe(25 * 60); expect(p.openSinceMs).toBeNull(); expect(p.firstJoinMs).toBe(START + 5 * MIN);
  });
  it('a stray "left" with no join credits nothing', () => {
    const p = run(l(START + 5 * MIN));
    expect(p.totalSeconds).toBe(0); expect(p.firstJoinMs).toBeNull();
  });
  it('closing a still-open connection at the end of the lesson', () => {
    const open = run(j(START + 5 * MIN));
    const closed = closeAt(open, END);
    expect(closed.totalSeconds).toBe(40 * 60); expect(closed.openSinceMs).toBeNull(); expect(closed.lastLeftMs).toBe(END);
    expect(closeAt(closed, END + 99 * MIN)).toEqual(closed);          // idempotent
  });
  it('left early = connected for less than half the scheduled lesson', () => {
    expect(finalStatus(22 * 60, START, END)).toBe('left_early');
    expect(finalStatus(23 * 60, START, END)).toBe('present');
    expect(finalStatus(45 * 60, START, END)).toBe('present');
    expect(finalStatus(0, START, END)).toBe('left_early');
  });
});
