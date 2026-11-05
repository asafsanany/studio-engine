import { z } from 'zod';
import { effortSchema } from './effort.ts';
import { isoTimestampSchema } from './job.ts';

// Graphics (the Graphics plan, Plane page "Graphics — architecture & dev plan"): a library of
// graphics the owner asks for in a chat. Each graphic is a folder `<inbox>/_Graphics/<Name>/` with one
// whole HyperFrames project per version (versions/v1/, v2/ …); a headless Claude run makes each
// version, and every reply in the chat makes a new one. Every edit can then use the library.
//
// This file is the contract the engine and the page share: the kinds, sizes, limits and words,
// the wire shapes (zod), and the small rules both sides need (a graphic's status, its name, the
// host URL's text values). GR0 owns it; later items only extend it, and say so in their hand-off.

// --- kinds, sizes, backgrounds -------------------------------------------------------------------

/** What a graphic is, as its run says in about.json. `other` is any graphic that is none of the four. */
export const GRAPHIC_KINDS = ['title', 'lower-third', 'callout', 'end-card', 'other'] as const;
export const graphicKindSchema = z.enum(GRAPHIC_KINDS);
export type GraphicKind = z.infer<typeof graphicKindSchema>;

/** The words of each kind in the list and in Details. */
export const GRAPHIC_KIND_LABELS: Readonly<Record<GraphicKind, string>> = {
  title: 'Title',
  'lower-third': 'Lower third',
  callout: 'Callout',
  'end-card': 'End card',
  other: 'Graphic',
};

/**
 * The sizes a graphic is checked and previewed at. A graphic is authored for 9:16 and sized in
 * cqmin/%, so it fits each of them. The keys are what the preview host's `size` parameter takes.
 */
export const GRAPHIC_SIZES = ['9x16', '16x9', '1x1'] as const;
export const graphicSizeSchema = z.enum(GRAPHIC_SIZES);
export type GraphicSize = z.infer<typeof graphicSizeSchema>;

/** Each size in pixels: the host's root composition is this big. */
export const GRAPHIC_SIZE_PIXELS: Readonly<Record<GraphicSize, { width: number; height: number }>> =
  {
    '9x16': { width: 1080, height: 1920 },
    '16x9': { width: 1920, height: 1080 },
    '1x1': { width: 1080, height: 1080 },
  };

/** Each size as the preview's toggle says it. */
export const GRAPHIC_SIZE_LABELS: Readonly<Record<GraphicSize, string>> = {
  '9x16': '9:16',
  '16x9': '16:9',
  '1x1': '1:1',
};

/**
 * What the preview shows behind the graphic: a sample frame of footage with captions, a
 * checkerboard that shows what is see-through, or black. The keys are the host's `bg` parameter.
 */
export const GRAPHIC_BACKGROUNDS = ['frame', 'checker', 'black'] as const;
export const graphicBackgroundSchema = z.enum(GRAPHIC_BACKGROUNDS);
export type GraphicBackground = z.infer<typeof graphicBackgroundSchema>;

/** Each background as the preview's "Behind it" toggle says it. */
export const GRAPHIC_BACKGROUND_LABELS: Readonly<Record<GraphicBackground, string>> = {
  frame: 'Sample frame',
  checker: 'See-through',
  black: 'Black',
};

// --- steps and limits ----------------------------------------------------------------------------

/** The three steps of a run, as `graphic_messages.step` stores them while it is making. */
export const GRAPHIC_STEPS = [0, 1, 2] as const;
export type GraphicStep = (typeof GRAPHIC_STEPS)[number];
export const graphicStepSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

/**
 * The words of the steps in the chat's making box: `first` while v1 is being made, `change` for
 * every later version. The engine reads the steps from the run's tool calls (GR2).
 */
export const GRAPHIC_STEP_LABELS = {
  first: ['Reading your request', 'Building the graphic', 'Checking it at 9:16, 16:9 and 1:1'],
  change: ['Reading your note', 'Changing the graphic', 'Checking it at 9:16, 16:9 and 1:1'],
} as const satisfies Record<'first' | 'change', readonly [string, string, string]>;

