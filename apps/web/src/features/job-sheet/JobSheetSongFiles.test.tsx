import { QueryClientProvider } from '@tanstack/react-query';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createTestQueryClient } from '@/data/test-utils';
import { COPIED_MS, COPY_LINE_FAILED, COPY_LINE_TOAST_ID, copyLine } from './copy-line';
import {
  CopyLineButton,
  JobSheetSongFiles,
  NoSongFileRow,
  SongFileRow,
  SongFilesSection,
  SongPostSection,
} from './JobSheetSongFiles';
import { SONG_SHEET_TEXT, type SongFile } from './sheet-songs';

// The two files and the line to post of a video with a song (Songs, SG9; board SGSheet). There is
// no DOM here: a state is server-rendered and read as markup, and a press is made by calling the
// handler found in the element tree of the parts that use no hooks.

const withSong: SongFile = {
  id: 'with-song',
  name: 'Demo 2.mp4',
  sub: 'With the song · to show the client · 0:39',
  href: '/api/jobs/a1/download',
};
const noSongFile: SongFile = {
  id: 'no-song',
  name: 'Demo 2 · no song.mp4',
  sub: 'Without it · to post · 0:39',
  href: '/api/jobs/a1/download?file=no-song',
};
const POST =
  'Post “Demo 2 · no song.mp4”. In Instagram tap Add audio, pick נתתי לך בית by Ofek Adanek and slide it to start at 0:42. That way the reel counts toward the song’s trend.';

const render = (node: ReactNode) => renderToStaticMarkup(node);
const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

type Element = ReactElement<Record<string, unknown>>;
function elementsIn(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elementsIn);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elementsIn(node.props.children as ReactNode)];
}

/** The tag that opens the element carrying `attribute`. */
const tagWith = (markup: string, attribute: string) =>
  markup.match(new RegExp(`<[^>]*${attribute}[^>]*>`))?.[0] ?? '';

describe('<SongFileRow>', () => {
  it('shows the file’s name, its line, and a Download link to the engine’s download', () => {
    const html = render(<SongFileRow file={withSong} primary />);
    expect(text(html)).toBe('Demo 2.mp4 With the song · to show the client · 0:39 Download');
    const link = tagWith(html, 'data-sheet-download');
    expect(link).toContain('href="/api/jobs/a1/download"');
    expect(link).toContain(' download=""');
    expect(link).toContain('data-sheet-download="with-song"');
  });

  it('is the primary button for the file to show and an outline one for the file to post', () => {
    const primary = render(<SongFileRow file={withSong} primary />);
    const outline = render(<SongFileRow file={noSongFile} primary={false} />);
    expect(tagWith(primary, 'data-sheet-download')).toContain('data-variant="default"');
    expect(tagWith(primary, 'data-sheet-download')).toContain('bg-zinc-50');
    expect(tagWith(outline, 'data-sheet-download')).toContain('data-variant="outline"');
    expect(tagWith(outline, 'data-sheet-download')).toContain('data-size="sm"');
  });

  it('keeps a name in its own reading direction', () => {
    const html = render(<SongFileRow file={{ ...withSong, name: 'דמו.mp4' }} primary />);
    expect(html).toContain('dir="auto"');
    expect(html).toContain('דמו.mp4');
  });

  it('waits while the engine is out of reach: no address, not a tab stop', () => {
    const link = tagWith(
      render(<SongFileRow file={withSong} primary waiting />),
      'data-sheet-download',
    );
    expect(link).not.toContain('href=');
    expect(link).toContain('aria-disabled="true"');
    expect(link).toContain('tabindex="-1"');
    expect(link).toContain('pointer-events-none');
  });
});

