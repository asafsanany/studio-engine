import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DROP_ZONE_TEXT, StyleDropZone } from './StyleDropZone';

type Busy = React.ComponentProps<typeof StyleDropZone>['busy'];

const render = (props: Partial<React.ComponentProps<typeof StyleDropZone>> = {}) =>
  renderToStaticMarkup(
    <StyleDropZone busy={null} names={[]} dragging={false} onFiles={() => {}} {...props} />,
  );

const uploading: Busy = { kind: 'uploading', text: 'Uploading 2 files… 30%', percent: 30 };
const analysing: Busy = {
  kind: 'busy',
  text: 'Analysing 2 files. style.md updates when it’s done.',
};

describe('<StyleDropZone>: waiting for files', () => {
  it('uses the words of the board', () => {
    expect(DROP_ZONE_TEXT).toEqual({
      title: 'No style yet',
      description:
        'Add a logo, fonts, a brand guide, notes or reference clips. They’re analysed into one style.md for this client. If you don’t, the first finished job writes it.',
      browse: 'Browse files',
      or: 'or drop files here',
      later: 'style.md appears here when it’s done.',
    });
    const markup = render();
    expect(markup).toMatch(/<h2[^>]*>No style yet<\/h2>/);
    expect(markup).toContain(DROP_ZONE_TEXT.description);
    expect(markup).toContain('or drop files here');
  });

  it('has Browse files: a label around a hidden file input that takes several files', () => {
    const markup = render();
    expect(markup).toMatch(
      /<label[^>]*>Browse files<input[^>]*type="file"[^>]*multiple[^>]*class="sr-only"/,
    );
    expect(markup).toContain('data-variant="outline"');
  });

  it('is a centred dashed box, at least 440 px tall', () => {
    const markup = render();
    expect(markup).toContain('border-dashed');
    expect(markup).toContain('min-h-[440px]');
    expect(markup).toContain('items-center justify-center');
  });

  it('lights up its border while files are dragged over the page', () => {
    expect(render({ dragging: true })).toContain('border-foreground/45');
    expect(render({ dragging: false })).not.toContain('border-foreground/45');
    expect(render()).toContain('ease-in-out');
  });
});

describe('<StyleDropZone>: files on their way or being analysed', () => {
  it('shows the upload in place of the invitation, with a bar and the file names', () => {
    const markup = render({ busy: uploading, names: ['notes.txt', 'logo.svg'] });
    expect(markup).toMatch(/<div role="status"><h2[^>]*>Uploading 2 files… 30%<\/h2><\/div>/);
    expect(markup).toContain('aria-valuenow="30"');
    expect(markup).toContain('notes.txt, logo.svg');
    expect(markup).toContain('style.md appears here when it’s done.');
    expect(markup).not.toContain('No style yet');
    expect(markup).not.toContain('Browse files');
    expect(markup).not.toContain('type="file"');
  });

  it('shows the analysis in place of the invitation, as the board does', () => {
    const markup = render({ busy: analysing, names: ['notes.txt'] });
    expect(markup).toMatch(
      /<div role="status"><h2[^>]*>Analysing 2 files\. style\.md updates when it’s done\.<\/h2><\/div>/,
    );
    expect(markup).toContain('notes.txt');
    expect(markup).toContain('style.md appears here when it’s done.');
    expect(markup).not.toContain('progressbar');
    expect(markup).not.toContain('Browse files');
  });

  it('says what it can when this page did not send the files (a Finder drop, a first job)', () => {
    const markup = render({
      busy: { kind: 'busy', text: 'Learning the style from Spring promo.', job: 'Spring promo' },
    });
    expect(markup).toContain('Learning the style from <bdi>Spring promo</bdi>.');
    expect(markup).not.toContain('<p dir="auto"');
  });

  it('lists a long run of names in one short line', () => {
    const names = ['1.png', '2.png', '3.png', '4.png', '5.png', '6.png'];
    expect(render({ busy: analysing, names })).toContain('1.png, 2.png, 3.png, 4.png and 2 more');
  });

  it('lets Hebrew names read in their own direction', () => {
    expect(render({ busy: analysing, names: ['לוגו.png'] })).toMatch(
      /<p dir="auto"[^>]*>לוגו\.png<\/p>/,
    );
  });
});
