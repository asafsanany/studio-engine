import type { MoneyFileState } from '@studio/shared';
import { TriangleAlert } from 'lucide-react';

/** What the line says while money.json has a mistake and the last good numbers are shown. */
export const MONEY_FILE_LAST_GOOD_TEXT =
  'money.json has a mistake, so this page shows the last good numbers. Run pnpm run doctor to see it.';

/** What it says when there is no good version either, so the numbers are only the defaults. */
export const MONEY_FILE_DEFAULTS_TEXT =
  'money.json has a mistake and no good version is saved, so prices and expenses are defaults and Mark delivered is off. Run pnpm run doctor.';

/**
 * The one line under the Money page's title when money.json has a mistake: a warning icon and the
 * sentence in the warning colour (the amber of a held job), with the first problem in the file
 * under it in muted text. No box and no buttons: it only says so; the doctor shows the rest.
 * Nothing at all while the file is fine.
 */
export function MoneyFileWarning({ moneyFile }: { moneyFile: MoneyFileState }) {
  if (moneyFile.status === 'ok') return null;
  return (
    <div
      role="status"
      data-money-file={moneyFile.status}
      className="-mt-2 flex items-start gap-2 text-[13px] leading-5"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-held" />
      <div className="min-w-0">
        <p className="text-status-held">
          {moneyFile.status === 'defaults' ? MONEY_FILE_DEFAULTS_TEXT : MONEY_FILE_LAST_GOOD_TEXT}
        </p>
        {moneyFile.issue !== null && (
          <p className="text-muted-foreground [overflow-wrap:anywhere]">{moneyFile.issue}</p>
        )}
      </div>
    </div>
  );
}
