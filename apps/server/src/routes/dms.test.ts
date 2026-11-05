import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DmItem, DmsResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '../test-temp.js';
import { createDmsRoutes } from './dms.js';

// The DMs page's routes over a stand-in inbox: what it answers is the inbox's, and the files are
// served from its files folder only.

function item(over: Partial<DmItem>): DmItem {
  return {
    id: 'm1:0',
    messageId: 'm1',
    at: '2026-10-30T10:00:00.000Z',
    from: 'owner_account',
    kind: 'reel',
    title: 'Gym hook',
    text: null,
    link: null,
    file: null,
    missing: null,
    ...over,
  };
}

function setup(items: DmItem[]) {
  const filesDir = makeTempDir('studio-engine-dms-files-');
  const answer: DmsResponse = {
    connection: {
      state: 'connected',
      account: 'studio_account',
      from: ['owner_account'],
      checkedAt: '2026-10-30T10:10:00.000Z',
      error: null,
      everySecs: 60,
    },
    items,
  };
  let checks = 0;
  const revealed: string[] = [];
  const app = createDmsRoutes({
    inbox: {
      filesDir,
      read: () => answer,
      check: async () => {
        checks += 1;
        return answer;
      },
      item: (id) => items.find((known) => known.id === id),
    },
    revealFile: async (path) => {
      revealed.push(path);
    },
  });
  return { app, filesDir, revealed, checks: () => checks };
}

describe('/api/dms', () => {
  it('answers the connection and the items, and checks on POST /check', async () => {
    const { app, checks } = setup([item({})]);
    const listed = await app.request('/');
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as DmsResponse).items).toHaveLength(1);
    const checked = await app.request('/check', { method: 'POST' });
    expect(checked.status).toBe(200);
    expect(checks()).toBe(1);
  });

  it('serves a downloaded file with ranges, and only files the items name', async () => {
    const file = { name: '2026-10-30-reel-0123456789.mp4', contentType: 'video/mp4', bytes: 10 };
    const { app, filesDir } = setup([item({ file })]);
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, file.name), '0123456789');
    writeFileSync(join(filesDir, 'other.mp4'), 'x');

    const whole = await app.request(`/file/${file.name}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(await whole.text()).toBe('0123456789');

    const part = await app.request(`/file/${file.name}`, { headers: { Range: 'bytes=2-4' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('234');

    expect((await app.request('/file/other.mp4')).status).toBe(404);
    expect((await app.request('/file/..%2Fsecret')).status).toBe(404);
  });

  it('shows an item’s file in Finder, and says why it cannot', async () => {
    const file = { name: 'a.mp4', contentType: 'video/mp4', bytes: 1 };
    const { app, filesDir, revealed } = setup([
      item({ id: 'm1:0', file }),
      item({ id: 'm2:0', kind: 'link', file: null }),
      item({ id: 'm3:0', file: { ...file, name: 'gone.mp4' } }),
    ]);
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, 'a.mp4'), 'x');

    const ok = await app.request(`/${encodeURIComponent('m1:0')}/reveal`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(revealed).toHaveLength(1);
    expect(revealed[0]?.endsWith('a.mp4')).toBe(true);

    const noFile = await app.request(`/${encodeURIComponent('m2:0')}/reveal`, { method: 'POST' });
    expect(noFile.status).toBe(404);
    expect(await noFile.json()).toEqual({ error: 'This item has no file.' });
    const gone = await app.request(`/${encodeURIComponent('m3:0')}/reveal`, { method: 'POST' });
    expect(await gone.json()).toEqual({ error: 'The file is gone.' });
    const unknown = await app.request('/nope/reveal', { method: 'POST' });
    expect(await unknown.json()).toEqual({ error: 'No such DM item.' });
  });
});
