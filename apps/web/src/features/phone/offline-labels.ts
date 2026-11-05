const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (value: number): string => String(value).padStart(2, '0');

/** Whole calendar days from `from` to `to` on this device's clock (DST days are not 24 h long). */
function daysBetween(from: Date, to: Date): number {
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end - start) / 86_400_000);
}

/**
 * The line under "Try again" on the offline screen (board MOffline): when the Mac last answered,
 * on a 24-hour clock in the phone's own time zone. "Last connected today at 14:02", "... yesterday
 * at 23:50", and for anything older the day: "Last connected on 20 Oct at 09:15".
 */
export function lastConnectedLabel(heardAt: number, now: number): string {
  const heard = new Date(heardAt);
  const time = `${pad(heard.getHours())}:${pad(heard.getMinutes())}`;
  const days = daysBetween(heard, new Date(now));
  if (days <= 0) return `Last connected today at ${time}`;
  if (days === 1) return `Last connected yesterday at ${time}`;
  return `Last connected on ${heard.getDate()} ${MONTHS[heard.getMonth()]} at ${time}`;
}

/**
 * The page title above the offline message: the page the phone is on, so "Jobs" on the jobs list
 * as in the board, "Settings" on Settings. A page the phone has no name for (a client's page)
 * gets the app's name.
 */
export function offlineTitle(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/' || path === '/jobs') return 'Jobs';
  if (path === '/settings') return 'Settings';
  if (path === '/clients') return 'Clients';
  if (path === '/money') return 'Money';
  return 'Studio Engine';
}
