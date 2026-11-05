#!/usr/bin/env node
// The check a graphic run does on its own work (Graphics plan, "The run"; GR2). The run calls it
// from its project folder (<graphic>/work/) once the graphic is written:
//
//   node <this file> <id> <lengthSec> [--at 1.2,2.6] [--vars '{"name":"The owner"}']
//
// 1. `npx hyperframes lint` on the project, with every finding listed. The engine's index.html
//    always has one warning (subcomposition_blanks_before_host: its root runs 0.8 s past the
//    graphic, so the preview's loop breathes); it is marked as expected.
// 2. Snapshots of the graphic at 9:16, 16:9 and 1:1. `hyperframes snapshot` only takes a project
//    folder whose entry is index.html (GR2's spike), so each size is a copy of compositions/, lib/
//    and vendor/ in a temp folder with a host of that size: a checkerboard behind the graphic and
//    one mount of it that lasts the whole root (length + 0.8 s), so a frame after the length shows
//    whether the graphic is gone by itself. Snapshot also writes .hyperframes/ into the project it
//    shoots, which is why work/ itself is never shot.
// 3. One more set of snapshots, at 9:16 only and at the moments asked for, with every text field
//    the graphic declares set to "" (what an edit passes for a field with no words in its video;
//    CVP-278). A graphic must hide such a field's pill or box by itself; the run sees here whether
//    an empty one is left behind.
//
// It prints where the contact sheets are, for the run to look at, and exits 1 when lint has an
// error or a snapshot could not be made. Plain Node, no dependencies: it runs from the engine's
// assets/ folder in src and dist alike.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The sizes a graphic is checked at, as the preview names them (GRAPHIC_SIZE_PIXELS). */
export const CHECK_SIZES = [
  { name: '9x16', label: '9:16', width: 1080, height: 1920 },
  { name: '16x9', label: '16:9', width: 1920, height: 1080 },
  { name: '1x1', label: '1:1', width: 1080, height: 1080 },
];

/** How long the host runs past the graphic, as the preview's host (HOST_TAIL_SEC). */
export const TAIL_SEC = 0.8;

/** When the "after the end" frame is taken, past the graphic's length. */
export const AFTER_END_SEC = 0.3;

/** The lint finding the engine's own index.html always has. */
const EXPECTED_HOST_WARNING = 'subcomposition_blanks_before_host';

const ID_PATTERN = /^[0-9a-f]{12}$/;

/** A number of seconds as the CLI and the markup take it: at most 3 decimals, no trailing zeros. */
export function seconds(value) {
  return String(Math.round(value * 1000) / 1000);
}

function escapeAttribute(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The arguments: `{ id, lengthSec, at, vars }`, or `{ error }` with the line to print. `at` is the
 * times asked for (default: the middle of the graphic and just before its end), always with the
 * frame after the end added.
 */
export function parseArgs(argv) {
  const usage =
    'Usage: node check-graphic.mjs <id> <lengthSec> [--at 1.2,2.6] [--vars \'{"id":"text"}\']';
  const positional = [];
  let at = null;
  let vars = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--at' || arg === '--vars') {
      const value = argv[i + 1];
      if (value === undefined) return { error: `${arg} needs a value. ${usage}` };
      i++;
      if (arg === '--at') {
        at = value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '')
          .map(Number);
        if (at.length === 0 || at.some((time) => !(Number.isFinite(time) && time >= 0))) {
          return { error: `--at takes seconds separated by commas, like 1.2,2.6. ${usage}` };
        }
      } else {
        try {
          vars = JSON.parse(value);
        } catch {
          return { error: `--vars takes a JSON object, like '{"name":"Dana"}'. ${usage}` };
        }
        if (vars === null || typeof vars !== 'object' || Array.isArray(vars)) {
          return { error: `--vars takes a JSON object, like '{"name":"Dana"}'. ${usage}` };
        }
      }
    } else {
      positional.push(arg);
    }
  }
  const [id, length] = positional;
  if (id === undefined || length === undefined || positional.length > 2) return { error: usage };
  if (!ID_PATTERN.test(id)) return { error: `The id is 12 hex characters, not "${id}". ${usage}` };
  const lengthSec = Number(length);
  if (!(Number.isFinite(lengthSec) && lengthSec >= 0.5 && lengthSec <= 30)) {
    return { error: `The length is the graphic's seconds, 0.5 to 30, not "${length}". ${usage}` };
  }
  const asked = at ?? [lengthSec / 2, Math.max(0, lengthSec - 0.15)];
  const end = lengthSec + AFTER_END_SEC;
  const times = [...new Set([...asked, end].map((time) => seconds(time)))]
    .map(Number)
    .sort((a, b) => a - b);
  return { id, lengthSec, at: times, vars };
}

