import { z } from 'zod';
import { clientStyleSchema } from './client.ts';
import { fontFamilySummarySchema } from './fonts.ts';
import { generateStateSchema } from './generate.ts';
import { graphicMessageSchema, graphicSummarySchema } from './graphics.ts';
import { jobSchema } from './job.ts';
import { lutSummarySchema } from './luts.ts';
import { musicViewSchema } from './music.ts';
import { quickFixSchema } from './quick-fixes.ts';
import { reviewNoteSchema } from './review-note.ts';
import { seriesSchema } from './series.ts';

/** Sent once when an SSE client connects. */
export const helloEventSchema = z.object({ type: z.literal('hello') });
export type HelloEvent = z.infer<typeof helloEventSchema>;

/** A job was created or changed: replace or insert it by `job.id`. */
export const jobUpsertEventSchema = z.object({ type: z.literal('job.upsert'), job: jobSchema });
export type JobUpsertEvent = z.infer<typeof jobUpsertEventSchema>;

/** A job is gone: drop it by `id`. */
export const jobRemoveEventSchema = z.object({
  type: z.literal('job.remove'),
  id: z.string().min(1),
});
export type JobRemoveEvent = z.infer<typeof jobRemoveEventSchema>;

/**
 * A client's style was created or changed. It carries the `GET /api/clients/:clientId/style`
 * answer without the markdown: the web app reloads that client's style when it arrives.
 */
export const clientUpsertEventSchema = z.object({
  type: z.literal('client.upsert'),
  style: clientStyleSchema,
});
export type ClientUpsertEvent = z.infer<typeof clientUpsertEventSchema>;

/**
 * A client folder appeared in the inbox, made in the app or in Finder: add it to the client list.
 * It says nothing about the client's jobs or style (`job.upsert` and `client.upsert` do).
 */
export const clientAddedEventSchema = z.object({
  type: z.literal('client.added'),
  clientId: z.string().min(1),
  client: z.string().min(1),
});
export type ClientAddedEvent = z.infer<typeof clientAddedEventSchema>;

/** A client folder is gone from the inbox: drop it from the client list by `clientId`. */
export const clientRemovedEventSchema = z.object({
  type: z.literal('client.removed'),
  clientId: z.string().min(1),
  client: z.string().min(1),
});
export type ClientRemovedEvent = z.infer<typeof clientRemovedEventSchema>;

/** A review note was created or changed (transcribed, edited, Add to style): replace or insert it by `note.id`. */
export const noteUpsertEventSchema = z.object({
  type: z.literal('note.upsert'),
  note: reviewNoteSchema,
});
export type NoteUpsertEvent = z.infer<typeof noteUpsertEventSchema>;

/** A note left the job's unsent notes: deleted, or sent with a round. */
export const noteRemoveEventSchema = z.object({
  type: z.literal('note.remove'),
  jobId: z.string().min(1),
  noteId: z.string().min(1),
});
export type NoteRemoveEvent = z.infer<typeof noteRemoveEventSchema>;

/**
 * The numbers of the Money page changed: a job was delivered, money.json was edited, or review time
 * was added. It carries nothing; the page loads `GET /api/money` again (query key ['money']).
 */
export const moneyChangedEventSchema = z.object({ type: z.literal('money.changed') });
export type MoneyChangedEvent = z.infer<typeof moneyChangedEventSchema>;

/**
 * A series was started or changed (a pass queued, installed or failed). It carries the
 * `GET /api/series/:seriesId` answer without the markdown: the web app reloads that series, and its
 * client's series list, when it arrives. A job joining or leaving a series is a `job.upsert`.
 */
export const seriesChangedEventSchema = z.object({
  type: z.literal('series.changed'),
  series: seriesSchema,
});
export type SeriesChangedEvent = z.infer<typeof seriesChangedEventSchema>;

