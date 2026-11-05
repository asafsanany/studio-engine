import { z } from 'zod';
import { isoTimestampSchema } from './job.ts';

// LUTs (the LUTs plan, Plane page "LUTs — architecture & dev plan"): a page where the owner sees every
// LUT, previews it as a real before/after on a test frame, and imports their own .cube (or .3dl)
// files. Yours = the files in `<inbox>/_LUTs/`; Built in = a fixed catalog of 19 rows read from the
// installed colour-grade skill. In a second build a note can name a LUT (`@luts/<slug>`) and the
// edit's colour grade uses it.
//
// This file is the contract the engine and the page share: the kinds, test frames, limits and
// words, the wire shapes (zod), the built-in catalog, and the small rules both sides need (a LUT's
// slug, its name, "Used in 3 jobs", the "New" tag, a kind guess from a file name). LU0 owns it;
// later items only extend it, and say so in their hand-off.

// --- kinds and test frames -----------------------------------------------------------------------

/**
 * What a LUT is for. `look` is creative colour; `fix` cures one specific problem (red skin);
 * `camera` turns flat log footage into normal colours (the grade never guesses one, and a job
 * waits without it).
 */
export const LUT_KINDS = ['look', 'camera', 'fix'] as const;
export const lutKindSchema = z.enum(LUT_KINDS);
export type LutKind = z.infer<typeof lutKindSchema>;

/** The words of each kind in the list, the tabs (plural there) and the import dialog. */
export const LUT_KIND_LABELS: Readonly<Record<LutKind, string>> = {
  look: 'Look',
  camera: 'Camera',
  fix: 'Fix',
};

/** The three test frames a LUT is previewed on: free Unsplash photos bundled with the engine. */
export const LUT_FRAMES = ['person', 'street', 'interior'] as const;
export const lutFrameSchema = z.enum(LUT_FRAMES);
export type LutFrame = z.infer<typeof lutFrameSchema>;

/** The frame chips' words. */
export const LUT_FRAME_LABELS: Readonly<Record<LutFrame, string>> = {
  person: 'Person',
  street: 'Street',
  interior: 'Interior',
};

/**
 * Whose photo each frame is, as the page says it under the frame ("Photo: Benjamin Combs,
 * Unsplash"). Same as apps/server/assets/luts/frames/CREDITS.md.
 */
export const LUT_FRAME_CREDITS: Readonly<Record<LutFrame, string>> = {
  person: 'Benjamin Combs, Unsplash',
  street: 'Nicholas Swanson, Unsplash',
  interior: 'The Anchor, Unsplash',
};

/** The two stills of a preview: the frame as it is, and the frame through the LUT. */
export const LUT_PREVIEW_SIDES = ['before', 'after'] as const;
export const lutPreviewSideSchema = z.enum(LUT_PREVIEW_SIDES);
export type LutPreviewSide = z.infer<typeof lutPreviewSideSchema>;

/** A preview still's size in pixels: the test frames are 9:16. */
export const LUT_FRAME_SIZE = { width: 396, height: 704 } as const;

// --- limits --------------------------------------------------------------------------------------

/** Every limit of the feature, in one place. Bytes are binary (1 MB = 1024 × 1024 bytes). */
export const LUT_LIMITS = {
  /** A LUT's name, in characters (see {@link cleanLutName}). */
  nameMax: 60,
  /** One LUT file, in bytes (a text file). */
  fileMaxBytes: 40 * 1024 * 1024,
  /** A .cube's LUT_3D_SIZE: the grid points per side. */
  gridMin: 2,
  gridMax: 129,
  /** Files in one import. */
  filesPerImport: 60,
  /** How long an upload waits in the staging folder before it is reaped. */
  stageLifetimeMs: 60 * 60 * 1000,
  /** How long a LUT shows the "New" tag after it was imported. */
  newTagMs: 30 * 60 * 1000,
} as const;

/** A LUT's id: 12 hex characters. */
export const LUT_ID_PATTERN = /^[0-9a-f]{12}$/;

/** A slug as notes write it after `@luts/`: lower-case letters and digits, joined by `-`. */
export const LUT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** What every imported file is named and stored as: `<Name>.cube` (a .3dl is converted on import). */
export const LUT_FILE_EXTENSION = '.cube';

