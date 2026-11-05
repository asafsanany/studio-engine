import { describe, expect, it } from 'vitest';
import { notifyCardWanted } from './notify-card';
import type { Permission, PushSupport } from './push-browser';
import type { NotifyCardMemory } from './push-store';

const wanted = (
  over: Partial<{
    support: PushSupport;
    permission: Permission;
    hasDevice: boolean;
    memory: NotifyCardMemory;
  }> = {},
) =>
  notifyCardWanted({
    support: 'supported',
    permission: 'default',
    hasDevice: false,
    memory: null,
    ...over,
  });

describe('notifyCardWanted (board MTurnOn)', () => {
  it('shows on a first open of the Home Screen app, before anything was asked', () => {
    expect(wanted()).toBe(true);
  });

  it('shows when notifications are allowed but this phone is not registered with the engine', () => {
    expect(wanted({ permission: 'granted', hasDevice: false })).toBe(true);
  });

  it('is gone once notifications are on', () => {
    expect(wanted({ permission: 'granted', hasDevice: true })).toBe(false);
  });

  it('asks again when the permission was taken back, even with a device', () => {
    expect(wanted({ permission: 'default', hasDevice: true })).toBe(true);
  });

  it('never comes back after “Not now”, or after it told how to allow notifications', () => {
    expect(wanted({ memory: 'dismissed' })).toBe(false);
    expect(wanted({ memory: 'told' })).toBe(false);
  });

  it('does not bring up a refusal made before: Settings says how to change it', () => {
    expect(wanted({ permission: 'denied' })).toBe(false);
  });

  it('is only in the Home Screen app with web push: not in a browser tab, not on old iOS', () => {
    expect(wanted({ support: 'browser' })).toBe(false);
    expect(wanted({ support: 'unsupported' })).toBe(false);
  });
});
