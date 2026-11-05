import { GRAPHIC_LIMITS, type GraphicDetail } from '@studio/shared';
import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ABOUT_COLUMN_WIDTH } from './studio-columns';
import { detailRows, type TypedValues } from './studio-logic';
import { ABOUT_TEXT } from './studio-text';

interface AboutPanelProps {
  /** `undefined` on /graphics/new, and before v1 the panel only says what will be here. */
  graphic: GraphicDetail | undefined;
  /** What the owner typed in "Text in it" (never saved). */
  typed: TypedValues;
  onType: (id: string, text: string) => void;
  /** Saves the When line (on blur); answers whether the engine took it. */
  onSaveWhen: (text: string) => Promise<boolean>;
  onSetUses: (uses: boolean) => void;
  /** The engine cannot be reached: the controls wait. */
  offline: boolean;
  /** The clock for "Made" (tests pin it). */
  now?: Date;
}

/**
 * The right column (board GRStudio): "Text in it" (one box per text field, to try other text in
 * the preview), "When edits use it" (saved when the box is left) with the "Edits can use it"
 * switch, and Details. Before v1 it only says that these show once v1 is ready.
 */
export function AboutPanel({
  graphic,
  typed,
  onType,
  onSaveWhen,
  onSetUses,
  offline,
  now = new Date(),
}: AboutPanelProps) {
  // What the owner is typing in the When box; `null` follows the engine's value.
  const [whenDraft, setWhenDraft] = useState<string | null>(null);
  const fieldId = useId();

  return (
    <aside
      data-slot="about-panel"
      aria-label={ABOUT_TEXT.label}
      className={cn(
        'flex flex-none flex-col gap-7 overflow-y-auto border-l p-5',
        ABOUT_COLUMN_WIDTH,
      )}
    >
      {graphic === undefined || graphic.version === null ? (
        <p className="m-0 text-[13px] text-zinc-500">{ABOUT_TEXT.beforeV1}</p>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="m-0 text-sm font-semibold">{ABOUT_TEXT.textTitle}</h2>
              <p className="m-0 text-[13px] text-muted-foreground">
                {graphic.variables.length === 0 ? ABOUT_TEXT.noText : ABOUT_TEXT.textHint}
              </p>
            </div>
            {graphic.variables.map((variable) => (
              <div
                key={variable.id}
                className="flex flex-col gap-1.5 text-[13px] text-muted-foreground"
              >
                <label htmlFor={`${fieldId}-${variable.id}`}>{variable.label}</label>
                <Input
                  id={`${fieldId}-${variable.id}`}
                  dir="auto"
                  value={typed[variable.id] ?? variable.default}
                  onChange={(event) => onType(variable.id, event.target.value)}
                  className="h-[34px] px-2.5 text-sm text-foreground [unicode-bidi:plaintext]"
                />
              </div>
            ))}
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="m-0 text-sm font-semibold">{ABOUT_TEXT.whenTitle}</h2>
              <p className="m-0 text-[13px] text-muted-foreground">{ABOUT_TEXT.whenHint}</p>
            </div>
            <Textarea
              dir="auto"
              rows={2}
              aria-label={ABOUT_TEXT.whenLabel}
              maxLength={GRAPHIC_LIMITS.whenMax}
              disabled={offline}
              value={whenDraft ?? graphic.when}
              onChange={(event) => setWhenDraft(event.target.value)}
              onBlur={() => {
                if (whenDraft === null) return;
                const text = whenDraft;
                // The box follows the engine again once its answer is in; a refusal keeps the text.
                void onSaveWhen(text).then((saved) => {
                  if (saved) setWhenDraft(null);
                });
              }}
              className="min-h-0 resize-none px-2.5 py-2 leading-[1.45] [unicode-bidi:plaintext]"
            />
            <div className="flex items-center justify-between gap-3">
              <span id="graphic-uses-label">{ABOUT_TEXT.usesLabel}</span>
              <Switch
                aria-labelledby="graphic-uses-label"
                checked={graphic.uses}
                disabled={offline}
                onCheckedChange={onSetUses}
              />
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-sm font-semibold">{ABOUT_TEXT.detailsTitle}</h2>
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
              {detailRows(graphic, now).map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd
                    dir="auto"
                    className="m-0 text-right [overflow-wrap:anywhere] [unicode-bidi:plaintext]"
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      )}
    </aside>
  );
}
