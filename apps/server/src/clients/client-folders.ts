import type { EventBus } from '../events/bus.js';
import { clientIdFor } from '../inbox/scan.js';

// The client folders of the inbox (Phase 2 plan §1): a client is any folder directly in the inbox
// that the inbox rules don't skip, with jobs or without. There is no table of them. The set is
// kept in memory:
//
//   boot      seeded from the inbox, silently (`seed`), and once more when the watcher is up
//             (`sync`), which publishes what happened in between
//   watcher   a client folder it finds is `add`ed, one it finds gone is `remove`d
//   POST      `add`s the folder it just made, so that the answer and the watcher agree
//
// `add` and `remove` publish `client.added` and `client.removed` when they change the set, so a
// folder made in Finder and one made in the app are announced alike, and once.
//
// The engine's server is up before the boot has listed the folders. From `expectSeed` (the engine's
// start) until then the set is not empty but unknown: `whenSeeded` waits for the listing, so the
// client list is never answered with none just because the engine has started a moment ago.

/** What publishes the events: the bus, or anything that takes a `ServerEvent`. */
export type ClientFoldersBus = Pick<EventBus, 'publish'>;

/** The longest `whenSeeded` waits: an inbox that cannot be read must not hold a page forever. */
export const SEED_WAIT_MS = 20_000;

/** Code point order of the NFC spellings: the order the scanner sorts in. */
export function compareClientNames(a: string, b: string): number {
  const left = a.normalize('NFC');
  const right = b.normalize('NFC');
  return left < right ? -1 : left > right ? 1 : 0;
}

export class ClientFolders {
  private readonly bus: ClientFoldersBus;
  /** The folder name as the file system lists it, by client id (so NFC and NFD are one client). */
  private readonly names = new Map<string, string>();
  /** False from `expectSeed` until the boot has listed the folders; a set nobody boots is known. */
  private seeded = true;
  private seededOnce: Promise<void> = Promise.resolve();
  private markSeeded: () => void = () => {};

  constructor(bus: ClientFoldersBus) {
    this.bus = bus;
  }

  /**
   * The boot is about to list the folders (the engine's start): until its `seed` (or `sync`) the
   * set is unknown, and `whenSeeded` waits for it.
   */
  expectSeed(): void {
    if (!this.seeded) return;
    this.seeded = false;
    this.seededOnce = new Promise((resolve) => {
      this.markSeeded = () => {
        this.seeded = true;
        resolve();
      };
    });
  }

  /**
   * Resolves once the boot has listed the client folders, or after `maxMs` whatever happened (a
   * list of the clients asks first). At once while the set is known.
   */
  whenSeeded(maxMs = SEED_WAIT_MS): Promise<void> {
    if (this.seeded) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxMs);
    });
    return Promise.race([this.seededOnce, cap]).finally(() => clearTimeout(timer));
  }

  /** The folder name of the client with this id, or null when there is no such client folder. */
  find(clientId: string): string | null {
    return this.names.get(clientId) ?? null;
  }

  has(client: string): boolean {
    return this.names.has(clientIdFor(client));
  }

  /** The folder names, sorted (code point order, NFC). */
  list(): string[] {
    return [...this.names.values()].sort(compareClientNames);
  }

  /**
   * A client folder exists. Publishes `client.added` when it is a new one and returns true; one
   * that is known already keeps its place and takes the spelling given, silently.
   */
  add(client: string): boolean {
    const clientId = clientIdFor(client);
    const known = this.names.has(clientId);
    this.names.set(clientId, client);
    if (known) return false;
    this.bus.publish({ type: 'client.added', clientId, client });
    return true;
  }

  /**
   * A client folder is gone. Publishes `client.removed` and returns true when it was a known one;
   * the event carries the name as it was kept.
   */
  remove(client: string): boolean {
    const clientId = clientIdFor(client);
    const kept = this.names.get(clientId);
    if (kept === undefined) return false;
    this.names.delete(clientId);
    this.bus.publish({ type: 'client.removed', clientId, client: kept });
    return true;
  }

  /** Replaces the whole set without a word: for the boot, before anyone is listening. */
  seed(clients: readonly string[]): void {
    this.names.clear();
    for (const client of clients) this.names.set(clientIdFor(client), client);
    this.markSeeded();
  }

  /**
   * Makes the set equal to `clients`, publishing `client.added` for each new folder and
   * `client.removed` for each that is gone. Returns the number of events.
   */
  sync(clients: readonly string[]): number {
    const present = new Map(clients.map((client) => [clientIdFor(client), client]));
    let changes = 0;
    for (const [clientId, client] of [...this.names]) {
      if (!present.has(clientId) && this.remove(client)) changes += 1;
    }
    for (const client of present.values()) if (this.add(client)) changes += 1;
    this.markSeeded();
    return changes;
  }
}
