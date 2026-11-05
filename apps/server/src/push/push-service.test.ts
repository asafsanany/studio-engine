import { DEFAULT_PUSH_EVENTS, type Job, type PushEvents } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioDb } from '../db/database.js';
import { PushDeviceRepository } from '../db/push-device-repository.js';
import { memoryDb } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { makeJob } from '../events/test-utils.js';
import { PushSendError } from './push-sender.js';
import { createPushService, type PushService } from './push-service.js';
import { FAKE_KEYS, FakeSender } from './test-utils.js';

// The service on an in-memory database with a fake sender: no real push is ever sent. A job is
// "saved" by publishing it on the bus, like the worker does.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const PHONE = 'https://web.push.apple.com/phone';
const MAC = 'https://fcm.googleapis.com/mac';

function setup(
  initialJobs: Job[] = [],
  canSee?: (owner: string | null, clientId: string) => boolean,
) {
  const db = memoryDb();
  opened.push(db);
  const devices = new PushDeviceRepository(db);
  const sender = new FakeSender();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const bus = createEventBus();
  const jobs = { getAll: () => initialJobs };
  const push: PushService = createPushService({ devices, jobs, sender, logger, canSee });
  push.listen(bus);

  const register = (
    endpoint: string,
    events: Partial<PushEvents> = {},
    label = 'iPhone',
    owner?: string,
  ) => {
    const { device } = devices.register({ endpoint, ...FAKE_KEYS, label, owner });
    if (Object.keys(events).length > 0) devices.setEvents(device.id, events);
    return device;
  };
  const save = (job: Job) => bus.publish({ type: 'job.upsert', job });
  return { db, devices, sender, logger, bus, push, register, save };
}

const spring = { id: 'a1b2c3d4e5f6', name: 'Spring menu', client: 'Northwind Bakery' };

describe('Ready to review', () => {
  it('goes out when a job enters Review, to a device that has it on', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE);

    save(makeJob({ ...spring, state: 'editing' }));
    save(makeJob({ ...spring, state: 'review' }));
    await push.settled();

    expect(sender.to(PHONE)).toEqual([
      {
        title: 'Ready to review',
        body: 'Spring menu · Northwind Bakery',
        url: '/jobs?job=a1b2c3d4e5f6&review=1',
        tag: 'a1b2c3d4e5f6',
        badge: 1,
      },
    ]);
  });

  it('is not sent to a device that turned it off, while another still gets it', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE, { review: false });
    register(MAC, {}, 'Mac · Chrome');

    save(makeJob({ ...spring, state: 'review' }));
    await push.settled();

    expect(sender.to(PHONE)).toEqual([]);
    expect(sender.to(MAC)).toHaveLength(1);
  });

  it('is sent once for a job that is saved again in Review', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE);

    save(makeJob({ ...spring, state: 'editing' }));
    save(makeJob({ ...spring, state: 'review', preview: null }));
    save(makeJob({ ...spring, state: 'review', etaSec: 12 }));
    save(makeJob({ ...spring, state: 'review', note: 'fix the intro' }));
    await push.settled();

    expect(sender.sent).toHaveLength(1);
  });

  it('is sent again when the job comes back to Review after a round of notes', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE);

    save(makeJob({ ...spring, state: 'review', round: 0 }));
    save(makeJob({ ...spring, state: 'queued', round: 1, runKind: 'revise' }));
    save(makeJob({ ...spring, state: 'editing', round: 1, runKind: 'revise' }));
    save(makeJob({ ...spring, state: 'review', round: 1, runKind: 'revise' }));
    await push.settled();

    expect(sender.sent.map((push) => push.payload.title)).toEqual([
      'Ready to review',
      'Ready to review',
    ]);
  });

  it('is not sent when the owner takes an approved video back to Review (Unapprove)', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE);

    save(makeJob({ ...spring, state: 'review' }));
    save(makeJob({ ...spring, state: 'ready', runKind: 'render' }));
    save(makeJob({ ...spring, state: 'review' }));
    await push.settled();

    // Only the first entry into Review: the way back from ready is their own doing.
    expect(sender.sent.map((push) => push.payload.title)).toEqual([
      'Ready to review',
      'Approved · ready to send',
    ]);
  });

  it('is not sent for a job that was already in Review when the engine started', async () => {
    const waiting = makeJob({ ...spring, state: 'review' });
    const { push, register, save, sender } = setup([waiting]);
    register(PHONE);

    // What the boot's reconcile publishes for it.
    save({ ...waiting, updatedAt: '2026-10-22T09:00:00.000Z' });
    await push.settled();

    expect(sender.sent).toEqual([]);
  });
});

