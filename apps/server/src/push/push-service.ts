// Sends the web pushes (Mobile plan §6, PH11). It listens to the event bus and, when a job
// changes, pushes to every device that has that event switched on:
//
//   a job enters Review                       -> "Ready to review"
//   a job fails                               -> "Failed at <Step>"; a usage limit: "Failed · Claude usage limit", "… · retry once it resets"
//   the render after Approve finishes        -> "Approved · ready to send"
//   the queue goes from busy to idle          -> "Queue is empty"
//
// "Once per change": a job is pushed when it ENTERS a state, never because it was saved again in
// it. The service remembers the last state of every job it saw (seeded from the database when it
// starts listening, so what the boot reconciles is not news), and the queue is busy while a job is
// arriving, queued or editing. A device with Count on the app icon on gets the count of Review +
// Needs attention in `badge`.
//
// Whose pushes (Team plan, TM2): a device has an owner (the login that registered it) and gets a
// push only about jobs of clients its owner may see; the badge counts only those jobs, and "Queue
// is empty" follows the jobs the owner sees. A device with no owner (registered before the team
// existed) is the owner's, the admin's, and gets everything.
//
// A push that does not go is never a reason to stop the engine: a 404 or 410 from the push service
// means the phone dropped its subscription, so the device is deleted; any other failure is logged
// (its status and code, never the endpoint) and the device stays.

import {
  type Job,
  PUSH_TEST_TITLE,
  PUSH_URLS,
  type PushNotifyKey,
  type PushPayload,
  type ServerEvent,
} from '@studio/shared';
import type { JobRepository, PushDeviceRepository, StoredPushDevice } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { badgeCount, pingFor } from './push-messages.js';
import { isGone, PushSendError, type PushSender } from './push-sender.js';

export interface PushLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const SILENT: PushLogger = { warn() {}, error() {} };

export interface PushServiceOptions {
  devices: Pick<PushDeviceRepository, 'list' | 'get' | 'remove' | 'markOk'>;
  /** Read once, when the service starts listening: the jobs as they were before the first event. */
  jobs: Pick<JobRepository, 'getAll'>;
  sender: PushSender;
  logger?: PushLogger;
  /**
   * Whether a device's owner may see a client's jobs (`owner` is null for a device from before the
   * team, which is the admin's). Default: everyone sees everything.
   */
  canSee?: (owner: string | null, clientId: string) => boolean;
}

/** How a push to one device ended. `gone`: the phone dropped its subscription, so the device was deleted. */
export type PushOutcome = 'sent' | 'gone' | 'failed';

/** What `sendTest` answers; `missing` is a device id that is not registered. */
export type TestOutcome = PushOutcome | 'missing';

export interface PushService {
  /** Starts listening to `bus`. Returns the function that stops it. */
  listen(bus: EventBus): () => void;
  /** Takes one event as the bus would hand it over. */
  handle(event: ServerEvent): void;
  /** Sends the test push (`Test from Studio Engine`) to one device, whatever its switches say. */
  sendTest(deviceId: string): Promise<TestOutcome>;
  /** Resolves once every push started so far has ended (for tests and for shutdown). */
  settled(): Promise<void>;
}

/** Whether a job holds the queue: the engine has work to do or is doing it. */
function isBusy(job: Pick<Job, 'state'>): boolean {
  return job.state === 'arriving' || job.state === 'queued' || job.state === 'editing';
}

