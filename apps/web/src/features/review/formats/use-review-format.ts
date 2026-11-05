import type { Job, JobFormat } from '@studio/shared';
import { useCallback, useState } from 'react';
import { formatStamp, formatsOf, selectedFormat } from './format-logic';

/** What Review knows of the formats of a job with more than one. */
export interface ReviewFormat {
  /** The job's formats, main first. */
  formats: readonly JobFormat[];
  /** The one on show: the player loads its composition and a new note is written on it. */
  shown: JobFormat;
  /** What a new note is stamped with: the extra format's id, `null` for the main one. */
  stamp: string | null;
  /** The id the player's address names (`previewUrl`'s `formatId`): the same, `null` for the main one. */
  previewId: string | null;
  select: (format: JobFormat) => void;
}

/**
 * The format on show in a Review (Generated videos, GN8): the main one to begin with, then what the
 * switch picked. `null` for a job with one format, which has no switch and nothing else changed.
 * A format the job no longer has (its brief changed) falls back to the main one.
 */
export function useReviewFormat(job: Pick<Job, 'formats'>): ReviewFormat | null {
  const formats = formatsOf(job);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const select = useCallback((format: JobFormat) => setPickedId(format.id), []);
  if (formats === undefined) return null;
  const shown = selectedFormat(formats, pickedId);
  const stamp = formatStamp(formats, shown);
  return { formats, shown, stamp, previewId: stamp, select };
}