/**
 * A series is gone (Undo of Start a series, or its folder was deleted): drop it by `seriesId`.
 * `clientId` says whose series list to load again. Its episodes follow as `job.upsert`s.
 */
export const seriesRemovedEventSchema = z.object({
  type: z.literal('series.removed'),
  seriesId: z.string().min(1),
  clientId: z.string().min(1),
});
export type SeriesRemovedEvent = z.infer<typeof seriesRemovedEventSchema>;

/**
 * A graphic was made, changed or moved on (Graphics plan): its status, step, version, name or
 * "Edits can use it" changed, or its chat got a message. It carries the list's summary and, when a
 * chat message changed, that message: the page writes both into its caches (the list and the
 * graphic's page) without asking again. A video that used the graphic (Graphics plan, build 2)
 * also carries `usedIn`, how many videos have used it now, which the summary has no room for.
 */
export const graphicChangedEventSchema = z.object({
  type: z.literal('graphic.changed'),
  graphic: graphicSummarySchema,
  message: graphicMessageSchema.optional(),
  usedIn: z.number().int().nonnegative().optional(),
});
export type GraphicChangedEvent = z.infer<typeof graphicChangedEventSchema>;

/** A graphic was deleted: drop it by `id` from the list, and its page shows it is gone. */
export const graphicRemovedEventSchema = z.object({
  type: z.literal('graphic.removed'),
  id: z.string().min(1),
});
export type GraphicRemovedEvent = z.infer<typeof graphicRemovedEventSchema>;

/**
 * A LUT was imported, renamed, re-kinded, duplicated or used by a job (LUTs plan): it carries the
 * list's summary, which the page writes into its caches (the list and the LUT's pane) without
 * asking again. Only sent while the LUTs switch is on.
 */
export const lutChangedEventSchema = z.object({
  type: z.literal('lut.changed'),
  lut: lutSummarySchema,
});
export type LutChangedEvent = z.infer<typeof lutChangedEventSchema>;

/** A LUT was deleted from Yours: drop it by `slug` from the list, and its pane shows it is gone. */
export const lutRemovedEventSchema = z.object({
  type: z.literal('lut.removed'),
  slug: z.string().min(1),
});
export type LutRemovedEvent = z.infer<typeof lutRemovedEventSchema>;

/**
 * A font family was added, got more weights, or was used by a job (Fonts plan): it carries the
 * list's summary, which the page writes into its caches (the list and the family's pane) without
 * asking again. Sent when the engine sees `_Fonts` change (an import, or files dropped in Finder).
 * Only sent while the Fonts switch is on.
 */
export const fontChangedEventSchema = z.object({
  type: z.literal('font.changed'),
  family: fontFamilySummarySchema,
});
export type FontChangedEvent = z.infer<typeof fontChangedEventSchema>;

/** A font family is gone (deleted, or its files left `_Fonts`): drop it by `slug` from the list. */
export const fontRemovedEventSchema = z.object({
  type: z.literal('font.removed'),
  slug: z.string().min(1),
});
export type FontRemovedEvent = z.infer<typeof fontRemovedEventSchema>;

/**
 * A note named a font the library does not have, and the request was added (Fonts plan, FN16; a
 * request already open for the same name, job and round sends nothing). It carries the name as it
 * was written and nothing else: the Fonts page asks for the list again, which has the job's name
 * and every other open request. Only sent while the Fonts and fontsInNotes switches are on.
 */
export const fontRequestedEventSchema = z.object({
  type: z.literal('font.requested'),
  name: z.string().min(1),
});
export type FontRequestedEvent = z.infer<typeof fontRequestedEventSchema>;

/**
 * The owner dismissed a request for a font ("Not a font", C52): it carries the id of the request he
 * pressed it on. Every other open request of the same job for the same name was dismissed with it,
 * so the Fonts page asks for the list again. Only sent while the Fonts and fontsInNotes switches
 * are on.
 */
