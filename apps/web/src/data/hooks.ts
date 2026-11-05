// The React side of the data layer: thin hooks over the testable cores next to them.

import {
  type AnalyticsPeriod,
  type JobAction,
  type JobActionOptions,
  withFolderDeleted,
} from '@studio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { analyticsQueryOptions } from './analytics-query';
import { api } from './api';
import { archiveJobsMutationOptions, unarchiveJobsMutationOptions } from './archive-jobs';
import { type ClientPhotoSources, clientPhotoSources, NO_CLIENT_PHOTOS } from './client-photos';
import { applyClientStyle, clientStyleQueryOptions } from './client-style';
import { clientsQueryOptions, createClientMutationOptions } from './clients-query';
import {
  deliverJobMutationOptions,
  markPaidMutationOptions,
  undeliverJobMutationOptions,
  undoPaidMutationOptions,
} from './delivery-mutations';
import {
  analyticsEnabled,
  dmsEnabled,
  draftChatEnabled,
  healthQueryOptions,
  instagramEnabled,
  jobSheetEnabled,
  phoneEnabled,
  quickFixesEnabled,
} from './health-query';
import { jobActionMutationOptions } from './job-action';
import { createJobEventsClient, engineLink } from './job-events';
import { jobFeedQueryOptions } from './job-feed';
import { jobStepsQueryOptions } from './job-steps';
import { jobStockQueryOptions } from './job-stock';
import { jobVersionsQueryOptions, restoreJobVersionMutationOptions } from './job-versions';
import { jobsQueryOptions } from './jobs-query';
import { applyLookMutationOptions, undoClientStyleMutationOptions } from './look-mutations';
import { meQueryOptions, readRememberedRole, rememberRole } from './me-query';
import { moneyPriceQueryOptions, moneyQueryOptions } from './money-query';
import {
  addNoteMutationOptions,
  addVoiceNoteMutationOptions,
  deleteNoteMutationOptions,
  patchNoteMutationOptions,
} from './note-mutations';
import { notesQueryOptions } from './notes-query';
import { orphanDeliveriesQueryOptions } from './orphan-deliveries';
import { revealJobMutationOptions } from './reveal-job';
import { saveEffortMutationOptions } from './save-effort';
import { saveNoteMutationOptions } from './save-note';
import { sentNotesQueryOptions } from './sent-notes';
import { setReviewEffortMutationOptions } from './set-review-effort';

/** The full job list (`['jobs']`). `data` is `undefined` until the first answer. */
export function useJobs() {
  return useQuery(jobsQueryOptions(api));
}

/**
 * The delivered videos whose folder is gone and that are not paid yet (`['orphan-deliveries']`).
 * `data` is `undefined` until the first answer. Kept current by the `money.changed` and
 * `job.remove` events.
 */
export function useOrphanDeliveries() {
  return useQuery(orphanDeliveriesQueryOptions(api));
}

/**
 * The jobs the Jobs page lists: the job list, and after it the unpaid videos whose folder is gone
 * (CVP-204), each as a job marked `folderDeleted`. They are still payable, so they sit under
 * Delivered (and All) like any delivered video. `data` is `undefined` until the job list has
 * arrived; the videos without a folder join it when their list does, and a failure to load that
 * list leaves them out without hiding the jobs. `isError`, `failureCount` and `refetch` are the job
 * list's.
 */
export function useListedJobs() {
  const jobs = useJobs();
  const orphans = useOrphanDeliveries();
  const data = useMemo(
    () => (jobs.data === undefined ? undefined : withFolderDeleted(jobs.data, orphans.data ?? [])),
    [jobs.data, orphans.data],
  );
  return { data, isError: jobs.isError, failureCount: jobs.failureCount, refetch: jobs.refetch };
}

/**
 * Every client folder of the inbox (`['clients']`), with jobs or without. `data` is `undefined`
 * until the first answer. Kept current by the job, client and style events.
 */
export function useClients() {
  return useQuery(clientsQueryOptions(api));
}

/**
 * The Instagram picture of every client that has one, by name (`clientPhotoSources`): empty while
 * the switch is off (the client list is not even asked for then, so a page that has no use for the
 * list does not load it) and until the list is in. Kept current by the client list's own events.
 */
export function useClientPhotos(): ClientPhotoSources {
  const on = useInstagramEnabled();
  const { data } = useQuery({ ...clientsQueryOptions(api), enabled: on });
  return useMemo(() => (on ? clientPhotoSources(data) : NO_CLIENT_PHOTOS), [on, data]);
}

