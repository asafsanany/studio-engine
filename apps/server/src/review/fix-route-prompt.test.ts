import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PROMPTS_DIR } from '../pipeline/prompts.js';
import {
  ABOUT_CUT_MAX,
  aboutCutExcerpt,
  buildRoutePrompt,
  EDIT_ADDED_MAX,
  editAddedExcerpt,
  lastJsonObject,
  parseRouteAnswer,
  type RoutePromptVars,
  readAboutCut,
  readEditAdded,
  readProjectNotes,
} from './fix-route-prompt.js';

// The router's prompt (prompts/fix-route.md), what it quotes from project.md, and the parsing of
// its answer. The three snapshots hold the whole prompt, the index included: they are read here,
// never written (change them on purpose, with the index or the template).

const GOLDEN_DIR = fileURLToPath(new URL('../pipeline/testdata/prompts/', import.meta.url));

/** A Hebrew note with the things that break a naive prompt: quotes, a line break and a template mark. */
const GOLDEN_VARS: Omit<RoutePromptVars, 'editAdded'> = {
  atSec: 72.34,
  text: 'תעשה את הכתוביות צהובות, "Heebo Bold" {{client}}\nואחר כך גם הכותרת',
};

const GOLDEN_PROJECT = `# Acme - Demo - project notes

## Plan
Interview, 38 s, vertical.

## Composition (live preview)
- edit/preview/index.html, 1080x1920, 38 s. cut.mp4 is the baked cut.
- Captions (Hebrew): compositions/captions.html, white on a dark band, bottom third.
- Title "Acme Bakery" from 0:02 to 0:05.
- A shop sign ("PEKARIA") is in the footage between 0:10 and 0:14; it is not an overlay.

## Check (Round 1)
Lint clean.
`;

