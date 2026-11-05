// Who may call which route (Team plan, TM1). The scope guard (scope-guard.ts) looks every /api
// request up in this table. The admin passes everything; an editor passes only what a row lets
// through, so a route that is not in the table is closed to editors until someone writes its row
// ("new routes are safe by default"). route-policies.test.ts walks the routes the app really has
// and fails for any that has no row.
//
// The policies:
//
//   any       every viewer: the health check and /me.
//   filtered  the handler scopes its own answer (lists, the live stream, creating a client, the
//             push devices, which an editor owns only when they registered them); the guard lets
//             it through. TM2 did the filtering; every handler of these rows is tested for an
//             editor and for the admin.
//   job       the job named in the path (`:id` or `:jobId`) must belong to a client the viewer sees.
//   client    the client named in the path (`:clientId`) must be one the viewer sees.
//   series    the series named in the path (`:seriesId`) must belong to a client the viewer sees.
//   batch     the ids in the body (`body`) must all be in scope.
//   admin     the admin only (money, analytics, graphics, LUTs, fonts, Finder, delete).
//
// `body` lists ids in the JSON body that must be in scope as well as the path's (a job put into a
// series names the series in its body).
//
// Rows are matched on the path as Hono routes it: pattern segments are literals, `:name` (one
// segment), `:name{.+}` (the rest, at least one segment) or a closing `*` (the rest, maybe none).

import { JOB_ACTIONS, jobActionPath } from '@studio/shared';

export type Policy = 'any' | 'filtered' | 'admin' | 'job' | 'client' | 'series' | 'batch';

/** What a body field names. */
export type Subject = 'job' | 'client' | 'series';

export interface BodyCheck {
  field: string;
  subject: Subject;
  /** The field is an array of ids, each of which must be in scope. */
  many?: boolean;
  /** `null` (or a missing field) is fine, as in "take the job out of its series". */
  nullable?: boolean;
}

export interface RoutePolicy {
  /** An HTTP method as Hono has it, or `*` for every method (`app.all`). HEAD follows GET. */
  method: string;
  /** The full path, `/api/…`, as Hono registers it. */
  pattern: string;
  policy: Policy;
  body?: readonly BodyCheck[];
}

const row = (
  method: string,
  pattern: string,
  policy: Policy,
  body?: readonly BodyCheck[],
): RoutePolicy =>
  body === undefined ? { method, pattern, policy } : { method, pattern, policy, body };

const ids = (field: string): readonly BodyCheck[] => [{ field, subject: 'job', many: true }];

