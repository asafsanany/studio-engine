import { createContext, useContext } from 'react';

/**
 * Whether the list under it is a series' own page (Series plan §6, board SeriesPage). There every
 * row is an episode of the one series, so the rows drop what would only repeat that (the Layers2
 * mark gives way to a muted "Format" after the format job's name, "follows episode N" goes) and the
 * row menu changes with them (`seriesMenuEntries`: no "Open the series", "Take out of the series").
 * The series page wraps its list in `<SeriesPageScope value>`; every other page leaves it `false`.
 */
const SeriesPageContext = createContext(false);

export const SeriesPageScope = SeriesPageContext.Provider;

/** Whether the row is on a series' own page. */
export function useOnSeriesPage(): boolean {
  return useContext(SeriesPageContext);
}
