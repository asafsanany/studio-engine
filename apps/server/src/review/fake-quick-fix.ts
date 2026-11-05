// The stand-in quick fix of STUDIO_RUNNER=fake (quick fixes plan, section 2; QF2). It reads nothing and
// spends nothing: it stands in for the Claude process only, so dev, tests and e2e go through the same
// steps, checks (verify-quick-fix.ts, without the lint, which needs `npx`), stills and answer as a
// real fix.
//
// It takes about 2 s (four steps, ÷ STUDIO_FAKE_SPEED), telling onStep on the way, and what it does
// to the fake job's composition (edit/preview/index.html, the sample of fake-preview.ts) is one change
// to the CSS rule of `#title`, picked from the words of the note:
//
//   "remove the title", "hide the title"   display: none
//   "font"                                 Georgia instead of Noto Sans Hebrew
//   "yellow"                               color #ffd60a
//   "bigger", "larger"                     the font size × 1.25
//   "higher"                               top 120 px less
//
// A note with the word "sign" (or "שלט") answers done: false ("the sign is part of the footage"), as
// does one with none of the words, or one whose change is already there (nothing changes). The stills
// are small solid-colour PNGs, before and after, so Compare can be tried; reply.json and the line in
// project.md are what the real run writes. An abort ends it at once, with nothing written after it.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { Config } from '../config.js';
import { realSleep, type Sleep } from '../pipeline/fake-runner.js';
import { PREVIEW_INDEX_PATH } from '../pipeline/preview-files.js';
import {
  FIX_PROJECT_PATH,
  FIX_REPLY_FILE,
  FIX_STILLS,
  fixDirPath,
  snapshotFileName,
} from './quick-fix-files.js';
import {
  type QuickFixOutcome,
  type QuickFixRequest,
  type QuickFixRunner,
  type QuickFixStep,
  quickFixStepLabel,
} from './quick-fix-run.js';
import { type LintPreview, listJobFolder, verifyQuickFix } from './verify-quick-fix.js';

/** How long each of the four steps takes at speed 1: about 2 s in all. */
export const FAKE_QUICK_FIX_STEP_MS = 500;

/** What the stand-in says when it was stopped. */
export const FAKE_QUICK_FIX_STOPPED = 'the fix was stopped';

/** The stills, 54 × 96: a twentieth of the sample's 1080 × 1920. */
const STILL_WIDTH = 54;
const STILL_HEIGHT = 96;
const BEFORE_RGB: readonly [number, number, number] = [58, 58, 60];

/** A PNG of one colour. */
export function solidPng(
  width: number,
  height: number,
  [r, g, b]: readonly [number, number, number],
): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill([r, g, b]).flat())]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One change the stand-in can make, and what it says about it. */
export interface FakeChange {
  /** What the note must say. */
  words: RegExp;
  /** The new text of the `#title { … }` rule, or the same text when it is already so. */
  apply(rule: string): string;
  said: string;
  /** The colour of the "after" still. */
  rgb: readonly [number, number, number];
}

