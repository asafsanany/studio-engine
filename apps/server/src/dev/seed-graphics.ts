// The Graphics library for the canvas seed (CVP-270, `pnpm seed:canvas --graphics`): the seven
// graphics of the GRLibrary board with the chats of the GRStudio board, so the Graphics pages can
// be compared with the design and walked through without waiting for a run.
//
//   Hours saved counter           Callout     making v1 (the Making box, step "Building")
//   Name on a white pill          Lower third ready, v2 (a note with a file, then "slower and higher"), used in 4 videos
//   Name with the client’s logo   Lower third couldn’t finish v3 (v2 is what edits use)
//   Myth or fact – opening          Title       ready, v1 (Hebrew)
//   Big number that counts up     Callout     ready, v1
//   Follow card                   End card    ready, v1
//   Follow card – first try       End card    ready, v1, off for edits
//
// Each made version is a whole project on disk, written the way a run's result is (work/ prepared
// by GraphicFolders, the canned graphic of the fake run from graphics/testdata/, then saved as
// versions/vN/), so the player has real compositions to play. The rows go in through the same
// repository the engine uses; times are moved so the list reads "just now", "10 min ago", "1 h
// ago", "Yesterday", "2 days ago" as the board does.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphicStep } from '@studio/shared';
import type { GraphicRepository, StoredGraphic } from '../db/index.js';
import { type FakeGraphicKind, writeFakeGraphicFiles } from '../graphics/fake-graphic-runner.js';
import { readGraphicAbout } from '../graphics/graphic-check.js';
import {
  FIRST_RUN_LENGTH_SEC,
  type GraphicFolders,
  graphicRefsDir,
  graphicWorkDir,
} from '../graphics/graphic-folders.js';

/** How long ago a graphic's last change was. `daysAgo` is a calendar day, at `hour` o'clock. */
export type GraphicSeedAge =
  | { secondsAgo: number }
  | { minutesAgo: number }
  | { daysAgo: number; hour: number };

/** What Claude answered to one of the owner's messages. */
export type GraphicSeedAnswer =
  | {
      status: 'done';
      reply?: string;
      tookSec: number;
      /** What the version changed in the canned graphic's composition, so it does what its reply says. */
      edit?: (composition: string) => string;
    }
  | { status: 'making'; step: GraphicStep }
  | {
      status: 'failed';
      /** Claude's own explanation, shown in the red box before the reason (the board's text). */
      text?: string;
      error: string;
      tookSec: number;
    };

/** One message of the owner's and Claude's answer to it. */
export interface GraphicSeedTurn {
  ask: string;
  /** A file attached to the message: written (a one-pixel picture) into the graphic's refs/. */
  attach?: string;
  answer: GraphicSeedAnswer;
}

export interface GraphicSeedSpec {
  name: string;
  /** Which of the fake run's canned graphics its versions are. */
  look: FakeGraphicKind;
  /** "Edits can use it" (default on). */
  uses?: boolean;
  /** When its last message ended: the list's "Last updated". */
  updated: GraphicSeedAge;
  /** How many videos used it (needs `graphicsInEdits` to show). */
  usedIn?: number;
  turns: readonly GraphicSeedTurn[];
}

const STARTERS: Readonly<Record<FakeGraphicKind, string>> = {
  'lower-third':
    'A lower third: the person’s name on a white pill and their role under it. It slides in from the right, stays about 3 seconds and slides out. Hebrew and English.',
  callout: 'A big number that counts up from zero, with a short label under it. Bold and clean.',
  title: 'An opening title that rises word by word, centred, in Hebrew.',
  'end-card': 'An end card: the client’s handle and a Follow button on a white card that pops in.',
};

/** What Claude said of v2 on the board (v1's reply is the canned graphic's own). */
const LOWER_THIRD_V2 =
  'Made v2. The slide-in takes 0.7 s with a softer ease, and the pill sits at 62% of the height, clear of the captions.';

/**
 * v2 of the lower third as its reply says: the canned graphic's pill sits at 72% of the height
 * (over the sample frame's captions) and slides in in 0.4 s; this puts it at 62% and slides it in
 * in 0.7 s with a softer ease.
 */
export function slowerAndHigher(composition: string): string {
  return composition
    .replace('top: 72%;', 'top: 62%;')
    .replaceAll('duration: 0.4, ease: "power3.out"', 'duration: 0.7, ease: "power2.out"');
}