/** A project.md with lines about the beat (C61): the cut is on it. */
const BEAT_PROJECT = `# Falcon FPV - Demo 2 - project notes

## Plan
Drone reel, 40 s, vertical 9:16, 37 shots. The supplied track runs under the whole video.

## Composition (live preview)
- edit/preview/index.html, 1080x1920, 40 s. cut.mp4 is the baked cut.
- Titles (Assistant) from 0:01 to 0:04 and a logo end card with no box.

## Round 8
- The cut is beat-synced: the track is 120 BPM, and every cut in cut.mp4 lands on a beat.
- Holds are 4 beats (2.0 s) or 2 beats (1.0 s).
- The 37 shots keep their footage, cut frames and 9:16 crops.
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-fix-route-prompt-'));
  dirs.push(dir);
  return dir;
}

describe('the prompt', () => {
  it('is byte for byte the snapshot with a project.md', async () => {
    const prompt = await buildRoutePrompt({
      ...GOLDEN_VARS,
      editAdded: editAddedExcerpt(GOLDEN_PROJECT),
    });
    expect(prompt).toBe(readFileSync(`${GOLDEN_DIR}fix-route-with-project.txt`, 'utf8'));
  });

  it('is byte for byte the snapshot without one', async () => {
    const prompt = await buildRoutePrompt({ ...GOLDEN_VARS, editAdded: null });
    expect(prompt).toBe(readFileSync(`${GOLDEN_DIR}fix-route-without-project.txt`, 'utf8'));
  });

  it('is byte for byte the snapshot with lines about the beat: "About the cut" after "What the edit added"', async () => {
    const prompt = await buildRoutePrompt({
      atSec: 12.5,
      text: 'The middle drags, cut on the beat',
      editAdded: editAddedExcerpt(BEAT_PROJECT),
      aboutCut: aboutCutExcerpt(BEAT_PROJECT),
    });
    expect(prompt).toBe(readFileSync(`${GOLDEN_DIR}fix-route-with-beat.txt`, 'utf8'));
    expect(prompt.indexOf('## What the edit added')).toBeLessThan(
      prompt.indexOf('## About the cut'),
    );
    expect(prompt.indexOf('## About the cut')).toBeLessThan(prompt.indexOf('# Your answer'));
  });

  it('leaves "About the cut" out when there is nothing about the beat, and has it when there is', async () => {
    const without = await buildRoutePrompt({ atSec: 1, text: 'x', editAdded: null });
    const nothing = await buildRoutePrompt({
      atSec: 1,
      text: 'x',
      editAdded: null,
      aboutCut: null,
    });
    const empty = await buildRoutePrompt({ atSec: 1, text: 'x', editAdded: null, aboutCut: ' \n' });
    const withIt = await buildRoutePrompt({
      atSec: 1,
      text: 'x',
      editAdded: null,
      aboutCut: '- Every cut is on a beat.',
    });
    // Rule 7 of the index names the part, so the section is told by its heading.
    expect(without).not.toContain('## About the cut');
    expect(nothing).toBe(without);
    expect(empty).toBe(without);
    expect(withIt).toContain('## About the cut');
    expect(withIt).toContain('<cut-notes>\n- Every cut is on a beat.\n</cut-notes>');
  });

  it('puts in the index as it is, then the note, then the answer rule', async () => {
    const prompt = await buildRoutePrompt({ atSec: 12, text: 'Make it yellow', editAdded: null });
    const index = readFileSync(join(PROMPTS_DIR, 'fix-index.md'), 'utf8');
    expect(prompt.startsWith(index.trimEnd())).toBe(true);
    expect(prompt).toContain('at 0:12.0.');
    expect(prompt).toContain('Note, as a JSON string: "Make it yellow"');
    expect(prompt.trimEnd().endsWith('starting with "it".')).toBe(true);
    expect(prompt.indexOf('# The note to sort')).toBeLessThan(prompt.indexOf('# Your answer'));
  });

  it('writes the time as m:ss.s, and keeps counting minutes past an hour', async () => {
    const at = async (atSec: number) =>
      (await buildRoutePrompt({ atSec, text: 'x', editAdded: null })).match(/, at (\S+)\./)?.[1];
    expect(await at(0)).toBe('0:00.0');
    expect(await at(5.96)).toBe('0:06.0');
    expect(await at(72.34)).toBe('1:12.3');
    expect(await at(3725)).toBe('62:05.0');
  });

  it('keeps a quote, a line break and a template mark of the note inside its JSON string', async () => {
    const prompt = await buildRoutePrompt({
      atSec: 1,
      text: ' say "hi" {{client}}\nthen {{> fix-index}} ',
      editAdded: null,
    });
    expect(prompt).toContain(
      'Note, as a JSON string: "say \\"hi\\" {{client}}\\nthen {{> fix-index}}"',
    );
  });

  it('leaves the section out when there is no project.md, and has it when there is', async () => {
    const without = await buildRoutePrompt({ atSec: 1, text: 'x', editAdded: null });
    const empty = await buildRoutePrompt({ atSec: 1, text: 'x', editAdded: '  \n' });
    const withIt = await buildRoutePrompt({ atSec: 1, text: 'x', editAdded: 'A title at 0:02.' });
    expect(without).not.toContain('What the edit added');
    expect(empty).toBe(without);
    expect(withIt).toContain('## What the edit added');
    expect(withIt).toContain('<composition-notes>\nA title at 0:02.\n</composition-notes>');
  });
});

describe('what the edit added', () => {
  it('is the section that records the composition, with its sub-sections', () => {
    const excerpt = editAddedExcerpt(
      [
        '# Job',
        '## Plan',
        'The plan.',
        '## Composition (live preview)',
        'Captions at the bottom.',
        '### Titles',
        'One title at 0:02.',
        '## Check',
        'Lint clean.',
      ].join('\n'),
    );
    expect(excerpt).toBe(
      '## Composition (live preview)\nCaptions at the bottom.\n### Titles\nOne title at 0:02.',
    );
  });

  it('takes the newest sections first and shows them in the file’s order', () => {
    const md = [
      '## Preview composition',
      'Base: captions and one title.',
      '## Round 2',
      'Notes.',
      '### Composition (Round 2)',
      'The title is yellow now.',
      '## Round 3',
      'Notes.',
      '### Titles (Round 3)',
      'The end card is new.',
    ].join('\n');
    expect(editAddedExcerpt(md)).toBe(
      [
        '## Preview composition\nBase: captions and one title.',
        '### Composition (Round 2)\nThe title is yellow now.',
        '### Titles (Round 3)\nThe end card is new.',
      ].join('\n\n'),
    );
  });

  it('stops adding older sections when they would not fit, and never goes over the limit', () => {
    const old = `## Composition (old)\n${'o'.repeat(EDIT_ADDED_MAX - 100)}`;
    const recent = `## Composition (new)\n${'n'.repeat(500)}`;
    const excerpt = editAddedExcerpt(`${old}\n\n## Check\nx\n\n${recent}\n`);
    expect(excerpt).toBe(recent);
  });

  it('cuts a single section that is longer than the limit', () => {
    const excerpt = editAddedExcerpt(
      `## Composition\n${'x'.repeat(EDIT_ADDED_MAX * 2)}\n## Check\n`,
    );
    expect(excerpt?.length).toBe(EDIT_ADDED_MAX);
    expect(excerpt?.startsWith('## Composition\nxxx')).toBe(true);
  });

  it('does not split a character that takes two code units when it cuts', () => {
    const excerpt = editAddedExcerpt(`## Composition\n${'😀'.repeat(EDIT_ADDED_MAX)}`) ?? '';
    expect(excerpt.length).toBeLessThanOrEqual(EDIT_ADDED_MAX);
    expect(excerpt).not.toMatch(/[\ud800-\udbff]$/);
    expect(() => encodeURIComponent(excerpt)).not.toThrow();
  });

  it('is the last characters of the file when no heading mentions the composition', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} of the plan`);
    const text = `# Plan\n${lines.join('\n')}\n`;
    const excerpt = editAddedExcerpt(text) ?? '';
    expect(excerpt.length).toBeLessThanOrEqual(EDIT_ADDED_MAX);
    expect(excerpt.endsWith('line 399 of the plan')).toBe(true);
    expect(excerpt.startsWith('line ')).toBe(true);
    expect(text.trim().endsWith(excerpt)).toBe(true);
  });

  it('is the whole file when it is short and has no such heading', () => {
    expect(editAddedExcerpt('# Plan\nCut it short.\n')).toBe('# Plan\nCut it short.');
  });

  it('does not read a # inside a code fence as a heading', () => {
    const md = ['## Plan', '```', '## Composition', '```', 'Done.'].join('\n');
    expect(editAddedExcerpt(md)).toBe(md);
  });

  it('reads Windows line breaks, and is null for an empty file', () => {
    expect(editAddedExcerpt('## Composition\r\nA title.\r\n## Check\r\nOK\r\n')).toBe(
      '## Composition\nA title.',
    );
    expect(editAddedExcerpt('')).toBeNull();
    expect(editAddedExcerpt(' \n\n')).toBeNull();
  });

  it('is read from the job’s edit/project.md, and null when there is none', async () => {
    const jobDir = tempDir();
    expect(await readEditAdded(jobDir)).toBeNull();
    mkdirSync(join(jobDir, 'edit'));
    expect(await readEditAdded(jobDir)).toBeNull();
    writeFileSync(join(jobDir, 'edit', 'project.md'), GOLDEN_PROJECT);
    expect(await readEditAdded(jobDir)).toBe(editAddedExcerpt(GOLDEN_PROJECT));
    writeFileSync(join(jobDir, 'edit', 'project.md'), '');
    expect(await readEditAdded(jobDir)).toBeNull();
  });
});

