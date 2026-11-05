// A stand-in for get-song.mjs for the song command's tests (the script loads it from
// MUSIC_GET_SONG). What it does comes from the scenario file FAKE_SONG_SCENARIO points at, read on
// every call so a test can change it between two runs of the script:
//   { log, full, reel?: 'same' | <file>, fail?: { code, message }, title?, artist?, site?, via?,
//     url?, id? }
// Every call is appended to `log` as one JSON line. The Apify "key" is FAKE_SONG_TOKEN.

import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readApifyToken(env = process.env) {
  return env.FAKE_SONG_TOKEN ?? null;
}

export async function getSong(options) {
  const scenario = JSON.parse(readFileSync(process.env.FAKE_SONG_SCENARIO, 'utf8'));
  appendFileSync(
    scenario.log,
    `${JSON.stringify({
      title: options.title,
      artist: options.artist,
      version: options.version,
      link: options.link,
      workDir: options.workDir,
      tools: options.tools,
      cacheDir: options.cacheDir,
    })}\n`,
  );
  if (scenario.fail) {
    const error = new Error(scenario.fail.message);
    error.name = 'SongError';
    error.code = scenario.fail.code;
    throw error;
  }
  mkdirSync(options.workDir, { recursive: true });
  const full = join(options.workDir, 'song-full.m4a');
  copyFileSync(scenario.full, full);
  let reel = null;
  if (scenario.reel === 'same') reel = full;
  else if (scenario.reel) {
    reel = join(options.workDir, 'song-reel.m4a');
    copyFileSync(scenario.reel, reel);
  }
  return {
    full,
    reel,
    meta: {
      title: scenario.title ?? options.title ?? 'Song',
      artist: scenario.artist ?? options.artist ?? 'Artist',
      site: scenario.site ?? 'youtube-music',
      via: scenario.via ?? 'yt-dlp',
      url: scenario.url ?? 'https://www.youtube.com/watch?v=fake0000001',
      id: scenario.id ?? 'fake0000001',
      fullMs: 0,
    },
  };
}
