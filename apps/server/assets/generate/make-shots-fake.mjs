#!/usr/bin/env node
// The FAKE shots script (Generated videos): GN0's stub, kept when GN3 wrote the real make-shots.mjs.
// make-shots.mjs hands over to it when STUDIO_GENERATE_FAKE=1, so the engine, the Generate prompt and
// the tests can run the whole flow without a service or a key. It obeys the same JSON-line contract
// (packages/shared/src/domain/generate.ts), sends nothing anywhere and writes tiny placeholder files.
// It knows only the GN0 forms of the commands (the real script has --tier, `upload` and a required
// --budget; see the top of make-shots.mjs):
//
//   STUDIO_GENERATE_FAKE=1 node make-shots.mjs estimate "<edit dir>" --kind clip|still|reframe --model <slug> [--seconds N]
//   STUDIO_GENERATE_FAKE=1 node make-shots.mjs still    "<edit dir>" <id> --into looks|keyframes --model <slug> --prompt "…"
//                                [--ref <file>…] [--budget <usd>]
//   STUDIO_GENERATE_FAKE=1 node make-shots.mjs clip     "<edit dir>" <clipId> --model <slug> --start <file> [--end <file>]
//                                --seconds N --prompt "…" [--ref <file>…] [--take N] [--budget <usd>]
//   STUDIO_GENERATE_FAKE=1 node make-shots.mjs reframe  "<edit dir>" <clipId> --take N --aspect 1:1 [--budget <usd>]
//   STUDIO_GENERATE_FAKE=1 node make-shots.mjs upload   "<edit dir>" --file <image>     (a made-up URL)
//
// A call written for the real script works too if it names --kind (estimate) and --into (still) as
// above: --tier (easy|people|tilt) is accepted and recorded as the model, the other new flags are
// ignored. A real call to `estimate` with no --kind, or to `still` with no --into, is refused here.
//
// Prices are made up but steady (a clip is $0.036 a second, a still $0.004, a reframe $0.18), and
// every request that "spends" is recorded in edit/generate/spend.json the way the real script does,
// so the engine's money tracking and the budget guard can be tested: with --budget, a request that
// would take the total past it is refused (exit 2, over_budget). A still is a 1-pixel PNG, a clip
// and a reframe are a 1-second black MP4 (testdata/black-1s.mp4), whatever the prompt.
//
// The ORDER is the real script's, so a process killed at any moment (a test or a dev run that stops
// the engine) leaves the money right: the ledger line is written FIRST (state "booked", keyed by a
// hash of the request, so the same command again picks that line up and never books a second one),
// then the file (a temp file, then a rename: a reader never sees half of it), then the line is
// marked "completed" with the file's path. spend.json itself is always written to a temp file and
// renamed. A kill can leave a booked line without its file (the next call makes the file and does not
// charge again) or a file whose line is still "booked" (still counted); never a file with no line,
// and never a half-written ledger. Unlike the real script it takes no lock: its calls never overlap.
// Output: one JSON line on stdout; exit 0, 1, 2 (refused) or 3 (down).
// STUDIO_GENERATE_STUB_FAIL=<an error code> makes the calls fail with that code's words (the free
// estimate fails only for key_rejected, unavailable and bad_request, like the real service);
// STUDIO_GENERATE_STUB_FAIL_AFTER=<n> lets the first n requests that spend succeed first.
//
// Plain Node, no dependencies: it runs from the engine's assets/ folder in src and dist alike.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BLACK = join(HERE, 'testdata', 'black-1s.mp4');
export const EXIT = { ok: 0, failed: 1, refused: 2, down: 3 };

/** A 1x1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** The Higgsfield model each tier of the real script means (the fake only records it in spend.json). */
const TIER_SLUGS = {
  easy: 'kling-video/v2.5-turbo/standard/image-to-video',
  people: 'alibaba/wan-3.0/image-to-video',
  tilt: 'alibaba/wan-3.0/image-to-video',
};

export const PRICES = { clipPerSecond: 0.036, still: 0.004, reframe: 0.18 };

/** The words of each error code for Higgsfield: generateErrorMessage(code). */
export const MESSAGES = {
  balance_empty:
    'Higgsfield balance is empty: add funds in the Higgsfield console, then Retry (clips already made are kept).',
  key_rejected: 'Higgsfield key not accepted: check HIGGSFIELD_API_KEY in .env',
  over_budget: (need, budget) =>
    `This video needs about ${dollars(need)}, over the budget of ${dollars(budget, true)}: add a note like 'budget $5' and Retry.`,
  bad_request:
    'Higgsfield did not accept a request: the details are in the job’s log. Retry once; if it stops again, the engine needs a fix.',
  unavailable:
    'Higgsfield is not answering right now: wait a few minutes, then Retry (what was already made is kept).',
  generation_failed:
    'Higgsfield could not make a shot, even after retakes: Retry, or say in a note what to change.',
};

