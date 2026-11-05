import { z } from 'zod';
import { clock } from '../format.ts';

// Generated videos (Plane page "Generated videos — architecture & dev plan", plan.md in
// ~/.studio-engine/handoff/generate-design/): a client sends a brief, a script and references but
// no footage. The Brief step marks the job `production: generate`, a Generate stage plans the
// shots, makes the voice (ElevenLabs), the keyframes and the short clips (Higgsfield's API), and
// the normal edit then cuts them to the voice and stops at Review.
//
// This file is the contract the two scripts, the engine and the page share: the files, the wire
// shapes (zod), the error codes and their words, the budget ladder and the texts the Jobs row and
// the job sheet show. GN0 (CVP-409) owns it; later items only extend it, and say "CONTRACT
// CHANGE:" in their hand-off. The scripts (apps/server/assets/generate/make-voice.mjs and
// make-shots.mjs) are plain Node and cannot import this, so they write what these schemas read;
// their tests check every line and file they write against them.
//
// --- Where "Generate" lives (the decision GN0 records) ---------------------------------------------
//
// Steps 1 to 8 stay exactly as they are: the step ids are persisted (`step_runs`, `jobs.step`) and
// used as constants in 33 files, and `STEPS` is never renumbered. "Generate" is NOT a ninth step.
// A generated job shows it like this:
//
//   job.step          stays 1 (Brief) while the Generate run works, and moves on to 2 (Transcribe)
//                     when the edit run starts. A job that is not generated never leaves 1 → 8.
//   job.generate      a nullable `GenerateState` on the job (`Job.generate`, optional on the wire so
//                     every other job's shape is unchanged): { phase, counts, spendUsd, budgetUsd }.
//                     It is read from the table `job_generate` whenever the job is read, only while
//                     the `generate` switch is on, and is `null`/absent for any job without a row.
//                     The Jobs row and the job sheet read it: while `job.generate` is set and its
//                     phase is not `done`, the row's detail is `generateRowText(state)` instead of
//                     the Brief step's text.
//   GET /api/jobs/:id/generate   the same `GenerateState` (200), or 404 for a job without one.
//   GET /api/jobs/:id/generate/history   what the stage did, `{ events: GenerateHistoryEvent[] }`
//                     oldest first (GN5); 404 as above.
//   job.generate      the stream event { jobId, generate }: the page writes it into the job's
//                     generate query (['job-generate', jobId]) and into the cached job.
//   the sheet         inserts a "Generate" row between Brief and Transcribe in Steps for a job
//                     that has `generate`, and shows the "Generated" section (`generateSheetRows`).
//
// Why not a step: a ninth step id would touch every `Record<StepId, …>` and every persisted number;
// this touches the job schema (one optional field), one table and one event.
//
// --- On disk, per job (paths relative to the job's edit/ folder, `GENERATE_FILES`) ------------------
//
//   generate/reference.md       what the Generate run learned from the reference video
//   generate/plan.json          the run's plan (GeneratePlan)
//   generate/voice/L1-take1.mp3 … one file per voice line and take (make-voice.mjs `line`)
//   generate/voice.mp3          the lines assembled with set pauses: the timing master
//   generate/voice-words.json   the word times of voice.mp3 (written by `assemble`)
//   generate/looks/ …           one still per person and made-up prop (make-shots.mjs `still`)
//   generate/keyframes/ …       the start (and end) frame of every clip (`still`)
//   generate/clips/A/take-1.mp4 … the clips, one folder per clip id (make-shots.mjs `clip`)
//   generate/shots/ …           the kept take of every clip, in the order of shots.json (hand-off)
//   generate/sfx/ …             sound effects (make-voice.mjs `sfx`)
//   generate/uploads.json       the public URLs of the images already uploaded to Higgsfield (its
//                               shape is make-shots.mjs's: GN3 defines it)
//   generate/spend.json         every Higgsfield dollar (GenerateSpend); only make-shots.mjs writes it
//   generate/shots.json         the run's hand-off to the edit run (GenerateShots)
//   generate/history.jsonl      what the Generate stage did, one GenerateHistoryEvent per line; the
//                               ENGINE writes it (GN5), the sheet's History reads it through
//                               `GET /api/jobs/:id/generate/history`
//
// --- The two scripts' JSON-line contract (same as the music script's) --------------------------------
//
// Each is called as `node <script> <command> "<edit dir>" …` and prints ONE JSON line on stdout.
// Success: {"ok":true,"command":"…", …}; failure: {"ok":false,"code":"…","message":"…"} with the
// codes of `GENERATE_ERROR_CODES` and the plain words of `generateErrorMessage`. Exit codes
// (`GENERATE_EXIT_CODES`): 0 done, 1 failed (a bad request, a shot Higgsfield would not make),
// 2 refused (a key not accepted, the budget, an empty balance: The owner has to act or say so), 3 the
// service is down or timed out. Paths in a line are relative to `<edit dir>/generate/`. Neither
// script prints, logs or puts in an argument a key; both read their key from a file or the
// environment themselves.
//
//   make-voice.mjs (ElevenLabs; the key is video-use's ELEVENLABS_API_KEY). GN2 made it real; its
//   own header has the details. Every command also takes the GN0 forms (`line "<edit>" L1` reads
//   the text and the direction from plan.json; `assemble --pick L1=1,L2=2`; `sfx "<edit>" alert`).
//     line     "<edit dir>" --id L3 --text "…" [--direction "…"] [--take N] [--voice ID]
//                                                  makes one take of one voice line (the caller has
//                                                  spelled numbers as words) → voice/L3-take1.mp3
//              → {"ok":true,"command":"line","id":"L3","take":1,"file":"voice/L3-take1.mp3",
//                 "ms":3180,"durationSec":3.18,"characters":58,"chars":58,"model":"eleven_v3",
//                 "voice":"…","directionApplied":true}
//     check    "<edit dir>" --file voice/L3-take1.mp3 --text "…" [--language en]
//                                                  listens to the take (Scribe) and compares it with
//                                                  the script's text; keeps the heard words in
//                                                  voice/L3-take1.words.json for `assemble`
//              → {"ok":true,"command":"check","id":"L3","take":1,"file":"voice/L3-take1.mp3",
//                 "match":false,"missing":["But"],"extra":[],"heard":"…",
//                 "words":[{"text":"…","startMs":0,"endMs":180}]}
//     assemble "<edit dir>" --order L1:2,L2:1,… [--pauses "L1>L2:500,…"] [--pause 350] [--lead 2800]
//                                                  joins the picked (and checked) takes with
//                                                  pauses into voice.mp3 at -16 LUFS and writes
//                                                  voice-words.json. --lead (whole ms, 0 to 6000)
//                                                  puts that much silence first, for a video that
//                                                  opens before anyone speaks: every line, word and
//                                                  the length move by it, and `leadMs` is said in the
//                                                  answer and in voice-words.json (missing = 0)
//              → {"ok":true,"command":"assemble","file":"voice.mp3","wordsFile":"voice-words.json",
//                 "ms":31100,"durationSec":31.1,"lufs":-16,"lines":[{"id":"L1","take":2,
//                 "startMs":0,"endMs":3200,"startSec":0,"endSec":3.2,"match":true}]}
//     sfx      "<edit dir>" --id alert --prompt "<what it sounds like>" [--seconds 1.2]
//              → {"ok":true,"command":"sfx","id":"alert","name":"alert","file":"sfx/alert.mp3",
//                 "ms":1020,"durationSec":1.02,"characters":null}
//
//   make-shots.mjs (Higgsfield's API; the key is HIGGSFIELD_API_KEY in the repo's .env, which the
//   script finds from the path in STUDIO_ENV_FILE: the engine passes the PATH only, never the key).
//   GN3 made it real; its own header has the details. `still` and `clip` take --budget <usd>
//   (required) and refuse (exit 2, `over_budget`) when spend.json's total plus the request's
//   estimate would pass it, creating nothing. Estimates are free; a failed, nsfw or canceled request
//   is not charged and is recorded `refunded`. Files are relative to generate/ (a start frame is a
//   file in the job folder). A model name may be given as `--model <slug>` (the GN0 form; the stub
//   still takes only that) or, for a clip, as `--tier`. Extra fields on a line are ignored by the
//   schemas below.
//     estimate "<edit dir>" --kind clip --tier easy|people|tilt --seconds N [--aspect 9:16]
//     estimate "<edit dir>" --kind still --model soul|soul-i2i|qwen-edit|qwen|z-image [--ref <file>…]
//     estimate --slug <slug> --body '<json>'
//              → {"ok":true,"command":"estimate","usd":0.105,"basis":"estimate"|"list",…}
//     upload   "<edit dir>" --file <image>      free; the public URL, cached by the file's hash
//              → {"ok":true,"command":"upload","file":"…","url":"https://…","cached":false,…}
//     still    "<edit dir>" <id> --into looks|keyframes --model <name> --prompt "<…>" --budget <usd>
//                           [--ref <file>…] [--aspect 9:16] [--take N]
//              → {"ok":true,"command":"still","id":"homeowner","file":"looks/homeowner.png",
//                 "usd":0.004,"requestId":"…","model":"…","reused":false,"spentUsd":…,"budgetUsd":3}
//     clip     "<edit dir>" <clipId> --tier easy|people|tilt --start <file> [--end <file>] --seconds N
//                           --prompt "<…>" --budget <usd> [--take N] [--aspect 9:16]
//              → {"ok":true,"command":"clip","id":"A","take":1,"file":"clips/A/take-1.mp4",
//                 "seconds":5,"requestedSeconds":4,"rounded":true,"tier":"easy","model":"…",
//                 "usd":0.105,"requestId":"…","fps":24,"durationSec":5.04,"reused":false,…}
//              A clip waits at most about 9 minutes. If the request is still running it prints
//              {"ok":false,"code":"pending","requestId":"…"} (exit 3, NOT a failure): the SAME command
//              again picks the same request up (never a second one, never a second charge).
//     reframe  has no Higgsfield model: the real script answers bad_request (the stub still
//              obeys the GN0 form: "<edit dir>" <clipId> --take N --aspect 1:1).
//
// The shots stub is kept as assets/generate/make-shots-stub.mjs: it obeys the GN0 forms of this
// contract and writes tiny placeholder files (nothing is sent anywhere), so the engine's and the
// Generate run's tests need no service. It fails on request with STUDIO_GENERATE_STUB_FAIL=<an
// error code>.