describe('about the cut', () => {
  it('is the lines that mention the beat, BPM, tempo, sync or the music’s hits', () => {
    const md = [
      '# Job',
      '- The track is 120 BPM.',
      '- Plain line about captions.',
      '- Every cut lands on a beat.',
      '- Beat-synced since round 8.',
      '- The tempo is steady.',
      '- Audio is in sync with the picture.',
      '- Cuts sit on the music’s hits.',
      '- The cuts follow the hits of the song.',
      '- A downbeat opens the intro.',
    ].join('\n');
    expect(aboutCutExcerpt(md)?.split('\n')).toEqual([
      '- The track is 120 BPM.',
      '- Every cut lands on a beat.',
      '- Beat-synced since round 8.',
      '- The tempo is steady.',
      '- Audio is in sync with the picture.',
      '- Cuts sit on the music’s hits.',
      '- The cuts follow the hits of the song.',
      '- A downbeat opens the intro.',
    ]);
  });

  it('does not take a line for a word that only contains one', () => {
    const md = [
      '- The beaten path shot.',
      '- A temporal fade.',
      '- Hits a wall at 0:10.',
      '- The bpmx field.',
      '- Asynchronous load.',
    ].join('\n');
    expect(aboutCutExcerpt(md)).toBeNull();
  });

  it('is null for a file with nothing about the beat, an empty file or nothing', () => {
    expect(aboutCutExcerpt(GOLDEN_PROJECT)).toBeNull();
    expect(aboutCutExcerpt('')).toBeNull();
    expect(aboutCutExcerpt(' \n\n')).toBeNull();
  });

  it('leaves out a line inside a code block', () => {
    const md = [
      '- Cut on the beat.',
      '```',
      'python detect_beat.py --bpm 120',
      '```',
      '- tempo ok',
    ].join('\n');
    expect(aboutCutExcerpt(md)).toBe('- Cut on the beat.\n- tempo ok');
  });

  it('takes the newest lines first, shows them in the file’s order, and never goes over the limit', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `- Round ${i}: the cut is on the beat.`);
    const excerpt = aboutCutExcerpt(lines.join('\n')) ?? '';
    expect(excerpt.length).toBeLessThanOrEqual(ABOUT_CUT_MAX);
    expect(ABOUT_CUT_MAX).toBe(1000);
    expect(excerpt.endsWith('- Round 59: the cut is on the beat.')).toBe(true);
    expect(excerpt).not.toContain('- Round 0:');
    const numbers = [...excerpt.matchAll(/Round (\d+):/g)].map((match) => Number(match[1]));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers.at(-1)).toBe(59);
  });

  it('cuts a single line that is longer than the limit', () => {
    const excerpt = aboutCutExcerpt(`- Every cut is on the beat ${'x'.repeat(ABOUT_CUT_MAX * 2)}`);
    expect(excerpt?.length).toBe(ABOUT_CUT_MAX);
    expect(excerpt?.startsWith('- Every cut is on the beat xxx')).toBe(true);
  });

  it('does not split a character that takes two code units when it cuts', () => {
    const excerpt = aboutCutExcerpt(`- on the beat ${'😀'.repeat(ABOUT_CUT_MAX)}`) ?? '';
    expect(excerpt.length).toBeLessThanOrEqual(ABOUT_CUT_MAX);
    expect(excerpt).not.toMatch(/[\ud800-\udbff]$/);
  });

  it('reads Windows line breaks, and drops a duplicate-free copy of each line as it is', () => {
    expect(aboutCutExcerpt('- Plan\r\n- On the beat.\r\n- Tempo: 90 BPM.\r\n')).toBe(
      '- On the beat.\n- Tempo: 90 BPM.',
    );
  });

  it('is read from the job’s edit/project.md together with the other excerpt, and null when there is none', async () => {
    const jobDir = tempDir();
    expect(await readProjectNotes(jobDir)).toEqual({ editAdded: null, aboutCut: null });
    expect(await readAboutCut(jobDir)).toBeNull();
    mkdirSync(join(jobDir, 'edit'));
    writeFileSync(join(jobDir, 'edit', 'project.md'), BEAT_PROJECT);
    expect(await readProjectNotes(jobDir)).toEqual({
      editAdded: editAddedExcerpt(BEAT_PROJECT),
      aboutCut: aboutCutExcerpt(BEAT_PROJECT),
    });
    expect(await readAboutCut(jobDir)).toBe(
      [
        '- The cut is beat-synced: the track is 120 BPM, and every cut in cut.mp4 lands on a beat.',
        '- Holds are 4 beats (2.0 s) or 2 beats (1.0 s).',
      ].join('\n'),
    );
    writeFileSync(join(jobDir, 'edit', 'project.md'), GOLDEN_PROJECT);
    expect((await readProjectNotes(jobDir)).aboutCut).toBeNull();
  });
});

