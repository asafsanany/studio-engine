// The Brief contract (Plane page "Phase 1 — Brief: architecture & dev plan", §3 "brief.json").
//
// `briefDraftSchema` is what the Brief run writes to edit/brief.json. `briefSchema` is the same
// plus the two fields only the engine writes (`schema` and `fingerprint`).
//
// Rules that shape every schema here:
// - Every key is required. A field the instructions did not cover is `null` (or `[]` for a list),
//   never missing, so the run has to answer each one and the generated JSON Schema lists them all
//   as required.
// - Unknown keys are stripped on parse (zod's default for `z.object`).
// - One exception to "every key is required": the three keys Songs added to `music` (`song`,
//   `original`, `wantsTrending`) have defaults (`null`, `null`, `false`), so a brief.json written
//   before them still parses, and `music.file` may be null. The Brief run is asked for them only
//   while the Songs switch is on: `briefPromptSchema({ songs: true })` lists them as required (zod
//   writes a key with a default as required in the output), and `briefPromptSchema()` is exactly the
//   schema the prompt had before Songs.
// - U21 (music only when asked) adds one more key with a default, the same way: `music.wanted`
//   (`false`). A brief.json written before it still parses and means "the instructions did not ask
//   for music". The Brief run is asked for it only while the music switch is on:
//   `briefPromptSchema({ music: true })` lists it as required (and makes `music.file` nullable, since
//   a brief that asks for music without naming a file has none), and without `music` the schema is
//   exactly what the prompt had before. With the Songs switch on the prompt schema is the whole
//   `music` object, `wanted` included (Songs only ever runs with the music).
// - Generated videos add four more keys with defaults, the same way (`production`, `voiceover`,
//   `formats`, `budgetUsd`, all `null`): a brief.json written before them still parses and means
//   "footage, one format, the configured budget". The Brief run is asked for them only while the
//   Generate switch is on: `briefPromptSchema({ generate: true })` lists them as required, and
//   without `generate` the schema is exactly what the prompt had before.
// - The JSON Schema in the prompt comes from these same objects, so anything the validator checks
//   must survive `z.toJSONSchema`: patterns are plain regexes without flags (zod drops flags when
//   it writes JSON Schema), and nothing here uses a transform or a refinement.

import { z } from 'zod';
import { generateVoiceLineSchema } from '../domain/generate.ts';
import { SONG_VERSIONS } from '../domain/music.ts';

/** What a failed parse says about a key that is not there at all. */
const MISSING = 'missing';

/**
 * Error text for the schemas whose own message would not say a key is missing (an enum or a
 * literal reports "invalid option" for `undefined`). Returning undefined keeps zod's message.
 */
const missingOr = (issue: { input?: unknown }): string | undefined =>
  issue.input === undefined ? MISSING : undefined;

/** The output sizes a brief can ask for. */
export const BRIEF_CANVASES = ['1080x1920', '1920x1080', '1080x1080', '1080x1350'] as const;
export const briefCanvasSchema = z.enum(BRIEF_CANVASES, { error: missingOr });

export const BRIEF_CAPTIONS = ['on', 'off'] as const;
export const briefCaptionsSchema = z.enum(BRIEF_CAPTIONS, { error: missingOr });

/** What the editor does with a file: only `footage` is cut; `instructions` never reach the video. */
export const BRIEF_FILE_ROLES = [
  'footage',
  'instructions',
  'music',
  'logo',
  'reference',
  'ignore',
] as const;
export const briefFileRoleSchema = z.enum(BRIEF_FILE_ROLES, { error: missingOr });

/** `#RRGGBB`, either case. No regex flag, so the JSON Schema pattern says exactly the same. */
const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, {
  error: (issue) => `expected a colour like #7A3E1D, got ${JSON.stringify(issue.input)}`,
});

/** ISO 639-1: two lower-case letters. Names are looked up by the renderer; unknown codes pass. */
const languageCodeSchema = z.string().regex(/^[a-z]{2}$/, {
  error: (issue) =>
    `expected a two-letter lower-case language code like "he", got ${JSON.stringify(issue.input)}`,
});

/** Seconds. Positive, because 0 and negative lengths mean nothing. */
const secondsSchema = z.number().positive();

const hookSchema = z.object({
  what: z.string().describe('The opening moment, in plain English.'),
  file: z.string().nullable().describe('File name that has it, or null.'),
  at: z.string().nullable().describe('Time in that file such as "0:08", or null.'),
});

const mustIncludeItemSchema = z.object({
  what: z.string().describe('What has to be in the video, in plain English.'),
  file: z.string().nullable().describe('File name that has it, or null.'),
  at: z.string().nullable().describe('Time in that file such as "0:08", or null.'),
  quote: z
    .string()
    .nullable()
    .describe('Words said or shown, word for word in the client’s language, or null.'),
});

const mustAvoidItemSchema = z.object({
  what: z.string().describe('What must not appear on screen, in captions or in the cut.'),
  file: z.string().nullable().describe('File name it comes from, or null.'),
});

