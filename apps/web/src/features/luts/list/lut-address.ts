import { isLutTab, type LutTab } from './lut-list';

// The LUTs page's place in the address: `/luts?lut=golden-hour-warm&tab=look`. The address is the
// truth about which LUT is open and which tab is showing, so a reload keeps them and a link can
// point at either.
//
// - `All` is the default, so choosing it takes `tab` out of the address.
// - Choosing a row or a tab replaces the history entry: it is a view of the same page, not a place
//   to go back to, so Back leaves the page and does not step through the picks.
// - Nothing scrolls: the page stays where it is.

/** The optional search parameters of the LUTs page. */
export interface LutsSearch {
  /** The open LUT's slug. */
  lut?: string;
  /** `look`, `camera` or `fix`; absent for All. */
  tab?: Exclude<LutTab, 'all'>;
  /**
   * A job that waits for a camera LUT (LU10): "Import LUT" on its row or sheet comes here with its
   * id, and the page opens the import dialog for it once and takes the parameter out.
   */
  for?: string;
}

/**
 * `validateSearch` of the page: keeps `lut` when it is a non-empty string and `tab` when it is
 * `look`, `camera` or `fix`; drops everything else (another word, a number, a list, nothing).
 */
export function validateLutsSearch(search: Record<string, unknown>): LutsSearch {
  const result: LutsSearch = {};
  const { lut, tab } = search;
  if (typeof lut === 'string' && lut !== '') result.lut = lut;
  if (isLutTab(tab) && tab !== 'all') result.tab = tab;
  if (typeof search.for === 'string' && search.for !== '') result.for = search.for;
  return result;
}

/** The open LUT's slug in a page's search, or `null`. Reads any search, valid or not. */
export function lutOfSearch(search: unknown): string | null {
  if (typeof search !== 'object' || search === null) return null;
  const { lut } = search as { lut?: unknown };
  return typeof lut === 'string' && lut !== '' ? lut : null;
}

/** The tab a page's search asks for: `all` unless it names a kind. Reads any search, valid or not. */
export function tabOfSearch(search: unknown): LutTab {
  if (typeof search !== 'object' || search === null) return 'all';
  const { tab } = search as { tab?: unknown };
  return isLutTab(tab) ? tab : 'all';
}

/** The job `?for=` names (LU10), or `null`. Reads any search, valid or not. */
export function forJobOfSearch(search: unknown): string | null {
  if (typeof search !== 'object' || search === null) return null;
  const { for: job } = search as { for?: unknown };
  return typeof job === 'string' && job !== '' ? job : null;
}

/** A change of the current page's search with `for` taken out; every other parameter stays. */
export function clearForParam(): never {
  const change = (search: Record<string, unknown>): Record<string, unknown> => {
    const { for: _was, ...rest } = search;
    return rest;
  };
  return change as never;
}

/**
 * A change of the current page's search with `lut` set, or taken out with `null`; every other
 * parameter stays. The router types `search` from the route in `to`, and with no `to` (the page we
 * are on) it can't know the route, so the function is handed over untyped.
 */
export function setLutParam(slug: string | null): never {
  const change = (search: Record<string, unknown>): Record<string, unknown> => {
    const { lut: _was, ...rest } = search;
    return slug === null ? rest : { ...rest, lut: slug };
  };
  return change as never;
}

/** Like {@link setLutParam} for `tab`: `all` takes it out. */
export function setTabParam(tab: LutTab): never {
  const change = (search: Record<string, unknown>): Record<string, unknown> => {
    const { tab: _was, ...rest } = search;
    return tab === 'all' ? rest : { ...rest, tab };
  };
  return change as never;
}

/**
 * Opens a LUT that has just been added: `lut` set and `tab` taken out (back to All), in one change,
 * so a LUT of another kind than the tab on show does not land hidden. Every other parameter stays.
 */
export function showLutParam(slug: string): never {
  const change = (search: Record<string, unknown>): Record<string, unknown> => {
    const { lut: _lut, tab: _tab, ...rest } = search;
    return { ...rest, lut: slug };
  };
  return change as never;
}
