import { inputCountsSchema } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  classifyFile,
  emptyInputCounts,
  type FileKind,
  GRAPHICS_DIR_NAME,
  isDotName,
  isIgnoredName,
  isPackageName,
  isPartialDownload,
  isReferencePath,
  isReservedJobName,
  isReservedName,
  isTimedKind,
  LUTS_DIR_NAME,
  REFERENCE_DIR_NAME,
  SERIES_DIR_NAME,
  SHARED_DIR_NAME,
  STYLE_DIR_NAME,
} from './classify.js';

// The lists from the work item, spelled out so a change to either side shows up here.
const EXTENSIONS: Record<Exclude<FileKind, 'other'>, string[]> = {
  video: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'mts', '3gp'],
  audio: ['opus', 'ogg', 'm4a', 'mp3', 'wav', 'aac', 'flac', 'amr'],
  image: ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'svg', 'tif', 'tiff'],
  doc: ['txt', 'md', 'pdf', 'docx', 'doc', 'rtf', 'pages'],
};

describe('classifyFile', () => {
  for (const [kind, extensions] of Object.entries(EXTENSIONS)) {
    it(`classifies every ${kind} extension, in any case`, () => {
      for (const extension of extensions) {
        expect(classifyFile(`clip.${extension}`), extension).toBe(kind);
        expect(classifyFile(`CLIP.${extension.toUpperCase()}`), extension).toBe(kind);
      }
    });
  }

  it('mixes cases and keeps the last extension only', () => {
    expect(classifyFile('IMG_0001.HeIc')).toBe('image');
    expect(classifyFile('final.cut.v2.Mp4')).toBe('video');
    expect(classifyFile('backup.mp4.zip')).toBe('other');
  });

  it('treats unknown extensions and extensionless names as other', () => {
    for (const name of [
      'notes.xyz',
      'README',
      'data.json',
      'project.prproj',
      'x.',
      'archive.zip',
    ]) {
      expect(classifyFile(name), name).toBe('other');
    }
  });

  it('handles Hebrew and emoji names', () => {
    expect(classifyFile('קליפ ראשון 🎬.mov')).toBe('video');
    expect(classifyFile('הקלטה.m4a')).toBe('audio');
    expect(classifyFile('תסריט.docx')).toBe('doc');
  });
});

describe('emptyInputCounts', () => {
  it('has all four keys at zero and satisfies the shared schema', () => {
    const counts = emptyInputCounts();
    expect(counts).toEqual({ video: 0, audio: 0, image: 0, doc: 0 });
    expect(inputCountsSchema.parse(counts)).toEqual(counts);
  });

  it('returns a new object each time', () => {
    expect(emptyInputCounts()).not.toBe(emptyInputCounts());
  });
});

describe('isTimedKind', () => {
  it('is true for video and audio only', () => {
    expect(isTimedKind('video')).toBe(true);
    expect(isTimedKind('audio')).toBe(true);
    expect(isTimedKind('image')).toBe(false);
    expect(isTimedKind('doc')).toBe(false);
    expect(isTimedKind('other')).toBe(false);
  });
});

describe('ignored names', () => {
  it('ignores dotfiles and dot-folders', () => {
    for (const name of ['.DS_Store', '.hidden', '._clip.mp4', '.Spotlight-V100', '.git']) {
      expect(isDotName(name), name).toBe(true);
      expect(isIgnoredName(name), name).toBe(true);
    }
  });

  it('ignores partial downloads in any case', () => {
    for (const name of ['a.mp4.crdownload', 'b.PART', 'c.Download', 'Unconfirmed 123.crdownload']) {
      expect(isPartialDownload(name), name).toBe(true);
      expect(isIgnoredName(name), name).toBe(true);
    }
  });

  it('keeps everything else', () => {
    for (const name of ['clip.mp4', 'notes.txt', 'part-two.mov', 'downloaded', 'edit', 'לקוח']) {
      expect(isIgnoredName(name), name).toBe(false);
    }
  });
});

describe('isReservedName', () => {
  it('ignores case', () => {
    expect(isReservedName('edit', 'edit')).toBe(true);
    expect(isReservedName('Edit', 'edit')).toBe(true);
    expect(isReservedName('_exports', '_Exports')).toBe(true);
    expect(isReservedName('_style', STYLE_DIR_NAME)).toBe(true);
    expect(isReservedName('_STYLE', STYLE_DIR_NAME)).toBe(true);
    expect(isReservedName('Style', STYLE_DIR_NAME)).toBe(false);
    expect(isReservedName('editing', 'edit')).toBe(false);
  });

  it('names the Graphics library _Graphics, in any case', () => {
    expect(GRAPHICS_DIR_NAME).toBe('_Graphics');
    expect(isReservedName('_graphics', GRAPHICS_DIR_NAME)).toBe(true);
    expect(isReservedName('Graphics', GRAPHICS_DIR_NAME)).toBe(false);
  });

  it('names the LUTs library _LUTs, in any case', () => {
    expect(LUTS_DIR_NAME).toBe('_LUTs');
    expect(isReservedName('_luts', LUTS_DIR_NAME)).toBe(true);
    expect(isReservedName('_LUTS', LUTS_DIR_NAME)).toBe(true);
    expect(isReservedName('LUTs', LUTS_DIR_NAME)).toBe(false);
  });
});

describe('isReservedJobName', () => {
  it('is true for _Style, _Series and _Shared in any case, and nothing else', () => {
    expect(SERIES_DIR_NAME).toBe('_Series');
    expect(SHARED_DIR_NAME).toBe('_Shared');
    for (const name of [
      '_Style',
      '_style',
      '_Series',
      '_series',
      '_SERIES',
      '_Shared',
      '_shared',
    ]) {
      expect(isReservedJobName(name), name).toBe(true);
    }
    for (const name of ['Series', '_Seriess', '_Exports', 'Shared', 'edit', 'מיתוס או אמת 5']) {
      expect(isReservedJobName(name), name).toBe(false);
    }
  });
});

describe('isPackageName', () => {
  it('knows the macOS packages, in any case', () => {
    for (const name of [
      'Brief.pages',
      'Deck.KEY',
      'Budget.numbers',
      'Notes.rtfd',
      'Lib.photoslibrary',
    ]) {
      expect(isPackageName(name), name).toBe(true);
    }
  });

  it('does not treat ordinary names as packages', () => {
    for (const name of ['raw', 'pages', 'clip.mp4', 'my.pages.backup']) {
      expect(isPackageName(name), name).toBe(false);
    }
  });
});

// Generated videos (GN4): the client's reference material sits in `reference/` at the job root.
describe('isReferencePath', () => {
  it('is a file inside reference/ at the root of the job, in any case, at any depth', () => {
    expect(REFERENCE_DIR_NAME).toBe('reference');
    expect(isReferencePath('reference/reference-video-35s.mp4')).toBe(true);
    expect(isReferencePath('Reference/old/ad.MOV')).toBe(true);
    expect(isReferencePath('REFERENCE/x.mp4')).toBe(true);
  });

  it('is not the folder itself, a file that only starts with the word, or a reference/ deeper down', () => {
    expect(isReferencePath('reference')).toBe(false);
    expect(isReferencePath('reference-video-35s.mp4')).toBe(false);
    expect(isReferencePath('references/ad.mp4')).toBe(false);
    expect(isReferencePath('raw/reference/ad.mp4')).toBe(false);
    expect(isReferencePath('')).toBe(false);
  });
});
