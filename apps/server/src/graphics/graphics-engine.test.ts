import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiErrorSchema,
  GRAPHIC_MESSAGES,
  graphicDetailSchema,
  graphicListResponseSchema,
  type ServerEvent,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from '../config.js';
import { memoryDb } from '../db/test-utils.js';
import { createEngine, type Engine } from '../engine.js';
import { RunnerUnavailableError } from '../pipeline/create-runner.js';
import { makeTempDir, noBuiltInLuts } from '../test-temp.js';
import { ScriptedGraphicRunner } from './test-utils.js';

// The graphics engine wired into the real engine (GR1): the multipart route, the worker with an
// injected stand-in runner, the bus, and the folders in the inbox. Nothing is deleted here: a
// delete would move a temp folder into the real ~/.Trash.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function boot(env: Record<string, string>): {
  engine: Engine;
  config: Config;
  runner: ScriptedGraphicRunner;
} {
  const home = makeTempDir('studio-engine-graphics-engine-');
  const config = loadConfig({ home, env });
  ensureDirs(config);
  const runner = new ScriptedGraphicRunner();
  const engine = createEngine({
    builtInLuts: noBuiltInLuts(),
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    createGraphicRunner: () => runner,
    openFolder: async () => {},
  });
  engines.push(engine);
  return { engine, config, runner };
}

describe('the graphics engine in the engine', () => {
  it('makes a graphic from the chat: POST, the run, the version, the events on the bus', async () => {
    const { engine, config, runner } = boot({ STUDIO_GRAPHICS: '1' });
    const events: ServerEvent[] = [];
    engine.bus.subscribe((event) => events.push(event));
    await engine.start();

    const body = new FormData();
    body.append('text', 'A white pill with the name in it');
    body.append('files[]', new File(['png'], 'shot.png'));
    const res = await engine.app.request('/api/graphics', { method: 'POST', body });

    expect(res.status).toBe(201);
    const created = graphicDetailSchema.parse(await res.json());
    expect(created).toMatchObject({ name: 'New graphic', status: 'making', makingVersion: 1 });
    await vi.waitFor(() => expect(engine.graphicsRepo.summary(created.id)?.status).toBe('ready'));

    const listed = graphicListResponseSchema.parse(
      await (await engine.app.request('/api/graphics')).json(),
    );
    expect(listed).toMatchObject([{ id: created.id, name: 'Name on a white pill', version: 1 }]);
    const folder = join(config.inboxPath, '_Graphics', 'Name on a white pill');
    expect(readFileSync(join(folder, 'refs', 'shot.png'), 'utf8')).toBe('png');
    expect(existsSync(join(folder, 'versions', 'v1', 'about.json'))).toBe(true);
    expect(runner.requests[0]).toMatchObject({
      version: 1,
      first: true,
      graphic: { id: created.id },
    });

    const changes = events.filter((event) => event.type === 'graphic.changed');
    expect(changes.length).toBeGreaterThanOrEqual(4);
    expect(changes.at(-1)).toMatchObject({
      graphic: { id: created.id, status: 'ready', name: 'Name on a white pill' },
      message: { status: 'done', text: 'Made v1.' },
    });

    // the change goes on from the version made
    const second = await engine.app.request(`/api/graphics/${created.id}/messages`, {
      method: 'POST',
      body: (() => {
        const form = new FormData();
        form.append('text', 'Make it blue');
        return form;
      })(),
    });
    expect(second.status).toBe(202);
    await vi.waitFor(() => expect(engine.graphicsRepo.get(created.id)?.version).toBe(2));
  });

  it('fails the runs a stopped engine left making when it boots', async () => {
    const { engine } = boot({ STUDIO_GRAPHICS: '1' });
    const graphic = engine.graphicsRepo.create({ name: 'Pill' });
    engine.graphicsRepo.addMessage({ graphicId: graphic.id, role: 'you', text: 'A pill' });
    const left = engine.graphicsRepo.addMessage({
      graphicId: graphic.id,
      role: 'claude',
      version: 1,
      status: 'making',
    });

    await engine.start();

    expect(engine.graphicsRepo.message(left.id)).toMatchObject({
      status: 'failed',
      error: 'The engine stopped while it was making v1. Retry to make it again.',
    });
  });

  it('keeps every graphics route off while the switch is off', async () => {
    const { engine, config } = boot({ STUDIO_GRAPHICS: '0' });
    await engine.start();

    const res = await engine.app.request('/api/graphics', {
      method: 'POST',
      body: (() => {
        const form = new FormData();
        form.append('text', 'A pill');
        return form;
      })(),
    });

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error).toBe(GRAPHIC_MESSAGES.off);
    expect(existsSync(join(config.inboxPath, '_Graphics'))).toBe(false);
  });
});
