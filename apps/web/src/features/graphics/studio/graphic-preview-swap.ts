// Which player the preview shows, and which one is loading behind it (GR3).
//
// Re-keying the player means loading a new host address. If the old player were taken away first,
// the picture would blank for as long as the new one needs to load, on every pause in typing. So the
// new player loads hidden, in the same place; the old one stays on show until the new one is ready
// (or has failed, so its error is seen). Then the new one is put at the time the old one was at, and
// the old one is dropped. This is that bookkeeping, as a reducer, so it is tested without a DOM.

/** One player to show: its address is its identity. */
export interface PlayerSource {
  src: string;
}

export interface SwapState<T extends PlayerSource> {
  /** The player on show. `null` only before there is any. */
  shown: T | null;
  /** The player loading behind it, if the wanted address is not the shown one. */
  loading: T | null;
  /** A player that has just answered (ready, or failed) and waits to be put in place. */
  answered: { src: string; ok: boolean } | null;
}

export type SwapAction<T extends PlayerSource> =
  /** The address that should be on show now (the same one again changes nothing). */
  | { type: 'want'; source: T | null }
  /** The player at `src` fired `ready` (`ok`), or failed (`!ok`). */
  | { type: 'answered'; src: string; ok: boolean }
  /** The answered player has been put in place: it is on show now. */
  | { type: 'placed'; src: string };

export function initialSwap<T extends PlayerSource>(source: T | null): SwapState<T> {
  return { shown: source, loading: null, answered: null };
}

export function swapReducer<T extends PlayerSource>(
  state: SwapState<T>,
  action: SwapAction<T>,
): SwapState<T> {
  switch (action.type) {
    case 'want': {
      const { source } = action;
      if (source === null) return initialSwap<T>(null);
      // Nothing on show yet: it is the one.
      if (state.shown === null) return { shown: source, loading: null, answered: null };
      // Back to what is on show: forget what was loading.
      if (state.shown.src === source.src) {
        return state.loading === null ? state : { ...state, loading: null, answered: null };
      }
      if (state.loading?.src === source.src) return state;
      // A new address: it loads (and replaces any other that was loading).
      return { ...state, loading: source, answered: null };
    }
    case 'answered':
      // Only the player that is loading, or the one on show for the first time, is waited for.
      if (state.loading?.src !== action.src && state.shown?.src !== action.src) return state;
      return { ...state, answered: { src: action.src, ok: action.ok } };
    case 'placed': {
      if (state.answered?.src !== action.src) return state;
      if (state.loading?.src === action.src) {
        return { shown: state.loading, loading: null, answered: null };
      }
      return { ...state, answered: null };
    }
  }
}

/** The players to draw: the one on show first, then the one loading. */
export function playersToDraw<T extends PlayerSource>(state: SwapState<T>): T[] {
  return [state.shown, state.loading].filter((source): source is T => source !== null);
}