/**
 * Whether the client has an Instagram account a scan can read (the client list's `instagram`, a
 * private account does not count): false while the switch is off, until the list is in, and while
 * `enabled` is false (nothing is asked then, so a sheet that has no use for the answer does not
 * load the list).
 */
export function useClientHasInstagram(
  clientId: string,
  { enabled = true }: { enabled?: boolean } = {},
): boolean {
  const on = useInstagramEnabled();
  const { data } = useQuery({ ...clientsQueryOptions(api), enabled: on && enabled });
  const instagram = data?.find((row) => row.clientId === clientId)?.instagram;
  return on && instagram != null && instagram.private !== true;
}

/**
 * "New client" as a mutation: `const create = useCreateClient(); await create.mutateAsync(name)`.
 * It resolves with the new client's row (already in the client list); a refusal is an `ApiError`
 * whose `message` is the server's reason (400) or says the name is taken (409).
 */
export function useCreateClient() {
  const queryClient = useQueryClient();
  return useMutation(createClientMutationOptions({ queryClient, api }));
}

/**
 * What the Money page shows for `month` (YYYY-MM): banners, ledger, subscriptions and expenses
 * (`['money', month]`). `data` is `undefined` until the first answer; while another month loads,
 * the month that was on screen stays in `data` (check `data.month`). Kept current by the
 * `money.changed` event.
 */
export function useMoney(month: string) {
  return useQuery(moneyQueryOptions(api, month));
}

/**
 * What Mark delivered would charge `client` now, and the month it would count in
 * (`['money', 'price', client]`), while `enabled`. Asked again on a `money.changed` event.
 */
export function useMoneyPrice(client: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...moneyPriceQueryOptions(api, client), enabled });
}

/** The server's health answer (`['health']`): its settle delay. `data` is `undefined` until it is in. */
export function useHealth() {
  return useQuery(healthQueryOptions(api));
}

/**
 * Who is asking (`['me']`, `GET /api/me`): their login, name and role. `data` is `undefined` until
 * the answer is in, and stays so for an engine that cannot give it; nothing admin-only is shown
 * then. The admin sees everything; an editor only their assigned clients (the server enforces it;
 * the web hides what it would refuse).
 */
export function useMe() {
  return useQuery(meQueryOptions(api));
}

/**
 * The viewer's role: the engine's answer once it is in, and until then the role the last answer
 * gave in this browser (so the owner's screen does not flicker on a reload). `null` when neither is
 * known, which shows nothing admin-only.
 */
export function useViewerRole(): 'admin' | 'editor' | null {
  const me = useMe();
  // Read once, as the page opens: later answers come through `me.data`.
  const [remembered] = useState(() => readRememberedRole());
  const role = me.data?.role;
  useEffect(() => {
    if (role !== undefined) rememberRole(role);
  }, [role]);
  return role ?? remembered;
}

/**
 * Whether the viewer is the admin (the owner): false while it is not known (and for an editor), so a
 * page that has not heard yet shows nothing admin-only. Every admin-only part of the web asks this.
 */
export function useIsAdmin(): boolean {
  return useViewerRole() === 'admin';
}

/**
 * Whether the Job sheet is on (`/api/health`): false until the answer is in, so a page that has
 * not heard yet behaves as before the sheet: rows open nothing and `?job=` is ignored.
 */
export function useJobSheetEnabled(): boolean {
  return jobSheetEnabled(useHealth().data);
}

/**
 * Whether Quick fixes are on (`/api/health`): false until the answer is in, so a page that has not
 * heard yet is today's app: the Effort menus in Review have no Auto and the row's Effort ▸ keeps
 * the edit's levels.
 */
export function useQuickFixesEnabled(): boolean {
  return quickFixesEnabled(useHealth().data);
}

/**
 * Whether Draft & chat is on (`/api/health`): false until the answer is in, so a page that has not
 * heard yet is today's app: Review has its notes column.
 */
export function useDraftChatEnabled(): boolean {
  return draftChatEnabled(useHealth().data);
}

/**
 * Whether Clients × Instagram is on (`/api/health`): false until the answer is in, so a page that
 * has not heard yet is today's app: no Instagram section, menu items or photo avatars.
 */
export function useInstagramEnabled(): boolean {
  return instagramEnabled(useHealth().data);
}

