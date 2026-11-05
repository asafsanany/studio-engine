import {
  DRAFT_STAGES,
  draftStageOf,
  type FeedCut,
  type FeedImage,
  type FeedRunItem,
  type Job,
  type JobFeedItem,
  type JobVersion,
  type ReviewNote,
} from '@studio/shared';
import { JOB_CHAT_TEXT } from './job-chat-text';

// The job chat's pure parts (Draft & chat, DR6): how the feed is cut into runs, what each divider
// and fold says, the transcript and the cut list as the cards show them, and the cut the player
// plays while the job runs.

/** One run of the chat and what it said and did; the items before the first run have none. */
export interface FeedSection {
  run: FeedRunItem | null;
  items: Exclude<JobFeedItem, FeedRunItem>[];
}

/** The feed, cut at each run's divider. */
export function feedSections(items: readonly JobFeedItem[]): FeedSection[] {
  const sections: FeedSection[] = [];
  let current: FeedSection | null = null;
  for (const item of items) {
    if (item.kind === 'run') {
      current = { run: item, items: [] };
      sections.push(current);
      continue;
    }
    if (current === null) {
      current = { run: null, items: [] };
      sections.push(current);
    }
    current.items.push(item);
  }
  return sections;
}

/** The runs that made the footage before the Draft: folded under one line. */
export function isFoldedRun(run: FeedRunItem | null): boolean {
  return run?.run === 'brief' || run?.run === 'generate';
}

/** "4 min", "50 min", "1 h 12 min", "38 s". */
export function tookText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** What a run's divider says. */
export function runDivider(run: FeedRunItem): string {
  const again = run.mode === 'resume' ? ', resumed' : run.mode === 'retry' ? ', again' : '';
  switch (run.run) {
    case 'brief':
      return `Read the brief${again}`;
    case 'generate':
      return `Made the footage${again}`;
    case 'draft':
      return `Draft started${again}`;
    case 'round':
      return `Round ${run.round ?? 1}${again}`;
    case 'fix':
      return 'Quick fix';
    case 'render':
      return `You approved it${again}`;
  }
}

/** The line a run ends with, once it has ended well: "Draft took 50 min". */
export function runTook(run: FeedRunItem): string | null {
  if (run.outcome !== 'succeeded' || run.durationMs === null) return null;
  const took = tookText(run.durationMs);
  switch (run.run) {
    case 'draft':
      return `Draft took ${took}`;
    case 'round':
      return `Round ${run.round ?? 1} took ${took}`;
    case 'render':
      return `Rendered in ${took}`;
    case 'fix':
      return `Fixed in ${took}`;
    default:
      return `Took ${took}`;
  }
}

/** The one line a folded run shows: "Made the footage first · 40 min". */
export function foldedLine(sections: readonly FeedSection[]): string {
  const generate = sections.some((section) => section.run?.run === 'generate');
  const ms = sections.reduce((sum, section) => sum + (section.run?.durationMs ?? 0), 0);
  const what = generate ? 'Made the footage first' : 'Read the brief first';
  return ms > 0 ? `${what} · ${tookText(ms)}` : what;
}

/** A command fold's line: "Ran 8 commands", or the one command's own words. */
export function commandsLine(count: number): string {
  return count === 1 ? 'Ran 1 command' : `Ran ${count} commands`;
}

/** 4.2 → "0:04.2"; 75 → "1:15.0". */
export function clock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** One phrase of the packed transcript. */
export interface TranscriptPhrase {
  source: string;
  startSec: number;
  endSec: number;
  text: string;
}

/** The packed transcript (video-use's takes_packed.md): its sources and phrases, in order. */
export function transcriptOf(text: string): { sources: string[]; phrases: TranscriptPhrase[] } {
  const sources: string[] = [];
  const phrases: TranscriptPhrase[] = [];
  let source = '';
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+?)(?:\s{2,}\(.*\))?\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      source = heading[1].trim();
      sources.push(source);
      continue;
    }
    const phrase = /^\s*\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\]\s*(.+)$/.exec(line);
    if (phrase?.[1] !== undefined && phrase[2] !== undefined && phrase[3] !== undefined) {
      phrases.push({
        source,
        startSec: Number(phrase[1]),
        endSec: Number(phrase[2]),
        text: phrase[3].trim(),
      });
    }
  }
  return { sources, phrases };
}

/** One shot of the cut list as the card shows it: where it starts in the cut and how long it is. */
export interface CutRow {
  index: number;
  atSec: number;
  lenSec: number;
  source: string;
  beat: string | null;
  quote: string | null;
}

/** The cut list's rows, each placed on the cut's timeline one after the other. */
export function cutRows(cuts: readonly FeedCut[]): CutRow[] {
  let at = 0;
  return cuts.map((cut, index) => {
    const lenSec = Math.max(0, cut.endSec - cut.startSec);
    const row = { index, atSec: at, lenSec, source: cut.source, beat: cut.beat, quote: cut.quote };
    at += lenSec;
    return row;
  });
}

/** The grey tones the segment bar gives each source, so shots of one source look alike. */
const SEGMENT_TONES = ['#3F3F46', '#52525B', '#27272A', '#71717A', '#2E2E33', '#45454D'];

