import { useCallback, useEffect, useMemo, useState } from 'react';
import { useJobAction, useJobs, useLuts } from '@/data';
import { type CameraWaitingJob, cameraWaitingJobs } from './camera-wait';

/** How long "Resumed …" stays after Resume. */
export const RESUMED_MS = 5000;

/**
 * What the LUTs page knows about jobs that wait for a camera LUT (LU10): which ones (read from their
 * error), whether a camera LUT was just imported for them, which ones Resume was just pressed for,
 * and Resume itself (a failed job's Retry, from the step it failed at).
 */
export function useCameraWait() {
  const jobs = useJobs();
  const luts = useLuts();
  const retry = useJobAction('retry');
  const [imported, setImported] = useState(false);
  const [resumed, setResumed] = useState<readonly string[]>([]);

  const library = luts.data;
  const waiting = useMemo(
    () =>
      cameraWaitingJobs(jobs.data ?? [], [...(library?.yours ?? []), ...(library?.builtIn ?? [])]),
    [jobs.data, library],
  );

  // The "Resumed" line goes by itself.
  useEffect(() => {
    if (resumed.length === 0) return;
    const timer = setTimeout(() => setResumed([]), RESUMED_MS);
    return () => clearTimeout(timer);
  }, [resumed]);

  const resume = useCallback(
    (items: readonly CameraWaitingJob[]) => {
      for (const item of items) retry.mutate(item.job.id);
      setResumed(items.map((item) => item.title));
      setImported(false);
    },
    [retry],
  );

  return {
    waiting,
    /** The jobs are known (a first answer is in), so a `?for=` that names none can be dropped. */
    loaded: jobs.data !== undefined,
    imported,
    markImported: useCallback(() => setImported(true), []),
    resumed,
    resume,
  };
}
