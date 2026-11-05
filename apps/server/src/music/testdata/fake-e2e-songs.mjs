// The stand-in for the song getter and the trending picker that the e2e engine and the dev fakes point the
// music script at (SG12): MUSIC_GET_SONG and MUSIC_TRENDING_PICK can both name this file. Nothing here
// touches the network, Apify, YouTube or a key; the audio is made with ffmpeg.
//
//   getSong        a 40 s "song": a quiet tone for 20 s, then a loud one over it (a drop at 0:20 that the
//                  song command's loudness step finds, so the part it cuts starts on the bar line at 0:19.1
//                  that fake-e2e-hyperframes.mjs answers, 0.9 s before the drop). The title and artist come back as asked, so
//                  the record says what the brief asked for. A title that starts with "Fail" is a song
//                  the downloader cannot get: `unavailable`, as the Couldn't get the song board says.
//   pickTrending   a fixed pick with its numbers, as Instagram's would give them for #fpv: 18.4K reels,
//                  3 of the top 20, marked trending.
//
// The scenario-driven stand-ins next to it (fake-get-song.mjs, fake-trending-pick.mjs) are for the song
// command's own tests, which need to change what they answer between two calls.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** How long the made song is, and where its drop is. fake-e2e-hyperframes.mjs answers for the same. */
export const FAKE_SONG_SECONDS = 40;
export const FAKE_SONG_DROP_SECONDS = 20;

/** The pick every trending lookup answers. */
export const FAKE_TRENDING = {
  title: 'Skyline Run',
  artist: 'Dana Kahn',
  link: 'https://www.youtube.com/watch?v=fake0000002',
  trending: { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' },
};

export function readApifyToken() {
  return null;
}

function ffmpegBinary(env) {
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir !== '' && existsSync(join(dir, 'ffmpeg'))) return join(dir, 'ffmpeg');
  }
  for (const path of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (existsSync(path)) return path;
  }
  return 'ffmpeg';
}

function songError(code, message) {
  const error = new Error(message);
  error.name = 'SongError';
  error.code = code;
  return error;
}

export async function getSong(options) {
  if (/^fail/i.test(options.title ?? '')) {
    throw songError('unavailable', 'The downloader didn’t answer');
  }
  mkdirSync(options.workDir, { recursive: true });
  const full = join(options.workDir, 'song-full.m4a');
  const drop = FAKE_SONG_DROP_SECONDS;
  const made = spawnSync(
    ffmpegBinary(process.env),
    [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...[
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=220:sample_rate=48000:duration=${FAKE_SONG_SECONDS}`,
      ],
      ...[
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=110:sample_rate=48000:duration=${FAKE_SONG_SECONDS - drop}`,
      ],
      ...[
        '-filter_complex',
        `[0:a]volume=0.24[q];[1:a]volume=2.4,adelay=${drop * 1000}|${drop * 1000}[l];[q][l]amix=inputs=2:duration=first:normalize=0,aformat=channel_layouts=stereo`,
      ],
      ...['-c:a', 'aac', '-b:a', '128k', full],
    ],
    { encoding: 'utf8' },
  );
  if (made.status !== 0)
    throw songError('failed', `The fake song could not be made: ${made.stderr}`);
  return {
    full,
    reel: null,
    meta: {
      title: options.title ?? 'Song',
      artist: options.artist ?? 'Artist',
      site: 'youtube-music',
      via: 'yt-dlp',
      url: options.link ?? 'https://www.youtube.com/watch?v=fake0000001',
      id: 'fake0000001',
      fullMs: 0,
    },
  };
}

export async function pickTrending() {
  return { ...FAKE_TRENDING, note: null, event: null };
}
