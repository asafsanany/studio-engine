import { describe, expect, it, vi } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces for
// plain elements that keep the props this test cares about; the content shows only while the
// dialog is open, as in the app.
vi.mock('@/components/ui/dialog', async () => {
  const { createContext, createElement: h, useContext } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  const Open = createContext(false);
  return {
    Dialog: ({ open, children }: Props) => h(Open.Provider, { value: Boolean(open) }, children),
    DialogTrigger: ({ children }: Props) => children,
    DialogClose: ({ children }: Props) => children,
    DialogContent: ({ children, showCloseButton, className }: Props) => {
      const open = useContext(Open);
      return open
        ? h(
            'div',
            { role: 'dialog', 'data-close-button': String(showCloseButton), class: className },
            children,
          )
        : null;
    },
    DialogHeader: ({ children }: Props) => h('header', null, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', { 'data-role': 'description' }, children),
    DialogFooter: ({ children }: Props) => h('footer', null, children),
  };
});

const { NewClientDialog, NewClientForm } = await import('./NewClientDialog');

const form = () => renderAt('/clients', <NewClientForm onCreated={() => {}} />);

describe('<NewClientDialog>: the button', () => {
  it('is an outline button with a plus and the words "New client"', async () => {
    const markup = await renderAt('/clients', <NewClientDialog />);
    expect(markup).toMatch(/<button [^>]*data-variant="outline"[^>]*>/);
    expect(markup).toContain('lucide-plus');
    expect(markup).toMatch(/>\s*New client<\/button>/);
  });

  it('does not show the dialog until it is opened', async () => {
    const markup = await renderAt('/clients', <NewClientDialog />);
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('<form');
  });
});

describe('<NewClientForm>: the dialog’s content', () => {
  it('is titled "New client", with a Name field, Cancel and Create', async () => {
    const markup = await form();
    expect(markup).toMatch(/<h2>New client<\/h2>/);
    expect(markup).toMatch(/<label[^>]*>Name<\/label>/);
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Cancel<\/button>/);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>Create<\/button>/);
    // Cancel before Create.
    expect(markup.indexOf('>Cancel<')).toBeLessThan(markup.indexOf('>Create<'));
  });

  it('has a name field that reads right to left for a Hebrew name (dir="auto")', async () => {
    const markup = await form();
    const input = markup.match(/<input [^>]*>/)?.[0] ?? '';
    expect(input).toContain('dir="auto"');
    expect(input).toContain('autoComplete="off"');
    // The label points at it.
    const id = input.match(/id="([^"]+)"/)?.[1];
    expect(markup).toContain(`for="${id}"`);
  });

  it('starts with an empty field and nothing said under it', async () => {
    const markup = await form();
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('aria-invalid="true"');
    expect(markup).not.toContain('disabled=""');
  });

  it('creates on Enter: the field is in a form', async () => {
    const markup = await form();
    expect(markup).toMatch(/<form[^>]*>[\s\S]*<input[\s\S]*type="submit"/);
  });

  it('describes itself, which the dialog needs for its screen-reader description', async () => {
    expect(await form()).toContain('A folder with this name is made in Studio Inbox.');
  });
});

describe('<NewClientForm>: the Instagram field (Clients × Instagram)', () => {
  const health = {
    ok: true,
    version: '0.63.14',
    settleMs: 60_000,
    series: false,
    jobSheet: false,
    analytics: false,
    phone: false,
    graphics: true,
    graphicsInEdits: true,
    music: false,
    luts: true,
    lutsInEdits: true,
    fonts: true,
    fontsInNotes: true,
    quickFixes: false,
  };
  const formWith = (instagram: boolean | undefined) => {
    const queryClient = createTestQueryClient();
    if (instagram !== undefined) queryClient.setQueryData(HEALTH_KEY, { ...health, instagram });
    return renderAt('/clients', <NewClientForm onCreated={() => {}} />, queryClient);
  };

  it('is there while the switch is on: an optional field after the name, with its hint', async () => {
    const markup = await formWith(true);
    expect(markup).toMatch(/<label[^>]*>Instagram \(optional\)<\/label>/);
    expect(markup.indexOf('>Name<')).toBeLessThan(markup.indexOf('Instagram (optional)'));
    const input =
      markup.match(/<input [^>]*placeholder="@name or instagram\.com\/name"[^>]*>/)?.[0] ?? '';
    expect(input).toContain('dir="ltr"');
    expect(input).toContain('autoComplete="off"');
    expect(input).not.toContain('required');
    expect(markup).toContain('A name or a link. Its page is read once a week, about $0.05.');
  });

  it('is not there while the switch is off, or before the engine has said', async () => {
    for (const on of [false, undefined]) {
      const markup = await formWith(on);
      expect(markup).not.toContain('Instagram (optional)');
      expect(markup.match(/<input /g)).toHaveLength(1);
    }
  });

  it('still has Cancel and Create, and nothing said in red', async () => {
    const markup = await formWith(true);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>Create<\/button>/);
    expect(markup).not.toContain('role="alert"');
  });
});
