/**
 * The two-choice switch of the phone's Money page (boards MMoney, MMoneyWarn): a muted track with
 * two equal halves, the chosen one raised on the page's colour. "Every job | By client" over the
 * Ledger and "Items | All charges" over the Expenses. Plain pressed-buttons, since it switches how
 * one list is shown and has no panels. A grey keyboard-only focus line; a tap leaves no ring.
 */
export function PhoneSegmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** The name of the group, for a screen reader ("Group the ledger"). */
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings a border, padding and a legend; this is only a named group of two buttons
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-2 rounded-lg bg-muted p-[3px] [-webkit-tap-highlight-color:transparent]"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className="h-[34px] cursor-pointer rounded-md text-sm font-medium text-muted-foreground transition-colors duration-150 ease-in-out outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-foreground/30 aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-[0_1px_2px_rgba(0,0,0,0.3)]"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