// --- the switch's numbers --------------------------------------------------------------------------

/**
 * The default of `generateBudgetUsd`: dollars for one video, the first pass and every review round.
 * $5 (27 Oct 2026, U29) because the clips are Kling 3.0 on the Higgsfield plan's credits now: a
 * 35 s video of 1.5-credit seconds is about $2.95 for one pass with no retake, so $5 leaves room
 * for a pass and a few scenes made again.
 */
export const DEFAULT_GENERATE_BUDGET_USD = 5;

/**
 * What one Higgsfield plan credit is worth in dollars when the engine is not told otherwise
 * (`generateUsdPerCredit`): the 1,000 credit pack, $55.56, on 27 Oct 2026 (packs run 17 to 19
 * credits a dollar). The pictures and clips are made on the plan's credits through the connector;
 * the scripts book them at this rate so spend.json, the budget and the Money page stay in dollars.
 * make-shots.mjs keeps its own copy (DEFAULT_USD_PER_CREDIT; it has no imports); a test keeps the
 * two equal.
 */
export const DEFAULT_GENERATE_USD_PER_CREDIT = 0.056;

/** How many plan credits a number of dollars buys at a rate, rounded down: "about 89". */
export function generateCreditsFor(usd: number, usdPerCredit: number): number {
  return usdPerCredit > 0 ? Math.max(0, Math.floor(usd / usdPerCredit)) : 0;
}

/**
 * The default of `generateVoiceId`: the ElevenLabs voice the voiceover is made with. Kal Jones
 * ("Deep, Smokey and Reliable", from ElevenLabs' voice library), the owner's pick on 25 Oct after he did not like
 * Brian.
 * make-voice.mjs keeps its own copy (it has no imports); a test keeps the two equal.
 */
export const DEFAULT_GENERATE_VOICE_ID = '68RUZBDjLe2YBQvv8zFx';

/**
 * The longest opening `make-voice.mjs assemble --lead` puts before the first word, in ms: voice.mp3 then
 * starts with that much silence and the cut's opening shot (an alert, a title) covers it. make-voice.mjs
 * keeps its own copy (MASTER.leadMaxMs; it has no imports); a test keeps the two equal.
 */
export const GENERATE_VOICE_LEAD_MAX_MS = 6000;

/**
 * The budget one job runs with: the one named in its brief (a note like "budget $5" raises it for
 * this job only), else the configured one.
 */
export function generateBudgetFor(briefBudgetUsd: number | null, configUsd: number): number {
  return briefBudgetUsd !== null && briefBudgetUsd > 0 ? briefBudgetUsd : configUsd;
}

// --- files ---------------------------------------------------------------------------------------

/** The Generate files, relative to a job's edit/ folder. */
export const GENERATE_FILES = {
  /** The folder the Generate run and the two scripts own. */
  dir: 'generate',
  reference: 'generate/reference.md',
  plan: 'generate/plan.json',
  /** `voiceTakeFile(line, take)` files, one per take. */
  voiceDir: 'generate/voice',
  /** The assembled voice: the timing master the shots are cut to. */
  voice: 'generate/voice.mp3',
  voiceWords: 'generate/voice-words.json',
  looksDir: 'generate/looks',
  keyframesDir: 'generate/keyframes',
  /** `clipTakeFile(id, take)` files, a folder per clip. */
  clipsDir: 'generate/clips',
  /** The kept take of every clip, in the order of shots.json (what the edit run cuts). */
  shotsDir: 'generate/shots',
  sfxDir: 'generate/sfx',
  uploads: 'generate/uploads.json',
  spend: 'generate/spend.json',
  shots: 'generate/shots.json',
  /** The stage's History, one JSON event per line (GN5); only the engine writes it. */
  history: 'generate/history.jsonl',
} as const;

/** A voice take's file inside generate/: "voice/L1-take2.mp3". */
export function voiceTakeFile(lineId: string, take: number): string {
  return `voice/${lineId}-take${take}.mp3`;
}

/** A clip take's file inside generate/: "clips/A/take-2.mp4". */
export function clipTakeFile(clipId: string, take: number): string {
  return `clips/${clipId}/take-${take}.mp4`;
}

/** The kept take of a clip in the hand-off folder, inside generate/: "shots/A.mp4". */
export function shotFile(clipId: string): string {
  return `shots/${clipId}.mp4`;
}

// --- ids and small shapes --------------------------------------------------------------------------

const countSchema = z.number().int().nonnegative();
const secondsSchema = z.number().nonnegative();
const usdSchema = z.number().nonnegative();
const textSchema = z.string().min(1);
const timestampSchema = z.iso.datetime();

/** A voice line: "L1", "L2" … */
export const generateLineIdSchema = z.string().regex(/^L[1-9]\d*$/, 'must be L1, L2 …');

/** A clip: "A", "B" … "AA"; letters and digits only, because it is a folder name. */
export const generateClipIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{1,8}$/, 'must be letters and digits, such as A or B2');

/** A person or a made-up prop of the cast: "homeowner", "hero-skylight". Also a file name. */
export const generateCastIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'must be lower-case words joined by dashes');

/** A stretch of the voice track, in seconds from its start. */
export const generateWindowSchema = z
  .object({ startSec: secondsSchema, endSec: secondsSchema })
  .refine((window) => window.endSec > window.startSec, {
    message: 'endSec must be after startSec',
    path: ['endSec'],
  });