/** The segment bar: one piece per shot, as wide as its share of the cut, toned by its source. */
export function cutSegments(
  cuts: readonly FeedCut[],
): { width: string; tone: string; source: string }[] {
  const rows = cutRows(cuts);
  const total = rows.reduce((sum, row) => sum + row.lenSec, 0);
  const tones = new Map<string, string>();
  return rows.map((row) => {
    if (!tones.has(row.source)) {
      tones.set(row.source, SEGMENT_TONES[tones.size % SEGMENT_TONES.length] ?? '#3F3F46');
    }
    return {
      width: total > 0 ? `${((row.lenSec / total) * 100).toFixed(3)}%` : '0%',
      tone: tones.get(row.source) ?? '#3F3F46',
      source: row.source,
    };
  });
}

/** Every picture of the feed, oldest first: what the lightbox steps through. */
export function feedPictures(items: readonly JobFeedItem[]): FeedImage[] {
  return items.flatMap((item) => (item.kind === 'images' ? item.images : []));
}

/**
 * The cut a running job's player plays (Draft & chat): the version the live preview was when the run
 * began, which is the one the run changes, or else the newest; `null` before the first cut. The
 * versions come newest first.
 */
export function runningCut(versions: readonly JobVersion[]): JobVersion | null {
  return versions.find((version) => version.current) ?? versions[0] ?? null;
}

/**
 * What the player's place says while a running job has no cut to play: "Waiting in line", or that
 * cut 1 shows there; `null` (nothing) until the versions' first answer.
 */
export function stageWaiting(job: Pick<Job, 'state'>, loading: boolean): string | null {
  if (job.state === 'queued') return JOB_CHAT_TEXT.waitingInLine;
  return loading ? null : JOB_CHAT_TEXT.noCutYet;
}

/** The notes of a round, by where they sit on the video. */
export function notesByTime(notes: readonly ReviewNote[]): ReviewNote[] {
  return [...notes].sort((a, b) => a.atSec - b.atSec);
}

/** A piece of Claude's line: plain, **bold** or `code`. */
export interface TextPiece {
  kind: 'plain' | 'bold' | 'code';
  text: string;
}

/** Claude's line in pieces: its **bold** and `code` marked, everything else as it is. */
export function textPieces(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) pieces.push({ kind: 'plain', text: text.slice(last, at) });
    if (match[1] !== undefined) pieces.push({ kind: 'bold', text: match[1] });
    else if (match[2] !== undefined) pieces.push({ kind: 'code', text: match[2] });
    last = at + match[0].length;
  }
  if (last < text.length) pieces.push({ kind: 'plain', text: text.slice(last) });
  return pieces;
}

/** What the run is doing now: the command still running, else the last one it ran. */
export function currentWork(items: readonly JobFeedItem[]): string | null {
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at];
    if (item?.kind === 'run') return null;
    if (item?.kind === 'tools') {
      const running = item.tools.find((tool) => tool.state === 'running');
      return (running ?? item.tools[item.tools.length - 1])?.label ?? null;
    }
  }
  return null;
}

/** Whether the job's run waits or goes on, so its chat is live and there is nothing to review yet. */
export function isRunning(job: Pick<Job, 'state'>): boolean {
  return job.state === 'queued' || job.state === 'editing';
}

/**
 * Whether a click on the job's row opens its chat (Review) instead of its sheet: with Draft & chat
 * on, a job in Review, waiting in line or running does.
 */
export function rowOpensChat(job: Pick<Job, 'state'>, chatOn: boolean): boolean {
  return chatOn && (job.state === 'review' || isRunning(job));
}

/** What the header's badge says while the job runs: "Drafting", "Round 2", "Rendering". */
export function runningLabel(job: Pick<Job, 'state' | 'runKind' | 'round'>): string {
  if (job.state === 'queued') return 'Waiting in line';
  if (job.runKind === 'revise') return `Round ${Math.max(1, job.round)}`;
  if (job.runKind === 'render') return 'Rendering';
  return 'Drafting';
}

/** The progress box's title: where the run is, and its own words for it ("transcribing 2/4"). */
export function progressTitle(
  job: Pick<Job, 'state' | 'runKind' | 'round' | 'step' | 'subProgress' | 'placeInLine'>,
): string {
  if (job.state === 'queued') {
    return job.placeInLine === null
      ? 'Waiting in line'
      : `Waiting in line · ${job.placeInLine} in line`;
  }
  const stage = DRAFT_STAGES.find((item) => item.id === draftStageOf(job.step));
  const what = job.runKind === 'edit' ? (stage?.label ?? 'Starting') : runningLabel(job);
  return job.subProgress === null ? what : `${what} · ${job.subProgress}`;
}

/** What the footer says while there is nothing to send yet (Approve is in the row's menu only). */
export function waitingFooter(job: Pick<Job, 'state' | 'runKind'>): string {
  if (job.runKind === 'render' && job.state === 'editing') return 'Rendering what you approved.';
  if (job.runKind === 'revise')
    return 'Your notes are being worked on. Send opens when the new cut is ready.';
  return 'Send opens when cut 1 is ready.';
}