// --- the built-in catalog ------------------------------------------------------------------------

/** One built-in LUT: a row of the fixed catalog the page shows under "Built in". */
export interface BuiltInLut {
  /** `lutSlug(name)`; unique across Yours and Built in. */
  slug: string;
  name: string;
  kind: LutKind;
  /** The line under the name in the pane. */
  description: string;
  /** An extra pane line for a LUT made for one problem; `null` for the rest. */
  note: string | null;
  /**
   * The file name(s) inside the skill's `correction_luts/` (~/.claude/skills/color-grade-ai). Empty
   * for the Cinematic look, which is {@link BuiltInLut.look} instead of a file.
   */
  files: readonly string[];
  /**
   * `'cinematic'` for the wrapper's `--look cinematic` chain (film contrast and a light golden
   * warmth), which has no file; `null` for the rest. Its preview is made from exactly what the
   * wrapper applies, so there is no second copy of the blend numbers.
   */
  look: 'cinematic' | null;
  /** "the cinematic look" while that chain uses this LUT; the "Used by …" line says it. */
  usedBy: string | null;
}

const FIX_NOTE = 'Made for footage with one problem, so a clean test frame can look off.';
const CINEMATIC_LOOK = 'the cinematic look';

/**
 * The 19 built-in LUTs (the colour-grade skill's 28 files fold to these: the strength variants
 * such as film_contrast_80 stay hidden because the grade's strength setting covers them). Sorted
 * by name, as the page lists them. The files are never copied into the repo.
 */
