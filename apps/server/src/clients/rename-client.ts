import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canRename,
  clientNameProblem,
  type Job,
  normalizeClientName,
  type ServerEvent,
} from '@studio/shared';
import {
  ClientRenameConflictError,
  type ClientRenameResult,
  type ClientStyleRepository,
  type JobRepository,
  type SeriesRepository,
  toClientStyle,
  toSeries,
} from '../db/index.js';
import { clientIdFor, isClientFolderName, seriesIdFor } from '../inbox/scan.js';
import type { WatcherLogger } from '../inbox/watcher.js';
import { moneyFilePath } from '../money/money-file.js';
import { jobLogPath } from '../pipeline/job-log.js';
import type { TeamService } from '../team/team-service.js';
import { errorCode, sameOrMissing } from '../trash-path.js';
import type { ClientFolders } from './client-folders.js';
import {
  clientDirFor,
  clientLogPath,
  instagramPhotoFor,
  KIT_DIR_NAME,
  styleDirFor,
} from './paths.js';
import type { StyleDrops } from './style-drops.js';

// Renaming a client (`PUT /api/clients/:clientId/name`). A client is its folder in the inbox, and
// its id, its jobs' ids and its series' ids are hashes of that folder's name, so a new name moves
// all of them:
//
//   checks   the name (as New client checks it), the client (a folder, nothing of it busy), and
//            that the new name is free: in the inbox, in the exports and in the database
//   moves    the registry learns the name ─▶ the inbox folder ─▶ the exports folder ─▶ the
//            client's history in the data folder ─▶ its Instagram photo ─▶ every row (one
//            transaction, `renameClient`, the Instagram rows among them). A step that fails puts
//            back the ones before it, so a refusal leaves the client as it was
//   then     the logs, the team's assignment, a price in money.json, the registry forgets the old
//            name, the client list and the events. None of these fails the rename: a failure is logged
//
// The inbox watcher sees the old folder go and the new one come. By the time it looks (it waits
// for quiet), the rows carry the new name, so it finds every job where it already is.

/** Why a client could not be renamed; `status` is what the route answers. */
export class RenameClientError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'RenameClientError';
    this.status = status;
  }
}

/** The registry of client names (inbox/client-registry.ts) as a rename uses it. */
export interface RenameRegistry {
  has(name: string): boolean;
  add(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface RenameClientOptions {
  /** The inbox root, `Config.inboxPath`. */
  inboxPath: string;
  /** The exports folder, `Config.exportsDir`: `<exports>/<Client>/` moves with the client. */
  exportsDir: string;
  /** The data folder, `Config.dataDir`: the style and series history (`clients/<id>`) and money.json. */
  dataDir?: string;
  /** Where the logs are: the jobs' and the client's follow their new ids. */
  logsDir?: string;
  jobs: Pick<JobRepository, 'getAll' | 'renameClient'>;
  clientStyles: Pick<ClientStyleRepository, 'get'>;
  series?: Pick<SeriesRepository, 'get' | 'listByClient'>;
  folders: Pick<ClientFolders, 'find' | 'add' | 'remove'>;
  /** The clients the watcher takes for clients (the engine's `clientRegistry`). None: every folder is one. */
  registry?: () => Promise<RenameRegistry | null>;
  /** The team's assignments, kept by client id. */
  team?: Pick<TeamService, 'editorsOf' | 'setEditors' | 'removeClient'>;
  /** Why the engine is working in a job's folder beside the edit queue (a quick fix, its music). */
  inUse?: (job: Job) => Promise<string | null> | string | null;
  /** Whether an Instagram scan of the client is queued or running: its rows and photo move with it. */
  instagramBusy?: (clientId: string) => boolean;
  /** Hears of the files in `_Style` before they move, so the move is not taken for a Finder drop. */
  uploads?: Pick<StyleDrops, 'expectUpload'>;
  publish: (event: ServerEvent) => void;
  logger: Pick<WatcherLogger, 'warn' | 'error'>;
}

const taken = (name: string) => `There is already a client or file called “${name}” in the inbox.`;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** What `clientBusyReason` looks at. */
export interface ClientBusySources {
  jobs: Pick<JobRepository, 'getAll'>;
  clientStyles: Pick<ClientStyleRepository, 'get'>;
  series?: Pick<SeriesRepository, 'listByClient'>;
  inUse?: (job: Job) => Promise<string | null> | string | null;
  instagramBusy?: (clientId: string) => boolean;
}

/**
 * Why the client cannot be renamed or deleted right now (`action` is the word the answer uses), or
 * `null`: one of its jobs is arriving, queued or being edited, or the engine works in its folder;
 * its style is being read; a series of it is being learned; an Instagram scan of it is queued or
 * running.
 */
export async function clientBusyReason(
  sources: ClientBusySources,
  clientId: string,
  action: 'rename' | 'delete',
): Promise<string | null> {
  for (const job of sources.jobs.getAll()) {
    if (job.clientId !== clientId) continue;
    if (job.state === 'arriving') {
      return `Wait until the files of “${job.name}” have arrived to ${action} this client.`;
    }
    if (!canRename(job)) return `Wait until “${job.name}” is edited to ${action} this client.`;
    if ((await sources.inUse?.(job)) != null) {
      return `Wait until the engine is done with “${job.name}” to ${action} this client.`;
    }
  }
  if (sources.clientStyles.get(clientId)?.state === 'analysing') {
    return `Wait until the style is ready to ${action} this client.`;
  }
  const learning = sources.series?.listByClient(clientId).find((one) => one.state === 'learning');
  if (learning !== undefined) {
    return `Wait until the series “${learning.name}” is ready to ${action} this client.`;
  }
  if (sources.instagramBusy?.(clientId) === true) {
    return `Wait until the Instagram scan is done to ${action} this client.`;
  }
  return null;
}

/**
 * The files of a style folder that the style drops would read (none in `kit/`, no dotfiles), with
 * their size and time, by their path inside `_Style`.
 */
async function styleFiles(
  dir: string,
  prefix = '',
): Promise<[string, { size: number; mtimeMs: number }][]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: [string, { size: number; mtimeMs: number }][] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (prefix === '' && entry.name === KIT_DIR_NAME) continue;
      files.push(...(await styleFiles(join(dir, entry.name), `${path}/`)));
    } else if (entry.isFile()) {
      const info = await lstat(join(dir, entry.name));
      files.push([path, { size: info.size, mtimeMs: info.mtimeMs }]);
    }
  }
  return files;
}

