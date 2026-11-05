// Helpers for the getter's tests (Songs, SG2): a bench with a fake yt-dlp (testdata/fake-yt-dlp.mjs
// driven by a scenario file), a fake fetch that records every call, and audio made with ffmpeg.
// Nothing here touches the network, the live inbox or the real ~/.studio-engine.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GetSongOptions } from '../../assets/music/get-song.mjs';

export const TESTDATA = fileURLToPath(new URL('./testdata/', import.meta.url));
export const FAKE_YT_DLP = join(TESTDATA, 'fake-yt-dlp.mjs');

/** A fixture file (testdata/<file>.json) read whole. */
export function fixtureFile<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(readFileSync(join(TESTDATA, `${file}.json`), 'utf8')) as T;
}

/** One entry of a fixture file. */
export function fixture<T = unknown>(file: string, name: string): T {
  const value = fixtureFile<Record<string, T>>(file)[name];
  if (value === undefined) throw new Error(`no fixture ${file}.json#${name}`);
  return value;
}

// --- the fake yt-dlp -----------------------------------------------------------------------------

export type Failing = { error: string; exit?: number };

/** What the fake yt-dlp does (see testdata/fake-yt-dlp.mjs). */
export interface Scenario {
  searches?: Record<string, string | Failing>;
  /** YouTube Music's own search (music.youtube.com/search?q=…), by the query. */
  musicSearches?: Record<string, string | Failing | { hang: true; pids: string }>;
  infos?: Record<string, string | Failing>;
  /** A video with a fixture of its id (testdata/youtube-info.json) is answered without being listed. */
  infosFromFixtures?: boolean;
  downloads?: Record<
    string,
    | { seconds: number; delayMs?: number }
    | Failing
    | { silent: string }
    | { hang: true; pids: string }
  >;
}

export interface FakeCall {
  at: number;
  kind: 'search' | 'music-search' | 'info' | 'download';
  phase?: 'start' | 'end';
  query?: string;
  id?: string;
  args?: string[];
  /** The names of the variables the fake yt-dlp was started with. */
  env: string[];
}

export interface Bench {
  root: string;
  workDir: string;
  scenarioFile: string;
  audioDir: string;
  tools: { ytDlp: string; deno: string; ffmpeg: string; ffprobe: string };
  /** Sets what the fake yt-dlp does (replaces the scenario). */
  set(scenario: Scenario): void;
  /** Every call the fake yt-dlp has had, in order. */
  calls(): FakeCall[];
  options(extra?: Partial<GetSongOptions>): GetSongOptions;
  dispose(): void;
}

export const TOKEN = 'apify_api_TESTKEY0123456789abcdef';

export function makeBench(ffmpeg: string, ffprobe: string, scenario: Scenario = {}): Bench {
  const root = mkdtempSync(join(tmpdir(), 'songs-test-'));
  const workDir = join(root, 'job', 'edit', 'music');
  const scenarioFile = join(root, 'scenario.json');
  const log = join(root, 'calls.jsonl');
  const audioDir = join(root, 'audio');
  mkdirSync(join(root, 'bin'), { recursive: true });
  const ytDlp = join(root, 'bin', 'yt-dlp');
  writeFileSync(ytDlp, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_YT_DLP}" "$@"\n`);
  chmodSync(ytDlp, 0o755);
  const deno = join(root, 'bin', 'deno');
  writeFileSync(deno, '#!/bin/sh\nexit 0\n');
  chmodSync(deno, 0o755);
  writeFileSync(log, '');

  const set = (next: Scenario): void => {
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        log,
        audioDir,
        ffmpeg,
        fixtures: {
          searches: join(TESTDATA, 'youtube-search.json'),
          musicSearches: join(TESTDATA, 'youtube-music-search.json'),
          infos: join(TESTDATA, 'youtube-info.json'),
        },
        ...next,
      }),
    );
  };
  set(scenario);

  const bench: Bench = {
    root,
    workDir,
    scenarioFile,
    audioDir,
    tools: { ytDlp, deno, ffmpeg, ffprobe },
    set,
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeCall),
    options: (extra = {}) => ({
      workDir,
      tools: { ytDlp, deno, ffmpeg, ffprobe },
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        FAKE_YTDLP: scenarioFile,
        APIFY_TOKEN: TOKEN,
      },
      envFile: join(root, 'no.env'),
      retryMs: 1,
      ...extra,
    }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
  return bench;
}

// --- the fake fetch ------------------------------------------------------------------------------

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export type Reply = Response | Error;

/**
 * A fetch that answers from `handler` (return `undefined` for a call nobody expects: the test then
 * fails with its URL) and records every call.
 */
export function fakeFetch(handler: (call: FetchCall) => Reply | Promise<Reply> | undefined) {
  const calls: FetchCall[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    const reply = await handler(call);
    if (reply === undefined) throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { fetch: fetchFn as typeof fetch, calls };
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });

export const bytes = (data: Uint8Array, type: string): Response =>
  new Response(data, { status: 200, headers: { 'content-type': type } });

// --- audio ---------------------------------------------------------------------------------------

/** A short silent audio file (m4a, or mp3 by extension) of `seconds`, made with ffmpeg. */
export function makeAudio(ffmpeg: string, file: string, seconds: number): Uint8Array {
  const codec = file.endsWith('.mp3') ? 'libmp3lame' : 'aac';
  const result = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=8000:cl=mono',
      '-t',
      String(seconds),
      '-c:a',
      codec,
      '-b:a',
      '16k',
      file,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`ffmpeg could not make ${file}: ${result.stderr}`);
  return readFileSync(file);
}

/** The length of an audio file in ms, read with ffprobe. */
export function lengthOf(ffprobe: string, file: string): number {
  const result = spawnSync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return Math.round(Number.parseFloat(result.stdout) * 1000);
}
