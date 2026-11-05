import { useSyncExternalStore } from 'react';
import { engineOffline } from '@/data/engine-offline';
import { engineLink } from '@/data/job-events';

/**
 * `true` once the engine has been out of reach for more than 5 s (the events stream broke or the
 * list cannot be fetched), until it answers again. The phone swaps its page for "Can't reach your
 * Mac" while it holds; the Mac layout never reads it.
 */
export function useEngineOffline(): boolean {
  return useSyncExternalStore(engineOffline.subscribe, engineOffline.isOffline, () => false);
}

/**
 * When the engine last answered (ms since the epoch), or null if it never has. It is read when the
 * offline screen opens and does not move while the engine is away, so it needs no subscription of
 * its own: it rides on the link's.
 */
export function useEngineLastHeard(): number | null {
  return useSyncExternalStore(engineLink.subscribe, engineLink.lastHeardAt, () => null);
}
