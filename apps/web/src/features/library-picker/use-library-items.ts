import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { graphicsApi } from '@/data/graphics-api';
import { graphicsQueryOptions, useGraphicsEnabled } from '@/data/graphics-query';
import { lutsApi } from '@/data/luts-api';
import { lutsQueryOptions, useLutsEnabled, useLutsInEditsEnabled } from '@/data/luts-query';
import { graphicPickerItems, lutPickerItems, type PickerItem } from './picker-items';

export interface LibraryItems {
  /** Notes can name library items (`lutsInEdits`): off, nothing of the picker shows and nothing is asked. */
  enabled: boolean;
  /** The LUTs, then the graphics, as the picker offers them. */
  items: PickerItem[];
  /** The first answer of a library that is on is still on its way. */
  loading: boolean;
}

/**
 * The LUTs and the graphics a note can name. Both libraries are asked only while `lutsInEdits` is
 * on (and each only while its own switch is on): with it off the notes box stays as it was, and the
 * review dialog asks the server nothing more. The lists are the ones the LUTs and Graphics pages
 * keep current, so they are shared with those pages, not asked twice. `active` false (the phone's
 * notes list, which has no picker and no chips) asks for nothing either.
 */
export function useLibraryItems(active = true): LibraryItems {
  const inEdits = useLutsInEditsEnabled() && active;
  const lutsOn = useLutsEnabled();
  const graphicsOn = useGraphicsEnabled();
  const luts = useQuery(lutsQueryOptions(lutsApi, inEdits && lutsOn));
  const graphics = useQuery(graphicsQueryOptions(graphicsApi, inEdits && graphicsOn));

  const lutData = luts.data;
  const graphicData = graphics.data;
  const items = useMemo<PickerItem[]>(
    () => (inEdits ? [...lutPickerItems(lutData), ...graphicPickerItems(graphicData)] : []),
    [inEdits, lutData, graphicData],
  );
  const loading =
    inEdits &&
    ((lutsOn && luts.data === undefined && luts.fetchStatus === 'fetching') ||
      (graphicsOn && graphics.data === undefined && graphics.fetchStatus === 'fetching'));
  return { enabled: inEdits, items, loading };
}
