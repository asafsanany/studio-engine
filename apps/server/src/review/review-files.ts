// Where a job's review lives, relative to the job folder (Phase 3 §3 and §6). All of it is inside
// edit/, which the inbox watcher ignores. Forward slashes on purpose: these strings are stored in
// review_notes.audio_file and printed in the round file.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { VoiceNoteType } from '@studio/shared';

export const REVIEW_DIR_PATH = 'edit/review';
export const VOICE_DIR_PATH = 'edit/review/voice';

/** edit/review/round-N.md: what the revise run of round N reads. */
export function roundFilePath(round: number): string {
  return `${REVIEW_DIR_PATH}/round-${round}.md`;
}

/** edit/review/voice/<id>.webm for audio/webm, .m4a for audio/mp4. */
export function voiceAudioPath(noteId: string, type: VoiceNoteType): string {
  return `${VOICE_DIR_PATH}/${noteId}.${type === 'audio/mp4' ? 'm4a' : 'webm'}`;
}

/** The Content-Type a recording is served with: audio/mp4 for .m4a, else audio/webm. */
export function voiceContentType(audioFile: string): VoiceNoteType {
  return audioFile.toLowerCase().endsWith('.m4a') ? 'audio/mp4' : 'audio/webm';
}

/** Writes in one move (.<name>.tmp in the same folder, then rename), making the folder; removes the temp file on failure. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.tmp`);
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => {});
    throw err;
  }
}