export type GenerateWindow = z.infer<typeof generateWindowSchema>;

// --- the plan (plan.json) ------------------------------------------------------------------------

/**
 * One line of the voiceover: the client's words, word for word, and how it should be said ("a clear
 * stop after BUT, weighty question"). The Brief run copies these into brief.json's `voiceover`; the
 * Generate run copies them into plan.json.
 */
export const generateVoiceLineSchema = z.object({
  id: generateLineIdSchema,
  text: textSchema,
  direction: z.string().nullable(),
});
export type GenerateVoiceLine = z.infer<typeof generateVoiceLineSchema>;

/** The kinds of cast: a person, or a made-up prop (a hero skylight). Things the client photographed are not cast. */
export const GENERATE_CAST_KINDS = ['person', 'prop'] as const;

/** One person or made-up prop, with the one fixed look every clip that shows it uses. */
export const generateCastSchema = z.object({
  id: generateCastIdSchema,
  kind: z.enum(GENERATE_CAST_KINDS),
  /** "the homeowner". */
  name: textSchema,
  /** The fixed look in words, repeated in every prompt that shows it. */
  look: textSchema,
  /** The prompt of its look still (looks/<id>.png). */
  prompt: textSchema,
  /** Files of the job folder it is made from (the client's photos), relative to the job folder. */
  references: z.array(textSchema),
});
export type GenerateCast = z.infer<typeof generateCastSchema>;

/**
 * What kind of scene a clip is: `easy` (little hand work), `people` (people and hands), `tilt` (a
 * move that must land on an exact end frame). Since 27 Oct 2026 (U31) every scene is a Kling 4.0
 * text-to-video clip at 720p with no pictures, so the tier no longer picks a model: it is a label
 * of what the scene shows (`tilt` needs a start and an end frame, which that path does not make).
 */
export const GENERATE_TIERS = ['easy', 'people', 'tilt'] as const;
export const generateTierSchema = z.enum(GENERATE_TIERS);
export type GenerateTier = z.infer<typeof generateTierSchema>;

/** A keyframe: the prompt it is made from, and its file inside generate/ once made. */
export const generateKeyframeSchema = z.object({
  prompt: textSchema,
  file: z.string().nullable(),
});
export type GenerateKeyframe = z.infer<typeof generateKeyframeSchema>;

/** The story beats a clip covers, each with its stretch of the voice track. A clip may be used more than once. */
export const generateCoverSchema = z.object({
  beat: textSchema,
  startSec: secondsSchema,
  endSec: secondsSchema,
});
export type GenerateCover = z.infer<typeof generateCoverSchema>;

/** One clip: as short as the cut uses, covering every beat it can. */
export const generateClipSchema = z.object({
  id: generateClipIdSchema,
  covers: z.array(generateCoverSchema).min(1),
  /** What it shows, in one plain sentence. */
  shows: textSchema,
  tier: generateTierSchema,
  /** The length it is made at, in seconds: what the edit uses (a Kling 4.0 scene is 3 to 30). */
  seconds: z.number().positive(),
  /**
   * The start frame it is made from, or `null` for none: a text-to-video scene (U31) starts from
   * words only, so the Generate stage waits for no keyframe of it.
   */
  start: generateKeyframeSchema.nullable(),
  /** Only where a move must land somewhere exact. */
  end: generateKeyframeSchema.nullable(),
  /** Ids of the cast it shows, and files of the job folder (the client's photos); empty without pictures. */
  references: z.array(textSchema),
  /** The scene prompt: the shots at their timecodes. */
  prompt: textSchema,
});
export type GenerateClip = z.infer<typeof generateClipSchema>;

/** edit/generate/plan.json. */
export const generatePlanSchema = z.object({
  voice: z.array(generateVoiceLineSchema).min(1),
  cast: z.array(generateCastSchema),
  clips: z.array(generateClipSchema).min(1),
});
export type GeneratePlan = z.infer<typeof generatePlanSchema>;

// --- the hand-off (shots.json) ---------------------------------------------------------------------

/** One kept clip. `file` is inside generate/. `windows` are the stretches of the voice it is used over (the skylight clip is used three times). */
export const generateShotSchema = z.object({
  id: generateClipIdSchema,
  /** The kept take, such as "clips/B/take-2.mp4". */
  file: textSchema,
  take: z.number().int().positive(),
  windows: z.array(generateWindowSchema).min(1),
  seconds: z.number().positive(),
  shows: textSchema,
  /** The Higgsfield model slug it was made with. */
  model: textSchema,
  /** What the kept take cost. */
  usd: usdSchema,
  /** True when the take failed its check and no better one could be paid for: Review says so. */
  belowBar: z.boolean(),
});
export type GenerateShot = z.infer<typeof generateShotSchema>;

/** edit/generate/shots.json: the shots in the order the edit cuts them. */
export const generateShotsSchema = z.object({ shots: z.array(generateShotSchema) });
export type GenerateShots = z.infer<typeof generateShotsSchema>;

// --- the voice's word times (voice-words.json) --------------------------------------------------------

/** One spoken word of voice.mp3, with the line it belongs to and its time in the assembled voice. */
export const generateVoiceWordSchema = z
  .object({
    line: generateLineIdSchema,
    text: textSchema,
    startSec: secondsSchema,
    endSec: secondsSchema,
  })
  .refine((word) => word.endSec >= word.startSec, {
    message: 'endSec is before startSec',
    path: ['endSec'],
  });
export type GenerateVoiceWord = z.infer<typeof generateVoiceWordSchema>;

/**
 * edit/generate/voice-words.json, written by `make-voice.mjs assemble`: the timing the shots are cut to.
 * `leadMs` is the silence voice.mp3 opens with (`assemble --lead`): the opening shot covers 0 to it, and
 * the word times already include it. Missing means 0, and the script leaves it out when there is none.
 */
export const generateVoiceWordsSchema = z.object({
  leadMs: countSchema.optional(),
  words: z.array(generateVoiceWordSchema),
});
export type GenerateVoiceWords = z.infer<typeof generateVoiceWordsSchema>;

// --- the money (spend.json) -----------------------------------------------------------------------

/** What a Higgsfield request made. A free estimate is never recorded. */
export const GENERATE_SPEND_KINDS = ['look', 'keyframe', 'clip', 'reframe'] as const;
export const generateSpendKindSchema = z.enum(GENERATE_SPEND_KINDS);

/**
 * One request. `usd` is its price from the free estimate; `refunded` is true when it ended failed,
 * nsfw or canceled (Higgsfield does not charge those) and no longer counts.
 */
export const generateSpendEntrySchema = z.object({
  at: timestampSchema,
  kind: generateSpendKindSchema,
  slug: textSchema,
  usd: usdSchema,
  requestId: z.string().nullable(),
  refunded: z.boolean(),
});
export type GenerateSpendEntry = z.infer<typeof generateSpendEntrySchema>;

/** edit/generate/spend.json. `total` is the sum of the entries that are not refunded. */
export const generateSpendSchema = z.object({
  entries: z.array(generateSpendEntrySchema),
  total: usdSchema,
});
export type GenerateSpend = z.infer<typeof generateSpendSchema>;

/** The dollars an entry list adds up to: the entries that were not refunded, in whole cents or finer. */
export function spendTotal(
  entries: readonly Pick<GenerateSpendEntry, 'usd' | 'refunded'>[],
): number {
  let total = 0;
  for (const entry of entries) if (!entry.refunded) total += entry.usd;
  // Six decimals: prices are tenths of a cent, and float sums should not show the noise.
  return Math.round(total * 1_000_000) / 1_000_000;
}

// --- the state the row and the sheet show --------------------------------------------------------

