import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FONT_LIMITS, FONT_MESSAGES } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  baseNameOf,
  createFontStaging,
  FONT_STAGE_REAP_INTERVAL_MS,
  FontUploadError,
  fontStagingRoot,
  isFontFileName,
  readUploadName,
  receiveFontFiles,
  startFontStagingReaper,
} from './font-staging.js';

// The staging folders and the upload that fills them (FN4): the folders are made, found, removed and
// reaped (with a clock the test holds); the multipart body is streamed to disk under names of the
// engine's own, with the name a folder pick sent kept only for the verdict.

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-font-staging-'));
  dirs.push(dir);
  return dir;
}

function age(dir: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(dir, when, when);
}

describe('createFontStaging', () => {
  it('makes an empty folder per stage under <data>/font-staging', async () => {
    const data = tempDir();
    const staging = createFontStaging({ dataDir: data });
    const a = await staging.create();
    const b = await staging.create();
    expect(a.stageId).toMatch(/^[0-9a-f]{12}$/);
    expect(a.stageId).not.toBe(b.stageId);
    expect(a.dir).toBe(join(fontStagingRoot(data), a.stageId));
    expect(statSync(a.dir).isDirectory()).toBe(true);
  });

  it('finds a stage by id, and not an unknown id or one that tries to leave the folder', async () => {
    const staging = createFontStaging({ dataDir: tempDir() });
    const stage = await staging.create();
    expect(await staging.find(stage.stageId)).toEqual(stage);
    expect(await staging.find('000000000000')).toBeNull();
    expect(await staging.find('..')).toBeNull();
    expect(await staging.find('../x')).toBeNull();
    expect(await staging.find('')).toBeNull();
  });

  it('removes a stage with what it holds, once', async () => {
    const staging = createFontStaging({ dataDir: tempDir() });
    const stage = await staging.create();
    writeFileSync(join(stage.dir, 'f0.upload'), 'x');
    expect(await staging.remove(stage.stageId)).toBe(true);
    expect(existsSync(stage.dir)).toBe(false);
    expect(await staging.remove(stage.stageId)).toBe(false);
    expect(await staging.remove('../..')).toBe(false);
    expect(await staging.find(stage.stageId)).toBeNull();
  });

  it('reaps the stages older than an hour and keeps the younger ones', async () => {
    const staging = createFontStaging({ dataDir: tempDir() });
    const old = await staging.create();
    const fresh = await staging.create();
    age(old.dir, FONT_LIMITS.stageLifetimeMs + 1000);
    age(fresh.dir, FONT_LIMITS.stageLifetimeMs - 60_000);
    expect(await staging.reap()).toBe(1);
    expect(existsSync(old.dir)).toBe(false);
    expect(existsSync(fresh.dir)).toBe(true);
    expect(await staging.reap()).toBe(0);
  });

  it('reaps at the time it is given, and every stage with `all`', async () => {
    const staging = createFontStaging({ dataDir: tempDir() });
    const a = await staging.create();
    const b = await staging.create();
    expect(await staging.reap()).toBe(0);
    expect(
      await staging.reap({ now: new Date(Date.now() + 2 * FONT_LIMITS.stageLifetimeMs) }),
    ).toBe(2);
    const c = await staging.create();
    expect(await staging.reap({ all: true })).toBe(1);
    for (const stage of [a, b, c]) expect(existsSync(stage.dir)).toBe(false);
  });

  it('judges age by the clock it was made with', async () => {
    let now = new Date();
    const staging = createFontStaging({ dataDir: tempDir(), clock: () => now });
    const stage = await staging.create();
    expect(await staging.reap()).toBe(0);
    now = new Date(Date.now() + FONT_LIMITS.stageLifetimeMs + 60_000);
    expect(await staging.reap()).toBe(1);
    expect(existsSync(stage.dir)).toBe(false);
  });

  it('has nothing to reap before the first stage, and ignores what is not a stage', async () => {
    const data = tempDir();
    const staging = createFontStaging({ dataDir: data });
    expect(await staging.reap({ all: true })).toBe(0);
    const stage = await staging.create();
    writeFileSync(join(fontStagingRoot(data), 'notes.txt'), 'x');
    expect(await staging.reap({ all: true })).toBe(1);
    expect(existsSync(stage.dir)).toBe(false);
    expect(existsSync(join(fontStagingRoot(data), 'notes.txt'))).toBe(true);
  });
});