/** Whether the engine has the Instagram DMs page (`/api/health`): false until the answer is in. */
export function useDmsEnabled(): boolean {
  return dmsEnabled(useHealth().data);
}

/**
 * Whether Analytics is on (`/api/health`): false until the answer is in, so a page that has not
 * heard yet behaves as before Analytics: the sidebar item is the disabled one.
 */
export function useAnalyticsEnabled(): boolean {
  return analyticsEnabled(useHealth().data);
}

/**
 * What the Analytics page shows for `period` (`['analytics', period]`): the Jobs tiles and charts,
 * a typical job, Reviews and Claude use. `data` is `undefined` until the first answer; while the
 * other period loads, the page that was on screen stays in `data` (check `data.period`). Kept
 * current by the job events and `money.changed`, a moment after they arrive. Only the page asks,
 * and only while the switch is on.
 */
export function useAnalytics(period: AnalyticsPeriod) {
  return useQuery(analyticsQueryOptions(api, period));
}

/**
 * Whether the Phone switch is on (`/api/health`): false until the answer is in, so a page that has
 * not heard yet is today's app. Phone components do not read this; they read `usePhoneLayout()`,
 * which adds the width.
 */
export function usePhoneEnabled(): boolean {
  return phoneEnabled(useHealth().data);
}

/**
 * Keeps the jobs cache live from `GET /api/events`. Mount it once, in App; it renders nothing.
 * The connection closes when the component unmounts. It also tells {@link useEngineReconnecting}
 * whether the engine can be reached.
 */
export function useJobEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const client = createJobEventsClient({
      queryClient,
      eventSourceFactory: (url) => new EventSource(url),
      link: engineLink,
      onUnreadableEvent: (error) => console.warn('Ignored an unreadable server event', error),
    });
    client.start();
    return () => client.stop();
  }, [queryClient]);
}

/**
 * `true` once the engine has been out of reach for about two seconds (the event stream broke or
 * the list cannot be fetched), until it answers again. A shorter break never shows. Whether to say
 * so is up to the caller: with no list on screen the page already says "Can't reach the engine."
 */
export function useEngineReconnecting(): boolean {
  return useSyncExternalStore(engineLink.subscribe, engineLink.isReconnecting, () => false);
}

/**
 * One job action as a mutation: `const hold = useJobAction('hold'); hold.mutate(job.id)`.
 * The job changes state at once and is put back if the server refuses; `hold.error` is an
 * `ApiError` whose `message` is the server's explanation, ready to show.
 *
 * Also keeps the server's settle delay loaded (`useHealth`), which the instant Release needs; one
 * request is shared by every row, and until it is in the 60 s default is used.
 *
 * `options.restorePlace` makes a Release put a job that was queued when it was held back at its
 * place in line, not at the back of it (the note dialog's release; see `JobActionOptions`).
 */
export function useJobAction(action: JobAction, options: JobActionOptions = {}) {
  const queryClient = useQueryClient();
  useHealth();
  return useMutation(jobActionMutationOptions({ queryClient, api, action, ...options }));
}

/**
 * Mark delivered as a mutation: `const deliver = useDeliverJob(); await deliver.mutateAsync(job.id)`.
 * It resolves with the job, now with its `delivery` (already in the jobs cache); a refusal is an
 * `ApiError` whose `message` is the server's explanation (409: the job is not ready, or was
 * already delivered), ready to show.
 */
export function useDeliverJob() {
  const queryClient = useQueryClient();
  return useMutation(deliverJobMutationOptions({ queryClient, api }));
}

/**
 * Not delivered yet as a mutation: `await undeliver.mutateAsync(job.id)`. It resolves with the job,
 * back to approved; a refusal is an `ApiError` (409: it is not delivered, or it is paid).
 */
export function useUndeliverJob() {
  const queryClient = useQueryClient();
  return useMutation(undeliverJobMutationOptions({ queryClient, api }));
}

/**
 * Not paid yet as a mutation, for one job: `await unpay.mutateAsync(job.id)`. It resolves with the
 * jobs the server changed (that one, delivered again); a refusal is an `ApiError` (409: it is not
 * paid).
 */
export function useUndoPaid() {
  const queryClient = useQueryClient();
  return useMutation(undoPaidMutationOptions({ queryClient, api }));
}

/**
 * Mark paid as a mutation: `await pay.mutateAsync({ jobIds, paidOn })`, where `paidOn` is the
 * calendar day (`YYYY-MM-DD`) the money came in. It resolves with the jobs, now paid, in the order
 * asked (already in the jobs cache); a refusal is an `ApiError` whose `message` is the server's
 * explanation (409: one of the videos is not delivered, or is paid already; nothing changed).
 */