/**
 * The text fields a graphic's `data-composition-variables` declares, as `{ ids }`, or `{ error }`
 * with the line to print when the attribute is there but is not a JSON list. No attribute means
 * no fields.
 */
export function fieldIds(html) {
  const ids = [];
  for (const match of html.matchAll(/data-composition-variables\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const raw = (match[1] ?? match[2] ?? '')
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&amp;/gi, '&');
    let list;
    try {
      list = JSON.parse(raw);
    } catch {
      return { error: 'its data-composition-variables is not valid JSON' };
    }
    if (!Array.isArray(list)) return { error: 'its data-composition-variables is not a list' };
    for (const item of list) {
      const id = item === null || typeof item !== 'object' ? undefined : item.id;
      if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
    }
  }
  return { ids };
}

/**
 * The moments the empty-fields snapshot is taken at: the ones asked for, without the frame after
 * the end the check adds by itself (nothing of an empty field is expected there either way).
 */
export function emptyFieldMoments(at, lengthSec) {
  const end = lengthSec + AFTER_END_SEC;
  const before = at.filter((time) => time < end - 0.0005);
  return before.length > 0 ? before : at.slice(0, 1);
}

/** The host page of one check: the graphic mounted once over a checkerboard, at one size. */
export function checkHostHtml({ id, lengthSec, width, height, vars = {} }) {
  const lib = `lib-${id}`;
  const duration = seconds(lengthSec + TAIL_SEC);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="vendor/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: transparent; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; }
      #check-background { position: absolute; inset: 0; background: repeating-conic-gradient(#52525b 0% 25%, #3f3f46 0% 50%) 0 0 / 80px 80px; }
      #graphic { position: absolute; inset: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="check-background"></div>
      <div id="graphic" data-composition-id="${lib}" data-composition-src="compositions/${lib}.html" data-start="0" data-duration="${duration}" data-track-index="1" data-width="${width}" data-height="${height}" data-variable-values="${escapeAttribute(JSON.stringify(vars))}"></div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
}

/** The lines that say what lint found, and whether it found an error. */
export function lintReport(output) {
  let report;
  try {
    report = JSON.parse(output.slice(output.indexOf('{')));
  } catch {
    return { errors: 1, lines: ['Lint could not be read:', output.trim() || '(no output)'] };
  }
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const errors = typeof report.errorCount === 'number' ? report.errorCount : 0;
  const warnings = typeof report.warningCount === 'number' ? report.warningCount : 0;
  const lines = [
    `Lint: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`,
  ];
  for (const finding of findings) {
    const file =
      typeof finding.file === 'string' ? finding.file.split('/').slice(-2).join('/') : '';
    const where = file === '' ? '' : ` (${file}${finding.line ? `:${finding.line}` : ''})`;
    const expected =
      finding.code === EXPECTED_HOST_WARNING && file.endsWith('index.html')
        ? ' [expected: the engine’s index.html; leave it]'
        : '';
    lines.push(`  ${finding.severity} ${finding.code}${where}: ${finding.message}${expected}`);
    if (finding.fixHint && expected === '') lines.push(`    Fix: ${finding.fixHint}`);
  }
  return { errors, lines };
}

