import { describe, expect, it } from 'vitest';
import { type BriefPromptFile, formatBriefFiles } from './prompts.js';

// The Brief prompt's file list says which picture the owner attached to the note themselves (Songs, SG5).

const at = Date.UTC(2026, 9, 21, 7, 5);
const file = (over: Partial<BriefPromptFile>): BriefPromptFile => ({
  relPath: 'a.txt',
  kind: 'doc',
  size: 10,
  mtimeMs: at,
  durationSec: null,
  ...over,
});

describe('the Brief prompt’s file list, with attached pictures', () => {
  it('marks a picture attached to the note, before its modified time', () => {
    expect(
      formatBriefFiles([
        file({ relPath: 'brief.txt' }),
        file({
          relPath: 'edit/brief/from-you/IMG_4412.PNG',
          kind: 'image',
          size: 1_200_000,
          attached: true,
        }),
      ]),
    ).toBe(
      [
        '- brief.txt (text, 10 bytes, modified 2026-10-21 07:05 UTC)',
        '- edit/brief/from-you/IMG_4412.PNG (image, 1.2 MB, attached by the owner, modified 2026-10-21 07:05 UTC)',
      ].join('\n'),
    );
  });

  it('is the list as it was for a file that is not marked', () => {
    const plain = formatBriefFiles([file({ relPath: 'logo.png', kind: 'image' })]);
    expect(plain).toBe('- logo.png (image, 10 bytes, modified 2026-10-21 07:05 UTC)');
    expect(formatBriefFiles([file({ relPath: 'logo.png', kind: 'image', attached: false })])).toBe(
      plain,
    );
  });
});