export const EXIT_FOR = {
  balance_empty: EXIT.refused,
  key_rejected: EXIT.refused,
  over_budget: EXIT.refused,
  unavailable: EXIT.down,
  bad_request: EXIT.failed,
  generation_failed: EXIT.failed,
};

/** Codes the free estimate also fails with. */
const FREE_FAILS = new Set(['key_rejected', 'unavailable', 'bad_request']);

const cents = (usd) => Math.round(usd * 100) / 100;

/** "$4.10" for a price; "$3" for a whole-dollar budget. */
function dollars(usd, whole = false) {
  const rounded = cents(usd);
  return whole && Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

class StubError extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? (typeof MESSAGES[code] === 'string' ? MESSAGES[code] : code));
    this.code = code;
    this.extra = extra;
  }
}

/** Flags may repeat (--ref a --ref b): every flag keeps all its values. */
function parseArgs(argv) {
  const flags = new Map();
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const values = flags.get(arg.slice(2)) ?? [];
      values.push(argv[i + 1] ?? '');
      flags.set(arg.slice(2), values);
      i += 1;
    } else words.push(arg);
  }
  return { flag: (name) => flags.get(name)?.[0], words };
}

function readSpend(path) {
  try {
    const spend = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(spend.entries)) return spend;
  } catch {
    // No spend.json yet.
  }
  return { entries: [], total: 0 };
}

/** Writes a file so a reader never sees half of it: a temp file next to it, then a rename. */
function writeAtomic(path, write) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  write(tmp);
  renameSync(tmp, path);
}

/** spend.json with its total, written atomically. */
function writeSpend(path, entries) {
  const text = `${JSON.stringify({ entries, total: totalOf(entries) }, null, 2)}\n`;
  writeAtomic(path, (tmp) => writeFileSync(tmp, text));
}

/**
 * The key of a request: the same job folder, kind, id, take, model and request always give the same
 * key (as the real script's Idempotency-Key does), so the same command again is one request.
 */
function requestKey(editDir, kind, id, take, model, request) {
  const text = JSON.stringify([dirname(editDir), kind, id, take, model, request]);
  return `studio-${createHash('sha256').update(text).digest('hex').slice(0, 48)}`;
}

const totalOf = (entries) =>
  Math.round(
    entries.filter((entry) => !entry.refunded).reduce((sum, entry) => sum + entry.usd, 0) * 1e6,
  ) / 1e6;

function priceOf(kind, seconds) {
  if (kind === 'clip') return Number((PRICES.clipPerSecond * seconds).toFixed(3));
  if (kind === 'still') return PRICES.still;
  if (kind === 'reframe') return PRICES.reframe;
  throw new StubError('bad_request', 'estimate needs --kind clip, still or reframe.');
}

