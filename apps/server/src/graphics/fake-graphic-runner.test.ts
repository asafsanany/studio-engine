import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GraphicMessage, type GraphicStep, graphicAboutSchema } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Sleep } from '../pipeline/fake-runner.js';
import {
  FAKE_GRAPHIC_FAILURE,
  FAKE_GRAPHIC_KINDS,
  FAKE_GRAPHIC_STEP_MS,
  FAKE_GRAPHIC_STOPPED,
  FakeGraphicRunner,
  fakeGraphicKind,
  GRAPHIC_TESTDATA_DIR,
  GRAPHIC_TESTDATA_ID,
} from './fake-graphic-runner.js';
import { checkGraphicWork } from './graphic-check.js';
import type { GraphicRunRequest } from './graphic-run.js';

const ID = 'feedc0de1234';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-fake-graphic-'));
  mkdirSync(join(dir, 'work'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A sleep that takes no time and remembers how long it was asked to wait. */
function recordingSleep(): { sleep: Sleep; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

function request(
  overrides: Partial<GraphicRunRequest> & { text?: string } = {},
): GraphicRunRequest & { steps: GraphicStep[] } {
  const steps: GraphicStep[] = [];
  const { text = 'A lower third for a name', ...rest } = overrides;
  return {
    graphic: { id: ID, name: 'New graphic', dir },
    message: { id: 'm1', text, refs: [], effort: 'xhigh' },
    version: 1,
    first: true,
    conversation: [],
    signal: new AbortController().signal,
    onStep: (step) => steps.push(step),
    steps,
    ...rest,
  };
}

function work(path: string): string {
  return join(dir, 'work', path);
}

function about() {
  return graphicAboutSchema.parse(JSON.parse(readFileSync(work('about.json'), 'utf8')));
}

describe('the kind from the request', () => {
  it('reads the request’s words like the prototype', () => {
    expect(fakeGraphicKind('A big number that counts up')).toBe('callout');
    expect(fakeGraphicKind('מחיר גדול')).toBe('callout');
    expect(fakeGraphicKind('An opening title that rises word by word')).toBe('title');
    expect(fakeGraphicKind('כותרת פתיחה')).toBe('title');
    expect(fakeGraphicKind('An end card with a Follow button')).toBe('end-card');
    expect(fakeGraphicKind('A lower third for a name')).toBe('lower-third');
    expect(fakeGraphicKind('something else')).toBe('lower-third');
  });
});

describe('a first version', () => {
  it('goes through the steps, about a second each divided by the speed', async () => {
    const { sleep, waits } = recordingSleep();
    const req = request();
    expect(await new FakeGraphicRunner({ speed: 4, sleep }).run(req)).toEqual({ ok: true });
    expect(req.steps).toEqual([1, 2]);
    expect(waits).toEqual([
      FAKE_GRAPHIC_STEP_MS / 4,
      FAKE_GRAPHIC_STEP_MS / 4,
      FAKE_GRAPHIC_STEP_MS / 4,
    ]);
  });

  it.each(FAKE_GRAPHIC_KINDS.map((kind) => [kind]))(
    'writes the canned %s with the graphic’s id and an about.json that passes',
    async (kind) => {
      const { sleep } = recordingSleep();
      const text = {
        'lower-third': 'A lower third: the person’s name on a white pill',
        callout: 'A big number that counts up from zero',
        title: 'An opening title that rises word by word',
        'end-card': 'An end card with a Follow button',
      }[kind];
      expect(await new FakeGraphicRunner({ sleep }).run(request({ text }))).toEqual({ ok: true });

      const html = readFileSync(work(`compositions/lib-${ID}.html`), 'utf8');
      expect(html).not.toContain(GRAPHIC_TESTDATA_ID);
      expect(html).toContain('<template>');
      expect(html).toContain(`<div id="root" data-composition-id="lib-${ID}">`);
      expect(html).toContain(`window.__timelines["lib-${ID}"]`);
      expect(html).not.toMatch(/https?:|url\(["']?\//);

      const answer = about();
      expect(answer.kind).toBe(kind);
      expect(answer.name).toBeTruthy();
      expect(answer.reply).toMatch(/^Made v1\. /);
      expect(html).toContain(`data-duration="${answer.lengthSec}"`);
      const declared = /data-composition-variables='([^']*)'/.exec(html)?.[1] ?? '[]';
      expect((JSON.parse(declared) as { id: string }[]).map((v) => v.id)).toEqual(
        answer.variables.map((v) => v.id),
      );
      // Every file it loads is there, written from the project root.
      const files = [...html.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1] ?? '');
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(file.startsWith(`lib/${ID}/`)).toBe(true);
        expect(existsSync(work(file))).toBe(true);
      }
      // And the engine's own check (GR1) takes it as a version.
      expect(await checkGraphicWork(join(dir, 'work'), ID)).toMatchObject({ ok: true });
    },
  );

  it('fails when the request says fail, with nothing written', async () => {
    const { sleep } = recordingSleep();
    const outcome = await new FakeGraphicRunner({ sleep }).run(
      request({ text: 'Please fail this' }),
    );
    expect(outcome).toEqual({ ok: false, error: FAKE_GRAPHIC_FAILURE });
    expect(existsSync(work('about.json'))).toBe(false);
  });

  it('stops at once when it is aborted, with nothing written', async () => {
    const controller = new AbortController();
    const req = request({ signal: controller.signal });
    const sleep: Sleep = async () => {
      controller.abort();
    };
    expect(await new FakeGraphicRunner({ sleep }).run(req)).toEqual({
      ok: false,
      error: FAKE_GRAPHIC_STOPPED,
    });
    expect(req.steps).toEqual([]);
    expect(existsSync(work('about.json'))).toBe(false);
  });

  it('really waits, and a Stop cuts the wait short', async () => {
    const controller = new AbortController();
    const running = new FakeGraphicRunner({ speed: 0.001 }).run(
      request({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 20);
    expect(await running).toEqual({ ok: false, error: FAKE_GRAPHIC_STOPPED });
  });
});

describe('a change', () => {
  it('keeps the kind in work/, leaves the name out and answers in one line', async () => {
    const { sleep } = recordingSleep();
    writeFileSync(
      work('about.json'),
      readFileSync(join(GRAPHIC_TESTDATA_DIR, 'callout', 'about.json'), 'utf8'),
    );
    const outcome = await new FakeGraphicRunner({ sleep }).run(
      request({ text: 'make it dark', version: 2, first: false }),
    );
    expect(outcome).toEqual({ ok: true });
    const answer = about();
    expect(answer.kind).toBe('callout');
    expect(answer.name).toBeUndefined();
    expect(answer.reply).toBe(
      'Made v2: this stand-in run keeps the graphic as it was, for “make it dark”.',
    );
  });

  it('takes the kind from the first request when work/ has no about.json', async () => {
    const { sleep } = recordingSleep();
    const first: GraphicMessage = {
      id: 'm0',
      role: 'you',
      text: 'An end card with a Follow button',
      refs: [],
      effort: null,
      version: null,
      status: null,
      step: null,
      error: null,
      startedAt: null,
      endedAt: null,
      createdAt: '2026-10-22T10:00:00.000Z',
    };
    await new FakeGraphicRunner({ sleep }).run(
      request({ text: 'slower and higher', version: 2, first: false, conversation: [first] }),
    );
    expect(about().kind).toBe('end-card');
  });
});
