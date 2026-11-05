import { toast } from 'sonner';
import { useScanClientInstagram } from '@/data';
import { ACTION_ERROR_MS } from '@/features/jobs/cells/ActionError';

/**
 * Scan now for one client: `start()` asks the engine to scan it and `busy` is true while that
 * request is on its way. A refusal is said in a toast (once per client). The section's numbers fill
 * in when the scan is done (the `client-instagram` event); both the head's Scan now and a scan
 * problem's Retry use it.
 */
export function useStartScan(clientId: string): { start: () => void; busy: boolean } {
  const scan = useScanClientInstagram();
  return {
    busy: scan.isPending,
    start: () =>
      scan.mutate(clientId, {
        onError: (error) =>
          toast.error("Couldn't start the scan", {
            id: `scan-client-instagram:${clientId}`,
            description: error.message,
            duration: ACTION_ERROR_MS,
          }),
      }),
  };
}
