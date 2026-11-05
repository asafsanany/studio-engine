import type { ServerEvent } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { createEventBus } from '../events/bus.js';
import { clientIdFor } from '../inbox/scan.js';
import { ClientFolders, compareClientNames } from './client-folders.js';

function setup() {
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  return { folders: new ClientFolders(bus), events };
}

const added = (client: string): ServerEvent => ({
  type: 'client.added',
  clientId: clientIdFor(client),
  client,
});
const removed = (client: string): ServerEvent => ({
  type: 'client.removed',
  clientId: clientIdFor(client),
  client,
});

describe('ClientFolders', () => {
  it('starts empty', () => {
    const { folders, events } = setup();
    expect(folders.list()).toEqual([]);
    expect(folders.find(clientIdFor('Acme'))).toBeNull();
    expect(folders.has('Acme')).toBe(false);
    expect(events).toEqual([]);
  });

  it('adds a client folder, finds it by its id and announces it once', () => {
    const { folders, events } = setup();

    expect(folders.add('Acme')).toBe(true);
    expect(folders.add('Acme')).toBe(false);

    expect(folders.find(clientIdFor('Acme'))).toBe('Acme');
    expect(folders.has('Acme')).toBe(true);
    expect(events).toEqual([added('Acme')]);
  });

  it('lists the folders sorted by name', () => {
    const { folders } = setup();
    for (const name of ['Kova Coffee', 'Arc Fitness', 'מאפיית הצפון', 'Beta']) folders.add(name);

    expect(folders.list()).toEqual(['Arc Fitness', 'Beta', 'Kova Coffee', 'מאפיית הצפון']);
  });

  it('takes the NFC and NFD spellings of a name for one client, and keeps the latest spelling', () => {
    const { folders, events } = setup();
    const nfc = 'Café Müller';
    const nfd = nfc.normalize('NFD');

    expect(folders.add(nfc)).toBe(true);
    expect(folders.add(nfd)).toBe(false);

    expect(folders.list()).toEqual([nfd]);
    expect(folders.find(clientIdFor(nfc))).toBe(nfd);
    expect(folders.has(nfc)).toBe(true);
    expect(events).toEqual([added(nfc)]);
  });

  it('removes a client folder and announces it with the name it was kept under', () => {
    const { folders, events } = setup();
    const nfc = 'Café Müller';
    folders.add(nfc);

    expect(folders.remove(nfc.normalize('NFD'))).toBe(true);
    expect(folders.remove(nfc)).toBe(false);

    expect(folders.list()).toEqual([]);
    expect(events).toEqual([added(nfc), removed(nfc)]);
  });

  it('says nothing about removing a folder it never had', () => {
    const { folders, events } = setup();
    expect(folders.remove('Nobody')).toBe(false);
    expect(events).toEqual([]);
  });

  it('announces a folder that comes back', () => {
    const { folders, events } = setup();
    folders.add('Acme');
    folders.remove('Acme');
    folders.add('Acme');
    expect(events).toEqual([added('Acme'), removed('Acme'), added('Acme')]);
  });

  describe('seed', () => {
    it('fills the list without a word, and replaces what was there', () => {
      const { folders, events } = setup();
      folders.add('Old');
      events.length = 0;

      folders.seed(['Beta', 'Acme']);

      expect(folders.list()).toEqual(['Acme', 'Beta']);
      expect(events).toEqual([]);
    });
  });

  describe('sync', () => {
    it('announces the folders that came and went since the list was made', () => {
      const { folders, events } = setup();
      folders.seed(['Acme', 'Beta']);

      const changes = folders.sync(['Beta', 'Cora']);

      expect(changes).toBe(2);
      expect(folders.list()).toEqual(['Beta', 'Cora']);
      expect(events).toEqual([removed('Acme'), added('Cora')]);
    });

    it('announces nothing when the list is right, even when a name is spelled the other way', () => {
      const { folders, events } = setup();
      folders.seed(['Café']);

      expect(folders.sync(['Café'.normalize('NFD')])).toBe(0);

      expect(folders.list()).toEqual(['Café'.normalize('NFD')]);
      expect(events).toEqual([]);
    });
  });
});

describe('whenSeeded', () => {
  /** Whether `promise` has settled once pending callbacks have run. */
  async function settled(promise: Promise<void>): Promise<boolean> {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return done;
  }

  const booting = () => {
    const folders = new ClientFolders(createEventBus());
    folders.expectSeed();
    return folders;
  };

  it('resolves at once for a set nobody boots', async () => {
    expect(await settled(setup().folders.whenSeeded())).toBe(true);
  });

  it('waits for the boot to list the folders, then resolves at once', async () => {
    const folders = booting();
    const waiting = folders.whenSeeded();
    expect(await settled(waiting)).toBe(false);

    folders.seed(['Acme']);

    expect(await settled(waiting)).toBe(true);
    expect(await settled(folders.whenSeeded())).toBe(true);
  });

  it('takes the sync once the watcher is up as the listing too', async () => {
    const folders = booting();
    const waiting = folders.whenSeeded();

    folders.sync(['Acme']);

    expect(await settled(waiting)).toBe(true);
  });

  it('stops waiting after the cap, so an inbox that cannot be read does not hold the page', async () => {
    const folders = booting();
    const waiting = folders.whenSeeded(5);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await settled(waiting)).toBe(true);
    expect(folders.list()).toEqual([]);
  });
});

describe('compareClientNames', () => {
  it('sorts by code point in NFC, so the spelling does not change the place', () => {
    const names = ['b', 'Écrin'.normalize('NFD'), 'a', 'Zed'];
    expect([...names].sort(compareClientNames)).toEqual([
      'Zed',
      'a',
      'b',
      'Écrin'.normalize('NFD'),
    ]);
  });
});
