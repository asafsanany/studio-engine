import { describe, expect, it } from 'vitest';
import { fileCountText, fileKind, namesText } from './style-text';

describe('fileCountText', () => {
  it('says "1 file" and "N files"', () => {
    expect(fileCountText(1)).toBe('1 file');
    expect(fileCountText(2)).toBe('2 files');
    expect(fileCountText(0)).toBe('0 files');
  });
});

describe('namesText', () => {
  it('joins a few names', () => {
    expect(namesText(['logo.png'])).toBe('logo.png');
    expect(namesText(['a.png', 'b.txt', 'c.pdf'])).toBe('a.png, b.txt, c.pdf');
  });

  it('cuts a long list short with "and N more"', () => {
    const names = ['1', '2', '3', '4', '5', '6', '7'];
    expect(namesText(names)).toBe('1, 2, 3, 4 and 3 more');
    expect(namesText(names, 6)).toBe('1, 2, 3, 4, 5, 6 and 1 more');
  });
});

describe('fileKind', () => {
  it('knows images, fonts and videos by their extension, in any case', () => {
    expect(fileKind('logo.PNG')).toBe('image');
    expect(fileKind('mark.svg')).toBe('image');
    expect(fileKind('Rubik-Bold.ttf')).toBe('font');
    expect(fileKind('Heebo.woff2')).toBe('font');
    expect(fileKind('reel-ref.mp4')).toBe('video');
    expect(fileKind('take.MOV')).toBe('video');
  });

  it('calls everything else a document', () => {
    expect(fileKind('brand-guide.pdf')).toBe('doc');
    expect(fileKind('notes.txt')).toBe('doc');
    expect(fileKind('README')).toBe('doc');
    expect(fileKind('archive.tar.gz')).toBe('doc');
  });

  it('reads Hebrew names', () => {
    expect(fileKind('לוגו.png')).toBe('image');
    expect(fileKind('הנחיות מותג.pdf')).toBe('doc');
  });
});