const FAKE_CHANGES: readonly FakeChange[] = [
  {
    words: /\b(?:remove|hide|delete)\b[^.]*\btitle\b|הסר|תסיר|מחק/i,
    apply: (rule) =>
      rule.includes('display: none') ? rule : rule.replace(/\{/, '{ display: none;'),
    said: 'The title is hidden now.',
    rgb: [20, 20, 22],
  },
  {
    words: /\bfont\b|פונט|גופן/i,
    apply: (rule) =>
      rule.replace(/"Noto Sans Hebrew", sans-serif/, 'Georgia, "Times New Roman", serif'),
    said: 'The font is Georgia now.',
    rgb: [88, 70, 40],
  },
  {
    words: /\byellow\b|צהוב/i,
    apply: (rule) => rule.replace(/color:\s*#fff\b/, 'color: #ffd60a'),
    said: 'The title is yellow now.',
    rgb: [255, 214, 10],
  },
  {
    words: /\b(?:bigger|larger)\b|גדול/i,
    apply: (rule) =>
      rule.replace(/(font:\s*\d+\s+)(\d+)px/, (_, head: string, size: string) => {
        return `${head}${Math.round(Number(size) * 1.25)}px`;
      }),
    said: 'The title is bigger now.',
    rgb: [60, 120, 200],
  },
  {
    words: /\bhigher\b|גבוה/i,
    apply: (rule) =>
      rule.replace(
        /top:\s*(\d+)px/,
        (_, top: string) => `top: ${Math.max(40, Number(top) - 120)}px`,
      ),
    said: 'The title is higher now.',
    rgb: [60, 160, 110],
  },
];

/** The `#title { … }` rule of the sample composition. */
const TITLE_RULE = /#title\s*\{[^}]*\}/;

/** The note asks for something the footage holds. */
const FOOTAGE_WORDS = /\bsign\b|שלט/i;

/** What the stand-in does with a note's words: a change, or why it cannot. */
export function fakeQuickFixChange(text: string): FakeChange | { why: string } {
  if (FOOTAGE_WORDS.test(text)) return { why: 'the sign is part of the footage' };
  return (
    FAKE_CHANGES.find((change) => change.words.test(text)) ?? {
      why: 'the stand-in does not know that one',
    }
  );
}

export interface FakeQuickFixRunnerOptions {
  config: Pick<Config, 'inboxPath'>;
  /** STUDIO_FAKE_SPEED: 10 makes a fix ten times faster. Default 1. */
  speed?: number;
  /** For tests: a sleep that returns at once. */
  sleep?: Sleep;
}

/** The lint stand-in: the fake's composition is not run through `npx`. */
const NO_LINT: LintPreview = async () => ({ ok: true });

/** The stand-in quick fix run. OWNER: QF2. */
export class FakeQuickFixRunner implements QuickFixRunner {
  readonly kind = 'fake' as const;
  private readonly inboxPath: string;
  private readonly speed: number;
  private readonly sleep: Sleep;

  constructor(options: FakeQuickFixRunnerOptions) {
    this.inboxPath = options.config.inboxPath;
    this.speed = options.speed ?? 1;
    this.sleep = options.sleep ?? realSleep;
  }

  async run(request: QuickFixRequest): Promise<QuickFixOutcome> {
    const { job, note, fix, signal } = request;
    const stopped = (): QuickFixOutcome => ({
      status: 'failed',
      why: FAKE_QUICK_FIX_STOPPED,
      hasCompare: false,
    });
    const step = async (to: QuickFixStep): Promise<boolean> => {
      request.onStep?.(to, quickFixStepLabel(to, note.route?.kind));
      try {
        await this.sleep(FAKE_QUICK_FIX_STEP_MS / this.speed, signal);
      } catch {
        return false;
      }
      return !signal.aborted;
    };
    if (signal.aborted) return stopped();

    const jobDir = join(this.inboxPath, job.relPath);
    const indexPath = join(jobDir, PREVIEW_INDEX_PATH);
    let html: string;
    try {
      html = await readFile(indexPath, 'utf8');
    } catch {
      return { status: 'failed', why: 'there is no preview to change', hasCompare: false };
    }
    const text = note.text?.trim() ?? '';
    if (text === '')
      return { status: 'failed', why: 'the note has no words yet', hasCompare: false };

    const before = await listJobFolder(jobDir);
    const fixDir = join(jobDir, fixDirPath(fix.id));
    const still = snapshotFileName(note.atSec);
    const writeStill = async (folder: string, rgb: readonly [number, number, number]) => {
      await mkdir(join(fixDir, folder), { recursive: true });
      await writeFile(join(fixDir, folder, still), solidPng(STILL_WIDTH, STILL_HEIGHT, rgb));
    };

    if (!(await step(0))) return stopped();
    await writeStill(FIX_STILLS.before, BEFORE_RGB);
    const change = fakeQuickFixChange(text);
    if (!(await step(1))) return stopped();
    let reply: { done: true; said: string } | { done: false; why: string };
    let afterRgb = BEFORE_RGB;
    if ('why' in change) {
      reply = { done: false, why: change.why };
    } else {
      const rule = TITLE_RULE.exec(html)?.[0];
      if (rule === undefined) {
        reply = { done: false, why: 'there is no title to change' };
      } else {
        const changed = change.apply(rule);
        if (changed === rule) {
          reply = { done: false, why: 'nothing changed' };
        } else {
          await writeFile(
            indexPath,
            html.replace(rule, () => changed),
          );
          reply = { done: true, said: change.said };
          afterRgb = change.rgb;
          await this.noteInProject(jobDir, fix.round, change.said);
        }
      }
    }
    if (!(await step(2))) return stopped();
    if (!(await step(3))) return stopped();
    await writeStill(FIX_STILLS.after, afterRgb);
    await mkdir(fixDir, { recursive: true });
    await writeFile(join(fixDir, FIX_REPLY_FILE), `${JSON.stringify(reply)}\n`);

    return verifyQuickFix({
      jobDir,
      fixId: fix.id,
      atSec: note.atSec,
      before,
      lint: NO_LINT,
      signal,
    });
  }

  /** The line the real run adds to project.md; a fake job without one gets none. */
  private async noteInProject(jobDir: string, round: number, said: string): Promise<void> {
    const path = join(jobDir, FIX_PROJECT_PATH);
    let project: string;
    try {
      project = await readFile(path, 'utf8');
    } catch {
      return;
    }
    const heading = `## Round ${round} · fixed in Review`;
    const body = project.trimEnd();
    const next = body.includes(heading)
      ? `${body}\n- ${said}\n`
      : `${body}\n\n${heading}\n- ${said}\n`;
    await writeFile(path, next);
  }
}