export const BUILTIN_LUTS: readonly BuiltInLut[] = [
  {
    slug: 'black-crush',
    name: 'Black crush',
    kind: 'look',
    description: 'Pulls milky blacks down to true black.',
    note: null,
    files: ['black_crush.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'black-lift',
    name: 'Black lift',
    kind: 'look',
    description: 'Lifts the blacks for a faded, vintage look.',
    note: null,
    files: ['black_lift.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'cinema-dark',
    name: 'Cinema dark',
    kind: 'look',
    description: 'Dark, moody and dramatic.',
    note: null,
    files: ['cinema_dark.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'cinematic',
    name: 'Cinematic',
    kind: 'look',
    description: 'Film contrast plus a light golden warmth.',
    note: null,
    files: [],
    look: 'cinematic',
    usedBy: CINEMATIC_LOOK,
  },
  {
    slug: 'cool-shift',
    name: 'Cool shift',
    kind: 'look',
    description: 'A subtle cool shift.',
    note: null,
    files: ['cool_shift.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'film-contrast',
    name: 'Film contrast',
    kind: 'look',
    description: 'Deeper shadows and rolled highlights.',
    note: null,
    files: ['film_contrast.cube'],
    look: null,
    usedBy: CINEMATIC_LOOK,
  },
  {
    slug: 'flat-lift',
    name: 'Flat lift',
    kind: 'look',
    description: 'Lifts the shadows for a softer, more open look.',
    note: null,
    files: ['flat_lift.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'golden-warm',
    name: 'Golden warm',
    kind: 'look',
    description: 'A strong golden-hour warmth.',
    note: null,
    files: ['golden_warm.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'led-green-fix',
    name: 'LED green fix',
    kind: 'fix',
    description: 'Takes the green cast out of cheap LED lighting.',
    note: FIX_NOTE,
    files: ['led_green_fix.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'red-skin-fix',
    name: 'Red skin fix',
    kind: 'fix',
    description: 'Turns red or flushed skin to peach.',
    note: FIX_NOTE,
    files: ['red_skin_fix.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 's-gamut3-to-cine',
    name: 'S-Gamut3 to Cine',
    kind: 'camera',
    description: 'Compensates for S-Gamut3.Cine LUTs used on S-Gamut3 footage.',
    note: null,
    files: ['sgamut3_to_cine.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'saturation-boost',
    name: 'Saturation boost',
    kind: 'look',
    description: 'More colour, about +15%.',
    note: null,
    files: ['sat_boost.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'saturation-reduce',
    name: 'Saturation reduce',
    kind: 'look',
    description: 'Less colour, about -15%.',
    note: null,
    files: ['sat_reduce.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'studio-balanced',
    name: 'Studio balanced',
    kind: 'look',
    description: 'Punch with a touch of warmth and colour.',
    note: null,
    files: ['studio_balanced_baked.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'studio-clean',
    name: 'Studio clean',
    kind: 'look',
    description: 'Clean punch with a little extra colour.',
    note: null,
    files: ['studio_clean_baked.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'studio-dance',
    name: 'Studio dance',
    kind: 'look',
    description: 'Strong punch and warmth, made for stage lighting.',
    note: null,
    files: ['studio_dance_baked.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'studio-film',
    name: 'Studio film',
    kind: 'look',
    description: 'Film contrast, softly warm and a little muted.',
    note: null,
    files: ['studio_film_baked.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'studio-punch',
    name: 'Studio punch',
    kind: 'look',
    description: 'A gentle contrast boost for well-lit interiors.',
    note: null,
    files: ['studio_punch.cube'],
    look: null,
    usedBy: null,
  },
  {
    slug: 'warm-shift',
    name: 'Warm shift',
    kind: 'look',
    description: 'A subtle warm shift.',
    note: null,
    files: ['warm_shift.cube'],
    look: null,
    usedBy: null,
  },
];

/** The built-in LUT with this slug, or `undefined`. */
export function builtInLut(slug: string): BuiltInLut | undefined {
  return BUILTIN_LUTS.find((lut) => lut.slug === slug);
}

// --- a LUT on the wire ---------------------------------------------------------------------------

/** Whose a LUT is: an imported file (`yours`) or a row of the fixed catalog (`builtIn`). */
export const LUT_OWNERS = ['yours', 'builtIn'] as const;
export const lutOwnerSchema = z.enum(LUT_OWNERS);
export type LutOwner = z.infer<typeof lutOwnerSchema>;

/**
 * One LUT as the list shows it (`GET /api/luts`) and as `lut.changed` carries it. Every field is
 * always present; "none" is `null`. `used` is how many jobs used it (distinct jobs), `usedLabel`
 * says so in words, `addedAt` is when it was imported (`null` for a built-in one) and `isNew` is
 * true for {@link LUT_LIMITS}.newTagMs after that.
 */
export const lutSummarySchema = z.object({
  slug: z.string().regex(LUT_SLUG_PATTERN),
  name: z.string().min(1),
  kind: lutKindSchema,
  /** The grid points per side (17, 33, 65 …). */
  size: z.number().int().min(LUT_LIMITS.gridMin).max(LUT_LIMITS.gridMax),
  owner: lutOwnerSchema,
  used: z.number().int().nonnegative(),
  usedLabel: z.string().min(1),
  addedAt: isoTimestampSchema.nullable(),
  isNew: z.boolean(),
  /**
   * 8 hex characters of a hash of the LUT's file and kind (LU2). The page puts it on a preview
   * still's address as `?v=<previewKey>` (`lutPreviewUrl`), which tells the server the address
   * changes when the file or the kind does, so the still may be cached for good. Left out, or `null`
   * (a file that cannot be read), the stills are checked again each time (an ETag keeps that cheap).
   */
  previewKey: z
    .string()
    .regex(/^[0-9a-f]{8}$/)
    .nullable()
    .optional(),
});
export type LutSummary = z.infer<typeof lutSummarySchema>;

/**
 * One LUT with everything its pane shows (`GET /api/luts/:slug`, and the answer of every action on
 * it): the summary, the line under its name, an optional note (a Fix made for one problem), its file
 * (the name inside `_LUTs`; a built-in one has the skill's file name, and `null` for the Cinematic
 * look, which has none), the grid as the facts say it ("33 × 33 × 33"), its bytes (`null` for the
 * Cinematic look) and how many jobs used it (`null` while the lutsInEdits switch is off: the pane
 * hides the row).
 */
export const lutDetailSchema = lutSummarySchema.extend({
  description: z.string(),
  note: z.string().nullable(),
  file: z.string().min(1).nullable(),
  sizeLabel: z.string().min(1),
  bytes: z.number().int().nonnegative().nullable(),
  usedIn: z.number().int().nonnegative().nullable(),
});
export type LutDetail = z.infer<typeof lutDetailSchema>;

/**
 * `GET /api/luts`: Yours (newest first) and Built in (by name). `builtInAvailable` is false when
 * the colour-grade skill is not installed: Built in is then empty and the page says why.
 */
export const lutListResponseSchema = z.object({
  yours: z.array(lutSummarySchema),
  builtIn: z.array(lutSummarySchema),
  builtInAvailable: z.boolean(),
});
export type LutListResponse = z.infer<typeof lutListResponseSchema>;

/** `PATCH /api/luts/:slug` body (Yours only): at least one of the two. */
export const updateLutRequestSchema = z
  .object({
    name: z.string().optional(),
    kind: lutKindSchema.optional(),
  })
  .refine((patch) => patch.name !== undefined || patch.kind !== undefined, {
    message: 'Send a name or a kind.',
  });
export type UpdateLutRequest = z.infer<typeof updateLutRequestSchema>;

// --- import: stage, then import ------------------------------------------------------------------

/**
 * The check's verdict on one uploaded file (`POST /api/luts/stage`): `ok` with its `size` (grid
 * points), or not with a one-sentence `error`. `id` names the file inside the stage; `bytes` is
 * what was uploaded; `kindGuess` is {@link lutKindGuess} of the name.
 */
export const lutStageFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ok: z.boolean(),
  error: z.string().min(1).nullable(),
  size: z.number().int().min(LUT_LIMITS.gridMin).max(LUT_LIMITS.gridMax).nullable(),
  bytes: z.number().int().nonnegative(),
  kindGuess: lutKindSchema,
});
export type LutStageFile = z.infer<typeof lutStageFileSchema>;

/** `POST /api/luts/stage` answer: where the files wait, and one verdict per file. */
export const lutStageResponseSchema = z.object({
  stageId: z.string().min(1),
  files: z.array(lutStageFileSchema),
});
export type LutStageResponse = z.infer<typeof lutStageResponseSchema>;

/** `POST /api/luts/import` body: the files to add (by stage id) and the kind the owner marked each as. */
export const lutImportRequestSchema = z.object({
  stageId: z.string().min(1),
  items: z
    .array(z.object({ id: z.string().min(1), kind: lutKindSchema }))
    .min(1)
    .max(LUT_LIMITS.filesPerImport),
});
export type LutImportRequest = z.infer<typeof lutImportRequestSchema>;

/** `POST /api/luts/import` answer: the new rows, and the files that could not be added with why. */
export const lutImportResponseSchema = z.object({
  imported: z.array(lutSummarySchema),
  failed: z.array(z.object({ id: z.string().min(1), error: z.string().min(1) })),
});
export type LutImportResponse = z.infer<typeof lutImportResponseSchema>;

/** `DELETE /api/luts/stage/:stageId`: the upload was thrown away. */
export const cancelLutStageResponseSchema = z.object({ ok: z.literal(true) });
export type CancelLutStageResponse = z.infer<typeof cancelLutStageResponseSchema>;

/** `POST /api/luts/:slug/reveal`: Finder shows the LUT's file. */
export const revealLutResponseSchema = z.object({ ok: z.literal(true) });
export type RevealLutResponse = z.infer<typeof revealLutResponseSchema>;

/**
 * `DELETE /api/luts/:slug`: the LUT is gone from Yours. `where` is the folder its file was moved
 * to: in the Trash, or `<data>/deleted-luts/` when macOS would not take it there.
 */
export const deleteLutResponseSchema = z.object({
  ok: z.literal(true),
  where: z.string().min(1),
});
export type DeleteLutResponse = z.infer<typeof deleteLutResponseSchema>;

// --- words ---------------------------------------------------------------------------------------

/**
 * The engine's words for every refusal of the LUTs API (`{ error }`) and every verdict of the
 * check, one plain sentence each ending in a period. The status each goes with is in its comment.
 */
export const LUT_MESSAGES = {
  /** 404, every LUTs route while the LUTs switch is off. */
  off: 'LUTs are off.',
  /** 404, a slug the engine does not know (or a LUT that was deleted). */
  notFound: 'There is no such LUT.',
  /** 404, a test frame that is none of {@link LUT_FRAMES}, or a side that is not before or after. */
  previewNotFound: 'There is no such preview.',
  /** 404, a stage id the engine does not know (or one that was reaped). */
  stageNotFound: 'That upload is gone. Choose the files again.',
  /** 400, a `PATCH /api/luts/:slug` body that is neither a name nor a kind. */
  badUpdate: 'Send a name or a kind.',
  /** 400, an import body or an upload that cannot be read. */
  badImport: 'The files could not be read. Choose them again.',
  /** 400, an import that names a file the stage does not have, or one that failed its check. */
  badImportItem: 'That file is not in the upload, or it did not pass the check.',
  /** 422, a name that is empty once cleaned. */
  nameEmpty: 'Give the LUT a name.',
  /** 422, a name another LUT has (names compare without regard to case; Built in counts). */
  nameTaken: 'Another LUT already has this name.',
  /** 403, a rename, a kind change or a delete of a built-in LUT. */
  builtInReadOnly: 'A built-in LUT cannot be changed.',
  /** 413, more than {@link LUT_LIMITS}.filesPerImport files at once. */
  tooManyFiles: `Import at most ${LUT_LIMITS.filesPerImport} LUTs at once.`,
  /** The check: a file over {@link LUT_LIMITS}.fileMaxBytes. */
  tooLarge: 'The file is too large: a LUT can be 40 MB at most.',
  /** The check: an extension that is not .cube or .3dl. */
  badExtension: 'Not a LUT: only .cube and .3dl files can be imported.',
  /** The check: a file that is not text. */
  notText: 'Not a LUT: the file is not text.',
  /** The check: a .cube with no LUT_3D_SIZE line. */
  noSize: 'Not a LUT: there is no LUT_3D_SIZE line.',
  /** The check: a .cube with LUT_1D_SIZE and no LUT_3D_SIZE. */
  oneD: 'That is a 1D LUT.',
  /** The check: a LUT_3D_SIZE outside {@link LUT_LIMITS}.gridMin–gridMax. */
  badGrid: 'The LUT grid must be from 2 to 129 points on a side.',
  /** The check: not exactly size³ rows of three numbers. */
  badRows: 'The LUT does not have the colour rows its size needs.',
  /** The check: a DOMAIN_MIN or DOMAIN_MAX that is not 0 and 1. */
  badDomain: 'Only a LUT with the range 0 to 1 can be used.',
  /** The check: a .3dl that cannot be converted. */
  bad3dl: 'Not a LUT: this .3dl file could not be read.',
  /** The check: ffmpeg could not read the file though it looked right. */
  ffmpegRefused: 'The video tools could not read this LUT.',
  /** 409, the colour-grade skill is not installed. */
  builtInMissing: 'Built-in LUTs need the colour grade. Run pnpm color-grade:install.',
  /** 404, the LUT's file is not in `_LUTs` any more. */
  fileMissing: 'The LUT’s file is not in _LUTs any more.',
  /** 500, Finder could not be asked to show the file. */
  revealFailed: 'Finder could not show the file.',
  /** 500, the file could not be moved to the Trash nor kept aside. */
  deleteFailed: 'The LUT could not be moved to the Trash.',
  /** 500, the still could not be made. */
  previewFailed: 'The preview could not be made.',
  /** 422, the paused-frame look of a Camera LUT (it needs log footage; the grade never guesses one). */
  frameCamera: 'That LUT cannot be previewed.',
  /** 404, the paused-frame look of a job with no preview (or none of that round). */
  frameNoPreview: 'This job has no preview yet.',
  /** 404, the job's preview video is still being rendered (the player's own frames are live). */
  frameMaking: 'The preview video is still being made.',
  /** 400, a `t` that is not a number of seconds (0 or more). */
  frameBadTime: 'Give the time in seconds.',
  /** 500, the frame of the video could not be taken. */
  frameFailed: 'The frame could not be made.',
} as const;

/** The line a built-in section shows while the colour grade is not installed. */
export const LUT_BUILTIN_MISSING_LINE = LUT_MESSAGES.builtInMissing;

// --- rules ---------------------------------------------------------------------------------------

/** Characters, not UTF-16 units: a Hebrew letter or an emoji counts once. */
function cutTo(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

/**
 * A LUT's name as the engine keeps it (it is also its file's name, `<Name>.cube`): in Unicode NFC,
 * with `/` and `:` turned into "–", control characters into spaces, no leading dots (a dot-file is
 * hidden), trimmed and at most {@link LUT_LIMITS}.nameMax characters. Empty when nothing is left:
 * the caller refuses it ({@link LUT_MESSAGES}.nameEmpty).
 */
export function cleanLutName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[/:]/g, '–')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: names can hold them
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  return cutTo(cleaned, LUT_LIMITS.nameMax).trim();
}

/** How LUT names compare: in NFC and lower case (a macOS file name ignores case). */
export function lutNameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * `name`, or the first of "name (2)", "name (3)", … that none of `taken` has, comparing without
 * regard to case ({@link lutNameKey}). A numbered name is cut so it still fits
 * {@link LUT_LIMITS}.nameMax characters.
 */
export function freeLutName(name: string, taken: Iterable<string>): string {
  const keys = new Set(Array.from(taken, lutNameKey));
  if (!keys.has(lutNameKey(name))) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const base = cutTo(name, LUT_LIMITS.nameMax - suffix.length).trimEnd();
    const candidate = `${base}${suffix}`;
    if (!keys.has(lutNameKey(candidate))) return candidate;
  }
}

/**
 * A LUT's slug, the word notes write after `@luts/`: the name in kebab-case ("Golden Hour Warm" →
 * "golden-hour-warm", "Film contrast (2)" → "film-contrast-2"). Letters lose their accents, and
 * anything that is not a letter or digit of the Latin alphabet becomes a single "-". A name with
 * none (Hebrew, say) gets `lut-<first 6 of fallbackId>`. At most 60 characters, so it always
 * matches {@link LUT_SLUG_PATTERN}.
 */
export function lutSlug(name: string, fallbackId: string): string {
  const slug = cutTo(
    name
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, ''),
    60,
  ).replace(/-+$/, '');
  return slug === '' ? `lut-${fallbackId.slice(0, 6).toLowerCase()}` : slug;
}

/**
 * The "Used" column and fact: "3 jobs", "1 job", "Not used yet", or, for a built-in LUT the
 * cinematic look uses and no job has used by itself, "Used by the cinematic look" (`usedBy` is
 * the end of that sentence).
 */
export function lutUsedLabel(used: number, usedBy: string | null = null): string {
  if (used > 0) return used === 1 ? '1 job' : `${used} jobs`;
  return usedBy === null ? 'Not used yet' : `Used by ${usedBy}`;
}

/** The grid as the facts say it: 33 → "33 × 33 × 33". */
export function lutSizeLabel(size: number): string {
  return `${size} × ${size} × ${size}`;
}

/**
 * Whether a LUT imported at `addedAt` still has its "New" tag at `now`: it was added within the
 * last {@link LUT_LIMITS}.newTagMs. A built-in LUT (`addedAt` null), a time in the future or one
 * that cannot be read is not new.
 */
export function isNewLut(
  addedAt: string | null,
  now: Date | string | number = new Date(),
): boolean {
  if (addedAt === null) return false;
  const added = Date.parse(addedAt);
  const at = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (Number.isNaN(added) || Number.isNaN(at)) return false;
  const age = at - added;
  return age >= 0 && age < LUT_LIMITS.newTagMs;
}

/** The words of a file name that say what kind of footage a LUT is for. */
const CAMERA_WORDS = new Set(['to', 'rec709', 'log']);

/**
 * The kind the import dialog starts a file at, from its name (the owner can change it): a name with log,
 * s-log, v-log, c-log (also slog3 …), rec709 (Rec.709) or "to" as a word is `camera`, any other
 * `look`. Never `fix`: that is the owner's call.
 */
export function lutKindGuess(fileName: string): LutKind {
  const words = fileName
    .toLowerCase()
    .replace(/\.(cube|3dl)$/, '')
    .replace(/rec[ ._-]?709/g, 'rec709')
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
  return words.some((word) => CAMERA_WORDS.has(word) || /^[a-z]?log\d*$/.test(word))
    ? 'camera'
    : 'look';
}
