import { z } from 'zod';
import { clientInstagramSummarySchema } from './instagram.ts';
import { isoTimestampSchema } from './job.ts';

/**
 * Where a client's style (`<inbox>/<Client>/_Style/style.md`) stands, in lifecycle order. A client
 * with no stored row is `none`; `analysing` while a style run is queued or running.
 */
export const CLIENT_STYLE_STATES = ['none', 'analysing', 'ready', 'failed'] as const;

export const clientStyleStateSchema = z.enum(CLIENT_STYLE_STATES);
export type ClientStyleState = z.infer<typeof clientStyleStateSchema>;

/** The two kinds of style run (Phase 2 plan §5): `read` makes it from files, `learn` from a finished job. */
export const STYLE_PASS_KINDS = ['read', 'learn'] as const;

/**
 * What an `analysing` client's style run is doing, for "Analysing N files" or "Learning from
 * <job>". A Read pass `create`s the first style.md, `add`s files to it or `replace`s it from new
 * files; a Learn pass, from a finished job, `create`s the first one, `merge`s the job's look into
 * it (every job that reaches ready) or `replace`s it (Use this look). `fileCount` is the Read
 * pass's new files (0 for a Learn pass); `jobId` and `job` name the Learn pass's job (`null` for a
 * Read pass).
 */
export const stylePassSummarySchema = z.object({
  kind: z.enum(STYLE_PASS_KINDS),
  mode: z.enum(['create', 'add', 'merge', 'replace']),
  fileCount: z.number().int().nonnegative(),
  jobId: z.string().min(1).nullable(),
  job: z.string().min(1).nullable(),
});
export type StylePassSummary = z.infer<typeof stylePassSummarySchema>;

/**
 * The style of one client, as the server sends it and the `client.upsert` event carries it (no
 * markdown). Every field is always present; "none" is `null`. `pass` is the one exception: the
 * server always sends it, but it is optional so that older stand-ins without it still parse.
 */
export const clientStyleSchema = z.object({
  /** Stable hash of the client folder name: the first 12 hex characters of sha1 (NFC). */
  clientId: z.string().min(1),
  /** The client folder's name, spelled as the file system lists it. */
  client: z.string().min(1),
  state: clientStyleStateSchema,
  /** 0 until a style exists; 1 for the first; +1 each time `style.md` is replaced. */
  version: z.number().int().nonnegative(),
  /** When the style last changed; `null` for a client that has no stored style yet. */
  updatedAt: isoTimestampSchema.nullable(),
  /** Why the latest style run failed ("Style stopped: ..."); only for `failed`. */
  error: z.string().min(1).nullable(),
  /** The job the current look was learned from; `null` for a style made from files. */
  sourceJobId: z.string().min(1).nullable(),
  /** The run queued or running while the client is `analysing`; `null` otherwise. */
  pass: stylePassSummarySchema.nullable().optional(),
});
export type ClientStyle = z.infer<typeof clientStyleSchema>;

/** `GET /api/clients/:clientId/style`: the style plus `style.md` itself, or `null` when it is not there. */
export const clientStyleResponseSchema = clientStyleSchema.extend({
  markdown: z.string().nullable(),
});
export type ClientStyleResponse = z.infer<typeof clientStyleResponseSchema>;

/** `POST /api/clients/:clientId/reveal`: Finder was asked to open the client's folder. */
export const revealClientResponseSchema = z.object({ ok: z.literal(true) });
export type RevealClientResponse = z.infer<typeof revealClientResponseSchema>;

/**
 * One client folder of the inbox, as `GET /api/clients` lists it (and `POST /api/clients` answers
 * with the new one): a folder directly in the inbox, with jobs or without. `jobs` counts the jobs
 * the engine knows for it and `lastJobAt` is the newest one's `addedAt` (`null` without jobs);
 * `style` is where its style stands (`none` and `null` until it has one). `instagram` is the
 * client's Instagram account in short (Clients × Instagram, L1): `null` for a client with none,
 * and left out altogether while the `instagram` switch is off.
 */
export const clientRowSchema = z.object({
  clientId: z.string().min(1),
  client: z.string().min(1),
  jobs: z.number().int().nonnegative(),
  lastJobAt: isoTimestampSchema.nullable(),
  style: z.object({
    state: clientStyleStateSchema,
    updatedAt: isoTimestampSchema.nullable(),
  }),
  instagram: clientInstagramSummarySchema.nullable().optional(),
});
export type ClientRow = z.infer<typeof clientRowSchema>;