function run(argv, env) {
  const { flag, words } = parseArgs(argv);
  const [command, editDir, id] = words;
  if (!['estimate', 'upload', 'still', 'clip', 'reframe'].includes(command ?? '') || !editDir) {
    throw new StubError(
      'bad_request',
      'Usage: make-shots.mjs estimate|upload|still|clip|reframe "<edit dir>" …',
    );
  }
  const dir = join(editDir, 'generate');
  const spendPath = join(dir, 'spend.json');
  const spend = readSpend(spendPath);

  const injected = env.STUDIO_GENERATE_STUB_FAIL;
  if (injected !== undefined && injected !== '') {
    if (!(injected in MESSAGES)) {
      throw new StubError('bad_request', `Unknown STUDIO_GENERATE_STUB_FAIL: ${injected}`);
    }
    // A request that spends fails once `FAIL_AFTER` of them are recorded; the free estimate only
    // fails the way the real service fails a free call.
    const after = Number(env.STUDIO_GENERATE_STUB_FAIL_AFTER ?? 0);
    const applies =
      command === 'estimate' || command === 'upload'
        ? FREE_FAILS.has(injected)
        : spend.entries.length >= after;
    if (applies) {
      const over = injected === 'over_budget';
      throw new StubError(
        injected,
        over ? MESSAGES.over_budget(4.1, 3) : undefined,
        over ? { needUsd: 4.1, budgetUsd: 3 } : {},
      );
    }
  }

  if (command === 'estimate') {
    const seconds = Number(flag('seconds') ?? 5);
    return { ok: true, command, usd: priceOf(flag('kind'), seconds) };
  }

  if (command === 'upload') {
    // Free like the real one; no file is read and nothing is sent: a made-up URL.
    const file = flag('file');
    if (!file) throw new StubError('bad_request', 'upload needs --file <image>.');
    return {
      ok: true,
      command,
      file,
      url: `https://stub.invalid/${encodeURIComponent(file)}`,
      cached: false,
      contentType: 'image/png',
    };
  }

  if (!id) throw new StubError('bad_request', `${command} needs an id.`);
  const model = flag('model') ?? TIER_SLUGS[flag('tier')] ?? 'stub/model';
  let kind;
  let file;
  let seconds = 0;
  let take = 0;
  if (command === 'still') {
    const into = flag('into');
    if (into !== 'looks' && into !== 'keyframes') {
      throw new StubError('bad_request', 'still needs --into looks or --into keyframes.');
    }
    if (!flag('prompt')) throw new StubError('bad_request', 'still needs --prompt "…".');
    kind = into === 'looks' ? 'look' : 'keyframe';
    file = `${into}/${id}.png`;
  } else if (command === 'clip') {
    seconds = Number(flag('seconds'));
    if (!(seconds > 0) || !flag('prompt')) {
      throw new StubError('bad_request', 'clip needs --seconds N and --prompt "…".');
    }
    if (!flag('start') || !existsSync(join(dir, flag('start')))) {
      throw new StubError('bad_request', 'clip needs --start <a keyframe that exists>.');
    }
    take = Number(flag('take') ?? 1);
    kind = 'clip';
    file = `clips/${id}/take-${take}.mp4`;
  } else {
    take = Number(flag('take'));
    if (!(take > 0) || !flag('aspect') || !existsSync(join(dir, `clips/${id}/take-${take}.mp4`))) {
      throw new StubError(
        'bad_request',
        'reframe needs --take N (a take that exists) and --aspect 1:1.',
      );
    }
    kind = 'reframe';
    file = `clips/${id}/take-${take}-${flag('aspect').replace(':', 'x')}.mp4`;
  }

  const usd = priceOf(kind === 'look' || kind === 'keyframe' ? 'still' : kind, seconds);
  const key = requestKey(editDir, kind, id, command === 'still' ? 1 : take, model, [
    flag('prompt') ?? null,
    flag('start') ?? null,
    flag('end') ?? null,
    flag('aspect') ?? null,
    seconds,
  ]);
  const target = join(dir, file);
  const answer = (entry) => {
    if (command === 'still')
      return { ok: true, command, id, file, usd: entry.usd, requestId: entry.requestId };
    if (command === 'clip') {
      return {
        ok: true,
        command,
        id,
        take,
        file,
        seconds,
        usd: entry.usd,
        requestId: entry.requestId,
      };
    }
    return { ok: true, command, id, take, file, usd: entry.usd, requestId: entry.requestId };
  };

  // The same request again: its line is already in the ledger, so it is not booked or charged twice.
  // A finished one with its file is answered at once; one whose file is missing (the process was
  // stopped after the line was written) gets its file now.
  let entry = [...spend.entries].reverse().find((other) => other.key === key);
  if (entry?.state === 'completed' && existsSync(target)) return { ...answer(entry), reused: true };

  if (!entry) {
    const budget = flag('budget') === undefined ? null : Number(flag('budget'));
    const total = totalOf(spend.entries);
    if (budget !== null && cents(total + usd) > cents(budget)) {
      const need = total + usd;
      throw new StubError('over_budget', MESSAGES.over_budget(need, budget), {
        needUsd: cents(need),
        budgetUsd: budget,
      });
    }
    // The ledger first: the line exists before anything it pays for does.
    entry = {
      at: new Date().toISOString(),
      kind,
      slug: model,
      usd,
      requestId: `stub-${spend.entries.length + 1}`,
      refunded: false,
      // Not in the shared schema (it ignores them): what lets the same command pick the line up again.
      id,
      take: command === 'still' ? 1 : take,
      key,
      state: 'booked',
    };
    spend.entries.push(entry);
    writeSpend(spendPath, spend.entries);
  }

  writeAtomic(target, (tmp) => {
    if (command === 'still') writeFileSync(tmp, PNG);
    else copyFileSync(BLACK, tmp);
  });
  entry.state = 'completed';
  entry.file = file;
  writeSpend(spendPath, spend.entries);

  return answer(entry);
}

export function main() {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2), process.env)));
    process.exit(EXIT.ok);
  } catch (error) {
    const code = error instanceof StubError ? error.code : 'bad_request';
    const message = error instanceof StubError ? error.message : String(error?.message ?? error);
    const extra = error instanceof StubError ? error.extra : {};
    console.log(JSON.stringify({ ok: false, code, message, ...extra }));
    process.exit(EXIT_FOR[code]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
