import { describe, expect, it } from 'vitest';
import { makeGraphicDetail } from '@/data/test-utils';
import { StudioHeader } from './StudioHeader';
import { renderStudio, tagWith, textOf } from './test-helpers';

const DISABLED = / disabled=""/;

async function header(
  props: Partial<React.ComponentProps<typeof StudioHeader>> = {},
): Promise<string> {
  return renderStudio(
    <StudioHeader
      graphic={makeGraphicDetail()}
      offline={false}
      onRename={async () => true}
      onToggleUses={() => {}}
      onReveal={() => {}}
      onDuplicate={() => {}}
      onDelete={() => {}}
      {...props}
    />,
  );
}

describe('<StudioHeader>', () => {
  it('is the 56 px bar with a line under it', async () => {
    const tag = tagWith(await header(), 'data-slot="studio-header"');
    for (const className of ['h-14', 'border-b', 'flex-none']) expect(tag).toContain(className);
  });

  it('has ‹ Graphics going back to the library', async () => {
    const html = await header();
    expect(tagWith(html, 'href="/graphics"')).toContain('href="/graphics"');
    expect(html).toMatch(/lucide-chevron-left[\s\S]*Graphics<\/a>/);
  });

  it('shows the name as a button that renames, in its own direction', async () => {
    const html = await header({ graphic: makeGraphicDetail({ name: 'Name on a white pill' }) });
    expect(html).toMatch(/<h1[^>]*>[\s\S]*Name on a white pill[\s\S]*<\/h1>/);
    const button = html.slice(html.indexOf('<h1'));
    expect(tagWith(button, 'dir="auto"')).toContain('[unicode-bidi:plaintext]');
    expect(tagWith(button, 'dir="auto"')).not.toMatch(DISABLED);
  });

  it('shows the name of the new graphic as plain text, with nothing to rename or open', async () => {
    const html = await header({ graphic: undefined });
    expect(html).toContain('New graphic');
    expect(html).not.toContain('data-slot="input"');
    expect(textOf(html)).toContain('Not made yet');
    expect(tagWith(html, 'aria-label="Show in Finder"')).toMatch(DISABLED);
    expect(tagWith(html, 'aria-label="More"')).toMatch(DISABLED);
  });
});

describe('<StudioHeader> · the status', () => {
  const status = (html: string) => {
    const tag = tagWith(html, 'data-tone=');
    return {
      tone: /data-tone="(\w+)"/.exec(tag)?.[1],
      text: textOf(html.slice(html.indexOf(tag))),
    };
  };

  it('says the version, with "off for edits" when the switch is off', async () => {
    expect(status(await header()).text).toMatch(/^v2/);
    expect(textOf(await header({ graphic: makeGraphicDetail({ uses: false }) }))).toContain(
      'v2 · off for edits',
    );
  });

  it('says "Making v1…" in blue while the first version is made', async () => {
    const html = await header({
      graphic: makeGraphicDetail({
        version: null,
        status: 'making',
        makingVersion: 1,
        lengthSec: null,
        kind: null,
      }),
    });
    expect(status(html).tone).toBe('making');
    expect(textOf(html)).toContain('Making v1…');
  });

  it('says "couldn’t finish v3" in red', async () => {
    const html = await header({
      graphic: makeGraphicDetail({ status: 'failed', failedVersion: 3 }),
    });
    expect(status(html).tone).toBe('failed');
    expect(textOf(html)).toContain('v2 · couldn’t finish v3');
  });
});

describe('<StudioHeader> · renaming', () => {
  it('turns the name into a field with all of it selected for typing', async () => {
    const html = await header({ initialRenaming: true });
    const tag = tagWith(html, 'aria-label="Name of the graphic"');
    expect(tag).toContain('value="Name on a white pill"');
    expect(tag).toContain('dir="auto"');
    expect(html).not.toMatch(/<h1/);
  });

  it('waits while a version is being made, with the engine’s sentence as the tooltip’s words', async () => {
    const html = await header({
      graphic: makeGraphicDetail({ status: 'making', makingVersion: 3 }),
    });
    const button = html.slice(html.indexOf('<h1'));
    expect(tagWith(button, 'dir="auto"')).toMatch(DISABLED);
    // A disabled button gets no hover, so the span around it carries the tooltip and the focus.
    expect(button).toContain('tabindex="0"');
    expect(tagWith(button, 'dir="auto"')).toContain('disabled:opacity-100');
  });

  it('waits while the engine is out of reach', async () => {
    const html = await header({ offline: true });
    expect(tagWith(html.slice(html.indexOf('<h1')), 'dir="auto"')).toMatch(DISABLED);
  });
});

describe('<StudioHeader> · Show in Finder and ⋯', () => {
  it('has Show in Finder as a ghost icon, and ⋯ beside it', async () => {
    const html = await header();
    const finder = tagWith(html, 'aria-label="Show in Finder"');
    expect(finder).toContain('data-variant="ghost"');
    expect(finder).toContain('data-size="icon-sm"');
    expect(finder).not.toMatch(DISABLED);
    expect(html).toContain('lucide-folder');
    const more = tagWith(html, 'aria-label="More"');
    expect(more).toContain('aria-haspopup="menu"');
    expect(html).toContain('lucide-ellipsis');
    expect(html.indexOf('aria-label="Show in Finder"')).toBeLessThan(
      html.indexOf('aria-label="More"'),
    );
  });

  it('waits for v1 before Show in Finder works', async () => {
    const html = await header({
      graphic: makeGraphicDetail({ version: null, status: 'making', makingVersion: 1 }),
    });
    expect(tagWith(html, 'aria-label="Show in Finder"')).toMatch(DISABLED);
  });

  it('waits while the engine is out of reach', async () => {
    const html = await header({ offline: true });
    expect(tagWith(html, 'aria-label="Show in Finder"')).toMatch(DISABLED);
    expect(tagWith(html, 'aria-label="More"')).toMatch(DISABLED);
  });
});
