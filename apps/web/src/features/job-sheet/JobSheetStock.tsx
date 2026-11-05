import { useJobStock } from '@/data';
import { cn } from '@/lib/utils';
import { STOCK_TEXT, type StockRowView, sheetStock } from './sheet-stock';
import type { SheetVariant } from './sheet-variant';

const LINK = 'underline-offset-2 hover:underline focus-visible:underline';

/** The part as it looks: the heading, then a row for each sound effect or photo a run took. */
export function StockPanel({
  rows,
  variant = 'mac',
}: {
  rows: readonly StockRowView[];
  variant?: SheetVariant;
}) {
  const phone = variant === 'phone';
  return (
    <section
      aria-label={STOCK_TEXT.heading}
      data-slot="job-sheet-stock"
      className="flex flex-col gap-0.5"
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium text-muted-foreground">{STOCK_TEXT.heading}</h3>
        <span className="text-xs text-zinc-500">{STOCK_TEXT.sources}</span>
      </div>
      <dl>
        {rows.map((row) => (
          <div
            key={row.id}
            data-stock={row.id}
            className={cn(
              'grid items-baseline gap-x-3',
              phone
                ? 'min-h-8 grid-cols-[112px_minmax(0,1fr)] py-1'
                : 'min-h-7 grid-cols-[96px_minmax(0,1fr)] py-[3px]',
            )}
          >
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd dir="auto" className="text-left [unicode-bidi:plaintext] wrap-anywhere">
              <a href={row.href} target="_blank" rel="noopener noreferrer" className={LINK}>
                {row.title}
              </a>
            </dd>
            <dd
              dir="auto"
              className="col-start-2 -mt-px text-left text-[13px] text-pretty text-muted-foreground [unicode-bidi:plaintext] wrap-anywhere"
            >
              {row.creator !== '' &&
                (row.creatorHref === null ? (
                  row.creator
                ) : (
                  <a
                    href={row.creatorHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={LINK}
                  >
                    {row.creator}
                  </a>
                ))}
              {row.creator !== '' && ' · '}
              {row.detail}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The sheet's "Stock media" part (Stock media, ST6): the sound effects and photos the job's runs took
 * from Openverse and Unsplash, with who made them and their license, as the credits to keep. It reads
 * the job's own record, kept current by the job's changes, and shows nothing for a job that took none.
 */
export function JobSheetStock({
  job,
  variant = 'mac',
}: {
  job: { id: string };
  variant?: SheetVariant;
}) {
  const stock = useJobStock(job.id);
  const rows = stock.data === undefined ? null : sheetStock(stock.data.items);
  return rows === null ? null : <StockPanel rows={rows} variant={variant} />;
}
