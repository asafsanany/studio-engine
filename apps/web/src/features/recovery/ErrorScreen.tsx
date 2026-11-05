import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  browserSessionStorage,
  CHUNK_RELOAD_KEY,
  isChunkLoadError,
  reloadGuarded,
} from './recovery';

/** Reloads the page. The one thing every recovery screen's button does. */
export function reloadPage(): void {
  window.location.reload();
}

/**
 * What replaces the app when a render throws (CVP-317): a readable message and a Reload button, on
 * the dark page, in place of an empty screen. A page that asked for a script or stylesheet that is
 * gone (it stayed open across a release) reloads itself once; if that does not help, the button is
 * there. Used by the root boundary and by the router, for the Mac layout and the phone alike.
 */
export function ErrorScreen({ error }: { error?: unknown }) {
  const chunkError = isChunkLoadError(error);
  useEffect(() => {
    if (!chunkError) return;
    reloadGuarded({
      storage: browserSessionStorage(),
      key: CHUNK_RELOAD_KEY,
      now: Date.now(),
      reload: reloadPage,
    });
  }, [chunkError]);

  return <ErrorView detail={errorDetail(error)} onReload={reloadPage} />;
}

/** One line about what failed, for the person to read out; empty when there is nothing useful. */
export function errorDetail(error: unknown): string {
  if (error === undefined || error === null) return '';
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** The screen itself. Pure: the reload comes in as a prop. */
export function ErrorView({ detail, onReload }: { detail: string; onReload: () => void }) {
  return (
    <div
      data-slot="error-screen"
      role="alert"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground"
    >
      <h1 className="text-base font-semibold">Something went wrong</h1>
      <p className="max-w-xs text-sm text-muted-foreground">
        Studio Engine hit a problem drawing this page. Reloading usually fixes it.
      </p>
      {detail !== '' && (
        <p className="max-w-xs break-words font-mono text-xs text-muted-foreground">{detail}</p>
      )}
      <Button type="button" onClick={onReload} className="mt-2 h-11 px-5">
        Reload
      </Button>
    </div>
  );
}