/** The stages of the Generate run, in order. `done` is a finished run. */
export const GENERATE_PHASES = [
  'plan',
  'voice',
  'looks',
  'keyframes',
  'clips',
  'sound',
  'done',
] as const;
export const generatePhaseSchema = z.enum(GENERATE_PHASES);
export type GeneratePhase = z.infer<typeof generatePhaseSchema>;

/** Something made out of something planned: 3 of 7 voice lines. */
export const generateProgressSchema = z.object({ done: countSchema, total: countSchema });
export type GenerateProgress = z.infer<typeof generateProgressSchema>;

/** How far each part has got. `belowBar` counts clips kept below the bar because the money ran out. */
export const generateCountsSchema = z.object({
  voice: generateProgressSchema,
  looks: generateProgressSchema,
  keyframes: generateProgressSchema,
  clips: generateProgressSchema,
  belowBar: countSchema,
});
export type GenerateCounts = z.infer<typeof generateCountsSchema>;

/**
 * Where a generated job's Generate stage stands (the table `job_generate`; `Job.generate`;
 * `GET /api/jobs/:id/generate`; the `job.generate` event). `spendUsd` counts Higgsfield only (the
 * voice is ElevenLabs), and `budgetUsd` is the job's own (the brief's note, else the config's).
 */
export const generateStateSchema = z.object({
  phase: generatePhaseSchema,
  counts: generateCountsSchema,
  spendUsd: usdSchema,
  budgetUsd: z.number().positive(),
});
export type GenerateState = z.infer<typeof generateStateSchema>;

const NONE: GenerateProgress = { done: 0, total: 0 };

/** A state at the start of a run: planning, nothing made, nothing spent. */
export function initialGenerateState(budgetUsd: number): GenerateState {
  return {
    phase: 'plan',
    counts: { voice: NONE, looks: NONE, keyframes: NONE, clips: NONE, belowBar: 0 },
    spendUsd: 0,
    budgetUsd,
  };
}

/** `GET /api/jobs/:id/generate` and the `job.generate` event carry the state itself. */
export const generateResponseSchema = generateStateSchema;
export type GenerateResponse = GenerateState;

export const GENERATE_MESSAGES = {
  /** 404, the generate route while the Generate switch is off (the route is not mounted then; this is the service's answer). */
  off: 'Generated videos are off.',
  /** 404, a job that has no Generate stage. */
  notGenerated: 'This job is not a generated video.',
} as const;

// --- money in words ------------------------------------------------------------------------------

const cents = (usd: number): number => Math.round(usd * 100) / 100;

/** What was spent: "$0", "$1.65", "$3.00". */
export function spendUsdText(usd: number): string {
  return usd <= 0 ? '$0' : `$${cents(usd).toFixed(2)}`;
}

/** A budget or a price in a sentence: "$3", "$5", "$5.50", "$4.10". */
export function budgetUsdText(usd: number): string {
  const rounded = cents(usd);
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** What is left of the budget, in whole cents, never below zero. */
export function budgetLeftUsd(state: Pick<GenerateState, 'spendUsd' | 'budgetUsd'>): number {
  return Math.max(0, cents(state.budgetUsd - state.spendUsd));
}

// --- the row and the sheet's words (boards GNJobs, GNStates, GNSheet) ------------------------------

const ofText = (progress: GenerateProgress): string => `${progress.done}/${progress.total}`;

/**
 * The Generate part of the Jobs row's detail and the sheet's progress label, without the money:
 * "Generate · voice 3/7", "Generate · looks 2/3", "Generate · keyframes 5/7", "Generate · clips 4/6".
 * A part whose total is not known yet (the plan is not made) has no count.
 */
export function generateProgressLabel(state: GenerateState): string {
  const { counts } = state;
  const counted = (name: string, progress: GenerateProgress): string =>
    progress.total === 0 ? `Generate · ${name}` : `Generate · ${name} ${ofText(progress)}`;
  switch (state.phase) {
    case 'plan':
      return 'Generate · planning the shots';
    case 'voice':
      return counted('voice', counts.voice);
    case 'looks':
      return counted('looks', counts.looks);
    case 'keyframes':
      return counted('keyframes', counts.keyframes);
    case 'clips':
      return counted('clips', counts.clips);
    case 'sound':
      return 'Generate · sound effects';
    case 'done':
      return 'Generate · done';
  }
}

/** The Jobs row's detail while Generate runs: the label, and in the clips phase what has been spent. "Generate · clips 4/6 · $1.65". */
export function generateRowText(state: GenerateState): string {
  const label = generateProgressLabel(state);
  return state.phase === 'clips' ? `${label} · ${spendUsdText(state.spendUsd)}` : label;
}

/** The right side of the sheet's progress bar while clips are made: "$1.65 of $3". */
export function generateSpendText(state: Pick<GenerateState, 'spendUsd' | 'budgetUsd'>): string {
  return `${spendUsdText(state.spendUsd)} of ${budgetUsdText(state.budgetUsd)}`;
}

/**
 * The Generate step's text in the sheet's Steps while it runs: "now · voice 3/7" in the voice
 * phase, and "now · 18 min so far" in the others (`minutes` is how long the stage has run; without
 * it, just "now").
 */
export function generateStepText(state: GenerateState, minutes?: number): string {
  if (state.phase === 'voice' && state.counts.voice.total > 0) {
    return `now · voice ${ofText(state.counts.voice)}`;
  }
  return minutes === undefined ? 'now' : `now · ${minutes} min so far`;
}

/**
 * The sentence under the sheet's title while Generate runs. The numbers are the state's; nothing
 * here is a promise about time.
 */
export function generateNowText(state: GenerateState): string {
  const { counts } = state;
  switch (state.phase) {
    case 'plan':
      return 'Generating the video. First it watches the reference and plans the shots.';
    case 'voice':
      return `Generating the video. The voice comes first: line ${Math.max(counts.voice.done, 1)} of ${Math.max(counts.voice.total, 1)}. Every take is checked word by word against the script.`;
    case 'looks':
      return 'Generating the video. Now the looks: one still for each person and made-up prop, so faces and the logo stay the same in every clip.';
    case 'keyframes':
      return 'Generating the video. Now the keyframes: the first frame of every clip.';
    case 'clips':
      return `Generating the clips in Higgsfield: ${counts.clips.done} of ${counts.clips.total} done. One take each, checked frame by frame; a retake only when the check fails.`;
    case 'sound':
      return 'Generating the video. Now the sound effects the brief asks for.';
    case 'done':
      return 'The shots are made. The edit comes next.';
  }
}

/** Which way a row of the sheet's Generated section reads. */
export type GenerateTone = 'normal' | 'muted' | 'warn' | 'error';

/** One row of the sheet's "Generated" section: Voice, Looks, Keyframes, Clips, Spend. */
export interface GenerateSheetRow {
  key: 'Voice' | 'Looks' | 'Keyframes' | 'Clips' | 'Spend';
  value: string;
  tone: GenerateTone;
  /** 0 to 100 for rows that fill; absent otherwise. */
  barPercent?: number;
  /** The bar's colour: blue (normal), grey (the run stopped), amber (the money is spent). */
  barTone?: 'normal' | 'muted' | 'warn';
  /** The muted second line. */
  sub?: string;
}

export interface GenerateSheetOptions {
  /** The assembled voice's length, once it is made: "7 lines · 0:31". */
  voiceSec?: number | null;
  /** The clip below the bar, when the budget ran out: "Clip B: the pour and the tilt up, 0:03 to 0:08." */
  belowBarNote?: string | null;
  /** The stop turned the Spend row red (an estimate over the budget). */
  overBudgetNeedUsd?: number | null;
  /** The run stopped (a failed job): its bars are grey and the clips made are "kept". */
  stopped?: boolean;
}

const percent = (progress: GenerateProgress): number =>
  progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);

const linesText = (count: number): string => `${count} ${count === 1 ? 'line' : 'lines'}`;

