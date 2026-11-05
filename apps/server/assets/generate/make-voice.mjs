#!/usr/bin/env node
// The voice script of Generated videos (plan section 2.2, GN2). The Generate run calls it from Bash:
// it makes the voiceover line by line with ElevenLabs, checks every take by listening to it with
// Scribe, joins the picked takes into the timing master, and makes short sound effects. It is the
// only writer of edit/generate/voice/, voice.mp3, voice-words.json and sfx/.
//
//   node make-voice.mjs line     "<edit dir>" --id L3 --text "…" [--direction "…"] [--take 1]
//   node make-voice.mjs check    "<edit dir>" --file voice/L3-take1.mp3 --text "…" [--language en]
//   node make-voice.mjs assemble "<edit dir>" --order L1:2,L2:1,… [--pauses "L1>L2:500,…"] [--pause 350] [--lead 2800]
//   node make-voice.mjs sfx      "<edit dir>" --id alert --prompt "…" [--seconds 1.2]
//
// The shapes are the shared contract's (packages/shared/src/domain/generate.ts): the GN0 forms work
// too (`line "<edit>" L3 [--take N]` and `check "<edit>" L3 [--take N]` read the text and the
// direction from plan.json's `voice`; `assemble --pick L1=2,L2=1`; `sfx "<edit>" alert --prompt …`).
// Every line below is ONE JSON line on stdout; paths in it are relative to <edit dir>/generate/.
//
// line      makes one take of one line with the configured voice (--voice, then
//           STUDIO_GENERATE_VOICE_ID, then DEFAULT_VOICE_ID) and writes voice/L3-take1.mp3. The take
//           number is --take, else the next free one. A remade take drops its words file.
//           → {"ok":true,"command":"line","id":"L3","take":1,"file":"voice/L3-take1.mp3","ms":3180,
//              "durationSec":3.18,"characters":58,"chars":58,"model":"eleven_v3","voice":"…",
//              "directionApplied":true}
//           The text is spoken as given: the caller spells numbers as words ("ninety-seven dollars").
// check     sends the take to Scribe and compares what it heard with the script's text (case,
//           punctuation, hyphens and numbers do not matter: "$97" is "ninety-seven dollars"). A word
//           the voice dropped is in `missing`, a word it added or changed is in `extra`. `words` are
//           the heard words with their times in the take, also kept in voice/L3-take1.words.json for
//           `assemble`. ok is true when the check ran; `match` is the result.
//           → {"ok":true,"command":"check","id":"L3","take":1,"file":"voice/L3-take1.mp3",
//              "match":false,"missing":["But"],"extra":[],"heard":"…","words":[{"text":"…",
//              "startMs":0,"endMs":180}]}
// assemble  joins the picked takes, in that order, with silences (--pauses "L1>L2:500" for one gap,
//           --pause for every other, default 350 ms) into voice.mp3 at -16 LUFS, and writes
//           voice-words.json: every heard word with its start and end in voice.mp3, worked out from
//           each take's words file plus the offsets (no second transcription), so every picked take
//           must have been checked. --lead <ms> (whole milliseconds, 0 to 6000) puts that much
//           silence at the start of voice.mp3, for a video that opens on a shot before anyone speaks
//           (an alert, a title): time 0 of voice.mp3 stays time 0 of the cut, the first line starts
//           at the lead, every line and word and the total length move by it, and `leadMs` is said in
//           the answer and recorded in voice-words.json. The loudness is measured on the speech alone,
//           so the lead changes nothing else. Without --lead (or with --lead 0) nothing is different.
//           → {"ok":true,"command":"assemble","file":"voice.mp3","wordsFile":"voice-words.json",
//              "ms":31100,"durationSec":31.1,"lufs":-16,"lines":[{"id":"L1","take":2,"startMs":0,
//              "endMs":3200,"startSec":0,"endSec":3.2,"match":true}]}
// sfx       makes a short sound effect from a description (ElevenLabs sound generation) and writes
//           sfx/alert.mp3. --seconds is optional (0.5 to 30; without it ElevenLabs picks).
//           → {"ok":true,"command":"sfx","id":"alert","name":"alert","file":"sfx/alert.mp3",
//              "ms":1020,"durationSec":1.02,"characters":null}
//
// Failure: {"ok":false,"code":"…","message":"…","detail":"…"} with the codes and plain words of the
// shared contract (generateErrorMessage) and its exit codes: 0 done, 1 failed (a bad request),
// 2 refused (the key, the credits), 3 ElevenLabs is down or busy. `detail` is for the log.
//
// Model: Eleven v3 first (it follows audio tags, so a delivery direction like "a clear stop after
// BUT, weighty question" becomes the tags [a clear stop after BUT] [weighty question] before the
// text); when the account is refused that model, one retry with Multilingual v2 (stability, style
// and the text's own punctuation; the direction cannot be applied). `model` says which was used.
// The model is chosen by the call, not by listing models: the key may not be allowed to list them.
//
// Safety: the key is read here, from ~/Developer/video-use/.env and then ELEVENLABS_API_KEY, and is
// only ever sent in the request's header: never printed, never an argument, taken out of every
// message. Nothing is written outside <edit dir>/generate/ (ids and names are checked, paths are
// resolved through symlinks). 90 s a take, 180 s a check, one retry on a 5xx, a 429 or a network
// error. For tests: VOICE_API_BASE (a local address only), VOICE_TIMEOUT_MS, VOICE_RETRY_MS,
// VOICE_FFMPEG, VOICE_FFPROBE. STUDIO_GENERATE_FAKE=1 runs make-voice-fake.mjs instead: GN0's stub
// (silent placeholder files, no key, no network, STUDIO_GENERATE_STUB_FAIL=<code> to fail on request).
//
// Plain Node, no dependencies: it runs from the engine's assets/ folder in src and dist alike.

