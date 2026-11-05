import type { MeResponse, TeamRole } from '@studio/shared';
import { Navigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { isAdmin, useMe, useViewerRole } from '@/data';

/**
 * What an admin-only page does: `show` its content, `wait` (draw nothing) for the engine's answer,
 * or `redirect` to Jobs. The engine's answer wins; until it is in, the role this browser remembers
 * shows the page for the admin (no flicker on a reload) and nothing for anyone else.
 */
export function adminGate(input: {
  me: Pick<MeResponse, 'role'> | undefined;
  remembered: TeamRole | null;
  /** The engine has neither answered nor failed yet. */
  pending: boolean;
}): 'show' | 'wait' | 'redirect' {
  if (input.me !== undefined) return isAdmin(input.me) ? 'show' : 'redirect';
  if (input.remembered === 'admin') return 'show';
  return input.pending ? 'wait' : 'redirect';
}

/**
 * A page only the admin has (Money, Analytics, Graphics, and Team when it exists): the admin sees
 * `children`; an editor is sent to Jobs, as is anyone the engine cannot name. The server refuses
 * these pages' data to an editor anyway; this keeps the page from opening empty.
 *
 * Nothing is drawn until the engine has said who is asking, except where this browser remembers
 * the admin (`useViewerRole`): then the page shows at once and is corrected if the answer differs.
 * A reload on /money does not flash Jobs, and the owner's does not wait.
 */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { data: me, isPending } = useMe();
  const role = useViewerRole();
  const gate = adminGate({ me, remembered: role, pending: isPending });
  if (gate === 'wait') return null;
  return gate === 'show' ? children : <Navigate to="/jobs" replace />;
}
