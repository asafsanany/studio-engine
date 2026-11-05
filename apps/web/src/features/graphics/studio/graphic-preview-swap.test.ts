import { describe, expect, it } from 'vitest';
import {
  initialSwap,
  playersToDraw,
  type SwapAction,
  type SwapState,
  swapReducer,
} from './graphic-preview-swap';

interface Source {
  src: string;
}
const A: Source = { src: 'a' };
const B: Source = { src: 'b' };
const C: Source = { src: 'c' };

function run(state: SwapState<Source>, ...actions: SwapAction<Source>[]): SwapState<Source> {
  return actions.reduce((next, action) => swapReducer(next, action), state);
}

describe('swapReducer', () => {
  it('starts with the address that is wanted on show, and nothing loading', () => {
    expect(initialSwap(A)).toEqual({ shown: A, loading: null, answered: null });
    expect(initialSwap<Source>(null)).toEqual({ shown: null, loading: null, answered: null });
  });

  it('takes the first address as the one to show', () => {
    const empty = initialSwap<Source>(null);
    expect(swapReducer(empty, { type: 'want', source: A })).toEqual({
      shown: A,
      loading: null,
      answered: null,
    });
  });

  it('keeps the same address, with no change at all', () => {
    const state = initialSwap(A);
    expect(swapReducer(state, { type: 'want', source: { src: 'a' } })).toBe(state);
  });

  it('loads a new address behind the one on show', () => {
    expect(run(initialSwap(A), { type: 'want', source: B })).toEqual({
      shown: A,
      loading: B,
      answered: null,
    });
  });

  it('keeps loading the same address when it is wanted again', () => {
    const loading = run(initialSwap(A), { type: 'want', source: B });
    expect(swapReducer(loading, { type: 'want', source: { src: 'b' } })).toBe(loading);
  });

  it('replaces what was loading when another address is wanted', () => {
    const state = run(initialSwap(A), { type: 'want', source: B }, { type: 'want', source: C });
    expect(state).toEqual({ shown: A, loading: C, answered: null });
  });

  it('drops what was loading when the one on show is wanted again', () => {
    const state = run(initialSwap(A), { type: 'want', source: B }, { type: 'want', source: A });
    expect(state).toEqual({ shown: A, loading: null, answered: null });
  });

  it('puts the loading player in place once it has answered, and not before', () => {
    const loading = run(initialSwap(A), { type: 'want', source: B });
    const answered = swapReducer(loading, { type: 'answered', src: 'b', ok: true });
    // Still the old one on show until it is placed.
    expect(answered).toEqual({ shown: A, loading: B, answered: { src: 'b', ok: true } });
    expect(playersToDraw(answered)).toEqual([A, B]);

    const placed = swapReducer(answered, { type: 'placed', src: 'b' });
    expect(placed).toEqual({ shown: B, loading: null, answered: null });
    expect(playersToDraw(placed)).toEqual([B]);
  });

  it('puts a player that failed in place too, so its error is seen', () => {
    const state = run(
      initialSwap(A),
      { type: 'want', source: B },
      { type: 'answered', src: 'b', ok: false },
    );
    expect(state.answered).toEqual({ src: 'b', ok: false });
    expect(swapReducer(state, { type: 'placed', src: 'b' }).shown).toBe(B);
  });

  it('ignores an answer from a player that is neither on show nor loading', () => {
    const state = initialSwap(A);
    expect(swapReducer(state, { type: 'answered', src: 'zzz', ok: true })).toBe(state);
    const loading = run(initialSwap(A), { type: 'want', source: B }, { type: 'want', source: C });
    // b was replaced by c: its late answer means nothing.
    expect(swapReducer(loading, { type: 'answered', src: 'b', ok: true })).toBe(loading);
  });

  it('forgets an answer when what was loading is replaced or dropped', () => {
    const answeredB = run(
      initialSwap(A),
      { type: 'want', source: B },
      { type: 'answered', src: 'b', ok: true },
    );
    expect(swapReducer(answeredB, { type: 'want', source: C }).answered).toBeNull();
    expect(swapReducer(answeredB, { type: 'want', source: A }).answered).toBeNull();
  });

  it('does not place a player whose answer was forgotten', () => {
    const forgotten = run(
      initialSwap(A),
      { type: 'want', source: B },
      { type: 'answered', src: 'b', ok: true },
      { type: 'want', source: C },
    );
    expect(swapReducer(forgotten, { type: 'placed', src: 'b' })).toBe(forgotten);
  });

  it('settles the first player when it answers, with nothing to swap', () => {
    const state = run(initialSwap(A), { type: 'answered', src: 'a', ok: true });
    expect(state.answered).toEqual({ src: 'a', ok: true });
    expect(swapReducer(state, { type: 'placed', src: 'a' })).toEqual({
      shown: A,
      loading: null,
      answered: null,
    });
  });

  it('shows a player that is still loading when the next address arrives, then the next one wins', () => {
    // A never answers; B answers first and takes its place.
    const state = run(
      initialSwap(A),
      { type: 'want', source: B },
      { type: 'answered', src: 'b', ok: true },
      { type: 'placed', src: 'b' },
    );
    expect(state.shown).toBe(B);
    expect(playersToDraw(state)).toEqual([B]);
  });

  it('empties out when there is nothing to show any more', () => {
    const state = run(initialSwap(A), { type: 'want', source: B }, { type: 'want', source: null });
    expect(state).toEqual({ shown: null, loading: null, answered: null });
    expect(playersToDraw(state)).toEqual([]);
  });
});

describe('playersToDraw', () => {
  it('draws the player on show first, then the one loading', () => {
    expect(playersToDraw({ shown: A, loading: B, answered: null })).toEqual([A, B]);
    expect(playersToDraw({ shown: A, loading: null, answered: null })).toEqual([A]);
    expect(playersToDraw({ shown: null, loading: null, answered: null })).toEqual([]);
  });
});
