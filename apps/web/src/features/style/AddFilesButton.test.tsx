import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AddFilesButton, filesPicked } from './AddFilesButton';

const render = (props: Partial<React.ComponentProps<typeof AddFilesButton>> = {}) =>
  renderToStaticMarkup(
    <AddFilesButton onFiles={() => {}} {...props}>
      Add style files
    </AddFilesButton>,
  );

describe('<AddFilesButton>', () => {
  it('is an outline button that is a label around a hidden file input for several files', () => {
    const markup = render();
    expect(markup).toMatch(/^<label[^>]*data-slot="button"[^>]*data-variant="outline"/);
    expect(markup).toMatch(/Add style files<input[^>]*type="file"[^>]*multiple/);
    expect(markup).toContain('class="sr-only"');
    // No accept list: a logo, a font, a PDF, notes and clips all go.
    expect(markup).not.toContain('accept=');
  });

  it('gets the pointer cursor, which a label has not by itself', () => {
    expect(render()).toContain('cursor-pointer');
  });

  it('shows the keyboard focus of its input on the button, quietly and in grey', () => {
    const markup = render();
    expect(markup).toContain('has-[input:focus-visible]:ring-[3px]');
    expect(markup).toContain('has-[input:focus-visible]:ring-ring/35');
    expect(markup).not.toContain('blue');
  });

  it('draws the upload icon in front of the text when asked', () => {
    expect(render({ icon: true })).toMatch(/lucide-upload[\s\S]*Add style files/);
    expect(render()).not.toContain('lucide-upload');
  });

  it('waits while bytes are on their way: no picking, and it looks it', () => {
    const markup = render({ disabled: true });
    expect(markup).toMatch(/<input[^>]*disabled/);
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('pointer-events-none');
    expect(markup).toContain('opacity-50');
    expect(render()).not.toContain('aria-disabled');
  });
});

describe('filesPicked', () => {
  const logo = new File(['x'], 'logo.png');
  const notes = new File(['x'], 'notes.txt');

  it('hands over the files that were picked', () => {
    const onFiles = vi.fn();
    filesPicked(onFiles)({
      currentTarget: {
        files: [logo, notes] as unknown as FileList,
        value: 'C:\\fakepath\\logo.png',
      },
    });
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([logo, notes]);
  });

  it('empties the input, so that picking the same file again still counts as a change', () => {
    const input = { files: [logo] as unknown as FileList, value: 'C:\\fakepath\\logo.png' };
    filesPicked(() => {})({ currentTarget: input });
    expect(input.value).toBe('');
  });

  it('keeps the files it was handed after the input is emptied', () => {
    const seen: File[][] = [];
    const files = [logo];
    const input = { files: files as unknown as FileList, value: 'x' };
    filesPicked((picked) => seen.push(picked))({ currentTarget: input });
    input.files = [] as unknown as FileList;
    expect(seen).toEqual([[logo]]);
  });

  it('hands over nothing for an input with no files', () => {
    const onFiles = vi.fn();
    filesPicked(onFiles)({ currentTarget: { files: null, value: '' } });
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([]);
  });
});
