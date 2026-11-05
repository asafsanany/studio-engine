import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefDraftSchema, type Job } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listJobFiles } from '../inbox/scan.js';
import type { BriefFile } from './brief-step.js';
import { BRIEF_JSON_PATH, BRIEF_TRANSCRIPTS_PATH, BriefStep } from './brief-step.js';
import {
  canvasesIn,
  FAKE_BRIEF_ORIGINAL_BY,
  FAKE_BRIEF_SONG,
  FAKE_BRIEF_UNGETTABLE_SONG,
  FakeBriefWriter,
  fakeBriefDraft,
  fakeBriefMusic,
  fakeBudgetUsd,
  fakeFormats,
  fakeMusicWanted,
  scriptLinesOf,
} from './fake-brief.js';
import { FAKE_STEP_MS } from './fake-runner.js';

let jobDir: string;
let inbox: string;

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-fake-brief-'));
  jobDir = join(inbox, 'Acme', 'Teaser');
  mkdirSync(jobDir, { recursive: true });
  for (const name of ['clip.mp4', 'voice.m4a', 'memo.opus', 'brief.txt', 'logo.png', 'mood.jpg']) {
    writeFileSync(join(jobDir, name), 'x');
  }
});

afterEach(() => {
  rmSync(inbox, { recursive: true, force: true });
});

const job = {
  id: 'fafafafafafa',
  client: 'Acme',
  name: 'Teaser',
  relPath: 'Acme/Teaser',
  note: null,
} as Job;

async function write(writer: FakeBriefWriter, controller = new AbortController()) {
  const files = await listJobFiles(jobDir);
  return writer.write(job, { jobDir, files, note: null, signal: controller.signal });
}

describe('FakeBriefWriter', () => {
  it('writes a valid canned draft with every file and a role for each', async () => {
    const outcome = await write(new FakeBriefWriter({ speed: 1_000 }));

    expect(outcome).toEqual({ ok: true });
    const draft = briefDraftSchema.parse(
      JSON.parse(readFileSync(join(jobDir, BRIEF_JSON_PATH), 'utf8')),
    );
    expect(draft.summary).toContain('fake runner');
    expect(draft.files.map((file) => [file.path, file.role])).toEqual([
      ['brief.txt', 'instructions'],
      ['clip.mp4', 'footage'],
      ['logo.png', 'logo'],
      ['memo.opus', 'instructions'],
      ['mood.jpg', 'reference'],
      ['voice.m4a', 'instructions'],
    ]);
    expect(draft.look.logo).toBe('logo.png');
  });

  it('writes a stand-in transcript per audio file under edit/brief/transcripts/', async () => {
    await write(new FakeBriefWriter({ speed: 1_000 }));
    expect(readdirSync(join(jobDir, BRIEF_TRANSCRIPTS_PATH)).sort()).toEqual([
      'memo.json',
      'voice.json',
    ]);
    expect(existsSync(join(jobDir, 'edit', 'transcripts'))).toBe(false);
  });

  it('takes about a second at speed 1, divided by the speed', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    await write(new FakeBriefWriter({ speed: 1, sleep }));
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeCloseTo(FAKE_STEP_MS[1], 6);

    waits.length = 0;
    await write(new FakeBriefWriter({ speed: 4, sleep }));
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeCloseTo(FAKE_STEP_MS[1] / 4, 6);
  });

  it('writes nothing once aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await write(new FakeBriefWriter({ speed: 1_000 }), controller);
    expect(outcome.ok).toBe(false);
    expect(existsSync(join(jobDir, BRIEF_JSON_PATH))).toBe(false);
  });

  it('honours .fail-at-brief in the job folder, and only there', async () => {
    const writer = new FakeBriefWriter({ speed: 1_000 });
    const signal = new AbortController().signal;
    expect(await writer.injectedFailure(job, { jobDir, signal })).toBeNull();

    writeFileSync(join(jobDir, '.fail-at-brief'), '');
    expect(await writer.injectedFailure(job, { jobDir, signal })).toBe(
      'Brief failed: injected failure (.fail-at-brief)',
    );
  });

  it('fails the Brief step with .fail-at-brief even for a job that only has video', async () => {
    for (const name of readdirSync(jobDir)) if (name !== 'clip.mp4') rmSync(join(jobDir, name));
    writeFileSync(join(jobDir, '.fail-at-brief'), '');
    const step = new BriefStep({ inboxPath: inbox, writer: new FakeBriefWriter({ speed: 1_000 }) });

    const outcome = await step.prepare(job, {
      signal: new AbortController().signal,
      progress: () => {},
    });

    expect(outcome).toEqual({
      ok: false,
      error: 'Brief failed: injected failure (.fail-at-brief)',
    });
  });

  it.each([0, -1, Number.NaN])('refuses speed %s', (speed) => {
    expect(() => new FakeBriefWriter({ speed })).toThrow(RangeError);
  });
});