describe('startFontStagingReaper', () => {
  it('reaps every stage at once (nothing waits across a restart) and the old ones every hour', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const staging = createFontStaging({ dataDir: tempDir() });
    const left = await staging.create();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const stop = startFontStagingReaper(staging, logger);
    await vi.waitFor(() => expect(existsSync(left.dir)).toBe(false));
    expect(logger.info).toHaveBeenCalledWith({ removed: 1 }, 'fonts: removed old uploads');

    const fresh = await staging.create();
    const old = await staging.create();
    age(old.dir, FONT_LIMITS.stageLifetimeMs + 1000);
    await vi.advanceTimersByTimeAsync(FONT_STAGE_REAP_INTERVAL_MS);
    await vi.waitFor(() => expect(existsSync(old.dir)).toBe(false));
    expect(existsSync(fresh.dir)).toBe(true);

    stop();
    age(fresh.dir, FONT_LIMITS.stageLifetimeMs + 1000);
    await vi.advanceTimersByTimeAsync(FONT_STAGE_REAP_INTERVAL_MS * 2);
    expect(existsSync(fresh.dir)).toBe(true);
  });
});

describe('the names an upload carries', () => {
  it('knows a font file by its extension, without regard to case, and a collection too', () => {
    for (const name of ['a.ttf', 'a.OTF', 'a.woff', 'a.WOFF2', 'a.ttc', 'a.otc']) {
      expect(isFontFileName(name), name).toBe(true);
    }
    for (const name of ['a.txt', 'a', 'a.ttf.zip', 'OFL.txt', '.DS_Store']) {
      expect(isFontFileName(name), name).toBe(false);
    }
  });

  it('takes the last part of a received name', () => {
    expect(baseNameOf('Fonts/Heebo/Heebo-Bold.ttf')).toBe('Heebo-Bold.ttf');
    expect(baseNameOf('Heebo-Bold.ttf')).toBe('Heebo-Bold.ttf');
  });

  it('keeps the folders of a folder pick and flags what came from a folder', () => {
    expect(readUploadName('Fonts/Heebo/Heebo-Bold.ttf')).toEqual({
      kind: 'file',
      name: 'Fonts/Heebo/Heebo-Bold.ttf',
      inFolder: true,
      candidate: true,
    });
    expect(readUploadName('Heebo-Bold.ttf')).toEqual({
      kind: 'file',
      name: 'Heebo-Bold.ttf',
      inFolder: false,
      candidate: true,
    });
  });

  it('reads Windows paths, Hebrew and dots in the middle, and cleans what is not safe to show', () => {
    expect(readUploadName('פונטים\\אלף\\Alef-Bold.ttf')).toMatchObject({
      name: 'פונטים/אלף/Alef-Bold.ttf',
      inFolder: true,
    });
    expect(readUploadName('a/../b/./c.ttf')).toMatchObject({ name: 'a/b/c.ttf' });
    expect(readUploadName('/abs/x.ttf')).toMatchObject({ name: 'abs/x.ttf', inFolder: true });
    expect(readUploadName('A\u0000B.ttf')).toMatchObject({ name: 'A B.ttf' });
  });

  it('ignores dot names anywhere, `._` copies, partial downloads and a licence text in a folder', () => {
    for (const name of [
      '.DS_Store',
      'Fonts/.DS_Store',
      'Fonts/__MACOSX/._Heebo.ttf',
      '.git/hooks/x.ttf',
      'Fonts/.hidden/Heebo.ttf',
      'Heebo.ttf.crdownload',
      'Fonts/Heebo/OFL.txt',
      'Fonts/Heebo/README.md',
      '',
      '..',
      '/',
    ]) {
      expect(readUploadName(name), name).toEqual({ kind: 'ignore' });
    }
  });

  it('keeps a lone file that is not a font, for the check to name', () => {
    expect(readUploadName('notes.txt')).toEqual({
      kind: 'file',
      name: 'notes.txt',
      inFolder: false,
      candidate: false,
    });
  });

  it('keeps the tail of a very long name', () => {
    const name = `${'folder/'.repeat(100)}Heebo-Bold.ttf`;
    const read = readUploadName(name);
    expect(read.kind).toBe('file');
    if (read.kind === 'file') {
      expect(Array.from(read.name).length).toBe(300);
      expect(read.name.endsWith('Heebo-Bold.ttf')).toBe(true);
    }
  });
});

