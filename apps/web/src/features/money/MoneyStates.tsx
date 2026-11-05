import { Button } from '@/components/ui/button';

/**
 * How long the Money page waits before it draws grey placeholders for a first load. A local answer
 * usually takes a few tens of milliseconds, and placeholders that blink in and out for that long
 * look like a flash; after this long the wait is real.
 */
export const MONEY_SKELETON_DELAY_MS = 300;

/** The room the banners take, so the page below them does not jump when they arrive. */
export const BANNERS_MIN_HEIGHT = 'min-h-[196px]';

/**
 * "Can't reach the engine." with "Try again", the way the Jobs table says it: the first load of
 * the month failed, and nothing is on screen to keep showing.
 */
export function MoneyUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className={`${BANNERS_MIN_HEIGHT} flex items-center justify-center rounded-[12px] border text-center text-muted-foreground`}
    >
      <p>
        <span role="alert">Can't reach the engine.</span>{' '}
        <Button
          type="button"
          variant="link"
          onClick={onRetry}
          className="h-auto p-0 text-blue-300 underline hover:text-blue-200"
        >
          Try again
        </Button>
      </p>
    </div>
  );
}
