import { useRouter, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';
import { familyOfSearch, setFamilyParam } from './font-address';

/** The open family as the address holds it, and the way to change it. */
export interface SelectedFamily {
  /** The open family's slug, or `null` when the address names none (the list's first row is open). */
  selected: string | null;
  /** Opens a family (a slug), or `null` to close it. Replaces the history entry and keeps the scroll. */
  setSelected: (slug: string | null) => void;
}

/**
 * The Fonts page's `?family=<slug>` (see font-address.ts). The list (FN6) and the pane (FN7, FN8)
 * both call this, so they share the open family through the address and no props.
 */
export function useSelectedFamily(): SelectedFamily {
  const router = useRouter();
  const search = useSearch({ strict: false });
  const setSelected = useCallback(
    (slug: string | null) => {
      void router.navigate({ search: setFamilyParam(slug), replace: true, resetScroll: false });
    },
    [router],
  );
  return { selected: familyOfSearch(search), setSelected };
}
