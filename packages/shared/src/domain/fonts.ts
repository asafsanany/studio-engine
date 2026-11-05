import { z } from 'zod';
import { isoTimestampSchema } from './job.ts';
import { LUT_FRAME_CREDITS, LUT_FRAME_LABELS, LUT_FRAMES, type LutFrame } from './luts.ts';

// Fonts (the Fonts plan, Plane page "Fonts — architecture & dev plan"): a page where the owner sees every
// font family in their `<inbox>/_Fonts` folder, set in English and Hebrew in every weight, and imports
// more by dropping files or a folder. In a second build a note can name a font by its full name
// (`@Heebo Bold`) and the edit uses it.
//
// This file is the contract the engine and the page share: the words (weights, scripts, styles,
// test frames), the limits, the wire shapes (zod), the messages, and the small rules both sides
// need (a face's name, a family's slug, "9 weights", "Thin–Black", "14 jobs", the "New" tag). FN0
// owns it; later items only extend it, and say so in their hand-off.
//
// The files in `_Fonts` are the only truth: nothing here describes a database row, and nothing here
// renames or moves a file. A family is the name inside the font file, a face is a family plus a
// weight and upright/italic, and the face's name is what the owner types after `@`.

// --- weights -------------------------------------------------------------------------------------

/** The nine weights a face can have (the CSS numbers, from the file's OS/2 weight class). */
export const FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

/**
 * The word of each weight, taken from the number, never from the file's own subfamily text
 * ("Heavy" is Black). Regular (400) is the only weight with no word in a face's name.
 */
export const FONT_WEIGHT_NAMES: Readonly<Record<FontWeight, string>> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

/** A weight on the wire: 100 to 900 in steps of 100. The font reader rounds a file's weight to this. */
export const fontWeightSchema = z
  .number()
  .int()
  .min(100)
  .max(900)
  .refine((weight) => weight % 100 === 0, { message: 'A weight is 100, 200 … 900.' });

/**
 * A weight number as one of the nine: rounded to the nearest 100 and kept within 100–900 (a
 * variable font's 450 becomes 500, an OS/2 class of 1000 becomes 900, 0 becomes 100). Not a number
 * at all gives 400.
 */
export function normalizeFontWeight(weight: number): FontWeight {
  if (!Number.isFinite(weight)) return 400;
  return Math.min(900, Math.max(100, Math.round(weight / 100) * 100)) as FontWeight;
}

/** The word of a weight: 700 → "Bold" (the weight is first made one of the nine). */
export function fontWeightName(weight: number): string {
  return FONT_WEIGHT_NAMES[normalizeFontWeight(weight)];
}

// --- script, style, test frames ------------------------------------------------------------------

/**
 * The two scripts a family can have, as the page says them. Script is read from the font file (its
 * cmap covers U+05D0–U+05EA or not), never from a folder. The same words are the two folders
 * inside `_Fonts` where an import files a new family (`_Fonts/Hebrew + English/<Family>/`).
 */
export const FONT_SCRIPT_LABELS = {
  hebrew: 'Hebrew + English',
  english: 'English only',
} as const;

/** The script label of a family: `he` is true when its file has the Hebrew letters. */
export function fontScriptLabel(he: boolean): string {
  return he ? FONT_SCRIPT_LABELS.hebrew : FONT_SCRIPT_LABELS.english;
}

/** The styles a family is filed under. Shown, never used to decide anything. */
export const FONT_STYLES = [
  'Sans',
  'Serif',
  'Slab',
  'Rounded',
  'Condensed',
  'Display',
  'Handwriting',
] as const;
export const fontStyleSchema = z.enum(FONT_STYLES);
export type FontStyle = z.infer<typeof fontStyleSchema>;

/** The style a family not in {@link FONT_STYLE_BY_FAMILY} gets when its file has no usable panose. */
export const FONT_DEFAULT_STYLE: FontStyle = 'Sans';