/** The step words of a run that makes `version`: v1's are `first`, every later one's `change`. */
export function graphicStepLabels(version: number): readonly [string, string, string] {
  return version <= 1 ? GRAPHIC_STEP_LABELS.first : GRAPHIC_STEP_LABELS.change;
}

/** Every limit of the feature, in one place. Bytes are binary (1 MB = 1024 × 1024 bytes). */
export const GRAPHIC_LIMITS = {
  /** A graphic's name, in characters (see {@link cleanGraphicName}). */
  nameMax: 60,
  /** One chat message, in characters. */
  textMax: 4000,
  /** Files attached to one message. */
  refsMaxFiles: 5,
  /** All the files of one message together. */
  refsMaxBytes: 500 * 1024 * 1024,
  /** Text fields (variables) a graphic may have. */
  variablesMax: 8,
  /** The "When edits use it" line, in characters. */
  whenMax: 200,
  /** The run's reply in the chat (about.json's `reply`), in characters. */
  replyMax: 600,
  /** A graphic's length, in seconds. */
  lengthMinSec: 0.5,
  lengthMaxSec: 30,
  /** Graphic runs at once, of all graphics together (one per graphic). */
  runsAtOnce: 2,
  /** How long one run may take before it fails with {@link GRAPHIC_MESSAGES}.timedOut. */
  runTimeoutMs: 20 * 60 * 1000,
} as const;

/** A graphic's id: 12 hex characters. */
export const GRAPHIC_ID_PATTERN = /^[0-9a-f]{12}$/;

/** A text field's id: a lower-case letter, then lower-case letters, digits and `_`. */
export const GRAPHIC_VARIABLE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

// --- about.json: the run's answer ----------------------------------------------------------------

/**
 * One text field of a graphic: a HyperFrames variable declared in the graphic
 * (`data-composition-variables`, type string) and bound with `data-var-text`. A host fills it with
 * `data-variable-values`; each edit fills it from its own video.
 */
export const graphicVariableSchema = z.object({
  id: z.string().regex(GRAPHIC_VARIABLE_ID_PATTERN),
  label: z.string().trim().min(1),
  default: z.string(),
});
export type GraphicVariable = z.infer<typeof graphicVariableSchema>;

/** At most {@link GRAPHIC_LIMITS}.variablesMax text fields, no id twice. */
export const graphicVariablesSchema = z
  .array(graphicVariableSchema)
  .max(GRAPHIC_LIMITS.variablesMax)
  .refine((variables) => new Set(variables.map((v) => v.id)).size === variables.length, {
    message: 'Each text field needs its own id.',
  });

/**
 * `about.json`, the run's answer, written next to the graphic in the version's folder. The engine
 * checks it with this schema after every run (graphic-check.ts); a run whose about.json does not
 * fit makes no version. `name` comes with the first version only (the engine names the graphic
 * from it while it is still "New graphic …"); `when` is taken only while the owner has not edited it.
 */
export const graphicAboutSchema = z.object({
  name: z.string().trim().min(1).max(GRAPHIC_LIMITS.nameMax).optional(),
  kind: graphicKindSchema,
  lengthSec: z.number().min(GRAPHIC_LIMITS.lengthMinSec).max(GRAPHIC_LIMITS.lengthMaxSec),
  variables: graphicVariablesSchema,
  when: z.string().trim().min(1).max(GRAPHIC_LIMITS.whenMax),
  reply: z.string().trim().min(1).max(GRAPHIC_LIMITS.replyMax),
});
export type GraphicAbout = z.infer<typeof graphicAboutSchema>;

// --- a graphic and its chat, on the wire ---------------------------------------------------------

/**
 * Where a graphic stands, worked out from its rows ({@link graphicStatusOf}): `making` while a run
 * of it is making, `failed` when its newest run failed, `ready` once it has a version, `empty`
 * otherwise. Empty graphics never show in the list.
 */