/**
 * The rows of the sheet's "Generated" section, word for word as board GNSheet shows them.
 * "—" (muted) is a part that has not started; a part under way says "3 of 7 lines" with a bar; a
 * finished one says what it made ("7 lines · 0:31", "3 stills", "7 for 6 clips", "6 of 6").
 */
export function generateSheetRows(
  state: GenerateState,
  options: GenerateSheetOptions = {},
): GenerateSheetRow[] {
  const { counts } = state;
  const rows: GenerateSheetRow[] = [];

  const voice = counts.voice;
  if (voice.total === 0) rows.push({ key: 'Voice', value: '—', tone: 'muted' });
  else if (voice.done < voice.total) {
    rows.push({
      key: 'Voice',
      value: `${voice.done} of ${voice.total} lines`,
      tone: 'normal',
      barPercent: percent(voice),
    });
  } else {
    const length = options.voiceSec == null ? '' : ` · ${clock(options.voiceSec)}`;
    rows.push({ key: 'Voice', value: `${linesText(voice.total)}${length}`, tone: 'normal' });
  }

  // A part that has made nothing yet reads "—" until the stage is at it (the plan knows the totals
  // before it starts, so "0 of 3 stills" would show a bar for something not begun), and for good
  // when the run stopped before it (GN9, boards GNSheet: Over the budget).
  const looks = counts.looks;
  if (looks.total === 0 || (looks.done === 0 && (state.phase !== 'looks' || options.stopped))) {
    rows.push({ key: 'Looks', value: '—', tone: 'muted' });
  } else if (looks.done < looks.total) {
    rows.push({
      key: 'Looks',
      value: `${looks.done} of ${looks.total} stills`,
      tone: 'normal',
      barPercent: percent(looks),
    });
  } else rows.push({ key: 'Looks', value: `${looks.total} stills`, tone: 'normal' });

  const keyframes = counts.keyframes;
  if (
    keyframes.total === 0 ||
    (keyframes.done === 0 && (state.phase !== 'keyframes' || options.stopped))
  ) {
    rows.push({ key: 'Keyframes', value: '—', tone: 'muted' });
  } else if (keyframes.done < keyframes.total) {
    rows.push({
      key: 'Keyframes',
      value: `${keyframes.done} of ${keyframes.total}`,
      tone: 'normal',
      barPercent: percent(keyframes),
    });
  } else {
    rows.push({
      key: 'Keyframes',
      value: `${keyframes.total} for ${counts.clips.total} clips`,
      tone: 'normal',
    });
  }

  const clips = counts.clips;
  if (clips.total === 0) rows.push({ key: 'Clips', value: '—', tone: 'muted' });
  else if (clips.done === 0 && state.phase !== 'clips') {
    rows.push({ key: 'Clips', value: `0 of ${clips.total}`, tone: 'muted' });
  } else if (clips.done < clips.total) {
    rows.push({
      key: 'Clips',
      // A stopped run keeps what it made: Retry only makes the rest.
      value: `${clips.done} of ${clips.total}${options.stopped && clips.done > 0 ? ' · kept' : ''}`,
      tone: 'normal',
      barPercent: percent(clips),
      barTone: options.stopped ? 'muted' : 'normal',
    });
  } else if (counts.belowBar > 0) {
    rows.push({
      key: 'Clips',
      value: `${clips.done} of ${clips.total} · ${counts.belowBar} below the bar`,
      tone: 'warn',
      ...(options.belowBarNote ? { sub: options.belowBarNote } : {}),
    });
  } else rows.push({ key: 'Clips', value: `${clips.done} of ${clips.total}`, tone: 'normal' });

  rows.push(spendRow(state, options));
  return rows;
}

function spendRow(state: GenerateState, options: GenerateSheetOptions): GenerateSheetRow {
  const value = generateSpendText(state);
  const left = budgetLeftUsd(state);
  const row: GenerateSheetRow = { key: 'Spend', value, tone: 'normal' };
  if (options.overBudgetNeedUsd != null) {
    return {
      ...row,
      tone: 'error',
      sub: `The estimate for one take of every clip is ${spendUsdText(options.overBudgetNeedUsd)}.`,
    };
  }
  if (state.spendUsd <= 0) {
    // Nothing spent yet: say what the money is, or that the voice is free on Higgsfield.
    if (state.phase === 'plan') {
      return { ...row, sub: 'On Higgsfield’s prepaid balance, which is separate from your plan.' };
    }
    return state.phase === 'voice'
      ? { ...row, sub: 'The voice is ElevenLabs, so it costs nothing on Higgsfield.' }
      : row;
  }
  const barPercent = Math.min(100, Math.round((state.spendUsd / state.budgetUsd) * 100));
  if (left <= 0) {
    return {
      ...row,
      barPercent,
      barTone: 'warn',
      sub: 'Nothing is left for retakes. A note like “budget $5” makes another take possible.',
    };
  }
  const barTone = options.stopped ? 'muted' : 'normal';
  if (state.phase === 'done' || state.phase === 'sound') {
    return {
      ...row,
      barPercent,
      barTone,
      sub: `${spendUsdText(left)} left for retakes and review rounds.`,
    };
  }
  return { ...row, barPercent, barTone };
}

// --- errors ----------------------------------------------------------------------------------------

/** Why a Generate call or the stage stopped. The words are `generateErrorMessage`'s. */
export const GENERATE_ERROR_CODES = [
  'balance_empty',
  'key_rejected',
  'over_budget',
  'bad_request',
  'unavailable',
  'generation_failed',
] as const;
export const generateErrorCodeSchema = z.enum(GENERATE_ERROR_CODES);
export type GenerateErrorCode = z.infer<typeof generateErrorCodeSchema>;

/** The services that can refuse: Higgsfield (shots) and ElevenLabs (voice and sound effects). */
export const GENERATE_SERVICES = ['higgsfield', 'elevenlabs'] as const;
export type GenerateService = (typeof GENERATE_SERVICES)[number];

/** What an error's words need beyond its code. */
export interface GenerateErrorContext {
  /** Default Higgsfield. */
  service?: GenerateService;
  /** over_budget: what the pass needs, and the budget it is over. */
  needUsd?: number;
  budgetUsd?: number;
}

const SERVICE_NAMES: Record<GenerateService, string> = {
  higgsfield: 'Higgsfield',
  elevenlabs: 'ElevenLabs',
};

/**
 * The job's error in plain words, the sentence stored in `job.error` and pushed to the phone. The
 * Higgsfield balance, key and budget texts are plan.md section 2.7 word for word.
 */
export function generateErrorMessage(
  code: GenerateErrorCode,
  context: GenerateErrorContext = {},
): string {
  const service = context.service ?? 'higgsfield';
  const name = SERVICE_NAMES[service];
  switch (code) {
    case 'balance_empty':
      return service === 'higgsfield'
        ? 'Higgsfield balance is empty: add funds in the Higgsfield console, then Retry (clips already made are kept).'
        : 'ElevenLabs credits are used up: add credits in ElevenLabs, then Retry (what was already made is kept).';
    case 'key_rejected':
      return service === 'higgsfield'
        ? 'Higgsfield key not accepted: check HIGGSFIELD_API_KEY in .env'
        : 'ElevenLabs key not accepted: check ELEVENLABS_API_KEY in ~/Developer/video-use/.env';
    case 'over_budget':
      return `This video needs about ${spendUsdText(context.needUsd ?? 0)}, over the budget of ${budgetUsdText(context.budgetUsd ?? 0)}: add a note like 'budget $5' and Retry.`;
    case 'bad_request':
      return `${name} did not accept a request: the details are in the job’s log. Retry once; if it stops again, the engine needs a fix.`;
    case 'unavailable':
      return `${name} is not answering right now: wait a few minutes, then Retry (what was already made is kept).`;
    case 'generation_failed':
      return `${name} could not make a shot, even after retakes: Retry, or say in a note what to change.`;
  }
}