/** The 40 families of the owner's `_Fonts` on 24 Oct 2026 and the style each is filed under. */
export const FONT_STYLE_BY_FAMILY: Readonly<Record<string, FontStyle>> = {
  Alef: 'Sans',
  'Amatic SC': 'Handwriting',
  Arimo: 'Sans',
  Assistant: 'Sans',
  Bellefair: 'Serif',
  'David Libre': 'Serif',
  'Frank Ruhl Libre': 'Serif',
  Fredoka: 'Rounded',
  'Google Sans': 'Sans',
  Heebo: 'Sans',
  'IBM Plex Sans Hebrew': 'Sans',
  'Noto Sans Hebrew': 'Sans',
  'Open Sans': 'Sans',
  Rubik: 'Sans',
  'Rubik Glitch': 'Display',
  'Rubik Spray Paint': 'Display',
  'Secular One': 'Display',
  'Suez One': 'Display',
  Tinos: 'Serif',
  'Varela Round': 'Rounded',
  'DM Sans': 'Sans',
  Inter: 'Sans',
  Lato: 'Sans',
  Manrope: 'Sans',
  Merriweather: 'Serif',
  Montserrat: 'Sans',
  'Noto Sans': 'Sans',
  Nunito: 'Rounded',
  'Nunito Sans': 'Sans',
  Oswald: 'Condensed',
  Outfit: 'Sans',
  'Playfair Display': 'Serif',
  'Plus Jakarta Sans': 'Sans',
  Poppins: 'Sans',
  Raleway: 'Sans',
  Roboto: 'Sans',
  'Roboto Condensed': 'Condensed',
  'Roboto Slab': 'Slab',
  Ubuntu: 'Sans',
  'Work Sans': 'Sans',
};

/**
 * How family names compare: in NFC, trimmed, with runs of spaces made one, in lower case. "Heebo",
 * "heebo" and "Heebo " are one family; so are a face name and what the owner typed after `@`.
 */
export function fontNameKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

const STYLE_BY_FAMILY_KEY: ReadonlyMap<string, FontStyle> = new Map(
  Object.entries(FONT_STYLE_BY_FAMILY).map(([family, style]) => [fontNameKey(family), style]),
);

/**
 * The style of a family in the hard-coded table of the 40 known ones (the name compares without
 * regard to case), or `null` when it is not listed. The caller then guesses from the file's OS/2
 * panose and falls back to {@link FONT_DEFAULT_STYLE}: `fontStyleFor(name) ?? panoseStyle ??
 * FONT_DEFAULT_STYLE`.
 */
export function fontStyleFor(family: string): FontStyle | null {
  return STYLE_BY_FAMILY_KEY.get(fontNameKey(family)) ?? null;
}

/**
 * The three test frames a font is shown on ("On a frame"): the same free Unsplash photos the LUTs
 * page uses, so these are the LUTs' frames under their own names (`/api/luts/frames`'s files in
 * `apps/server/assets/luts/frames/`), never a second copy.
 */
export const FONT_FRAMES = LUT_FRAMES;
export type FontFrame = LutFrame;
export const fontFrameSchema = z.enum(FONT_FRAMES);

/** The frame chips' words: Person, Street, Interior. */
export const FONT_FRAME_LABELS: Readonly<Record<FontFrame, string>> = LUT_FRAME_LABELS;

/**
 * Whose photo each frame is, as the page says it under the frame ("Photo: Benjamin Combs,
 * Unsplash"): person "Benjamin Combs, Unsplash", street "Nicholas Swanson, Unsplash", interior
 * "The Anchor, Unsplash".
 */
export const FONT_FRAME_CREDITS: Readonly<Record<FontFrame, string>> = LUT_FRAME_CREDITS;

/**
 * The sample copy of the page, the picker's caption card and the frame, word for word from the
 * approved design. The Hebrew lines are the real copy: keep them.
 */