const lowerThirdSchema = z.object({
  name: z.string().describe('Word for word, in the client’s language and spelling.'),
  role: z.string().nullable().describe('Word for word, or null.'),
});

const onScreenTextSchema = z.object({
  title: z.string().nullable().describe('Opening title, word for word, or null.'),
  lowerThirds: z.array(lowerThirdSchema).describe('One per person named on screen.'),
  cta: z.string().nullable().describe('Call to action, word for word, or null.'),
  endCard: z.string().nullable().describe('End card text, word for word, or null.'),
});

const lookSchema = z.object({
  logo: z.string().nullable().describe('Logo file name, or null.'),
  colors: z.array(hexColorSchema).describe('Brand colours as #RRGGBB.'),
  fonts: z.array(z.string()).describe('Font names, with weight if given, such as "Heebo 800".'),
});

/** The kinds of a song the brief can name: the same four the music record has. */
const briefSongVersionSchema = z.enum(SONG_VERSIONS, { error: missingOr });

const songSchema = z.object({
  title: z
    .string()
    .nullable()
    .describe(
      'The song’s title, word for word in its own language and spelling, or null when only a link is given.',
    ),
  artist: z
    .string()
    .nullable()
    .describe('The artist, word for word, or null when only a link is given.'),
  version: briefSongVersionSchema
    .nullable()
    .describe(
      '"sped up", "slowed" or "remix" when the name says so, "original" if it says so, else null.',
    ),
  link: z
    .string()
    .nullable()
    .describe('A link to the song or to the reel it is in, word for word, or null.'),
  fromFile: z
    .string()
    .nullable()
    .describe('Name of the screenshot or file the song was read from, or null.'),
});

const originalAudioSchema = z.object({
  by: z
    .string()
    .describe('The account named under the "Original audio" label, such as "@reels.creator".'),
});

/**
 * U21: whether the instructions ask for music to be made or added. Music is made only when it is
 * asked for, so this is the Brief run's whole answer to "does this job want music?". It has a
 * default so a brief.json from before it still parses (as "not asked").
 */
const wantedSchema = z
  .boolean()
  .default(false)
  .describe(
    'True only when the instructions (the note, a voice note, a chat, a document) ask for music to be made or added to this video and name no music file and no song. False in every other case: never true because music would fit.',
  );

const musicSchema = z.object({
  file: z
    .string()
    .nullable()
    .describe('Music file name, or null when the instructions give no music file.'),
  note: z.string().nullable().describe('Anything the instructions say about it, or null.'),
  wanted: wantedSchema,
  song: songSchema
    .nullable()
    .default(null)
    .describe(
      'The song the client asked for (from a screenshot, a link or a name), or null. Never guess a song.',
    ),
  original: originalAudioSchema
    .nullable()
    .default(null)
    .describe(
      'Set when the screenshot says "Original audio" instead of a song name, or null. It means there is no song to look up.',
    ),
  wantsTrending: z
    .boolean()
    .default(false)
    .describe('True when the instructions ask for a trending song and name none.'),
});

/**
 * The music the Brief run was asked for before Songs: a file and a note. Only the prompt's JSON
 * Schema uses it, while the music and Songs switches are off, so that prompt stays exactly what it
 * was.
 */
const musicBeforeSongsSchema = z.object({
  file: z.string().describe('Music file name.'),
  note: z.string().nullable().describe('Anything the instructions say about it, or null.'),
});

/**
 * The music the Brief run is asked for while the music switch is on and Songs is off (U21): a file
 * (or none), a note and `wanted`. Only the prompt's JSON Schema uses it.
 */
const musicWantedSchema = z.object({
  file: z
    .string()
    .nullable()
    .describe('Music file name, or null when the instructions give no music file.'),
  note: z.string().nullable().describe('Anything the instructions say about it, or null.'),
  wanted: wantedSchema,
});

const referenceSchema = z.object({
  file: z.string().describe('Reference file name. It is never cut into the video.'),
  takeaway: z.string().describe('The style to match, in plain English.'),
});

const fileSchema = z.object({
  path: z.string().describe('Path relative to the job folder.'),
  role: briefFileRoleSchema,
  note: z.string().nullable().describe('Short note such as "Voice note, 0:48", or null.'),
});

/** How the video is made: from the footage in the folder, or generated (no footage; the instructions describe a video to make). */
export const BRIEF_PRODUCTIONS = ['footage', 'generate'] as const;
export const briefProductionSchema = z.enum(BRIEF_PRODUCTIONS, { error: missingOr });

/** The voiceover of a generated video, line by line. */
const voiceoverSchema = z.object({
  lines: z
    .array(generateVoiceLineSchema)
    .min(1)
    .describe(
      'The script split into lines in the order it is said, ids L1, L2 and so on. "text" is word for word as the client wrote it.',
    ),
});

/**
 * The four keys Generated videos added, in one object so the prompt's schema can leave them out
 * while the Generate switch is off (see `briefPromptSchema`). Each has a default, so a brief.json
 * written before them still parses.
 */
export const BRIEF_GENERATED_KEYS = ['production', 'voiceover', 'formats', 'budgetUsd'] as const;

