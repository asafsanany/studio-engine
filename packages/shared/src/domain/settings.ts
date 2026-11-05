import { z } from 'zod';

/**
 * The switches the Settings page can change: the pages the owner does not always want in the sidebar
 * (graphics, fonts, luts) and how the engine's Claude runs are billed (`claudePlanOnly`: on, the
 * default, they use the claude.ai plan login only; off, they bill the API key in .env). Each is the
 * engine's own switch of that name (`Config.graphics`, `Config.fonts`, `Config.luts`,
 * `Config.claudePlanOnly`), kept in `~/.studio-engine/config.json`. The engine builds what is
 * behind a switch once at boot, so a change counts after the engine restarts.
 *
 * `draftChat` (Draft & chat, DR1) is the one switch that is off until it is turned on: an edit is
 * one video-use run that reads the instructions itself, and Review is the job's chat.
 *
 * `twoJobsAtOnce` (`Config.twoJobsAtOnce`): on, the queue edits two jobs at the same time; off, one
 * after another as before.
 *
 * `quickFixes` (`Config.quickFixes`, on since v0.43.0): with Auto effort in Review, a small pass
 * sorts each note and fixes the ones that only change the composition at once; off, every note
 * waits for Send.
 *
 * `instagram` (Clients × Instagram, IG0) is on since the acceptance run (IG15, v0.66.0): the weekly
 * Instagram scan, the client page's Instagram section and the clients' Instagram photos.
 *
 * `instagramClients` (IG4, "Which clients" in Settings › Instagram) is not a switch but a choice that
 * is kept the same way: `active` (the default) scans only the clients with a job added or delivered
 * in the last 60 days, `all` scans every client with an Instagram account.
 */
export const FEATURE_SWITCH_KEYS = [
  'graphics',
  'fonts',
  'luts',
  'claudePlanOnly',
  'draftChat',
  'twoJobsAtOnce',
  'quickFixes',
  'instagram',
] as const;
export const featureSwitchKeySchema = z.enum(FEATURE_SWITCH_KEYS);
export type FeatureSwitchKey = z.infer<typeof featureSwitchKeySchema>;

/**
 * What a switch is when neither the environment nor config.json says: on, except Draft & chat.
 */
export const FEATURE_SWITCH_DEFAULTS: Record<FeatureSwitchKey, boolean> = {
  graphics: true,
  fonts: true,
  luts: true,
  claudePlanOnly: true,
  draftChat: false,
  twoJobsAtOnce: true,
  quickFixes: true,
  instagram: true,
};

/** Which clients the weekly Instagram scan reads: the active ones, or every client with an account. */
export const INSTAGRAM_CLIENTS_CHOICES = ['active', 'all'] as const;
export const instagramClientsSchema = z.enum(INSTAGRAM_CLIENTS_CHOICES);
export type InstagramClients = z.infer<typeof instagramClientsSchema>;

/** What Which clients is when neither the environment nor config.json says. */
export const DEFAULT_INSTAGRAM_CLIENTS: InstagramClients = 'active';

/** How many days back a job added or delivered makes its client active. */
export const INSTAGRAM_ACTIVE_DAYS = 60;

/** One switch, as `GET /api/settings` tells it. */
export const featureSwitchSchema = z.object({
  key: featureSwitchKeySchema,
  /** What the engine is doing now. */
  running: z.boolean(),
  /**
   * What it does after the next restart: the environment's word, else config.json's, else its
   * default (`FEATURE_SWITCH_DEFAULTS`).
   */
  saved: z.boolean(),
  /** An environment variable (`STUDIO_GRAPHICS`…) decides it, so config.json cannot change it. */
  lockedByEnv: z.boolean(),
});
export type FeatureSwitch = z.infer<typeof featureSwitchSchema>;

/**
 * Which clients the Instagram scan reads, as `GET /api/settings` tells it: what the engine is doing
 * now, what it does after the next restart, and whether `STUDIO_INSTAGRAM_CLIENTS` decides it.
 */
export const instagramClientsSettingSchema = z.object({
  running: instagramClientsSchema,
  saved: instagramClientsSchema,
  lockedByEnv: z.boolean(),
});
export type InstagramClientsSetting = z.infer<typeof instagramClientsSettingSchema>;

/** `GET /api/settings` (admin only), and the answer to `PUT /api/settings`. */
export const settingsResponseSchema = z.object({
  features: z.array(featureSwitchSchema),
  /** Which clients the Instagram scan reads (IG4). The engine always sends it; optional for fixtures that predate it. */
  instagramClients: instagramClientsSettingSchema.optional(),
  /** The engine can restart itself (it runs as the launchd agent). Otherwise the user restarts it. */
  canRestart: z.boolean(),
});
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

/**
 * `PUT /api/settings` body: the switches to change, at least one. A key that is left out stays as
 * it is.
 */
export const updateSettingsRequestSchema = z
  .strictObject({
    graphics: z.boolean().optional(),
    fonts: z.boolean().optional(),
    luts: z.boolean().optional(),
    claudePlanOnly: z.boolean().optional(),
    draftChat: z.boolean().optional(),
    twoJobsAtOnce: z.boolean().optional(),
    quickFixes: z.boolean().optional(),
    instagram: z.boolean().optional(),
    instagramClients: instagramClientsSchema.optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'Say which switch to change.',
  });
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

/** Whether a switch (or the choice of Which clients) will change when the engine restarts. */
export function featureNeedsRestart(
  feature: Pick<FeatureSwitch | InstagramClientsSetting, 'running' | 'saved'>,
): boolean {
  return feature.running !== feature.saved;
}

/** Whether the engine has to restart for the settings to count. */
export function settingsNeedRestart(
  settings: Pick<SettingsResponse, 'features' | 'instagramClients'>,
): boolean {
  return (
    settings.features.some(featureNeedsRestart) ||
    (settings.instagramClients !== undefined && featureNeedsRestart(settings.instagramClients))
  );
}