export const ROUTE_POLICIES: readonly RoutePolicy[] = [
  // --- everyone ------------------------------------------------------------------------------
  row('GET', '/api/health', 'any'),
  row('GET', '/api/me', 'any'),

  // --- the handler filters its own answer (TM2) ----------------------------------------------
  row('GET', '/api/jobs', 'filtered'),
  row('GET', '/api/clients', 'filtered'),
  // An editor's new client is assigned to them by the handler (TM0).
  row('POST', '/api/clients', 'filtered'),
  row('GET', '/api/events', 'filtered'),
  row('GET', '/api/deliveries/unpaid-without-job', 'filtered'),
  // Push: an editor registers and manages only their own phone (the handlers check the owner).
  row('GET', '/api/push/key', 'filtered'),
  row('POST', '/api/push/devices', 'filtered'),
  row('GET', '/api/push/devices/:id', 'filtered'),
  row('PUT', '/api/push/devices/:id', 'filtered'),
  row('DELETE', '/api/push/devices/:id', 'filtered'),
  row('POST', '/api/push/devices/:id/test', 'filtered'),

  // --- a job -----------------------------------------------------------------------------------
  ...JOB_ACTIONS.map((action) => row('POST', `/api/jobs/:id/${jobActionPath(action)}`, 'job')),
  row('PUT', '/api/jobs/:id/note', 'job'),
  // The note view and its attached pictures (Songs, SG5); with Songs off there are no such routes.
  row('GET', '/api/jobs/:id/note', 'job'),
  row('POST', '/api/jobs/:id/note/attachments', 'job'),
  row('DELETE', '/api/jobs/:id/note/attachments/:name', 'job'),
  row('GET', '/api/jobs/:id/note/attachments/:name', 'job'),
  // The file without the song, the second export (Songs, SG8); with Songs off there is no such route.
  row('GET', '/api/jobs/:id/no-song', 'job'),
  row('POST', '/api/jobs/:id/no-song', 'job'),
  row('PUT', '/api/jobs/:id/effort', 'job'),
  // Renames the video: its folder and export move to the new name. An editor renames their own clients' videos.
  row('PUT', '/api/jobs/:id/name', 'job'),
  // Review's own effort, Auto by default (Quick fixes, QF4); 404 while the switch is off.
  row('PUT', '/api/jobs/:id/review-effort', 'job'),
  row('POST', '/api/jobs/:id/review-time', 'job'),
  row('GET', '/api/jobs/:id/download', 'job'),
  row('DELETE', '/api/jobs/:id', 'admin'),
  row('POST', '/api/jobs/:id/reveal', 'admin'),
  row('GET', '/api/jobs/:id/steps', 'job'),
  row('GET', '/api/jobs/:id/sent-notes', 'job'),
  row('GET', '/api/jobs/:id/stock', 'job'),
  row('GET', '/api/jobs/:id/reel', 'job'),
  // The live preview and what Review exports.
  row('GET', '/api/jobs/:id/preview/:path{.+}', 'job'),
  // An extra format's composition (Formats, GN7): the same files under the format's id.
  row('GET', '/api/jobs/:id/preview/:format/:path{.+}', 'job'),
  row('GET', '/api/jobs/:id/preview-poster', 'job'),
  row('GET', '/api/jobs/:id/preview-video', 'job'),
  row('GET', '/api/jobs/:id/preview-video.mp4', 'job'),
  // The look on the paused frame in Review (LU11).
  row('GET', '/api/jobs/:id/review/frame', 'job'),
  // The earlier versions kept for a job (VE1): look at one, go back to it.
  row('GET', '/api/jobs/:id/versions', 'job'),
  row('POST', '/api/jobs/:id/versions/:n/restore', 'job'),
  row('GET', '/api/jobs/:id/versions/:n/preview/:path{.+}', 'job'),
  row('POST', '/api/jobs/:id/review-export', 'job'),
  row('GET', '/api/jobs/:id/review-export', 'job'),
  row('GET', '/api/jobs/:id/review-export.mp4', 'job'),
  // Review notes.
  row('GET', '/api/jobs/:id/notes', 'job'),
  row('POST', '/api/jobs/:id/notes', 'job'),
  row('POST', '/api/jobs/:id/notes/voice', 'job'),
  row('PATCH', '/api/jobs/:id/notes/:noteId', 'job'),
  row('DELETE', '/api/jobs/:id/notes/:noteId', 'job'),
  row('GET', '/api/jobs/:id/notes/:noteId/audio', 'job'),
  // Use this look, and the still of a finished job.
  row('POST', '/api/jobs/:id/use-look', 'job'),
  row('GET', '/api/jobs/:id/still', 'job'),
  // Soundtrack, on or off (off, the handlers are `app.all`).
  row('GET', '/api/jobs/:id/music', 'job'),
  row('POST', '/api/jobs/:id/music', 'job'),
  row('PUT', '/api/jobs/:id/music/pick', 'job'),
  row('*', '/api/jobs/:id/music', 'job'),
  row('*', '/api/jobs/:id/music/*', 'job'),
  // The job's chat, on or off (off, the handlers are `app.all`): the feed and its pictures (Draft & chat, DR3).
  row('GET', '/api/jobs/:id/feed', 'job'),
  row('GET', '/api/jobs/:id/feed/img/:name', 'job'),
  row('*', '/api/jobs/:id/feed', 'job'),
  row('*', '/api/jobs/:id/feed/*', 'job'),
  // Quick fixes, on or off (off, the handlers are `app.all`): the list, Undo and Compare (QF3).
  row('GET', '/api/jobs/:id/fixes', 'job'),
  row('POST', '/api/jobs/:id/fixes/:fixId/undo', 'job'),
  row('GET', '/api/jobs/:id/fixes/:fixId/compare/:file', 'job'),
  row('*', '/api/jobs/:id/fixes', 'job'),
  row('*', '/api/jobs/:id/fixes/*', 'job'),
  // The Generate stage of a generated video (GN0); with Generate off there is no such route.
  row('GET', '/api/jobs/:id/generate', 'job'),
  // What the Generate stage did, for the sheet's History (GN5).
  row('GET', '/api/jobs/:id/generate/history', 'job'),
  // The clips and voice lines Review hints a note with (GN8).
  row('GET', '/api/jobs/:id/generate/review-plan', 'job'),
  // Delivered (money: Mark delivered and Mark paid are admin only), and the series a job is in.
  row('POST', '/api/jobs/:id/deliver', 'admin'),
  row('POST', '/api/jobs/:id/undeliver', 'admin'),
  row('POST', '/api/jobs/:jobId/series', 'job'),
  row('PUT', '/api/jobs/:jobId/series', 'job', [
    { field: 'seriesId', subject: 'series', nullable: true },
  ]),

  // --- many jobs at once: every id counts ------------------------------------------------------
  row('POST', '/api/jobs/archive', 'batch', ids('ids')),
  row('POST', '/api/jobs/unarchive', 'batch', ids('ids')),
  row('POST', '/api/payments', 'admin'),
  row('POST', '/api/payments/undo', 'admin'),

  // --- a client ----------------------------------------------------------------------------------
  row('GET', '/api/clients/:clientId/style', 'client'),
  row('POST', '/api/clients/:clientId/style/files', 'client'),
  row('POST', '/api/clients/:clientId/style/retry', 'client'),
  row('POST', '/api/clients/:clientId/style/undo', 'client'),
  row('POST', '/api/clients/:clientId/reveal', 'admin'),
  // Renames the client: its folder, its exports and every job of it move to the new name.
  row('PUT', '/api/clients/:clientId/name', 'admin'),
  // Deletes the client: its folders go to the Trash, its jobs and their payments are deleted.
  row('DELETE', '/api/clients/:clientId', 'admin'),
  row('GET', '/api/clients/:clientId/series', 'client'),
  // The client's Instagram, its scan and its photo (Clients × Instagram, IG0), on or off (off, the
  // handlers are `app.all`). An editor reaches the ones of their own clients, as the style page.
  row('GET', '/api/clients/:clientId/instagram', 'client'),
  row('PUT', '/api/clients/:clientId/instagram', 'client'),
  row('DELETE', '/api/clients/:clientId/instagram', 'client'),
  row('POST', '/api/clients/:clientId/instagram/scan', 'client'),
  row('GET', '/api/clients/:clientId/photo', 'client'),
  row('*', '/api/clients/:clientId/instagram', 'client'),
  row('*', '/api/clients/:clientId/instagram/*', 'client'),
  row('*', '/api/clients/:clientId/photo', 'client'),
  // Linking a reel to a job turns the job Uploaded, a step of its delivery: the rule of Mark delivered.
  row('POST', '/api/instagram/reels/:shortcode/link', 'admin'),
  row('DELETE', '/api/instagram/reels/:shortcode/link', 'admin'),
  row('*', '/api/instagram/*', 'admin'),

  // --- a series ----------------------------------------------------------------------------------
  row('GET', '/api/series/:seriesId', 'series'),
  row('POST', '/api/series/:seriesId/format', 'series', [{ field: 'jobId', subject: 'job' }]),
  row('POST', '/api/series/:seriesId/undo', 'series'),
  row('POST', '/api/series/:seriesId/retry', 'series'),

  // --- the admin only ----------------------------------------------------------------------------
  row('GET', '/api/money', 'admin'),
  row('GET', '/api/money/price', 'admin'),
  row('GET', '/api/analytics', 'admin'),
  row('*', '/api/graphics', 'admin'),
  row('*', '/api/graphics/*', 'admin'),
  row('*', '/api/luts', 'admin'),
  row('*', '/api/luts/*', 'admin'),
  row('*', '/api/fonts', 'admin'),
  row('*', '/api/fonts/*', 'admin'),
  // The Instagram DMs page: the admin's own DMs.
  row('GET', '/api/dms', 'admin'),
  row('POST', '/api/dms/check', 'admin'),
  row('GET', '/api/dms/file/:name', 'admin'),
  row('POST', '/api/dms/:id/reveal', 'admin'),
  // The feature switches and the engine restart (Settings page).
  row('*', '/api/settings', 'admin'),
  row('*', '/api/settings/*', 'admin'),
];

/**
 * Routes of the plan that other items add (TM3's team API). Their rows are here so that those
 * routes are closed to editors from the day they exist; the stale-row test allows them to be
 * missing from an app that does not have them yet.
 */
export const PLANNED_ROUTES: readonly RoutePolicy[] = [
  row('*', '/api/team', 'admin'),
  row('*', '/api/team/*', 'admin'),
  row('PUT', '/api/clients/:id/assignees', 'admin'),
];
