import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Laptop } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { whatsNewStore } from '@/components/whats-new/whats-new-store';
import { useMe } from '@/data';
import { signedInAs } from '@/data/me-query';
import { APP_VERSION } from '@/lib/version';
import { PhoneNotificationsSection } from './push/PhoneNotificationsSection';

/** The address this page was opened at (`name.tailnet.ts.net`); empty where there is no window. */
function currentHost(): string {
  return typeof window === 'undefined' ? '' : window.location.host;
}

/**
 * Settings on the phone (boards MSettingsBasic, MSettings), behind the gear on the jobs list:
 * "Notifications on this phone" (PH12; in the Home Screen app only; an editor's phone registers
 * under their own login), "This phone" (who is signed in, and how it reaches
 * the Mac) and "About" (What's new and the version). The `/settings` route renders it on the phone
 * layout; on the Mac layout that address redirects to `/jobs`.
 */
export function PhoneSettingsPage({ address = currentHost() }: { address?: string }) {
  const { data: me } = useMe();
  return (
    // The board has the back row right under the status bar (the shell's top padding is taken
    // back, as the Jobs page does) and its text at 15 px.
    <div
      data-slot="phone-settings-page"
      className="-mt-4 flex flex-col gap-[22px] text-[15px] leading-[1.43]"
    >
      <div className="flex flex-col gap-1">
        <Button
          asChild
          variant="ghost"
          // The ghost button's own padding for a button with an icon (px-3) would win over pl-1 / pr-2.5.
          className="-ml-2 h-11 gap-0.5 self-start pr-2.5 pl-1 text-[15px] has-[>svg]:pr-2.5 has-[>svg]:pl-1"
        >
          <Link to="/jobs">
            <ChevronLeft className="size-5" aria-hidden="true" />
            Jobs
          </Link>
        </Button>
        <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">Settings</h1>
      </div>

      {/* "Notifications on this phone": empty, and so hidden, outside the Home Screen app. */}
      <div data-slot="phone-settings-notifications" className="empty:hidden">
        <PhoneNotificationsSection />
      </div>

      <Section title="This phone">
        {me !== undefined && (
          <div
            data-slot="phone-settings-signed-in"
            className="flex min-h-12 items-center gap-3 border-b px-3.5 py-2"
          >
            <span className="flex-none text-muted-foreground">Signed in as</span>
            <span className="min-w-0 flex-1 text-right font-medium break-words [overflow-wrap:anywhere]">
              {signedInAs(me)}
            </span>
          </div>
        )}
        <div className="flex min-h-14 items-center gap-3 border-b px-3.5 py-2">
          <Laptop className="size-5 flex-none text-muted-foreground" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">Connected to your Mac</span>
            <span className="text-[13px] text-muted-foreground">
              Over Tailscale, only your devices
            </span>
          </span>
          <span
            role="img"
            aria-label="Connected"
            className="size-2 flex-none rounded-full bg-emerald-400"
          />
        </div>
        <div className="flex min-h-12 items-center gap-3 px-3.5 py-2">
          <span className="flex-none text-muted-foreground">Address</span>
          <span className="min-w-0 flex-1 text-right text-sm break-words text-zinc-300 [overflow-wrap:anywhere]">
            {address}
          </span>
        </div>
      </Section>

      <Section title="About">
        <button
          type="button"
          onClick={() => whatsNewStore.getState().openCurrent()}
          className="flex min-h-12 w-full cursor-pointer items-center gap-3 border-b px-3.5 py-2 text-left outline-none transition-colors ease-in-out focus-visible:bg-white/5 active:bg-white/5"
        >
          <span className="flex-1 font-medium">What’s new</span>
          <ChevronRight className="size-4 text-zinc-500" aria-hidden="true" />
        </button>
        <div className="flex min-h-12 items-center gap-3 px-3.5 py-2">
          <span className="flex-1 text-muted-foreground">Version</span>
          <span className="tabular-nums">{APP_VERSION}</span>
        </div>
      </Section>
    </div>
  );
}

/** A titled group of rows in a rounded, hairline box. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `phone-settings-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="px-1 text-[13px] font-medium text-muted-foreground">
        {title}
      </h2>
      <div className="overflow-hidden rounded-xl border">{children}</div>
    </section>
  );
}
