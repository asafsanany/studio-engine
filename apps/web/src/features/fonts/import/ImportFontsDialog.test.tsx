import { describe, expect, it } from 'vitest';
import { renderAt } from '@/lib/test-router';
import { ImportFontsDialog } from './ImportFontsDialog';

// The dialog itself lives in a portal, which a static render does not draw; what the page can see
// while it is closed is checked here, and its behaviour in font-import-session.test.ts,
// font-import-intake.test.ts, ImportFontsBody.test.tsx and font-import-flow.test.ts.

describe('<ImportFontsDialog> closed', () => {
  it('leaves its slot on the page and draws no dialog and no drop veil', async () => {
    const html = await renderAt(
      '/fonts',
      <ImportFontsDialog open={false} onOpenChange={() => {}} />,
    );
    expect(html).toContain('data-slot="import-fonts-dialog"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('font-drop-overlay');
    expect(html).not.toContain('Drop to import');
  });
});
