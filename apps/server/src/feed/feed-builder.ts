// The job chat's builder (Draft & chat, DR2): the job log, line by line, into the chat's items.
//
// The log (`<logsDir>/jobs/<id>.log`, pipeline/job-log.ts) holds every line a run wrote: the
// engine's markers around each run and every stream-json line of claude, verbatim. So the chat
// needs nothing from Claude: it is what the runs said, ran and looked at, in order.
//
//   markers            a `run` item per run: the Brief run, Generate, the Draft (an edit run), a
//                      review round (a revise run, numbered), a quick fix and the render, closed by
//                      its end marker with the outcome, the error and how long it took. The fix
//                      router's sorting of a note (`fix_route_start` … `fix_route_end`) is left out
//   assistant text     a `text` item; lines of text with nothing between them join into one
//   tool uses          a `tools` item: the commands Claude ran one after the other, each in its own
//                      plain words (a command's description) and done or failed once its result is in
//   pictures           an `images` item: every picture a Read brought back. The picture is saved
//                      from the log's base64, so a later round that writes the same file cannot
//                      change what the chat shows. Reading a picture is not listed as a command
//   cards              a `card` item when a run wrote edit/brief.json (what it understood),
//                      edit/project.md (the plan) or edit/edl.json (the cut list), read
//                      takes_packed.md or packed it (the transcript), or a command printed ffmpeg's
//                      loudness summary. The file is read when its line is pushed: a card shows the
//                      file as it was then, or, for an older log read later, as it is now
//
// Lines from a helper Claude started (`parent_tool_use_id`), the thinking, the usage and rate-limit
// lines say nothing to the owner and are skipped. Each item's id is made from the line it started on,
// so building the same log again gives the same ids (and the same picture names).
//
// The builder is pure apart from its two injected calls (`FeedBuilderIo`); FeedService (DR3) owns
// the files.

import { Buffer } from 'node:buffer';
import { basename, dirname, extname } from 'node:path';
import type {
  FeedCard,
  FeedCardType,
  FeedCut,
  FeedImage,
  FeedRunItem,
  FeedRunKind,
  FeedRunOutcome,
  FeedTool,
  JobFeedItem,
} from '@studio/shared';
import { FEED_RUN_OUTCOMES } from '@studio/shared';

/** What the builder needs from outside: where pictures go and how a card's file is read. */
export interface FeedBuilderIo {
  /** Saves one picture under `name`. A rebuild calls it again with the same name and bytes. */
  saveImage(name: string, bytes: Buffer): void;
  /** A file's text as it is now, or null when it cannot be read. */
  readText(absPath: string): string | null;
}

/** The engine's marker lines: `{"type":"studio_engine","event":…}` (job-log.ts). */
const MARKER_TYPE = 'studio_engine';

/** Which run each start marker opens. An edit run is the Draft. */
const RUN_STARTS: Record<string, FeedRunKind | 'edit-run'> = {
  start: 'edit-run',
  brief_start: 'brief',
  generate_start: 'generate',
  quick_fix_start: 'fix',
};
const RUN_ENDS = new Set(['end', 'brief_end', 'generate_end', 'quick_fix_end']);

/** The edit runner's `runKind` on its start marker, as the chat names the run. */
const EDIT_RUN_KINDS: Record<string, FeedRunKind> = {
  edit: 'draft',
  revise: 'round',
  render: 'render',
};

/** Pictures a Read brings back, by extension. */
const IMAGE_PATH = /\.(png|jpe?g|webp|gif)$/i;

/** How much of a file a card keeps. */
const TRANSCRIPT_CHARS = 12_000;
const PLAN_CHARS = 4_000;
const DETAIL_CHARS = 4_000;
const LABEL_CHARS = 120;
const MAX_CUTS = 200;

/** A picture this much wider than tall is shown across the chat (frames and a sound wave, a sheet). */
const WIDE_RATIO = 1.6;

type Json = Record<string, unknown>;

