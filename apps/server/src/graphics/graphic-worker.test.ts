import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  freeGraphicName,
  GRAPHIC_MESSAGES,
  type GraphicChangedEvent,
  graphicStepSchema,
  graphicStoppedByEngineMessage,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredGraphicMessage } from '../db/index.js';
import { graphicVersionDir, graphicWorkDir } from './graphic-folders.js';
import { GraphicWorker } from './graphic-worker.js';
import {
  type GraphicHarness,
  type HarnessOptions,
  makeHarness,
  writeCannedGraphic,
} from './test-utils.js';

// The graphic worker (GR1) with the real repository (in memory), folders (a temp inbox) and a
// stand-in runner the test drives. The service is not in play here: the test makes the rows the
// service would make and queues them.

const harnesses: GraphicHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

function harness(options: HarnessOptions = {}): GraphicHarness {
  const made = makeHarness(options);
  harnesses.push(made);
  return made;
}

/** A graphic with the owner's message and Claude's making row for `version`, queued. */
async function ask(
  h: GraphicHarness,
  graphicId: string | null,
  text = 'A white pill with the name in it',
  version = 1,
): Promise<{ graphicId: string; messageId: string }> {
  let id = graphicId;
  if (id === null) {
    const graphic = h.repo.create({ name: freeGraphicName('New graphic', h.repo.liveNames()) });
    await h.folders.create(graphic.folder);
    id = graphic.id;
  }
  h.repo.addMessage({ graphicId: id, role: 'you', text, effort: 'high' });
  const making = h.repo.addMessage({
    graphicId: id,
    role: 'claude',
    version,
    status: 'making',
    step: 0,
  });
  h.worker.enqueue(id, making.id);
  return { graphicId: id, messageId: making.id };
}

/** Waits until Claude's row is no longer making. */
async function ended(h: GraphicHarness, messageId: string): Promise<StoredGraphicMessage> {
  await vi.waitFor(() => expect(h.repo.message(messageId)?.status).not.toBe('making'));
  return h.repo.message(messageId) as StoredGraphicMessage;
}

const changed = (h: GraphicHarness): GraphicChangedEvent[] =>
  h.events.filter((event): event is GraphicChangedEvent => event.type === 'graphic.changed');

