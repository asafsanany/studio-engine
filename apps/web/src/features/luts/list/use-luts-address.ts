import { useRouter, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';
import {
  clearForParam,
  forJobOfSearch,
  lutOfSearch,
  setLutParam,
  setTabParam,
  showLutParam,
  tabOfSearch,
} from './lut-address';
import type { LutTab } from './lut-list';

/** The open LUT and the tab, as the address holds them, and the two ways to change them. */
export interface LutsAddress {
  /** The open LUT's slug, or `null` for the list's first row. */
  selected: string | null;
  tab: LutTab;
  setSelected: (slug: string | null) => void;
  setTab: (tab: LutTab) => void;
  /** Opens a LUT that was just added, on the All tab so it is not hidden by the one on show. */
  showNew: (slug: string) => void;
  /** The job `?for=` names: "Import LUT" on a job that waits for a camera LUT came here for it (LU10). */
  forJob: string | null;
  /** Takes `?for=` out of the address once the page has acted on it. */
  clearForJob: () => void;
}

/**
 * The LUTs page's `?lut=` and `?tab=` (see lut-address.ts). Both changes replace the history entry
 * and keep the scroll.
 */
export function useLutsAddress(): LutsAddress {
  const router = useRouter();
  const search = useSearch({ strict: false });
  const setSelected = useCallback(
    (slug: string | null) => {
      void router.navigate({ search: setLutParam(slug), replace: true, resetScroll: false });
    },
    [router],
  );
  const setTab = useCallback(
    (tab: LutTab) => {
      void router.navigate({ search: setTabParam(tab), replace: true, resetScroll: false });
    },
    [router],
  );
  const showNew = useCallback(
    (slug: string) => {
      void router.navigate({ search: showLutParam(slug), replace: true, resetScroll: false });
    },
    [router],
  );
  const clearForJob = useCallback(() => {
    void router.navigate({ search: clearForParam(), replace: true, resetScroll: false });
  }, [router]);
  return {
    forJob: forJobOfSearch(search),
    clearForJob,
    selected: lutOfSearch(search),
    tab: tabOfSearch(search),
    setSelected,
    setTab,
    showNew,
  };
}
