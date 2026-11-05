import { describe, expect, it, vi } from 'vitest';
import { render } from '@/components/jobs/test-helpers';
import { varsParam } from './graphic-preview-logic';

// A static render of the first frame. The lazy player is swapped for the player itself, as the
// Review dialog's tests do, so its element is in the markup; what it does afterwards (events, the
// swap of a new address) is covered by graphic-preview-swap.test.ts and in the browser.
vi.mock('@/features/review/LazyPreviewPlayer', async () => ({
  LazyPreviewPlayer: (await import('@/features/review/PreviewPlayer')).PreviewPlayer,
}));

const { GraphicPreview } = await import('./GraphicPreview');
type Props = Parameters<typeof GraphicPreview>[0];

const ID = '5a3e1c0de001';
const GRAPHIC = { id: ID, lengthSec: 3, version: 2, makingVersion: null } as const;

function preview(props: Partial<Props> = {}): string {
  return render(<GraphicPreview graphic={GRAPHIC} {...props} />);
}

/** The opening tag of the first element in `html` that has `attribute`. */
function tagWith(html: string, attribute: string): string {
  const at = html.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

/** The labels of the tabs, in order. */
function tabLabels(html: string): string[] {
  return [...html.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map(
    (match) => match[1] ?? '',
  );
}

describe('<GraphicPreview>', () => {
  it('is the labelled preview column and says which version is on show', () => {
    const section = tagWith(preview(), 'data-slot="graphic-preview"');
    expect(section).toContain('aria-label="Preview"');
    expect(section).toContain('data-version="2"');
  });

  it('has the two segmented controls: Size, then Behind it', () => {
    const html = preview();
    expect(html).toContain('aria-label="Size"');
    expect(html).toContain('aria-label="Behind the graphic"');
    expect(tabLabels(html)).toEqual([
      '9:16',
      '16:9',
      '1:1',
      'Sample frame',
      'See-through',
      'Black',
    ]);
    expect(html.indexOf('aria-label="Size"')).toBeLessThan(
      html.indexOf('aria-label="Behind the graphic"'),
    );
  });

  it('starts on 9:16 over the sample frame', () => {
    const html = preview();
    const active = [...html.matchAll(/<button[^>]*data-state="active"[^>]*>(.*?)<\/button>/g)].map(
      (match) => match[1],
    );
    expect(active).toEqual(['9:16', 'Sample frame']);
  });

  it('starts where it is told to', () => {
    const html = preview({ initialSize: '16x9', initialBackground: 'checker' });
    const active = [...html.matchAll(/<button[^>]*data-state="active"[^>]*>(.*?)<\/button>/g)].map(
      (match) => match[1],
    );
    expect(active).toEqual(['16:9', 'See-through']);
    expect(tagWith(html, '<hyperframes-player')).toContain('size=16x9&amp;bg=checker');
  });

  describe('the player', () => {
    it('loads the host page of the version, looping', () => {
      const element = tagWith(preview(), '<hyperframes-player');
      expect(element).toContain(`src="/api/graphics/${ID}/v/2/host.html?size=9x16&amp;bg=frame"`);
      expect(element).toMatch(/\bloop=""/);
      expect(element).toContain('width="1080"');
      expect(element).toContain('height="1920"');
    });

    it('is sized for the size chosen', () => {
      const element = tagWith(preview({ initialSize: '1x1' }), '<hyperframes-player');
      expect(element).toContain('width="1080"');
      expect(element).toContain('height="1080"');
    });

    it('plays the version on show, not the newest', () => {
      const element = tagWith(
        preview({ shownVersion: 1, newestVersion: 2 }),
        '<hyperframes-player',
      );
      expect(element).toContain('/v/1/host.html');
    });

    it('carries the text values in the address', () => {
      const values = { name: 'דנה לוי' };
      const element = tagWith(preview({ values }), '<hyperframes-player');
      expect(element).toContain(`&amp;vars=${varsParam(values)}`);
    });

    it('keeps the loop’s length in the bar before the player is ready: 3 s plus the tail', () => {
      expect(preview()).toContain('0.0 / 3.0 s');
    });

    it('takes the address of another API, for the dev gallery', () => {
      const element = tagWith(preview({ apiBase: '/__dev/graphic-sample' }), '<hyperframes-player');
      expect(element).toContain(`src="/__dev/graphic-sample/${ID}/v/2/host.html?`);
    });

    it('uses the newest version when only the graphic is given', () => {
      const element = tagWith(
        render(<GraphicPreview graphic={{ ...GRAPHIC, version: 5 }} />),
        '<hyperframes-player',
      );
      expect(element).toContain('/v/5/host.html');
    });
  });

  describe('the bar under the picture', () => {
    it('has play/pause, play from the start, the timeline and the time', () => {
      const html = preview();
      expect(html).toContain('data-slot="graphic-controls"');
      expect(html).toContain('aria-label="Play"');
      expect(html).toContain('aria-label="Play from the start"');
      expect(html).toContain('aria-label="Time"');
    });

    it('is disabled until the player is ready', () => {
      const html = preview();
      const bar = html.slice(html.indexOf('data-slot="graphic-controls"'));
      expect(bar.match(/<button [^>]*disabled=""/g)).toHaveLength(2);
      expect(tagWith(html, 'data-slot="graphic-controls"')).toContain('opacity-40');
    });

    it('is under the picture', () => {
      const html = preview();
      expect(html.indexOf('data-slot="graphic-controls"')).toBeGreaterThan(
        html.indexOf('<hyperframes-player'),
      );
    });
  });

  describe('"Showing v1. Edits use v2."', () => {
    it('shows when an older version is on show, with Back to v2 and Use v1 again', () => {
      const html = preview({ shownVersion: 1, newestVersion: 2 });
      expect(html).toContain('data-slot="showing-old"');
      expect(html).toContain('Showing v1. Edits use v2.');
      expect(html).toMatch(/<button[^>]*>Back to v2<\/button>/);
      expect(html).toMatch(/<button[^>]*>Use v1 again<\/button>/);
    });

    it('is not there when the newest version is on show', () => {
      expect(preview()).not.toContain('data-slot="showing-old"');
      expect(preview({ shownVersion: 2, newestVersion: 2 })).not.toContain('Showing');
    });

    it('cannot Use v1 again while a version is being made, but can go Back', () => {
      const html = preview({ shownVersion: 1, newestVersion: 2, making: 3 });
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Use v1 again<\/button>/);
      expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Back to v2<\/button>/);
    });

    it('can Use v1 again otherwise', () => {
      const html = preview({ shownVersion: 1, newestVersion: 2 });
      expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Use v1 again<\/button>/);
    });
  });

  describe('while a version is being made', () => {
    it('shows the chip over the picture, and keeps the picture', () => {
      const html = preview({ making: 3 });
      expect(html).toContain('data-slot="making-chip"');
      expect(html).toContain('Making v3…');
      expect(html).toContain('<hyperframes-player');
    });

    it('takes the version being made from the graphic when it is not told', () => {
      const html = render(<GraphicPreview graphic={{ ...GRAPHIC, makingVersion: 3 }} />);
      expect(html).toContain('Making v3…');
    });

    it('is not told it when `making` is null, whatever the graphic says', () => {
      const html = render(
        <GraphicPreview graphic={{ ...GRAPHIC, makingVersion: 3 }} making={null} />,
      );
      expect(html).not.toContain('making-chip');
    });

    it('has no chip when nothing is being made', () => {
      expect(preview()).not.toContain('making-chip');
    });
  });

  describe('with no version yet', () => {
    const none = { id: ID, lengthSec: null, version: null, makingVersion: null } as const;

    it('says "Your graphic plays here" in a dashed box, with no player', () => {
      const html = render(<GraphicPreview graphic={none} />);
      expect(html).toContain('Your graphic plays here');
      expect(tagWith(html, 'data-slot="preview-placeholder"')).toContain('border-dashed');
      expect(tagWith(html, 'data-slot="preview-placeholder"')).toContain('data-state="waiting"');
      expect(html).not.toContain('<hyperframes-player');
      expect(html).not.toContain('data-version');
    });

    it('says "Making v1. It plays here when it’s ready." with pulsing lines while v1 is made', () => {
      const html = render(<GraphicPreview graphic={{ ...none, makingVersion: 1 }} />);
      expect(html).toContain('Making v1. It plays here when it’s ready.');
      expect(tagWith(html, 'data-slot="preview-placeholder"')).toContain('data-state="making"');
      expect(html.match(/animate-pulse/g)).toHaveLength(2);
      expect(html).not.toContain('Your graphic plays here');
      expect(html).not.toContain('<hyperframes-player');
    });

    it('keeps the controls on screen, dimmed, and the toggles usable', () => {
      const html = render(<GraphicPreview graphic={none} />);
      expect(tagWith(html, 'data-slot="graphic-controls"')).toContain('opacity-40');
      expect(html).toContain('0.0 / 0.0 s');
      expect(tabLabels(html)).toHaveLength(6);
    });

    it('shows the same empty box while the graphic is still loading', () => {
      const html = render(<GraphicPreview graphic={undefined} />);
      expect(html).toContain('Your graphic plays here');
      expect(html).toContain('data-slot="graphic-preview"');
    });

    it('draws the box in the shape of the size', () => {
      const html = render(<GraphicPreview graphic={none} initialSize="16x9" />);
      expect(tagWith(html, 'data-slot="preview-box"')).toContain('aspect-ratio:1920 / 1080');
    });

    it('is not told a version on show without a graphic to play it from', () => {
      const html = render(
        <GraphicPreview graphic={undefined} shownVersion={2} newestVersion={2} />,
      );
      expect(html).not.toContain('<hyperframes-player');
    });
  });

  it('takes a class name for the column', () => {
    expect(tagWith(preview({ className: 'h-full' }), 'data-slot="graphic-preview"')).toContain(
      'h-full',
    );
  });
});
