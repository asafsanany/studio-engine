import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  escapeHtml,
  FAKE_MUSIC_VOLUME,
  FAKE_PREVIEW_TEMPLATE_DIR,
  renderFakePreviewVideo,
  SAMPLE_TITLE,
  withMusicElement,
  writeFakePreview,
} from './fake-preview.js';
import { previewFromHtml, readPreview } from './preview-composition.js';

/** What the engine reads from a composition's text: its size and length, or nothing. */
function readPreviewFromHtml(html: string) {
  const check = previewFromHtml(html);
  return check.ok ? check.preview : null;
}

// The sample composition (W9) copied into a job's edit/ by the fake runner, with the job's name as
// its title. Real files in a temp folder.

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-fake-preview-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every file under `dir`, relative and sorted (folders included when they are dot-named). */
function listing(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]).sort();
}

const SAMPLE_FILES = [
  'assets/fonts/noto-sans-hebrew-hebrew-700-normal.woff2',
  'compositions/badge.html',
  'cut.mp4',
  'index.html',
  'vendor/gsap.min.js',
];

const HOSTILE = 'פרומו & "שבוע" <1> $&';

describe('escapeHtml', () => {
  it('escapes & < > " and \' (the ampersand first, so nothing is escaped twice)', () => {
    expect(escapeHtml(`a & b < c > d "e" 'f'`)).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;',
    );
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
    expect(escapeHtml('פרומו לסוף השבוע')).toBe('פרומו לסוף השבוע');
    expect(escapeHtml('')).toBe('');
  });
});

describe('FAKE_PREVIEW_TEMPLATE_DIR', () => {
  it("is W9's sample in the source tree, with a trailing slash", () => {
    expect(FAKE_PREVIEW_TEMPLATE_DIR).toMatch(/apps\/server\/src\/pipeline\/testdata\/preview\/$/);
    expect(readFileSync(join(FAKE_PREVIEW_TEMPLATE_DIR, 'index.html'), 'utf8')).toContain(
      SAMPLE_TITLE,
    );
  });
});