function hyperframes(args, cwd) {
  const result = spawnSync('npx', ['--yes', 'hyperframes', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HYPERFRAMES_NO_TELEMETRY: '1',
      HYPERFRAMES_SKIP_SKILLS: '1',
      NO_COLOR: '1',
    },
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { status: result.status, output, error: result.error };
}

/**
 * Snapshots the graphic at `times` at one size, in a copy of the project under `root/<folder>`
 * (the size's name by default), and says what to print: where the contact sheet and the frames are,
 * or why the snapshot failed.
 */
function snapshotSize({ project, root, id, lengthSec, size, vars, times, folder = size.name }) {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  for (const part of ['compositions', 'lib', 'vendor']) {
    if (existsSync(join(project, part)))
      cpSync(join(project, part), join(dir, part), { recursive: true });
  }
  writeFileSync(join(dir, 'index.html'), checkHostHtml({ id, lengthSec, ...size, vars }));
  const out = join(root, 'snaps', folder);
  const shot = hyperframes(
    ['snapshot', dir, '--at', times.join(','), '--no-end', '-o', out, '--describe', 'false'],
    project,
  );
  const sheet = join(out, 'contact-sheet.jpg');
  if (shot.status === 0 && existsSync(sheet)) {
    const frames = readdirSync(out)
      .filter((name) => name.endsWith('.png'))
      .sort();
    return {
      ok: true,
      lines: [
        `  ${size.label} (${size.width}×${size.height}): ${sheet}`,
        `    frames: ${frames.map((name) => join(out, name)).join(' ')}`,
      ],
    };
  }
  const tail = shot.output.trim().split('\n').slice(-12).join('\n');
  return {
    ok: false,
    lines: [
      `  ${size.label}: the snapshot failed${shot.error ? ` (${shot.error.message})` : ''}:\n${tail}`,
    ],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) {
    console.log(args.error);
    process.exit(2);
  }
  const { id, lengthSec, at, vars } = args;
  const project = process.cwd();
  const graphic = join(project, 'compositions', `lib-${id}.html`);
  if (!existsSync(graphic)) {
    console.log(
      `There is no compositions/lib-${id}.html here (${project}). Run this in the graphic's project folder.`,
    );
    process.exit(2);
  }

  let failed = false;
  const lint = hyperframes(['lint', '--json'], project);
  const report = lintReport(lint.output);
  console.log(report.lines.join('\n'));
  if (report.errors > 0) failed = true;

  const root = join(tmpdir(), `studio-graphic-check-${id}`);
  rmSync(root, { recursive: true, force: true });
  console.log(
    `\nSnapshots at ${at.map((time) => `${time}s`).join(', ')} (the last one is after the end: it must show only the checkerboard):`,
  );
  for (const size of CHECK_SIZES) {
    const done = snapshotSize({ project, root, id, lengthSec, size, vars, times: at });
    if (!done.ok) failed = true;
    console.log(done.lines.join('\n'));
  }

  const fields = fieldIds(readFileSync(graphic, 'utf8'));
  if ('error' in fields) {
    failed = true;
    console.log(`\nThe text fields could not be read: ${fields.error}.`);
  } else if (fields.ids.length === 0) {
    console.log('\nThe graphic declares no text fields, so there is no empty-fields snapshot.');
  } else {
    const [size] = CHECK_SIZES;
    const empty = Object.fromEntries(fields.ids.map((field) => [field, '']));
    const moments = emptyFieldMoments(at, lengthSec);
    console.log(
      `\nEvery text field empty (${fields.ids.join(', ')}), at ${moments.map((time) => `${time}s`).join(', ')}: nothing of a field may be left, no empty pill, box or plate and no gap (what holds no text, a logo or an accent line, may stay):`,
    );
    const done = snapshotSize({
      project,
      root,
      id,
      lengthSec,
      size,
      vars: empty,
      times: moments,
      folder: `${size.name}-empty`,
    });
    if (!done.ok) failed = true;
    console.log(done.lines.join('\n'));
  }
  console.log(
    failed
      ? '\nNot passed yet: fix what is listed above and run this check again.'
      : '\nLint passed and the snapshots are made. Look at each contact sheet with the Read tool (and a frame up close where you need to) before you call it done.',
  );
  process.exit(failed ? 1 : 0);
}

/** Whether this file is the script node was asked to run (not a module imported by a test). */
function isMain() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main();