import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareWords } from './voice-text.mjs';

/** GENERATE_EXIT_CODES in the shared contract. */
export const EXIT = { ok: 0, failed: 1, refused: 2, down: 3 };

/** Where ElevenLabs' key is read from first: video-use's .env (then ELEVENLABS_API_KEY). */
export const KEY_FILE = join(homedir(), 'Developer', 'video-use', '.env');
const KEY_PLACE = '~/Developer/video-use/.env';
const KEYS_PAGE = 'https://elevenlabs.io/app/settings/api-keys';

/**
 * The voice when nothing names one (DEFAULT_GENERATE_VOICE_ID in the shared contract): Kal Jones
 * ("Deep, Smokey and Reliable", from ElevenLabs' voice library), the owner's pick on 25 Oct after they did not like
 * Brian.
 */
export const DEFAULT_VOICE_ID = '68RUZBDjLe2YBQvv8zFx';

/** ElevenLabs' API and how this script calls it. */
export const ELEVENLABS = {
  base: 'https://api.elevenlabs.io',
  /** Follows audio tags: the direction becomes tags. */
  expressiveModel: 'eleven_v3',
  /** The fallback: no tags, so the direction cannot be applied. */
  steadyModel: 'eleven_multilingual_v2',
  scribeModel: 'scribe_v1',
  /** 128 kb/s mono is allowed on every plan; assemble makes the 192 kb/s master. */
  speechFormat: 'mp3_44100_128',
  speechBytesPerSec: 16_000,
  speechTimeoutMs: 90_000,
  scribeTimeoutMs: 180_000,
  sfxTimeoutMs: 60_000,
  retryMs: 1_500,
  textMax: 5_000,
  promptMax: 450,
  secondsMin: 0.5,
  secondsMax: 30,
};

/** What `assemble` makes: the speech master. */
export const MASTER = {
  sampleRate: 44_100,
  bitrate: '192k',
  integratedLufs: -16,
  truePeakDbtp: -1.5,
  defaultPauseMs: 350,
  /** The longest lead `assemble --lead` puts before the first word (LEAD_MAX_MS in the shared contract). */
  leadMaxMs: 6_000,
};

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

/** generateExitCode in the shared contract. */
export const EXIT_FOR = {
  balance_empty: EXIT.refused,
  key_rejected: EXIT.refused,
  over_budget: EXIT.refused,
  unavailable: EXIT.down,
  bad_request: EXIT.failed,
  generation_failed: EXIT.failed,
};

/** A failure with its code (GENERATE_ERROR_CODES), the contract's plain words, and a detail for the log. */
export class VoiceError extends Error {
  constructor(code, detail = '', extra = {}) {
    super(MESSAGES[code]);
    this.name = 'VoiceError';
    this.code = code;
    this.detail = detail;
    this.message = extra.message ?? MESSAGES[code];
    this.modelRefused = extra.modelRefused === true;
  }
}

const bad = (detail) => new VoiceError('bad_request', detail);

// --- the key ------------------------------------------------------------------------------------

/** Keys this process has read: `redact` takes each of them out, whatever they look like. */
const secrets = new Set();

