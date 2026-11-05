import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFakePreview } from '../pipeline/fake-preview.js';
import { ClaudeQuickFixRunner } from './claude-quick-fix.js';
import { createQuickFixRunner } from './create-quick-fix-runner.js';
import {
  FAKE_QUICK_FIX_STEP_MS,
  FAKE_QUICK_FIX_STOPPED,
  FakeQuickFixRunner,
  fakeQuickFixChange,
  solidPng,
} from './fake-quick-fix.js';
import { fixDirPath } from './quick-fix-files.js';
import type { QuickFixRequest, QuickFixStep } from './quick-fix-run.js';

// The stand-in quick fix on a fake job's composition (the sample of fake-preview.ts).

const FIX_ID = 'fix-1';

let root: string;
let jobDir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'studio-fake-quick-fix-'));
  jobDir = join(root, 'Acme Studio', 'Launch teaser');
  mkdirSync(join(jobDir, 'edit'), { recursive: true });
  await writeFakePreview(join(jobDir, 'edit'), 'Launch teaser');
  writeFileSync(join(jobDir, 'edit', 'project.md'), '# Launch teaser\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const indexPath = () => join(jobDir, 'edit', 'preview', 'index.html');
const readIndex = () => readFileSync(indexPath(), 'utf8');
const titleRule = (html: string) => /#title\s*\{[^}]*\}/.exec(html)?.[0] ?? '';

function runner(options: { sleeps?: number[]; speed?: number } = {}) {
  return new FakeQuickFixRunner({
    config: { inboxPath: root },
    speed: options.speed,
    sleep: async (ms) => {
      options.sleeps?.push(ms);
    },
  });
}

function request(
  text: string | null,
  overrides: Partial<QuickFixRequest> = {},
): QuickFixRequest & { steps: [QuickFixStep, string][] } {
  const steps: [QuickFixStep, string][] = [];
  return {
    job: {
      id: 'job-1',
      client: 'Acme Studio',
      name: 'Launch teaser',
      relPath: 'Acme Studio/Launch teaser',
    },
    note: {
      id: 'note-1',
      atSec: 3,
      text,
      route: { tier: 'quick', kind: 'Changing the title', why: '' },
    },
    fix: { id: FIX_ID, round: 2 },
    signal: new AbortController().signal,
    onStep: (step, label) => steps.push([step, label]),
    steps,
    ...overrides,
  };
}

describe('what it changes', () => {
  it.each([
    ['change the font to Heebo', 'Georgia', 'The font is Georgia now.'],
    ['make the title yellow', 'color: #ffd60a', 'The title is yellow now.'],
    ['the title should be bigger', '120px', 'The title is bigger now.'],
    ['move the title higher', 'top: 200px', 'The title is higher now.'],
    ['remove the title', 'display: none', 'The title is hidden now.'],
  ])('"%s" changes the rule of #title', async (note, expected, said) => {
    const before = titleRule(readIndex());
    const outcome = await runner().run(request(note));

    expect(outcome).toEqual({ status: 'fixed', said, hasCompare: true });
    const after = titleRule(readIndex());
    expect(after).not.toBe(before);
    expect(after).toContain(expected);
  });

  it('leaves every other byte of the composition as it was', async () => {
    const original = readIndex();
    await runner().run(request('make the title yellow'));
    expect(readIndex()).toBe(original.replace('color: #fff', 'color: #ffd60a'));
  });

  it('writes a small before and after PNG, reply.json and a line in project.md', async () => {
    await runner().run(request('make the title yellow'));
    const fix = join(jobDir, fixDirPath(FIX_ID));
    const before = readFileSync(join(fix, 'before.png'));
    const after = readFileSync(join(fix, 'after.png'));
    expect(before.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(before.equals(after)).toBe(false);
    expect(before.length).toBeLessThan(2_000);
    expect(JSON.parse(readFileSync(join(fix, 'reply.json'), 'utf8'))).toEqual({
      done: true,
      said: 'The title is yellow now.',
    });
    expect(existsSync(join(fix, 'stills'))).toBe(false);
    expect(readFileSync(join(jobDir, 'edit', 'project.md'), 'utf8')).toBe(
      '# Launch teaser\n\n## Round 2 · fixed in Review\n- The title is yellow now.\n',
    );
  });

  it('adds a second line under the same heading', async () => {
    await runner().run(request('make the title yellow'));
    await runner().run(request('the title should be bigger', { fix: { id: 'fix-2', round: 2 } }));
    expect(readFileSync(join(jobDir, 'edit', 'project.md'), 'utf8')).toBe(
      '# Launch teaser\n\n## Round 2 · fixed in Review\n- The title is yellow now.\n- The title is bigger now.\n',
    );
  });
});

describe('what it cannot do', () => {
  it('answers done: false for the sign, and changes nothing', async () => {
    const original = readIndex();
    const outcome = await runner().run(request('the sign says the wrong thing'));
    expect(outcome).toEqual({
      status: 'escalated',
      why: 'the sign is part of the footage',
      hasCompare: true,
    });
    expect(readIndex()).toBe(original);
  });

  it('answers done: false for a note with none of its words', async () => {
    expect(await runner().run(request('swap this shot for the drone shot'))).toMatchObject({
      status: 'escalated',
      why: 'the stand-in does not know that one',
    });
  });

  it('says nothing changed when the change is already there', async () => {
    await runner().run(request('make the title yellow'));
    expect(
      await runner().run(request('make the title yellow', { fix: { id: 'fix-2', round: 2 } })),
    ).toMatchObject({ status: 'escalated', why: 'nothing changed' });
  });

  it('fails when there is no preview, or the note has no words', async () => {
    expect(await runner().run(request(null))).toMatchObject({
      status: 'failed',
      why: 'the note has no words yet',
    });
    rmSync(join(jobDir, 'edit', 'preview'), { recursive: true });
    expect(await runner().run(request('make the title yellow'))).toMatchObject({
      status: 'failed',
      why: 'there is no preview to change',
    });
  });

  it('answers that there is no title when the composition has none', async () => {
    writeFileSync(indexPath(), '<html><body>no title rule here</body></html>');
    expect(await runner().run(request('make the title yellow'))).toMatchObject({
      status: 'escalated',
      why: 'there is no title to change',
    });
  });
});

describe('its pace and steps', () => {
  it('goes through the four steps in about 2 s, saying each with the note’s kind', async () => {
    const sleeps: number[] = [];
    const req = request('make the title yellow');
    await runner({ sleeps }).run(req);
    expect(req.steps).toEqual([
      [0, 'Reading the edit'],
      [1, 'Changing the title'],
      [2, 'Checking it'],
      [3, 'Looking at the frames'],
    ]);
    expect(sleeps).toEqual([500, 500, 500, 500]);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(4 * FAKE_QUICK_FIX_STEP_MS);
  });

  it('is faster at STUDIO_FAKE_SPEED', async () => {
    const sleeps: number[] = [];
    await runner({ sleeps, speed: 10 }).run(request('make the title yellow'));
    expect(sleeps).toEqual([50, 50, 50, 50]);
  });

  it('stops at once on an abort, with nothing changed and no answer', async () => {
    const original = readIndex();
    const controller = new AbortController();
    const slow = new FakeQuickFixRunner({
      config: { inboxPath: root },
      sleep: async () => {
        controller.abort();
      },
    });
    expect(await slow.run(request('make the title yellow', { signal: controller.signal }))).toEqual(
      {
        status: 'failed',
        why: FAKE_QUICK_FIX_STOPPED,
        hasCompare: false,
      },
    );
    expect(readIndex()).toBe(original);
    expect(existsSync(join(jobDir, fixDirPath(FIX_ID), 'reply.json'))).toBe(false);
  });

  it('does not start when it is aborted already', async () => {
    const controller = new AbortController();
    controller.abort();
    const req = request('make the title yellow', { signal: controller.signal });
    expect(await runner().run(req)).toMatchObject({
      status: 'failed',
      why: FAKE_QUICK_FIX_STOPPED,
    });
    expect(req.steps).toEqual([]);
  });
});

describe('fakeQuickFixChange', () => {
  it('reads the words of a note, the sign first', () => {
    const said = (text: string) => {
      const change = fakeQuickFixChange(text);
      return 'said' in change ? change.said : `cannot: ${change.why}`;
    };
    expect(said('remove the sign')).toBe('cannot: the sign is part of the footage');
    expect(said('remove the title')).toBe('The title is hidden now.');
    expect(said('a different FONT')).toBe('The font is Georgia now.');
    expect(said('hello')).toBe('cannot: the stand-in does not know that one');
  });
});

describe('solidPng', () => {
  it('is a PNG of the size and colour asked for', () => {
    const png = solidPng(4, 3, [255, 0, 0]);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBe(4);
    expect(png.readUInt32BE(20)).toBe(3);
    expect(png.subarray(-12, -8).readUInt32BE(0)).toBe(0); // IEND, no data
  });
});

describe('createQuickFixRunner', () => {
  const config = {
    inboxPath: '/inbox',
    logsDir: '/logs',
    dataDir: '/data',
    claudeBin: 'claude',
  };

  it('is the Claude run for claude and the stand-in for fake', () => {
    const real = createQuickFixRunner({ ...config, runner: 'claude' });
    expect(real).toBeInstanceOf(ClaudeQuickFixRunner);
    expect(real.kind).toBe('claude');
    const fake = createQuickFixRunner(
      { ...config, runner: 'fake' },
      { env: { STUDIO_FAKE_SPEED: '10' } },
    );
    expect(fake).toBeInstanceOf(FakeQuickFixRunner);
    expect(fake.kind).toBe('fake');
  });

  it('throws for a speed that is not a number above 0', () => {
    expect(() =>
      createQuickFixRunner({ ...config, runner: 'fake' }, { env: { STUDIO_FAKE_SPEED: '0' } }),
    ).toThrow();
  });
});
