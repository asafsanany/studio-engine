#!/usr/bin/env node
// A stand-in for video-use's transcribe.py in voice-transcriber.test.ts: no network, no key.
// Run as `node stub-transcribe.mjs <audio> --edit-dir <dir> [--language xx]`, cwd = <dir>.
// Scenario: stub-transcribe.<stem>.json in the cwd, else stub-transcribe.json, else {}. Fields (all optional):
//   words      the transcript's words (default [{ "text": "stub", "type": "word" }]),
//              written to <edit-dir>/transcripts/<stem>.json as { language_code, text, words }
//   raw        write this text as the transcript file instead (a broken JSON)
//   noOutput   write no transcript
//   stderr     text to write to stderr
//   exitCode   exit code (default 0)
//   waitFor    a file name in the cwd: wait until it exists before going on (polls every 20 ms)
//   hang       stay alive after the call record (and the grandchild), until signalled
//   grandchild start `sleep 300` in the stub's own process group (as the helper's ffmpeg is) and record its pid
// Like the helper, an existing transcript prints "cached: <name>" and exits 0 without writing.
// First of all it writes stub-transcribe.<stem>.call.json (argv, env, cwd, pid, grandchild) to the cwd.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const audio = argv[0] ?? '';
const stem = basename(audio, extname(audio));
const editDirIndex = argv.indexOf('--edit-dir');
const editDir = resolve(editDirIndex >= 0 ? (argv[editDirIndex + 1] ?? '.') : '.');

const own = `stub-transcribe.${stem}.json`;
const shared = 'stub-transcribe.json';
const scenarioFile = existsSync(own) ? own : existsSync(shared) ? shared : null;
const scenario = scenarioFile === null ? {} : JSON.parse(readFileSync(scenarioFile, 'utf8'));

// Written whole, then renamed, so a test that polls for the file never reads half of it.
const callFile = `stub-transcribe.${stem}.call.json`;
const call = { argv, env: process.env, cwd: process.cwd(), pid: process.pid };
function writeCall() {
  writeFileSync(`${callFile}.tmp`, JSON.stringify(call));
  renameSync(`${callFile}.tmp`, callFile);
}
writeCall();

if (scenario.grandchild) {
  const child = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
  child.unref();
  call.grandchild = child.pid;
  writeCall();
}

if (scenario.waitFor) {
  while (!existsSync(scenario.waitFor)) await new Promise((done) => setTimeout(done, 20));
}

if (scenario.hang) {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

const transcript = join(editDir, 'transcripts', `${stem}.json`);
if (existsSync(transcript)) {
  console.log(`cached: ${basename(transcript)}`);
  process.exit(0);
}

// Pipes are asynchronous on macOS: let the write finish before the process may end.
if (scenario.stderr) await new Promise((done) => process.stderr.write(scenario.stderr, done));

if (!scenario.noOutput) {
  mkdirSync(join(editDir, 'transcripts'), { recursive: true });
  if (scenario.raw !== undefined) {
    writeFileSync(transcript, scenario.raw);
  } else {
    const words = scenario.words ?? [{ text: 'stub', type: 'word' }];
    const text = words.map((entry) => entry.text).join(' ');
    writeFileSync(transcript, JSON.stringify({ language_code: 'eng', text, words }));
  }
}

process.exitCode = scenario.exitCode ?? 0;
