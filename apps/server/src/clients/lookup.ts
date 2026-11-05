import type { ClientStyleRepository, JobRepository } from '../db/index.js';
import { clientIdFor } from '../inbox/scan.js';
import type { ClientFolders } from './client-folders.js';

/** What it takes to tell which clients exist: the jobs, the client folders and the stored styles. */
export interface ClientSources {
  jobs: Pick<JobRepository, 'clientNames'>;
  /**
   * The client folders of the inbox, so that a client with no job is known too. Left out by tests
   * that only have jobs and styles.
   */
  folders?: Pick<ClientFolders, 'find'>;
  clientStyles: Pick<ClientStyleRepository, 'get'>;
}

/**
 * The folder name of the client with this id, or null for an unknown client. There is no table of
 * clients: a client is known while it has a folder in the inbox (with jobs or without), while one
 * of its jobs is, or once it has a stored style (so a client whose folder and last job are gone
 * keeps its style page). The name is spelled as the latest scan of one of its jobs listed it, else
 * as its folder was listed, else as the stored style has it.
 */
export function findClient(
  clientId: string,
  { jobs, folders, clientStyles }: ClientSources,
): string | null {
  const fromJobs = jobs.clientNames().find((name) => clientIdFor(name) === clientId);
  return fromJobs ?? folders?.find(clientId) ?? clientStyles.get(clientId)?.client ?? null;
}
