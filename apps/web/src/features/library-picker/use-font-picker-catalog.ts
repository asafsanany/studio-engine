import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fontsApi } from '@/data/fonts-api';
import { fontsQueryOptions, useFontsInNotesEnabled } from '@/data/fonts-query';
import { type FontPickerCatalog, fontPickerCatalog } from './font-picker';

export interface FontPickerCatalogState {
  /** Notes can name a font (`fontsInNotes`, with Fonts on): off, nothing of Fonts is asked or shown. */
  enabled: boolean;
  /** Every face of the library; empty while the list is on its way, or when it could not be had. */
  catalog: FontPickerCatalog;
  /** The first answer of the font list is still on its way. */
  loading: boolean;
}

/**
 * The fonts a note can name (`GET /api/fonts`'s catalog, the list the Fonts page keeps current, so
 * it is shared with that page and not asked twice). The list is asked only while `fontsInNotes` is
 * on: with it off the notes box stays as it was and the review dialog asks the server nothing more.
 * `active` false (a box that has no picker) asks for nothing either.
 */
export function useFontPickerCatalog(active = true): FontPickerCatalogState {
  const on = useFontsInNotesEnabled() && active;
  const list = useQuery(fontsQueryOptions(fontsApi, on));
  const data = list.data;
  const catalog = useMemo(() => fontPickerCatalog(on ? data : undefined), [on, data]);
  const loading = on && data === undefined && list.fetchStatus === 'fetching';
  return { enabled: on, catalog, loading };
}
