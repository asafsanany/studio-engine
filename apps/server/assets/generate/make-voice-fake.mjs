#!/usr/bin/env node
// The FAKE voice script (Generated videos): GN0's stub, kept when GN2 wrote the real make-voice.mjs.
// make-voice.mjs hands over to it when STUDIO_GENERATE_FAKE=1, so the engine, the Generate prompt and
// the tests can run the whole flow without a service. It obeys the same JSON-line contract
// (packages/shared/src/domain/generate.ts), sends nothing anywhere, needs no key and writes tiny
// placeholder files. It knows only the GN0 forms of three commands (the real script has `check` too):
//
//   STUDIO_GENERATE_FAKE=1 node make-voice.mjs line     "<edit dir>" <L1> [--take N]
//   STUDIO_GENERATE_FAKE=1 node make-voice.mjs assemble "<edit dir>" --pick L1=1,L2=2 [--lead 2800]
//   STUDIO_GENERATE_FAKE=1 node make-voice.mjs sfx      "<edit dir>" <name> --prompt "<what it sounds like>" [--seconds N]
//
// Every file is a 1-second silent mp3 (testdata/silence-1s.mp3), whatever the text or the prompt;
// the lengths it prints are nominal (1 s a line, no pauses). `--lead <ms>` (0 to 6000) works as in the
// real script: every line and word moves by the lead, durationSec grows by it, leadMs is recorded, and
// voice.mp3 gets a placeholder second for each started second of it. `line` reads the voice lines from
// edit/generate/plan.json, as the real script does. Output: one JSON line on stdout; exit 0, 1, 2
// (refused) or 3 (down). STUDIO_GENERATE_STUB_FAIL=<an error code> makes every call fail with that
// code's words; STUDIO_GENERATE_STUB_FAIL_AFTER=<n> lets the first n calls that make something
// succeed before it starts failing.
//
// Plain Node, no dependencies: it runs from the engine's assets/ folder in src and dist alike.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SILENCE = join(HERE, 'testdata', 'silence-1s.mp3');
export const EXIT = { ok: 0, failed: 1, refused: 2, down: 3 };
/** The longest `assemble --lead` (MASTER.leadMaxMs in make-voice.mjs). */
const LEAD_MAX_MS = 6000;

/** The words of each error code for ElevenLabs: generateErrorMessage(code, { service: 'elevenlabs' }). */
export const MESSAGES = {
  balance_empty:
    'ElevenLabs credits are used up: add credits in ElevenLabs, then Retry (what was already made is kept).',
  key_rejected:
    'ElevenLabs key not accepted: check ELEVENLABS_API_KEY in ~/Developer/video-use/.env',
  over_budget:
    "This video needs about $4.10, over the budget of $3: add a note like 'budget $5' and Retry.",
  bad_request:
    'ElevenLabs did not accept a request: the details are in the job’s log. Retry once; if it stops again, the engine needs a fix.',
  unavailable:
    'ElevenLabs is not answering right now: wait a few minutes, then Retry (what was already made is kept).',
  generation_failed:
    'ElevenLabs could not make a shot, even after retakes: Retry, or say in a note what to change.',
};

export const EXIT_FOR = {
  balance_empty: EXIT.refused,
  key_rejected: EXIT.refused,
  over_budget: EXIT.refused,
  unavailable: EXIT.down,
  bad_request: EXIT.failed,
  generation_failed: EXIT.failed,
};

class StubError extends Error {
  constructor(code, message = MESSAGES[code]) {
    super(message);
    this.code = code;
  }
}

/** `--name value` pairs and the words that are not flags, in order. */
function parseArgs(argv) {
  const flags = new Map();
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      flags.set(arg.slice(2), argv[i + 1] ?? '');
      i += 1;
    } else words.push(arg);
  }
  return { flags, words };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function made(dir, subdir) {
  const folder = join(dir, subdir);
  return existsSync(folder)
    ? readdirSync(folder).filter((name) => name.endsWith('.mp3')).length
    : 0;
}

/** Whether the injected failure applies to this call. */
function injected(env, dir, spends) {
  const code = env.STUDIO_GENERATE_STUB_FAIL;
  if (code === undefined || code === '') return null;
  if (!(code in MESSAGES))
    throw new StubError('bad_request', `Unknown STUDIO_GENERATE_STUB_FAIL: ${code}`);
  const after = Number(env.STUDIO_GENERATE_STUB_FAIL_AFTER ?? 0);
  if (spends && after > 0 && made(dir, 'voice') + made(dir, 'sfx') < after) return null;
  return code;
}

