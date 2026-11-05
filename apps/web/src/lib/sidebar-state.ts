import { SIDEBAR_COOKIE_NAME } from '@/components/ui/sidebar';

/**
 * Whether the sidebar starts expanded. shadcn's SidebarProvider writes its open/closed state to
 * the `sidebar_state` cookie but never reads it back (on Next.js the server does that), so the app
 * reads it here and passes the result as `defaultOpen`. Anything but an explicit `false` means open.
 */
export function parseSidebarOpen(cookieHeader: string): boolean {
  for (const part of cookieHeader.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SIDEBAR_COOKIE_NAME) return value.join('=') !== 'false';
  }
  return true;
}

/** `parseSidebarOpen` over this browser's cookies; open if cookies are unavailable. */
export function readSidebarOpen(): boolean {
  try {
    return parseSidebarOpen(document.cookie);
  } catch {
    return true;
  }
}