describe('a run that makes a version', () => {
  it('makes v1: steps on the row, then the version, the fields of about.json and the name', async () => {
    const h = harness();
    const { graphicId, messageId } = await ask(h, null);

    const row = await ended(h, messageId);

    expect(row).toMatchObject({
      status: 'done',
      text: 'Made v1.',
      step: null,
      error: null,
      version: 1,
    });
    expect(row.startedAt).not.toBeNull();
    expect(row.endedAt).not.toBeNull();
    const graphic = h.repo.get(graphicId);
    expect(graphic).toMatchObject({
      name: 'Name on a white pill',
      folder: 'Name on a white pill',
      version: 1,
      kind: 'lower-third',
      lengthSec: 3,
      variables: [{ id: 'name', label: 'Name', default: 'Dana Levy' }],
      when: 'The first time a person is named on camera.',
      whenEdited: false,
    });
    // the folder moved with the name, and v1 is a whole project in it
    expect(await h.folders.names()).toEqual(['Name on a white pill']);
    const v1 = graphicVersionDir(h.folders.dirOf('Name on a white pill'), 1);
    expect(existsSync(join(v1, 'compositions', `lib-${graphicId}.html`))).toBe(true);
    expect(existsSync(join(v1, 'vendor', 'gsap.min.js'))).toBe(true);
    expect(readFileSync(join(v1, 'index.html'), 'utf8')).toContain(`lib-${graphicId}`);
    expect(h.repo.summary(graphicId)).toMatchObject({ status: 'ready', makingVersion: null });
  });

  it('tells the run what it needs: the graphic, the owner’s message at its effort, v1, no earlier chat', async () => {
    const h = harness();
    const { graphicId } = await ask(h, null, 'A lower third, please');
    await vi.waitFor(() => expect(h.runner.requests).toHaveLength(1));
    const request = h.runner.requests[0];

    expect(request).toMatchObject({
      graphic: { id: graphicId, name: 'New graphic', dir: h.folders.dirOf('New graphic') },
      message: { text: 'A lower third, please', refs: [], effort: 'high' },
      version: 1,
      first: true,
      conversation: [],
    });
    expect(request?.signal.aborted).toBe(false);
  });

  it('prepares work/ before the run: the host, GSAP and a fresh copy of the shared fonts', async () => {
    const h = harness();
    mkdirSync(join(h.inbox, '_Fonts'), { recursive: true });
    writeFileSync(join(h.inbox, '_Fonts', 'Heebo-Bold.ttf'), 'heebo');
    let seen: string[] = [];
    h.runner.behaviour = async (request) => {
      const work = graphicWorkDir(request.graphic.dir);
      seen = [...readdirSync(work), ...readdirSync(join(request.graphic.dir, 'fonts'))];
      writeCannedGraphic(work, request.graphic.id, 1, { name: 'Pill' });
      return { ok: true };
    };
    const { messageId } = await ask(h, null);

    await ended(h, messageId);

    expect(seen.sort()).toEqual(['Heebo-Bold.ttf', 'index.html', 'vendor']);
  });

  it('publishes graphic.changed for the start, each step and the end, with the message that moved', async () => {
    const h = harness();
    const { graphicId, messageId } = await ask(h, null);
    await ended(h, messageId);

    const events = changed(h).filter((event) => event.message?.id === messageId);
    expect(events.every((event) => event.graphic.id === graphicId)).toBe(true);
    const steps = events.map((event) => event.message?.step);
    expect(steps).toEqual([0, 1, 2, null]);
    expect(events.map((event) => event.graphic.status)).toEqual([
      'making',
      'making',
      'making',
      'ready',
    ]);
    for (const step of steps.filter((step) => step !== null)) {
      expect(graphicStepSchema.safeParse(step).success).toBe(true);
    }
    expect(events.at(-1)?.message).toMatchObject({ status: 'done', text: 'Made v1.' });
    expect(events.at(-1)?.graphic).toMatchObject({ name: 'Name on a white pill', version: 1 });
  });

  it('makes a change as v2 from v1, with the chat so far, and keeps the name and the owner’s When line', async () => {
    const h = harness();
    const first = await ask(h, null);
    await ended(h, first.messageId);
    h.repo.setWhen(first.graphicId, 'When a name appears on screen.');
    h.runner.canned = (request) => ({
      reply: `Made v${request.version}.`,
      kind: 'callout',
      when: 'Elsewhere.',
    });

    const second = await ask(h, first.graphicId, 'Make it blue', 2);
    const row = await ended(h, second.messageId);

    expect(row).toMatchObject({ status: 'done', text: 'Made v2.', version: 2 });
    const request = h.runner.requests[1];
    expect(request).toMatchObject({ version: 2, first: false, message: { text: 'Make it blue' } });
    expect(request?.conversation.map((message) => message.role)).toEqual(['you', 'claude']);
    expect(request?.conversation[1]).toMatchObject({ text: 'Made v1.', status: 'done' });
    expect(h.repo.get(first.graphicId)).toMatchObject({
      name: 'Name on a white pill',
      version: 2,
      kind: 'callout',
      when: 'When a name appears on screen.',
      whenEdited: true,
    });
    const folder = h.folders.dirOf('Name on a white pill');
    expect(readdirSync(join(folder, 'versions')).sort()).toEqual(['v1', 'v2']);
    // v1 is as it was made
    expect(
      JSON.parse(readFileSync(join(graphicVersionDir(folder, 1), 'about.json'), 'utf8')).reply,
    ).toBe('Made v1.');
  });

  it('writes the version’s host for the length the run settled on', async () => {
    const h = harness();
    h.runner.canned = () => ({ name: 'Pill', lengthSec: 5 });
    const { messageId } = await ask(h, null);
    await ended(h, messageId);

    const host = readFileSync(
      join(graphicVersionDir(h.folders.dirOf('Pill'), 1), 'index.html'),
      'utf8',
    );
    expect(host).toContain('data-duration="5.8"');
  });

  it('gives the name from about.json a free one when another graphic has it', async () => {
    const h = harness();
    h.repo.create({ name: 'name on a WHITE pill' });
    const { graphicId, messageId } = await ask(h, null);

    await ended(h, messageId);

    expect(h.repo.get(graphicId)?.name).toBe('Name on a white pill (2)');
    expect(await h.folders.has('Name on a white pill (2)')).toBe(true);
  });

  it('keeps a name the owner could have chosen: only "New graphic …" is named by the run', async () => {
    const h = harness();
    const graphic = h.repo.create({ name: 'My pill' });
    await h.folders.create('My pill');
    const { messageId } = await ask(h, graphic.id);

    await ended(h, messageId);

    expect(h.repo.get(graphic.id)).toMatchObject({ name: 'My pill', folder: 'My pill' });
  });
});