/** The bold title of the sheet's error box: "Higgsfield balance is empty", "Over the budget". */
export function generateErrorTitle(
  code: GenerateErrorCode,
  context: GenerateErrorContext = {},
): string {
  const name = SERVICE_NAMES[context.service ?? 'higgsfield'];
  switch (code) {
    case 'balance_empty':
      return context.service === 'elevenlabs'
        ? 'ElevenLabs credits are used up'
        : 'Higgsfield balance is empty';
    case 'key_rejected':
      return `${name} key not accepted`;
    case 'over_budget':
      return 'Over the budget';
    case 'bad_request':
      return `${name} did not accept a request`;
    case 'unavailable':
      return `${name} is not answering`;
    case 'generation_failed':
      return 'A shot could not be made';
  }
}

/** The code line in the sheet's error box: "HTTP 403 · Insufficient balance", "Needs about $4.10 · budget $3". */
export function generateErrorLine(
  code: GenerateErrorCode,
  context: GenerateErrorContext = {},
): string {
  switch (code) {
    case 'balance_empty':
      return context.service === 'elevenlabs'
        ? 'ElevenLabs · quota exceeded'
        : 'HTTP 403 · Insufficient balance';
    case 'key_rejected':
      return 'HTTP 401 · key not accepted';
    case 'over_budget':
      return `Needs about ${spendUsdText(context.needUsd ?? 0)} · budget ${budgetUsdText(context.budgetUsd ?? 0)}`;
    case 'bad_request':
      return 'HTTP 400 · request not accepted';
    case 'unavailable':
      return 'The service did not answer';
    case 'generation_failed':
      return 'Every try was failed by the service';
  }
}

/** The help line under the sheet's error box. */
export function generateErrorHelp(
  code: GenerateErrorCode,
  context: GenerateErrorContext = {},
): string {
  switch (code) {
    case 'balance_empty':
      return context.service === 'elevenlabs'
        ? 'Add credits in ElevenLabs, then press Retry. What was already made is kept.'
        : 'Add funds in the Higgsfield console (console.higgsfield.ai), then press Retry. The request that stopped wasn’t charged.';
    case 'key_rejected':
      return context.service === 'elevenlabs'
        ? 'Check ELEVENLABS_API_KEY in ~/Developer/video-use/.env, then press Retry.'
        : 'Check HIGGSFIELD_API_KEY in .env, then press Retry.';
    case 'over_budget':
      return 'Add a note like “budget $5” in Note for the editor, then press Retry. The voice is kept.';
    case 'bad_request':
      return 'Press Retry once. If it stops again, the engine needs a fix.';
    case 'unavailable':
      return 'Wait a few minutes, then press Retry. What was already made is kept.';
    case 'generation_failed':
      return 'Press Retry, or add a note that says what to change.';
  }
}

/** The Jobs row's detail for a stopped job: "Higgsfield balance is empty", "Needs about $4.10, the budget is $3". */
export function generateRowError(
  code: GenerateErrorCode,
  context: GenerateErrorContext = {},
): string {
  if (code === 'over_budget') {
    return `Needs about ${spendUsdText(context.needUsd ?? 0)}, the budget is ${budgetUsdText(context.budgetUsd ?? 0)}`;
  }
  return generateErrorTitle(code, context);
}

/** What `stopped` needs: the moment, as the sheet writes it ("14:21"), and the clips made and planned. */
export interface GenerateStoppedContext extends GenerateErrorContext {
  at?: string;
  clipsKept?: number;
  clipsTotal?: number;
}

/** Why it stopped as a clause: "the Higgsfield balance is empty", "Higgsfield is not answering". */
export function generateStopReason(
  code: GenerateErrorCode,
  context: GenerateErrorContext = {},
): string {
  const service = context.service ?? 'higgsfield';
  const name = SERVICE_NAMES[service];
  switch (code) {
    case 'balance_empty':
      return service === 'higgsfield'
        ? 'the Higgsfield balance is empty'
        : 'the ElevenLabs credits are used up';
    case 'key_rejected':
      return `the ${name} key was not accepted`;
    case 'over_budget':
      return `this video needs about ${spendUsdText(context.needUsd ?? 0)}, over the budget of ${budgetUsdText(context.budgetUsd ?? 0)}`;
    case 'bad_request':
      return `${name} did not accept a request`;
    case 'unavailable':
      return `${name} is not answering`;
    case 'generation_failed':
      return 'a shot could not be made';
  }
}

/** The sheet's sentence under the title for a stopped job. */
export function generateStoppedText(
  code: GenerateErrorCode,
  context: GenerateStoppedContext = {},
): string {
  if (code === 'over_budget') {
    return `Stopped before any clip: one take of every clip needs about ${spendUsdText(context.needUsd ?? 0)}, over the budget of ${budgetUsdText(context.budgetUsd ?? 0)}, even with the cheaper models.`;
  }
  const at = context.at ? ` at ${context.at}` : '';
  const head = `Stopped${at}: ${generateStopReason(code, context)}.`;
  const kept = context.clipsKept ?? 0;
  const total = context.clipsTotal ?? 0;
  if (kept > 0 && total > kept) {
    return `${head} The ${kept} clips already made are kept, so Retry only makes the other ${total - kept}.`;
  }
  return head;
}

/** The exit codes of both scripts: 0 done, 1 failed, 2 refused (key, budget, balance), 3 the service is down. */
export const GENERATE_EXIT_CODES = { ok: 0, failed: 1, refused: 2, down: 3 } as const;

/** The exit code that goes with an error code. */
export function generateExitCode(code: GenerateErrorCode): number {
  switch (code) {
    case 'balance_empty':
    case 'key_rejected':
    case 'over_budget':
      return GENERATE_EXIT_CODES.refused;
    case 'unavailable':
      return GENERATE_EXIT_CODES.down;
    case 'bad_request':
    case 'generation_failed':
      return GENERATE_EXIT_CODES.failed;
  }
}

// --- the budget ladder (plan.md section 2.3) -------------------------------------------------------

/**
 * What the run does, in this order, when one take of every clip plus the stills costs more than the
 * budget: the cheaper model on every clip with no hands or liquid; every clip cut to the seconds
 * the edit really uses; the most static clip as a still keyframe with a slow push-in built in
 * HyperFrames (free); no retakes at all. The last one does not lower the estimate: it keeps the
 * pass from spending past the budget on retakes, and is the end of the road.
 */
export const LADDER_STEPS = [
  'cheaper_model',
  'trim_clips',
  'still_instead_of_clip',
  'no_retakes',
] as const;
export type LadderStep = (typeof LADDER_STEPS)[number];

/** What `ladderStep` says. */
export type LadderResult =
  /** The estimate fits: go. `leftUsd` is what a retake or a review round can draw on. */
  | { kind: 'fits'; leftUsd: number }
  /** Over: do this step, work out the estimate again, and ask again with `applied` plus `step`. */
  | { kind: 'apply'; step: LadderStep }
  /** Over, and every step is used: stop with `over_budget` (`needUsd` is the estimate). */
  | { kind: 'blocked'; needUsd: number; budgetUsd: number };

/**
 * The next thing to do about a budget: `estimateUsd` is the price of one take of every clip plus
 * the stills as they stand, `applied` the steps already taken (in any order). Pure: the run (or the
 * engine) works out the new estimate after each step and asks again.
 */
export function ladderStep(
  estimateUsd: number,
  budgetUsd: number,
  applied: readonly LadderStep[] = [],
): LadderResult {
  // Cents: a pass that costs exactly the budget fits.
  if (cents(estimateUsd) <= cents(budgetUsd)) {
    return { kind: 'fits', leftUsd: Math.max(0, cents(budgetUsd - estimateUsd)) };
  }
  const next = LADDER_STEPS.find((step) => !applied.includes(step));
  if (next === undefined) {
    return { kind: 'blocked', needUsd: cents(estimateUsd), budgetUsd };
  }
  return { kind: 'apply', step: next };
}