describe('Failed at <Step>', () => {
  it('names the step and opens the sheet', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE);

    save(makeJob({ ...spring, state: 'editing' }));
    save(
      makeJob({
        ...spring,
        state: 'failed',
        failedAt: 8,
        error: 'Claude Code stopped with exit code 1: boom',
      }),
    );
    await push.settled();

    expect(sender.to(PHONE)).toEqual([
      {
        title: 'Failed at Render',
        body: 'Spring menu · Northwind Bakery',
        url: '/jobs?job=a1b2c3d4e5f6',
        tag: 'a1b2c3d4e5f6',
        badge: 1,
      },
    ]);
  });

  it('says "Claude usage limit" and adds "retry once it resets" for the Claude usage limit', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE);

    save(
      makeJob({
        ...spring,
        state: 'failed',
        failedAt: 5,
        error: 'Claude usage limit reached. Retry once it resets. (hit your limit)',
      }),
    );
    await push.settled();

    expect(sender.to(PHONE)[0]).toMatchObject({
      title: 'Failed · Claude usage limit',
      body: 'Spring menu · Northwind Bakery · retry once it resets',
    });
  });

  it('is sent once per failure, and again after a retry fails again', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE);
    const failed = makeJob({ ...spring, state: 'failed', failedAt: 3, error: 'x' });

    save(failed);
    save({ ...failed, updatedAt: '2026-10-22T10:00:00.000Z' });
    expect(sender.sent).toHaveLength(1);

    save(makeJob({ ...spring, state: 'queued' }));
    save(makeJob({ ...spring, state: 'editing' }));
    save(failed);
    await push.settled();

    expect(sender.sent).toHaveLength(2);
  });

  it('respects the Failed switch', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE, { failed: false });

    save(makeJob({ ...spring, state: 'failed', failedAt: 3, error: 'x' }));
    await push.settled();

    expect(sender.sent).toEqual([]);
  });
});

describe('Approved · ready to send', () => {
  it('goes out when the render after Approve finishes, and opens the sheet', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE);

    save(makeJob({ ...spring, state: 'review' }));
    save(
      makeJob({
        ...spring,
        state: 'queued',
        runKind: 'render',
        approvedAt: '2026-10-22T10:00:00.000Z',
      }),
    );
    save(makeJob({ ...spring, state: 'editing', runKind: 'render', step: 8 }));
    expect(sender.sent.map((p) => p.payload.title)).toEqual(['Ready to review']);

    save(
      makeJob({
        ...spring,
        state: 'ready',
        runKind: 'render',
        step: 8,
        approvedAt: '2026-10-22T10:00:00.000Z',
      }),
    );
    await push.settled();

    expect(sender.to(PHONE).at(-1)).toEqual({
      title: 'Approved · ready to send',
      body: 'Spring menu · Northwind Bakery',
      url: '/jobs?job=a1b2c3d4e5f6',
      tag: 'a1b2c3d4e5f6',
      badge: 0,
    });
  });

  it('is sent once, whatever happens to the ready job afterwards (delivered, archived, saved again)', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE, { queueEmpty: false });
    const ready = makeJob({ ...spring, state: 'ready', runKind: 'render' });

    save(makeJob({ ...spring, state: 'editing', runKind: 'render' }));
    save(ready);
    save({
      ...ready,
      delivery: {
        deliveredAt: '2026-10-22T11:00:00.000Z',
        price: 40,
        currency: 'ILS',
        paidOn: null,
      },
    });
    save({ ...ready, archivedAt: '2026-10-22T12:00:00.000Z' });
    await push.settled();

    expect(sender.sent.map((p) => p.payload.title)).toEqual(['Approved · ready to send']);
  });

  it('is not sent for a job that is ready from an edit run (Review off): nothing was approved', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE);

    save(makeJob({ ...spring, state: 'editing', runKind: 'edit' }));
    save(makeJob({ ...spring, state: 'ready', runKind: 'edit' }));
    await push.settled();

    expect(sender.sent).toEqual([]);
  });

  it('respects the Approved switch', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE, { approved: false });

    save(makeJob({ ...spring, state: 'ready', runKind: 'render' }));
    await push.settled();

    expect(sender.sent).toEqual([]);
  });
});