export function useMarkPaid() {
  const queryClient = useQueryClient();
  return useMutation(markPaidMutationOptions({ queryClient, api }));
}

/**
 * Saves a job's note as a mutation: `const save = useSaveNote(); await save.mutateAsync({ id, note })`.
 * It resolves with the job the server answers with (already in the jobs cache); a refusal is an
 * `ApiError` whose `message` is the server's explanation (409: "Cannot edit the note of a job that
 * is editing."), ready to show.
 */
export function useSaveNote() {
  const queryClient = useQueryClient();
  return useMutation(saveNoteMutationOptions({ queryClient, api }));
}

/**
 * Archives jobs as a mutation: `const archive = useArchiveJobs(); archive.mutate(ids)` (1 to 200
 * ids). It resolves with the jobs the server answers with, in the order asked (already in the jobs
 * cache, each where it stood: archiving does not move `updatedAt`). All or nothing: a refusal is an
 * `ApiError` whose `message` is the server's explanation (409: `Can't archive "Spring menu" while
 * it is editing.`), ready to show, and no job changed.
 */
export function useArchiveJobs() {
  const queryClient = useQueryClient();
  return useMutation(archiveJobsMutationOptions({ queryClient, api }));
}

/**
 * Takes jobs out of the archive as a mutation: `const unarchive = useUnarchiveJobs();
 * unarchive.mutate(ids)`. It resolves with the jobs the server answers with, in the order asked
 * (already in the jobs cache). All or nothing, like {@link useArchiveJobs}.
 */
export function useUnarchiveJobs() {
  const queryClient = useQueryClient();
  return useMutation(unarchiveJobsMutationOptions({ queryClient, api }));
}

/**
 * Sets a job's effort level as a mutation: `const save = useSaveEffort(); save.mutate({ id, effort })`
 * (`effort: null` is Default). It resolves with the job the server answers with (already in the
 * jobs cache); a refusal is an `ApiError` whose `message` is the server's explanation (409:
 * "Cannot change the effort of a job that is editing."), ready to show.
 */
export function useSaveEffort() {
  const queryClient = useQueryClient();
  return useMutation(saveEffortMutationOptions({ queryClient, api }));
}

/**
 * Sets the effort of a job's review rounds as a mutation (Quick fixes):
 * `const set = useSetReviewEffort(job.id); set.mutate(effort)` (`effort: null` is Auto). The job
 * in the cache shows the new level at once. If the server refuses (409: the job is not in
 * Review) the old level comes back and a toast, "Could not change the effort", says why in the
 * server's words.
 */
export function useSetReviewEffort(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation(
    setReviewEffortMutationOptions({ queryClient, api, jobId, notify: toast.error }),
  );
}

/**
 * A job's unsent review notes (`['notes', jobId]`), by atSec. Turn it off with `{ enabled: false }`
 * while the job is not in Review (every notes route answers 409 then). `data` is `undefined` until
 * the first answer.
 */
export function useNotes(jobId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...notesQueryOptions(api, jobId), enabled });
}

/**
 * A job's timed step runs (`['job-steps', jobId]`), oldest first: `data` is `{ jobId, runs }`,
 * `undefined` until the first answer. Only the open job sheet asks: pass `{ enabled: false }`
 * otherwise. A change of the job (`job.upsert`) invalidates it, so an open sheet reads it again
 * and a closed one does not. An unknown job is an `ApiError` with status 404.
 */
export function useJobSteps(jobId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...jobStepsQueryOptions(api, jobId), enabled });
}

/**
 * A job's preview versions (`['job-versions', jobId]`), newest first: `data` is `{ versions }`,
 * `undefined` until the first answer. Only the open job sheet asks: pass `{ enabled: false }`
 * otherwise. A change of the job (`job.upsert`: a run ended in Review, a restore) invalidates it,
 * so an open sheet reads it again and a closed one does not. An unknown job is an `ApiError` with
 * status 404.
 */
export function useJobVersions(jobId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...jobVersionsQueryOptions(api, jobId), enabled });
}

/**
 * Goes back to an earlier cut as a mutation: `restore.mutate({ id, n })`. It resolves with the job
 * the server answers with (already in the jobs cache); a refusal is an `ApiError` whose `message`
 * is the server's explanation (409: "Only a job in Review can go back to an earlier cut."), ready
 * to show.
 */
