/**
 * Where a tapped notification lands (Mobile plan §6). The engine sends the address to open (PH11,
 * `PUSH_URLS`): `/jobs?job=<id>&review=1` for "Ready to review", `/jobs?job=<id>` (the job's
 * sheet) for the others, `/jobs` for "Queue is empty". The service worker opens it in the app, or
 * hands it to the open app (`SW_OPEN_MESSAGE`), which navigates there with its router.
 *
 * `review=1` asks for the job's Review: PhonePush opens the job's sheet with the phone Review (PH8)
 * over it. The address is replaced by the sheet's (`/jobs?job=<id>`), so a reload or Back does not
 * ask again; closing the review gives the sheet back.
 */

/** Whether `url` is an address of this app (a path), not another site's. */
export function isAppPath(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');
}

/**
 * The job whose Review the address asks for (`?job=<id>&review=1`), or `null`. Reads the router's
 * parsed search, where `1` may arrive as a number.
 */
export function reviewLanding(search: unknown): string | null {
  if (typeof search !== 'object' || search === null) return null;
  const { job, review } = search as { job?: unknown; review?: unknown };
  if (review !== 1 && review !== '1' && review !== true) return null;
  return typeof job === 'string' && job !== '' ? job : null;
}