describe('writeFakePreview', () => {
  it('copies all five files of the sample into edit/preview/', async () => {
    const editDir = tempDir();

    await writeFakePreview(editDir, 'Spring menu');

    const files = listing(join(editDir, 'preview')).filter((path) =>
      statSync(join(editDir, 'preview', path)).isFile(),
    );
    expect(files).toEqual(SAMPLE_FILES);
    // Every file but index.html (it gets the title) is a byte for byte copy.
    for (const file of SAMPLE_FILES.filter((path) => path !== 'index.html')) {
      const copied = readFileSync(join(editDir, 'preview', file));
      expect(copied.equals(readFileSync(join(FAKE_PREVIEW_TEMPLATE_DIR, file))), file).toBe(true);
    }
    expect(readdirSync(editDir)).toEqual(['preview']);
  });

  it("puts the job's name in both places the sample says its title", async () => {
    const editDir = tempDir();

    await writeFakePreview(editDir, 'Spring menu');

    const html = readFileSync(join(editDir, 'preview', 'index.html'), 'utf8');
    expect(html).toContain('<title>Spring menu</title>');
    expect(html).toContain('<div id="title" dir="auto">Spring menu</div>');
    expect(html).not.toContain(SAMPLE_TITLE);
    // Nothing else of the page changed.
    const sample = readFileSync(join(FAKE_PREVIEW_TEMPLATE_DIR, 'index.html'), 'utf8');
    expect(html).toBe(sample.replaceAll(SAMPLE_TITLE, 'Spring menu'));
  });

  it('escapes the name: Hebrew stays, & " < > and $& are text, not markup or a pattern', async () => {
    const editDir = tempDir();

    await writeFakePreview(editDir, HOSTILE);

    const html = readFileSync(join(editDir, 'preview', 'index.html'), 'utf8');
    const escaped = 'פרומו &amp; &quot;שבוע&quot; &lt;1&gt; $&amp;';
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).toContain(`<div id="title" dir="auto">${escaped}</div>`);
    expect(html).not.toContain(SAMPLE_TITLE);
    expect(html.split(escaped)).toHaveLength(3);
  });

  it('leaves no dot-named folder or file behind', async () => {
    const editDir = tempDir();
    await writeFakePreview(editDir, 'Spring menu');
    expect(readdirSync(editDir)).toEqual(['preview']);
    expect(listing(editDir).some((path) => path.split('/').some((p) => p.startsWith('.')))).toBe(
      false,
    );
  });

  it('replaces an existing edit/preview/ whole', async () => {
    const editDir = tempDir();
    mkdirSync(join(editDir, 'preview', 'old'), { recursive: true });
    writeFileSync(join(editDir, 'preview', 'old', 'left-over.txt'), 'x');
    writeFileSync(join(editDir, 'preview', 'index.html'), '<p>an earlier round</p>');

    await writeFakePreview(editDir, 'Round two');

    expect(listing(join(editDir, 'preview'))).not.toContain('old/left-over.txt');
    expect(readFileSync(join(editDir, 'preview', 'index.html'), 'utf8')).toContain(
      '<title>Round two</title>',
    );
  });

  it('can be run twice in a row', async () => {
    const editDir = tempDir();
    await writeFakePreview(editDir, 'One');
    await writeFakePreview(editDir, 'Two');
    expect(readFileSync(join(editDir, 'preview', 'index.html'), 'utf8')).toContain(
      '<title>Two</title>',
    );
    expect(readdirSync(editDir)).toEqual(['preview']);
  });

  it('makes a composition the engine reads as 6 s, 1080x1920', async () => {
    const jobDir = tempDir();
    await writeFakePreview(join(jobDir, 'edit'), HOSTILE);

    expect(await readPreview(jobDir)).toEqual({
      ok: true,
      preview: { durationSec: 6, width: 1080, height: 1920 },
    });
  });

  it('creates edit/ when it is not there yet', async () => {
    const jobDir = tempDir();
    await writeFakePreview(join(jobDir, 'edit'), 'Fresh');
    expect(listing(join(jobDir, 'edit', 'preview'))).toEqual(expect.arrayContaining(SAMPLE_FILES));
  });

  it('throws, and leaves no temporary folder, for a template without the title', async () => {
    const editDir = tempDir();
    const template = tempDir();
    writeFileSync(join(template, 'index.html'), '<html><head><title>Other</title></head></html>');

    await expect(writeFakePreview(editDir, 'x', template)).rejects.toThrow(
      'the sample composition has no "Sample preview" title',
    );

    expect(readdirSync(editDir)).toEqual([]);
  });

  it('keeps an earlier preview/ when the new one cannot be made', async () => {
    const editDir = tempDir();
    mkdirSync(join(editDir, 'preview'), { recursive: true });
    writeFileSync(join(editDir, 'preview', 'index.html'), '<p>the earlier round</p>');
    const template = tempDir();
    writeFileSync(join(template, 'index.html'), 'no title here');

    await expect(writeFakePreview(editDir, 'x', template)).rejects.toThrow();

    expect(readFileSync(join(editDir, 'preview', 'index.html'), 'utf8')).toBe(
      '<p>the earlier round</p>',
    );
    expect(readdirSync(editDir)).toEqual(['preview']);
  });

  it('throws, and leaves no temporary folder, for a template that is not there', async () => {
    const editDir = tempDir();
    await expect(writeFakePreview(editDir, 'x', join(tempDir(), 'nope'))).rejects.toThrow();
    expect(readdirSync(editDir)).toEqual([]);
  });
});

