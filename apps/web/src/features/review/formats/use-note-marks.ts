import type { Job, JobFormat, ReviewNote } from '@studio/shared';
import { useMemo } from 'react';
import { useGenerateReviewPlan } from '@/data';
import { type NoteMarks, noteMarksOf } from './format-logic';

/**
 * The format stamp, the hint line and the scope of each of a Review's notes (Generated videos,
 * GN8). The hint lines exist only for a generated job (`job.generate`) whose plan the engine could
 * read; the stamp only for a job with two formats. Both are empty for any other job, which also
 * asks for nothing.
 */
export function useNoteMarks(
  job: Pick<Job, 'id' | 'state' | 'generate'>,
  notes: readonly ReviewNote[] | undefined,
  formats: readonly JobFormat[] | undefined,
  where: 'mac' | 'phone' = 'mac',
): NoteMarks {
  const generated = job.generate !== undefined && job.generate !== null;
  const planQuery = useGenerateReviewPlan(job.id, { enabled: generated && job.state === 'review' });
  const plan = planQuery.data;
  const generate = job.generate ?? undefined;
  return useMemo(
    () => noteMarksOf({ notes, formats, plan, generate, where }),
    [notes, formats, plan, generate, where],
  );
}