export const FONT_SAMPLE_TEXT = {
  /** The big glyphs at the top of the specimen box (64 px). */
  glyphsEnglish: 'Aa',
  glyphsHebrew: 'אב',
  /** The two specimen lines (22 px). */
  lineEnglish: 'Every great edit starts with a cut',
  lineHebrew: 'כל עריכה טובה מתחילה בחיתוך',
  /** The caption "On a frame" and in the picker's card. */
  captionHebrew: 'ככה הכול התחיל',
  captionEnglish: 'That’s how it all started',
  /** A title on the Review frame. */
  titleHebrew: 'הבית ליד הים',
} as const;

// --- files and formats ---------------------------------------------------------------------------

/** The four formats of a font file the page reads. */
export const FONT_FORMATS = ['ttf', 'otf', 'woff', 'woff2'] as const;
export const fontFormatSchema = z.enum(FONT_FORMATS);
export type FontFormat = z.infer<typeof fontFormatSchema>;

/** The extensions of those formats, lower case with the dot: what an import accepts. */
export const FONT_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'] as const;

/** The `Content-Type` of `GET /api/fonts/file/:fileId` for each format. */
export const FONT_MIME_TYPES: Readonly<Record<FontFormat, string>> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/** The format of a font file by its name (the extension, without regard to case), or `null`. */
export function fontFormatOf(fileName: string): FontFormat | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = fileName.slice(dot).toLowerCase();
  const index = (FONT_EXTENSIONS as readonly string[]).indexOf(extension);
  return index < 0 ? null : (FONT_FORMATS[index] ?? null);
}

/** The multipart field of `POST /api/fonts/stage`: every file (a folder is many files) under it. */
export const FONT_STAGE_FIELD = 'files[]';

// --- limits --------------------------------------------------------------------------------------

