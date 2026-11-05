import type { Job } from '@studio/shared';
import { useCanGoBack, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WhatsNew } from '@/components/whats-new/WhatsNew';
import { PreviewViewerHost } from '@/features/review/PreviewViewerHost';
import { cn } from '@/lib/utils';
import { PhoneJobSheetHost } from './PhoneJobSheetHost';
import { PhoneOffline } from './PhoneOffline';
import { PhoneTabBar } from './PhoneTabBar';
import { hasPhoneLayout } from './phone-pages';
import { showsTabBar } from './phone-tabs';
import { PhonePush } from './push/PhonePush';
import { PhoneReviewHost } from './review/PhoneReviewHost';

/**
 * The frame of every page on the phone, in place of the sidebar shell (App renders it when
 * `usePhoneLayout()` is true). Top to bottom: the top safe-area inset, the page (inside the offline
 * screen's reach, PH5) and the tab bar's slot (PH18, PH19: Jobs, Clients and Money; the slot is empty, and
 * hidden, on a page that belongs to no tab), with the phone job sheet's host (PH4) and the phone
 * Review's (PH8) beside them. It also mounts "What's new" as a bottom sheet (the Mac shell mounts
 * it as a dialog), which opens over the page for the releases not seen yet and again from the
 * "What's new" row in Settings, and the
 * notifications' unseen part (PH12: the service worker, a tapped notification, the app badge). And
 * the one toaster (PH16), so a message shows from a sheet opened on any page; the pages that mount
 * a toaster on the Mac (Jobs, a client, a series) leave theirs out under this shell.
 *
 * A page with no phone layout yet (a series, Analytics) is the Mac's page, shown here under a
 * "‹ Back" header so nothing is out of reach; a phone page (the jobs list, Clients, a client, its
 * Style, Money, Settings) brings its own header. `jobs` is the live list from App, for the job sheet's host.
 *
 * While it is up, the page is marked `data-phone-layout` (on <html>, so the sheets, which render
 * outside the shell, are marked too): a long press selects no text there, as in a native app
 * (index.css).
 *
 * Mobile plan §5. The shell is pinned to the four edges of the screen (`fixed inset-0`, not a
 * `dvh` height, which comes out short in an iPhone's Home Screen app and leaves a gap under the tab
 * bar) and the page area scrolls inside it; the document does not scroll, so the top inset and the
 * tab bar never move.
 */
/** On <html> while the phone shell is up (index.css reads it). */
export const PHONE_LAYOUT_ATTRIBUTE = 'data-phone-layout';

/** On <html> while the tab bar shows, so the messages (index.css) sit above it. */
export const PHONE_TAB_BAR_ATTRIBUTE = 'data-phone-tab-bar';

export function PhoneShell({
  jobs,
  children,
}: {
  jobs: readonly Job[] | undefined;
  children: ReactNode;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => {
    document.documentElement.setAttribute(PHONE_LAYOUT_ATTRIBUTE, '');
    return () => document.documentElement.removeAttribute(PHONE_LAYOUT_ATTRIBUTE);
  }, []);
  const tabBar = showsTabBar(pathname);
  useEffect(() => {
    document.documentElement.toggleAttribute(PHONE_TAB_BAR_ATTRIBUTE, tabBar);
    return () => document.documentElement.removeAttribute(PHONE_TAB_BAR_ATTRIBUTE);
  }, [tabBar]);

  return (
    // The pages' tooltips need a provider; on the Mac the sidebar's provides it.
    <TooltipProvider>
      <div
        data-slot="phone-shell"
        className="fixed inset-0 flex flex-col overflow-hidden bg-background pt-safe"
      >
        {/* The one scroller of the phone: the document itself never scrolls (index.css), so the
            tab bar below stays put and nothing rubber-bands, as in a native app. The pages' sticky
            headers stick to this box's top edge, which sits below the safe-area inset the shell pads. */}
        <div
          data-slot="phone-scroll"
          data-scroll-restoration-id="phone-scroll"
          className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain bg-background pr-safe pl-safe"
        >
          <PhoneOffline>
            {hasPhoneLayout(pathname) ? null : <PhoneBackHeader />}
            <main
              className={cn(
                'flex flex-1 flex-col gap-4 px-4 pt-4',
                // The bar brings the home-bar inset itself; without it the page does.
                tabBar ? 'pb-6' : 'pb-[max(1.5rem,var(--safe-bottom))]',
              )}
            >
              {children}
            </main>
          </PhoneOffline>
        </div>
        {/* The tab bar's slot (PH18): it sits below the scroller, so it stays at the bottom of the
            screen, brings its own bottom inset, and is empty (so hidden) on a page that has no tab. */}
        <div data-slot="phone-tab-bar-slot" className="z-10 flex-none empty:hidden">
          <PhoneTabBar pathname={pathname} jobs={jobs} />
        </div>
        <PhoneJobSheetHost jobs={jobs} />
        {/* Review, full screen: opened from a Review row's Play icon or the job sheet's Review button (PH8). */}
        <PhoneReviewHost jobs={jobs} />
        <PreviewViewerHost jobs={jobs} phone />
        <WhatsNew variant="sheet" />
        <PhonePush jobs={jobs} />
      </div>
      {/* The one toaster of the phone layout (PH16): every message, from any page or sheet, at the
          bottom, 12 px from the sides and above the home bar. The pages under it mount none. It sits
          outside the shell: a fixed shell is a layer of its own, which would put the messages under
          the sheets. */}
      <Toaster phone />
    </TooltipProvider>
  );
}

/**
 * "‹ Back" for a page that has no phone layout yet: one step back in the history, or the jobs list
 * when the page was opened directly (nothing to go back to inside the app).
 */
function PhoneBackHeader() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();

  return (
    <header
      data-slot="phone-back-header"
      className="flex h-12 flex-none items-center border-b px-2"
    >
      <Button
        type="button"
        variant="ghost"
        // The ghost button's own padding for a button with an icon (px-3) would win over px-2.
        className="h-11 gap-1 px-2 text-base has-[>svg]:px-2"
        onClick={() => {
          if (canGoBack) router.history.back();
          else void navigate({ to: '/jobs', replace: true });
        }}
      >
        <ChevronLeft className="size-5" aria-hidden="true" />
        Back
      </Button>
    </header>
  );
}