interface PendingTool {
  name: string;
  input: Json;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** A path as the chat shows it: inside the job folder relative to it, else with ~ for home. */
export function shownPath(path: string, cwd: string | null): string {
  if (cwd !== null && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  const home = process.env.HOME;
  if (home !== undefined && home !== '' && path.startsWith(`${home}/`)) {
    return `~/${path.slice(home.length + 1)}`;
  }
  return path;
}

/** A command's own words for itself, else its first line. */
export function toolLabel(name: string, input: Json, cwd: string | null): string {
  const path = str(input.file_path);
  const where = path === null ? null : shownPath(path, cwd);
  switch (name) {
    case 'Bash': {
      const described = str(input.description);
      if (described !== null) return clip(described, LABEL_CHARS);
      const first = (str(input.command) ?? 'A command').split('\n')[0] ?? 'A command';
      return clip(first.trim(), LABEL_CHARS);
    }
    case 'Read':
      return where === null ? 'Read a file' : `Read ${where}`;
    case 'Write':
      return where === null ? 'Wrote a file' : `Wrote ${where}`;
    case 'Edit':
    case 'MultiEdit':
      return where === null ? 'Changed a file' : `Changed ${where}`;
    case 'Skill': {
      const skill = str(input.skill);
      return skill === null ? 'Opened a skill' : `Opened the ${skill} skill`;
    }
    case 'Glob':
      return `Looked for ${str(input.pattern) ?? 'files'}`;
    case 'Grep':
      return `Searched for “${clip(str(input.pattern) ?? '', 60)}”`;
    case 'Task':
    case 'Agent':
      return clip(str(input.description) ?? 'Asked a helper', LABEL_CHARS);
    case 'TodoWrite':
      return 'Updated its list';
    default:
      return name;
  }
}

/** What a command's fold shows when opened: the command itself, or the path. */
function toolDetail(name: string, input: Json): string | null {
  if (name === 'Bash') {
    const command = str(input.command);
    return command === null ? null : clip(command, DETAIL_CHARS);
  }
  return str(input.file_path) ?? str(input.pattern) ?? null;
}

function pretty(stem: string): string {
  const words = stem.replace(/[_-]+/g, ' ').trim();
  return words === '' ? 'Picture' : words.charAt(0).toUpperCase() + words.slice(1);
}

/** What a picture is, from where Claude found it. */
export function imageLabel(path: string | null): string {
  if (path === null) return 'Picture';
  const stem = basename(path, extname(path));
  const lower = stem.toLowerCase();
  const folder = basename(dirname(path));
  // video-use's timeline_view names its picture <video>_<start>-<end>.png.
  const span = /_(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(stem);
  if (span !== null) return `Frames and sound wave · ${span[1]}–${span[2]} s`;
  if (lower.includes('timeline') || /^tl[-_]/.test(lower)) return 'Frames and sound wave';
  if (lower.startsWith('contact-sheet')) return `Snapshots · ${folder}`;
  if (lower.includes('grade') && (lower.includes('before') || lower.includes('after'))) {
    return 'Colour, before and after';
  }
  if (lower.includes('cuts') || lower.includes('cut_sheet') || lower.includes('cut-sheet')) {
    return 'Cut sheet';
  }
  return pretty(stem);
}

/** A PNG's or JPEG's width and height from its first bytes, or null for anything else. */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1] ?? 0;
      const length = bytes.readUInt16BE(at + 2);
      // Start of frame: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
      }
      at += 2 + length;
    }
  }
  return null;
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** ffmpeg's loudness, from an ebur128 summary or loudnorm's JSON; the last one when there are several. */
export function parseLoudness(
  text: string,
): Omit<Extract<FeedCard, { type: 'loudness' }>, 'type'> | null {
  const last = (pattern: RegExp): number | null => {
    let found: number | null = null;
    for (const match of text.matchAll(pattern)) found = num(match[1]);
    return found;
  };
  const ebur = last(/Integrated loudness:\s*\n\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g);
  if (ebur !== null) {
    return {
      integratedLufs: ebur,
      truePeakDb: last(/True peak:\s*\n\s*Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g),
      rangeLu: last(/LRA:\s*(\d+(?:\.\d+)?)\s*LU\b/g),
    };
  }
  const loudnorm = last(/"input_i"\s*:\s*"(-?\d+(?:\.\d+)?)"/g);
  if (loudnorm !== null) {
    return {
      integratedLufs: loudnorm,
      truePeakDb: last(/"input_tp"\s*:\s*"(-?\d+(?:\.\d+)?)"/g),
      rangeLu: last(/"input_lra"\s*:\s*"(\d+(?:\.\d+)?)"/g),
    };
  }
  return null;
}

