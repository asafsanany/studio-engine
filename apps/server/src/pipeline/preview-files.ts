import { join } from 'node:path';
import { extraFinalName, extraPreviewDirName } from '@studio/shared';

/** The live composition inside a job folder (Phase 3 §3): what edit and revise runs leave, and what the preview route serves. */
export const PREVIEW_DIR_PATH = join('edit', 'preview');

/** The composition's root file. A review job without it fails at boot (PREVIEW_MISSING). */
export const PREVIEW_INDEX_PATH = join(PREVIEW_DIR_PATH, 'index.html');

/**
 * Formats (GN7): an extra format's composition lives next to the main one, in `edit/preview-<id>/`
 * (id as in `JobFormat.id`: "1x1", "4x5"). The main format keeps `edit/preview/`.
 */
export function extraPreviewDirPath(formatId: string): string {
  return join('edit', extraPreviewDirName(formatId));
}

/** An extra format's composition root, `edit/preview-<id>/index.html`. */
export function extraPreviewIndexPath(formatId: string): string {
  return join(extraPreviewDirPath(formatId), 'index.html');
}

/** An extra format's rendered video, `edit/final-<id>.mp4`: what the render run leaves beside `edit/final.mp4`. */
export function extraFinalPath(formatId: string): string {
  return join('edit', extraFinalName(formatId));
}