/** Every limit of the feature, in one place. Bytes are binary (1 MB = 1024 × 1024 bytes). */
export const FONT_LIMITS = {
  /** One font file, in bytes. */
  fileMaxBytes: 30 * 1024 * 1024,
  /** Files in one import (a folder of fonts counts file by file). */
  filesPerImport: 400,
  /** All the files of one import together, in bytes. */
  stageMaxBytes: 400 * 1024 * 1024,
  /** How long an upload waits in the staging folder before it is reaped. */
  stageLifetimeMs: 60 * 60 * 1000,
  /** How long a family shows the "New" tag after it was added. */
  newTagMs: 30 * 60 * 1000,
  /** How long the "a note asked for a font you don't have" banner stays (build 2). */
  missingBannerMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/**
 * The font a Hebrew word keeps when the chosen font has no Hebrew letters. The edit prompts and the
 * video-use skill default to Heebo; the design's "Assistant" was a stand-in.
 */
export const HEBREW_FALLBACK_FONT = 'Heebo';

/** A family's slug (in a page address, `/fonts/heebo`): lower-case letters and digits joined by `-`. */
export const FONT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;

// --- a font on the wire --------------------------------------------------------------------------

/**
 * One face: a family plus a weight, upright or italic, in one file. `name` is what the owner types
 * after `@` ({@link faceName}); `fileId` is a hash of the file's path inside `_Fonts`, looked up in
 * the index only (`GET /api/fonts/file/:fileId`, a client never sends a path). A variable font's
 * named instances each carry the same `fileId`.
 */
export const fontFaceSchema = z.object({
  name: z.string().min(1),
  family: z.string().min(1),
  weight: fontWeightSchema,
  italic: z.boolean(),
  fileId: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  /** The file's format: the page names it in "9 TTF · 0.4 MB" and in the face's `@font-face`. */
  format: fontFormatSchema,
  /**
   * The file’s modified time in milliseconds, as text. The page puts it in the file’s address
   * (`?v=`) so the browser can keep the font for good and a replaced file is asked for again.
   * Optional so a face made without one (a test, an older event) still parses.
   */
  version: z.string().min(1).optional(),
});
/**
 * A face on the wire. (The plan calls it `FontFace`; that is also a global class of the browser,
 * which the page may use to load a specimen, so the type is named `FontFaceInfo`.)
 */
export type FontFaceInfo = z.infer<typeof fontFaceSchema>;

/**
 * One family as the list shows it (`GET /api/fonts`) and as `font.changed` carries it. Every field
 * is always present. `he` is true when the file has the Hebrew letters; `weights` is every weight
 * the family has, once each, lowest first; `weightsLabel` is "9 weights". `used` is how many jobs
 * used the family (distinct jobs) and `usedLabel` says so in words; `addedAt` is the earliest of
 * its files' modified times and `isNew` is true for {@link FONT_LIMITS}.newTagMs after that.
 */
export const fontFamilySummarySchema = z.object({
  slug: z.string().regex(FONT_SLUG_PATTERN),
  name: z.string().min(1),
  he: z.boolean(),
  style: fontStyleSchema,
  weights: z.array(fontWeightSchema).min(1),
  weightsLabel: z.string().min(1),
  used: z.number().int().nonnegative(),
  usedLabel: z.string().min(1),
  addedAt: isoTimestampSchema,
  isNew: z.boolean(),
});
export type FontFamilySummary = z.infer<typeof fontFamilySummarySchema>;

/**
 * One family with everything its pane shows (`GET /api/fonts/:slug`): the summary, one face per
 * weight (and italic), how many files the family has (`files`: different files, so a variable
 * font's instances count once), their bytes together, and how many jobs used it (`usedIn`, `null`
 * while the fontsInNotes switch is off: nothing records the use then, and the pane hides the row).
 */
export const fontFamilyDetailSchema = fontFamilySummarySchema.extend({
  faces: z.array(fontFaceSchema).min(1),
  files: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  usedIn: z.number().int().nonnegative().nullable(),
});
export type FontFamilyDetail = z.infer<typeof fontFamilyDetailSchema>;

/**
 * A note named a font the library does not have (build 2): "Demo · Horizon FPV asked for Gotham Bold".
 * `name` is as it was written, `round` is the review round of the note (0 = the edit's own brief),
 * `at` is when the note was read. The banner shows the requests newer than
 * {@link FONT_LIMITS}.missingBannerMs that nobody has imported since.
 */
export const fontRequestSchema = z.object({
  /** 12 hex characters. */
  id: z.string().min(1),
  name: z.string().min(1),
  jobId: z.string().min(1),
  jobName: z.string().min(1),
  round: z.number().int().nonnegative(),
  at: isoTimestampSchema,
});
export type FontRequest = z.infer<typeof fontRequestSchema>;

/**
 * `GET /api/fonts`: the families (A to Z), the catalog (every face of every family: what the `@`
 * picker and the note parser match against) and the open requests for a font that is not there.
 */
export const fontsListResponseSchema = z.object({
  families: z.array(fontFamilySummarySchema),
  catalog: z.array(fontFaceSchema),
  requests: z.array(fontRequestSchema),
});
export type FontsListResponse = z.infer<typeof fontsListResponseSchema>;

// --- import: stage, then import ------------------------------------------------------------------

/**
 * What the check says about one item of an upload: a family (the files are grouped by the family
 * inside them, folder and file names do not matter) or a file that is not a font.
 *   new       the family is not here yet
 *   adds      the family is here and these files add weights to it
 *   same      the family is here with the same weights and the same bytes: skipped
 *   conflict  the same face is here as a different file: that file is not imported
 *   bad       not a font; `info` says why
 */
export const FONT_STAGE_STATUSES = ['new', 'adds', 'same', 'conflict', 'bad'] as const;
export const fontStageStatusSchema = z.enum(FONT_STAGE_STATUSES);
export type FontStageStatus = z.infer<typeof fontStageStatusSchema>;

/**
 * One line of the import dialog (`POST /api/fonts/stage`). For a family `name` is its name, `files`
 * how many files of it were uploaded, `he` whether it has Hebrew, `weights` the weights uploaded and
 * `bytes` their size; for a `bad` item `name` is the file's name, `files` is 1, `he` false and
 * `weights` empty. `info` is the one plain sentence the dialog shows under the name.
 */
export const fontStageItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  files: z.number().int().positive(),
  he: z.boolean(),
  weights: z.array(fontWeightSchema),
  bytes: z.number().int().nonnegative(),
  status: fontStageStatusSchema,
  info: z.string().min(1),
});
export type FontStageItem = z.infer<typeof fontStageItemSchema>;