export const GRAPHIC_STATUSES = ['empty', 'making', 'failed', 'ready'] as const;
export const graphicStatusSchema = z.enum(GRAPHIC_STATUSES);
export type GraphicStatus = z.infer<typeof graphicStatusSchema>;

/** Who wrote a chat message: The owner (`you`) or the run (`claude`). */
export const GRAPHIC_ROLES = ['you', 'claude'] as const;
export const graphicRoleSchema = z.enum(GRAPHIC_ROLES);
export type GraphicRole = z.infer<typeof graphicRoleSchema>;

/** Where one of Claude's rows stands: one run (or one "Use vN again", which is `done` at once). */
export const GRAPHIC_MESSAGE_STATUSES = ['making', 'done', 'failed', 'stopped'] as const;
export const graphicMessageStatusSchema = z.enum(GRAPHIC_MESSAGE_STATUSES);
export type GraphicMessageStatus = z.infer<typeof graphicMessageStatusSchema>;

const versionNumber = z.number().int().min(1);

/**
 * One graphic as the list shows it (`GET /api/graphics`) and as `graphic.changed` carries it.
 * Every field is always present; "none" is `null`.
 */
export const graphicSummarySchema = z.object({
  /** 12 hex characters ({@link GRAPHIC_ID_PATTERN}). */
  id: z.string().regex(GRAPHIC_ID_PATTERN),
  /** "New graphic" (numbered) until v1 names it; then what the run or the owner named it. */
  name: z.string().min(1),
  /** From the newest version's about.json; `null` before v1. */
  kind: graphicKindSchema.nullable(),
  /** Seconds, from the newest version's about.json; `null` before v1. */
  lengthSec: z.number().positive().nullable(),
  /** The version edits use: the newest one made; `null` until v1. */
  version: versionNumber.nullable(),
  /** "Edits can use it" (on by default). */
  uses: z.boolean(),
  status: graphicStatusSchema,
  /** The version being made while `making`; `null` otherwise. */
  makingVersion: versionNumber.nullable(),
  /** The version that could not be made while `failed`; `null` otherwise. */
  failedVersion: versionNumber.nullable(),
  /** When anything about the graphic last changed (a message, a run, a rename). */
  updatedAt: isoTimestampSchema,
});
export type GraphicSummary = z.infer<typeof graphicSummarySchema>;

/**
 * One chat message. The owner's (`you`) carry their text, the files they attached (`refs`, names inside the
 * graphic's refs/ folder) and the effort they picked (`null`: the default). Claude's carry the
 * version they made or tried, their `status`, the `step` while making, the reply as `text` once
 * done (empty before), and the `error` once failed.
 */
export const graphicMessageSchema = z.object({
  id: z.string().min(1),
  role: graphicRoleSchema,
  text: z.string(),
  refs: z.array(z.string().min(1)),
  effort: effortSchema.nullable(),
  version: versionNumber.nullable(),
  status: graphicMessageStatusSchema.nullable(),
  step: graphicStepSchema.nullable(),
  error: z.string().min(1).nullable(),
  startedAt: isoTimestampSchema.nullable(),
  endedAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
});
export type GraphicMessage = z.infer<typeof graphicMessageSchema>;

/**
 * One graphic with everything its page shows (`GET /api/graphics/:id`, and the answer of every
 * action on it): the summary, the "When edits use it" line (`whenEdited` once the owner changed it, so
 * runs no longer do), its text fields, how many videos used it (`null` while the graphicsInEdits
 * switch is off: Details hides the row), its folder's name inside `<inbox>/_Graphics`, when it was
 * made, and its chat, oldest first.
 */
export const graphicDetailSchema = graphicSummarySchema.extend({
  when: z.string(),
  whenEdited: z.boolean(),
  variables: z.array(graphicVariableSchema),
  usedIn: z.number().int().nonnegative().nullable(),
  folder: z.string().min(1),
  createdAt: isoTimestampSchema,
  messages: z.array(graphicMessageSchema),
});
export type GraphicDetail = z.infer<typeof graphicDetailSchema>;