// --- the scripts' lines ---------------------------------------------------------------------------

/** The failure line both scripts print: the code, its plain words, and for the budget the numbers. */
export const generateScriptErrorSchema = z.object({
  ok: z.literal(false),
  code: generateErrorCodeSchema,
  message: textSchema,
  needUsd: usdSchema.optional(),
  budgetUsd: usdSchema.optional(),
  /** What the service said, for the job's log (make-voice.mjs sends it; it holds no key). */
  detail: z.string().optional(),
});

const voiceLineOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('line'),
  id: generateLineIdSchema,
  take: z.number().int().positive(),
  file: textSchema,
  durationSec: secondsSchema,
  /** ElevenLabs characters the take used. */
  chars: countSchema,
  /** The real script also says (the fake one leaves them out): the length in ms, the model and the voice used. */
  ms: countSchema.optional(),
  characters: countSchema.optional(),
  model: textSchema.optional(),
  voice: textSchema.optional(),
  /** Whether the delivery direction was applied (Eleven v3 follows it as audio tags; v2 cannot). */
  directionApplied: z.boolean().optional(),
});

/** What a check heard: the words, with their times in the take. */
const voiceHeardWordSchema = z.object({
  text: textSchema,
  startMs: countSchema,
  endMs: countSchema,
});
export type GenerateVoiceHeardWord = z.infer<typeof voiceHeardWordSchema>;

const voiceCheckOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('check'),
  id: z.string().nullable(),
  take: z.number().int().positive().nullable(),
  file: textSchema,
  /** The check ran; `match` is its result: nothing of the script missing, nothing added. */
  match: z.boolean(),
  /** The script's words the voice did not say ("But"), as written in the script. */
  missing: z.array(textSchema),
  /** The words the voice said that are not in the script (or said instead of one that is). */
  extra: z.array(textSchema),
  heard: z.string(),
  words: z.array(voiceHeardWordSchema),
});

const voiceAssembleOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('assemble'),
  file: textSchema,
  wordsFile: textSchema,
  durationSec: secondsSchema,
  /** The real script also says (the fake one leaves them out): the length in ms and the loudness it made. */
  ms: countSchema.optional(),
  /** The silence voice.mp3 opens with, when `--lead` asked for one (the words and lines already include it). */
  leadMs: countSchema.optional(),
  lufs: z.number().optional(),
  lines: z.array(
    z.object({
      id: generateLineIdSchema,
      take: z.number().int().positive(),
      startSec: secondsSchema,
      endSec: secondsSchema,
      startMs: countSchema.optional(),
      endMs: countSchema.optional(),
      /** Whether the take passed its check. */
      match: z.boolean().optional(),
    }),
  ),
});

const voiceSfxOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('sfx'),
  name: textSchema,
  file: textSchema,
  durationSec: secondsSchema,
  id: textSchema.optional(),
  ms: countSchema.optional(),
  /** The credits ElevenLabs charged, when it says. */
  characters: countSchema.nullable().optional(),
});

/** The one JSON line make-voice.mjs prints. */
export const makeVoiceLineSchema = z.union([
  z.discriminatedUnion('command', [
    voiceLineOkSchema,
    voiceCheckOkSchema,
    voiceAssembleOkSchema,
    voiceSfxOkSchema,
  ]),
  generateScriptErrorSchema,
]);
export type MakeVoiceLine = z.infer<typeof makeVoiceLineSchema>;

const shotsEstimateOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('estimate'),
  usd: usdSchema,
  /** The real script also says (the stub leaves them out): what the price is based on, and for what. */
  basis: z.enum(['estimate', 'list']).optional(),
  kind: z.enum(['clip', 'still']).optional(),
  tier: generateTierSchema.optional(),
  slug: textSchema.optional(),
  seconds: z.number().positive().optional(),
  requestedSeconds: z.number().positive().optional(),
  rounded: z.boolean().optional(),
});

/** What the real script adds to a line of a command that spends (the stub leaves it out). */
const shotsSpendExtras = {
  model: textSchema.optional(),
  /** True when the file was already on disk and nothing was asked of Higgsfield. */
  reused: z.boolean().optional(),
  /** spend.json's total after this call, and the budget it was held to. */
  spentUsd: usdSchema.optional(),
  budgetUsd: usdSchema.optional(),
};

const shotsUploadOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('upload'),
  file: textSchema,
  url: textSchema,
  cached: z.boolean(),
  contentType: textSchema.optional(),
});

const shotsStillOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('still'),
  id: textSchema,
  file: textSchema,
  usd: usdSchema,
  requestId: z.string().nullable(),
  take: z.number().int().positive().optional(),
  ...shotsSpendExtras,
});

const shotsClipOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('clip'),
  id: generateClipIdSchema,
  take: z.number().int().positive(),
  file: textSchema,
  /** The length it was made at: Kling 2.5 Turbo only makes 5 s or 10 s, so a shorter ask is rounded UP. */
  seconds: z.number().positive(),
  usd: usdSchema,
  requestId: z.string().nullable(),
  requestedSeconds: z.number().positive().optional(),
  rounded: z.boolean().optional(),
  tier: generateTierSchema.optional(),
  basis: z.enum(['estimate', 'list']).nullable().optional(),
  /** The file's real frame rate and length (Kling 24 fps, Wan 30 fps; `null` without ffprobe). */
  fps: z.number().positive().nullable().optional(),
  durationSec: secondsSchema.nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  ...shotsSpendExtras,
});

const shotsReframeOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('reframe'),
  id: generateClipIdSchema,
  take: z.number().int().positive(),
  file: textSchema,
  usd: usdSchema,
  requestId: z.string().nullable(),
});

// The four commands that go with the Higgsfield connector (U27): the run makes pictures and clips
// through it on the plan's credits, and these keep the same files and the same ledger around them.

/** `book`: the price of a request, booked in spend.json before it is sent. */
const shotsBookOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('book'),
  kind: generateSpendKindSchema,
  id: textSchema,
  take: z.number().int().positive(),
  model: textSchema,
  credits: z.number().nonnegative(),
  usd: usdSchema,
  /** True when this take was already booked (a rerun): nothing was booked a second time. */
  reused: z.boolean(),
  spentUsd: usdSchema,
  budgetUsd: usdSchema,
  leftUsd: usdSchema,
  /** Where the take stands, so a rerun does not make it twice: `booked` (maybe with a requestId to wait for) or `completed` (with its file). */
  state: z.enum(['booked', 'completed']).optional(),
  requestId: z.string().nullable().optional(),
  file: z.string().nullable().optional(),
});

/** `save`: the file the connector made, downloaded to its place. */
const shotsSaveOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('save'),
  kind: generateSpendKindSchema,
  id: textSchema,
  take: z.number().int().positive(),
  file: textSchema,
  model: textSchema.optional(),
  credits: z.number().nonnegative().nullable().optional(),
  usd: usdSchema,
  seconds: z.number().positive().nullable().optional(),
  requestId: z.string().nullable().optional(),
  fps: z.number().positive().nullable().optional(),
  durationSec: secondsSchema.nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  /** A clip is saved silent: `dropped` (it had a soundtrack), `none` (it had none), `kept` (it could not be taken out). */
  audio: z.enum(['dropped', 'none', 'kept']).nullable().optional(),
  reused: z.boolean(),
  spentUsd: usdSchema,
});

/** `void`: a request that failed, was blocked or cancelled; it is not charged and no longer counts. */
const shotsVoidOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('void'),
  kind: generateSpendKindSchema,
  id: textSchema,
  take: z.number().int().positive(),
  usd: usdSchema,
  refunded: z.literal(true),
  spentUsd: usdSchema,
});

/** `put`: an image of the job sent to the address `media_upload` gave. */
const shotsPutOkSchema = z.object({
  ok: z.literal(true),
  command: z.literal('put'),
  file: textSchema,
  bytes: countSchema,
  contentType: textSchema,
});

