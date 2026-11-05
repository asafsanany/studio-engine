import type { HealthResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient } from '@/data/test-utils';
import { renderApp } from '@/lib/test-router';

// The routes around the phone layout. A static render runs no effects, so the width has not been
// read yet: the phone layout cannot show here (that is the phone Playwright spec's job), and what
// is checked is that nothing changes before it is known, with the switch on or off.

const health: HealthResponse = {
  ok: true,
  version: '0.13.18',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

function clientWith(phone: boolean) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, { ...health, phone });
  return queryClient;
}

describe('the app before the phone layout is known', () => {
  for (const phone of [false, true]) {
    const switchWord = phone ? 'on' : 'off';

    it(`shows the Mac layout with the switch ${switchWord}`, async () => {
      for (const path of ['/', '/jobs']) {
        const html = await renderApp(path, clientWith(phone));
        expect(html, path).toContain('data-slot="sidebar-wrapper"');
        expect(html, path).not.toContain('data-slot="phone-shell"');
        expect(html, path).not.toContain('data-slot="phone-jobs-page"');
        expect(html, path).toContain('Jobs');
      }
    });

    it(`shows the Mac’s Money page with the switch ${switchWord}, until the layout is known`, async () => {
      const html = await renderApp('/money', clientWith(phone));
      expect(html).toContain('data-slot="sidebar-wrapper"');
      expect(html).toMatch(/<h1[^>]*>Money<\/h1>/);
      expect(html).toContain('data-slot="select-trigger"');
      expect(html).toContain('lucide-calendar');
      expect(html).not.toContain('data-slot="phone-shell"');
      expect(html).not.toContain('data-slot="phone-money-page"');
    });

    it(`draws nothing for /settings with the switch ${switchWord}, until it knows where it is`, async () => {
      const html = await renderApp('/settings', clientWith(phone));
      expect(html).not.toContain('data-slot="phone-settings-page"');
      expect(html).not.toContain('No such page');
    });
  }
});