/** `GET /api/clients`: one row per client folder, sorted by name. */
export const clientListResponseSchema = z.array(clientRowSchema);
export type ClientListResponse = z.infer<typeof clientListResponseSchema>;

/**
 * `POST /api/clients` body: the new client's name. The server trims it and writes it in Unicode
 * NFC; see {@link clientNameProblem} for what it refuses (400, with a plain message).
 */
export const createClientRequestSchema = z.object({ name: z.string() });
export type CreateClientRequest = z.infer<typeof createClientRequestSchema>;

/** `POST /api/clients`: the new client. */
export const createClientResponseSchema = clientRowSchema;
export type CreateClientResponse = z.infer<typeof createClientResponseSchema>;

/**
 * `PUT /api/clients/:clientId/name` body: the client's new name, checked as New client checks one
 * ({@link clientNameProblem}). Its folder, its exports and its jobs take the name.
 */
export const renameClientRequestSchema = z.object({ name: z.string() });
export type RenameClientRequest = z.infer<typeof renameClientRequestSchema>;

/**
 * `PUT /api/clients/:clientId/name`: the client under its new name. Its `clientId` is new (a hash
 * of the folder name), and so are its jobs' ids: the old ones are gone from the lists.
 */
export const renameClientResponseSchema = clientRowSchema;
export type RenameClientResponse = z.infer<typeof renameClientResponseSchema>;

/**
 * `DELETE /api/clients/:clientId`: the client is gone, with its jobs and their payments. Its folder
 * and its exports went to the Trash, or (`trashed` false, when macOS would not take them) to the
 * engine's `deleted-clients` folder.
 */
export const deleteClientResponseSchema = z.object({
  clientId: z.string().min(1),
  client: z.string().min(1),
  trashed: z.boolean(),
});
export type DeleteClientResponse = z.infer<typeof deleteClientResponseSchema>;

/** The longest client name, in characters. */
export const CLIENT_NAME_MAX_LENGTH = 80;

/** A client name as the server keeps it: trimmed and in Unicode NFC. */
export function normalizeClientName(name: string): string {
  return name.trim().normalize('NFC');
}

/** Control characters (NUL included) can't be in a folder name. */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Invisible and look-alike characters: format characters (zero-width space and joiner, the soft
 * hyphen, the byte order mark, direction marks), control characters, line and paragraph
 * separators, and every space that is not a plain one (no-break, ideographic, thin...). They would
 * make a second client that looks the same as another.
 */
const HIDDEN_CHARACTER = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]|[^\P{Zs} ]/u;

/**
 * Why a client name can't be used, in words for the person who typed it, or null when it can. The
 * name is checked as {@link normalizeClientName} leaves it: not empty, at most
 * {@link CLIENT_NAME_MAX_LENGTH} characters, no `/` or `:` (nor control characters), and not
 * starting with `.` or `_` (the inbox skips those folders), no invisible characters (zero-width
 * and other format characters, spaces other than a plain one) and no double spaces. Spaces at the
 * ends are trimmed by {@link normalizeClientName} first. Only a name being made is checked this
 * way; folders already in the inbox are read as they are. Whether the name is taken is up to the
 * server.
 */
export function clientNameProblem(name: string): string | null {
  const normalized = normalizeClientName(name);
  if (normalized === '') return 'Give the client a name.';
  if (Array.from(normalized).length > CLIENT_NAME_MAX_LENGTH) {
    return `A client name can have at most ${CLIENT_NAME_MAX_LENGTH} characters.`;
  }
  if (normalized.includes('/') || normalized.includes(':')) {
    return 'A client name can’t contain / or :.';
  }
  if (hasControlCharacter(normalized)) return 'A client name can’t contain control characters.';
  if (HIDDEN_CHARACTER.test(normalized)) return 'A client name can’t contain hidden characters.';
  if (normalized.includes('  ')) return 'A client name can’t have two spaces in a row.';
  if (normalized.startsWith('.') || normalized.startsWith('_')) {
    return 'A client name can’t start with . or _.';
  }
  return null;
}

/** The style of a client that has none: what the API says before any style run or `style.md` exists. */
export function noClientStyle(clientId: string, client: string): ClientStyle {
  return {
    clientId,
    client,
    state: 'none',
    version: 0,
    updatedAt: null,
    error: null,
    sourceJobId: null,
    pass: null,
  };
}