/**
 * A `still` or `clip` that was still being made when its wait (about 9 minutes, the limit of a tool
 * call) ran out. It is NOT a failure and nothing is lost: running the SAME command again picks the
 * same request up, never makes or charges a second one, and downloads the file when it is ready.
 * The script exits 3 (the service family), so the caller tells it from `unavailable` by this code.
 */
export const shotsPendingSchema = z.object({
  ok: z.literal(false),
  code: z.literal('pending'),
  message: textSchema,
  requestId: textSchema,
  id: textSchema.optional(),
  take: z.number().int().positive().optional(),
  kind: generateSpendKindSchema.optional(),
});

/** The one JSON line make-shots.mjs prints. */
export const makeShotsLineSchema = z.union([
  z.discriminatedUnion('command', [
    shotsEstimateOkSchema,
    shotsUploadOkSchema,
    shotsStillOkSchema,
    shotsClipOkSchema,
    shotsReframeOkSchema,
    shotsBookOkSchema,
    shotsSaveOkSchema,
    shotsVoidOkSchema,
    shotsPutOkSchema,
  ]),
  generateScriptErrorSchema,
  shotsPendingSchema,
]);
export type MakeShotsLine = z.infer<typeof makeShotsLineSchema>;

/** The commands of the two scripts. */
export const MAKE_VOICE_COMMANDS = ['line', 'check', 'assemble', 'sfx'] as const;
export const MAKE_SHOTS_COMMANDS = [
  'estimate',
  'upload',
  'still',
  'clip',
  'reframe',
  'book',
  'save',
  'void',
  'put',
] as const;

/**
 * The last line of `stdout` that is a valid answer of the script (`schema`), or `null` when there
 * is none (it crashed before printing).
 */
export function parseGenerateScriptLine<T extends z.ZodType>(
  schema: T,
  stdout: string,
): z.infer<T> | null {
  for (const line of stdout.split('\n').reverse()) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: an earlier line.
    }
  }
  return null;
}

// --- History (board GNSheet) -----------------------------------------------------------------------

/**
 * The things a generated job's History says about its Generate stage, each with the words of board
 * GNSheet. The engine decides when one happened; the sheet puts it among the other rows by `at`.
 */
export const generateHistoryEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('decided'),
    at: timestampSchema,
    /** The formats the brief asked for, as "9:16" and "1:1", or null for one. */
    formats: z.array(textSchema).nullable(),
  }),
  z.object({
    kind: z.literal('unpacked'),
    at: timestampSchema,
    count: countSchema,
    /** "logo, equipment, ladder, an older ad, a skylight clip". */
    what: z.string(),
  }),
  z.object({
    kind: z.literal('voice'),
    at: timestampSchema,
    lines: countSchema,
    seconds: secondsSchema,
  }),
  z.object({ kind: z.literal('looks'), at: timestampSchema, names: z.array(textSchema) }),
  z.object({ kind: z.literal('keyframes'), at: timestampSchema, clips: countSchema }),
  z.object({
    kind: z.literal('clip'),
    at: timestampSchema,
    id: generateClipIdSchema,
    shows: textSchema,
    take: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('clips_done'), at: timestampSchema, count: countSchema }),
  z.object({ kind: z.literal('budget'), at: timestampSchema, id: generateClipIdSchema }),
  z.object({
    kind: z.literal('stopped'),
    at: timestampSchema,
    code: generateErrorCodeSchema,
    service: z.enum(GENERATE_SERVICES).optional(),
    needUsd: usdSchema.optional(),
    budgetUsd: usdSchema.optional(),
  }),
]);
export type GenerateHistoryEvent = z.infer<typeof generateHistoryEventSchema>;

/** A format as the sheet writes it: "1080x1920" is "9:16", "1080x1080" is "1:1". */
export function formatRatioText(canvas: string): string {
  switch (canvas) {
    case '1080x1920':
      return '9:16';
    case '1920x1080':
      return '16:9';
    case '1080x1080':
      return '1:1';
    case '1080x1350':
      return '4:5';
    default:
      return canvas;
  }
}

/** "9:16 and 1:1", "9:16, 1:1 and 4:5". */
function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** What History says for one event; the sheet's rows are "time · this". */
export function generateHistoryText(event: GenerateHistoryEvent): string {
  switch (event.kind) {
    case 'decided':
      return event.formats === null || event.formats.length < 2
        ? 'The brief found no footage and a script, so the video is generated.'
        : `The brief found no footage and a script, so the video is generated. ${listText(event.formats)} asked for.`;
    case 'unpacked':
      return `Unpacked the zip: ${event.count} references${event.what === '' ? '' : ` (${event.what})`}`;
    case 'voice':
      return `Voice made: ${linesText(event.lines)}, ${clock(event.seconds)} of speech. Every word checked against the script`;
    case 'looks':
      return `Looks: ${event.names.join(', ')}`;
    case 'keyframes':
      return `Keyframes for ${event.clips} clips`;
    case 'clip':
      return `Clip ${event.id}, ${event.shows}: take ${event.take} kept`;
    case 'clips_done':
      return `All ${event.count} clips kept`;
    case 'budget':
      return `Budget reached: clip ${event.id} kept its best take, below the bar`;
    case 'stopped':
      return event.code === 'over_budget'
        ? `Stopped: needs about ${spendUsdText(event.needUsd ?? 0)}, the budget is ${budgetUsdText(event.budgetUsd ?? 0)}`
        : `Stopped: ${generateStopReason(event.code, event.service === undefined ? {} : { service: event.service })}`;
  }
}

/** How a History line reads on top of the normal colour: a stop is `failure`, the budget running out is `warn`. */
export function generateHistoryTone(event: GenerateHistoryEvent): 'normal' | 'warn' | 'failure' {
  if (event.kind === 'stopped') return 'failure';
  if (event.kind === 'budget') return 'warn';
  return 'normal';
}

/**
 * `GET /api/jobs/:id/generate/history` (GN5): the events of the Generate stage, oldest first, as the
 * engine wrote them while the stage ran. `generateHistoryText` / `generateHistoryTone` give each
 * its line; the sheet puts it among the other History rows by `at`.
 */
export const generateHistoryResponseSchema = z.object({
  events: z.array(generateHistoryEventSchema),
});
export type GenerateHistoryResponse = z.infer<typeof generateHistoryResponseSchema>;

// --- reading an error back (GN5) -------------------------------------------------------------------

/** What a stored job error says about a Generate stop: which error and, for the budget, the dollars. */
export interface ParsedGenerateError {
  code: GenerateErrorCode;
  service: GenerateService;
  needUsd?: number;
  budgetUsd?: number;
}

const OVER_BUDGET_MESSAGE =
  /^This video needs about \$(\d+(?:\.\d+)?), over the budget of \$(\d+(?:\.\d+)?): add a note like 'budget \$5' and Retry\.$/;

/**
 * Reads a job's error (`job.error`) back into the error it came from: the engine stores the exact
 * sentence of `generateErrorMessage(code, { service, … })` when a Generate stop has a code, so the
 * sheet and the phone can pick the title, the code line and the help text from the same table.
 * `null` for any other sentence (a failure of the edit, or of Generate with no code).
 */
export function parseGenerateErrorMessage(message: string | null): ParsedGenerateError | null {
  if (message === null) return null;
  const text = message.trim();
  const over = OVER_BUDGET_MESSAGE.exec(text);
  if (over !== null) {
    return {
      code: 'over_budget',
      service: 'higgsfield',
      needUsd: Number(over[1]),
      budgetUsd: Number(over[2]),
    };
  }
  for (const service of GENERATE_SERVICES) {
    for (const code of GENERATE_ERROR_CODES) {
      if (code === 'over_budget') continue;
      if (generateErrorMessage(code, { service }) === text) return { code, service };
    }
  }
  return null;
}