describe('<NoSongFileRow>', () => {
  const tryAgain = vi.fn();

  it('is a Download of the file once it is made', () => {
    const html = render(
      <NoSongFileRow row={{ state: 'ready', file: noSongFile }} onTryAgain={tryAgain} />,
    );
    expect(text(html)).toBe('Demo 2 · no song.mp4 Without it · to post · 0:39 Download');
    expect(html).toContain('data-sheet-download="no-song"');
    expect(html).not.toContain('Try again');
  });

  it('is a status with a spinner while the file is being made, and nothing to press', () => {
    const html = render(
      <NoSongFileRow row={{ state: 'making', name: noSongFile.name }} onTryAgain={tryAgain} />,
    );
    expect(text(html)).toBe('Making the file without the song…');
    expect(html).toContain('role="status"');
    expect(html).toContain('animate-spin');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
  });

  it('says why it is not there, in red, with Try again', () => {
    const row = {
      state: 'failed',
      name: noSongFile.name,
      message: 'The render stopped: Chrome did not start.',
    } as const;
    const html = render(<NoSongFileRow row={row} onTryAgain={tryAgain} />);
    expect(text(html)).toBe(
      'Demo 2 · no song.mp4 The render stopped: Chrome did not start. Try again',
    );
    expect(html).toMatch(/text-status-failed-foreground[^>]*>The render stopped/);
    expect(tagWith(html, 'data-sheet-action="try-again"')).toContain('data-variant="outline"');
    expect(html).not.toContain('data-sheet-download');
  });

  it('asks the engine again when Try again is pressed', () => {
    const row = { state: 'failed', name: noSongFile.name, message: 'No.' } as const;
    const onTryAgain = vi.fn();
    const tree = NoSongFileRow({ row, onTryAgain });
    const button = elementsIn(tree).find(
      (element) => element.props['data-sheet-action'] === 'try-again',
    );
    if (button === undefined) throw new Error('no Try again button');
    (button.props.onClick as () => void)();
    expect(onTryAgain).toHaveBeenCalledOnce();
  });

  it('waits for the engine’s answer to a press, and while the engine is out of reach', () => {
    const row = { state: 'failed', name: noSongFile.name, message: 'No.' } as const;
    const open = (props: { retrying?: boolean; waiting?: boolean }) =>
      tagWith(render(<NoSongFileRow row={row} onTryAgain={() => {}} {...props} />), 'try-again');
    const disabled = /\sdisabled(=|\s|>)/;
    expect(open({})).not.toMatch(disabled);
    expect(open({ retrying: true })).toMatch(disabled);
    expect(open({ waiting: true })).toMatch(disabled);
    expect(render(<NoSongFileRow row={row} onTryAgain={() => {}} retrying />)).toContain(
      'animate-spin',
    );
  });
});

describe('<SongFilesSection>', () => {
  it('is the Files section: the file to show first, then the one to post', () => {
    const html = render(
      <SongFilesSection
        withSong={withSong}
        noSong={{ state: 'ready', file: noSongFile }}
        onTryAgain={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Files"');
    expect(html.indexOf('Demo 2.mp4')).toBeLessThan(html.indexOf('Demo 2 · no song.mp4'));
    expect([...html.matchAll(/data-sheet-download="([\w-]+)"/g)].map((match) => match[1])).toEqual([
      'with-song',
      'no-song',
    ]);
  });
});

describe('<SongPostSection>', () => {
  it('is "To post on Instagram": the line in a muted box, Copy, and the hint', () => {
    const html = render(<SongPostSection text={POST} />);
    expect(html).toContain('aria-label="To post on Instagram"');
    expect(text(html)).toBe(
      `To post on Instagram Copy ${POST} Copy it and send it to Yael with the file.`,
    );
    expect(tagWith(html, 'data-slot="song-post-text"')).toContain('dir="auto"');
    expect(tagWith(html, 'data-slot="song-post-text"')).toContain('bg-white/4');
  });

  it('has Copy as a 28 px outline button on the Mac and a 44 px one on the phone', () => {
    const mac = tagWith(render(<CopyLineButton text={POST} />), 'data-sheet-copy-line');
    const phone = tagWith(
      render(<CopyLineButton text={POST} variant="phone" />),
      'data-sheet-copy-line',
    );
    expect(mac).toContain('data-variant="outline"');
    expect(mac).toContain('h-7');
    expect(phone).toContain('data-variant="outline"');
    expect(phone).toContain('h-11');
    expect(phone).toContain('text-[15px]');
  });

  it('says Copy before it is pressed', () => {
    expect(text(render(<CopyLineButton text={POST} />))).toBe(SONG_SHEET_TEXT.copy);
  });
});

describe('<JobSheetSongFiles>', () => {
  it('is the files, then the line to post', () => {
    const html = render(
      <QueryClientProvider client={createTestQueryClient()}>
        <JobSheetSongFiles
          jobId="a1"
          withSong={withSong}
          noSong={{ state: 'ready', file: noSongFile }}
          post={POST}
        />
      </QueryClientProvider>,
    );
    expect(html.indexOf('aria-label="Files"')).toBeLessThan(
      html.indexOf('aria-label="To post on Instagram"'),
    );
    expect(html).toContain(POST);
  });
});

describe('copyLine', () => {
  it('writes the whole text to the clipboard and says it got there', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const notifyError = vi.fn();
    await expect(copyLine(POST, { writeText, notifyError })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(POST);
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('says so in a toast, and that it did not, when the clipboard cannot be written', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    const notifyError = vi.fn();
    await expect(copyLine(POST, { writeText, notifyError })).resolves.toBe(false);
    expect(notifyError).toHaveBeenCalledWith(COPY_LINE_FAILED, {
      id: COPY_LINE_TOAST_ID,
      duration: COPIED_MS,
    });
  });

  it('says "Copied" for two seconds', () => {
    expect(COPIED_MS).toBe(2000);
    expect(SONG_SHEET_TEXT.copied).toBe('Copied');
  });
});