// The Soundtrack variant (the music switch is on): the same sample, playing music.mp3.
describe('the Soundtrack variant of the sample', () => {
  const sample = () => readFileSync(join(FAKE_PREVIEW_TEMPLATE_DIR, 'index.html'), 'utf8');

  it('withMusicElement adds one quiet audio element over the whole composition and changes nothing else', () => {
    const html = withMusicElement(sample());

    const audio = `<audio id="music" src="music.mp3" data-start="0" data-duration="6" data-track-index="3" data-volume="${FAKE_MUSIC_VOLUME}"></audio>`;
    expect(html.split(audio)).toHaveLength(2);
    expect(html.replace(`${audio}\n      `, '')).toBe(sample());
    expect(FAKE_MUSIC_VOLUME).toBeLessThan(0.5);
    // The composition is still the one the engine reads.
    expect(readPreviewFromHtml(html)).toEqual({ durationSec: 6, width: 1080, height: 1920 });
  });

  it('withMusicElement needs a usable composition to put the music in', () => {
    expect(() => withMusicElement('<html></html>')).toThrow(/not usable/);
    expect(() => withMusicElement(sample().replace('<div id="progress"></div>', ''))).toThrow(
      /no <div id="progress"><\/div> to put the music before/,
    );
  });

  it('writes the sample with the audio element when the music is on, and byte for byte as before when it is off', async () => {
    const withMusic = tempDir();
    const without = tempDir();

    await writeFakePreview(withMusic, 'Spring menu', FAKE_PREVIEW_TEMPLATE_DIR, { music: true });
    await writeFakePreview(without, 'Spring menu', FAKE_PREVIEW_TEMPLATE_DIR, { music: false });
    const plain = tempDir();
    await writeFakePreview(plain, 'Spring menu');

    const musical = readFileSync(join(withMusic, 'preview', 'index.html'), 'utf8');
    expect(musical).toContain('<audio id="music" src="music.mp3"');
    expect(musical).toContain('<title>Spring menu</title>');
    expect(readFileSync(join(without, 'preview', 'index.html'), 'utf8')).toBe(
      readFileSync(join(plain, 'preview', 'index.html'), 'utf8'),
    );
    expect(readFileSync(join(plain, 'preview', 'index.html'), 'utf8')).not.toContain('<audio');
    // The same files: music.mp3 is the music script's, not the sample's.
    expect(listing(join(withMusic, 'preview'))).toEqual(listing(join(plain, 'preview')));
  });

  it('keeps the music.mp3 that is playing, with its modified time, in the new composition', async () => {
    const editDir = tempDir();
    await writeFakePreview(editDir, 'Spring menu', FAKE_PREVIEW_TEMPLATE_DIR, { music: true });
    const music = join(editDir, 'preview', 'music.mp3');
    writeFileSync(music, 'tone');
    const when = new Date('2026-10-23T09:00:00.000Z');
    utimesSync(music, when, when);

    await writeFakePreview(editDir, 'Round 1', FAKE_PREVIEW_TEMPLATE_DIR, { music: true });

    expect(readFileSync(music, 'utf8')).toBe('tone');
    expect(statSync(music).mtimeMs).toBe(when.getTime());
    expect(readFileSync(join(editDir, 'preview', 'index.html'), 'utf8')).toContain(
      '<title>Round 1</title>',
    );
    expect(readdirSync(editDir)).toEqual(['preview']);
  });

  it('is fine without a music.mp3 to keep, and drops it when the music is off', async () => {
    const editDir = tempDir();
    await writeFakePreview(editDir, 'One', FAKE_PREVIEW_TEMPLATE_DIR, { music: true });
    expect(existsSync(join(editDir, 'preview', 'music.mp3'))).toBe(false);

    writeFileSync(join(editDir, 'preview', 'music.mp3'), 'tone');
    await writeFakePreview(editDir, 'Two');
    expect(existsSync(join(editDir, 'preview', 'music.mp3'))).toBe(false);
  });

  it('leaves the music where it was when the new composition cannot be made', async () => {
    const editDir = tempDir();
    mkdirSync(join(editDir, 'preview'), { recursive: true });
    writeFileSync(join(editDir, 'preview', 'index.html'), '<p>the earlier round</p>');
    writeFileSync(join(editDir, 'preview', 'music.mp3'), 'tone');
    const template = tempDir();
    writeFileSync(join(template, 'index.html'), 'no title here');

    await expect(writeFakePreview(editDir, 'x', template, { music: true })).rejects.toThrow();

    expect(readFileSync(join(editDir, 'preview', 'music.mp3'), 'utf8')).toBe('tone');
    expect(readdirSync(editDir)).toEqual(['preview']);
  });
});

describe('renderFakePreviewVideo', () => {
  const run = promisify(execFile);

  /** The length of `file` in seconds, and whether it has a sound track, as ffprobe reads it. */
  async function probe(file: string): Promise<{ seconds: number; audio: boolean }> {
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type',
      '-of',
      'json',
      file,
    ]);
    const info = JSON.parse(stdout) as {
      format: { duration: string };
      streams: { codec_type: string }[];
    };
    return {
      seconds: Number(info.format.duration),
      audio: info.streams.some((stream) => stream.codec_type === 'audio'),
    };
  }

  it('makes a clip as long as the composition, with a tone', async () => {
    const editDir = tempDir();
    await writeFakePreview(editDir, 'One');
    const out = join(editDir, 'full.mp4');

    await renderFakePreviewVideo(join(editDir, 'preview'), out, AbortSignal.timeout(30_000));

    const { seconds, audio } = await probe(out);
    expect(seconds).toBeGreaterThan(5.5);
    expect(seconds).toBeLessThan(6.5);
    expect(audio).toBe(true);
  });

  it('fails when the render is stopped', async () => {
    const editDir = tempDir();
    await writeFakePreview(editDir, 'One');
    await expect(
      renderFakePreviewVideo(
        join(editDir, 'preview'),
        join(editDir, 'full.mp4'),
        AbortSignal.abort(),
      ),
    ).rejects.toThrow('it took too long');
    expect(existsSync(join(editDir, 'full.mp4'))).toBe(false);
  });
});
