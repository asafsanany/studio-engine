// The composition the fake runner leaves in edit/preview/ when the Review switch is on (W2): W9's
// sample (apps/server/src/pipeline/testdata/preview/) copied into the job, with the job's name as
// its title. It is a real, playable HyperFrames composition (about 6 s, 1080x1920, one
// sub-composition), so the whole Review flow can be tried without a Claude run.

import { randomUUID } from 'node:crypto';
import { access, cp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUSIC_FILES } from '@studio/shared';
import { KILL_GRACE_MS } from './claude-process.js';
import { makeClip, resolveFfmpeg } from './fake-media.js';
import { previewFromHtml } from './preview-composition.js';

/**
 * W9's sample composition. tsc doesn't copy testdata/ into dist/, and this path works from
 * src/pipeline/ (dev, tests) and from dist/pipeline/ (the built server, e2e) alike: both are two
 * folders below apps/server/.
 */
export const FAKE_PREVIEW_TEMPLATE_DIR = fileURLToPath(
  new URL('../../src/pipeline/testdata/preview/', import.meta.url),
);

/** The text of the sample's `<title>` and `#title` element that the job's name replaces. */
export const SAMPLE_TITLE = 'Sample preview';

/** `text` safe to put in HTML text or in an attribute value. `&` first, so no entity is escaped twice. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The music element of the Soundtrack variant: music.mp3 under the cut, quietly (the cut's own sound is the tone). */
export const FAKE_MUSIC_VOLUME = 0.15;

/** Where the Soundtrack variant puts its audio element: before the progress bar, inside the root. */
const MUSIC_ANCHOR = '<div id="progress"></div>';

/**
 * The sample's `index.html` with the music playing: an `<audio id="music" src="music.mp3">` over
 * the whole composition at a low volume, which is what an edit run with Soundtrack on leaves. The
 * length is the composition's own (`data-duration` of its root).
 */
export function withMusicElement(html: string): string {
  const check = previewFromHtml(html);
  if (!check.ok) throw new Error(`the sample composition is not usable: ${check.problem}`);
  if (!html.includes(MUSIC_ANCHOR)) {
    throw new Error(`the sample composition has no ${MUSIC_ANCHOR} to put the music before`);
  }
  const audio = `<audio id="music" src="music.mp3" data-start="0" data-duration="${check.preview.durationSec}" data-track-index="3" data-volume="${FAKE_MUSIC_VOLUME}"></audio>`;
  // A function, not a string: a string replacement reads `$&` as a pattern.
  return html.replace(MUSIC_ANCHOR, () => `${audio}\n      ${MUSIC_ANCHOR}`);
}

export interface FakePreviewOptions {
  /**
   * The Soundtrack variant (the music switch is on): the composition plays `music.mp3` (see
   * `withMusicElement`), and a music.mp3 already in `preview/` is kept, with its modified time, in the
   * new one. Off (the default): the sample as it was before Soundtrack, byte for byte.
   */
  music?: boolean;
  /**
   * Formats (GN7): the folder inside edit/ the composition goes to, `preview` (the default) for
   * the main format or `preview-1x1` for an extra one. A composition in another folder never plays
   * music (the fake runner's extra formats are silent).
   */
  dirName?: string;
  /**
   * Formats (GN7): the frame size of an extra format. The sample is 1080x1920; with a size, its
   * root and page are that size instead. Left out: the sample as it is.
   */
  size?: { width: number; height: number };
}

/** The sample's markup at another frame size: the root's and the page's, nothing else changes. */
export function withFrameSize(
  html: string,
  { width, height }: { width: number; height: number },
): string {
  return html
    .replaceAll('data-width="1080"', `data-width="${width}"`)
    .replaceAll('data-height="1920"', `data-height="${height}"`)
    .replace('width=1080, height=1920', `width=${width}, height=${height}`)
    .replace('width: 1080px; height: 1920px;', `width: ${width}px; height: ${height}px;`);
}

/**
 * Writes the sample composition into `<editDir>/preview/`, with `title` (the job's name) in place
 * of "Sample preview". It is built in a dot-named folder next to it (the progress watcher ignores
 * those) and moved into place in one step, so a reader never sees half a composition. An existing
 * `preview/` is replaced. On any error the temporary folder is removed and the error rethrown.
 */
export async function writeFakePreview(
  editDir: string,
  title: string,
  templateDir: string = FAKE_PREVIEW_TEMPLATE_DIR,
  { music = false, dirName = 'preview', size }: FakePreviewOptions = {},
): Promise<void> {
  const temporary = join(editDir, `.preview-${randomUUID()}.tmp`);
  try {
    await cp(templateDir, temporary, { recursive: true });
    const indexPath = join(temporary, 'index.html');
    const html = await readFile(indexPath, 'utf8');
    if (!html.includes(SAMPLE_TITLE)) {
      throw new Error(`the sample composition has no "${SAMPLE_TITLE}" title`);
    }
    // A function, not a string: a string replacement would read `$&` in a job name as a pattern.
    const titled = html.replaceAll(SAMPLE_TITLE, () => escapeHtml(title));
    const sized = size === undefined ? titled : withFrameSize(titled, size);
    await writeFile(indexPath, music ? withMusicElement(sized) : sized);
    if (music) {
      // The music is the music script's, not this sample's: a new composition keeps the one playing.
      try {
        await rename(join(editDir, MUSIC_FILES.preview), join(temporary, 'music.mp3'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rm(join(editDir, dirName), { recursive: true, force: true });
    await rename(temporary, join(editDir, dirName));
  } catch (error) {
    // The music that was being kept goes back to where it was, if there is still a place for it.
    if (music) {
      await rename(join(temporary, 'music.mp3'), join(editDir, MUSIC_FILES.preview)).catch(
        () => {},
      );
    }
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

/** The sample composition's length when its `index.html` can't be read: what W9 made it. */
const SAMPLE_SECONDS = 6;

/** The pitch of the preview video's tone, apart from the fake edit's 330 Hz and 440 Hz. */
const PREVIEW_VIDEO_TONE_HZ = 550;

/**
 * The fake runner's stand-in for `npx hyperframes render` (the render step of `PreviewVideos`,
 * which then shrinks the result with ffmpeg as it always does): a test-pattern clip as long as the
 * composition in `cwd` (edit/preview/), with its `music.mp3` as the sound when it has one and a
 * tone when not. A real render of the sample takes far longer than the phone's Review (or its spec)
 * will wait.
 */
export async function renderFakePreviewVideo(
  cwd: string,
  out: string,
  signal: AbortSignal,
): Promise<void> {
  const ffmpeg = await resolveFfmpeg();
  if (ffmpeg === null) throw new Error('ffmpeg was not found');
  const html = await readFile(join(cwd, 'index.html'), 'utf8').catch(() => '');
  const check = previewFromHtml(html);
  const music = join(cwd, 'music.mp3');
  const audioFile = await access(music).then(
    () => music,
    () => undefined,
  );
  // Stopped (the job was removed) while this looked around: makeClip makes the folder of `out` first,
  // and that would bring a deleted job's edit/ back. Same words as an abort during the clip below.
  if (signal.aborted) throw new Error('it took too long');
  const result = await makeClip({ bin: ffmpeg, signal, killGraceMs: KILL_GRACE_MS }, out, {
    seconds: check.ok ? check.preview.durationSec : SAMPLE_SECONDS,
    pattern: 'testsrc2',
    toneHz: PREVIEW_VIDEO_TONE_HZ,
    audioFile,
  });
  if (result.status === 'aborted') throw new Error('it took too long');
  if (result.status === 'failed') throw new Error(result.message);
}