function formWith(files: { name: string; data: string | Uint8Array }[]): FormData {
  const form = new FormData();
  for (const { name, data } of files) form.append('files[]', new Blob([data]), name);
  return form;
}

const post = (body: RequestInit['body'], headers: Record<string, string> = {}): Request =>
  new Request('http://localhost/upload', { method: 'POST', body, headers });

describe('receiveFontFiles', () => {
  it('stores each file under a name of the engine’s own and keeps the sent name for the verdict', async () => {
    const stageDir = tempDir();
    const form = formWith([
      { name: 'Fonts/Heebo/Heebo-Bold.ttf', data: 'bold' },
      { name: 'Fonts/Heebo/Heebo-Thin.otf', data: 'thin!' },
      { name: 'Alef-Regular.woff2', data: 'alef' },
    ]);

    const received = await receiveFontFiles(post(form), { stageDir });

    expect(received.ignored).toBe(0);
    expect(received.files).toEqual([
      { name: 'Fonts/Heebo/Heebo-Bold.ttf', path: join(stageDir, 'f0.upload'), bytes: 4 },
      { name: 'Fonts/Heebo/Heebo-Thin.otf', path: join(stageDir, 'f1.upload'), bytes: 5 },
      { name: 'Alef-Regular.woff2', path: join(stageDir, 'f2.upload'), bytes: 4 },
    ]);
    expect(readFileSync(received.files[0]?.path ?? '', 'utf8')).toBe('bold');
    expect(readFileSync(received.files[1]?.path ?? '', 'utf8')).toBe('thin!');
  });

  it('never builds a path from a name: `..` and absolute names write only inside the stage', async () => {
    const stageDir = tempDir();
    const form = formWith([
      { name: '../../escape.ttf', data: 'x' },
      { name: '/etc/evil.ttf', data: 'y' },
    ]);

    const received = await receiveFontFiles(post(form), { stageDir });

    expect(received.files.map((file) => file.name)).toEqual(['escape.ttf', 'etc/evil.ttf']);
    for (const file of received.files) expect(file.path.startsWith(`${stageDir}/f`)).toBe(true);
    expect(existsSync(join(stageDir, '..', '..', 'escape.ttf'))).toBe(false);
  });

  it('reads Hebrew file names as UTF-8', async () => {
    const stageDir = tempDir();
    const received = await receiveFontFiles(
      post(formWith([{ name: 'פונטים/אלף-רגיל.ttf', data: 'x' }])),
      { stageDir },
    );
    expect(received.files.map((file) => file.name)).toEqual(['פונטים/אלף-רגיל.ttf']);
  });

  it('throws away .DS_Store, `._` copies and a licence text inside a folder without a word', async () => {
    const stageDir = tempDir();
    const form = formWith([
      { name: 'Fonts/.DS_Store', data: 'junk' },
      { name: 'Fonts/Heebo/Heebo-Bold.ttf', data: 'bold' },
      { name: 'Fonts/__MACOSX/._Heebo-Bold.ttf', data: 'apple' },
      { name: 'Fonts/Heebo/OFL.txt', data: 'licence text' },
    ]);

    const received = await receiveFontFiles(post(form), { stageDir });

    expect(received.files.map((file) => file.name)).toEqual(['Fonts/Heebo/Heebo-Bold.ttf']);
    expect(received.ignored).toBe(3);
    expect(existsSync(join(stageDir, 'f1.upload'))).toBe(false);
  });

  it('keeps a lone file that is not a font in the list, without writing it', async () => {
    const stageDir = tempDir();
    const received = await receiveFontFiles(
      post(formWith([{ name: 'notes.txt', data: 'hello' }])),
      { stageDir },
    );
    expect(received.files).toEqual([
      { name: 'notes.txt', path: join(stageDir, 'f0.upload'), bytes: 5 },
    ]);
    expect(existsSync(join(stageDir, 'f0.upload'))).toBe(false);
  });

  it('counts a font over the per-file limit but writes nothing of it', async () => {
    const stageDir = tempDir();
    const received = await receiveFontFiles(
      post(
        formWith([
          { name: 'Huge.ttf', data: new Uint8Array(100) },
          { name: 'Small.ttf', data: new Uint8Array(10) },
        ]),
      ),
      { stageDir, maxFileBytes: 50 },
    );
    expect(received.files.map((file) => [file.name, file.bytes])).toEqual([
      ['Huge.ttf', 100],
      ['Small.ttf', 10],
    ]);
    expect(existsSync(join(stageDir, 'f0.upload'))).toBe(false);
    expect(statSync(join(stageDir, 'f1.upload')).size).toBe(10);
  });

  it('answers an empty list for a form with no file at all', async () => {
    const form = new FormData();
    form.append('note', 'hello');
    expect(await receiveFontFiles(post(form), { stageDir: tempDir() })).toEqual({
      files: [],
      ignored: 0,
    });
  });

  it('refuses more files than the limit with 413', async () => {
    const form = formWith([
      { name: 'a.ttf', data: 'a' },
      { name: 'b.ttf', data: 'b' },
      { name: 'c.ttf', data: 'c' },
    ]);
    await expect(
      receiveFontFiles(post(form), { stageDir: tempDir(), maxFiles: 2 }),
    ).rejects.toMatchObject({ status: 413, message: FONT_MESSAGES.tooManyFiles });
  });

  it('does not count what it throws away against the number of files', async () => {
    const form = formWith([
      { name: 'F/.DS_Store', data: 'a' },
      { name: 'F/a.ttf', data: 'a' },
      { name: 'F/OFL.txt', data: 'b' },
      { name: 'F/b.ttf', data: 'c' },
    ]);
    const received = await receiveFontFiles(post(form), { stageDir: tempDir(), maxFiles: 2 });
    expect(received.files).toHaveLength(2);
  });

  it('refuses more bytes in all than the limit with 413, thrown-away files included', async () => {
    await expect(
      receiveFontFiles(
        post(
          formWith([
            { name: 'a.ttf', data: new Uint8Array(60) },
            { name: 'b.ttf', data: new Uint8Array(60) },
          ]),
        ),
        { stageDir: tempDir(), maxTotalBytes: 100 },
      ),
    ).rejects.toMatchObject({ status: 413, message: FONT_MESSAGES.stageTooLarge });
    await expect(
      receiveFontFiles(post(formWith([{ name: 'F/.DS_Store', data: new Uint8Array(200) }])), {
        stageDir: tempDir(),
        maxTotalBytes: 100,
      }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('refuses a body that is not multipart with 400', async () => {
    const error = await receiveFontFiles(post('{}', { 'content-type': 'application/json' }), {
      stageDir: tempDir(),
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FontUploadError);
    expect(error).toMatchObject({ status: 400, message: FONT_MESSAGES.badImport });
    await expect(
      receiveFontFiles(new Request('http://localhost/upload', { method: 'POST' }), {
        stageDir: tempDir(),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a multipart body that is cut off or garbled with 400', async () => {
    const bad = post(
      '--x\r\nContent-Disposition: form-data; name="files[]"; filename="a.ttf"\r\n',
      {
        'content-type': 'multipart/form-data; boundary=x',
      },
    );
    await expect(receiveFontFiles(bad, { stageDir: tempDir() })).rejects.toMatchObject({
      status: 400,
    });
  });
});