describe('Queue is empty', () => {
  const job = (id: string, state: Job['state']) => makeJob({ id, name: id, state });

  it('goes out when the last arriving, queued or editing job is done, to a device that turned it on', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE, { queueEmpty: true, review: false });

    save(job('a', 'arriving'));
    save(job('a', 'queued'));
    save(job('b', 'queued'));
    save(job('a', 'editing'));
    save(job('a', 'review'));
    expect(sender.sent).toEqual([]);

    save(job('b', 'editing'));
    save(job('b', 'review'));
    await push.settled();

    expect(sender.to(PHONE)).toEqual([
      {
        title: 'Queue is empty',
        body: 'Everything you dropped in is done.',
        url: '/jobs',
        tag: 'queue-empty',
        badge: 2,
      },
    ]);
  });

  it('is off by default', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE);
    expect(DEFAULT_PUSH_EVENTS.queueEmpty).toBe(false);

    save(job('a', 'editing'));
    save(job('a', 'ready'));
    await push.settled();

    expect(sender.sent).toEqual([]);
  });

  it('is sent once per busy spell, not for every job that leaves the queue', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE, { queueEmpty: true });

    save(job('a', 'editing'));
    save(job('a', 'ready'));
    save({ ...job('a', 'ready'), note: 'x' });
    save(job('b', 'held'));
    await push.settled();
    expect(sender.sent).toHaveLength(1);

    save(job('c', 'queued'));
    save(job('c', 'editing'));
    save(job('c', 'failed'));
    await push.settled();
    expect(sender.sent.filter((p) => p.payload.tag === 'queue-empty')).toHaveLength(2);
  });

  it('does not count a held job as busy', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE, { queueEmpty: true });

    save(job('a', 'editing'));
    save(job('h', 'held'));
    save(job('a', 'ready'));
    await push.settled();

    expect(sender.sent.map((p) => p.payload.tag)).toEqual(['queue-empty']);
  });

  it('is not sent when the only busy job is removed: it was not done', async () => {
    const { push, register, save, sender, bus } = setup();
    register(PHONE, { queueEmpty: true });

    save(job('a', 'arriving'));
    bus.publish({ type: 'job.remove', id: 'a' });
    save(job('b', 'ready'));
    await push.settled();

    expect(sender.sent).toEqual([]);
  });

  it('knows the jobs that were busy before the first event', async () => {
    const { push, register, save, sender } = setup([job('a', 'editing')]);
    register(PHONE, { queueEmpty: true });

    save(job('a', 'ready'));
    await push.settled();

    expect(sender.sent.map((p) => p.payload.title)).toEqual(['Queue is empty']);
  });

  it('comes after the job ping that ended the queue', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE, { queueEmpty: true });

    save(job('a', 'editing'));
    save(job('a', 'review'));
    await push.settled();

    expect(sender.sent.map((p) => p.payload.title)).toEqual(['Ready to review', 'Queue is empty']);
  });
});

describe('the badge', () => {
  it('counts Review + Needs attention, for a device with Count on the app icon on', async () => {
    const { push, register, save, sender } = setup([
      makeJob({ id: 'x1', state: 'failed' }),
      makeJob({ id: 'x2', state: 'held' }),
      makeJob({ id: 'x3', state: 'review' }),
      makeJob({ id: 'x4', state: 'ready' }),
    ]);
    register(PHONE);
    register(MAC, { badge: false }, 'Mac · Chrome');

    save(makeJob({ ...spring, state: 'review' }));
    await push.settled();

    expect(sender.to(PHONE)[0]?.badge).toBe(4);
    expect(sender.to(MAC)).toHaveLength(1);
    expect(sender.to(MAC)[0]).not.toHaveProperty('badge');
  });

  it('follows the jobs that left: archived and removed ones do not count', async () => {
    const { push, register, save, sender, bus } = setup([
      makeJob({ id: 'x1', state: 'failed' }),
      makeJob({ id: 'x2', state: 'failed' }),
    ]);
    register(PHONE);

    save(makeJob({ id: 'x1', state: 'failed', archivedAt: '2026-10-22T10:00:00.000Z' }));
    bus.publish({ type: 'job.remove', id: 'x2' });
    save(makeJob({ ...spring, state: 'review' }));
    await push.settled();

    expect(sender.to(PHONE)[0]?.badge).toBe(1);
  });
});

