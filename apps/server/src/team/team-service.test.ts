import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamService } from './team-service.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-team-'));
  file = join(dir, 'nested', 'team.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const yael = { email: 'yael@example.com', name: 'Yael', role: 'editor' as const };
const amit = { email: 'amit@example.com', name: 'Amit', role: 'editor' as const };

describe('TeamService', () => {
  it('is an empty team while there is no file, and writes nothing by reading', () => {
    const team = new TeamService(file);
    expect(team.users()).toEqual([]);
    expect(team.emails()).toEqual([]);
    expect(team.find('yael@example.com')).toBeUndefined();
    expect(team.editorsOf('c1')).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('saves a person atomically: valid JSON in place, no temp file left, folder made', () => {
    const team = new TeamService(file);
    team.upsertUser({ ...yael, email: ' Yael@Example.com ' });

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ users: [yael], assignments: {} });
    expect(readdirSync(join(dir, 'nested'))).toEqual(['team.json']);
    expect(team.find('YAEL@example.com')).toEqual(yael);

    // A second service reads the same file.
    expect(new TeamService(file).emails()).toEqual(['yael@example.com']);
  });

  it('changes a person in place and keeps logins that are not emails as they are', () => {
    const team = new TeamService(file);
    team.upsertUser(yael);
    team.upsertUser({ ...yael, name: 'Yael B', role: 'admin' });
    team.upsertUser({ email: 'Amit@GitHub', name: 'Amit', role: 'editor' });
    expect(team.users()).toEqual([
      { email: 'yael@example.com', name: 'Yael B', role: 'admin' },
      { email: 'amit@github', name: 'Amit', role: 'editor' },
    ]);
  });

  it('assigns a client to several editors, with its name beside its id', () => {
    const team = new TeamService(file);
    team.upsertUser(yael);
    team.upsertUser(amit);
    team.setEditors('c1', 'Acme', ['Yael@example.com', 'amit@example.com', 'yael@example.com']);

    expect(team.editorsOf('c1')).toEqual(['yael@example.com', 'amit@example.com']);
    expect(JSON.parse(readFileSync(file, 'utf8')).assignments).toEqual({
      c1: { client: 'Acme', editors: ['yael@example.com', 'amit@example.com'] },
    });
    expect(team.clientIdsOf('amit@example.com')).toEqual(['c1']);
    expect(team.clientIdsOf('nobody@example.com')).toEqual([]);

    team.setEditors('c1', 'Acme', []);
    expect(team.editorsOf('c1')).toEqual([]);
    expect(team.assignments()).toEqual({});
  });

  it('shows an unassigned client to the admin only, and an assigned one to its editors', () => {
    const team = new TeamService(file);
    team.setEditors('c1', 'Acme', ['yael@example.com']);
    const asEditor = (email: string) => ({ email, role: 'editor' as const });

    expect(team.canSee({ email: 'local', role: 'admin' }, 'c1')).toBe(true);
    expect(team.canSee({ email: 'local', role: 'admin' }, 'unassigned')).toBe(true);
    expect(team.canSee(asEditor('Yael@example.com'), 'c1')).toBe(true);
    expect(team.canSee(asEditor('amit@example.com'), 'c1')).toBe(false);
    expect(team.canSee(asEditor('yael@example.com'), 'unassigned')).toBe(false);
  });

  it('assigns a client an editor created to that editor, and only to an editor', () => {
    const team = new TeamService(file);
    expect(team.autoAssign('c1', 'Acme', { email: 'Yael@example.com', role: 'editor' })).toBe(true);
    expect(team.editorsOf('c1')).toEqual(['yael@example.com']);

    // Another editor joins; the same editor twice changes nothing.
    team.autoAssign('c1', 'Acme', { email: 'amit@example.com', role: 'editor' });
    team.autoAssign('c1', 'Acme', { email: 'amit@example.com', role: 'editor' });
    expect(team.editorsOf('c1')).toEqual(['yael@example.com', 'amit@example.com']);

    // The admin's client stays unassigned: the admin sees every client anyway.
    expect(team.autoAssign('c2', 'Beta', { email: 'local', role: 'admin' })).toBe(false);
    expect(team.editorsOf('c2')).toEqual([]);
  });

  it('removing a person removes them from every client; removing a client forgets it', () => {
    const team = new TeamService(file);
    team.upsertUser(yael);
    team.upsertUser(amit);
    team.setEditors('c1', 'Acme', ['yael@example.com', 'amit@example.com']);
    team.setEditors('c2', 'Beta', ['yael@example.com']);

    team.removeUser('yael@example.com');
    expect(team.emails()).toEqual(['amit@example.com']);
    expect(team.editorsOf('c1')).toEqual(['amit@example.com']);
    expect(team.editorsOf('c2')).toEqual([]);

    expect(team.removeClient('c1')).toBe(true);
    expect(team.assignments()).toEqual({});
    expect(team.removeClient('c1')).toBe(false);
  });

  it('reads the file again when it changes on disk, so a hand edit needs no restart', () => {
    const team = new TeamService(file);
    team.upsertUser(yael);
    expect(team.emails()).toEqual(['yael@example.com']);

    writeFileSync(
      file,
      JSON.stringify({
        users: [yael, amit],
        assignments: { c9: { client: 'Z', editors: ['AMIT@example.com'] } },
      }),
    );
    expect(team.emails()).toEqual(['yael@example.com', 'amit@example.com']);
    expect(team.editorsOf('c9')).toEqual(['amit@example.com']);

    rmSync(file);
    expect(team.emails()).toEqual([]);
  });

  it('keeps the last good team when the file turns unreadable, and says so', () => {
    const onUnreadable = vi.fn();
    const team = new TeamService(file, { onUnreadable });
    team.upsertUser(yael);

    writeFileSync(file, '{ not json, and longer than before');
    expect(team.emails()).toEqual(['yael@example.com']);
    expect(onUnreadable).toHaveBeenCalledTimes(1);

    writeFileSync(file, JSON.stringify({ users: [{ email: 'x', name: 'X', role: 'owner' }] }));
    expect(team.emails()).toEqual(['yael@example.com']);
  });

  it('fills defaults for a file with only some of its keys', () => {
    const team = new TeamService(file);
    team.upsertUser(yael);
    writeFileSync(file, JSON.stringify({ users: [amit] }));
    expect(team.emails()).toEqual(['amit@example.com']);
    expect(team.assignments()).toEqual({});
  });
});
