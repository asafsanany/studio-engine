import { describe, expect, it } from 'vitest';
import { FALLBACK_VAPID_SUBJECT, resolveVapidSubject, vapidSubjectOf } from './vapid-subject.js';

describe('vapidSubjectOf', () => {
  it('turns an email into a mailto: address and keeps mailto: and https ones', () => {
    expect(vapidSubjectOf('owner@example.com')).toBe('mailto:owner@example.com');
    expect(vapidSubjectOf(' mailto:owner@example.com ')).toBe('mailto:owner@example.com');
    expect(vapidSubjectOf('MAILTO:owner@example.com')).toBe('mailto:owner@example.com');
    expect(vapidSubjectOf('https://studio.example.com/contact')).toBe(
      'https://studio.example.com/contact',
    );
  });

  it('is null for anything else', () => {
    for (const value of [
      undefined,
      null,
      '',
      '  ',
      'owner',
      'http://studio.example.com',
      'a b@c.d',
    ]) {
      expect(vapidSubjectOf(value)).toBeNull();
    }
  });
});

describe('resolveVapidSubject', () => {
  it('prefers the configured subject, then the Mac owner login, then a placeholder', () => {
    expect(resolveVapidSubject('mailto:cfg@example.com', 'owner@example.com')).toBe(
      'mailto:cfg@example.com',
    );
    expect(resolveVapidSubject(undefined, 'owner@example.com')).toBe('mailto:owner@example.com');
    expect(resolveVapidSubject(undefined, 'tagged-devices')).toBe(FALLBACK_VAPID_SUBJECT);
    expect(resolveVapidSubject(undefined, undefined)).toBe(FALLBACK_VAPID_SUBJECT);
  });
});