/** The plan's strategy: project.md's "Strategy" section, else the top of the file. */
export function planText(markdown: string): string {
  const section = /^##\s+Strategy\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(markdown);
  const text = (section?.[1] ?? markdown).trim();
  return clip(text, PLAN_CHARS);
}

/** The cut list from video-use's edl.json, or null when it is not one. */
export function cutsCard(json: unknown): Extract<FeedCard, { type: 'cuts' }> | null {
  if (!isObject(json) || !Array.isArray(json.ranges)) return null;
  const cuts: FeedCut[] = [];
  let sum = 0;
  for (const range of json.ranges.slice(0, MAX_CUTS)) {
    if (!isObject(range)) continue;
    const startSec = num(range.start);
    const endSec = num(range.end);
    if (startSec === null || endSec === null) continue;
    const outStart = num(range.out_start);
    const outEnd = num(range.out_end);
    const speed = num(range.speed) ?? 1;
    sum +=
      outStart !== null && outEnd !== null
        ? outEnd - outStart
        : (endSec - startSec) / (speed > 0 ? speed : 1);
    cuts.push({
      source: str(range.source) ?? String(range.source ?? ''),
      startSec,
      endSec,
      beat: str(range.beat),
      quote: str(range.quote) ?? str(range.text),
      reason: str(range.reason) ?? str(range.why),
    });
  }
  if (cuts.length === 0) return null;
  const total = num(json.total_duration_s) ?? sum;
  return { type: 'cuts', cuts, totalSec: Math.max(0, Math.round(total * 100) / 100) };
}

