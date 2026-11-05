import {
  type FeatureSwitch,
  featureNeedsRestart,
  type SettingsResponse,
  settingsNeedRestart,
  type UpdateSettingsRequest,
} from '@studio/shared';
import { Loader2 } from 'lucide-react';
import { Fragment, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useRestartEngine, useSaveSettings } from '@/data';
import { InstagramClientsRow } from './InstagramClientsRow';
import { FEATURE_TEXT, pendingText, SETTINGS_TEXT, settingsErrorText } from './settings-text';

function FeatureRow({
  feature,
  checked,
  disabled,
  onChange,
}: {
  feature: FeatureSwitch;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  const text = FEATURE_TEXT[feature.key];
  const locked = feature.lockedByEnv;
  return (
    <div
      data-slot="feature-row"
      data-feature={feature.key}
      className="flex items-center gap-4 px-4 py-3.5"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className={locked ? 'font-medium' : 'cursor-pointer font-medium'}>
          {text.label}
        </label>
        <p className="text-sm text-muted-foreground">{text.description}</p>
        {locked ? (
          <p className="text-sm text-muted-foreground">
            Set by the engine’s environment, so it can’t be changed here.
          </p>
        ) : featureNeedsRestart(feature) ? (
          <p className="text-sm text-muted-foreground">{pendingText(text.label, feature.saved)}</p>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled || locked}
        onCheckedChange={onChange}
        className="cursor-pointer disabled:cursor-not-allowed"
      />
    </div>
  );
}

/** The one switch that is about Claude's billing, not a page: it gets its own section. */
const CLAUDE_KEY = 'claudePlanOnly';

/** The weekly Instagram scan, whose row has Which clients under it. */
const INSTAGRAM_KEY = 'instagram';

/**
 * The switches as lists of rows with a switch each: Features (Graphics, Fonts, LUTs, the weekly
 * Instagram scan with Which clients under it while it is on, …), then Claude (Claude plan only, the
 * billing of every Claude run), and under them the restart that makes the saved switches (and
 * Which clients) count. A switch shows what is saved; a saved change that the running engine does
 * not have yet is said under the row, and the Restart engine button appears. The server's refusals
 * (an environment variable decides, config.json is broken) come back under the lists.
 */
export function FeatureSwitches({ settings }: { settings: SettingsResponse }) {
  const save = useSaveSettings();
  const restart = useRestartEngine();
  const needsRestart = settingsNeedRestart(settings);

  function change(patch: UpdateSettingsRequest) {
    restart.reset();
    save.mutate(patch);
  }

  function list(id: string, title: string, features: FeatureSwitch[]) {
    return (
      <section aria-labelledby={id} className="flex flex-col gap-3">
        <h2 id={id} className="text-sm font-medium text-muted-foreground">
          {title}
        </h2>
        <div className="divide-y rounded-lg border bg-card">
          {features.map((feature) => {
            const asked = save.isPending ? save.variables?.[feature.key] : undefined;
            const checked = asked ?? feature.saved;
            const busy = save.isPending || restart.isPending;
            return (
              <Fragment key={feature.key}>
                <FeatureRow
                  feature={feature}
                  checked={checked}
                  disabled={busy}
                  onChange={(on) => change({ [feature.key]: on })}
                />
                {/* Which clients (S7) belongs to the weekly Instagram scan: right under its switch, only while that is on. */}
                {feature.key === INSTAGRAM_KEY && checked && settings.instagramClients && (
                  <InstagramClientsRow
                    setting={settings.instagramClients}
                    chosen={
                      (save.isPending ? save.variables?.instagramClients : undefined) ??
                      settings.instagramClients.saved
                    }
                    disabled={busy}
                    onChange={(instagramClients) => change({ instagramClients })}
                  />
                )}
              </Fragment>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-6">
        {list(
          'settings-features',
          SETTINGS_TEXT.featuresTitle,
          settings.features.filter((feature) => feature.key !== CLAUDE_KEY),
        )}
        {list(
          'settings-claude',
          SETTINGS_TEXT.claudeTitle,
          settings.features.filter((feature) => feature.key === CLAUDE_KEY),
        )}
      </div>
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {settingsErrorText(save.error)}
        </p>
      ) : null}
      {needsRestart || restart.isPending || restart.isError ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3"
        >
          <p className="min-w-0 flex-1 text-sm">
            {restart.isError
              ? SETTINGS_TEXT.restartFailed
              : settings.canRestart
                ? SETTINGS_TEXT.restartNeeded
                : SETTINGS_TEXT.cannotRestart}
          </p>
          {settings.canRestart ? (
            <Button
              type="button"
              size="sm"
              className="cursor-pointer"
              disabled={restart.isPending}
              onClick={() => restart.mutate()}
            >
              {restart.isPending ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  {SETTINGS_TEXT.restarting}
                </>
              ) : (
                SETTINGS_TEXT.restart
              )}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
