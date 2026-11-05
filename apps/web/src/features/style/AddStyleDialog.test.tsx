import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces for
// plain elements that keep the props this test cares about (the close button, the width).
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children, showCloseButton, className }: Props) =>
      h(
        'div',
        { role: 'dialog', 'data-close-button': String(showCloseButton), class: className },
        children,
      ),
    DialogHeader: ({ children }: Props) => h('header', null, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', { 'data-role': 'description' }, children),
    DialogFooter: ({ children }: Props) => h('footer', null, children),
  };
});

const { ADD_DIALOG_TEXT, ADD_OPTIONS, AddStyleDialog } = await import('./AddStyleDialog');

const file = (name: string) => new File(['x'], name);

const dialog = (props: Partial<React.ComponentProps<typeof AddStyleDialog>> = {}) =>
  renderToStaticMarkup(
    <AddStyleDialog
      open
      client="Kova Coffee"
      files={[file('menu-2027.pdf'), file('logo-new.svg'), file('reel-reference.mp4')]}
      mode="add"
      onModeChange={() => {}}
      onConfirm={() => {}}
      onCancel={() => {}}
      {...props}
    />,
  );

describe('<AddStyleDialog>', () => {
  it('uses the words of the design canvas', () => {
    expect(ADD_DIALOG_TEXT.description).toBe('They’re analysed and written into one style.md.');
    expect(
      ADD_OPTIONS.map(({ mode, title, description, confirm }) => [
        mode,
        title,
        description,
        confirm,
      ]),
    ).toEqual([
      [
        'add',
        'Add to the current style',
        'Merged into style.md. Where the new files disagree with it, they win.',
        'Add to style',
      ],
      [
        'replace',
        'Replace the style',
        'A new style.md from these files only. The current one is kept in history.',
        'Replace style',
      ],
    ]);
  });

  it('shows nothing while it is closed', () => {
    expect(dialog({ open: false })).toBe('');
  });

  it('asks about the number of files and the client, the client in its own direction', () => {
    const markup = dialog();
    expect(markup).toContain('<h2>Add 3 files to <bdi>Kova Coffee</bdi>’s style?</h2>');
    expect(markup).toContain('They’re analysed and written into one style.md.');
  });

  it('says "1 file" for one', () => {
    expect(dialog({ files: [file('notes.txt')] })).toContain('<h2>Add 1 file to <bdi>');
  });

  it('reads a Hebrew client name in its own direction', () => {
    expect(dialog({ client: 'מאפיית הצפון' })).toContain('<bdi>מאפיית הצפון</bdi>’s style?');
  });

  it('has no close button (Cancel is the way out) and the board’s 480 px width', () => {
    const markup = dialog();
    expect(markup).toContain('data-close-button="false"');
    expect(markup).toContain('sm:max-w-[480px]');
  });

  it('lists the files with an icon for what each is', () => {
    const markup = dialog({
      files: [
        file('logo.png'),
        file('Rubik-Bold.ttf'),
        file('reel.mp4'),
        file('brand-guide.pdf'),
        file('לוגו.svg'),
      ],
    });
    const items = [...markup.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1] ?? '');
    expect(items).toHaveLength(5);
    expect(items[0]).toContain('lucide-image');
    expect(items[1]).toContain('lucide-type');
    expect(items[2]).toContain('lucide-video');
    expect(items[3]).toContain('lucide-file-text');
    expect(items[4]).toContain('lucide-image');
    expect(markup).toMatch(/<span dir="auto" class="bidi">לוגו\.svg<\/span>/);
  });

  it('lists five files and says "and N more" for the rest', () => {
    const files = Array.from({ length: 8 }, (_, i) => file(`file-${i + 1}.txt`));
    const markup = dialog({ files });
    expect(markup).toContain('file-5.txt');
    expect(markup).not.toContain('file-6.txt');
    expect(markup).toContain('and 3 more');
    expect(dialog()).not.toContain('more');
  });

  it('keeps two files that share a name apart', () => {
    const markup = dialog({ files: [file('logo.png'), file('logo.png')] });
    expect(markup.match(/logo\.png/g)).toHaveLength(2);
  });

  it('offers Add to the current style first, and chosen to begin with', () => {
    const markup = dialog();
    const radios = [...markup.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios).toHaveLength(2);
    expect(radios[0]).toContain('value="add"');
    expect(radios[0]).toContain('aria-checked="true"');
    expect(radios[1]).toContain('value="replace"');
    expect(radios[1]).toContain('aria-checked="false"');
    expect(markup.indexOf('Add to the current style')).toBeLessThan(
      markup.indexOf('Replace the style'),
    );
  });

  it('chooses Replace the style when told to', () => {
    const markup = dialog({ mode: 'replace' });
    const radios = [...markup.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios[0]).toContain('aria-checked="false"');
    expect(radios[1]).toContain('aria-checked="true"');
  });

  it('is a labelled group of two cards, each a label for its radio, named by its title', () => {
    const markup = dialog();
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain(`aria-label="${ADD_DIALOG_TEXT.groupLabel}"`);
    expect(markup.match(/<label[^>]*for="add-style-(add|replace)"/g)).toHaveLength(2);
    expect(markup).toContain('aria-labelledby="add-style-add-title"');
    expect(markup).toContain('aria-describedby="add-style-replace-description"');
    expect(markup).toContain('cursor-pointer');
  });

  it('marks the chosen card', () => {
    const cards = (mode: 'add' | 'replace') =>
      [...dialog({ mode }).matchAll(/<label[^>]*class="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(cards('add')[0]).toContain('border-foreground/35');
    expect(cards('add')[1]).not.toContain('border-foreground/35');
    expect(cards('replace')[1]).toContain('border-foreground/35');
  });

  it('confirms with "Add to style", or "Replace style" when Replace is chosen', () => {
    expect(dialog()).toMatch(/<button[^>]*>Cancel<\/button><button[^>]*>Add to style<\/button>/);
    expect(dialog({ mode: 'replace' })).toMatch(/<button[^>]*>Replace style<\/button>/);
    expect(dialog({ mode: 'replace' })).not.toContain('Add to style');
  });

  it('is a stock radio group and primary button, with white (not blue) radios', () => {
    const markup = dialog();
    expect(markup).toContain('data-slot="radio-group"');
    expect(markup).toContain('data-slot="radio-group-item"');
    expect(markup).toMatch(/<button[^>]*data-variant="outline"[^>]*>Cancel/);
    expect(markup).toMatch(/<button[^>]*data-variant="default"[^>]*>Add to style/);
    expect(markup).toContain('text-foreground');
  });
});
