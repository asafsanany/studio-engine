#!/usr/bin/env node
// A stand-in for the `claude` binary in claude-runner.test.ts: no model, no network, no tokens.
//
// The runner passes the child a scrubbed environment, so the scenario comes from a file in the
// working directory (the job folder): stub-claude.json, for example
//   { "replay": "/abs/sample-run.jsonl", "writeFinal": true, "exitCode": 0 }
// Fields (all optional):
//   replay      path of a stream-json file to print line by line
//   lines       lines to print (after `replay`)
//   stderr      text to write to stderr
//   writeFinal  write edit/final.mp4
//   writeFiles  { "<path relative to the cwd>": "<content>" }: files to write (folders made),
//               e.g. edit/brief.json for the Brief run
//   exitCode    exit code (default 0)
//   delayMs     stay silent this long before printing anything, like a run waiting for a clip
//   hang        stay alive after printing, until signalled, or until the process that started
//               it is gone (a test killed mid-run: the stub is detached, so nothing else would
//               stop it, and it used to stay for hours) -- its grandchild goes with it
//   ignoreTerm  ignore SIGTERM (only SIGKILL stops it)
//   grandchild  start `sleep 300` in its own process group, like Claude Code's Bash tool does;
//               "stubborn" makes it ignore SIGTERM too. The stub never waits for it.
// It writes stub-claude.call.json (argv, env, pid, grandchild pid) next to it for the test.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const scenario = existsSync('stub-claude.json')
  ? JSON.parse(readFileSync('stub-claude.json', 'utf8'))
  : {};

// The process that started the stub; `hang` watches it (see `hangUntilOrphaned`).
const parentPid = process.ppid;

const call = {
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  pid: process.pid,
};

if (scenario.ignoreTerm) process.on('SIGTERM', () => {});

if (scenario.grandchild) {
  const command =
    scenario.grandchild === 'stubborn' ? 'trap "" TERM; exec sleep 300' : 'exec sleep 300';
  const child = spawn('/bin/bash', ['-c', command], { detached: true, stdio: 'ignore' });
  child.unref();
  call.grandchild = child.pid;
}
// Written whole, then renamed: a test that polls for the file never reads half of it.
writeFileSync('stub-claude.call.json.tmp', JSON.stringify(call));
renameSync('stub-claude.call.json.tmp', 'stub-claude.call.json');

if (scenario.delayMs) await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));

let out = '';
if (scenario.replay) out += readFileSync(scenario.replay, 'utf8');
for (const line of scenario.lines ?? []) out += `${line}\n`;
for (const [path, content] of Object.entries(scenario.writeFiles ?? {})) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
if (scenario.writeFinal) {
  mkdirSync('edit', { recursive: true });
  writeFileSync('edit/final.mp4', 'not really a video');
}
if (scenario.stderr) process.stderr.write(scenario.stderr);
process.exitCode = scenario.exitCode ?? 0;

// Pipes are asynchronous on macOS: let the write finish before the process may end.
process.stdout.write(out, () => {
  if (scenario.hang) hangUntilOrphaned();
});

/**
 * Stays alive until a signal ends it. The runner stops it in a test's normal course; if the test
 * process dies first (a timeout, Ctrl-C, a killed worker), the stub is re-parented to launchd
 * and would run for ever, so it ends itself, and the tool command it started, within a second.
 */
function hangUntilOrphaned() {
  setInterval(() => {
    if (process.ppid === parentPid && parentPid !== 1) return;
    if (call.grandchild) {
      try {
        process.kill(-call.grandchild, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    process.exit(1);
  }, 500);
}