export function createPushService(options: PushServiceOptions): PushService {
  const { devices, jobs, sender, logger = SILENT } = options;
  const mayRead = (device: StoredPushDevice, job: Pick<Job, 'clientId'>): boolean =>
    options.canSee?.(device.owner, job.clientId) ?? true;

  // The last thing the bus said about every job.
  const known = new Map<string, Job>();
  const inFlight = new Set<Promise<unknown>>();

  function track<T>(work: Promise<T>): Promise<T> {
    inFlight.add(work);
    const forget = (): void => {
      inFlight.delete(work);
    };
    work.then(forget, forget);
    return work;
  }

  /** Sends to one device; deletes it when its subscription is gone, logs any other failure. */
  function deliver(device: StoredPushDevice, payload: PushPayload): Promise<PushOutcome> {
    return track(
      (async (): Promise<PushOutcome> => {
        try {
          await sender.send(device, payload);
        } catch (err) {
          if (isGone(err)) {
            try {
              devices.remove(device.id);
            } catch (removeError) {
              logger.error({ err: removeError, deviceId: device.id }, 'could not forget a device');
            }
            return 'gone';
          }
          logger.warn(
            {
              deviceId: device.id,
              statusCode: err instanceof PushSendError ? err.statusCode : null,
              code: err instanceof PushSendError ? err.code : null,
            },
            'a push was not delivered',
          );
          return 'failed';
        }
        try {
          devices.markOk(device.id);
        } catch (err) {
          logger.error({ err, deviceId: device.id }, 'could not note that a push went through');
        }
        return 'sent';
      })(),
    );
  }

  /** The payload for one device: the badge only when the device asked for it. */
  function forDevice(
    device: StoredPushDevice,
    ping: Omit<PushPayload, 'badge'>,
    badge: number,
  ): PushPayload {
    return device.events.badge ? { ...ping, badge } : ping;
  }

  /** The count on the icon of one device: only the jobs its owner may see. */
  const badgeFor = (device: StoredPushDevice): number =>
    badgeCount([...known.values()].filter((job) => mayRead(device, job)));

  /** Whether a job the device's owner may see is busy, leaving `except` out. */
  const busyFor = (device: StoredPushDevice, except: string): boolean =>
    [...known.values()].some((job) => job.id !== except && isBusy(job) && mayRead(device, job));

  /** Pings about one job go to the devices that have the event on and whose owner sees the job. */
  function dispatch(kind: PushNotifyKey, job: Job, everyDevice: readonly StoredPushDevice[]): void {
    const ping = pingFor(kind, job);
    for (const device of everyDevice) {
      if (device.events[kind] && mayRead(device, job)) {
        void deliver(device, forDevice(device, ping, badgeFor(device)));
      }
    }
  }

  function onUpsert(job: Job): void {
    const before = known.get(job.id);
    known.set(job.id, job);

    const everyDevice = devices.list();
    if (everyDevice.length === 0) return;

    // A ready job that goes back to Review is the owner's own Unapprove: no ping for what they just did.
    if (job.state === 'review' && before?.state !== 'review' && before?.state !== 'ready') {
      dispatch('review', job, everyDevice);
    } else if (job.state === 'failed' && before?.state !== 'failed') {
      dispatch('failed', job, everyDevice);
    } else if (job.state === 'ready' && before?.state !== 'ready' && job.runKind === 'render') {
      dispatch('approved', job, everyDevice);
    }

    // The queue went idle for a device when this job was the last busy one it sees.
    if (before !== undefined && isBusy(before) && !isBusy(job)) {
      const ping = pingFor('queueEmpty', null);
      for (const device of everyDevice) {
        if (!device.events.queueEmpty || !mayRead(device, job)) continue;
        if (!busyFor(device, job.id))
          void deliver(device, forDevice(device, ping, badgeFor(device)));
      }
    }
  }

  function handle(event: ServerEvent): void {
    try {
      if (event.type === 'job.upsert') {
        onUpsert(event.job);
      } else if (event.type === 'job.remove') {
        // A job that is gone is not "done": the queue may go idle, but nobody is told.
        known.delete(event.id);
      }
    } catch (err) {
      logger.error({ err }, 'could not work out the pushes for a job change');
    }
  }

  return {
    listen(bus) {
      known.clear();
      for (const job of jobs.getAll()) known.set(job.id, job);
      return bus.subscribe(handle);
    },
    handle,
    async sendTest(deviceId) {
      const device = devices.get(deviceId);
      if (device === null) return 'missing';
      const ping = {
        title: PUSH_TEST_TITLE,
        body: 'Notifications are working on this phone.',
        url: PUSH_URLS.jobs,
        tag: 'test',
      };
      return deliver(device, forDevice(device, ping, badgeFor(device)));
    },
    async settled() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
