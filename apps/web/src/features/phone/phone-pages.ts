/**
 * The addresses that have a phone layout of their own: the jobs list (`/` and `/jobs`), the phone
 * Settings page, the Clients pages (PH18: the list at `/clients`, a client at `/clients/<id>` and
 * its Style at `/clients/<id>/style`) and Money (PH19). Every other page is the Mac's page, shown
 * inside the phone shell under a "‹ Back" header until it gets a phone layout. Add an address here
 * when its phone page arrives.
 */
const PHONE_PAGES: readonly string[] = ['/', '/jobs', '/settings', '/clients', '/money'];

/** `pathname` without the slash that may end it (the root stays `/`). */
export function trimmedPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/**
 * The parts of a path under `/clients`: `['<id>']` for a client's page, `['<id>', 'style']` for its
 * Style page; `null` for any other address (the list itself, a series page, another section).
 */
function clientPathParts(path: string): string[] | null {
  const [, section, ...rest] = path.split('/');
  if (section !== 'clients' || rest.length === 0 || rest[0] === '') return null;
  if (rest.length === 1) return rest;
  return rest.length === 2 && rest[1] === 'style' ? rest : null;
}

/** Whether the page at `pathname` is a phone page (it brings its own header, not the shell's Back). */
export function hasPhoneLayout(pathname: string): boolean {
  const path = trimmedPath(pathname);
  return PHONE_PAGES.includes(path) || clientPathParts(path) !== null;
}