const generatedKeys = {
  production: briefProductionSchema
    .nullable()
    .default(null)
    .describe(
      '"generate" when the folder has no footage and the instructions describe a video to make, "footage" when the video is cut from footage, null when not said.',
    ),
  voiceover: voiceoverSchema
    .nullable()
    .default(null)
    .describe(
      'The voiceover script for a generated video, word for word, split into lines, each with how it should be said (its direction) or null. Null when there is no script.',
    ),
  formats: z
    .array(briefCanvasSchema)
    .min(1)
    .nullable()
    .default(null)
    .describe(
      'Every size to deliver, such as ["1080x1920", "1080x1080"], the main one first. Only when the instructions or the note explicitly ask for more than one format, else null.',
    ),
  budgetUsd: z
    .number()
    .positive()
    .nullable()
    .default(null)
    .describe(
      'The most that may be spent on generating this video, in dollars, only from a note such as "budget $5", else null.',
    ),
};

export const briefDraftSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe('3–5 plain sentences an editor can act on: what the video is and what matters most.'),
  goal: z.string().nullable(),
  audience: z.string().nullable(),
  platform: z.array(z.string()).describe('Where it will be posted, such as "Instagram Reel".'),
  canvas: briefCanvasSchema.nullable(),
  length: z
    .object({
      targetSec: secondsSchema.nullable().describe('Wanted length in seconds, or null.'),
      maxSec: secondsSchema.nullable().describe('Hard limit in seconds, or null.'),
    })
    .nullable(),
  language: languageCodeSchema
    .nullable()
    .describe('ISO 639-1 code of the spoken language, such as "he", or null.'),
  captions: briefCaptionsSchema.nullable(),
  tone: z.string().nullable(),
  pacing: z.string().nullable(),
  hook: hookSchema.nullable(),
  mustInclude: z.array(mustIncludeItemSchema),
  mustAvoid: z.array(mustAvoidItemSchema),
  onScreenText: onScreenTextSchema,
  look: lookSchema,
  music: musicSchema.nullable(),
  ...generatedKeys,
  references: z.array(referenceSchema),
  files: z.array(fileSchema).describe('Every file in the job folder, each with a role.'),
  assumptions: z
    .array(z.string())
    .describe('Every inference and every conflict you resolved, one plain sentence each.'),
  assumed: z
    .array(z.string())
    .describe('Field paths of the values that are guesses, such as "captions" or "look.colors".'),
});

/** The draft plus the two fields the engine adds after validating it. */
export const briefSchema = z.object({
  schema: z.literal(1, { error: missingOr }),
  fingerprint: z.string(),
  ...briefDraftSchema.shape,
});

export type BriefCanvas = z.infer<typeof briefCanvasSchema>;
export type BriefCaptions = z.infer<typeof briefCaptionsSchema>;
export type BriefFileRole = z.infer<typeof briefFileRoleSchema>;
export type BriefFile = z.infer<typeof fileSchema>;
export type BriefDraft = z.infer<typeof briefDraftSchema>;
export type Brief = z.infer<typeof briefSchema>;

/**
 * The JSON Schema of the draft as pretty JSON, for the Brief prompt's `{{> brief-schema}}`. With
 * `songs` (the Songs switch is on) it is the whole draft, `music.song`, `music.original`,
 * `music.wantsTrending` and `music.wanted` included; with `music` (the music switch is on, Songs
 * off) `music` has `wanted` and a file that may be null; with neither, the draft as it was before
 * Songs. With `generate`
 * (the Generate switch is on) it also lists `production`, `voiceover`, `formats` and `budgetUsd`;
 * without it they are left out. So a prompt built with both switches off is byte for byte what it
 * was. The engine validates what the run wrote with `briefDraftSchema` either way.
 */
export function briefPromptSchema({
  music = false,
  songs = false,
  generate = false,
}: {
  music?: boolean;
  songs?: boolean;
  generate?: boolean;
} = {}): string {
  const withSongs = songs
    ? briefDraftSchema
    : briefDraftSchema.extend({
        music: (music ? musicWantedSchema : musicBeforeSongsSchema).nullable(),
      });
  const schema = generate
    ? withSongs
    : withSongs.omit({ production: true, voiceover: true, formats: true, budgetUsd: true });
  // (BRIEF_GENERATED_KEYS names the same four.)
  return JSON.stringify(z.toJSONSchema(schema), null, 2);
}

/**
 * The first problem in a failed parse as one readable line, such as `files[3].role: Invalid
 * option: expected one of "footage"|"instructions"|…`. A key that is missing reads
 * `goal: missing`, because zod's own text there ("expected string, received undefined") hides that
 * the fix is to write `null`.
 */
export function firstBriefIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unknown problem';
  const missing = issue.code === 'invalid_type' && /received undefined$/.test(issue.message);
  const message = missing ? MISSING : issue.message.replace(/^Invalid input: /, '');
  const path = formatIssuePath(issue.path);
  return path ? `${path}: ${message}` : message;
}

/** `['files', 3, 'role']` → `files[3].role`. */
function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}
