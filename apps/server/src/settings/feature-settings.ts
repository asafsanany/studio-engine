// The switches of the Settings page (Graphics, Fonts, LUTs, Claude plan only, Draft & chat, Two
// jobs at once, Quick fixes, Clients × Instagram) and the choice beside the last one, Which clients the
// Instagram scan reads (`instagramClients`, active or all): what the engine
// runs now, what config.json says for the next boot, and the write that changes it.
//
// The switches are the engine's own (`Config.graphics`, `Config.claudePlanOnly`…). The engine builds what is behind them once
// at boot, so a change here is written to ~/.studio-engine/config.json and counts after a restart.
// An environment variable (`STUDIO_GRAPHICS`, `STUDIO_CLAUDE_PLAN_ONLY`…) beats config.json at boot, so a switch it decides is
// told as locked and refuses a write.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  DEFAULT_INSTAGRAM_CLIENTS,
  FEATURE_SWITCH_DEFAULTS,
  FEATURE_SWITCH_KEYS,
  type FeatureSwitch,
  type FeatureSwitchKey,
  INSTAGRAM_CLIENTS_CHOICES,
  type InstagramClients,
  type InstagramClientsSetting,
  type SettingsResponse,
  type UpdateSettingsRequest,
} from '@studio/shared';

/** The environment variable that decides each switch at boot (see config.ts). */
export const FEATURE_ENV: Record<FeatureSwitchKey, string> = {
  graphics: 'STUDIO_GRAPHICS',
  fonts: 'STUDIO_FONTS',
  luts: 'STUDIO_LUTS',
  claudePlanOnly: 'STUDIO_CLAUDE_PLAN_ONLY',
  draftChat: 'STUDIO_DRAFT_CHAT',
  twoJobsAtOnce: 'STUDIO_TWO_JOBS_AT_ONCE',
  quickFixes: 'STUDIO_QUICK_FIXES',
  instagram: 'STUDIO_INSTAGRAM',
};

/** The environment variable that decides Which clients at boot (see config.ts). */
export const INSTAGRAM_CLIENTS_ENV = 'STUDIO_INSTAGRAM_CLIENTS';

/** Why a write was refused; `status` is the HTTP answer the route gives. */
export class SettingsError extends Error {
  readonly status: 409 | 500;

  constructor(message: string, status: 409 | 500 = 409) {
    super(message);
    this.name = 'SettingsError';
    this.status = status;
  }
}

export interface FeatureSettingsOptions {
  /** `<home>/.studio-engine/config.json`: where the switches are kept. */
  configPath: string;
  /** What the engine booted with. */
  running: Record<FeatureSwitchKey, boolean>;
  /** Which clients the Instagram scan reads, as the engine booted (`Config.instagramClients`). Default: active. */
  instagramClients?: InstagramClients;
  /** The environment the engine booted in. */
  env?: Record<string, string | undefined>;
}

/** The choice an environment variable gives (active or all), or undefined when it gives none. */
function choiceValue(raw: string | undefined): InstagramClients | undefined {
  const value = raw?.trim().toLowerCase();
  return INSTAGRAM_CLIENTS_CHOICES.find((choice) => choice === value);
}

/** The value an environment variable gives (1/true or 0/false), or undefined when it gives none. */
function envValue(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

export class FeatureSettings {
  private readonly env: Record<string, string | undefined>;

  constructor(private readonly options: FeatureSettingsOptions) {
    this.env = options.env ?? process.env;
  }

  /** The switches as they are now. A config.json that cannot be read counts as saying nothing. */
  read(): FeatureSwitch[] {
    let file: Record<string, unknown> = {};
    try {
      file = this.readFile();
    } catch {
      // The next boot would refuse such a file; the page still shows what is running.
    }
    return FEATURE_SWITCH_KEYS.map((key) => {
      const fromEnv = envValue(this.env[FEATURE_ENV[key]]);
      const fromFile = typeof file[key] === 'boolean' ? file[key] : undefined;
      return {
        key,
        running: this.options.running[key],
        saved: fromEnv ?? fromFile ?? FEATURE_SWITCH_DEFAULTS[key],
        lockedByEnv: fromEnv !== undefined,
      };
    });
  }

  /** Which clients the Instagram scan reads, as it is now and as config.json will have it at the next boot. */
  readInstagramClients(): InstagramClientsSetting {
    let file: Record<string, unknown> = {};
    try {
      file = this.readFile();
    } catch {
      // As for the switches: the page still shows what is running.
    }
    const fromEnv = choiceValue(this.env[INSTAGRAM_CLIENTS_ENV]);
    const fromFile = choiceValue(
      typeof file.instagramClients === 'string' ? file.instagramClients : undefined,
    );
    return {
      running: this.options.instagramClients ?? DEFAULT_INSTAGRAM_CLIENTS,
      saved: fromEnv ?? fromFile ?? DEFAULT_INSTAGRAM_CLIENTS,
      lockedByEnv: fromEnv !== undefined,
    };
  }

  /**
   * Writes the switches in `patch` to config.json, leaving every other key as it is. Refuses a
   * switch an environment variable decides, and a config.json that is not a JSON object.
   */
  write(patch: UpdateSettingsRequest): void {
    const locked = this.read().filter((feature) => feature.lockedByEnv);
    for (const feature of locked) {
      if (patch[feature.key] === undefined) continue;
      throw new SettingsError(
        `${FEATURE_ENV[feature.key]} is set in the engine's environment, so it can't be changed here.`,
      );
    }

    if (patch.instagramClients !== undefined && this.readInstagramClients().lockedByEnv) {
      throw new SettingsError(
        `${INSTAGRAM_CLIENTS_ENV} is set in the engine's environment, so it can't be changed here.`,
      );
    }
    const file = this.readFile();
    for (const key of FEATURE_SWITCH_KEYS) {
      const value = patch[key];
      if (value !== undefined) file[key] = value;
    }
    if (patch.instagramClients !== undefined) file.instagramClients = patch.instagramClients;

    // Written beside the file and moved over it, so a crash never leaves half a config.json.
    const temp = `${this.options.configPath}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`);
      renameSync(temp, this.options.configPath);
    } catch (err) {
      throw new SettingsError(
        `Couldn't save config.json: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
  }

  /** The answer of `GET /api/settings`. */
  response(canRestart: boolean): SettingsResponse {
    return { features: this.read(), instagramClients: this.readInstagramClients(), canRestart };
  }

  private readFile(): Record<string, unknown> {
    const { configPath } = this.options;
    if (!existsSync(configPath)) return {};
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      throw new SettingsError(`config.json can't be read as JSON. Fix it first: ${configPath}`);
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new SettingsError(`config.json is not a JSON object. Fix it first: ${configPath}`);
    }
    return json as Record<string, unknown>;
  }
}
