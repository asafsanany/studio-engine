/**
 * The months the picker lists: the server's `months` (newest first), with the month shown among
 * them even if the server does not list it (a month with nothing in it, asked for by a clock that
 * differs from the server's). Newest first, no repeats. Before the list has arrived, just the month.
 */
export function monthOptions(month: string, months: readonly string[] | undefined): string[] {
  const all = new Set([month, ...(months ?? [])]);
  // YYYY-MM sorts as text.
  return [...all].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}
