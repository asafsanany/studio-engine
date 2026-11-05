import { type ClientStyleResponse, noClientStyle } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createTestQueryClient } from '@/data/test-utils';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces for
// plain elements (as the Add dialog's own test does).
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children }: Props) => h('div', { role: 'dialog' }, children),
    DialogHeader: ({ children }: Props) => h('header', null, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', null, children),
    DialogFooter: ({ children }: Props) => h('footer', null, children),
  };
});

const { DROP_OVERLAY_TEXT, StyleLayout } = await import('./StyleLayout');
type Layout = React.ComponentProps<typeof StyleLayout>;

const MARKDOWN = '# Style: Kova Coffee\nFrom your files: logo.png.\n## Look\n- Fonts: Rubik 700\n';

const ready: ClientStyleResponse = {
  ...noClientStyle('eba5851d92fa', 'Kova Coffee'),
  state: 'ready',
  version: 2,
  updatedAt: '2026-10-20T13:30:00.000Z',
  markdown: MARKDOWN,
};
const none: ClientStyleResponse = {
  ...ready,
  state: 'none',
  version: 0,
  updatedAt: null,
  markdown: null,
};
const idle: Layout['session'] = { dialog: null, upload: null, started: null, notice: null };

function render(props: Partial<Layout> = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>
      <TooltipProvider>
        <StyleLayout
          style={ready}
          session={idle}
          dragging={false}
          retrying={false}
          retryError={null}
          onFiles={() => {}}
          onRetry={() => {}}
          onChooseMode={() => {}}
          onConfirm={() => {}}
          onCancel={() => {}}
          {...props}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const file = (name: string) => new File(['x'], name);

describe('<StyleLayout>: a style.md and nothing going on', () => {
  it('is the document in a 680 px column, with Add style files above it', () => {
    const markup = render();
    expect(markup).toMatch(/<article[^>]*max-w-\[680px\]/);
    expect(markup).toContain('Add style files');
    expect(markup).toMatch(/<h1[^>]*>Style: Kova Coffee<\/h1>/);
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain(DROP_OVERLAY_TEXT);
  });

  it('reads at the board’s 1.6 line height, and tall enough for the overlay to cover the page', () => {
    const markup = render();
    expect(markup).toContain('leading-[1.6]');
    expect(markup).toContain('min-h-[calc(100svh-7.5rem)]');
  });
});

describe('<StyleLayout>: bytes on their way', () => {
  const upload = { names: ['logo.png', 'notes.txt', 'ref.mp4'], percent: 42 };

  it('says how far the upload has got above the document, and holds the Add button', () => {
    const markup = render({ session: { ...idle, upload } });
    expect(markup).toContain('data-status="uploading"');
    expect(markup).toContain('Uploading 3 files… 42%');
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toMatch(/<input[^>]*type="file"[^>]*disabled/);
    expect(markup).toContain('aria-disabled="true"');
    // The old style.md stays where it is.
    expect(markup).toMatch(/<h1[^>]*>Style: Kova Coffee<\/h1>/);
    expect(markup.indexOf('Uploading 3 files')).toBeLessThan(markup.indexOf('<h1'));
  });

  it('says it in the drop zone when there is no style.md, with the file names', () => {
    const markup = render({ style: none, session: { ...idle, upload } });
    expect(markup).toContain('data-slot="style-drop-zone"');
    expect(markup).toMatch(/<div role="status"><h2[^>]*>Uploading 3 files… 42%<\/h2><\/div>/);
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain('logo.png, notes.txt, ref.mp4');
    expect(markup).not.toContain('No style yet');
    expect(markup).not.toContain('Browse files');
    // Said once, in the box: not again above it.
    expect(markup.match(/Uploading 3 files/g)).toHaveLength(1);
  });
});

describe('<StyleLayout>: after the upload, while the style is analysed', () => {
  const analysing: ClientStyleResponse = {
    ...ready,
    state: 'analysing',
    pass: { kind: 'read', mode: 'add', fileCount: 2, jobId: null, job: null },
  };
  const started = {
    fromVersion: 2,
    names: ['logo.png', 'notes.txt'],
    mode: 'add',
    hadStyle: true,
  } as const;

  it('keeps the file names in the empty drop zone while its first style is made', () => {
    const markup = render({
      style: { ...none, state: 'analysing', pass: { ...analysing.pass, mode: 'create' } as never },
      session: { ...idle, started: { ...started, hadStyle: false } },
    });
    expect(markup).toContain('Analysing 2 files. style.md updates when it’s done.');
    expect(markup).toContain('logo.png, notes.txt');
  });

  it('has Add style files enabled again: the next files will be turned away with words, not with a dead button', () => {
    const markup = render({ style: analysing, session: { ...idle, started } });
    expect(markup).toContain('Analysing 2 files. style.md updates when it’s done.');
    expect(markup).not.toMatch(/<input[^>]*disabled/);
  });
});

describe('<StyleLayout>: what the last upload came to', () => {
  it('says the files were added', () => {
    const markup = render({
      session: { ...idle, notice: { tone: 'done', text: 'Added 2 files to the style.' } },
    });
    expect(markup).toContain('data-status="done"');
    expect(markup).toContain('Added 2 files to the style.');
  });

  it('says "Still working on the last files." as a status, not an alert', () => {
    const markup = render({
      session: { ...idle, notice: { tone: 'info', text: 'Still working on the last files.' } },
    });
    expect(markup).toContain('data-status="info"');
    expect(markup).not.toContain('role="alert"');
  });

  it('says why the files were refused, in the server’s words', () => {
    const markup = render({
      session: {
        ...idle,
        notice: { tone: 'error', text: 'The files are larger than 2 GB together.' },
      },
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The files are larger than 2 GB together.');
    expect(markup).not.toContain('Retry');
  });

  it('puts the refusal above the drop zone, which stays', () => {
    const markup = render({
      style: none,
      session: {
        ...idle,
        notice: { tone: 'error', text: 'The files are larger than 2 GB together.' },
      },
    });
    expect(markup).toContain('Browse files');
    expect(markup.indexOf('larger than 2 GB')).toBeLessThan(markup.indexOf('No style yet'));
  });
});

describe('<StyleLayout>: a failed style run', () => {
  const failed: ClientStyleResponse = {
    ...ready,
    state: 'failed',
    error: 'Style stopped: it timed out.',
  };

  it('gives the error with Retry', () => {
    const markup = render({ style: failed });
    expect(markup).toContain('Style stopped: it timed out.');
    expect(markup).toMatch(/<button[^>]*>Retry<\/button>/);
  });

  it('waits on Retry while it is sent', () => {
    expect(render({ style: failed, retrying: true })).toMatch(
      /<button[^>]* disabled=""[^>]*>Retry<\/button>/,
    );
  });

  it('says why a Retry was refused in place of the failure', () => {
    const markup = render({ style: failed, retryError: 'There is nothing to retry.' });
    expect(markup).toContain('There is nothing to retry.');
    expect(markup).not.toContain('it timed out');
    expect(markup).toMatch(/<button[^>]*>Retry<\/button>/);
  });
});

describe('<StyleLayout>: files dragged over the page', () => {
  it('shows the dashed overlay over a page with a style.md', () => {
    const markup = render({ dragging: true });
    expect(markup).toContain(DROP_OVERLAY_TEXT);
    expect(DROP_OVERLAY_TEXT).toBe('Drop files to add them to the style');
    expect(markup).toMatch(
      /<div aria-hidden="true" class="[^"]*pointer-events-none[^"]*absolute[^"]*border-dashed/,
    );
    // 12 px inside the page, as on the board.
    expect(markup).toContain('-inset-3');
  });

  it('lights up the drop zone instead when there is no style.md', () => {
    const markup = render({ style: none, dragging: true });
    expect(markup).toContain('border-foreground/45');
    expect(markup).not.toContain(DROP_OVERLAY_TEXT);
  });

  it('shows nothing while a dialog is asking, or while bytes are on their way', () => {
    const asking = render({
      dragging: true,
      session: { ...idle, dialog: { files: [file('a.txt')], mode: 'add' } },
    });
    expect(asking).not.toContain(DROP_OVERLAY_TEXT);
    const sending = render({
      dragging: true,
      session: { ...idle, upload: { names: ['a.txt'], percent: 1 } },
    });
    expect(sending).not.toContain(DROP_OVERLAY_TEXT);
    const zone = render({
      style: none,
      dragging: true,
      session: { ...idle, upload: { names: ['a.txt'], percent: 1 } },
    });
    expect(zone).not.toContain('border-foreground/45');
  });
});

describe('<StyleLayout>: the Add / Replace dialog', () => {
  it('is closed until files wait in it', () => {
    expect(render()).not.toContain('role="dialog"');
  });

  it('asks about the files, with Add chosen to begin with', () => {
    const markup = render({
      session: { ...idle, dialog: { files: [file('logo.png'), file('notes.txt')], mode: 'add' } },
    });
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('Add 2 files to <bdi>Kova Coffee</bdi>’s style?');
    expect(markup).toContain('logo.png');
    expect(markup).toContain('notes.txt');
    expect(markup).toMatch(/<button[^>]*aria-checked="true"[^>]*value="add"/);
    expect(markup).toContain('Add to style</button>');
  });

  it('shows the choice that was made', () => {
    const markup = render({
      session: { ...idle, dialog: { files: [file('logo.png')], mode: 'replace' } },
    });
    expect(markup).toMatch(/<button[^>]*aria-checked="true"[^>]*value="replace"/);
    expect(markup).toContain('Replace style</button>');
  });

  it('names a client in a script of its own', () => {
    const markup = render({
      style: { ...ready, client: 'מאפיית הצפון' },
      session: { ...idle, dialog: { files: [file('logo.png')], mode: 'add' } },
    });
    expect(markup).toContain('<bdi>מאפיית הצפון</bdi>’s style?');
  });
});

describe('<StyleLayout>: when style.md was updated', () => {
  it('says so, with the time in lower case after "updated"', () => {
    const markup = render();
    expect(markup).toContain('style.md');
    expect(markup).toContain(' · updated ');
    expect(markup).toContain('first-letter:lowercase');
  });

  it('says only "style.md" for a style no run has written', () => {
    const markup = render({ style: { ...ready, updatedAt: null } });
    expect(markup).not.toContain('updated');
  });
});
