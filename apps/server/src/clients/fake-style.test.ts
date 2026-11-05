import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Sleep } from '../pipeline/fake-runner.js';
import {
  FAIL_SERIES_MARKER,
  FAKE_STYLE_MS,
  FakeStyleRunner,
  fakeLearnedMarkdown,
  fakeStyleMarkdown,
  fakeStyleWithoutSeries,
} from './fake-style.js';
import { newSeriesProblem, newStyleProblem } from './style-install.js';
import type { ReadPass, SeriesPass } from './style-pass.js';
import type { SeriesRunRequest } from './style-run.js';

let root: string;
let styleDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-fake-style-'));
  styleDir = join(root, 'Kova Coffee', '_Style');
  mkdirSync(styleDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const pass = (mode: ReadPass['mode']): ReadPass => ({
  kind: 'read',
  mode,
  files: [
    { name: 'logo.png', size: 10 },
    { name: 'notes.txt', size: 20 },
  ],
});

/** A sleep that only records how long it was asked to wait. */
function recordingSleep(): { sleep: Sleep; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

function runner(sleep: Sleep, speed = 1) {
  return new FakeStyleRunner({ speed, sleep, clock: () => new Date(2026, 9, 21, 12) });
}

const request = (mode: ReadPass['mode'], signal = new AbortController().signal) => ({
  clientId: 'c0ffee000000',
  client: 'Kova Coffee',
  styleDir,
  pass: pass(mode),
  signal,
});

describe('FakeStyleRunner', () => {
  it('writes a style.md.new the install accepts, after about a second', async () => {
    const { sleep, waits } = recordingSleep();
    expect(await runner(sleep).run(request('create'))).toEqual({ ok: true });

    expect(waits).toEqual([FAKE_STYLE_MS]);
    const text = readFileSync(join(styleDir, 'style.md.new'), 'utf8');
    expect(newStyleProblem(text)).toBeNull();
    expect(text.split('\n').slice(0, 2)).toEqual([
      '# Style: Kova Coffee',
      'From your files: logo.png and notes.txt.',
    ]);
    expect(text).toContain('- logo.png: ');
    expect(existsSync(join(styleDir, '.style.md.new.tmp'))).toBe(false);
  });

  it('goes STUDIO_FAKE_SPEED times faster', async () => {
    const { sleep, waits } = recordingSleep();
    await runner(sleep, 10).run(request('create'));
    expect(waits).toEqual([FAKE_STYLE_MS / 10]);
  });

  it('fails with the injected failure while _Style/.fail-style is there, and writes nothing', async () => {
    writeFileSync(join(styleDir, '.fail-style'), '');
    const { sleep } = recordingSleep();
    expect(await runner(sleep).run(request('create'))).toEqual({
      ok: false,
      error: 'Style stopped: injected failure (.fail-style)',
    });
    expect(existsSync(join(styleDir, 'style.md.new'))).toBe(false);
  });

  it('writes nothing once stopped', async () => {
    const controller = new AbortController();
    controller.abort('shutdown');
    const { sleep } = recordingSleep();
    const outcome = await runner(sleep).run(request('create', controller.signal));
    expect(outcome.ok).toBe(false);
    expect(existsSync(join(styleDir, 'style.md.new'))).toBe(false);
  });
});

describe('FakeStyleRunner, Learn pass', () => {
  const learnRequest = (kit: string[]) => ({
    clientId: 'c0ffee000000',
    client: 'Kova Coffee',
    styleDir,
    pass: { kind: 'learn', mode: 'create', jobId: 'a1b2c3d4e5f6', job: 'Menu' } as const,
    learn: { jobDir: join(root, 'Kova Coffee', 'Menu'), kit },
    signal: new AbortController().signal,
  });

  it('writes a learned style that names the kit the engine copied', async () => {
    const { sleep } = recordingSleep();
    expect(await runner(sleep).run(learnRequest(['slot_captions', 'slot_title']))).toEqual({
      ok: true,
    });

    const text = readFileSync(join(styleDir, 'style.md.new'), 'utf8');
    expect(newStyleProblem(text)).toBeNull();
    expect(text.split('\n').slice(0, 2)).toEqual([
      '# Style: Kova Coffee',
      'Learned from Menu (2026-10-21).',
    ]);
    expect(text).toContain('## Kit\n- slot_captions: ');
    expect(text).toContain('\n- slot_title: ');
  });

  it('says so when there was no kit, and honours .fail-style like a Read pass', async () => {
    const { sleep } = recordingSleep();
    await runner(sleep).run(learnRequest([]));
    expect(readFileSync(join(styleDir, 'style.md.new'), 'utf8')).toContain(
      '## Kit\nNo graphics were copied.\n',
    );

    writeFileSync(join(styleDir, '.fail-style'), '');
    expect(await runner(sleep).run(learnRequest([]))).toEqual({
      ok: false,
      error: 'Style stopped: injected failure (.fail-style)',
    });
  });

  it('merges: keeps the current style, adds the Plus line and names the new kit', async () => {
    writeFileSync(
      join(styleDir, 'style.md'),
      '# Style: Kova Coffee\nLearned from Autumn (2026-10-01).\n## Look\n- Colours: Red\n## Kit\n- slot_old: the old title\n## Reference\n- old.pdf: the old look\n',
    );
    const { sleep } = recordingSleep();
    const request = learnRequest(['slot_title']);

    await runner(sleep).run({ ...request, pass: { ...request.pass, mode: 'merge' } });

    const text = readFileSync(join(styleDir, 'style.md.new'), 'utf8');
    expect(newStyleProblem(text)).toBeNull();
    expect(text).toBe(
      '# Style: Kova Coffee\nLearned from Autumn (2026-10-01). Plus Menu (2026-10-21).\n## Look\n- Colours: Red\n## Kit\n- slot_title: a stand-in line; the fake runner looked at nothing\n## Reference\n- old.pdf: the old look\n',
    );
  });
});

describe('fakeLearnedMarkdown', () => {
  const merge = { kind: 'learn', mode: 'merge', jobId: 'a1b2c3d4e5f6', job: 'Winter' } as const;

  it('adds ## Kit to a merged style that had none, and takes a $ in a slot name literally', () => {
    expect(
      fakeLearnedMarkdown(
        'Kova Coffee',
        merge,
        ['slot_$&'],
        '2026-10-21',
        '# Style: Kova Coffee\nFrom your files: notes.txt.\n',
      ),
    ).toBe(
      '# Style: Kova Coffee\nFrom your files: notes.txt. Plus Winter (2026-10-21).\n## Kit\n- slot_$&: a stand-in line; the fake runner looked at nothing\n',
    );
  });

  it('writes a new style when there is nothing to merge into', () => {
    expect(fakeLearnedMarkdown('Kova Coffee', merge, [], '2026-10-21', null)).toMatch(
      /^# Style: Kova Coffee\nLearned from Winter \(2026-10-21\)\.\n/,
    );
  });
});

describe('fakeStyleMarkdown', () => {
  const current =
    '# Style: Kova Coffee\nFrom your files: old.pdf.\n## Look\n- Colours: Red\n## Kit\n- title card (slot_1)\n## Reference\n- old.pdf: the old look\n';

  it('adds to the current style: the Plus line with the date, the files under Reference', () => {
    expect(fakeStyleMarkdown('Kova Coffee', pass('add'), current, '2026-10-21')).toBe(
      '# Style: Kova Coffee\nFrom your files: old.pdf. Plus logo.png and notes.txt (2026-10-21).\n## Look\n- Colours: Red\n## Kit\n- title card (slot_1)\n## Reference\n- old.pdf: the old look\n- logo.png: a stand-in line; the fake runner read nothing\n- notes.txt: a stand-in line; the fake runner read nothing\n',
    );
  });

  it('replaces the style and drops its kit: the engine moves the kit to history (C17)', () => {
    const text = fakeStyleMarkdown('Kova Coffee', pass('replace'), current, '2026-10-21');
    expect(text).toContain('From your files: logo.png and notes.txt.\n');
    expect(text).not.toContain('## Kit');
    expect(text).not.toContain('slot_1');
    expect(text).not.toContain('old.pdf');
  });
});

describe('FakeStyleRunner series passes', () => {
  const seriesDir = () => join(root, 'Kova Coffee', '_Series', 'Weekly');
  const START: SeriesPass = {
    kind: 'series',
    mode: 'start',
    seriesId: 'se1',
    series: 'Weekly',
    jobId: 'j5',
    job: 'Weekly 5',
  };
  const NOTES = [{ name: 'Review notes – Weekly 6 – round 1.md', size: 40 }];
  const seriesRequest = (
    pass: SeriesPass,
    writesStyle = false,
    signal = new AbortController().signal,
  ): SeriesRunRequest => ({
    clientId: 'c0ffee000000',
    client: 'Kova Coffee',
    seriesDir: seriesDir(),
    styleDir,
    pass,
    writesStyle,
    signal,
    jobDir: join(root, 'Kova Coffee', pass.job),
  });

  beforeEach(() => {
    mkdirSync(seriesDir(), { recursive: true });
  });

  it('writes a series.md.new the install accepts, and nothing in _Style when not asked', async () => {
    const { sleep, waits } = recordingSleep();

    expect(await runner(sleep).runSeries(seriesRequest(START))).toEqual({ ok: true });

    const written = readFileSync(join(seriesDir(), 'series.md.new'), 'utf8');
    expect(newSeriesProblem(written)).toBeNull();
    expect(written.split('\n').slice(0, 2)).toEqual([
      '# Series: Weekly',
      'Format from Weekly 5 (2026-10-21). Fonts, colours and captions come from the client style.',
    ]);
    expect(written).toContain('## New in each episode');
    expect(written).toContain('- The composition of Weekly 5, with the title text left open');
    expect(existsSync(join(styleDir, 'style.md.new'))).toBe(false);
    expect(waits).toEqual([FAKE_STYLE_MS]);
  });

  it('also writes the style without its kit when a start rewrites the style', async () => {
    writeFileSync(
      join(styleDir, 'style.md'),
      '# Style: Kova Coffee\nLearned from Weekly 5 (2026-10-01).\n## Look\n- Colours: red\n## Kit\n- composition: the stamp\n## Do\n- Smile.\n',
    );

    await runner(recordingSleep().sleep).runSeries(seriesRequest(START, true));

    const style = readFileSync(join(styleDir, 'style.md.new'), 'utf8');
    expect(newStyleProblem(style)).toBeNull();
    expect(style).toBe(
      '# Style: Kova Coffee\nLearned from Weekly 5 (2026-10-01). Moved what only Weekly does into the series (2026-10-21).\n## Look\n- Colours: red\n## Do\n- Smile.\n',
    );
  });

  it('writes a stand-in rule per notes file under ## Notes for an approved episode (C26)', async () => {
    const pass: SeriesPass = { ...START, mode: 'replace', job: 'Weekly 6', notes: NOTES };

    expect(
      await runner(recordingSleep().sleep).runSeries({
        ...seriesRequest(pass),
        notes: { files: NOTES, rounds: '## Round 1\n- 0.5 s later' },
      }),
    ).toEqual({ ok: true });

    const written = readFileSync(join(seriesDir(), 'series.md.new'), 'utf8');
    expect(newSeriesProblem(written)).toBeNull();
    expect(written).toContain('Format from Weekly 6 (2026-10-21).');
    expect(
      written.endsWith(
        '## Notes\n- Review notes – Weekly 6 – round 1.md: a stand-in rule with the episode’s rounds; the fake runner read nothing\n',
      ),
    ).toBe(true);

    await runner(recordingSleep().sleep).runSeries({
      ...seriesRequest(pass),
      notes: { files: NOTES, rounds: null },
    });
    expect(readFileSync(join(seriesDir(), 'series.md.new'), 'utf8')).toContain(
      'a stand-in rule without the episode’s rounds',
    );
  });

  it('fails on .fail-series in the series folder or in _Series', async () => {
    for (const marker of [
      join(seriesDir(), FAIL_SERIES_MARKER),
      join(seriesDir(), '..', FAIL_SERIES_MARKER),
    ]) {
      writeFileSync(marker, '');
      expect(await runner(recordingSleep().sleep).runSeries(seriesRequest(START))).toEqual({
        ok: false,
        error: 'Series stopped: injected failure (.fail-series)',
      });
      rmSync(marker);
    }
    expect(existsSync(join(seriesDir(), 'series.md.new'))).toBe(false);
  });

  it('writes nothing once it is stopped', async () => {
    const controller = new AbortController();
    controller.abort('shutdown');
    const outcome = await runner(recordingSleep().sleep).runSeries(
      seriesRequest(START, false, controller.signal),
    );
    expect(outcome.ok).toBe(false);
    expect(existsSync(join(seriesDir(), 'series.md.new'))).toBe(false);
  });
});

describe('fakeStyleWithoutSeries', () => {
  const STYLE =
    '# Style: Kova\nLearned from Weekly 5 (2026-10-01).\n## Look\n- Colours: red\n## Kit\n- composition: the stamp\n## Do\n- Smile.\n';

  it('keeps a style that has no kit, adding the line under the title', () => {
    expect(
      fakeStyleWithoutSeries('# Style: Kova\nFrom your files.\n## Look\n', 'Weekly', '2026-10-21'),
    ).toBe(
      '# Style: Kova\nFrom your files. Moved what only Weekly does into the series (2026-10-21).\n## Look\n',
    );
  });

  it('keeps ## Kit when the kit stays (C23)', () => {
    expect(fakeStyleWithoutSeries(STYLE, 'Weekly', '2026-10-21', { kind: 'keep' })).toBe(
      '# Style: Kova\nLearned from Weekly 5 (2026-10-01). Moved what only Weekly does into the series (2026-10-21).\n## Look\n- Colours: red\n## Kit\n- composition: the stamp\n## Do\n- Smile.\n',
    );
  });

  it('writes ## Kit for the kit that comes back, from its lines or a stand-in (C23)', () => {
    const back = (section: string | null) =>
      fakeStyleWithoutSeries(STYLE, 'Weekly', '2026-10-21', {
        kind: 'restore',
        names: ['composition'],
        job: 'FAQ 5',
        section,
      });

    expect(back('- composition: the WhatsApp card')).toContain(
      '## Kit\n- composition: the WhatsApp card\n## Do\n',
    );
    expect(back(null)).toContain(
      '## Kit\n- composition: a stand-in line; the fake runner looked at nothing\n## Do\n',
    );
    expect(
      fakeStyleWithoutSeries('# Style: Kova\nFrom your files.\n', 'Weekly', '2026-10-21', {
        kind: 'restore',
        names: ['composition'],
        job: null,
        section: '- composition: the card',
      }),
    ).toBe(
      '# Style: Kova\nFrom your files. Moved what only Weekly does into the series (2026-10-21).\n## Kit\n- composition: the card\n',
    );
  });
});
