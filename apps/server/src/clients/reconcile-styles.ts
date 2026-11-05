import { stat } from 'node:fs/promises';
import { type ClientStyleRepository, toClientStyle } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { clientIdFor, listClientNames } from '../inbox/scan.js';
import type { WatcherLogger } from '../inbox/watcher.js';
import { styleFileFor } from './paths.js';

// Startup reconciliation of the client styles (Phase 2 plan §4). The engine can be off while
// someone writes `<inbox>/<Client>/_Style/style.md` by hand, and a style made before the table
// existed has no row. For every client folder whose style.md exists and which has no row, this
// adds one:
//
//   state ready, version 1, updatedAt = the file's modification time
//
// so a hand-made style counts as a style. A client that has a row is left alone, whatever the file
// says: the style runs own the row from then on. The new row is published as `client.upsert`.

/** The repository methods the reconciliation uses. */
export type ReconcileStylesRepository = Pick<ClientStyleRepository, 'get' | 'upsert'>;

export interface ReconcileStylesOptions {
  /** The inbox root, `Config.inboxPath`. */
  inboxPath: string;
  /** The exports folder, `Config.exportsDir`: not a client, whatever it is called. */
  exportsDir: string;
  repo: ReconcileStylesRepository;
  bus: EventBus;
  logger?: Pick<WatcherLogger, 'info' | 'warn'>;
}

/** The modification time of the client's `style.md`, or null when there is no such file. */
async function styleMtimeMs(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * Adds a `ready` row for every client that has a `style.md` and no row. Returns the number of rows
 * added. One client whose file cannot be read does not stop the others.
 */
export async function reconcileClientStyles(options: ReconcileStylesOptions): Promise<number> {
  const { inboxPath, exportsDir, repo, bus, logger } = options;

  let added = 0;
  for (const client of await listClientNames(inboxPath, { exportsDir })) {
    const clientId = clientIdFor(client);
    try {
      if (repo.get(clientId) !== null) continue;

      const mtimeMs = await styleMtimeMs(styleFileFor(inboxPath, client));
      if (mtimeMs === null) continue;

      const { style } = repo.upsert({
        clientId,
        client,
        state: 'ready',
        version: 1,
        updatedAt: new Date(mtimeMs).toISOString(),
      });
      added += 1;
      logger?.info({ clientId, client }, 'found a style.md without a style record; marked ready');
      bus.publish({ type: 'client.upsert', style: toClientStyle(style) });
    } catch (error) {
      logger?.warn({ clientId, client, err: error }, 'could not record the style of a client');
    }
  }
  return added;
}
