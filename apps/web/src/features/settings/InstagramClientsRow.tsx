import {
  featureNeedsRestart,
  INSTAGRAM_CLIENTS_CHOICES,
  type InstagramClients,
  type InstagramClientsSetting,
} from '@studio/shared';
import { useId } from 'react';
import {
  INSTAGRAM_CLIENTS_TEXT,
  instagramClientsHint,
  instagramClientsPendingText,
} from './settings-text';

/**
 * "Which clients" under the weekly Instagram scan (board CLStates S7): Active | All, in the look of
 * the Instagram section's range switch (a muted track, the chosen one raised), with what each means
 * under the name. It shows what is saved; a saved change that the running engine does not have yet
 * is said under the row (the restart notice is the Settings page's). Locked when an environment
 * variable (`STUDIO_INSTAGRAM_CLIENTS`) decides it.
 */
export function InstagramClientsRow({
  setting,
  chosen = setting.saved,
  disabled,
  onChange,
}: {
  setting: InstagramClientsSetting;
  /** What the row shows as chosen: the saved one, or the one being saved. */
  chosen?: InstagramClients;
  disabled: boolean;
  onChange: (choice: InstagramClients) => void;
}) {
  const id = useId();
  const locked = setting.lockedByEnv;
  return (
    <div data-slot="instagram-clients-row" className="flex items-center gap-4 px-4 py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={id} className="font-medium">
          {INSTAGRAM_CLIENTS_TEXT.label}
        </span>
        <p className="text-sm text-muted-foreground">{instagramClientsHint(chosen)}</p>
        {locked ? (
          <p className="text-sm text-muted-foreground">
            Set by the engine’s environment, so it can’t be changed here.
          </p>
        ) : featureNeedsRestart(setting) ? (
          <p className="text-sm text-muted-foreground">
            {instagramClientsPendingText(setting.saved)}
          </p>
        ) : null}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings a border, padding and a legend; this is only a named group of buttons */}
      <div
        role="group"
        aria-labelledby={id}
        className="inline-flex flex-none rounded-lg bg-muted p-[3px]"
      >
        {INSTAGRAM_CLIENTS_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={chosen === choice}
            disabled={disabled || locked}
            onClick={() => {
              if (chosen !== choice) onChange(choice);
            }}
            className="h-[29px] cursor-pointer rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-in-out outline-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-foreground/30 disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-[0_1px_2px_rgba(0,0,0,0.3)]"
          >
            {INSTAGRAM_CLIENTS_TEXT[choice]}
          </button>
        ))}
      </div>
    </div>
  );
}