/** A picture attached to the note (Songs): `edit/brief/from-you/<name>`, as the Brief step lists it. */
function attached(name: string): BriefFile {
  return {
    relPath: `edit/brief/from-you/${name}`,
    absPath: `/x/edit/brief/from-you/${name}`,
    kind: 'image',
    size: 1,
    mtimeMs: 1,
    attached: true,
  };
}

describe('the song the fake Brief reads off a picture attached to the note (Songs)', () => {
  it('asks for no music without a picture, and a picture in the folder is no screenshot to read', () => {
    expect(fakeBriefMusic([])).toBeNull();
    const plain = { ...attached('IMG_4412.PNG'), relPath: 'IMG_4412.PNG' };
    delete (plain as { attached?: true }).attached;
    expect(fakeBriefMusic([plain])).toBeNull();
  });

  it('reads the boards’ song off an ordinary name, with the picture’s name as where it was read', () => {
    expect(fakeBriefMusic([attached('IMG_4412.PNG')])).toEqual({
      file: null,
      note: null,
      wanted: false,
      song: { ...FAKE_BRIEF_SONG, link: null, fromFile: 'IMG_4412.PNG' },
      original: null,
      wantsTrending: false,
    });
    expect(FAKE_BRIEF_SONG).toMatchObject({ title: 'A Home for You', version: 'sped up' });
  });

  it('asks for a trending song, a song that cannot be got, or "Original audio" by the picture’s name', () => {
    expect(fakeBriefMusic([attached('trending-request.png')])).toMatchObject({
      song: null,
      original: null,
      wantsTrending: true,
    });
    expect(fakeBriefMusic([attached('fail-request.png')])).toMatchObject({
      song: { ...FAKE_BRIEF_UNGETTABLE_SONG, fromFile: 'fail-request.png' },
    });
    expect(fakeBriefMusic([attached('original-audio.png')])).toMatchObject({
      song: null,
      original: { by: FAKE_BRIEF_ORIGINAL_BY },
      wantsTrending: false,
    });
  });

  it('makes a draft the schema takes, with the picture as instructions and the song in its music', () => {
    const files = [attached('IMG_4412.PNG')];
    const draft = briefDraftSchema.parse(
      fakeBriefDraft({ client: 'Acme', name: 'Teaser' }, files, 'Yael wants this song.'),
    );
    expect(draft.music?.song?.title).toBe('A Home for You');
    expect(draft.files).toEqual([
      {
        path: 'edit/brief/from-you/IMG_4412.PNG',
        role: 'instructions',
        note: 'Screenshot attached to the note',
      },
    ]);
  });
});