/** What the brief says, as the "What I understood" card shows it; null for a brief not read yet. */
export function briefCard(
  json: unknown,
  pendingSummary: string | null,
): Extract<FeedCard, { type: 'brief' }> | null {
  if (!isObject(json)) return null;
  const summary = str(json.summary);
  if (summary !== null && summary === pendingSummary) return null;
  const facts: { label: string; value: string }[] = [];
  if (isObject(json.length)) {
    const target = num(json.length.targetSec) ?? num(json.length.maxSec);
    if (target !== null) facts.push({ label: 'Length', value: `${target} s` });
  }
  if (isObject(json.canvas)) {
    const width = num(json.canvas.width);
    const height = num(json.canvas.height);
    if (width !== null && height !== null) {
      facts.push({ label: 'Canvas', value: `${width} × ${height}` });
    }
  }
  const language = str(json.language);
  if (language !== null) facts.push({ label: 'Language', value: language });
  if (Array.isArray(json.platform) && json.platform.length > 0) {
    facts.push({
      label: 'For',
      value: json.platform.filter((p) => typeof p === 'string').join(', '),
    });
  }
  const tone = str(json.tone);
  if (tone !== null) facts.push({ label: 'Tone', value: clip(tone, 80) });
  if (summary === null && facts.length === 0) return null;
  return { type: 'brief', summary, facts };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A tool result's text: its string, or the text blocks of its list. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isObject(block) && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

export interface FeedBuilderOptions {
  /** The placeholder brief's summary (DR4): a brief that still says it is not read gets no card. */
  pendingBriefSummary?: string | null;
}

/** See the top of the file. Push the log's lines in order, every one of them, blank ones too. */
export class FeedBuilder {
  private readonly list: JobFeedItem[] = [];
  private lineNo = 0;
  private run: FeedRunItem | null = null;
  private cwd: string | null = null;
  private rounds = 0;
  /** Inside the fix router's sorting of a note, which the chat leaves out. */
  private hidden = false;
  private readonly pending = new Map<string, PendingTool>();
  private readonly shown = new Map<string, FeedTool>();
  /**
   * The last card of each kind, so a file that is the same as when the chat last showed it is not
   * shown again: written again unchanged, or (for an older log) read again in a later round.
   */
  private readonly lastCards = new Map<FeedCardType, string>();
  private readonly pendingBriefSummary: string | null;

  constructor(
    private readonly io: FeedBuilderIo,
    options: FeedBuilderOptions = {},
  ) {
    this.pendingBriefSummary = options.pendingBriefSummary ?? null;
  }

  /** The items so far, oldest first. The last ones change while their run goes on. */
  get items(): readonly JobFeedItem[] {
    return this.list;
  }

  /** How many lines have been pushed. */
  get lines(): number {
    return this.lineNo;
  }

  push(line: string): void {
    this.lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isObject(event)) return;
    if (event.type === MARKER_TYPE) {
      this.marker(event);
      return;
    }
    if (this.hidden) return;
    // A helper's own lines (Task): the helper's result is what counts, and it is a tool result.
    if (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null) return;
    const message = isObject(event.message) ? event.message : null;
    if (message === null || !Array.isArray(message.content)) return;
    if (event.type === 'assistant') this.assistant(message.content);
    else if (event.type === 'user') this.results(message.content);
  }

  private id(suffix?: string | number): string {
    return suffix === undefined ? `L${this.lineNo}` : `L${this.lineNo}-${suffix}`;
  }

  private marker(event: Json): void {
    const name = typeof event.event === 'string' ? event.event : '';
    if (name === 'fix_route_start') {
      this.hidden = true;
      return;
    }
    if (name === 'fix_route_end') {
      this.hidden = false;
      return;
    }
    const opens = RUN_STARTS[name];
    if (opens !== undefined) {
      this.openRun(opens, event);
      return;
    }
    if (RUN_ENDS.has(name)) this.closeRun(event);
  }

  private openRun(opens: FeedRunKind | 'edit-run', event: Json): void {
    // A run the log never closed (the engine died) ends where the next one starts.
    if (this.run !== null) this.closeRun({});
    const mode = str(event.mode);
    let run: FeedRunKind;
    if (opens === 'edit-run') run = EDIT_RUN_KINDS[str(event.runKind) ?? 'edit'] ?? 'draft';
    else run = opens;
    let round: number | null = null;
    if (run === 'round') {
      if (mode === null || mode === 'start' || this.rounds === 0) this.rounds += 1;
      round = this.rounds;
    }
    const item: FeedRunItem = {
      id: this.id(),
      at: str(event.at),
      kind: 'run',
      run,
      round,
      mode,
      endedAt: null,
      outcome: null,
      error: null,
      durationMs: null,
      notes: [],
    };
    this.list.push(item);
    this.run = item;
    this.cwd = str(event.cwd) ?? this.cwd;
    this.hidden = false;
  }

  private closeRun(event: Json): void {
    const run = this.run;
    if (run === null) return;
    const outcome = str(event.outcome);
    run.endedAt = str(event.at);
    run.outcome =
      outcome !== null && (FEED_RUN_OUTCOMES as readonly string[]).includes(outcome)
        ? (outcome as FeedRunOutcome)
        : null;
    run.error = str(event.error);
    run.durationMs = num(event.durationMs);
    // A command still running when its run ended was cut short, unless the run went well.
    const settled = run.outcome === 'succeeded' ? 'done' : 'failed';
    for (const tool of this.shown.values()) {
      if (tool.state === 'running') tool.state = settled;
    }
    this.shown.clear();
    this.pending.clear();
    this.run = null;
  }

  private last(): JobFeedItem | undefined {
    return this.list[this.list.length - 1];
  }

  private assistant(content: unknown[]): void {
    content.forEach((block, index) => {
      if (!isObject(block)) return;
      if (block.type === 'text') {
        const text = str(block.text);
        if (text === null) return;
        const last = this.last();
        if (last?.kind === 'text') last.text = `${last.text}\n\n${text}`;
        else this.list.push({ id: this.id(index), at: null, kind: 'text', text });
        return;
      }
      if (block.type !== 'tool_use') return;
      const id = str(block.id);
      const name = str(block.name);
      if (id === null || name === null) return;
      const input = isObject(block.input) ? block.input : {};
      this.pending.set(id, { name, input });
      // Reading a picture shows as the picture, not as a command.
      if (name === 'Read' && IMAGE_PATH.test(str(input.file_path) ?? '')) return;
      const tool: FeedTool = {
        id,
        tool: name,
        label: toolLabel(name, input, this.cwd),
        detail: toolDetail(name, input),
        state: 'running',
      };
      this.shown.set(id, tool);
      const last = this.last();
      if (last?.kind === 'tools') last.tools.push(tool);
      else this.list.push({ id: this.id(index), at: null, kind: 'tools', tools: [tool] });
    });
  }

  private results(content: unknown[]): void {
    content.forEach((block, index) => {
      if (!isObject(block) || block.type !== 'tool_result') return;
      const id = str(block.tool_use_id);
      if (id === null) return;
      const failed = block.is_error === true;
      const tool = this.shown.get(id);
      if (tool !== undefined) tool.state = failed ? 'failed' : 'done';
      const used = this.pending.get(id);
      if (Array.isArray(block.content)) this.pictures(block.content, used, index);
      if (!failed && used !== undefined) this.cards(used, block.content, index);
    });
  }

  private pictures(content: unknown[], used: PendingTool | undefined, index: number): void {
    const path = used === undefined ? null : str(used.input.file_path);
    content.forEach((block, at) => {
      if (!isObject(block) || block.type !== 'image' || !isObject(block.source)) return;
      const data = str(block.source.data);
      if (data === null) return;
      const extension = EXTENSIONS[str(block.source.media_type) ?? ''] ?? 'png';
      const bytes = Buffer.from(data, 'base64');
      const name = `${this.id(`${index}-${at}`)}.${extension}`;
      this.io.saveImage(name, bytes);
      const size = imageSize(bytes);
      const image: FeedImage = {
        name,
        label: imageLabel(path),
        path: path === null ? null : shownPath(path, this.cwd),
        wide: size !== null && size.height > 0 && size.width / size.height >= WIDE_RATIO,
      };
      const last = this.last();
      if (last?.kind === 'images') last.images.push(image);
      else
        this.list.push({
          id: this.id(`${index}-${at}`),
          at: null,
          kind: 'images',
          images: [image],
        });
    });
  }

  private cards(used: PendingTool, content: unknown, index: number): void {
    const path = str(used.input.file_path);
    const wrote = used.name === 'Write' || used.name === 'Edit' || used.name === 'MultiEdit';
    if (path !== null && wrote && path.endsWith('/edit/edl.json')) {
      this.card(cutsCard(parseJson(this.io.readText(path))), index);
    } else if (path !== null && wrote && path.endsWith('/edit/project.md')) {
      const text = this.io.readText(path);
      if (text !== null && text.trim() !== '')
        this.card({ type: 'plan', text: planText(text) }, index);
    } else if (path !== null && wrote && path.endsWith('/edit/brief.json')) {
      this.card(briefCard(parseJson(this.io.readText(path)), this.pendingBriefSummary), index);
    } else if (path !== null && used.name === 'Read' && path.endsWith('takes_packed.md')) {
      this.transcript(path, index);
    } else if (used.name === 'Bash') {
      const command = str(used.input.command) ?? '';
      // A script can write the files too: a command that names one is looked at after it ran (an
      // unchanged file shows nothing, see `card`).
      const named = `${command}\n${str(used.input.description) ?? ''}`;
      if (this.cwd !== null) {
        const edit = `${this.cwd}/edit`;
        if (/pack_transcripts|takes_packed/.test(named))
          this.transcript(`${edit}/takes_packed.md`, index);
        if (/edl\.json|\bEDL\b/.test(named)) {
          this.card(cutsCard(parseJson(this.io.readText(`${edit}/edl.json`))), index);
        }
        if (named.includes('project.md')) {
          const plan = this.io.readText(`${edit}/project.md`);
          if (plan !== null && plan.trim() !== '')
            this.card({ type: 'plan', text: planText(plan) }, index);
        }
      }
      const loudness = parseLoudness(resultText(content));
      if (loudness !== null) this.card({ type: 'loudness', ...loudness }, index);
    }
  }

  private transcript(path: string, index: number): void {
    const text = this.io.readText(path);
    if (text === null || text.trim() === '') return;
    this.card({ type: 'transcript', text: clip(text.trim(), TRANSCRIPT_CHARS) }, index);
  }

  private card(card: FeedCard | null, index: number): void {
    if (card === null) return;
    const key = JSON.stringify(card);
    if (this.lastCards.get(card.type) === key) return;
    this.lastCards.set(card.type, key);
    this.list.push({ id: this.id(`${index}-${card.type}`), at: null, kind: 'card', card });
  }
}