/** The seven graphics of the GRLibrary board, newest change first. */
export const GRAPHIC_SEED_SPECS: readonly GraphicSeedSpec[] = [
  {
    name: 'Hours saved counter',
    look: 'callout',
    updated: { secondsAgo: 20 },
    turns: [
      {
        ask: 'A counter for hours saved: it counts up to the number, with “hours saved” under it. Big, white and bold.',
        answer: { status: 'making', step: 1 },
      },
    ],
  },
  {
    name: 'Name on a white pill',
    look: 'lower-third',
    updated: { minutesAgo: 10 },
    usedIn: 4,
    turns: [
      {
        ask: STARTERS['lower-third'],
        attach: 'lower-third-I-like.png',
        answer: { status: 'done', tookSec: 112 },
      },
      {
        ask: 'Slower in, and higher: the captions sit where it is now.',
        answer: { status: 'done', reply: LOWER_THIRD_V2, tookSec: 70, edit: slowerAndHigher },
      },
    ],
  },
  {
    name: 'Name with the client’s logo',
    look: 'lower-third',
    updated: { minutesAgo: 60 },
    usedIn: 4,
    turns: [
      {
        ask: STARTERS['lower-third'],
        answer: { status: 'done', tookSec: 112 },
      },
      {
        ask: 'Slower in, and higher: the captions sit where it is now.',
        answer: { status: 'done', reply: LOWER_THIRD_V2, tookSec: 70, edit: slowerAndHigher },
      },
      {
        ask: 'Put the client’s logo at the start of the pill.',
        answer: {
          status: 'failed',
          text: 'At 16:9 the logo pushed the role line out of the frame.',
          error: 'Check at 16:9: the role line ends at x=1968; the frame is 1920 wide.',
          tookSec: 95,
        },
      },
    ],
  },
  {
    name: 'Myth or fact – opening',
    look: 'title',
    updated: { daysAgo: 1, hour: 15 },
    turns: [{ ask: STARTERS.title, answer: { status: 'done', tookSec: 112 } }],
  },
  {
    name: 'Big number that counts up',
    look: 'callout',
    updated: { daysAgo: 1, hour: 11 },
    turns: [{ ask: STARTERS.callout, answer: { status: 'done', tookSec: 112 } }],
  },
  {
    name: 'Follow card',
    look: 'end-card',
    updated: { daysAgo: 2, hour: 16 },
    turns: [{ ask: STARTERS['end-card'], answer: { status: 'done', tookSec: 112 } }],
  },
  {
    name: 'Follow card – first try',
    look: 'end-card',
    uses: false,
    updated: { daysAgo: 2, hour: 12 },
    turns: [{ ask: STARTERS['end-card'], answer: { status: 'done', tookSec: 112 } }],
  },
];

/** Jobs of the twelve that "Name on a white pill" is said to be used in. */
const USED_IN_JOBS = ['j10', 'j11', 'j2', 'j5', 'j6', 'j9'];

/** A one-pixel PNG, the stand-in for a reference picture. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** The moment an age points at, from `now` (ms). A calendar day is the viewer's own. */
export function graphicSeedTime(now: number, age: GraphicSeedAge): number {
  if ('secondsAgo' in age) return now - age.secondsAgo * 1000;
  if ('minutesAgo' in age) return now - age.minutesAgo * 60_000;
  const day = new Date(now);
  day.setDate(day.getDate() - age.daysAgo);
  day.setHours(age.hour, 0, 0, 0);
  return day.getTime();
}

/** When each message of a graphic's chat was asked, started and answered, working back from its last change. */
export interface GraphicSeedTimes {
  askedAt: number;
  startedAt: number;
  /** `null` while the answer is still being made. */
  endedAt: number | null;
}

/** A gap between one answer and the next message of the owner's. */
const BETWEEN_TURNS_MS = 6 * 60_000;

export function graphicSeedTimes(
  turns: readonly GraphicSeedTurn[],
  lastChangeAt: number,
): GraphicSeedTimes[] {
  const times: GraphicSeedTimes[] = [];
  let answerEnds = lastChangeAt;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const answer = (turns[i] as GraphicSeedTurn).answer;
    // A run still going started at the last change; a finished one ended there and took its time.
    const startedAt =
      answer.status === 'making' ? lastChangeAt : answerEnds - answer.tookSec * 1000;
    times[i] = {
      askedAt: startedAt - 2000,
      startedAt,
      endedAt: answer.status === 'making' ? null : answerEnds,
    };
    answerEnds = startedAt - 2000 - BETWEEN_TURNS_MS;
  }
  return times;
}

