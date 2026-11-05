import { DEFAULT_PUSH_EVENTS } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import {
  PushDeviceOwnedError,
  PushDeviceRepository,
  toPushDevice,
} from './push-device-repository.js';
import { fakeClock, memoryDb, T0 } from './test-utils.js';

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup() {
  const db = memoryDb();
  opened.push(db);
  const clock = fakeClock();
  return { db, clock, devices: new PushDeviceRepository(db, { clock }) };
}

const PHONE = {
  endpoint: 'https://web.push.apple.com/phone',
  p256dh: 'p256dh-phone',
  auth: 'auth-phone',
  label: 'iPhone',
};

describe('PushDeviceRepository.register', () => {
  it('stores a new device with the default switches', () => {
    const { devices } = setup();

    const { device, created } = devices.register(PHONE);

    expect(created).toBe(true);
    expect(device).toMatchObject({ ...PHONE, events: DEFAULT_PUSH_EVENTS, lastOkAt: null });
    expect(device.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(device.createdAt).toBe(Date.parse(T0));
    expect(devices.get(device.id)).toEqual(device);
  });

  it('upserts by endpoint: the same id and switches, new keys and label', () => {
    const { devices, clock } = setup();
    const first = devices.register(PHONE).device;
    devices.setEvents(first.id, { queueEmpty: true, review: false });
    clock.tick();

    const again = devices.register({
      ...PHONE,
      p256dh: 'new-p256dh',
      auth: 'new-auth',
      label: 'iPad',
    });

    expect(again.created).toBe(false);
    expect(again.device).toMatchObject({
      id: first.id,
      p256dh: 'new-p256dh',
      auth: 'new-auth',
      label: 'iPad',
      createdAt: first.createdAt,
      events: { ...DEFAULT_PUSH_EVENTS, queueEmpty: true, review: false },
    });
    expect(devices.list()).toHaveLength(1);
  });

  it('keeps two endpoints apart', () => {
    const { devices, clock } = setup();
    const a = devices.register(PHONE).device;
    clock.tick();
    const b = devices.register({ ...PHONE, endpoint: 'https://fcm.googleapis.com/other' }).device;

    expect(a.id).not.toBe(b.id);
    expect(devices.list().map((d) => d.id)).toEqual([a.id, b.id]);
  });
});

describe('PushDeviceRepository.setEvents', () => {
  it('changes the switches named and keeps the others', () => {
    const { devices } = setup();
    const { id } = devices.register(PHONE).device;

    const changed = devices.setEvents(id, { queueEmpty: true, badge: false });

    expect(changed?.events).toEqual({
      review: true,
      failed: true,
      approved: true,
      queueEmpty: true,
      badge: false,
    });
    expect(devices.get(id)?.events).toEqual(changed?.events);
    expect(devices.setEvents(id, { review: undefined })?.events).toEqual(changed?.events);
  });

  it('answers null for an unknown device', () => {
    expect(setup().devices.setEvents('nope', { review: false })).toBeNull();
  });

  it('reads a column edited into nonsense as the default switches', () => {
    const { devices, db } = setup();
    const { id } = devices.register(PHONE).device;
    db.sqlite.prepare('update push_devices set events = \'{"review":1}\' where id = ?').run(id);

    expect(devices.get(id)?.events).toEqual(DEFAULT_PUSH_EVENTS);
  });
});

describe('PushDeviceRepository.markOk and remove', () => {
  it('notes when a push last went through', () => {
    const { devices, clock } = setup();
    const { id } = devices.register(PHONE).device;
    clock.tick(5_000);

    devices.markOk(id);

    expect(devices.get(id)?.lastOkAt).toBe(Date.parse(T0) + 5_000);
  });

  it('deletes a device, once', () => {
    const { devices } = setup();
    const { id } = devices.register(PHONE).device;

    expect(devices.remove(id)).toBe(true);
    expect(devices.remove(id)).toBe(false);
    expect(devices.get(id)).toBeNull();
    expect(devices.list()).toEqual([]);
  });

  it('lets the same endpoint register again as a new device', () => {
    const { devices } = setup();
    const first = devices.register(PHONE).device;
    devices.remove(first.id);

    const second = devices.register(PHONE);

    expect(second.created).toBe(true);
    expect(second.device.id).not.toBe(first.id);
  });
});

describe('the table', () => {
  it('gives a row that does not say its switches the default ones (the column default)', () => {
    const { db, devices } = setup();
    db.sqlite
      .prepare(
        "insert into push_devices (id, endpoint, p256dh, auth, label, created_at) values ('x', 'https://e', 'k', 'a', 'Device', 1)",
      )
      .run();

    expect(devices.get('x')?.events).toEqual(DEFAULT_PUSH_EVENTS);
  });

  it('refuses a second row with the same endpoint', () => {
    const { db, devices } = setup();
    devices.register(PHONE);

    expect(() =>
      db.sqlite
        .prepare(
          "insert into push_devices (id, endpoint, p256dh, auth, label, created_at) values ('y', ?, 'k', 'a', 'Device', 1)",
        )
        .run(PHONE.endpoint),
    ).toThrow(/UNIQUE/);
  });
});

describe('toPushDevice', () => {
  it('leaves the subscription out and writes the times as ISO strings', () => {
    const { devices, clock } = setup();
    const { id } = devices.register(PHONE).device;
    clock.tick(1_000);
    devices.markOk(id);

    const wire = toPushDevice(devices.get(id) ?? (undefined as never));

    expect(wire).toEqual({
      id,
      label: 'iPhone',
      events: DEFAULT_PUSH_EVENTS,
      createdAt: '2026-10-20T10:00:00.000Z',
      lastOkAt: '2026-10-20T10:00:01.000Z',
    });
    expect(JSON.stringify(wire)).not.toContain('push.apple.com');
    expect(JSON.stringify(wire)).not.toContain('p256dh');
  });
});

describe('PushDeviceRepository.register: whose device it is (Team plan, TM2)', () => {
  const YAEL = { owner: 'yael@example.com', admin: false };
  const OWNER = { owner: 'local', admin: true };

  it('stores no owner for a device registered without one, and the owner it is given', () => {
    const { devices } = setup();
    expect(devices.register(PHONE).device.owner).toBeNull();
    const other = { ...PHONE, endpoint: 'https://web.push.apple.com/other', ...YAEL };
    expect(devices.register(other).device.owner).toBe('yael@example.com');
    expect(devices.get(devices.register(other).device.id)?.owner).toBe('yael@example.com');
  });

  it('lets the owner register again, keeping the device', () => {
    const { devices } = setup();
    const first = devices.register({ ...PHONE, ...YAEL }).device;
    const again = devices.register({ ...PHONE, label: 'iPad', ...YAEL });
    expect(again.created).toBe(false);
    expect(again.device).toMatchObject({ id: first.id, label: 'iPad', owner: YAEL.owner });
  });

  it('refuses anyone else but an admin, and leaves the device as it was', () => {
    const { devices } = setup();
    const first = devices.register({ ...PHONE, ...OWNER }).device;
    const stranger = { ...PHONE, p256dh: 'hijack', owner: 'amit@example.com', admin: false };
    expect(() => devices.register(stranger)).toThrow(PushDeviceOwnedError);
    expect(devices.get(first.id)).toEqual(first);
    // A device from before the team (no owner) is the admin's: an editor cannot take it either.
    const old = devices.register({ ...PHONE, endpoint: 'https://old.example/x' }).device;
    expect(() =>
      devices.register({ ...PHONE, endpoint: 'https://old.example/x', ...YAEL }),
    ).toThrow(PushDeviceOwnedError);
    expect(devices.get(old.id)).toEqual(old);
  });

  it('lets an admin take a device over, an old one included', () => {
    const { devices } = setup();
    const old = devices.register(PHONE).device;
    expect(devices.register({ ...PHONE, ...OWNER }).device).toMatchObject({
      id: old.id,
      owner: 'local',
    });
    const yaels = devices.register({ ...PHONE, endpoint: 'https://x.example/n', ...YAEL }).device;
    expect(
      devices.register({ ...PHONE, endpoint: 'https://x.example/n', ...OWNER }).device.id,
    ).toBe(yaels.id);
  });
});
