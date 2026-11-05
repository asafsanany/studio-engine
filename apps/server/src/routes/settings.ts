// The settings API (Settings page): the switches the admin can change. Admin only.
// Mounted at /settings of the API.
//
//   GET  /settings          { features: [{ key, running, saved, lockedByEnv }], instagramClients:
//                           { running, saved, lockedByEnv }, canRestart }: the switches (graphics,
//                           fonts, luts, claudePlanOnly) as the engine runs them and as config.json
//                           will have them at the next boot, and Which clients the Instagram scan
//                           reads (active or all) the same way
//   PUT  /settings          { graphics?, fonts?, luts?, claudePlanOnly?, instagramClients? } writes those
//                           to config.json and answers like GET. Nothing changes in the running engine until it
//                           restarts. 400 for a body that names no switch or an unknown one; 409 for
//                           a switch an environment variable decides, or a config.json that cannot
//                           be read
//   POST /settings/restart  restarts the engine (answers { ok: true } first). 409 when the engine
//                           does not run as the launchd agent, which is what brings it back up
//
// Every route is for admins: an editor gets 403 "Not allowed.". Every error answers
// `{ error: string }` (the shared `apiErrorSchema`).

import { updateSettingsRequestSchema } from '@studio/shared';
import { type Context, Hono } from 'hono';
import { type FeatureSettings, SettingsError } from '../settings/feature-settings.js';
import { requireAdmin } from './team.js';

export interface SettingsRouteOptions {
  settings: FeatureSettings;
  /**
   * Restarts the engine: it stops, and the launchd agent starts it again. `null` when the engine
   * has no agent to start it again (a dev server), so it cannot restart itself.
   */
  restart: (() => void) | null;
  /** Wait between the answer and the restart, so the browser gets the answer. Default 300 ms. */
  restartDelayMs?: number;
}

export const SETTINGS_MESSAGES = {
  noRestart: "This engine isn't running as the Studio Engine agent, so it can't restart itself.",
  badBody: 'Say which switch to change: graphics, fonts, luts or claudePlanOnly, true or false.',
} as const;

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createSettingsRoutes(options: SettingsRouteOptions): Hono {
  const { settings, restart, restartDelayMs = 300 } = options;
  const routes = new Hono();
  const canRestart = restart !== null;

  routes.get('/', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    return c.json(settings.response(canRestart));
  });

  routes.put('/', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const parsed = updateSettingsRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: SETTINGS_MESSAGES.badBody }, 400);
    try {
      settings.write(parsed.data);
    } catch (err) {
      if (err instanceof SettingsError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    return c.json(settings.response(canRestart));
  });

  routes.post('/restart', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    if (restart === null) return c.json({ error: SETTINGS_MESSAGES.noRestart }, 409);
    // After the answer is out: the restart closes the server.
    setTimeout(restart, restartDelayMs).unref();
    return c.json({ ok: true });
  });

  return routes;
}
