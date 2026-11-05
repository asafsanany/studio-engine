// The one way files get into a client's `_Style` folder and become a Read pass (Phase 2 plan §5;
// Phase 3 §7, Add to style). The upload route and the review notes both go through here, so the free
// name, the Finder watcher's ignore and the queued pass are one piece of code:
//
//   each source written to `_Style/.upload-<id>/<n>` (a dot-folder the inbox watcher and the
//     scanner skip), in order
//   ─▶ each file moved into `_Style` under its own name, or "name (1).ext" when that is taken, the
//     Finder drops told of it first (`expectUpload`) so they don't read it a second time
//   ─▶ exactly one Read pass, with exactly these files, queued on the style worker
//
// `whileAnalysing` is the only difference between the two callers: an upload is refused while the
// client's style is being analysed (the route answers 409), the style notes wait their turn (the
// worker runs one pass at a time and joins a pass that is already waiting).

import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClientStyle } from '@studio/shared';
import type { ClientStyleRepository } from '../db/index.js';
import { toClientStyle } from '../db/index.js';
import { type RunnerLogger, SILENT_LOGGER } from '../pipeline/claude-process.js';
import { clientDirFor, styleDirFor } from './paths.js';
import type { StyleDrops } from './style-drops.js';
import type { RequestedReadMode } from './style-pass.js';
import { moveIntoStyle, type StagedFile } from './style-upload.js';
import type { StyleWorker } from './style-worker.js';

/** The 409 of an upload while the client's style is being analysed. */
export const STYLE_BEING_ANALYSED = 'The style is being analysed. Add files once it is done.';

/** The 404 for a client folder that is gone: it is never made here. */
export const CLIENT_FOLDER_MISSING = 'The client folder is missing.';

/** Files can't be added: 404 (the client folder is gone) or 409 (analysing, and the caller won't wait). */
export class AddStyleFilesError extends Error {
  readonly status: 404 | 409;

  constructor(message: string, status: 404 | 409) {
    super(message);
    this.name = 'AddStyleFilesError';
    this.status = status;
  }
}

/** One file to put into a client's `_Style` folder. */
export interface StyleFileSource {
  /**
   * The name it should get: already clean (`cleanFileName` for an upload, the shared
   * `styleNotesFileName` for the notes). A taken name gets " (1)", " (2)", … (`freeStyleName`).
   */
  name: string;
  /**
   * Puts the content at `path`, a file in a staging folder inside `_Style`. It is moved to its free
   * name afterwards, which keeps its size and modification time: those are what tells the Finder
   * drops that the file is not theirs.
   */
  write(path: string): Promise<void>;
}

export interface AddStyleFilesRequest {
  clientId: string;
  /** The client folder's name, as the job or the style row spells it. */
  client: string;
  files: readonly StyleFileSource[];
  /** The style worker turns it into create when there is no style.md. */
  mode: RequestedReadMode;
  /**
   * `refuse`: nothing is written while the client's style is analysing (the upload, 409).
   * `queue`: the pass is queued behind the one that is running (the style notes).
   */
  whileAnalysing: 'refuse' | 'queue';
}

export interface AddStyleFilesResult {
  /** The names the files got in `_Style`, in order. */
  fileNames: string[];
  /** The style after the pass was queued (analysing). */
  style: ClientStyle;
}

export interface AddStyleFilesDeps {
  /** `Config.inboxPath`. */
  inboxPath: string;
  clientStyles: Pick<ClientStyleRepository, 'get'>;
  worker: Pick<StyleWorker, 'enqueue'>;
  /** Hears of every file just before it is moved in, so the Finder drops don't read it again. */
  uploads?: Pick<StyleDrops, 'expectUpload'>;
  /** Default silent. */
  logger?: RunnerLogger;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Puts the files into the client's `_Style` and queues one Read pass for them. Rejects with an
 * `AddStyleFilesError` before anything is written when the client's folder is gone, or when it is
 * analysing and `whileAnalysing` is `refuse`. A write that fails rejects with its own error and
 * leaves nothing in `_Style` but the files moved before it; no pass is queued.
 */
export async function addStyleFiles(
  deps: AddStyleFilesDeps,
  request: AddStyleFilesRequest,
): Promise<AddStyleFilesResult> {
  const { inboxPath, clientStyles, worker, uploads, logger = SILENT_LOGGER } = deps;
  const { clientId, client, files, mode, whileAnalysing } = request;
  if (files.length === 0) throw new RangeError('addStyleFiles needs at least one file');

  if (whileAnalysing === 'refuse' && clientStyles.get(clientId)?.state === 'analysing') {
    throw new AddStyleFilesError(STYLE_BEING_ANALYSED, 409);
  }
  // Never made here: a client folder that is gone stays gone.
  if (!(await isDirectory(clientDirFor(inboxPath, client)))) {
    throw new AddStyleFilesError(CLIENT_FOLDER_MISSING, 404);
  }

  const styleDir = styleDirFor(inboxPath, client);
  const stagingDir = join(styleDir, `.upload-${randomUUID()}`);
  try {
    await mkdir(stagingDir, { recursive: true });
    const staged: StagedFile[] = [];
    for (const [index, file] of files.entries()) {
      const path = join(stagingDir, String(index));
      await file.write(path);
      staged.push({ name: file.name, path, size: (await stat(path)).size });
    }
    const moved = await moveIntoStyle(staged, styleDir, (name, info) =>
      uploads?.expectUpload(client, name, info),
    );
    const style = await worker.enqueue(client, { kind: 'read', mode, files: moved });
    return { fileNames: moved.map((file) => file.name), style: toClientStyle(style) };
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch((err: unknown) => {
      logger.warn({ err, stagingDir }, 'could not remove the upload staging folder');
    });
  }
}
