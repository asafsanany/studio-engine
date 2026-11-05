// Types of yt-dlp-errors.mjs, the reader of yt-dlp's complaints (Songs, SG2), for its tests, the
// getter and the doctor. The codes are the shared contract's (SONG_FAILURE_CODES in
// packages/shared/src/domain/music.ts).

export type YtDlpErrorCode =
  | 'update_needed'
  | 'blocked'
  | 'unavailable'
  | 'not_found'
  | 'tool_missing'
  | 'failed';

export interface YtDlpErrorContext {
  /** How the sentence names the song: `"נתתי לך בית" by Ofek Adanek`. Default "that song". */
  song?: string;
  /** How the sentence names the site: "YouTube Music". Default "YouTube". */
  site?: string;
}

/**
 * What yt-dlp's stderr means: a song failure code and a plain sentence (no URL, no key). Anything
 * it does not know is `failed`, with the last thing yt-dlp said.
 */
export function classifyYtDlpError(
  stderr: unknown,
  context?: YtDlpErrorContext,
): { code: YtDlpErrorCode; message: string };