/** Text with the key taken out: the key this process read, anything like sk_…, and an xi-api-key value. */
export function redact(text) {
  let out = String(text);
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[key]');
  return out
    .replace(/sk_[A-Za-z0-9_-]+/g, 'sk_…')
    .replace(/(xi-api-key["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[key]');
}

/** One variable's value in a .env text (the doctor's parseDotenv rules), or `null`. */
function dotenvValue(text, name) {
  let found = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1 || line.slice(0, eq).trim() !== name) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    found = value;
  }
  return found;
}

/** ElevenLabs' key: ELEVENLABS_API_KEY in video-use's .env, then in the environment, or `null`. */
export function readKey(env = process.env, file = KEY_FILE) {
  let key = '';
  try {
    key = (dotenvValue(readFileSync(file, 'utf8'), 'ELEVENLABS_API_KEY') ?? '').trim();
  } catch {
    // No .env: the environment's, if any.
  }
  if (key === '' && typeof env.ELEVENLABS_API_KEY === 'string') key = env.ELEVENLABS_API_KEY.trim();
  if (key === '') return null;
  secrets.add(key);
  return key;
}

function requireKey(env) {
  const key = readKey(env);
  if (key === null) {
    throw new VoiceError(
      'key_rejected',
      `There is no ElevenLabs key: put it after ELEVENLABS_API_KEY= in ${KEY_PLACE}.`,
    );
  }
  return key;
}

// --- arguments ----------------------------------------------------------------------------------

/** The options each command takes (all of them take a value). The key is never one of them. */
const OPTIONS = {
  line: ['id', 'text', 'direction', 'take', 'voice', 'model'],
  check: ['id', 'file', 'take', 'text', 'language'],
  assemble: ['order', 'pick', 'pauses', 'pause', 'lead'],
  sfx: ['id', 'prompt', 'seconds'],
};
const LINE_ID = /^L[1-9]\d*$/;
const NAME = /^[A-Za-z0-9_-]{1,60}$/;
const VOICE_ID = /^[A-Za-z0-9]{8,64}$/;

/** `<command> "<edit dir>" [word] --option value …`; throws a bad_request for anything else. */
export function parseArgs(argv) {
  const [command, editDir, ...rest] = argv;
  if (!(command in OPTIONS) || typeof editDir !== 'string' || editDir === '') {
    throw bad('Usage: make-voice.mjs line|check|assemble|sfx "<edit dir>" …');
  }
  const options = new Map();
  const words = [];
  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!OPTIONS[command].includes(name)) throw bad(`${command} has no option --${name}.`);
      if (at + 1 >= rest.length) throw bad(`--${name} needs a value.`);
      options.set(name, rest[at + 1]);
      at += 1;
    } else words.push(arg);
  }
  if (words.length > (command === 'assemble' ? 0 : 1)) {
    throw bad(`Unexpected "${words[command === 'assemble' ? 0 : 1]}".`);
  }
  return { command, editDir, word: words[0] ?? null, options };
}

function wholeNumber(text, what, min = 1) {
  if (!/^\d+$/.test(String(text))) throw bad(`${what} must be a whole number.`);
  const n = Number(text);
  if (n < min) throw bad(`${what} must be at least ${min}.`);
  return n;
}

/** "L1:2,L2:1" or "L1=2,L2=1" as [{ id, take }]; each line once. */
export function parseOrder(text) {
  const out = [];
  for (const part of String(text ?? '')
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean)) {
    const match = /^(L[1-9]\d*)[:=](\d+)$/.exec(part);
    if (!match || Number(match[2]) < 1) throw bad(`"${part}" is not a line and a take, like L1:2.`);
    if (out.some((entry) => entry.id === match[1]))
      throw bad(`Line ${match[1]} is in the order twice.`);
    out.push({ id: match[1], take: Number(match[2]) });
  }
  if (out.length === 0) throw bad('assemble needs --order L1:2,L2:1 (a line and its take).');
  return out;
}

/** `--lead`: whole milliseconds of silence before the first line, 0 to 6000; nothing given is 0. */
export function parseLead(text) {
  if (text === undefined) return 0;
  const lead = wholeNumber(text, '--lead', 0);
  if (lead > MASTER.leadMaxMs) {
    throw bad(
      `--lead ${lead} is too long: the opening before the first word is ${MASTER.leadMaxMs} ms (${MASTER.leadMaxMs / 1000} s) at most.`,
    );
  }
  return lead;
}

/** "L1>L2:500,L2>L3:250" as a Map of "L1>L2" → ms. */
export function parsePauses(text) {
  const out = new Map();
  for (const part of String(text ?? '')
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean)) {
    const match = /^(L[1-9]\d*)>(L[1-9]\d*):(\d+)$/.exec(part);
    if (!match) throw bad(`"${part}" is not a pause, like L1>L2:500.`);
    const ms = Number(match[3]);
    if (ms > 10_000) throw bad(`A pause of ${ms} ms is too long (10 s at most).`);
    out.set(`${match[1]}>${match[2]}`, ms);
  }
  return out;
}