/** `GET /api/graphics`: the graphics that are not empty, newest change first. */
export const graphicListResponseSchema = z.array(graphicSummarySchema);
export type GraphicListResponse = z.infer<typeof graphicListResponseSchema>;

/**
 * `PUT /api/graphics/:id` body: at least one of the three. `name` is cleaned by the server
 * ({@link cleanGraphicName}); `when` is trimmed, at most {@link GRAPHIC_LIMITS}.whenMax characters.
 */
export const updateGraphicRequestSchema = z
  .object({
    name: z.string().optional(),
    when: z.string().max(GRAPHIC_LIMITS.whenMax).optional(),
    uses: z.boolean().optional(),
  })
  .refine(
    (patch) => patch.name !== undefined || patch.when !== undefined || patch.uses !== undefined,
    { message: 'Send a name, a When line or Edits can use it.' },
  );
export type UpdateGraphicRequest = z.infer<typeof updateGraphicRequestSchema>;

/**
 * The text fields of the multipart body of `POST /api/graphics` and `POST /api/graphics/:id/messages`
 * (beside `files[]`): the message, 0 to {@link GRAPHIC_LIMITS}.textMax characters once trimmed, and
 * the effort picked next to Send (left out: the default, Extra high). A message may be only
 * attachments, so empty text is allowed here; the route and the service refuse a message that has
 * neither text nor a file ({@link GRAPHIC_MESSAGES}.textMissing).
 */
export const graphicMessageFieldsSchema = z.object({
  text: z.string().trim().max(GRAPHIC_LIMITS.textMax),
  effort: effortSchema.optional(),
});
export type GraphicMessageFields = z.infer<typeof graphicMessageFieldsSchema>;

/** `POST /api/graphics/voice`: what the voice note said. */
export const graphicVoiceResponseSchema = z.object({ text: z.string().min(1) });
export type GraphicVoiceResponse = z.infer<typeof graphicVoiceResponseSchema>;

/** `POST /api/graphics/:id/reveal`: Finder shows the graphic's folder. */
export const revealGraphicResponseSchema = z.object({ ok: z.literal(true) });
export type RevealGraphicResponse = z.infer<typeof revealGraphicResponseSchema>;

/**
 * `DELETE /api/graphics/:id`: the graphic is gone from the library. `where` is the folder it was
 * moved to: in the Trash, or `<data>/deleted-graphics/` when macOS would not take it there.
 */
export const deleteGraphicResponseSchema = z.object({
  ok: z.literal(true),
  where: z.string().min(1),
});
export type DeleteGraphicResponse = z.infer<typeof deleteGraphicResponseSchema>;

// --- words ---------------------------------------------------------------------------------------

/**
 * The engine's words for every refusal of the graphics API (`{ error }`), one plain sentence each.
 * The status each goes with is in its comment.
 */
