// The small files a test job is made of, and writing a job folder into the inbox.

import { execFile } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** File names of the generated media, relative to the fixtures folder. */
export const MEDIA_FILES = ['clip.mp4', 'voice.m4a', 'brief.txt'] as const;

async function ffmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...args,
    ]);
  } catch (error) {
    throw new Error(
      `ffmpeg is needed to make the e2e test media (brew install ffmpeg): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** A 2 s test-pattern video with a tone, a 1.5 s tone as audio, and a text file. */
export async function makeMediaFixtures(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await ffmpeg([
    ...['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=2'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2'],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-pix_fmt', 'yuv420p'],
    ...['-c:a', 'aac', '-b:a', '48k', '-shortest', '-movflags', '+faststart'],
    join(dir, 'clip.mp4'),
  ]);
  await ffmpeg([
    ...['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=1.5'],
    ...['-c:a', 'aac', '-b:a', '48k'],
    join(dir, 'voice.m4a'),
  ]);
  await writeFile(join(dir, 'brief.txt'), 'Short and punchy. Keep the logo at the end.\n');
}

/**
 * The PINEWOOD brief the generated-video specs use: the client's own words trimmed for tests (the two
 * sizes and the complete voiceover script, seven lines, are word for word).
 */
const GENERATED_BRIEF = fileURLToPath(
  new URL('../../apps/server/src/pipeline/testdata/pinewood/PINEWOOD brief.txt', import.meta.url),
);

export interface JobFolderOptions {
  client: string;
  job: string;
  /** Names a step (`render`, `plan`, ...) the fake runner must fail at: writes `.fail-at-<step>`. */
  failAt?: string;
  /**
   * A job with no footage for the Generated videos switch (GN10): a brief with a voiceover script and
   * two sizes (9:16 and 1:1), and a reference video under `reference/`, which is never footage.
   * The fixture clip, voice note and text file are left out.
   */
  generated?: boolean;
  /**
   * The text of a `.fail-at-generate` marker (`[code] [after=N] [voice]`, see fake-generate.ts) that
   * makes the fake Generate run's scripts fail like a service: `balance_empty after=14`.
   */
  failGenerate?: string;
  /**
   * The client's text asks for music ("Please add music…" in a text file of the folder). Music is made
   * only when a job asks for it (U21), and the fake Brief reads that file, so a spec that wants music
   * made says so here; a job without it gets none ("No music asked for").
   */
  asksMusic?: boolean;
}

/** What the text file of a job that asks for music says. */
export const MUSIC_REQUEST = 'Please add music with a steady beat.\n';

/**
 * Creates `<inbox>/<client>/<job>/` with the fixture files (and the failure marker, if asked).
 * Everything is copied within a few milliseconds, so the folder settles as one arrival. Resolves
 * to the job folder.
 */
export async function createJobFolder(
  inbox: string,
  fixturesDir: string,
  { client, job, failAt, generated = false, failGenerate, asksMusic = false }: JobFolderOptions,
): Promise<string> {
  const jobDir = join(inbox, client, job);
  await mkdir(jobDir, { recursive: true });
  // The markers go first: by the time the job is queued they are there for the runner to see.
  if (failAt !== undefined) await writeFile(join(jobDir, `.fail-at-${failAt}`), '');
  if (failGenerate !== undefined) await writeFile(join(jobDir, '.fail-at-generate'), failGenerate);
  if (generated) {
    await copyFile(GENERATED_BRIEF, join(jobDir, 'PINEWOOD brief.txt'));
    await mkdir(join(jobDir, 'reference'), { recursive: true });
    await copyFile(join(fixturesDir, 'clip.mp4'), join(jobDir, 'reference', 'reference-video.mp4'));
    return jobDir;
  }
  for (const name of MEDIA_FILES) await copyFile(join(fixturesDir, name), join(jobDir, name));
  if (asksMusic) await writeFile(join(jobDir, 'Music request.txt'), MUSIC_REQUEST);
  return jobDir;
}