// U21: music is made only when the job asks for it.
describe('the ask for music the fake Brief reads (music only when asked)', () => {
  it.each([
    'Add music.',
    'Please add some music with drops.',
    'with a soundtrack',
    'Put an energetic soundtrack under it',
    'I want intense music',
    'תוסיפו מוזיקה',
    'Short and punchy.\nAdd music to the end.',
  ])('reads “%s” as an ask', (text) => {
    expect(fakeMusicWanted(text)).toBe(true);
  });

  it.each([
    null,
    '',
    'Short and punchy. Keep the logo at the end.',
    'No music.',
    'Without music please',
    'no music at all, add a title',
    'The music in the clip is too loud.',
    'Do not add music',
  ])('does not read “%s” as an ask', (text) => {
    expect(fakeMusicWanted(text)).toBe(false);
  });

  it('puts the ask in music.wanted, with no file and no song', () => {
    expect(fakeBriefMusic([], true)).toEqual({
      file: null,
      note: null,
      wanted: true,
      song: null,
      original: null,
      wantsTrending: false,
    });
    expect(fakeBriefMusic([], false)).toBeNull();
    // A picture names a song: the song is the ask, not `wanted`.
    expect(fakeBriefMusic([attached('IMG_4412.PNG')], true)).toMatchObject({
      wanted: false,
      song: { title: 'A Home for You' },
    });
  });

  it('asks for music in the draft only with the music switch on (a text) and an ask in the note or the text', () => {
    const draftOf = (note: string | null, music?: { text: string }) =>
      briefDraftSchema.parse(
        fakeBriefDraft({ client: 'Acme', name: 'Teaser' }, [], note, undefined, music),
      ).music;
    expect(draftOf('Add music.')).toBeNull();
    expect(draftOf('Add music.', { text: '' })).toMatchObject({ wanted: true });
    expect(draftOf(null, { text: 'Please add music.' })).toMatchObject({ wanted: true });
    expect(draftOf(null, { text: 'Short and punchy.' })).toBeNull();
    expect(draftOf('No music.', { text: 'Add music.' })).toBeNull();
  });

  it('writes music.wanted from the note and from a text file of the job folder, with the switch on', async () => {
    const run = async (note: string | null, music: boolean) => {
      const files = await listJobFiles(jobDir);
      await new FakeBriefWriter({ speed: 1_000, music }).write(job, {
        jobDir,
        files,
        note,
        signal: new AbortController().signal,
      });
      return briefDraftSchema.parse(JSON.parse(readFileSync(join(jobDir, BRIEF_JSON_PATH), 'utf8')))
        .music;
    };
    // The folder's brief.txt asks for nothing.
    expect(await run(null, true)).toBeNull();
    expect(await run('Add music with drops.', true)).toMatchObject({ wanted: true, file: null });
    expect(await run('Add music with drops.', false)).toBeNull();
    writeFileSync(join(jobDir, 'brief.txt'), 'Please add some music.\n');
    expect(await run(null, true)).toMatchObject({ wanted: true });
    expect(await run(null, false)).toBeNull();
  });
});

describe('fakeFormats (GN7)', () => {
  it('is null for a note that names one size or none: the fake brief asks for one video', () => {
    expect(fakeFormats(null)).toBeNull();
    expect(fakeFormats('')).toBeNull();
    expect(fakeFormats('keep it under 30 seconds')).toBeNull();
    expect(fakeFormats('make it 9:16')).toBeNull();
    expect(fakeFormats('9:16, 9:16')).toBeNull();
  });

  it('lists the sizes a note names, the first one as the main format', () => {
    expect(fakeFormats('deliver 9:16 and 1:1')).toEqual(['1080x1920', '1080x1080']);
    expect(fakeFormats('1:1 first, then 4:5 and 9:16')).toEqual([
      '1080x1080',
      '1080x1350',
      '1080x1920',
    ]);
  });

  it('does not read a time or a score as a ratio', () => {
    expect(fakeFormats('cut at 11:16 and 9:161')).toBeNull();
    expect(fakeFormats('score 1:1:1 and 9:16')).toBeNull();
  });

  it('puts them in the draft only when the note asks for more than one', async () => {
    const files = await listJobFiles(jobDir);
    const writer = new FakeBriefWriter({ speed: 1_000 });
    await writer.write(job, {
      jobDir,
      files,
      note: 'deliver 9:16 and 1:1',
      signal: new AbortController().signal,
    });
    const draft = briefDraftSchema.parse(
      JSON.parse(readFileSync(join(jobDir, BRIEF_JSON_PATH), 'utf8')),
    );
    expect(draft.formats).toEqual(['1080x1920', '1080x1080']);
  });
});

