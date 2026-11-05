import { DEFAULT_PUSH_EVENTS, PUSH_EVENT_KEYS, type PushDevice } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  DENIED_TEXT,
  DEVICE_ERROR_TEXT,
  notificationsSection,
  PUSH_EVENT_ROWS,
  UNSUPPORTED_TEXT,
} from './notifications-view';

const DEVICE: PushDevice = {
  id: 'd1',
  label: 'iPhone',
  events: { ...DEFAULT_PUSH_EVENTS },
  createdAt: '2026-10-22T10:00:00.000Z',
  lastOkAt: null,
};

type Input = Parameters<typeof notificationsSection>[0];
const section = (over: Partial<Input> = {}) =>
  notificationsSection({
    support: 'supported',
    permission: 'granted',
    deviceId: 'd1',
    device: DEVICE,
    ...over,
  });

describe('PUSH_EVENT_ROWS (board MSettings)', () => {
  it('has a row for each of the engine’s switches, in its order', () => {
    expect(PUSH_EVENT_ROWS.map((row) => row.key)).toEqual([...PUSH_EVENT_KEYS]);
  });

  it('names them as the board does', () => {
    expect(PUSH_EVENT_ROWS.map((row) => [row.label, row.description])).toEqual([
      ['Ready to review', 'An edit is waiting for your notes'],
      ['Failed', 'A job stopped with an error, a Claude usage limit too'],
      ['Approved · ready to send', 'The final video is rendered after you approve'],
      ['Queue is empty', 'Everything you dropped in is done'],
      ['Count on the app icon', 'Jobs in Review or needing attention'],
    ]);
  });
});

describe('notificationsSection', () => {
  it('is on, with a switch per event as the engine has them and “Send a test”', () => {
    const view = section({
      device: { ...DEVICE, events: { ...DEFAULT_PUSH_EVENTS, failed: false, queueEmpty: true } },
    });
    expect(view).toMatchObject({ kind: 'on', on: true, error: null });
    if (view.kind !== 'on') throw new Error('not on');
    expect(view.rows.map((row) => [row.key, row.checked])).toEqual([
      ['review', true],
      ['failed', false],
      ['approved', true],
      ['queueEmpty', true],
      ['badge', true],
    ]);
    expect(view.test).toEqual({ label: 'Send a test', busy: false, error: null });
  });

  it('turns the test button into “Sending…”, then “Test sent to this phone”, or says why it failed', () => {
    const label = (test: Input['test']) => {
      const view = section({ test });
      return view.kind === 'on' ? view.test : null;
    };
    expect(label({ kind: 'sending' })).toEqual({ label: 'Sending…', busy: true, error: null });
    expect(label({ kind: 'sent' })).toEqual({
      label: 'Test sent to this phone',
      busy: false,
      error: null,
    });
    expect(label({ kind: 'failed', message: 'The push service did not take the test.' })).toEqual({
      label: 'Send a test',
      busy: false,
      error: 'The push service did not take the test.',
    });
  });

  it('carries a switch that did not save', () => {
    expect(section({ error: 'Couldn’t save that.' })).toMatchObject({
      kind: 'on',
      error: 'Couldn’t save that.',
    });
  });

  it('offers Turn on before notifications are on, and once the engine no longer has this phone', () => {
    expect(section({ permission: 'default', deviceId: null, device: undefined })).toEqual({
      kind: 'turn-on',
      on: false,
      working: false,
      error: null,
    });
    expect(section({ deviceId: null, device: undefined })).toMatchObject({ kind: 'turn-on' });
    expect(section({ device: null })).toMatchObject({ kind: 'turn-on' });
    // The permission was taken back in iOS Settings: asking again is the way back.
    expect(section({ permission: 'default' })).toMatchObject({ kind: 'turn-on' });
    expect(
      section({ deviceId: null, device: undefined, turnOn: { working: true, error: null } }),
    ).toMatchObject({ kind: 'turn-on', working: true });
    expect(
      section({ deviceId: null, device: undefined, turnOn: { working: false, error: 'No.' } }),
    ).toMatchObject({ kind: 'turn-on', error: 'No.' });
  });

  it('waits for the engine’s switches, and says so when they can’t be read', () => {
    expect(section({ device: undefined })).toEqual({ kind: 'loading', on: true });
    expect(section({ device: undefined, deviceFailed: true })).toEqual({
      kind: 'error',
      on: true,
      text: DEVICE_ERROR_TEXT,
    });
  });

  it('after a refusal, says how to allow notifications in iOS Settings', () => {
    expect(section({ permission: 'denied' })).toEqual({
      kind: 'denied',
      on: false,
      text: DENIED_TEXT,
    });
    expect(DENIED_TEXT).toContain('Settings');
  });

  it('is hidden in a browser tab, and says what is missing on an old iOS', () => {
    expect(section({ support: 'browser' })).toEqual({ kind: 'hidden' });
    expect(section({ support: 'unsupported' })).toEqual({
      kind: 'unsupported',
      on: false,
      text: UNSUPPORTED_TEXT,
    });
  });
});