// --- files --------------------------------------------------------------------------------------

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** ffmpeg or ffprobe: VOICE_FFMPEG / VOICE_FFPROBE, then PATH, then Homebrew's folders (launchd has none). */
export function findTool(name, env = process.env) {
  const override = env[`VOICE_${name.toUpperCase()}`];
  if (override) return override;
  const dirs = [...(env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    if (dir !== '' && isExecutable(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** The edit folder, its real path, and its generate/ folder (made), all checked to be inside it. */
function openEditDir(given, { create }) {
  if (!isAbsolute(given)) throw bad('The edit folder must be an absolute path.');
  let root;
  try {
    root = realpathSync(given);
    if (!statSync(root).isDirectory()) throw new Error('not a folder');
  } catch {
    throw bad(`There is no edit folder at ${given}.`);
  }
  const dir = join(root, 'generate');
  if (create) mkdirSync(dir, { recursive: true });
  else if (!existsSync(dir)) throw bad('There is no generate/ folder in the edit folder yet.');
  if (!isInside(root, dir)) throw bad('generate/ is not inside the edit folder.');
  return { root, dir };
}

/** Whether `path` is `root` or in it, once symlinks are followed (as far as the path exists). */
export function isInside(root, path) {
  let probe = resolve(path);
  const tail = [];
  while (!existsSync(probe)) {
    tail.unshift(basename(probe));
    const up = dirname(probe);
    if (up === probe) return false;
    probe = up;
  }
  const real = join(realpathSync(probe), ...tail);
  const rel = relative(root, real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Writes `data` to `path` through a temp file and a rename; refuses a path outside `root`. */
function writeFileAtomic(root, path, data) {
  if (!isInside(root, path))
    throw bad(`Refusing to write ${basename(path)} outside the edit folder.`);
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, data);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The plan's voice line `id`: { text, direction }, or `null`. */
function planLine(dir, id) {
  const line = readJson(join(dir, 'plan.json'))?.voice?.find?.((entry) => entry?.id === id);
  if (!line || typeof line.text !== 'string') return null;
  return { text: line.text, direction: typeof line.direction === 'string' ? line.direction : null };
}

/** The take numbers of line `id` that exist as files. */
function takesOf(dir, id) {
  const folder = join(dir, 'voice');
  if (!existsSync(folder)) return [];
  const pattern = new RegExp(`^${id}-take(\\d+)\\.mp3$`);
  return readdirSync(folder)
    .map((name) => pattern.exec(name)?.[1])
    .filter((n) => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

const takePath = (dir, id, take) => join(dir, 'voice', `${id}-take${take}.mp3`);
const wordsPath = (mp3) => join(dirname(mp3), `${basename(mp3, extname(mp3))}.words.json`);
const slash = (path) => path.split('\\').join('/');

/** A file's length in ms (ffprobe), or `null` when it cannot be read. */
function probeMs(path) {
  const bin = findTool('ffprobe');
  if (bin === null) return null;
  const result = spawnSync(
    bin,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const sec = Number.parseFloat(`${result.stdout ?? ''}`.trim());
  return result.status === 0 && Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : null;
}

/** An mp3's length in ms: ffprobe's, else worked out from its size (the speech is constant 128 kb/s). */
function lengthMs(path, bytes) {
  return probeMs(path) ?? Math.round((bytes / ELEVENLABS.speechBytesPerSec) * 1000);
}

// --- ElevenLabs ---------------------------------------------------------------------------------

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function wholeMs(value, fallback) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : fallback;
}

/** ElevenLabs' address, or the local stub's (VOICE_API_BASE, loopback only: the key goes there). */
function apiBase(env) {
  const given = env.VOICE_API_BASE;
  if (!given) return ELEVENLABS.base;
  let url;
  try {
    url = new URL(given);
  } catch {
    throw bad('VOICE_API_BASE is not an address.');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw bad('VOICE_API_BASE must be a local address.');
  }
  return given.replace(/\/+$/, '');
}

/** A sentence of what ElevenLabs said, with no key in it. */
function said(text) {
  const one = redact(String(text)).replace(/\s+/g, ' ').trim();
  return one.length > 300 ? `${one.slice(0, 299)}…` : one;
}

/**
 * Reads ElevenLabs' refusal: the contract's code, the plain words, a detail for the log, whether
 * the call is worth one more try, and whether it was the model that was refused. Its errors look
 * like { detail: { type, code, status, message } } or { detail: [{ loc, msg }] }.
 */
export function failureFor(status, body, what = 'a request') {
  const detail = body !== null && typeof body === 'object' ? body.detail : undefined;
  const fields =
    detail !== null && typeof detail === 'object' && !Array.isArray(detail) ? detail : {};
  const names = [fields.type, fields.code, fields.status]
    .filter((name) => typeof name === 'string')
    .map((name) => name.toLowerCase());
  const is = (...wanted) => wanted.some((name) => names.includes(name));
  const message =
    typeof fields.message === 'string'
      ? fields.message
      : typeof detail === 'string'
        ? detail
        : Array.isArray(detail) && typeof detail[0]?.msg === 'string'
          ? `${detail[0].msg}${Array.isArray(detail[0].loc) ? ` (${detail[0].loc.join('.')})` : ''}`
          : typeof body === 'string'
            ? body
            : '';
  const log = `${what}: ElevenLabs answered ${status}${message ? ` — ${said(message)}` : ''}`;

  if (status === 402 || is('quota_exceeded', 'insufficient_credits', 'payment_required')) {
    return { code: 'balance_empty', detail: log, retry: false };
  }
  if (is('missing_permissions', 'insufficient_permissions')) {
    const permission = /permission\s+([a-z_]+)/i.exec(message)?.[1];
    return {
      code: 'key_rejected',
      detail: log,
      retry: false,
      message: permission
        ? `ElevenLabs key not accepted: it is missing the "${permission}" permission. Give it that permission at ${KEYS_PAGE}, then Retry.`
        : MESSAGES.key_rejected,
    };
  }
  // The account is not allowed the model asked for (never a 401: that is the key).
  if (
    [400, 403, 404, 422].includes(status) &&
    !is('invalid_api_key', 'missing_api_key', 'needs_authorization') &&
    /model/i.test(`${names.join(' ')} ${message}`)
  ) {
    return { code: 'bad_request', detail: log, retry: false, modelRefused: true };
  }
  if (
    status === 401 ||
    status === 403 ||
    is(
      'invalid_api_key',
      'missing_api_key',
      'needs_authorization',
      'authentication_error',
      'unauthorized',
    )
  ) {
    return { code: 'key_rejected', detail: log, retry: false };
  }
  if (status === 429 || is('rate_limit_error', 'concurrent_limit_exceeded', 'system_busy')) {
    return { code: 'unavailable', detail: log, retry: true };
  }
  if (status >= 500) return { code: 'unavailable', detail: log, retry: true };
  return { code: 'bad_request', detail: log, retry: false };
}

/**
 * One call to ElevenLabs with the key in its header only. Answers { body, headers } on a 2xx;
 * throws a VoiceError for anything else. One more try on a 5xx, a 429 or a network error; none on
 * a timeout (it has waited long enough).
 */
async function callElevenLabs(method, path, { key, env, what, json, form, timeoutMs, accept }) {
  const base = apiBase(env);
  const waitMs = wholeMs(env.VOICE_TIMEOUT_MS, timeoutMs);
  const retryMs = wholeMs(env.VOICE_RETRY_MS, ELEVENLABS.retryMs);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'xi-api-key': key,
          accept,
          ...(json === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: json === undefined ? form : JSON.stringify(json),
        signal: AbortSignal.timeout(waitMs),
      });
      if (res.ok) return { body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
      const text = await res.text();
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON: the text is what it said.
      }
      const failure = failureFor(res.status, parsed, what);
      if (failure.retry && attempt === 1) {
        await sleep(retryMs);
        continue;
      }
      throw new VoiceError(failure.code, failure.detail, failure);
    } catch (err) {
      if (err instanceof VoiceError) throw err;
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new VoiceError(
          'unavailable',
          `${what}: ElevenLabs did not answer within ${Math.round(waitMs / 1000)} s.`,
        );
      }
      if (attempt === 1) {
        await sleep(retryMs);
        continue;
      }
      throw new VoiceError(
        'unavailable',
        `${what}: ElevenLabs could not be reached (${said(err?.message ?? err)}).`,
      );
    }
  }
}

/** The credits ElevenLabs says a call cost (its character-cost header), or `null`. */
function costOf(headers) {
  const n = Number.parseInt(headers.get('character-cost') ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// --- line ---------------------------------------------------------------------------------------

/**
 * A delivery direction as v3 audio tags: each comma-separated part (at most 3, 40 characters
 * each) in square brackets, followed by a space, or '' when there is none.
 */
export function directionTags(direction) {
  const parts = String(direction ?? '')
    .split(/[,;\n]+/)
    .map((part) =>
      part
        .replace(/[[\](){}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((part) => part.length >= 2)
    .slice(0, 3)
    .map((part) => {
      if (part.length <= 40) return part;
      const cut = part.slice(0, 40);
      return cut.slice(0, Math.max(cut.lastIndexOf(' '), 12)).trim();
    });
  return parts.length === 0 ? '' : `${parts.map((part) => `[${part}]`).join(' ')} `;
}

/** The request body of one take for `model`; `sent` is the text ElevenLabs bills, tags included. */
export function speechBody(text, direction, model) {
  if (model === ELEVENLABS.expressiveModel) {
    const sent = `${directionTags(direction)}${text}`;
    return {
      sent,
      applied: sent !== text,
      body: {
        text: sent,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      },
    };
  }
  return {
    sent: text,
    applied: false,
    body: {
      text,
      model_id: model,
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75,
        style: 0.3,
        use_speaker_boost: true,
      },
    },
  };
}

function lineInput(args, dir) {
  const id = args.options.get('id') ?? args.word;
  if (id === undefined || id === null || !LINE_ID.test(id)) {
    throw bad('line needs a line id like L3 (--id L3).');
  }
  const planned = planLine(dir, id);
  const text = (args.options.get('text') ?? planned?.text ?? '').trim();
  if (text === '')
    throw bad(`There is no text for line ${id}: pass --text, or put it in plan.json.`);
  if (text.length > ELEVENLABS.textMax)
    throw bad(`Line ${id} is over ${ELEVENLABS.textMax} characters.`);
  const direction = args.options.has('direction')
    ? args.options.get('direction').trim() || null
    : (planned?.direction ?? null);
  return { id, text, direction };
}

async function line(args, env) {
  const { root, dir } = openEditDir(args.editDir, { create: true });
  const { id, text, direction } = lineInput(args, dir);
  const take = args.options.has('take')
    ? wholeNumber(args.options.get('take'), '--take')
    : Math.max(0, ...takesOf(dir, id)) + 1;
  const voice = args.options.get('voice') ?? env.STUDIO_GENERATE_VOICE_ID ?? DEFAULT_VOICE_ID;
  if (!VOICE_ID.test(voice)) throw bad('The voice id is not an ElevenLabs voice id.');
  const models = args.options.has('model')
    ? [args.options.get('model')]
    : [ELEVENLABS.expressiveModel, ELEVENLABS.steadyModel];
  const key = requireKey(env);

  let answer = null;
  let used = null;
  for (const [at, model] of models.entries()) {
    const request = speechBody(text, direction, model);
    try {
      answer = await callElevenLabs(
        'POST',
        `/v1/text-to-speech/${voice}?output_format=${ELEVENLABS.speechFormat}`,
        {
          key,
          env,
          what: `line ${id}`,
          json: request.body,
          timeoutMs: ELEVENLABS.speechTimeoutMs,
          accept: 'audio/mpeg',
        },
      );
      used = { model, ...request };
      break;
    } catch (err) {
      // The account is not allowed this model: the next one (a refused call is not charged).
      if (err instanceof VoiceError && err.modelRefused && at < models.length - 1) continue;
      throw err;
    }
  }
  if (answer === null || used === null || answer.body.length === 0) {
    throw new VoiceError('bad_request', `line ${id}: ElevenLabs sent back no audio.`);
  }

  const file = takePath(dir, id, take);
  writeFileAtomic(root, file, answer.body);
  rmSync(wordsPath(file), { force: true });
  const ms = lengthMs(file, answer.body.length);
  const characters = costOf(answer.headers) ?? used.sent.length;
  return {
    ok: true,
    command: 'line',
    id,
    take,
    file: slash(relative(dir, file)),
    ms,
    durationSec: ms / 1000,
    characters,
    chars: characters,
    model: used.model,
    voice,
    directionApplied: used.applied,
  };
}

// --- check --------------------------------------------------------------------------------------

/** The take `--file` (or the line's `--take`, else its latest) names, inside generate/. */
function checkedFile(args, dir, root) {
  const given = args.options.get('file');
  let file;
  if (given !== undefined) {
    const candidates = isAbsolute(given) ? [given] : [resolve(dir, given), resolve(root, given)];
    file = candidates.find((path) => existsSync(path));
    if (file === undefined) throw bad(`There is no file ${given}.`);
  } else {
    const id = args.options.get('id') ?? args.word;
    if (id === undefined || id === null || !LINE_ID.test(id))
      throw bad('check needs --file, or a line id like L3.');
    const take = args.options.has('take')
      ? wholeNumber(args.options.get('take'), '--take')
      : takesOf(dir, id).at(-1);
    if (take === undefined) throw bad(`Line ${id} has no takes yet.`);
    file = takePath(dir, id, take);
    if (!existsSync(file)) throw bad(`There is no take ${take} of line ${id}.`);
  }
  if (!isInside(root, file) || !statSync(file).isFile())
    throw bad('The file is not in the edit folder.');
  return file;
}

/** What Scribe heard: its words (not the spaces or sounds between them) with times in ms. */
function heardWords(answer) {
  const words = Array.isArray(answer?.words) ? answer.words : null;
  if (words === null) throw bad('check: Scribe sent no word times.');
  return words
    .filter(
      (word) =>
        (word?.type ?? 'word') === 'word' &&
        typeof word?.text === 'string' &&
        word.text.trim() !== '',
    )
    .map((word) => ({
      text: word.text.trim(),
      startMs: Math.round(Number(word.start) * 1000),
      endMs: Math.round(Number(word.end) * 1000),
    }))
    .filter((word) => Number.isFinite(word.startMs) && Number.isFinite(word.endMs));
}

async function check(args, env) {
  const { root, dir } = openEditDir(args.editDir, { create: false });
  const file = checkedFile(args, dir, root);
  const name = /^(L[1-9]\d*)-take(\d+)\.mp3$/.exec(basename(file));
  const id = name?.[1] ?? args.options.get('id') ?? args.word ?? null;
  const take = name ? Number(name[2]) : null;
  const text = (
    args.options.get('text') ??
    (id === null ? null : planLine(dir, id)?.text) ??
    ''
  ).trim();
  if (text === '')
    throw bad('check needs --text "<the script’s words>", or the line in plan.json.');
  const key = requireKey(env);

  const form = new FormData();
  form.set('model_id', ELEVENLABS.scribeModel);
  form.set('timestamps_granularity', 'word');
  form.set('tag_audio_events', 'false');
  form.set('diarize', 'false');
  if (args.options.has('language')) form.set('language_code', args.options.get('language'));
  form.set('file', new Blob([readFileSync(file)], { type: 'audio/mpeg' }), basename(file));
  const answer = await callElevenLabs('POST', '/v1/speech-to-text', {
    key,
    env,
    what: `check ${basename(file)}`,
    form,
    timeoutMs: ELEVENLABS.scribeTimeoutMs,
    accept: 'application/json',
  });
  let parsed = null;
  try {
    parsed = JSON.parse(answer.body.toString('utf8'));
  } catch {
    // Handled below.
  }
  const words = heardWords(parsed);
  const compared = compareWords(
    text,
    words.map((word) => word.text),
  );
  const heard = words.map((word) => word.text).join(' ');
  const rel = slash(relative(dir, file));
  const ms = lengthMs(file, statSync(file).size);
  writeFileAtomic(
    root,
    wordsPath(file),
    `${JSON.stringify({ file: rel, id, take, text, heard, ms, ...compared, words }, null, 2)}\n`,
  );
  return {
    ok: true,
    command: 'check',
    id,
    take,
    file: rel,
    match: compared.match,
    missing: compared.missing,
    extra: compared.extra,
    heard,
    words,
  };
}

// --- assemble -----------------------------------------------------------------------------------

/** Runs ffmpeg (input from `input` when given); throws a bad_request with the end of what it said. */
function ffmpeg(args, input) {
  const bin = findTool('ffmpeg');
  if (bin === null) throw bad('ffmpeg is not installed (brew install ffmpeg).');
  const result = spawnSync(bin, ['-hide_banner', '-nostdin', '-y', ...args], {
    input,
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 300_000,
  });
  if (result.status !== 0) {
    const tail = `${result.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ');
    throw bad(redact(`ffmpeg failed${tail ? `: ${tail}` : ''}.`));
  }
  return result;
}

/** A take as raw 16-bit mono samples at the master's rate. */
function decode(path) {
  return ffmpeg([
    '-loglevel',
    'error',
    '-i',
    path,
    '-f',
    's16le',
    '-ac',
    '1',
    '-ar',
    String(MASTER.sampleRate),
    'pipe:1',
  ]).stdout;
}

const PCM_INPUT = ['-f', 's16le', '-ac', '1', '-ar', String(MASTER.sampleRate), '-i', 'pipe:0'];

/** The samples' integrated loudness (LUFS) and true peak (dBTP), from ffmpeg's loudnorm pass. */
function measure(pcm) {
  const result = ffmpeg(
    [
      ...PCM_INPUT,
      '-af',
      `loudnorm=I=${MASTER.integratedLufs}:TP=${MASTER.truePeakDbtp}:LRA=11:print_format=json`,
      '-f',
      'null',
      '-',
    ],
    pcm,
  );
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(`${result.stderr ?? ''}`)?.[0];
  if (json === undefined) throw bad('ffmpeg could not measure the voice’s loudness.');
  const measured = JSON.parse(json);
  return {
    integrated: Number.parseFloat(measured.input_i),
    truePeak: Number.parseFloat(measured.input_tp),
  };
}

/**
 * The one gain (dB) that brings speech measured at `integrated` LUFS to the target, cut back when it
 * would push the true peak over the ceiling. Linear: the voice's own dynamics stay.
 */
export function loudnessGain(integrated, truePeak) {
  let gain = MASTER.integratedLufs - integrated;
  if (Number.isFinite(truePeak) && truePeak + gain > MASTER.truePeakDbtp) {
    gain = MASTER.truePeakDbtp - truePeak;
  }
  return Math.round(gain * 100) / 100;
}

const samplesToMs = (samples) => Math.round((samples * 1000) / MASTER.sampleRate);

async function assemble(args) {
  const { root, dir } = openEditDir(args.editDir, { create: false });
  const order = parseOrder(args.options.get('order') ?? args.options.get('pick'));
  const pauses = parsePauses(args.options.get('pauses'));
  const defaultPause = args.options.has('pause')
    ? wholeNumber(args.options.get('pause'), '--pause', 0)
    : MASTER.defaultPauseMs;
  if (defaultPause > 10_000) throw bad('A pause of more than 10 s is too long.');
  const lead = parseLead(args.options.get('lead'));
  const pairs = order.slice(1).map((entry, at) => `${order[at].id}>${entry.id}`);
  for (const pair of pauses.keys()) {
    if (!pairs.includes(pair))
      throw bad(`The pause ${pair} is not between two lines that follow each other in the order.`);
  }

  const takes = order.map((entry) => {
    const file = takePath(dir, entry.id, entry.take);
    if (!existsSync(file)) throw bad(`There is no take ${entry.take} of line ${entry.id}.`);
    const checked = readJson(wordsPath(file));
    if (!checked || !Array.isArray(checked.words)) {
      throw bad(`Take ${entry.take} of line ${entry.id} was not checked: run check on it first.`);
    }
    return { ...entry, file, checked };
  });

  const chunks = [];
  const lines = [];
  const words = [];
  let samples = 0;
  for (const [at, take] of takes.entries()) {
    if (at > 0) {
      const gap = Math.round(
        ((pauses.get(pairs[at - 1]) ?? defaultPause) * MASTER.sampleRate) / 1000,
      );
      chunks.push(Buffer.alloc(gap * 2));
      samples += gap;
    }
    const pcm = decode(take.file);
    const startMs = lead + samplesToMs(samples);
    samples += pcm.length / 2;
    chunks.push(pcm);
    const endMs = lead + samplesToMs(samples);
    lines.push({
      id: take.id,
      take: take.take,
      startMs,
      endMs,
      startSec: startMs / 1000,
      endSec: endMs / 1000,
      match: take.checked.match === true,
    });
    for (const word of take.checked.words) {
      words.push({
        line: take.id,
        text: word.text,
        startSec: (startMs + word.startMs) / 1000,
        endSec: (startMs + word.endMs) / 1000,
        startMs: startMs + word.startMs,
        endMs: startMs + word.endMs,
      });
    }
  }

  const speech = Buffer.concat(chunks);
  // The loudness is the speech's own: the lead's silence is put before it only for the master.
  const { integrated, truePeak } = measure(speech);
  if (!Number.isFinite(integrated) || integrated < -60) throw bad('The picked takes are silent.');
  const gain = loudnessGain(integrated, truePeak);
  const pcm =
    lead === 0
      ? speech
      : Buffer.concat([Buffer.alloc(Math.round((lead * MASTER.sampleRate) / 1000) * 2), speech]);
  const out = join(dir, 'voice.mp3');
  const temp = join(dir, `.voice.${process.pid}.tmp.mp3`);
  try {
    ffmpeg(
      [
        ...PCM_INPUT,
        '-af',
        `volume=${gain}dB`,
        '-c:a',
        'libmp3lame',
        '-b:a',
        MASTER.bitrate,
        '-ar',
        String(MASTER.sampleRate),
        '-ac',
        '1',
        temp,
      ],
      pcm,
    );
    if (!isInside(root, out)) throw bad('Refusing to write voice.mp3 outside the edit folder.');
    renameSync(temp, out);
  } finally {
    rmSync(temp, { force: true });
  }
  const ms = lead + samplesToMs(samples);
  const leadField = lead === 0 ? {} : { leadMs: lead };
  writeFileAtomic(
    root,
    join(dir, 'voice-words.json'),
    `${JSON.stringify({ ms, ...leadField, lines, words }, null, 2)}\n`,
  );
  return {
    ok: true,
    command: 'assemble',
    file: 'voice.mp3',
    wordsFile: 'voice-words.json',
    ms,
    ...leadField,
    durationSec: ms / 1000,
    lufs: Math.round((integrated + gain) * 10) / 10,
    lines,
  };
}

// --- sfx ----------------------------------------------------------------------------------------

async function sfx(args, env) {
  const { root, dir } = openEditDir(args.editDir, { create: true });
  const name = args.options.get('id') ?? args.word;
  if (name === undefined || name === null || !NAME.test(name)) {
    throw bad('sfx needs a name of letters, digits, - and _ (--id alert).');
  }
  const prompt = (args.options.get('prompt') ?? '').trim();
  if (prompt === '') throw bad('sfx needs --prompt "<what it sounds like>".');
  if (prompt.length > ELEVENLABS.promptMax)
    throw bad(`The prompt is over ${ELEVENLABS.promptMax} characters.`);
  let seconds = null;
  if (args.options.has('seconds')) {
    seconds = Number(args.options.get('seconds'));
    if (
      !Number.isFinite(seconds) ||
      seconds < ELEVENLABS.secondsMin ||
      seconds > ELEVENLABS.secondsMax
    ) {
      throw bad(`--seconds must be between ${ELEVENLABS.secondsMin} and ${ELEVENLABS.secondsMax}.`);
    }
  }
  const key = requireKey(env);
  const answer = await callElevenLabs(
    'POST',
    `/v1/sound-generation?output_format=${ELEVENLABS.speechFormat}`,
    {
      key,
      env,
      what: `sfx ${name}`,
      json: { text: prompt, ...(seconds === null ? {} : { duration_seconds: seconds }) },
      timeoutMs: ELEVENLABS.sfxTimeoutMs,
      accept: 'audio/mpeg',
    },
  );
  if (answer.body.length === 0)
    throw new VoiceError('bad_request', `sfx ${name}: ElevenLabs sent back no audio.`);
  const file = join(dir, 'sfx', `${name}.mp3`);
  writeFileAtomic(root, file, answer.body);
  const ms = lengthMs(file, answer.body.length);
  return {
    ok: true,
    command: 'sfx',
    id: name,
    name,
    file: slash(relative(dir, file)),
    ms,
    durationSec: ms / 1000,
    characters: costOf(answer.headers),
  };
}

// --- main ---------------------------------------------------------------------------------------

const COMMANDS = { line, check, assemble, sfx };

/** Runs one command; answers its success line. */
export async function run(argv, env = process.env) {
  const args = parseArgs(argv);
  return await COMMANDS[args.command](args, env);
}

function print(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main() {
  if (process.env.STUDIO_GENERATE_FAKE === '1') {
    const fake = await import('./make-voice-fake.mjs');
    fake.main();
    return;
  }
  try {
    print(await run(process.argv.slice(2), process.env));
    process.exitCode = EXIT.ok;
  } catch (err) {
    const failure =
      err instanceof VoiceError ? err : new VoiceError('bad_request', redact(err?.message ?? err));
    print({
      ok: false,
      code: failure.code,
      message: failure.message,
      ...(failure.detail ? { detail: said(failure.detail) } : {}),
    });
    process.exitCode = EXIT_FOR[failure.code];
  }
}

/** Whether this file is the script node was asked to run (not a module imported by a test). */
function isMain() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) await main();