describe('a run that does not make a version', () => {
  it('fails with the run’s error and keeps the version it had', async () => {
    const h = harness();
    const first = await ask(h, null);
    await ended(h, first.messageId);
    h.runner.behaviour = async () => ({ ok: false, error: 'Claude could not finish it.' });

    const second = await ask(h, first.graphicId, 'Make it blue', 2);
    const row = await ended(h, second.messageId);

    expect(row).toMatchObject({
      status: 'failed',
      error: 'Claude could not finish it.',
      step: null,
    });
    expect(h.repo.get(first.graphicId)?.version).toBe(1);
    expect(h.repo.summary(first.graphicId)).toMatchObject({
      status: 'failed',
      failedVersion: 2,
      version: 1,
    });
    expect(existsSync(graphicVersionDir(h.folders.dirOf('Name on a white pill'), 2))).toBe(false);
    expect(changed(h).at(-1)?.message).toMatchObject({ status: 'failed' });
  });

  it('fails with the check’s sentence, and makes no version', async () => {
    const h = harness();
    const { graphicId, messageId } = await ask(h, null);
    await ended(h, messageId);

    // a run that leaves a graphic without its timeline
    h.runner.behaviour = async (request) => {
      writeCannedGraphic(graphicWorkDir(request.graphic.dir), request.graphic.id, 2, {
        reply: 'Made v2.',
      });
      writeFileSync(
        join(graphicWorkDir(request.graphic.dir), 'compositions', `lib-${request.graphic.id}.html`),
        '<div>no template</div>',
      );
      return { ok: true };
    };
    const second = await ask(h, graphicId, 'Make it blue', 2);
    const row = await ended(h, second.messageId);

    expect(row.status).toBe('failed');
    expect(row.error).toContain('has no <template>');
    expect(h.repo.get(graphicId)?.version).toBe(1);
    expect(existsSync(graphicVersionDir(h.folders.dirOf('Name on a white pill'), 2))).toBe(false);
  });

  it('uses the check it is given', async () => {
    const check = vi.fn(async () => ({ ok: false as const, error: 'Not good enough.' }));
    const h = harness();
    const worker = new GraphicWorker({
      repo: h.repo,
      folders: h.folders,
      runner: h.runner,
      publish: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      check,
    });
    worker.start();
    const graphic = h.repo.create({ name: 'New graphic' });
    await h.folders.create(graphic.folder);
    h.repo.addMessage({ graphicId: graphic.id, role: 'you', text: 'x' });
    const making = h.repo.addMessage({
      graphicId: graphic.id,
      role: 'claude',
      version: 1,
      status: 'making',
    });
    worker.enqueue(graphic.id, making.id);

    const row = await ended(h, making.id);

    expect(check).toHaveBeenCalledWith(graphicWorkDir(h.folders.dirOf('New graphic')), graphic.id);
    expect(row).toMatchObject({ status: 'failed', error: 'Not good enough.' });
    await worker.stop();
  });

  it('fails a run that writes no about.json', async () => {
    const h = harness();
    h.runner.behaviour = async () => ({ ok: true });
    const { messageId } = await ask(h, null);

    const row = await ended(h, messageId);

    expect(row).toMatchObject({
      status: 'failed',
      error: 'The run finished without writing a new about.json.',
    });
  });

  it('fails a change that leaves about.json as the last version had it', async () => {
    const h = harness();
    const first = await ask(h, null);
    await ended(h, first.messageId);
    h.runner.behaviour = async () => ({ ok: true });

    const second = await ask(h, first.graphicId, 'Make it blue', 2);
    const row = await ended(h, second.messageId);

    expect(row).toMatchObject({
      status: 'failed',
      error: 'The run finished without writing a new about.json.',
    });
    expect(h.repo.get(first.graphicId)?.version).toBe(1);
  });

  it('fails with a plain sentence when the run throws', async () => {
    const h = harness();
    h.runner.behaviour = async () => {
      throw new Error('spawn claude ENOENT');
    };
    const { messageId } = await ask(h, null);

    const row = await ended(h, messageId);

    expect(row).toMatchObject({
      status: 'failed',
      error: 'The graphic could not be made: spawn claude ENOENT.',
    });
  });

  it('fails a version whose folder is gone, without running anything', async () => {
    const h = harness();
    const first = await ask(h, null);
    await ended(h, first.messageId);
    rmSync(graphicVersionDir(h.folders.dirOf('Name on a white pill'), 1), { recursive: true });

    const second = await ask(h, first.graphicId, 'Make it blue', 2);
    const row = await ended(h, second.messageId);

    expect(row.status).toBe('failed');
    expect(row.error).toContain('v1 is not in the graphic');
    expect(h.runner.requests).toHaveLength(1);
  });

  it('fails a run that takes too long, with the words for it', async () => {
    const h = harness({ timeoutMs: 40 });
    h.runner.behaviour = async (_request, control) => {
      await control.hold();
      return { ok: false, error: 'Stopped.' };
    };
    const { messageId } = await ask(h, null);

    const row = await ended(h, messageId);

    expect(row).toMatchObject({ status: 'failed', error: GRAPHIC_MESSAGES.timedOut });
    expect(h.runner.requests[0]?.signal.aborted).toBe(true);
  });
});

