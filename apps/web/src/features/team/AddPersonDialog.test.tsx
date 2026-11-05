import { describe, expect, it, vi } from 'vitest';
import { renderAt } from '@/lib/test-router';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces for
// plain elements (as NewClientDialog.test does); the content shows only while the dialog is open.
vi.mock('@/components/ui/dialog', async () => {
  const { createContext, createElement: h, useContext } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  const Open = createContext(false);
  return {
    Dialog: ({ open, children }: Props) => h(Open.Provider, { value: Boolean(open) }, children),
    DialogTrigger: ({ children }: Props) => children,
    DialogClose: ({ children }: Props) => children,
    DialogContent: ({ children }: Props) => {
      const open = useContext(Open);
      return open ? h('div', { role: 'dialog' }, children) : null;
    },
    DialogHeader: ({ children }: Props) => h('header', null, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', null, children),
    DialogFooter: ({ children }: Props) => h('footer', null, children),
  };
});

const { AddPersonDialog, AddPersonForm } = await import('./AddPersonDialog');

const form = () => renderAt('/', <AddPersonForm onAdded={() => {}} />);

describe('<AddPersonDialog>: the button', () => {
  it('is an outline button with a plus and the words "Add person"', async () => {
    const markup = await renderAt('/', <AddPersonDialog />);
    expect(markup).toMatch(/<button [^>]*data-variant="outline"[^>]*>/);
    expect(markup).toContain('lucide-plus');
    expect(markup).toMatch(/>\s*Add person<\/button>/);
    expect(markup).not.toContain('role="dialog"');
  });
});

describe('<AddPersonForm>: the dialog’s content', () => {
  it('has Name, Login and Role fields with Cancel before Add', async () => {
    const markup = await form();
    expect(markup).toMatch(/<h2>Add person<\/h2>/);
    expect(markup).toMatch(/<label[^>]*>Name<\/label>/);
    expect(markup).toMatch(/<label[^>]*>Login<\/label>/);
    expect(markup).toContain('Role');
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Cancel<\/button>/);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>Add<\/button>/);
    expect(markup.indexOf('>Cancel<')).toBeLessThan(markup.indexOf('>Add<'));
  });

  it('points each label at its field, and reads a Hebrew name right to left', async () => {
    const markup = await form();
    // (Radix adds hidden radio inputs of its own to the form.)
    const inputs = (markup.match(/<input [^>]*>/g) ?? []).filter(
      (tag) => !tag.includes('aria-hidden'),
    );
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      const id = input.match(/id="([^"]+)"/)?.[1];
      expect(markup).toContain(`for="${id}"`);
    }
    expect(inputs[0]).toContain('dir="auto"');
    expect(inputs[1]).toContain('autoCapitalize="none"');
  });

  it('offers Editor (the default) and Admin, each with a line saying what it sees', async () => {
    const markup = await form();
    const radios = markup.match(/<button [^>]*role="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(radios[0]).toContain('value="editor"');
    expect(radios[0]).toContain('aria-checked="true"');
    expect(radios[1]).toContain('value="admin"');
    expect(radios[1]).toContain('aria-checked="false"');
    expect(markup).toContain('Sees only the clients assigned to them.');
    expect(markup).toContain('Sees everything, like you.');
  });

  it('starts with nothing said under the fields', async () => {
    const markup = await form();
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('aria-invalid="true"');
  });

  it('adds on Enter: the fields are in a form', async () => {
    expect(await form()).toMatch(/<form[^>]*>/);
  });
});