export const fontRequestDismissedEventSchema = z.object({
  type: z.literal('font.request.dismissed'),
  id: z.string().min(1),
});
export type FontRequestDismissedEvent = z.infer<typeof fontRequestDismissedEventSchema>;

/**
 * A job's music changed (Soundtrack): a version started being made, was made or failed, a pick
 * changed, or an edit or revise run ended with new music. It carries the `GET /api/jobs/:id/music`
 * answer, which the page writes into its cache (['music', jobId]) as it is: `null` when the job
 * has no music.json (any more). Only sent while the Soundtrack switch is on.
 */
export const jobMusicEventSchema = z.object({
  type: z.literal('job.music'),
  jobId: z.string().min(1),
  music: musicViewSchema.nullable(),
});
export type JobMusicEvent = z.infer<typeof jobMusicEventSchema>;

/**
 * A quick fix was queued, started, moved on a step, or ended (fixed, escalated, failed, undone or
 * cancelled; quick fixes, QF0). It carries the fix as the server has it now: the page writes it
 * into the job's fixes (['fixes', jobId]) as it is, and the fix landing (`status: 'fixed'`) is
 * when the player reloads. Only sent while the `quickFixes` switch is on.
 */
export const jobFixEventSchema = z.object({
  type: z.literal('job.fix'),
  jobId: z.string().min(1),
  fix: quickFixSchema,
});
export type JobFixEvent = z.infer<typeof jobFixEventSchema>;

/**
 * A generated job's Generate stage moved on (Generated videos, GN0): a part started or finished, a
 * clip was kept, money was spent. It carries the state as the server has it now: the page writes it
 * into the job's generate query (['job-generate', jobId]) and into the cached job's `generate`.
 * Progress can be chatty, so the server sends it as it comes and the page keeps the last. Only
 * sent while the `generate` switch is on.
 */
export const jobGenerateEventSchema = z.object({
  type: z.literal('job.generate'),
  jobId: z.string().min(1),
  generate: generateStateSchema,
});
export type JobGenerateEvent = z.infer<typeof jobGenerateEventSchema>;

/**
 * A client's Instagram changed (Clients × Instagram): an account was added, changed or removed, a
 * scan started or ended, or a reel was linked to a job or unlinked. It carries nothing but whose:
 * the page loads that client's `GET /api/clients/:clientId/instagram` again (query key
 * ['client-instagram', clientId]). Only sent while the `instagram` switch is on.
 */
export const clientInstagramEventSchema = z.object({
  type: z.literal('client-instagram'),
  clientId: z.string().min(1),
});
export type ClientInstagramEvent = z.infer<typeof clientInstagramEventSchema>;

/**
 * Who may see what changed (Team plan, TM3): a person joined, left or changed role, or a client's
 * editors changed. It carries nothing; whoever is watching works out what it means for them. The
 * web app ignores it for now.
 */
export const accessChangedEventSchema = z.object({ type: z.literal('access.changed') });
export type AccessChangedEvent = z.infer<typeof accessChangedEventSchema>;

/** One message on `GET /api/events` (the `data:` line of each SSE frame, as JSON). */
export const serverEventSchema = z.discriminatedUnion('type', [
  helloEventSchema,
  jobUpsertEventSchema,
  jobRemoveEventSchema,
  clientUpsertEventSchema,
  clientAddedEventSchema,
  clientRemovedEventSchema,
  noteUpsertEventSchema,
  noteRemoveEventSchema,
  moneyChangedEventSchema,
  seriesChangedEventSchema,
  seriesRemovedEventSchema,
  graphicChangedEventSchema,
  graphicRemovedEventSchema,
  lutChangedEventSchema,
  lutRemovedEventSchema,
  fontChangedEventSchema,
  fontRemovedEventSchema,
  fontRequestedEventSchema,
  fontRequestDismissedEventSchema,
  jobMusicEventSchema,
  jobFixEventSchema,
  jobGenerateEventSchema,
  clientInstagramEventSchema,
  accessChangedEventSchema,
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