/** Moves a file or folder, and nothing when it is not there. Answers whether it moved. */
async function moveIfThere(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Gives the client with this id a new name: its folder, its exports, its history, its logs and
 * every row about it and its jobs. Returns the name the folder has now (trimmed, NFC). Throws a
 * {@link RenameClientError}: 400 for a name New client would refuse, 404 for a client that has no
 * folder, 409 while the engine works on one of its jobs, its style or a series, or when the name
 * is taken (in the inbox, the exports or the database).
 */
export async function renameClient(
  options: RenameClientOptions,
  clientId: string,
  requestedName: string,
): Promise<string> {
  const { inboxPath, exportsDir, dataDir, logsDir, jobs, folders, team, logger } = options;
  const name = normalizeClientName(requestedName);
  const problem = clientNameProblem(name);
  if (problem !== null) throw new RenameClientError(400, problem);
  if (!isClientFolderName(inboxPath, name, { exportsDir })) {
    throw new RenameClientError(400, 'That name is kept for the engine. Try another.');
  }

  const client = folders.find(clientId);
  if (client === null) throw new RenameClientError(404, `Client ${clientId} not found`);
  if (client.normalize('NFC') === name) return client;
  const newId = clientIdFor(name);

  const busy = await clientBusyReason(options, clientId, 'rename');
  if (busy !== null) throw new RenameClientError(409, busy);
  const series = options.series?.listByClient(clientId) ?? [];

  if (folders.find(newId) !== null) throw new RenameClientError(409, taken(name));
  const oldDir = clientDirFor(inboxPath, client);
  const newDir = clientDirFor(inboxPath, name);
  if ((await sameOrMissing(oldDir, newDir)) === 'taken') {
    throw new RenameClientError(409, taken(name));
  }
  const oldExports = join(exportsDir, client);
  const newExports = join(exportsDir, name);
  const exportsMove = await isDirectory(oldExports);
  if (exportsMove && (await sameOrMissing(oldExports, newExports)) === 'taken') {
    throw new RenameClientError(409, `A folder called “${name}” is already in the exports.`);
  }
  const oldHistory = dataDir === undefined ? null : join(dataDir, 'clients', clientId);
  const newHistory = dataDir === undefined ? null : join(dataDir, 'clients', newId);
  const historyMove = oldHistory !== null && (await isDirectory(oldHistory));
  if (historyMove && newHistory !== null && (await isDirectory(newHistory))) {
    throw new RenameClientError(
      409,
      `The engine still keeps the style history of an earlier client called “${name}”. Pick another name.`,
    );
  }

  // The Instagram profile picture is a file in the data folder, named by the client's id.
  const oldPhoto = dataDir === undefined ? null : instagramPhotoFor(dataDir, clientId);
  const newPhoto = dataDir === undefined ? null : instagramPhotoFor(dataDir, newId);
  const photoMove = oldPhoto !== null && (await isFile(oldPhoto));

  // Read before anything moves: the watcher drops the assignment of a folder it sees gone.
  const editors = team?.editorsOf(clientId) ?? [];
  if (options.uploads !== undefined) {
    for (const [path, info] of await styleFiles(styleDirFor(inboxPath, client))) {
      options.uploads.expectUpload(name, path, info);
    }
  }

  const registry = (await options.registry?.()) ?? undefined;
  const undo: (() => Promise<void>)[] = [];
  const rollBack = async (): Promise<void> => {
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch (err) {
        logger.error({ err, clientId }, 'could not put back a step of a client rename');
      }
    }
  };
  let moved: ClientRenameResult;
  try {
    // The watcher takes only registered folders for clients: the new name is one before it exists.
    if (registry !== undefined && !registry.has(name)) {
      await registry.add(name);
      undo.push(() => registry.remove(name));
    }
    await rename(oldDir, newDir);
    undo.push(() => rename(newDir, oldDir));
    if (exportsMove) {
      await rename(oldExports, newExports);
      undo.push(() => rename(newExports, oldExports));
    }
    if (historyMove && oldHistory !== null && newHistory !== null) {
      await rename(oldHistory, newHistory);
      undo.push(() => rename(newHistory, oldHistory));
      for (const one of series) {
        const from = join(newHistory, 'series', one.id);
        const to = join(newHistory, 'series', seriesIdFor(newId, one.name));
        if (await moveIfThere(from, to)) undo.push(() => rename(to, from));
      }
    }
    if (photoMove && oldPhoto !== null && newPhoto !== null) {
      await rename(oldPhoto, newPhoto);
      undo.push(() => rename(newPhoto, oldPhoto));
    }
    moved = jobs.renameClient(client, name);
  } catch (err) {
    await rollBack();
    if (err instanceof ClientRenameConflictError) throw new RenameClientError(409, err.message);
    const code = errorCode(err);
    if (code !== undefined && ['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM', 'EBUSY'].includes(code)) {
      logger.warn({ err, clientId }, 'could not rename the folder of a client');
      throw new RenameClientError(409, `Could not rename the folder: ${(err as Error).message}`);
    }
    throw err;
  }

  // From here on the client is renamed: what follows is logged when it fails, never undone.
  if (logsDir !== undefined) {
    const logs = moved.movedIds.map(({ from, to }) => ({
      from: jobLogPath(logsDir, from),
      to: jobLogPath(logsDir, to),
    }));
    logs.push({ from: clientLogPath(logsDir, clientId), to: clientLogPath(logsDir, newId) });
    for (const log of logs) {
      try {
        await moveIfThere(log.from, log.to);
      } catch (err) {
        logger.error({ err, clientId, log: log.from }, 'could not move a log of a renamed client');
      }
    }
  }
  let accessChanged = false;
  if (team !== undefined && editors.length > 0) {
    try {
      team.setEditors(newId, name, editors);
      team.removeClient(clientId);
      accessChanged = true;
    } catch (err) {
      logger.error({ err, clientId }, 'could not move the assignment of a renamed client');
    }
  }
  if (dataDir !== undefined) {
    try {
      await moveClientPrice(moneyFilePath(dataDir), client, name);
    } catch (err) {
      logger.error({ err, clientId }, 'could not move the price of a renamed client');
    }
  }
  if (registry !== undefined) {
    try {
      await registry.remove(client);
    } catch (err) {
      logger.error({ err, clientId }, 'could not forget the old name of a renamed client');
    }
  }

  folders.remove(client);
  folders.add(name);
  const { publish } = options;
  for (const job of moved.jobs) publish({ type: 'job.upsert', job });
  for (const { from } of moved.movedIds) publish({ type: 'job.remove', id: from });
  for (const one of moved.movedSeries) {
    publish({ type: 'series.removed', seriesId: one.from, clientId });
    const stored = options.series?.get(one.to) ?? null;
    if (stored !== null) publish({ type: 'series.changed', series: toSeries(stored) });
  }
  const style = options.clientStyles.get(newId);
  if (style !== null) publish({ type: 'client.upsert', style: toClientStyle(style) });
  if (moved.deliveries > 0) publish({ type: 'money.changed' });
  if (accessChanged) publish({ type: 'access.changed' });
  return name;
}

/**
 * money.json's `clientPrices` is by client name: an entry for the old name (as written, or in
 * NFC) is given the new one, so the client keeps its price. A file with no such entry, or none at
 * all, is left alone; the money watcher reads the new file as it reads the owner's edits.
 */
async function moveClientPrice(path: string, from: string, to: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  const money: unknown = JSON.parse(text);
  if (typeof money !== 'object' || money === null) return;
  const prices = (money as { clientPrices?: unknown }).clientPrices;
  if (typeof prices !== 'object' || prices === null || Array.isArray(prices)) return;
  const key = Object.keys(prices).find(
    (name) => name === from || name.normalize('NFC') === from.normalize('NFC'),
  );
  if (key === undefined) return;
  const next = Object.fromEntries(
    Object.entries(prices).map(([name, price]) => [name === key ? to : name, price]),
  );
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify({ ...money, clientPrices: next }, null, 2)}\n`);
  await rename(temp, path);
}