describe('a push that does not go', () => {
  it('deletes the device on a 410, so it is not tried again', async () => {
    const { push, register, save, sender, devices, logger } = setup();
    const gone = register(PHONE);
    register(MAC, {}, 'Mac · Chrome');
    sender.failWith(PHONE, new PushSendError('gone', 410));

    save(makeJob({ ...spring, state: 'review' }));
    await push.settled();

    expect(devices.get(gone.id)).toBeNull();
    expect(devices.list()).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();

    save(makeJob({ ...spring, name: 'Other', id: 'ffff', state: 'review' }));
    await push.settled();
    expect(sender.to(PHONE)).toHaveLength(1);
    expect(sender.to(MAC)).toHaveLength(2);
  });

  it('deletes the device on a 404 too', async () => {
    const { push, register, save, sender, devices } = setup();
    const gone = register(PHONE);
    sender.failWith(PHONE, new PushSendError('missing', 404));

    save(makeJob({ ...spring, state: 'review' }));
    await push.settled();

    expect(devices.get(gone.id)).toBeNull();
  });

  it('keeps the device on any other error and logs it without the endpoint', async () => {
    const { push, register, save, sender, devices, logger } = setup();
    const flaky = register(PHONE);
    sender.failWith(PHONE, new PushSendError('The push service answered 500.', 500));

    save(makeJob({ ...spring, state: 'review' }));
    await push.settled();

    expect(devices.get(flaky.id)).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields] = logger.warn.mock.calls[0] ?? [];
    expect(fields).toEqual({ deviceId: flaky.id, statusCode: 500, code: null });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('apple.com');
  });

  it('keeps the device when the push service never answered (a network error)', async () => {
    const { push, register, save, sender, devices, logger } = setup();
    const flaky = register(PHONE);
    sender.failWith(PHONE, new PushSendError('could not be sent', null, 'ECONNRESET'));

    save(makeJob({ ...spring, state: 'review' }));
    await push.settled();

    expect(devices.get(flaky.id)).not.toBeNull();
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ statusCode: null, code: 'ECONNRESET' });
  });

  it('keeps going to the other devices when one fails', async () => {
    const { push, register, save, sender } = setup();
    register(PHONE);
    register(MAC, {}, 'Mac · Chrome');
    sender.failWith(PHONE, new PushSendError('boom', 500));

    save(makeJob({ ...spring, state: 'review' }));
    await push.settled();

    expect(sender.to(MAC)).toHaveLength(1);
  });

  it('notes the time of a push that went through', async () => {
    const { push, register, save, devices } = setup();
    const phone = register(PHONE);
    expect(devices.get(phone.id)?.lastOkAt).toBeNull();

    save(makeJob({ ...spring, state: 'review' }));
    await push.settled();

    expect(devices.get(phone.id)?.lastOkAt).not.toBeNull();
  });
});

describe('with no devices', () => {
  it('sends nothing and does not mind', async () => {
    const { push, save, sender } = setup();

    save(makeJob({ ...spring, state: 'review' }));
    await push.settled();

    expect(sender.sent).toEqual([]);
  });

  it('survives a broken database: the bus is never disturbed', async () => {
    const { push, register, save, db, logger } = setup();
    register(PHONE);
    db.sqlite.close();

    expect(() => save(makeJob({ ...spring, state: 'review' }))).not.toThrow();
    await push.settled();

    expect(logger.error).toHaveBeenCalled();
  });
});

describe('sendTest', () => {
  it('sends "Test from Studio Engine" whatever the switches say', async () => {
    const { push, register, sender } = setup([makeJob({ state: 'review' })]);
    register(PHONE, { review: false, failed: false, approved: false, queueEmpty: false });

    expect(await push.sendTest(register(PHONE).id)).toBe('sent');

    expect(sender.to(PHONE)).toEqual([
      {
        title: 'Test from Studio Engine',
        body: 'Notifications are working on this phone.',
        url: '/jobs',
        tag: 'test',
        badge: 1,
      },
    ]);
  });

  it('answers missing for an unknown device, gone (and deletes it) on a 410, failed otherwise', async () => {
    const { push, register, sender, devices } = setup();
    const phone = register(PHONE);
    const mac = register(MAC, {}, 'Mac · Chrome');

    expect(await push.sendTest('nope')).toBe('missing');

    sender.failWith(PHONE, new PushSendError('gone', 410));
    expect(await push.sendTest(phone.id)).toBe('gone');
    expect(devices.get(phone.id)).toBeNull();

    sender.failWith(MAC, new PushSendError('boom', 502));
    expect(await push.sendTest(mac.id)).toBe('failed');
    expect(devices.get(mac.id)).not.toBeNull();
  });
});