/** `POST /api/fonts/stage` answer: where the files wait, and one verdict per family or bad file. */
export const fontStageResponseSchema = z.object({
  stageId: z.string().min(1),
  items: z.array(fontStageItemSchema),
});
export type FontStageResponse = z.infer<typeof fontStageResponseSchema>;

/** `POST /api/fonts/import` body: the items to add, by id, from the stage. */
export const fontImportRequestSchema = z.object({
  stageId: z.string().min(1),
  items: z.array(z.string().min(1)).min(1).max(FONT_LIMITS.filesPerImport),
});
export type FontImportRequest = z.infer<typeof fontImportRequestSchema>;

/** `POST /api/fonts/import` answer: the families as they are now, and the items that could not be added. */
export const fontImportResponseSchema = z.object({
  imported: z.array(fontFamilySummarySchema),
  failed: z.array(z.object({ id: z.string().min(1), error: z.string().min(1) })),
});
export type FontImportResponse = z.infer<typeof fontImportResponseSchema>;

/** `DELETE /api/fonts/stage/:stageId`: the upload was thrown away. */
export const cancelFontStageResponseSchema = z.object({ ok: z.literal(true) });
export type CancelFontStageResponse = z.infer<typeof cancelFontStageResponseSchema>;

/**
 * `DELETE /api/fonts/requests/:id` (C52): "Not a font". The request is dismissed, and so is every
 * other open request of the same job for the same name; the bar moves on to the next request. The
 * same name for the same job is not asked again in a later round.
 */
export const dismissFontRequestResponseSchema = z.object({ ok: z.literal(true) });
export type DismissFontRequestResponse = z.infer<typeof dismissFontRequestResponseSchema>;

/** `POST /api/fonts/:slug/reveal`: Finder shows the family's folder. */
export const revealFontResponseSchema = z.object({ ok: z.literal(true) });
export type RevealFontResponse = z.infer<typeof revealFontResponseSchema>;

/**
 * `DELETE /api/fonts/:slug`: the whole family is gone from `_Fonts`. `where` is the folder its files
 * were moved to (the Trash). Jobs already made keep their own copy in `edit/fonts/`.
 */
export const deleteFontResponseSchema = z.object({
  ok: z.literal(true),
  where: z.string().min(1),
});
export type DeleteFontResponse = z.infer<typeof deleteFontResponseSchema>;

// --- uses ----------------------------------------------------------------------------------------

/**
 * Where a recorded use of a font face came from (the `font_uses` table, build 2): `token` is a note
 * that named it (`@Heebo Bold`), `composition` is a finished job whose compositions mention it.
 */
export const FONT_USE_SOURCES = ['token', 'composition'] as const;
export const fontUseSourceSchema = z.enum(FONT_USE_SOURCES);
export type FontUseSource = z.infer<typeof fontUseSourceSchema>;

// --- words ---------------------------------------------------------------------------------------

/**
 * The engine's words for every refusal of the Fonts API (`{ error }`) and every verdict of the
 * check, one plain sentence each ending in a period (the verdicts that depend on a number or a name
 * are functions). The status each goes with is in its comment.
 */