describe('the answer', () => {
  const GOOD = '{"tier":"quick","kind":"Changing the caption font","why":""}';

  it('takes a good line of JSON', () => {
    expect(parseRouteAnswer(GOOD)).toEqual({
      ok: true,
      route: { tier: 'quick', kind: 'Changing the caption font', why: '' },
    });
    expect(
      parseRouteAnswer('{"tier":"revise","kind":"Replacing a shot","why":"it changes the cut"}'),
    ).toEqual({
      ok: true,
      route: { tier: 'revise', kind: 'Replacing a shot', why: 'it changes the cut' },
    });
  });

  it('takes the JSON out of a code fence or a sentence, and the last object when there are two', () => {
    expect(parseRouteAnswer(`\`\`\`json\n${GOOD}\n\`\`\``).ok).toBe(true);
    expect(parseRouteAnswer(`Here is my answer: ${GOOD} Hope that helps.`).ok).toBe(true);
    const twice = `{"tier":"full","kind":"First","why":"it changes the whole video"}\n${GOOD}`;
    expect(parseRouteAnswer(twice)).toEqual({
      ok: true,
      route: { tier: 'quick', kind: 'Changing the caption font', why: '' },
    });
  });

  it('keeps a brace inside a string where it is', () => {
    const answer = '{"tier":"revise","kind":"Fixing } a brace","why":"it changes the cut {x}"}';
    expect(parseRouteAnswer(answer)).toEqual({
      ok: true,
      route: { tier: 'revise', kind: 'Fixing } a brace', why: 'it changes the cut {x}' },
    });
    expect(lastJsonObject('a { b } {"a":1} c { d')).toBe('{"a":1}');
    expect(lastJsonObject('no json here')).toBeNull();
    expect(lastJsonObject('{broken')).toBeNull();
  });

  it('trims the words, and drops a reason a quick note was given', () => {
    expect(
      parseRouteAnswer('{"tier":"quick","kind":"  Moving the captions ","why":"it moves them"}'),
    ).toEqual({ ok: true, route: { tier: 'quick', kind: 'Moving the captions', why: '' } });
  });

  it('refuses a tier that is not one of the three', () => {
    const answer = parseRouteAnswer('{"tier":"huge","kind":"Changing it","why":"it changes it"}');
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.error).toMatch(/tier/);
    expect(parseRouteAnswer('{"tier":"Quick","kind":"x","why":""}').ok).toBe(false);
  });

  it('refuses an answer with a field missing, empty or not text', () => {
    expect(parseRouteAnswer('{"tier":"quick","why":""}').ok).toBe(false); // no kind
    expect(parseRouteAnswer('{"kind":"Changing it","why":""}').ok).toBe(false); // no tier
    expect(parseRouteAnswer('{"tier":"revise","kind":"Changing it"}').ok).toBe(false); // no why
    expect(parseRouteAnswer('{"tier":"quick","kind":"","why":""}').ok).toBe(false);
    expect(parseRouteAnswer('{"tier":"quick","kind":7,"why":""}').ok).toBe(false);
    expect(parseRouteAnswer(`{"tier":"quick","kind":"${'k'.repeat(81)}","why":""}`).ok).toBe(false);
    expect(parseRouteAnswer('[]').ok).toBe(false);
  });

  it('refuses a note that is not quick and does not say why', () => {
    const answer = parseRouteAnswer('{"tier":"revise","kind":"Replacing a shot","why":" "}');
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.error).toMatch(/no why/);
  });

  it('refuses text with no JSON in it', () => {
    expect(parseRouteAnswer('quick').ok).toBe(false);
    expect(parseRouteAnswer('').ok).toBe(false);
  });
});