describe('listen', () => {
  it('stops listening when told to', async () => {
    const db = memoryDb();
    opened.push(db);
    const devices = new PushDeviceRepository(db);
    const sender = new FakeSender();
    const bus = createEventBus();
    const push = createPushService({ devices, jobs: { getAll: () => [] }, sender });
    devices.register({ endpoint: PHONE, ...FAKE_KEYS, label: 'iPhone' });

    const stop = push.listen(bus);
    bus.publish({ type: 'job.upsert', job: makeJob({ ...spring, state: 'review' }) });
    stop();
    bus.publish({ type: 'job.upsert', job: makeJob({ id: 'zzzz', name: 'Z', state: 'review' }) });
    await push.settled();

    expect(sender.sent).toHaveLength(1);
    expect(bus.listenerCount()).toBe(0);
  });
});

describe('whose pushes (Team plan, TM2)', () => {
  const YAEL = 'yael@example.com';
  const YAEL_PHONE = 'https://web.push.apple.com/yael';
  const OWN = 'client-yael';
  const ELSEWHERE = 'client-amit';
  // Yael sees her client; a device with no owner (before the team) and the owner's see everything.
  const canSee = (owner: string | null, clientId: string) =>
    owner === null || owner === 'local' || clientId === OWN;
  const job = (id: string, clientId: string, state: Job['state']) =>
    makeJob({ id, name: id, clientId, state });

  it('go to a device only for the clients its owner sees; an ownerless device (from before the team) gets all', async () => {
    const { push, register, save, sender } = setup([], canSee);
    register(YAEL_PHONE, {}, 'iPhone', YAEL);
    register(PHONE); // registered before the team existed: no owner
    register(MAC, {}, 'Mac', 'local');

    save(job('a', ELSEWHERE, 'review'));
    save(job('b', OWN, 'review'));
    await push.settled();

    expect(sender.to(YAEL_PHONE).map((payload) => payload.tag)).toEqual(['b']);
    expect(sender.to(PHONE).map((payload) => payload.tag)).toEqual(['a', 'b']);
    expect(sender.to(MAC).map((payload) => payload.tag)).toEqual(['a', 'b']);
  });

  it('count only the jobs its owner sees in the badge', async () => {
    const { push, register, save, sender } = setup(
      [job('x1', ELSEWHERE, 'failed'), job('x2', ELSEWHERE, 'review'), job('x3', OWN, 'held')],
      canSee,
    );
    register(YAEL_PHONE, {}, 'iPhone', YAEL);
    register(PHONE);

    save(job('b', OWN, 'review'));
    await push.settled();

    expect(sender.to(YAEL_PHONE)[0]?.badge).toBe(2);
    expect(sender.to(PHONE)[0]?.badge).toBe(4);
  });

  it('say the queue is empty when the owner’s last busy job is done, whatever the others do', async () => {
    const { push, register, save, sender } = setup([], canSee);
    register(YAEL_PHONE, { queueEmpty: true, review: false }, 'iPhone', YAEL);
    register(PHONE, { queueEmpty: true, review: false });

    save(job('mine', OWN, 'editing'));
    save(job('theirs', ELSEWHERE, 'editing'));
    save(job('mine', OWN, 'review'));
    await push.settled();
    // Yael's queue is empty; the other client's job is still busy for the admin's phone.
    expect(sender.to(YAEL_PHONE).map((payload) => payload.title)).toEqual(['Queue is empty']);
    expect(sender.to(PHONE)).toEqual([]);

    save(job('theirs', ELSEWHERE, 'review'));
    await push.settled();
    expect(sender.to(YAEL_PHONE)).toHaveLength(1); // nothing of the other client moved her queue
    expect(sender.to(PHONE).map((payload) => payload.title)).toEqual(['Queue is empty']);
  });

  it('send the test push to the device whatever its owner sees', async () => {
    const { push, register, sender } = setup([], canSee);
    const device = register(YAEL_PHONE, {}, 'iPhone', YAEL);
    expect(await push.sendTest(device.id)).toBe('sent');
    expect(sender.to(YAEL_PHONE)).toHaveLength(1);
  });
});