describe('stop', () => {
  it('aborts the run, and the row becomes stopped with work/ left as it is', async () => {
    const h = harness({ holdAll: true });
    const { graphicId, messageId } = await ask(h, null);
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));

    const stopped = await h.worker.stopRun(graphicId, messageId);

    expect(stopped).toBe(true);
    expect(h.runner.requests[0]?.signal.aborted).toBe(true);
    expect(h.repo.message(messageId)).toMatchObject({ status: 'stopped', step: null });
    expect(h.worker.isMaking(graphicId)).toBe(false);
    // a first run that was stopped leaves an empty graphic, which the list does not show
    expect(h.repo.summary(graphicId)).toMatchObject({ status: 'empty' });
    expect(existsSync(join(graphicWorkDir(h.folders.dirOf('New graphic')), 'index.html'))).toBe(
      true,
    );
    expect(changed(h).at(-1)?.message).toMatchObject({ id: messageId, status: 'stopped' });
  });

  it('does not make a version of a run that ended well just as it was stopped', async () => {
    const h = harness();
    h.runner.behaviour = async (request, control) => {
      await control.hold();
      writeCannedGraphic(graphicWorkDir(request.graphic.dir), request.graphic.id, 1, {
        name: 'Pill',
      });
      return { ok: true };
    };
    const { graphicId, messageId } = await ask(h, null);
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));

    await h.worker.stopRun(graphicId, messageId);

    expect(h.repo.message(messageId)?.status).toBe('stopped');
    expect(h.repo.get(graphicId)?.version).toBeNull();
    expect(await h.folders.names()).toEqual(['New graphic']);
  });

  it('takes a run that is waiting for its turn out of the line', async () => {
    const h = harness({ holdAll: true, concurrency: 1 });
    const running = await ask(h, null);
    const waiting = await ask(h, null);
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));

    expect(await h.worker.stopRun(waiting.graphicId, waiting.messageId)).toBe(true);

    expect(h.repo.message(waiting.messageId)).toMatchObject({ status: 'stopped', startedAt: null });
    expect(h.worker.isMaking(waiting.graphicId)).toBe(false);
    h.runner.releaseAll();
    await ended(h, running.messageId);
    expect(h.runner.requests).toHaveLength(1);
  });

  it('knows nothing of a run that is not there', async () => {
    const h = harness();
    expect(await h.worker.stopRun('0a1b2c3d4e5f', 'nope')).toBe(false);
  });
});

