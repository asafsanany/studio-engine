// Changing a job's review notes: add (typed or recorded), edit, delete.
//
// Add and edit have no optimistic update: the server decides (it trims, checks, and refuses outside
// Review), so the cache takes the note it answers with. Delete is instant: the note leaves the
// list at once and comes back if the server refuses, because notes are deleted without asking.
// The server's note events keep the list right for everything else (job-events.ts).

import type { AddNoteRequest, PatchNoteRequest, ReviewNote } from '@studio/shared';
import { mutationOptions, type QueryClient } from '@tanstack/react-query';
import { type Api, ApiError, type VoiceNoteUpload } from './api';
import { notesKey, removeNote, upsertNote } from './notes-cache';

/** First element of every note mutation's key; the second is what it does, the third the job. */
export const NOTE_MUTATION_KEY = 'note';

export interface NoteMutationParams {
  queryClient: QueryClient;
  api: Api;
  /** The job the notes belong to. */
  jobId: string;
}

/** The note joins the job's cached list (when there is one: whoever loads it reads the server). */
function putNote(queryClient: QueryClient, jobId: string, note: ReviewNote): void {
  queryClient.setQueryData<ReviewNote[]>(notesKey(jobId), (list) => list && upsertNote(list, note));
}

/** The mutation of a typed note: variables are `{ atSec, text }`, the result is the note. */
export function addNoteMutationOptions({ queryClient, api, jobId }: NoteMutationParams) {
  return mutationOptions<ReviewNote, ApiError, AddNoteRequest>({
    mutationKey: [NOTE_MUTATION_KEY, 'add', jobId],
    mutationFn: (note) => api.addNote(jobId, note),
    onSuccess: (note) => putNote(queryClient, jobId, note),
  });
}

/** The mutation of a recorded note: variables are the upload; the note comes back pending. */
export function addVoiceNoteMutationOptions({ queryClient, api, jobId }: NoteMutationParams) {
  return mutationOptions<ReviewNote, ApiError, VoiceNoteUpload>({
    mutationKey: [NOTE_MUTATION_KEY, 'add-voice', jobId],
    mutationFn: (upload) => api.addVoiceNote(jobId, upload),
    onSuccess: (note) => putNote(queryClient, jobId, note),
  });
}

/** What PATCH sends for a note. */
export interface PatchNoteVariables {
  noteId: string;
  patch: PatchNoteRequest;
}

/** The mutation of an edit (text, Add to style): the result is the note as the server has it. */
export function patchNoteMutationOptions({ queryClient, api, jobId }: NoteMutationParams) {
  return mutationOptions<ReviewNote, ApiError, PatchNoteVariables>({
    mutationKey: [NOTE_MUTATION_KEY, 'patch', jobId],
    mutationFn: ({ noteId, patch }) => api.patchNote(jobId, noteId, patch),
    onSuccess: (note) => putNote(queryClient, jobId, note),
  });
}

/** What `onMutate` remembers for `onError`: the note that was taken out of the list, if it was there. */
export interface DeleteNoteContext {
  note?: ReviewNote;
}

/** The mutation of a delete: the variable is the note id. */
export function deleteNoteMutationOptions({ queryClient, api, jobId }: NoteMutationParams) {
  return mutationOptions<void, ApiError, string, DeleteNoteContext>({
    mutationKey: [NOTE_MUTATION_KEY, 'delete', jobId],
    mutationFn: (noteId) => api.deleteNote(jobId, noteId),

    async onMutate(noteId) {
      // A fetch that finishes after the removal would bring the note back.
      await queryClient.cancelQueries({ queryKey: notesKey(jobId) });
      const note = queryClient
        .getQueryData<ReviewNote[]>(notesKey(jobId))
        ?.find((existing) => existing.id === noteId);
      queryClient.setQueryData<ReviewNote[]>(
        notesKey(jobId),
        (list) => list && removeNote(list, noteId),
      );
      return note === undefined ? {} : { note };
    },

    onError(error, _noteId, context) {
      const note = context?.note;
      if (note === undefined) return;
      // The server says it is not there (deleted elsewhere): putting it back would show a ghost.
      if (error instanceof ApiError && error.status === 404) return;
      putNote(queryClient, jobId, note);
    },
  });
}

/** Whether the delete of note `noteId` is on its way to the server right now. */
export function isNoteDeletePending(queryClient: QueryClient, noteId: string): boolean {
  return (
    queryClient.isMutating({
      mutationKey: [NOTE_MUTATION_KEY, 'delete'],
      predicate: (mutation) => mutation.state.variables === noteId,
    }) > 0
  );
}
