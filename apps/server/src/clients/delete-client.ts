import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job, ServerEvent } from '@studio/shared';
import type { ClientStyleRepository, JobRepository, SeriesRepository } from '../db/index.js';
import type { WatcherLogger } from '../inbox/watcher.js';
import { errorText } from '../pipeline/claude-process.js';
import { jobLogPath } from '../pipeline/job-log.js';
import type { TeamService } from '../team/team-service.js';
import { moveDir, type TrashedPath, trashPath } from '../trash-path.js';
import type { ClientFolders } from './client-folders.js';
import { clientDirFor, clientLogPath, instagramPhotoFor } from './paths.js';
import { clientBusyReason, type RenameRegistry } from './rename-client.js';

// Deleting a client (`DELETE /api/clients/:clientId`, the admin's). A client is its folder in the
// inbox; deleting it takes everything of it:
//
//   checks   the client has a folder and nothing of it is busy (as Rename checks)
//   moves    the inbox folder ─▶ the Trash as "<Client>", the exports folder ─▶ the Trash as
//            "<Client> exports". When macOS will not take them they go to `<data>/deleted-clients`
//            instead. When the exports cannot move, the inbox folder is put back and nothing changed
//   rows     every row about the client and its jobs, deliveries and payments included, its series,
//            its style and its Instagram account, scans and reels (one transaction, `purgeClient`)
//   then     the jobs' and the client's logs, its history and its Instagram photo in the data
//            folder, the team's assignment, the registry, the client list and the events. None of
//            these fails the delete: a failure is logged
//
// The folders are moved before the rows go: a move that fails leaves the client as it was. The
// inbox watcher waits for quiet before it looks, and by then the rows are gone, so it finds no job
// to mark as deleted. money.json is the owner's file and is left alone (a price there is by name).

/** Why a client could not be deleted; `status` is what the route answers. */
export class DeleteClientError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = 'DeleteClientError';
    this.status = status;
  }
}

export interface DeleteClientOptions {
  /** The inbox root, `Config.inboxPath`. */
  inboxPath: string;
  /** The exports folder, `Config.exportsDir`: `<exports>/<Client>/` goes with the client. */
  exportsDir: string;
  /** The data folder, `Config.dataDir`: the history (`clients/<id>`), and `deleted-clients`. */
  dataDir?: string;
  /** Where the logs are: the jobs' and the client's are removed. */
  logsDir?: string;
  jobs: Pick<JobRepository, 'getAll' | 'purgeClient'>;
  clientStyles: Pick<ClientStyleRepository, 'get'>;
  series?: Pick<SeriesRepository, 'listByClient'>;
  folders: Pick<ClientFolders, 'find' | 'remove'>;
  /** The clients the watcher takes for clients (the engine's `clientRegistry`). */
  registry?: () => Promise<RenameRegistry | null>;
  /** The team's assignments, kept by client id. */
  team?: Pick<TeamService, 'removeClient'>;
  /** Why the engine is working in a job's folder beside the edit queue (a quick fix, its music). */
  inUse?: (job: Job) => Promise<string | null> | string | null;
  /** Whether an Instagram scan of the client is queued or running: its rows go with the client. */
  instagramBusy?: (clientId: string) => boolean;
  /** The home folder, for `~/.Trash`. Default: the user's. Tests pass a temp folder. */
  home?: string;
  publish: (event: ServerEvent) => void;
  logger: Pick<WatcherLogger, 'warn' | 'error'>;
}

/** What a delete did. */
export interface DeletedClient {
  /** The client's folder name. */
  client: string;
  /** False when macOS would not take a folder to the Trash and it went to `<data>/deleted-clients`. */
  trashed: boolean;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Deletes the client with this id: its folder and its exports go to the Trash, and its jobs, their
 * payments, its series, its style, its logs and its history are deleted. Throws a
 * {@link DeleteClientError}: 404 for a client that has no folder, 409 while the engine works on one
 * of its jobs, its style or a series, or when its folder cannot be moved.
 */
export async function deleteClient(
  options: DeleteClientOptions,
  clientId: string,
): Promise<DeletedClient> {
  const { inboxPath, exportsDir, dataDir, logsDir, jobs, folders, logger } = options;
  const client = folders.find(clientId);
  if (client === null) throw new DeleteClientError(404, `Client ${clientId} not found`);
  const busy = await clientBusyReason(options, clientId, 'delete');
  if (busy !== null) throw new DeleteClientError(409, busy);

  const trash = (from: string, name: string): Promise<TrashedPath> =>
    trashPath(from, {
      name,
      ...(options.home === undefined ? {} : { home: options.home }),
      asideDir: dataDir === undefined ? null : join(dataDir, 'deleted-clients'),
    });
  // A folder that is already gone (Finder was quicker than the watcher) has nothing to move.
  const folder = clientDirFor(inboxPath, client);
  let inbox: TrashedPath | null = null;
  if (await isDirectory(folder)) {
    try {
      inbox = await trash(folder, client);
    } catch (err) {
      logger.warn({ err, clientId }, 'could not move the folder of a deleted client');
      throw new DeleteClientError(409, `Could not move the folder to the Trash: ${errorText(err)}`);
    }
  }
  let trashed = inbox?.trashed ?? true;
  const exportsFolder = join(exportsDir, client);
  if (await isDirectory(exportsFolder)) {
    try {
      trashed = (await trash(exportsFolder, `${client} exports`)).trashed && trashed;
    } catch (err) {
      logger.warn({ err, clientId }, 'could not move the exports of a deleted client');
      if (inbox !== null) {
        try {
          await moveDir(inbox.where, folder);
        } catch (undo) {
          logger.error({ err: undo, clientId }, 'could not put back the folder of a client');
        }
      }
      throw new DeleteClientError(
        409,
        `Could not move the exports to the Trash: ${errorText(err)}`,
      );
    }
  }

  // From here on the client is deleted: what follows is logged when it fails, never undone.
  const gone = jobs.purgeClient(client);
  const files = [
    ...(logsDir === undefined
      ? []
      : [...gone.jobIds.map((id) => jobLogPath(logsDir, id)), clientLogPath(logsDir, clientId)]),
    ...(dataDir === undefined
      ? []
      : [join(dataDir, 'clients', clientId), instagramPhotoFor(dataDir, clientId)]),
  ];
  for (const path of files) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (err) {
      logger.error({ err, clientId, path }, 'could not remove a file of a deleted client');
    }
  }
  let accessChanged = false;
  try {
    accessChanged = options.team?.removeClient(clientId) ?? false;
  } catch (err) {
    logger.error({ err, clientId }, 'could not drop the assignment of a deleted client');
  }
  try {
    await (await options.registry?.())?.remove(client);
  } catch (err) {
    logger.error({ err, clientId }, 'could not forget the name of a deleted client');
  }

  folders.remove(client);
  const { publish } = options;
  for (const id of gone.jobIds) publish({ type: 'job.remove', id });
  for (const seriesId of gone.seriesIds) publish({ type: 'series.removed', seriesId, clientId });
  if (gone.deliveries > 0) publish({ type: 'money.changed' });
  if (accessChanged) publish({ type: 'access.changed' });
  return { client, trashed };
}