describe('retry', () => {
  it('runs the same message again as a new attempt', async () => {
    const h = harness();
    h.runner.behaviour = async () => ({ ok: false, error: 'It broke.' });
    const { graphicId, messageId } = await ask(h, null);
    await ended(h, messageId);
    h.runner.behaviour = undefined;

    // what the service does for Retry: the row goes back to making, and is queued
    h.repo.updateMessage(messageId, {
      status: 'making',
      step: 0,
      error: null,
      text: '',
      startedAt: null,
      endedAt: null,
    });
    h.worker.enqueue(graphicId, messageId);
    const row = await ended(h, messageId);

    expect(row).toMatchObject({ status: 'done', error: null, version: 1 });
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]?.message.text).toBe(h.runner.requests[0]?.message.text);
    expect(h.repo.get(graphicId)?.version).toBe(1);
  });
});

describe('the queue', () => {
  it('runs at most two at once, and the third when one is over', async () => {
    const h = harness({ holdAll: true });
    const a = await ask(h, null);
    const b = await ask(h, null);
    const c = await ask(h, null);

    await vi.waitFor(() => expect(h.runner.held).toHaveLength(2));
    expect(h.runner.active).toBe(2);
    expect(h.worker.isMaking(c.graphicId)).toBe(true);
    expect(h.repo.message(c.messageId)).toMatchObject({ status: 'making', startedAt: null });

    h.runner.holdAll = false;
    h.runner.releaseAll();

    for (const run of [a, b, c]) {
      expect(await ended(h, run.messageId)).toMatchObject({ status: 'done' });
    }
    expect(h.runner.peak).toBe(2);
    expect(h.runner.requests).toHaveLength(3);
  });

  it('runs one at a time per graphic', async () => {
    const h = harness({ holdAll: true });
    const { graphicId } = await ask(h, null);

    expect(() => h.worker.enqueue(graphicId, 'another')).toThrow(/already being made/);
  });

  it('knows which message of a graphic is being made', async () => {
    const h = harness({ holdAll: true });
    const { graphicId, messageId } = await ask(h, null);

    expect(h.worker.makingMessageOf(graphicId)).toBe(messageId);
    expect(h.worker.makingMessageOf('0a1b2c3d4e5f')).toBeNull();
  });

  it('skips a run whose graphic was deleted while it waited', async () => {
    const h = harness({ holdAll: true, concurrency: 1 });
    const running = await ask(h, null);
    const waiting = await ask(h, null);
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));
    h.repo.softDelete(waiting.graphicId);

    h.runner.holdAll = false;
    h.runner.releaseAll();
    await ended(h, running.messageId);

    await vi.waitFor(() => expect(h.worker.isMaking(waiting.graphicId)).toBe(false));
    expect(h.runner.requests).toHaveLength(1);
  });
});