export function useRestoreJobVersion() {
  const queryClient = useQueryClient();
  return useMutation(restoreJobVersionMutationOptions({ queryClient, api }));
}

/**
 * The review notes a job's rounds were sent with (`['sent-notes', jobId]`), by round: `data` is
 * `{ jobId, notes }`, `undefined` until the first answer. Unlike `useNotes` (the unsent notes,
 * Review only) it answers in every state of the job. Only the open job sheet asks: pass
 * `{ enabled: false }` otherwise. A change of the job (`job.upsert`, which Send notes causes)
 * invalidates it, so an open sheet reads it again and a closed one does not. An unknown job is an
 * `ApiError` with status 404.
 */
export function useSentNotes(jobId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...sentNotesQueryOptions(api, jobId), enabled });
}

/**
 * The stock media a job's runs took (`['job-stock', jobId]`): `data` is `{ jobId, items }`,
 * `undefined` until the first answer. Only the open job sheet asks: pass `{ enabled: false }`
 * otherwise. A change of the job (`job.upsert`) invalidates it, so an open sheet reads it again and
 * a closed one does not. An unknown job is an `ApiError` with status 404.
 */
export function useJobStock(jobId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...jobStockQueryOptions(api, jobId), enabled });
}

/**
 * A job's chat (Draft & chat): asked only while `enabled` (an open chat with the switch on), and
 * asked again every 2 s while `live` (the job's run goes on).
 */
export function useJobFeed(
  jobId: string,
  { enabled = true, live = false }: { enabled?: boolean; live?: boolean } = {},
) {
  return useQuery({ ...jobFeedQueryOptions(api, jobId, { live }), enabled });
}

/**
 * Show in Finder for a job: `reveal.mutate(jobId)` shows the export MP4 selected when the job has
 * one, else opens its folder. Success says nothing (Finder coming forward is the sign); a failure
 * is a toast with the server's words.
 */
export function useRevealJob() {
  return useMutation(revealJobMutationOptions({ api, notify: toast }));
}

/**
 * A client's style (`['client-style', clientId]`): its state (none, analysing, ready, failed) and
 * its style.md as `markdown` (`null` while there is none). `data` is `undefined` until the first
 * answer; an unknown client is an `ApiError` with status 404. The `client.upsert` event loads it
 * again. Turn it off with `{ enabled: false }` while nothing needs it (a closed menu or dialog).
 */
export function useClientStyle(clientId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...clientStyleQueryOptions(api, clientId), enabled });
}

/** Runs a failed style run again: `retry.mutate()`. The style (now analysing) is already in the cache. */
export function useRetryClientStyle(clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.retryClientStyle(clientId),
    onSuccess: (style) => applyClientStyle(queryClient, style),
  });
}

/**
 * Use this look as a mutation: `await apply.mutateAsync(job.id)`. Resolves with the client's style
 * (now analysing, already in the cache); a refusal is an `ApiError` whose `message` is the server's
 * explanation (409: "The style is being analysed. Try again once it is done."), ready to show.
 */
export function useApplyLook() {
  const queryClient = useQueryClient();
  return useMutation(applyLookMutationOptions({ queryClient, api }));
}

/**
 * Undo of Use this look: `await undo.mutateAsync(clientId)`. Resolves with the restored style
 * (already in the cache); a refusal is an `ApiError` with the server's words.
 */
export function useUndoClientStyle() {
  const queryClient = useQueryClient();
  return useMutation(undoClientStyleMutationOptions({ queryClient, api }));
}

/** Adds a typed note: `add.mutate({ atSec, text })`. Resolves with the note (already in the cache). */
export function useAddNote(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation(addNoteMutationOptions({ queryClient, api, jobId }));
}

/** Adds a recorded note: `add.mutate({ audio, atSec, audioSec })`. The note comes back pending. */
export function useAddVoiceNote(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation(addVoiceNoteMutationOptions({ queryClient, api, jobId }));
}

/** Edits a note: `patch.mutate({ noteId, patch: { text } })` or `{ addToStyle }`. */
export function usePatchNote(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation(patchNoteMutationOptions({ queryClient, api, jobId }));
}

/** Deletes a note at once (no confirmation): `remove.mutate(noteId)`. It comes back if the server refuses. */
export function useDeleteNote(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation(deleteNoteMutationOptions({ queryClient, api, jobId }));
}
