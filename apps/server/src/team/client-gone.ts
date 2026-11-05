// A client folder that is really gone takes its team assignment with it (C40). The assignments
// are kept by client id (a hash of the folder name), so one that outlives its folder would hand
// the next client of the same name to the earlier editors, with its videos.
//
// "Gone" is decided on the disk, not on the engine's list of client folders: that list drops a
// folder it merely failed to read (a busy or unmounted drive, a permission error), and such a
// client must keep its editors. Only a folder the disk says does not exist, or is no longer a
// folder, is gone, and never while the inbox itself cannot be read.

import { lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clientIdFor } from '../inbox/scan.js';
import type { TeamService } from './team-service.js';

/** True only when `<inbox>/<client>` certainly does not exist (or is not a folder any more). */
export function clientFolderIsGone(inboxPath: string, client: string): boolean {
  try {
    if (!statSync(inboxPath).isDirectory()) return false;
  } catch {
    return false; // The inbox cannot be read: every folder would look gone.
  }
  try {
    return !lstatSync(join(inboxPath, client)).isDirectory();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/**
 * The engine heard that a client folder is gone: drops its assignment when the disk agrees.
 * Returns whether an assignment was dropped (the caller then publishes `access.changed`).
 */
export function dropAssignmentOfGoneClient(
  team: Pick<TeamService, 'removeClient'>,
  inboxPath: string,
  clientId: string,
  client: string,
): boolean {
  if (!clientFolderIsGone(inboxPath, client)) return false;
  return team.removeClient(clientId);
}

/**
 * Start-up: drops the assignments whose client folder is not in `present` (the client folders
 * the inbox was just listed with, so call it only after that listing succeeded) and that the disk
 * confirms gone. Returns how many were dropped.
 */
export function pruneGoneAssignments(
  team: Pick<TeamService, 'assignments' | 'removeClient'>,
  inboxPath: string,
  present: readonly string[],
): number {
  const here = new Set(present.map(clientIdFor));
  let dropped = 0;
  for (const [clientId, assignment] of Object.entries(team.assignments())) {
    if (here.has(clientId)) continue;
    if (dropAssignmentOfGoneClient(team, inboxPath, clientId, assignment.client)) dropped += 1;
  }
  return dropped;
}