describe('boot and shutdown', () => {
  it('fails the rows a stopped engine left making, with the words for it', async () => {
    const h = harness();
    const graphic = h.repo.create({ name: 'Pill' });
    h.repo.addMessage({ graphicId: graphic.id, role: 'you', text: 'x' });
    const left = h.repo.addMessage({
      graphicId: graphic.id,
      role: 'claude',
      version: 3,
      status: 'making',
      step: 1,
      startedAt: '2026-10-22T10:00:00.000Z',
    });
    h.events.length = 0;

    h.worker.start();

    expect(h.repo.message(left.id)).toMatchObject({
      status: 'failed',
      step: null,
      error: graphicStoppedByEngineMessage(3),
    });
    expect(h.repo.message(left.id)?.error).toBe(
      'The engine stopped while it was making v3. Retry to make it again.',
    );
    expect(h.repo.summary(graphic.id)).toMatchObject({ status: 'failed', failedVersion: 3 });
    expect(changed(h)).toHaveLength(1);
    expect(changed(h)[0]?.message).toMatchObject({ id: left.id, status: 'failed' });
  });

  it('leaves the runs it is making alone when started again', async () => {
    const h = harness({ holdAll: true });
    const { messageId } = await ask(h, null);
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));

    h.worker.start();

    expect(h.repo.message(messageId)?.status).toBe('making');
  });

  it('stops every run on shutdown, the waiting ones too, and takes no more', async () => {
    const h = harness({ holdAll: true, concurrency: 1 });
    const running = await ask(h, null);
    const waiting = await ask(h, null);
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));

    await h.worker.stop();

    expect(h.repo.message(running.messageId)?.status).toBe('stopped');
    expect(h.repo.message(waiting.messageId)).toMatchObject({ status: 'stopped', startedAt: null });
    expect(h.runner.requests).toHaveLength(1);
    expect(h.runner.requests[0]?.signal.aborted).toBe(true);
    expect(() => h.worker.enqueue(running.graphicId, 'again')).toThrow(/shutting down/);
  });

  it('clears the uploads a stopped engine left behind when it starts', async () => {
    const h = harness();
    const staging = await h.folders.stagingDir();
    const old = new Date(Date.now() - 24 * 3600 * 1000);
    utimesSync(staging, old, old);

    h.worker.start();

    await vi.waitFor(() => expect(existsSync(staging)).toBe(false));
  });

  it('names the runner it drives', () => {
    expect(harness().worker.runnerKind).toBe('fake');
  });
});

describe('the runs an earlier engine left running', () => {
  /** A worker on the harness's repository and folders that reaps with `reapRuns` at its start. */
  function reaping(
    h: GraphicHarness,
    reapRuns: () => Promise<{ jobId: string; pid: number; processes: number }[]>,
  ) {
    return new GraphicWorker({
      repo: h.repo,
      folders: h.folders,
      runner: h.runner,
      publish: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      reapRuns,
    });
  }

  it('are stopped at the start, and no run begins before that is done', async () => {
    const h = harness();
    let finished!: () => void;
    const reap = vi.fn(
      () =>
        new Promise<{ jobId: string; pid: number; processes: number }[]>((resolve) => {
          finished = () => resolve([{ jobId: 'g1', pid: 4242, processes: 2 }]);
        }),
    );
    const worker = reaping(h, reap);
    worker.start();
    const graphic = h.repo.create({ name: freeGraphicName('New graphic', h.repo.liveNames()) });
    await h.folders.create(graphic.folder);
    h.repo.addMessage({ graphicId: graphic.id, role: 'you', text: 'A pill' });
    const making = h.repo.addMessage({
      graphicId: graphic.id,
      role: 'claude',
      version: 1,
      status: 'making',
      step: 0,
    });

    worker.enqueue(graphic.id, making.id);
    expect(reap).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.runner.requests).toHaveLength(0);

    finished();

    await vi.waitFor(() => expect(h.runner.requests).toHaveLength(1));
    await vi.waitFor(() => expect(h.repo.message(making.id)?.status).not.toBe('making'));
    await worker.stop();
  });

  it('do not hold the queue when stopping them fails', async () => {
    const h = harness();
    const worker = reaping(h, () => Promise.reject(new Error('no ps')));
    worker.start();
    const graphic = h.repo.create({ name: 'Pill' });
    await h.folders.create(graphic.folder);
    h.repo.addMessage({ graphicId: graphic.id, role: 'you', text: 'A pill' });
    const making = h.repo.addMessage({
      graphicId: graphic.id,
      role: 'claude',
      version: 1,
      status: 'making',
      step: 0,
    });

    worker.enqueue(graphic.id, making.id);

    await vi.waitFor(() => expect(h.runner.requests).toHaveLength(1));
    await worker.stop();
  });
});
