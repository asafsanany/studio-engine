import type { SettingsResponse } from '@studio/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from './api';
import { HEALTH_KEY } from './health-query';
import {
  restartEngineMutationOptions,
  saveSettingsMutationOptions,
  waitForEngine,
} from './settings-mutations';
import { SETTINGS_KEY } from './settings-query';

const settings = (savedFonts: boolean): SettingsResponse => ({
  features: [
    { key: 'graphics', running: true, saved: true, lockedByEnv: false },
    { key: 'fonts', running: true, saved: savedFonts, lockedByEnv: false },
    { key: 'luts', running: true, saved: true, lockedByEnv: false },
  ],
  canRestart: true,
});

// Restarted: the fonts switch is off now, and saved off too.
const restarted: SettingsResponse = {
  ...settings(false),
  features: settings(false).features.map((f) => (f.key === 'fonts' ? { ...f, running: false } : f)),
};

const noWait = async () => {};

describe('waitForEngine', () => {
  it('asks again while the engine is down or still the old one, and answers once it is back', async () => {
    const getSettings = vi
      .fn<Api['getSettings']>()
      .mockResolvedValueOnce(settings(false)) // still the old engine
      .mockRejectedValueOnce(new Error('connection refused')) // down
      .mockResolvedValueOnce(restarted);
    await expect(waitForEngine({ getSettings }, { sleep: noWait })).resolves.toEqual(restarted);
    expect(getSettings).toHaveBeenCalledTimes(3);
  });

  it('gives up when the engine never comes back', async () => {
    const getSettings = vi.fn<Api['getSettings']>().mockRejectedValue(new Error('down'));
    await expect(
      waitForEngine({ getSettings }, { sleep: noWait, intervalMs: 100, timeoutMs: 300 }),
    ).rejects.toThrow('did not come back');
    expect(getSettings).toHaveBeenCalledTimes(4);
  });
});

describe('saveSettingsMutationOptions', () => {
  it('puts the saved settings into the query', async () => {
    const queryClient = new QueryClient();
    const api = { saveSettings: vi.fn().mockResolvedValue(settings(false)) } as unknown as Api;
    const options = saveSettingsMutationOptions({ queryClient, api });
    const answer = await options.mutationFn?.({ fonts: false }, undefined as never);
    expect(api.saveSettings).toHaveBeenCalledWith({ fonts: false });
    await options.onSuccess?.(answer as SettingsResponse, { fonts: false }, undefined, {} as never);
    expect(queryClient.getQueryData(SETTINGS_KEY)).toEqual(settings(false));
  });
});

describe('restartEngineMutationOptions', () => {
  it('restarts, waits for the engine, then loads the health answer again', async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const api = { restartEngine: vi.fn().mockResolvedValue(undefined) } as unknown as Api;
    const wait = vi.fn().mockResolvedValue(restarted);
    const options = restartEngineMutationOptions({ queryClient, api, wait });
    const answer = await options.mutationFn?.(undefined, undefined as never);
    expect(api.restartEngine).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(api);
    await options.onSuccess?.(answer as SettingsResponse, undefined, undefined, {} as never);
    expect(queryClient.getQueryData(SETTINGS_KEY)).toEqual(restarted);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: HEALTH_KEY });
  });

  it('does not wait when the restart is refused', async () => {
    const queryClient = new QueryClient();
    const api = {
      restartEngine: vi.fn().mockRejectedValue(new Error('No agent.')),
    } as unknown as Api;
    const wait = vi.fn();
    const options = restartEngineMutationOptions({ queryClient, api, wait });
    await expect(options.mutationFn?.(undefined, undefined as never)).rejects.toThrow('No agent.');
    expect(wait).not.toHaveBeenCalled();
  });
});
