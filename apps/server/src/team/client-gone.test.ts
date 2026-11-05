import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientIdFor } from '../inbox/scan.js';
import {
  clientFolderIsGone,
  dropAssignmentOfGoneClient,
  pruneGoneAssignments,
} from './client-gone.js';
import { TeamService } from './team-service.js';

let dir: string;
let inbox: string;
let team: TeamService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-client-gone-'));
  inbox = join(dir, 'inbox');
  mkdirSync(inbox);
  team = new TeamService(join(dir, 'team.json'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('clientFolderIsGone', () => {
  it('is false for a folder that is there', () => {
    mkdirSync(join(inbox, 'Acme'));
    expect(clientFolderIsGone(inbox, 'Acme')).toBe(false);
  });

  it('is true for a folder that does not exist, and for a name taken by a file', () => {
    expect(clientFolderIsGone(inbox, 'Acme')).toBe(true);
    writeFileSync(join(inbox, 'Acme'), 'x');
    expect(clientFolderIsGone(inbox, 'Acme')).toBe(true);
  });

  it('is false while the inbox itself is missing: every folder would look gone', () => {
    rmSync(inbox, { recursive: true });
    expect(clientFolderIsGone(inbox, 'Acme')).toBe(false);
  });
});

describe('dropAssignmentOfGoneClient', () => {
  it('drops the assignment of a gone client once, then reports nothing to drop', () => {
    const id = clientIdFor('Acme');
    team.setEditors(id, 'Acme', ['yael@example.com']);
    expect(dropAssignmentOfGoneClient(team, inbox, id, 'Acme')).toBe(true);
    expect(team.editorsOf(id)).toEqual([]);
    expect(dropAssignmentOfGoneClient(team, inbox, id, 'Acme')).toBe(false);
  });

  it('keeps the assignment of a client whose folder is there', () => {
    mkdirSync(join(inbox, 'Acme'));
    const id = clientIdFor('Acme');
    team.setEditors(id, 'Acme', ['yael@example.com']);
    expect(dropAssignmentOfGoneClient(team, inbox, id, 'Acme')).toBe(false);
    expect(team.editorsOf(id)).toEqual(['yael@example.com']);
  });
});

describe('pruneGoneAssignments', () => {
  it('drops only the assignments of clients that are neither listed nor on the disk', () => {
    mkdirSync(join(inbox, 'Listed'));
    mkdirSync(join(inbox, 'Unlisted But There'));
    team.setEditors(clientIdFor('Listed'), 'Listed', ['yael@example.com']);
    team.setEditors(clientIdFor('Unlisted But There'), 'Unlisted But There', ['yael@example.com']);
    team.setEditors(clientIdFor('Gone'), 'Gone', ['amit@example.com']);

    expect(pruneGoneAssignments(team, inbox, ['Listed'])).toBe(1);
    expect(Object.keys(team.assignments()).sort()).toEqual(
      [clientIdFor('Listed'), clientIdFor('Unlisted But There')].sort(),
    );
  });
});
