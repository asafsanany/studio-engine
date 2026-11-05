// What a handler needs to scope its own answer to the viewer (Team plan, TM2). The scope guard
// (scope-guard.ts) lets the routes marked `filtered` through for an editor; each of those
// handlers asks `clientFilter` which clients the viewer may see and leaves out the rest.

import { type Job, type TeamRole, type Viewer, withoutJobMoney } from '@studio/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../remote/viewer.js';

/** Whether this viewer may see the client (an unassigned client is the admin's alone). */
export type CanSee = (viewer: { email: string; role: TeamRole }, clientId: string) => boolean;

/** The viewer of a request. Routes mounted alone (tests) have none. */
export function viewerOf(c: Context): Viewer | undefined {
  return (c as unknown as Context<AppEnv>).get('viewer');
}

/**
 * Which clients the request's viewer may see: `null` when all of them (the admin, or a route
 * mounted without the app's viewer middleware), else a predicate. Without a `canSee` an editor
 * sees nothing, so a route that was not given one fails closed.
 */
export function clientFilter(
  c: Context,
  canSee: CanSee | undefined,
): ((clientId: string) => boolean) | null {
  const viewer = viewerOf(c);
  if (viewer === undefined || viewer.role === 'admin') return null;
  return (clientId) => canSee?.(viewer, clientId) ?? false;
}

/**
 * Whether the request's viewer is an editor. A request with no viewer (a route mounted alone, in
 * tests) is the admin's, as everywhere else.
 */
export function isEditor(c: Context): boolean {
  const viewer = viewerOf(c);
  return viewer !== undefined && viewer.role !== 'admin';
}

/**
 * The job as this request's viewer may see it: whole for the admin, without the price, currency and
 * pay date of its delivery for an editor (money is the admin's alone). Every route that answers
 * with a job passes it through here.
 */
export function jobFor<T extends { delivery: Job['delivery'] }>(c: Context, job: T): T {
  return isEditor(c) ? withoutJobMoney(job) : job;
}
