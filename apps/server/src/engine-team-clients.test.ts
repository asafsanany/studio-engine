import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { memoryDb } from './db/test-utils.js';
import { createEngine, type Engine } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import { clientIdFor } from './inbox/scan.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { TeamService } from './team/team-service.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// C40: a client folder that is gone takes its team assignment with it, so the next client of the
// same name starts with nobody (or only its creator), never with the earlier editors.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

const YAEL = 'yael@example.com';
const AMIT = 'amit@example.com';

function boot() {
  const home = makeTempDir('studio-engine-team-clients-');
  const config: Config = loadConfig({
    home,
    env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0' },
  });
  ensureDirs(config);
  const team = new TeamService(join(config.dataDir, 'team.json'));
  team.upsertUser({ email: YAEL, name: 'Yael', role: 'editor' });
  team.upsertUser({ email: AMIT, name: 'Amit', role: 'editor' });
  const startInbox = async (): Promise<RunningInbox> => ({
    watcher: {} as InboxWatcher,
    summary: {
      created: 0,
      changed: 0,
      removed: 0,
      settled: 0,
      failedMissingExport: 0,
      failedMissingPreview: 0,
      failedFolderRemoved: 0,
      resuming: 0,
      unchanged: 0,
    },
    stop: async () => {},
  });
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    startInbox,
    // No colour-grade skill: no LUT stills written into the temp home after the test removed it.
    builtInLuts: noBuiltInLuts(),
    team,
    remoteAccess: () => ({ hosts: ['studio.tail.ts.net'], logins: [] }),
  });
  engines.push(engine);
  const events: ServerEvent[] = [];
  engine.bus.subscribe((event) => events.push(event));
  const accessChanges = () => events.filter((event) => event.type === 'access.changed').length;
  const makeFolder = (name: string) => mkdirSync(join(config.inboxPath, name), { recursive: true });
  return { engine, config, team, events, accessChanges, makeFolder };
}

describe('a client folder that is gone (C40)', () => {
  it('drops the assignment when the folder is really gone, and tells the browsers', () => {
    const { engine, team, accessChanges } = boot();
    const clientId = clientIdFor('Reused Name');
    engine.clientFolders.add('Reused Name');
    team.setEditors(clientId, 'Reused Name', [YAEL]);

    engine.clientFolders.remove('Reused Name');

    expect(team.editorsOf(clientId)).toEqual([]);
    expect(team.assignments()).toEqual({});
    expect(accessChanges()).toBe(1);
  });

  it('keeps the assignment when the folder is still on the disk (merely unreadable)', () => {
    const { engine, team, accessChanges, makeFolder } = boot();
    const clientId = clientIdFor('Quiet Client');
    makeFolder('Quiet Client');
    engine.clientFolders.add('Quiet Client');
    team.setEditors(clientId, 'Quiet Client', [YAEL]);

    // The watcher could not read it for a moment and dropped it from its list.
    engine.clientFolders.remove('Quiet Client');

    expect(team.editorsOf(clientId)).toEqual([YAEL]);
    expect(accessChanges()).toBe(0);
  });

  it('says nothing for a client nobody was assigned to', () => {
    const { engine, accessChanges } = boot();
    engine.clientFolders.add('Admin Only');
    engine.clientFolders.remove('Admin Only');
    expect(accessChanges()).toBe(0);
  });

  it('starts a client made by someone else with only its creator, not the earlier editors', async () => {
    const { engine, team } = boot();
    const clientId = clientIdFor('Reused Name');
    // The earlier client's leftover (as an older engine would have left it).
    team.setEditors(clientId, 'Reused Name', [YAEL]);

    const res = await engine.app.request('/api/clients', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'tailscale-user-login': AMIT,
        host: 'studio.tail.ts.net',
      },
      body: JSON.stringify({ name: 'Reused Name' }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(team.editorsOf(clientId)).toEqual([AMIT]);
  });
});

describe('start-up check of the assignments (C40)', () => {
  it('drops assignments whose folder is gone and keeps those of folders that are there', async () => {
    const { engine, team, accessChanges, makeFolder } = boot();
    makeFolder('Still Here');
    team.setEditors(clientIdFor('Still Here'), 'Still Here', [YAEL]);
    team.setEditors(clientIdFor('Gone While Off'), 'Gone While Off', [AMIT]);

    await engine.start();

    expect(Object.keys(team.assignments())).toEqual([clientIdFor('Still Here')]);
    expect(accessChanges()).toBe(1);
  });

  it('keeps everything when the inbox cannot be listed', async () => {
    const { engine, team, config } = boot();
    team.setEditors(clientIdFor('Somebody'), 'Somebody', [YAEL]);
    rmSync(config.inboxPath, { recursive: true, force: true });

    await engine.start();

    expect(team.editorsOf(clientIdFor('Somebody'))).toEqual([YAEL]);
  });
});
