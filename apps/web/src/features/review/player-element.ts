// The <hyperframes-player> custom element: what we load of it, where its runtime comes from, and
// its JSX typing. Importing @hyperframes/player runs `customElements.define(...)` and a class that
// extends HTMLElement at module load, which throws in node. So nothing here imports it at the top:
// only `loadPlayerElement()`, called from an effect, does, plus `import type`.

import runtimeSrc from '@hyperframes/core/runtime?url';
import type { HyperframesPlayer } from '@hyperframes/player';

export type { HyperframesPlayer } from '@hyperframes/player';

/**
 * Where the player loads the HyperFrames runtime script from: our own origin (`/@fs/...` in dev,
 * `/assets/hyperframe.runtime.iife-<hash>.js` in a build). It keeps the player from fetching the
 * runtime from cdn.jsdelivr.net, which is its default. The `runtime-src` attribute is undocumented;
 * the player accepts it only for a same-origin or localhost URL and silently uses the CDN otherwise.
 */
export const PLAYER_RUNTIME_SRC: string = runtimeSrc;

let loading: Promise<void> | null = null;

/**
 * Defines <hyperframes-player> (browser only; call it from an effect). Loaded once: the second call
 * gets the same promise. A failed load is forgotten, so "Try again" can retry it.
 */
export function loadPlayerElement(): Promise<void> {
  if (loading === null) {
    loading = import('@hyperframes/player').then(
      () => undefined,
      (error: unknown) => {
        loading = null;
        throw error;
      },
    );
  }
  return loading;
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'hyperframes-player': DetailedHTMLProps<
        HTMLAttributes<HyperframesPlayer>,
        HyperframesPlayer
      > & {
        src?: string;
        width?: number;
        height?: number;
        'runtime-src'?: string;
        'disable-click-to-play'?: '';
        'assets-loading-ui'?: 'player' | 'none';
        /** Play again from the start when it reaches the end (a boolean attribute). */
        loop?: boolean;
        /** The speed, the composition's timeline and its media together (the player keeps it 0.1 to 5). */
        'playback-rate'?: string;
      };
    }
  }
}
