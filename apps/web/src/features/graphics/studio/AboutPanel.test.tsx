import { describe, expect, it } from 'vitest';
import { makeGraphicDetail } from '@/data/test-utils';
import { AboutPanel } from './AboutPanel';
import { ABOUT_COLUMN_WIDTH } from './studio-columns';
import { renderStudio, tagWith, textOf } from './test-helpers';

const DISABLED = / disabled=""/;
const NOW = new Date(2026, 9, 22, 12, 0);

async function about(
  props: Partial<React.ComponentProps<typeof AboutPanel>> = {},
): Promise<string> {
  return renderStudio(
    <AboutPanel
      graphic={makeGraphicDetail({
        createdAt: new Date(2026, 9, 22, 10, 4).toISOString(),
        variables: [
          { id: 'name', label: 'Name', default: 'דנה לוי' },
          { id: 'role', label: 'Role', default: 'מייסדת, Kova Coffee' },
        ],
      })}
      typed={{}}
      onType={() => {}}
      onSaveWhen={async () => true}
      onSetUses={() => {}}
      offline={false}
      now={NOW}
      {...props}
    />,
  );
}

describe('<AboutPanel> · before v1', () => {
  it('says what will be here once v1 is ready, on a new graphic and on one not made yet', async () => {
    const text = 'Its text, when edits use it, and its details show here once v1 is ready.';
    const empty = await about({ graphic: undefined });
    expect(textOf(empty)).toContain(text);
    expect(empty).not.toContain('Text in it');
    const making = await about({
      graphic: makeGraphicDetail({ version: null, status: 'making', makingVersion: 1 }),
    });
    expect(textOf(making)).toContain(text);
    expect(making).not.toContain('Details');
  });

  it('is the 300 px column with a line on its left', async () => {
    const tag = tagWith(await about({ graphic: undefined }), 'data-slot="about-panel"');
    expect(tag).toContain(ABOUT_COLUMN_WIDTH);
    expect(tag).toContain('border-l');
    expect(tag).toContain('aria-label="About this graphic"');
  });
});

describe('<AboutPanel> · Text in it', () => {
  it('has one box per text field, filled with the graphic’s own text', async () => {
    const html = await about();
    expect(textOf(html)).toContain('Text in it');
    expect(textOf(html)).toContain(
      'Each edit fills these from its video. Type here to try other text.',
    );
    expect(html).toMatch(/<label[^>]*>Name<\/label>/);
    expect(html).toMatch(/<label[^>]*>Role<\/label>/);
    expect(html).toContain('value="דנה לוי"');
    expect(html).toContain('value="מייסדת, Kova Coffee"');
    expect(html.match(/data-slot="input"/g)).toHaveLength(2);
  });

  it('connects each label to its box, and gives the box its own text direction', async () => {
    const html = await about();
    const forId = /<label[^>]* for="([^"]+)"[^>]*>Name<\/label>/.exec(html)?.[1];
    expect(forId).toBeTruthy();
    const tag = tagWith(html, `id="${forId}"`);
    expect(tag).toContain('dir="auto"');
    expect(tag).toContain('[unicode-bidi:plaintext]');
  });

  it('shows what was typed instead of the default', async () => {
    const html = await about({ typed: { name: 'Dana' } });
    expect(html).toContain('value="Dana"');
    expect(html).toContain('value="מייסדת, Kova Coffee"');
    expect(html).not.toContain('value="דנה לוי"');
  });

  it('says so when the graphic has no text to change', async () => {
    const html = await about({ graphic: makeGraphicDetail({ variables: [] }) });
    expect(textOf(html)).toContain('This graphic has no text to change.');
    expect(html).not.toContain('data-slot="input"');
  });
});

describe('<AboutPanel> · When edits use it', () => {
  it('shows the line in a two-row box, in its own direction', async () => {
    const html = await about();
    expect(textOf(html)).toContain('When edits use it');
    expect(textOf(html)).toContain('The editor reads this to decide.');
    const tag = tagWith(html, 'aria-label="When edits use it"');
    expect(tag).toContain('rows="2"');
    expect(tag).toContain('dir="auto"');
    expect(tag).toContain('maxLength="200"');
    expect(html).toMatch(/<textarea[^>]*>The first time a person is named on camera\.<\/textarea>/);
  });

  it('has the Edits can use it switch, on', async () => {
    const tag = tagWith(await about(), 'role="switch"');
    expect(tag).toContain('aria-checked="true"');
    expect(tag).toContain('aria-labelledby="graphic-uses-label"');
  });

  it('shows the switch off when edits do not use it', async () => {
    const html = await about({ graphic: makeGraphicDetail({ uses: false }) });
    expect(tagWith(html, 'role="switch"')).toContain('aria-checked="false"');
  });

  it('waits while the engine is out of reach', async () => {
    const html = await about({ offline: true });
    expect(tagWith(html, 'role="switch"')).toMatch(DISABLED);
    expect(tagWith(html, 'aria-label="When edits use it"')).toMatch(DISABLED);
  });
});

describe('<AboutPanel> · Details', () => {
  it('lists Kind, Sizes, Length, Versions, Made and Folder', async () => {
    const text = textOf(await about());
    expect(text).toContain('Details');
    for (const row of [
      'Kind Lower third',
      'Sizes 9:16, 16:9, 1:1',
      'Length 3 s',
      'Versions 2',
      'Made Today, 10:04',
      'Folder _Graphics/Name on a white pill',
    ]) {
      expect(text, row).toContain(row);
    }
  });

  it('hides Used in while the edits switch is off', async () => {
    expect(textOf(await about({ graphic: makeGraphicDetail({ usedIn: null }) }))).not.toContain(
      'Used in',
    );
  });

  it('shows Used in when the engine counts: "4 videos" or "No videos yet"', async () => {
    expect(textOf(await about({ graphic: makeGraphicDetail({ usedIn: 4 }) }))).toContain(
      'Used in 4 videos',
    );
    expect(textOf(await about({ graphic: makeGraphicDetail({ usedIn: 0 }) }))).toContain(
      'Used in No videos yet',
    );
  });
});