export const FONT_MESSAGES = {
  /** 404, every Fonts route while the Fonts switch is off. */
  off: 'Fonts are off.',
  /** 404, a slug the engine does not know (or a family that was deleted). */
  notFound: 'There is no such font.',
  /** 404, a file id the index does not know. */
  fileNotFound: 'There is no such font file.',
  /** 404, a request id the engine does not know (or one that is hidden while notes cannot name a font). */
  requestNotFound: 'There is no such request.',
  /** 404, a stage id the engine does not know (or one that was reaped). */
  stageNotFound: 'That upload is gone. Choose the files again.',
  /** 400, an import body or an upload that cannot be read. */
  badImport: 'The files could not be read. Choose them again.',
  /** 400, an import that names an item the stage does not have, or one that is not importable. */
  badImportItem: 'That font is not in the upload, or it cannot be imported.',
  /** 413, more than {@link FONT_LIMITS}.filesPerImport files at once. */
  tooManyFiles: `Import at most ${FONT_LIMITS.filesPerImport} font files at once.`,
  /** 413, more than {@link FONT_LIMITS}.stageMaxBytes in one upload. */
  stageTooLarge: 'The upload is too large: at most 400 MB at once.',
  /** The check: the file ends before its tables do. */
  cutShort: 'Not a font: the file is cut short.',
  /** The check: the first bytes are not those of a font file. */
  notFontFile: 'Not a font: it does not start like a font file.',
  /** The check: a .ttc / .otc collection. */
  collection: 'A font collection (.ttc) holds several fonts in one file. Export them one by one.',
  /** The check: a file over {@link FONT_LIMITS}.fileMaxBytes. */
  tooLarge: 'Too big: over 30 MB.',
  /** The check: a lone file whose extension is none of {@link FONT_EXTENSIONS}. */
  badExtension: 'Not a font: only .ttf, .otf, .woff and .woff2 files.',
  /** 404, the family's folder is not in `_Fonts` any more. */
  fileMissing: 'The font’s files are not in _Fonts any more.',
  /** 500, Finder could not be asked to show the folder. */
  revealFailed: 'Finder could not show the folder.',
  /** 500, the family's files could not be moved to the Trash. */
  deleteFailed: 'The font could not be moved to the Trash.',
  /** 500, the files could not be copied into `_Fonts`. */
  importFailed: 'The font could not be copied into _Fonts.',
} as const;

/** `fontSameMessage(9)` → "Already here with the same 9 weights. Skipped." (the verdict `same`). */
export function fontSameMessage(weights: number): string {
  return weights === 1
    ? 'Already here with the same weight. Skipped.'
    : `Already here with the same ${weightCountLabel(weights)}. Skipped.`;
}

/** `fontAddsMessage(2, 'Rubik')` → "Adds 2 weights to Rubik." (the verdict `adds`). */
export function fontAddsMessage(weights: number, family: string): string {
  return `Adds ${weightCountLabel(weights)} to ${family}.`;
}

/**
 * `fontConflictMessage('Rubik Bold')` → "You already have a different Rubik Bold. Delete it first to
 * replace it." (the verdict `conflict`; `face` is the face's name, {@link faceName}).
 */
export function fontConflictMessage(face: string): string {
  return `You already have a different ${face}. Delete it first to replace it.`;
}

/** "1 file", "3 files". */
export function fontFilesWord(files: number): string {
  return files === 1 ? '1 file' : `${files} files`;
}

/**
 * A size the way the page says it: one decimal under 10 MB with a floor of 0.1 ("0.2 MB", "0.1 MB"
 * for a small file, "7.3 MB"), whole megabytes from 10 up ("42 MB"). Binary megabytes.
 */
export function fontBytesLabel(bytes: number): string {
  const mb = Math.max(0, bytes) / (1024 * 1024);
  if (mb >= 10) return `${Math.round(mb)} MB`;
  return `${Math.max(0.1, Math.round(mb * 10) / 10).toFixed(1)} MB`;
}

/**
 * The verdict `new` ("3 files · Hebrew + English · 0.2 MB"): how many files, the script, the size.
 */
export function fontNewMessage(files: number, he: boolean, bytes: number): string {
  return `${fontFilesWord(files)} · ${fontScriptLabel(he)} · ${fontBytesLabel(bytes)}`;
}

/**
 * The "Files" fact of the pane ("9 TTF · 0.4 MB"): the number of different files, their format in
 * capitals (a family with two formats says "7 TTF + 2 OTF") and their size together.
 */