export interface SeedGraphicsOptions {
  /** A repository on the seed's database whose clock the seeding sets (`setNow`). */
  repo: GraphicRepository;
  /** Moves the repository's clock to this moment: every row is stamped with it. */
  setNow: (at: number) => void;
  folders: GraphicFolders;
  /** The moment the ages are counted from. */
  now: number;
  specs?: readonly GraphicSeedSpec[];
}

/**
 * Puts the graphics into the seed: rows (graphic, chat, uses) through the repository and, for each
 * made version, a whole project in `_Graphics/<Name>/versions/vN/`. Answers the graphics made, in
 * the order of the specs.
 */
export async function seedGraphics({
  repo,
  setNow,
  folders,
  now,
  specs = GRAPHIC_SEED_SPECS,
}: SeedGraphicsOptions): Promise<StoredGraphic[]> {
  const made: StoredGraphic[] = [];
  for (const spec of specs) {
    const times = graphicSeedTimes(spec.turns, graphicSeedTime(now, spec.updated));
    const first = times[0] as GraphicSeedTimes;
    setNow(first.askedAt - 5000);
    const graphic = repo.create({ name: spec.name, uses: spec.uses ?? true });
    await folders.create(graphic.folder);
    const dir = folders.dirOf(graphic.folder);

    let version = 0;
    for (const [i, turn] of spec.turns.entries()) {
      const at = times[i] as GraphicSeedTimes;
      version += 1;
      if (turn.attach !== undefined) {
        await mkdir(graphicRefsDir(dir), { recursive: true });
        await writeFile(join(graphicRefsDir(dir), turn.attach), PIXEL_PNG);
      }
      setNow(at.askedAt);
      repo.addMessage({
        graphicId: graphic.id,
        role: 'you',
        text: turn.ask,
        refs: turn.attach === undefined ? [] : [turn.attach],
      });
      setNow(at.startedAt);
      const answering = repo.addMessage({
        graphicId: graphic.id,
        role: 'claude',
        version,
        status: 'making',
        step: turn.answer.status === 'making' ? turn.answer.step : 0,
        startedAt: new Date(at.startedAt).toISOString(),
      });
      if (turn.answer.status === 'making') continue;

      setNow(at.endedAt as number);
      const endedAt = new Date(at.endedAt as number).toISOString();
      if (turn.answer.status === 'failed') {
        repo.updateMessage(answering.id, {
          status: 'failed',
          step: null,
          ...(turn.answer.text === undefined ? {} : { text: turn.answer.text }),
          error: turn.answer.error,
          endedAt,
        });
        continue;
      }

      // done: the canned graphic becomes versions/v<version>/, the way a run's result does
      const lengthSec = repo.get(graphic.id)?.lengthSec ?? FIRST_RUN_LENGTH_SEC;
      await folders.prepareWork(graphic.folder, {
        id: graphic.id,
        fromVersion: version === 1 ? null : version - 1,
        lengthSec,
      });
      const work = graphicWorkDir(dir);
      await writeFakeGraphicFiles(work, graphic.id, spec.look, {
        first: version === 1,
        reply: turn.answer.reply ?? `Made v${version}.`,
      });
      if (turn.answer.edit !== undefined) {
        const file = join(work, 'compositions', `lib-${graphic.id}.html`);
        await writeFile(file, turn.answer.edit(await readFile(file, 'utf8')));
      }
      const checked = await readGraphicAbout(work);
      if (!checked.ok)
        throw new Error(`The canned ${spec.look} graphic is not right: ${checked.error}`);
      const { about } = checked;
      await folders.writeWorkHost(graphic.folder, graphic.id, about.lengthSec);
      await folders.saveVersion(graphic.folder, version);
      repo.updateMessage(answering.id, {
        status: 'done',
        text: about.reply,
        step: null,
        error: null,
        endedAt,
      });
      repo.setVersion(graphic.id, {
        version,
        kind: about.kind,
        lengthSec: about.lengthSec,
        variables: about.variables,
        when: about.when,
      });
    }

    for (const jobId of USED_IN_JOBS.slice(0, spec.usedIn ?? 0)) {
      repo.addUse(
        graphic.id,
        jobId,
        version,
        new Date(first.endedAt ?? first.startedAt).toISOString(),
      );
    }
    made.push(repo.get(graphic.id) as StoredGraphic);
  }
  return made;
}
