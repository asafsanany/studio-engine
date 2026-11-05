// The Settings page's actions: save a switch, and restart the engine so the saved switches count.
// A save only writes config.json (the running engine is unchanged), so it puts the engine's answer
// straight into the query. A restart waits for the engine to come back with its switches as saved,
// then loads the health answer again, which is what the sidebar and the routes read.

import {
  type SettingsResponse,
  settingsNeedRestart,
  type UpdateSettingsRequest,
} from '@studio/shared';
import {
  mutationOptions,
  type QueryClient,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { type Api, type ApiError, api } from './api';
import { HEALTH_KEY } from './health-query';
import { SETTINGS_KEY } from './settings-query';

/** First element of each settings mutation's key. */
export const SETTINGS_MUTATION_KEYS = {
  save: 'save-settings',
  restart: 'restart-engine',
} as const;

/** How often the restarting engine is asked whether it is back, and how long it gets. */
export const RESTART_POLL_MS = 700;
export const RESTART_TIMEOUT_MS = 90_000;

export interface WaitForEngineOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Asks the engine for its settings until it answers with every switch running as saved, which only
 * a restarted engine does. An engine that is down (or still the old one) is asked again; it gets
 * `timeoutMs`, then this rejects.
 */
export async function waitForEngine(
  client: Pick<Api, 'getSettings'>,
  {
    intervalMs = RESTART_POLL_MS,
    timeoutMs = RESTART_TIMEOUT_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: WaitForEngineOptions = {},
): Promise<SettingsResponse> {
  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    await sleep(intervalMs);
    try {
      const settings = await client.getSettings();
      if (!settingsNeedRestart(settings)) return settings;
    } catch {
      // Down while it restarts.
    }
  }
  throw new Error('The engine did not come back in time.');
}

export interface SettingsMutationParams {
  queryClient: QueryClient;
  api: Api;
}

/** Save switches: resolves with the settings as saved; a refusal is an `ApiError` with the server's words. */
export function saveSettingsMutationOptions({ queryClient, api: client }: SettingsMutationParams) {
  return mutationOptions<SettingsResponse, ApiError, UpdateSettingsRequest>({
    mutationKey: [SETTINGS_MUTATION_KEYS.save],
    mutationFn: (patch) => client.saveSettings(patch),
    onSuccess: (settings) => {
      queryClient.setQueryData(SETTINGS_KEY, settings);
    },
  });
}

/** Restart the engine and wait for it to come back. */
export function restartEngineMutationOptions({
  queryClient,
  api: client,
  wait = waitForEngine,
}: SettingsMutationParams & { wait?: typeof waitForEngine }) {
  return mutationOptions<SettingsResponse, Error, void>({
    mutationKey: [SETTINGS_MUTATION_KEYS.restart],
    mutationFn: async () => {
      await client.restartEngine();
      return wait(client);
    },
    onSuccess: async (settings) => {
      queryClient.setQueryData(SETTINGS_KEY, settings);
      await queryClient.invalidateQueries({ queryKey: HEALTH_KEY });
    },
  });
}

export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation(saveSettingsMutationOptions({ queryClient, api }));
}

export function useRestartEngine() {
  const queryClient = useQueryClient();
  return useMutation(restartEngineMutationOptions({ queryClient, api }));
}
