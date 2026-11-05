import { mkdir, readdir } from 'node:fs/promises';
import {
  type ClientInstagramSummary,
  type ClientRow,
  clientNameProblem,
  normalizeClientName,
} from '@studio/shared';
import type { ClientStyleRepository, JobRepository } from '../db/index.js';
import { clientIdFor, isClientFolderName } from '../inbox/scan.js';
import type { ClientFolders } from './client-folders.js';
import { clientDirFor, styleDirFor } from './paths.js';

// The client list (Phase 2 plan §1): one row per client folder, with or without jobs, and New
// client, which makes the folder.

/** What the list is made from. */
export interface ClientListSources {
  folders: Pick<ClientFolders, 'list'>;
  jobs: Pick<JobRepository, 'clientJobStats'>;
  clientStyles: Pick<ClientStyleRepository, 'get'>;
  /**
   * The client's Instagram in short (Clients × Instagram, IG6): given only while the `instagram`
   * switch is on, and then every row has an `instagram` (`null` for a client with no account).
   */
  instagram?: { summary(clientId: string): ClientInstagramSummary | null };
}

interface JobStats {
  jobs: number;
  lastJobAt: string;
}

/** The job counts by client id: a client scanned in both NFC and NFD spellings is one. */
function statsByClient(jobs: ClientListSources['jobs']): Map<string, JobStats> {
  const stats = new Map<string, JobStats>();
  for (const line of jobs.clientJobStats()) {
    const clientId = clientIdFor(line.client);
    const known = stats.get(clientId);
    stats.set(clientId, {
      jobs: (known?.jobs ?? 0) + line.jobs,
      lastJobAt:
        known === undefined || Date.parse(line.lastAddedAt) > Date.parse(known.lastJobAt)
          ? line.lastAddedAt
          : known.lastJobAt,
    });
  }
  return stats;
}

function rowFor(
  client: string,
  stats: Map<string, JobStats>,
  { clientStyles, instagram }: Pick<ClientListSources, 'clientStyles' | 'instagram'>,
): ClientRow {
  const clientId = clientIdFor(client);
  const style = clientStyles.get(clientId);
  return {
    clientId,
    client,
    jobs: stats.get(clientId)?.jobs ?? 0,
    lastJobAt: stats.get(clientId)?.lastJobAt ?? null,
    style: { state: style?.state ?? 'none', updatedAt: style?.updatedAt ?? null },
    ...(instagram === undefined ? {} : { instagram: instagram.summary(clientId) }),
  };
}

/** One row per client folder, sorted by name. `jobs` counts the jobs the engine knows for it. */
export function listClients(sources: ClientListSources): ClientRow[] {
  const stats = statsByClient(sources.jobs);
  return sources.folders.list().map((client) => rowFor(client, stats, sources));
}

/** The row of one client folder, whether or not the list holds it yet. */
export function clientRow(sources: Omit<ClientListSources, 'folders'>, client: string): ClientRow {
  return rowFor(client, statsByClient(sources.jobs), sources);
}

/** Why a client could not be made; `status` is what the route answers. */
export class CreateClientError extends Error {
  readonly status: 400 | 409 | 500;
  constructor(status: 400 | 409 | 500, message: string) {
    super(message);
    this.name = 'CreateClientError';
    this.status = status;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export interface CreateClientOptions {
  /** The inbox root, `Config.inboxPath`. */
  inboxPath: string;
  /** The exports folder, `Config.exportsDir`: not a client, whatever it is called. */
  exportsDir?: string;
  /** Registers the name as a client, before its folder is made (the watcher ignores others). */
  register?: (name: string) => Promise<void>;
  /** Told of the new folder (`client.added`) as soon as it is there. */
  folders: Pick<ClientFolders, 'add'>;
  /** Told when `_Style` could not be made; the watcher makes it later. */
  onStyleDirFailed?: (error: unknown, path: string) => void;
}

const taken = (name: string) => `There is already a client or file called “${name}” in the inbox.`;

/**
 * Makes `<inbox>/<name>/` and its `_Style/` and returns the name the folder has: trimmed and in
 * NFC. Throws a {@link CreateClientError}: 400 for a name that can't be used (see
 * `clientNameProblem`), 409 when the inbox has something by that name already, in NFC or NFD (and
 * on a case-insensitive disk, whatever the case), 500 when the folder could not be made.
 *
 * It makes folders and nothing else: a job is a folder inside a client, and `_Style` is the one
 * folder inside that the scanner and the watcher never take for one, so the watcher finding the
 * new folder (before or after `_Style` is there) leaves the job list as it was. The client folder
 * is made without `-p`, so that a folder made meanwhile (or one the disk can't tell apart from
 * this name) is a 409 and not a merge, and an inbox that is not there is never brought back.
 */
export async function createClientFolder(
  options: CreateClientOptions,
  requestedName: string,
): Promise<string> {
  const { inboxPath, exportsDir, folders } = options;
  const name = normalizeClientName(requestedName);
  const problem = clientNameProblem(name);
  if (problem !== null) throw new CreateClientError(400, problem);
  if (!isClientFolderName(inboxPath, name, { exportsDir })) {
    throw new CreateClientError(400, 'That name is kept for the engine. Try another.');
  }

  // The disk decides what is taken, not the list of folders, which can lag behind a Finder delete.
  let entries: string[];
  try {
    entries = await readdir(inboxPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new CreateClientError(500, 'The inbox folder is missing.');
    }
    throw error;
  }
  // The disk may list the same name decomposed (NFD) where we write it composed (NFC).
  if (entries.some((entry) => entry.normalize('NFC') === name)) {
    throw new CreateClientError(409, taken(name));
  }

  const folder = clientDirFor(inboxPath, name);
  await options.register?.(name);
  try {
    await mkdir(folder);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EEXIST') throw new CreateClientError(409, taken(name));
    if (code === 'ENAMETOOLONG') {
      throw new CreateClientError(400, 'That name is too long for a folder. Make it shorter.');
    }
    if (code === 'ENOENT') throw new CreateClientError(500, 'The inbox folder is missing.');
    throw error;
  }

  // The watcher makes `_Style` for a client folder it finds, so a failure here is not the end.
  const styleDir = styleDirFor(inboxPath, name);
  try {
    await mkdir(styleDir);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') options.onStyleDirFailed?.(error, styleDir);
  }

  folders.add(name);
  return name;
}
