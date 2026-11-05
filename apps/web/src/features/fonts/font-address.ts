// The Fonts page's place in the address: `/fonts?family=heebo`. The address is the truth about which
// family is open, so a reload keeps it and a link can point at it. The list (FN6) and the pane
// (FN7, FN8) both read it through `useSelectedFamily` (use-selected-family.ts).
//
// - Choosing a row replaces the history entry: it is a view of the same page, not a place to go
//   back to, so Back leaves the page and does not step through the picks.
// - Nothing scrolls: the page stays where it is.

/** The optional search parameters of the Fonts page. */
export interface FontsSearch {
  /** The open family's slug. */
  family?: string;
}

/**
 * `validateSearch` of the page: keeps `family` when it is a non-empty string; drops everything
 * else (a number, a list, nothing) and every other parameter.
 */
export function validateFontsSearch(search: Record<string, unknown>): FontsSearch {
  const result: FontsSearch = {};
  const { family } = search;
  if (typeof family === 'string' && family !== '') result.family = family;
  return result;
}

/** The open family's slug in a page's search, or `null`. Reads any search, valid or not. */
export function familyOfSearch(search: unknown): string | null {
  if (typeof search !== 'object' || search === null) return null;
  const { family } = search as { family?: unknown };
  return typeof family === 'string' && family !== '' ? family : null;
}

/**
 * A change of the current page's search with `family` set, or taken out with `null`; every other
 * parameter stays. The router types `search` from the route in `to`, and with no `to` (the page we
 * are on) it can't know the route, so the function is handed over untyped.
 */
export function setFamilyParam(slug: string | null): never {
  const change = (search: Record<string, unknown>): Record<string, unknown> => {
    const { family: _was, ...rest } = search;
    return slug === null ? rest : { ...rest, family: slug };
  };
  return change as never;
}