function run(argv, env) {
  const { flags, words } = parseArgs(argv);
  const [command, editDir, ...rest] = words;
  if (!['line', 'check', 'assemble', 'sfx'].includes(command ?? '') || !editDir) {
    throw new StubError(
      'bad_request',
      'Usage: make-voice.mjs line|check|assemble|sfx "<edit dir>" …',
    );
  }
  const dir = join(editDir, 'generate');
  const fail = injected(env, dir, command !== 'assemble');
  if (fail !== null) throw new StubError(fail);

  if (command === 'line' || command === 'check') {
    // Both forms: `line "<edit>" L1` (text from plan.json) and `line "<edit>" --id L1 --text "…"`.
    const named = /(L[1-9]\d*)-take(\d+)\.mp3$/.exec(flags.get('file') ?? '');
    const id = flags.get('id') ?? named?.[1] ?? rest[0];
    const plan = readJson(join(dir, 'plan.json'));
    const planned = plan?.voice?.find((entry) => entry.id === id);
    const text = flags.get('text') ?? planned?.text;
    if (!id || typeof text !== 'string' || text === '') {
      throw new StubError('bad_request', `There is no text for voice line ${id}.`);
    }
    const taken = existsSync(join(dir, 'voice'))
      ? readdirSync(join(dir, 'voice')).filter(
          (name) => name.startsWith(`${id}-take`) && name.endsWith('.mp3'),
        ).length
      : 0;
    if (command === 'line') {
      const take = flags.has('take') ? Number(flags.get('take')) : taken + 1;
      mkdirSync(join(dir, 'voice'), { recursive: true });
      const file = `voice/${id}-take${take}.mp3`;
      copyFileSync(SILENCE, join(dir, file));
      return {
        ok: true,
        command,
        id,
        take,
        file,
        ms: 1000,
        durationSec: 1,
        characters: text.length,
        chars: text.length,
      };
    }
    // check: every word is heard, evenly spread over the one second of the placeholder take.
    const take = flags.has('take')
      ? Number(flags.get('take'))
      : named
        ? Number(named[2])
        : Math.max(taken, 1);
    const file = `voice/${id}-take${take}.mp3`;
    if (!existsSync(join(dir, file))) {
      throw new StubError('bad_request', `There is no take ${take} of line ${id}.`);
    }
    const parts = text.split(/\s+/).filter(Boolean);
    const heard = parts.map((word, at) => ({
      text: word,
      startMs: Math.round((at * 1000) / parts.length),
      endMs: Math.round(((at + 1) * 1000) / parts.length),
    }));
    writeFileSync(
      join(dir, `voice/${id}-take${take}.words.json`),
      `${JSON.stringify({ file, id, take, text, heard: text, ms: 1000, match: true, missing: [], extra: [], words: heard }, null, 2)}\n`,
    );
    return {
      ok: true,
      command,
      id,
      take,
      file,
      match: true,
      missing: [],
      extra: [],
      heard: text,
      words: heard,
    };
  }

  if (command === 'assemble') {
    const picks = String(flags.get('pick') ?? flags.get('order') ?? '')
      .split(',')
      .filter(Boolean)
      .map((pair) => pair.split(/[:=]/));
    if (picks.length === 0) {
      throw new StubError('bad_request', 'assemble needs --order L1:2,L2:1 (or --pick L1=2,L2=1).');
    }
    const leadText = flags.get('lead');
    if (leadText !== undefined && !/^\d+$/.test(leadText)) {
      throw new StubError('bad_request', '--lead must be a whole number.');
    }
    const leadMs = leadText === undefined ? 0 : Number(leadText);
    if (leadMs > LEAD_MAX_MS) {
      throw new StubError(
        'bad_request',
        `--lead ${leadMs} is too long: the opening before the first word is ${LEAD_MAX_MS} ms (${LEAD_MAX_MS / 1000} s) at most.`,
      );
    }
    const leadSec = leadMs / 1000;
    const plan = readJson(join(dir, 'plan.json'));
    const lines = [];
    const spoken = [];
    for (const [index, [id, take]] of picks.entries()) {
      if (!existsSync(join(dir, `voice/${id}-take${take}.mp3`))) {
        throw new StubError('bad_request', `There is no take ${take} of line ${id}.`);
      }
      lines.push({
        id,
        take: Number(take),
        startSec: Number((leadSec + index).toFixed(3)),
        endSec: Number((leadSec + index + 1).toFixed(3)),
      });
      const text =
        plan?.voice?.find((entry) => entry.id === id)?.text ??
        readJson(join(dir, `voice/${id}-take${take}.words.json`))?.text ??
        '';
      const parts = text.split(/\s+/).filter(Boolean);
      parts.forEach((word, at) => {
        const slice = 1 / parts.length;
        spoken.push({
          line: id,
          text: word,
          startSec: Number((leadSec + index + at * slice).toFixed(3)),
          endSec: Number((leadSec + index + (at + 1) * slice).toFixed(3)),
        });
      });
    }
    const bytes = readFileSync(SILENCE);
    const opening = Array.from({ length: Math.ceil(leadMs / 1000) }, () => bytes);
    writeFileSync(join(dir, 'voice.mp3'), Buffer.concat([...opening, ...lines.map(() => bytes)]));
    const leadField = leadMs === 0 ? {} : { leadMs };
    writeFileSync(
      join(dir, 'voice-words.json'),
      `${JSON.stringify({ ...leadField, words: spoken }, null, 2)}\n`,
    );
    return {
      ok: true,
      command,
      file: 'voice.mp3',
      wordsFile: 'voice-words.json',
      ...leadField,
      durationSec: Number((leadSec + lines.length).toFixed(3)),
      lines,
    };
  }

  const name = flags.get('id') ?? rest[0];
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name) || !flags.get('prompt')) {
    throw new StubError('bad_request', 'sfx needs a name and --prompt "<what it sounds like>".');
  }
  mkdirSync(join(dir, 'sfx'), { recursive: true });
  copyFileSync(SILENCE, join(dir, `sfx/${name}.mp3`));
  return {
    ok: true,
    command,
    id: name,
    name,
    file: `sfx/${name}.mp3`,
    ms: 1000,
    durationSec: 1,
    characters: null,
  };
}

export function main() {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2), process.env)));
    process.exit(EXIT.ok);
  } catch (error) {
    const code = error instanceof StubError ? error.code : 'bad_request';
    const message = error instanceof StubError ? error.message : String(error?.message ?? error);
    console.log(JSON.stringify({ ok: false, code, message }));
    process.exit(EXIT_FOR[code]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