export const GRAPHIC_MESSAGES = {
  /** 404, every graphics route while the Graphics switch is off. */
  off: 'Graphics are off.',
  /** 404, an id the engine does not know (or a graphic that was deleted). */
  notFound: 'There is no such graphic.',
  /** 404, a message id that is not one of the graphic's. */
  messageNotFound: 'There is no such message in this chat.',
  /** 404, a version the graphic does not have. */
  versionNotFound: 'This graphic has no such version.',
  /** 400, a message with no text and no file. */
  textMissing: 'Write what you need first.',
  /** 400, a message over the limit. */
  textTooLong: `A message can have at most ${GRAPHIC_LIMITS.textMax} characters.`,
  /** 400, a multipart body that cannot be read, or an effort that does not exist. */
  badMessage: 'The message could not be read. Send it again.',
  /** 400, a `PUT /api/graphics/:id` body that is none of name, when and uses. */
  badUpdate: 'Send a name, a When line or Edits can use it.',
  /** 422, a name that is empty once cleaned. */
  nameEmpty: 'Give the graphic a name.',
  /** 422, a name another graphic has (names compare without regard to case). */
  nameTaken: 'Another graphic already has this name.',
  /** 400, a When line over the limit. */
  whenTooLong: `When edits use it can have at most ${GRAPHIC_LIMITS.whenMax} characters.`,
  /** 415, an attached file that is not an image, a video, a font or a PDF. */
  badUploadType: 'Attach images, videos, fonts or PDFs only.',
  /** 413, more than {@link GRAPHIC_LIMITS}.refsMaxFiles files on one message. */
  tooManyFiles: `Attach at most ${GRAPHIC_LIMITS.refsMaxFiles} files to one message.`,
  /** 413, the files of one message over {@link GRAPHIC_LIMITS}.refsMaxBytes together. */
  tooLarge: 'The files of one message can be 500 MB at most, together.',
  /** 409, "Use vN again" of the version edits use already. */
  nothingToRestore: 'Edits use this version already.',
  /** 409, Stop of a message that is not being made. */
  notMaking: 'This message isn’t being made.',
  /** 409, Retry of a message that did not fail and was not stopped. */
  notRetryable: 'Only a message that failed or was stopped can be made again.',
  /** 409, Duplicate of a graphic that has no version yet. */
  nothingToDuplicate: 'There is nothing to copy until v1 is made.',
  /** 400, a voice note that is not a recording. */
  badRecording: 'That recording could not be read.',
  /** 413, a voice note over the voice-note limit. */
  recordingTooLarge: 'That recording is too long. Keep it under a few minutes.',
  /** 422, a voice note in which nothing was said. */
  noSpeech: 'Nothing was said in that recording.',
  /** 500, the transcriber failed. */
  voiceFailed: 'The voice note could not be typed out. Try again, or type it.',
  /** 500, Finder could not be asked to show the folder. */
  revealFailed: 'Finder could not show the folder.',
  /** 500, the folder could not be moved to the Trash nor kept aside. */
  deleteFailed: 'The graphic could not be moved to the Trash.',
  /** A run that ran out of time (the message's `error`). */
  timedOut: 'It took longer than 20 minutes.',
} as const;

/** What the "busy" refusals (409) ask the owner to wait before. */
export const GRAPHIC_BUSY_ACTIONS = {
  send: 'send your next message',
  rename: 'rename it',
  restore: 'use another version',
  retry: 'try again',
} as const;
export type GraphicBusyAction = keyof typeof GRAPHIC_BUSY_ACTIONS;

/** 409 while the graphic is making `version`: "Wait until v3 is made, then rename it.". */
export function graphicBusyMessage(version: number, action: GraphicBusyAction): string {
  return `Wait until v${version} is made, then ${GRAPHIC_BUSY_ACTIONS[action]}.`;
}

/** The `error` of a run the engine left making when it stopped (set at the next boot). */
export function graphicStoppedByEngineMessage(version: number): string {
  return `The engine stopped while it was making v${version}. Retry to make it again.`;
}

/** Claude's row when "Use vN again" makes it the newest version: "v1 is back, as v3.". */
export function graphicRestoredText(from: number, to: number): string {
  return `v${from} is back, as v${to}.`;
}

/** The first message of a copy: "Copied from Name on a white pill v2.". */
export function graphicCopiedText(name: string, version: number): string {
  return `Copied from ${name} v${version}.`;
}

// --- rules ---------------------------------------------------------------------------------------

/** The part of a chat message {@link graphicStatusOf} reads. */
export type GraphicStatusRow = Pick<GraphicMessage, 'role' | 'status' | 'version'>;

/** A graphic's status, with the version it is making or failed to make. */
export interface GraphicStatusInfo {
  status: GraphicStatus;
  makingVersion: number | null;
  failedVersion: number | null;
}

/**
 * Where a graphic stands, from the version edits use and its chat (oldest message first), in this
 * order: `making` when one of Claude's rows is making; `failed` when Claude's newest row failed;
 * `ready` when it has a version; `empty` otherwise (a new graphic whose first run was stopped, say).
 */