export function fontFilesLabel(
  faces: readonly Pick<FontFaceInfo, 'fileId' | 'format' | 'bytes'>[],
): string {
  const byFile = new Map<string, Pick<FontFaceInfo, 'format' | 'bytes'>>();
  for (const face of faces) byFile.set(face.fileId, face);
  const perFormat = new Map<FontFormat, number>();
  let bytes = 0;
  for (const { format, bytes: size } of byFile.values()) {
    perFormat.set(format, (perFormat.get(format) ?? 0) + 1);
    bytes += size;
  }
  const parts = FONT_FORMATS.filter((format) => perFormat.has(format)).map(
    (format) => `${perFormat.get(format)} ${format.toUpperCase()}`,
  );
  return `${parts.join(' + ')} · ${fontBytesLabel(bytes)}`;
}

// --- rules ---------------------------------------------------------------------------------------

/** Characters, not UTF-16 units: a Hebrew letter or an emoji counts once. */
function cutTo(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

/**
 * A face's name, what the owner types after `@`: the family alone for Regular upright ("Heebo"), else
 * the family plus the weight word and " Italic" for an italic ("Heebo Bold", "Merriweather
 * Italic", "Heebo Bold Italic"). The word comes from the weight number ({@link FONT_WEIGHT_NAMES}).
 */
export function faceName(family: string, weight: number, italic: boolean): string {
  const word = normalizeFontWeight(weight) === 400 ? '' : fontWeightName(weight);
  return [family, word, italic ? 'Italic' : ''].filter((part) => part !== '').join(' ');
}

/** A small stable hash (FNV-1a, 32 bits) as 8 hex characters: the name of a family with no Latin letters. */
function nameHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * A family's slug, its address on the page: the name in kebab-case ("IBM Plex Sans Hebrew" →
 * "ibm-plex-sans-hebrew"). Letters lose their accents, and anything that is not a letter or digit
 * of the Latin alphabet becomes a single "-". A name with none (a Hebrew family name) gets
 * `font-<6 hex characters of a hash of the name>`. At most 60 characters, so it always matches
 * {@link FONT_SLUG_PATTERN}. The slug is never typed in a note.
 */
export function familySlug(name: string): string {
  const slug = cutTo(
    name
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, ''),
    60,
  ).replace(/-+$/, '');
  return slug === '' ? `font-${nameHash(fontNameKey(name)).slice(0, 6)}` : slug;
}

/** The distinct weights, lowest first. */
function distinctWeights(weights: readonly number[]): number[] {
  return [...new Set(weights.map(normalizeFontWeight))].sort((a, b) => a - b);
}

/** "9 weights", "1 weight": a number of weights in words. */
export function weightCountLabel(count: number): string {
  return count === 1 ? '1 weight' : `${count} weights`;
}

/** "9 weights", "1 weight": how many different weights (an italic of the same weight is one). */
export function weightsLabel(weights: readonly number[]): string {
  return weightCountLabel(new Set(weights).size);
}

/**
 * The weights as the "Weights" fact says them: a single weight by its word ("Regular"), two or
 * three listed ("Regular, Bold", "Light, Regular, Bold"), more as a range ("Thin–Black", with an en
 * dash). Empty for no weights.
 */
export function weightRangeLabel(weights: readonly number[]): string {
  const sorted = distinctWeights(weights);
  if (sorted.length === 0) return '';
  const names = sorted.map(fontWeightName);
  if (names.length <= 3) return names.join(', ');
  return `${names[0]}–${names[names.length - 1]}`;
}

/** The "Used" column and fact: "14 jobs", "1 job", "Not used yet". */
export function fontUsedLabel(used: number): string {
  if (used <= 0) return 'Not used yet';
  return used === 1 ? '1 job' : `${used} jobs`;
}

/**
 * Whether a family added at `addedAt` still has its "New" tag at `now`: it was added within the
 * last {@link FONT_LIMITS}.newTagMs. A `null`, a time in the future or one that cannot be read is
 * not new.
 */
export function isNewFont(
  addedAt: string | null,
  now: Date | string | number = new Date(),
): boolean {
  if (addedAt === null) return false;
  const added = Date.parse(addedAt);
  const at = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (Number.isNaN(added) || Number.isNaN(at)) return false;
  const age = at - added;
  return age >= 0 && age < FONT_LIMITS.newTagMs;
}
