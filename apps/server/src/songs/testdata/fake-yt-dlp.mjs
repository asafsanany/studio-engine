// A fake yt-dlp for the getter's tests (Songs, SG2). It answers the calls get-song.mjs makes, from
// a scenario file (the path is in FAKE_YTDLP), and logs every call to the scenario's log file. No
// network. Not a copy of yt-dlp: only the parts the getter relies on.
//
//   yt-dlp … -J --flat-playlist ytsearch8:<query>   -> searches[query] (a fixture name or { error })
//   yt-dlp … -J --flat-playlist https://music.youtube.com/search?q=<query>
//                                                    -> musicSearches[query] (C71: YouTube Music's
//                                                       own search; a fixture name, { error } or
//                                                       { hang: true, pids })
//   yt-dlp … -J --no-playlist <url>                  -> infos[<video id>]
//   yt-dlp … --print after_move:filepath … <url>     -> writes the audio and prints its path
//
// A scenario: { log, audioDir, ffmpeg, fixtures: { searches, musicSearches, infos }, searches: {
// query: name | { error, exit } }, musicSearches: { query: name | { error, exit } | { hang: true,
// pids } }, infos: { id: name | { error, exit } }, downloads: { id: { seconds } | { error, exit } |
// { silent: "text" } | { hang: true, pids } | { delayMs } } }, infosFromFixtures: true. A search
// nobody planned finds nothing.

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(process.env.FAKE_YTDLP, 'utf8'));

function log(entry) {
  appendFileSync(
    scenario.log,
    `${JSON.stringify({ at: Date.now(), env: Object.keys(process.env), ...entry })}\n`,
  );
}

function fixture(kind, name) {
  return JSON.parse(readFileSync(scenario.fixtures[kind], 'utf8'))[name];
}

function fail(rule) {
  process.stderr.write(`${rule.error}\n`);
  process.exit(rule.exit ?? 1);
}

const search = args.find((arg) => arg.startsWith('ytsearch'));
const url = args.at(-1);
const id = /[?&]v=([\w-]+)/.exec(url)?.[1] ?? url;
const musicQuery = url.startsWith('https://music.youtube.com/search?')
  ? new URL(url).searchParams.get('q')
  : null;

if (musicQuery !== null) {
  log({ kind: 'music-search', query: musicQuery, args });
  const rule = scenario.musicSearches?.[musicQuery];
  if (rule === undefined) {
    process.stdout.write(JSON.stringify({ _type: 'playlist', entries: [] }));
  } else if (typeof rule === 'string') {
    process.stdout.write(JSON.stringify({ _type: 'playlist', ...fixture('musicSearches', rule) }));
  } else if (rule.hang) {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    writeFileSync(rule.pids, JSON.stringify({ parent: process.pid, child: child.pid }));
    setTimeout(() => process.exit(0), 60_000);
  } else {
    fail(rule);
  }
} else if (search !== undefined) {
  const query = search.replace(/^ytsearch\d+:/, '');
  log({ kind: 'search', query, args });
  const rule = scenario.searches?.[query];
  if (rule === undefined) {
    process.stdout.write(JSON.stringify({ _type: 'playlist', entries: [] }));
  } else if (typeof rule === 'string') {
    process.stdout.write(JSON.stringify({ _type: 'playlist', ...fixture('searches', rule) }));
  } else {
    fail(rule);
  }
} else if (args.includes('--print')) {
  const rule = scenario.downloads?.[id] ?? { seconds: 30 };
  log({ kind: 'download', phase: 'start', id, args });
  if (rule.error !== undefined) fail(rule);
  if (rule.silent !== undefined) {
    process.stdout.write(`${rule.silent}\n`);
    log({ kind: 'download', phase: 'end', id });
    process.exit(0);
  }
  if (rule.hang) {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    writeFileSync(rule.pids, JSON.stringify({ parent: process.pid, child: child.pid }));
    setTimeout(() => process.exit(0), 60_000);
  } else {
    const template = args[args.indexOf('-o') + 1];
    const out = template.replace('%(ext)s', 'm4a').replaceAll('%%', '%');
    mkdirSync(dirname(out), { recursive: true });
    const cached = join(scenario.audioDir, `${rule.seconds}.m4a`);
    if (!existsSync(cached)) {
      mkdirSync(scenario.audioDir, { recursive: true });
      spawnSync(scenario.ffmpeg, [
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
        String(rule.seconds),
        '-c:a',
        'aac',
        '-b:a',
        '8k',
        cached,
      ]);
    }
    const finish = () => {
      copyFileSync(cached, out);
      log({ kind: 'download', phase: 'end', id });
      process.stdout.write(`${out}\n`);
    };
    if (rule.delayMs) setTimeout(finish, rule.delayMs);
    else finish();
  }
} else {
  log({ kind: 'info', id, args });
  // `infosFromFixtures`: a video with a fixture of its id is answered without listing it in `infos`
  // (the search of YouTube Music names the videos, so a test would repeat them all).
  const known = scenario.infosFromFixtures && fixture('infos', id) !== undefined ? id : undefined;
  const rule = scenario.infos?.[id] ?? known;
  if (rule === undefined) fail({ error: `ERROR: [youtube] ${id}: Video unavailable`, exit: 1 });
  else if (typeof rule === 'string') process.stdout.write(JSON.stringify(fixture('infos', rule)));
  else fail(rule);
}
