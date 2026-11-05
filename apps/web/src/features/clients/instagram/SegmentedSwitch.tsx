/**
 * A segmented control over the Instagram section's views: a muted track with the chosen one raised,
 * in the look of the Analytics page's Week | Month. Plain pressed-buttons, since it changes how the
 * section's numbers are counted or which of its rows are shown and has no panels. A view control,
 * not an action: it changes what the section shows and nothing else. A grey keyboard-only focus
 * line; a click leaves no ring. `label` names the group (the range, the reels' filter).
 */
export function SegmentedSwitch<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: Value; label: string }>;
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings a border, padding and a legend; this is only a named group of buttons
    <div
      role="group"
      aria-label={label}
      className="inline-flex flex-none rounded-lg bg-muted p-[3px]"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className="h-[29px] rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-in-out outline-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-foreground/30 aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-[0_1px_2px_rgba(0,0,0,0.3)]"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
