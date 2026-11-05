import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PUSH_EVENTS,
  type PushDevice,
  type PushEvents,
  type PushEventsPatch,
  pushEventsSchema,
} from '@studio/shared';
import { asc, eq } from 'drizzle-orm';
import type { StudioDb } from './database.js';
import { toIso } from './mapping.js';
import { type PushDeviceRow, pushDevices } from './schema.js';

/**
 * A device as stored: the browser's push subscription (`endpoint`, `p256dh`, `auth`) next to what
 * the routes show. Times are milliseconds since the epoch. The subscription is a secret of the
 * push service: it goes to the sender and nowhere else (`toPushDevice` leaves it out).
 */
export interface StoredPushDevice {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  events: PushEvents;
  createdAt: number;
  lastOkAt: number | null;
  /**
   * The login of the person who registered the device (`viewer.email`; `local` for the owner on the
   * Mac). `null` for a device registered before the team existed: it is the owner's, the admin's.
   */
  owner: string | null;
}

/** What a device registers with: its push subscription, a short name and who registers it. */
export interface NewPushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  /** The registering viewer's login. Left out (tests, old callers): no owner, so the admin's. */
  owner?: string | null;
  /**
   * Whether the registering viewer is an admin. Anyone else cannot take over a device that is
   * someone else's (or the admin's) by registering its endpoint again.
   */
  admin?: boolean;
}

/** An editor registered the endpoint of a device that belongs to someone else. */
export class PushDeviceOwnedError extends Error {
  constructor() {
    super('This device is registered to someone else.');
    this.name = 'PushDeviceOwnedError';
  }
}

export interface PushDeviceRepositoryOptions {
  /** The clock for `createdAt` and `lastOkAt`. Tests pass a fake. */
  clock?: () => Date;
}

/** The events of a row: the stored switches, or the defaults when the column was edited by hand into nonsense. */
function parseEvents(raw: unknown): PushEvents {
  const parsed = pushEventsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...DEFAULT_PUSH_EVENTS };
}

function rowToStored(row: PushDeviceRow): StoredPushDevice {
  return {
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    label: row.label,
    events: parseEvents(row.events),
    createdAt: row.createdAt,
    lastOkAt: row.lastOkAt,
    owner: row.owner,
  };
}

/** The wire device of a stored one: no subscription, ISO times. */
export function toPushDevice(stored: StoredPushDevice): PushDevice {
  return {
    id: stored.id,
    label: stored.label,
    events: stored.events,
    createdAt: toIso(stored.createdAt),
    lastOkAt: stored.lastOkAt === null ? null : toIso(stored.lastOkAt),
  };
}

/**
 * Durable storage for the phones that get a push (Mobile plan §6): the only code that reads or
 * writes the `push_devices` table. A device registers by its endpoint (`register` writes a new row
 * or refreshes the keys of the one that has it), has its switches changed with `setEvents`, and is
 * deleted by whoever finds its subscription gone (`remove`).
 */
export class PushDeviceRepository {
  private readonly db: StudioDb;
  private readonly clock: () => Date;

  constructor(db: StudioDb, { clock = () => new Date() }: PushDeviceRepositoryOptions = {}) {
    this.db = db;
    this.clock = clock;
  }

  get(id: string): StoredPushDevice | null {
    const row = this.db.orm.select().from(pushDevices).where(eq(pushDevices.id, id)).get();
    return row === undefined ? null : rowToStored(row);
  }

  /** Every device, the oldest first. */
  list(): StoredPushDevice[] {
    return this.db.orm
      .select()
      .from(pushDevices)
      .orderBy(asc(pushDevices.createdAt), asc(pushDevices.id))
      .all()
      .map(rowToStored);
  }

  /**
   * Registers a device by its endpoint. A new endpoint becomes a new device with the default
   * switches; one that is known keeps its id, switches and `createdAt` and takes the new keys and
   * label (a browser that subscribes again, or an update of the user agent).
   *
   * Who registers it owns it (Team plan, TM2). A known device keeps its owner when the same login
   * registers it again; an admin who registers it takes it over (a device from before the team has
   * no owner and is the admin's anyway); anyone else gets a {@link PushDeviceOwnedError} and the
   * device is left as it was.
   */
  register(input: NewPushDevice): { device: StoredPushDevice; created: boolean } {
    return this.db.sqlite.transaction(() => {
      const known = this.db.orm
        .select()
        .from(pushDevices)
        .where(eq(pushDevices.endpoint, input.endpoint))
        .get();
      const owner = input.owner ?? null;
      if (known !== undefined) {
        // Only an admin may take a device that is someone else's (or the admin's own, which a
        // device from before the team is).
        if (input.admin !== true && known.owner !== owner) throw new PushDeviceOwnedError();
        const row = this.db.orm
          .update(pushDevices)
          .set({
            p256dh: input.p256dh,
            auth: input.auth,
            label: input.label,
            owner: input.admin === true ? owner : known.owner,
          })
          .where(eq(pushDevices.id, known.id))
          .returning()
          .get();
        return { device: rowToStored(row ?? known), created: false };
      }
      const row = this.db.orm
        .insert(pushDevices)
        .values({
          id: randomUUID(),
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          label: input.label,
          events: { ...DEFAULT_PUSH_EVENTS },
          createdAt: this.clock().getTime(),
          lastOkAt: null,
          owner,
        })
        .returning()
        .get();
      return { device: rowToStored(row), created: true };
    })();
  }

  /** Changes the switches named in `patch`, keeps the others. `null` when there is no such device. */
  setEvents(id: string, patch: PushEventsPatch): StoredPushDevice | null {
    return this.db.sqlite.transaction(() => {
      const current = this.get(id);
      if (current === null) return null;
      const events = pushEventsSchema.parse({ ...current.events, ...definedOnly(patch) });
      const row = this.db.orm
        .update(pushDevices)
        .set({ events })
        .where(eq(pushDevices.id, id))
        .returning()
        .get();
      return row === undefined ? null : rowToStored(row);
    })();
  }

  /** Notes that a push to the device went through, now. */
  markOk(id: string): void {
    this.db.orm
      .update(pushDevices)
      .set({ lastOkAt: this.clock().getTime() })
      .where(eq(pushDevices.id, id))
      .run();
  }

  /** Deletes the device. True when there was one. */
  remove(id: string): boolean {
    return (
      this.db.orm.delete(pushDevices).where(eq(pushDevices.id, id)).returning().all().length > 0
    );
  }
}

function definedOnly(patch: PushEventsPatch): PushEventsPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as PushEventsPatch;
}