export function graphicStatusOf(
  version: number | null,
  messages: readonly GraphicStatusRow[],
): GraphicStatusInfo {
  const claude = messages.filter((message) => message.role === 'claude');
  const making = claude.find((message) => message.status === 'making');
  if (making !== undefined) {
    return { status: 'making', makingVersion: making.version, failedVersion: null };
  }
  const newest = claude.at(-1);
  if (newest?.status === 'failed') {
    return { status: 'failed', makingVersion: null, failedVersion: newest.version };
  }
  return { status: version === null ? 'empty' : 'ready', makingVersion: null, failedVersion: null };
}

/** The name a new graphic has until v1 names it (numbered when taken: "New graphic (2)"). */
export const NEW_GRAPHIC_NAME = 'New graphic';

/** The name of a duplicate, before it is made free: "Name on a white pill copy". */
export function graphicCopyName(name: string): string {
  return `${name} copy`;
}

/** Characters, not UTF-16 units: a Hebrew letter or an emoji counts once. */
function cutTo(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

/**
 * A graphic's name as the engine keeps it (it is also its folder's name): in Unicode NFC, with `/`
 * and `:` turned into "–", control characters into spaces, no leading dots (a dot-folder is
 * hidden), trimmed and at most {@link GRAPHIC_LIMITS}.nameMax characters. Empty when nothing is
 * left: the caller refuses it ({@link GRAPHIC_MESSAGES}.nameEmpty).
 */
export function cleanGraphicName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[/:]/g, '–')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: names can hold them
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  return cutTo(cleaned, GRAPHIC_LIMITS.nameMax).trim();
}

/** How graphic names compare: in NFC and lower case (a macOS folder name ignores case). */
export function graphicNameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * `name`, or the first of "name (2)", "name (3)", … that none of `taken` has, comparing without
 * regard to case ({@link graphicNameKey}). A numbered name is cut so it still fits
 * {@link GRAPHIC_LIMITS}.nameMax characters.
 */
export function freeGraphicName(name: string, taken: Iterable<string>): string {
  const keys = new Set(Array.from(taken, graphicNameKey));
  if (!keys.has(graphicNameKey(name))) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const base = cutTo(name, GRAPHIC_LIMITS.nameMax - suffix.length).trimEnd();
    const candidate = `${base}${suffix}`;
    if (!keys.has(graphicNameKey(candidate))) return candidate;
  }
}

/** The text values a host fills a graphic's fields with: variable id → text. */
export const graphicVarsSchema = z.record(z.string(), z.string());
export type GraphicVars = z.infer<typeof graphicVarsSchema>;

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** `text` in UTF-8. (JSON.stringify never leaves a lone surrogate, so every code point is whole.) */
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** Bytes as base64url without padding. */
function toBase64Url(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const second = bytes[i + 1];
    const third = bytes[i + 2];
    const n = ((bytes[i] ?? 0) << 16) | ((second ?? 0) << 8) | (third ?? 0);
    out += BASE64URL.charAt((n >> 18) & 63) + BASE64URL.charAt((n >> 12) & 63);
    if (second !== undefined) out += BASE64URL.charAt((n >> 6) & 63);
    if (third !== undefined) out += BASE64URL.charAt(n & 63);
  }
  return out;
}

/** base64url (padded or not) as bytes, or `null` when it is not base64url. */
function fromBase64Url(text: string): number[] | null {
  const body = text.replace(/=+$/, '');
  if (body.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of body) {
    const value = BASE64URL.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return bytes;
}

/**
 * `values` as the preview host's `vars` parameter: base64url (no padding) of its JSON in UTF-8, so
 * Hebrew and emoji survive the address. The same in the browser and in Node, with no globals.
 */
export function encodeGraphicVars(values: GraphicVars): string {
  return toBase64Url(utf8Bytes(JSON.stringify(values)));
}

/**
 * The text values of a host's `vars` parameter ({@link encodeGraphicVars}), or `null` when it is
 * not base64url of UTF-8 JSON that is an object of strings.
 */
export function decodeGraphicVars(text: string): GraphicVars | null {
  const bytes = fromBase64Url(text);
  if (bytes === null) return null;
  try {
    // Invalid UTF-8 makes decodeURIComponent throw.
    const json = decodeURIComponent(
      bytes.map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
    );
    const parsed = graphicVarsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
