import { describe, expect, it } from 'vitest';
import { primaryRole, hasPermission, hasRole, type SessionProfile } from './domain';

function profile(overrides: Partial<SessionProfile> = {}): SessionProfile {
  return {
    user_id: 'u1',
    email: 'a@b.com',
    full_name: 'Test User',
    status: 'ACTIVE',
    must_change_password: false,
    student_id: null,
    faculty_id: null,
    roles: [],
    permissions: [],
    ...overrides,
  };
}

describe('primaryRole', () => {
  it('returns null when no roles are assigned', () => {
    expect(primaryRole(profile())).toBeNull();
  });

  it('picks the lowest-rank (tightest-binding) role among several', () => {
    // rank: ADMIN 10, HOD 20, CLASS_INCHARGE 30, MENTOR 40, FACULTY 50, STUDENT 60
    const p = profile({
      roles: [
        { role: 'FACULTY', scope: 'ASSIGNED', department_id: null, section_id: null },
        { role: 'MENTOR', scope: 'ASSIGNED', department_id: null, section_id: null },
        { role: 'CLASS_INCHARGE', scope: 'SECTION', department_id: 'd1', section_id: 's1' },
      ],
    });
    expect(primaryRole(p)).toBe('CLASS_INCHARGE');
  });

  it('never lets a lower-privilege role shadow ADMIN', () => {
    const p = profile({
      roles: [
        { role: 'STUDENT', scope: 'SELF', department_id: null, section_id: null },
        { role: 'ADMIN', scope: 'GLOBAL', department_id: null, section_id: null },
      ],
    });
    expect(primaryRole(p)).toBe('ADMIN');
  });
});

describe('hasPermission', () => {
  it('is false for a null profile (signed out)', () => {
    expect(hasPermission(null, 'students.read')).toBe(false);
  });

  it('checks membership in the permissions array exactly', () => {
    const p = profile({ permissions: ['students.read', 'attendance.read'] });
    expect(hasPermission(p, 'students.read')).toBe(true);
    expect(hasPermission(p, 'students.write')).toBe(false);
  });
});

describe('hasRole', () => {
  it('is false for a null profile', () => {
    expect(hasRole(null, 'ADMIN')).toBe(false);
  });

  it('finds a role among several concurrent assignments', () => {
    const p = profile({
      roles: [
        { role: 'FACULTY', scope: 'ASSIGNED', department_id: null, section_id: null },
        { role: 'MENTOR', scope: 'ASSIGNED', department_id: null, section_id: null },
      ],
    });
    expect(hasRole(p, 'MENTOR')).toBe(true);
    expect(hasRole(p, 'HOD')).toBe(false);
  });
});
