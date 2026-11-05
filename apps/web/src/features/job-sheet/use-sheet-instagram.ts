// What a job's sheet reads of Instagram (Clients × Instagram, board CLStates S6), for the Mac sheet
// and the phone's: the reel linked to the job and its numbers, or whether the job could have one
// linked. Nothing is asked while the switch is off, so then the sheet is as it was.

import { type Job, jobStage } from '@studio/shared';
import { useClientHasInstagram, useInstagramEnabled, useJobReel } from '@/data';
import type { SheetInstagram } from './sheet-instagram';

/**
 * The sheet's Instagram, or `null` when it has nothing to say:
 * - a job a reel links (`delivery.uploadedAt`), delivered or paid: `{ kind: 'reel' }`, with the
 *   reel's numbers once they are in;
 * - a delivered job (not paid, not linked) of a client with an Instagram account:
 *   `{ kind: 'none' }`, the sheet says where to link a reel;
 * - anything else, and every job while the switch is off: `null`.
 */
export function useSheetInstagram(job: Job): SheetInstagram | null {
  const on = useInstagramEnabled();
  const stage = jobStage(job);
  const linked = stage !== null && job.delivery?.uploadedAt !== undefined;
  const unlinked = stage === 'delivered';
  const reel = useJobReel(job.id, { enabled: linked });
  const canLink = useClientHasInstagram(job.clientId, { enabled: unlinked });
  if (!on) return null;
  if (linked) return { kind: 'reel', reel: reel.data?.reel ?? null };
  return unlinked && canLink ? { kind: 'none' } : null;
}