// Generated videos (GN4): the fake run reads a script and the formats out of a text file when the
// Generate switch is on, so a PINEWOOD-shaped folder can be driven through dev and e2e. The whole
// folder through the Brief step is in brief-step.generate.test.ts.
describe('FakeBriefWriter with the Generate switch', () => {
  const SCRIPT = [
    'MASTER VIDEO PRODUCTION BRIEF',
    '',
    'COMPLETE VOICEOVER SCRIPT',
    '',
    '“You always think about the food you eat…',
    '',
    'But what about the view you look at every day?',
    '',
    'Get it now and save.”',
    '',
    'The narration must be synchronized exactly.',
  ].join('\n');

  const draftOf = () =>
    briefDraftSchema.parse(JSON.parse(readFileSync(join(jobDir, BRIEF_JSON_PATH), 'utf8')));

  it('is the canned draft it was with the switch off, even for a folder with a script', async () => {
    writeFileSync(join(jobDir, 'brief.txt'), SCRIPT);
    rmSync(join(jobDir, 'clip.mp4'));
    await write(new FakeBriefWriter({ speed: 1_000 }));
    expect(draftOf()).toMatchObject({ production: null, voiceover: null, formats: null });
  });

  it('writes production generate and the script into voiceover when there is no footage', async () => {
    writeFileSync(join(jobDir, 'brief.txt'), `${SCRIPT}\n\nDeliver 1080 × 1920 and 1080 × 1080.`);
    rmSync(join(jobDir, 'clip.mp4'));
    await write(new FakeBriefWriter({ speed: 1_000, generate: true }));

    const draft = draftOf();
    expect(draft.production).toBe('generate');
    expect(draft.voiceover).toEqual({
      lines: [
        { id: 'L1', text: 'You always think about the food you eat…', direction: null },
        { id: 'L2', text: 'But what about the view you look at every day?', direction: null },
        { id: 'L3', text: 'Get it now and save.', direction: null },
      ],
    });
    expect(draft.formats).toEqual(['1080x1920', '1080x1080']);
    expect(draft.canvas).toBe('1080x1920');
  });

  it('is not a generated video when the folder has footage', async () => {
    writeFileSync(join(jobDir, 'brief.txt'), SCRIPT);
    await write(new FakeBriefWriter({ speed: 1_000, generate: true }));
    expect(draftOf()).toMatchObject({ production: null, voiceover: null });
  });

  it('reads the budget off the owner’s note for a generated video, and nothing for a footage one', async () => {
    const withNote = async (generate: boolean) => {
      const files = await listJobFiles(jobDir);
      await new FakeBriefWriter({ speed: 1_000, generate }).write(job, {
        jobDir,
        files,
        note: 'Keep it tight. Budget $0.50 for this one.',
        signal: new AbortController().signal,
      });
      return draftOf();
    };
    writeFileSync(join(jobDir, 'brief.txt'), SCRIPT);
    rmSync(join(jobDir, 'clip.mp4'));
    expect((await withNote(true)).budgetUsd).toBe(0.5);
    // A folder with footage is not a generated video: no budget to read.
    writeFileSync(join(jobDir, 'clip.mp4'), 'x');
    expect((await withNote(true)).budgetUsd).toBeNull();
    // Off, the canned draft is what it always was.
    expect((await withNote(false)).budgetUsd).toBeNull();
  });

  describe('fakeBudgetUsd', () => {
    it('is the dollars a phrase like "budget $5" names', () => {
      expect(fakeBudgetUsd('budget $5')).toBe(5);
      expect(fakeBudgetUsd('Budget of $0.50, please')).toBe(0.5);
      expect(fakeBudgetUsd('the budget is $4.25 this time')).toBe(4.25);
      expect(fakeBudgetUsd('budget $ 7')).toBe(7);
    });

    it('is null for a note with no such phrase', () => {
      expect(fakeBudgetUsd(null)).toBeNull();
      expect(fakeBudgetUsd('')).toBeNull();
      expect(fakeBudgetUsd('keep it cheap')).toBeNull();
      expect(fakeBudgetUsd('budget 5')).toBeNull();
      expect(fakeBudgetUsd('budget $0')).toBeNull();
    });
  });

  describe('scriptLinesOf', () => {
    it('is the quoted block under the heading, a line per paragraph, quotes off', () => {
      expect(scriptLinesOf(SCRIPT)).toEqual([
        'You always think about the food you eat…',
        'But what about the view you look at every day?',
        'Get it now and save.',
      ]);
      expect(scriptLinesOf('Voice-over script\n\n"One line."')).toEqual(['One line.']);
      expect(scriptLinesOf('VOICEOVER SCRIPT\r\n\r\n“A”\r\n\r\nmore')).toEqual(['A']);
    });

    it('is null without the heading, without an opening quote, or without a closing one', () => {
      expect(scriptLinesOf('Just some notes about the video.')).toBeNull();
      expect(scriptLinesOf('VOICEOVER SCRIPT\n\nNo quotes here.')).toBeNull();
      expect(scriptLinesOf('VOICEOVER SCRIPT\n\n“Opened and never closed\n\nsecond')).toBeNull();
    });

    it('does not take a sentence that happens to say the words for the heading', () => {
      const note = `We wrote the voiceover script for the whole ad and it is long, so read it all.\n\n“Nope.”`;
      expect(scriptLinesOf(note)).toBeNull();
    });
  });

  describe('canvasesIn', () => {
    it('lists the sizes a brief can ask for, once each, in the order the text names them', () => {
      expect(canvasesIn('9:16 — 1080 × 1920, then 1:1 — 1080×1080 and 1080 x 1920 again')).toEqual([
        '1080x1920',
        '1080x1080',
      ]);
      expect(canvasesIn('1280x720 and 640 × 480')).toEqual([]);
    });
  });
});
