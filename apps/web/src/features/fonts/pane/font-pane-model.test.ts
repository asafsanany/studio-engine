import { describe, expect, it } from 'vitest';
import {
  chooseFace,
  DIMMED_HEBREW_OPACITY,
  defaultFace,
  FONT_PANE_VIEWS,
  faceKey,
  faceTag,
  isFontPaneView,
  nearestFace,
  noHebrewNote,
  paneFacts,
  paneFonts,
  paneSubtitle,
  rememberFace,
  sortFaces,
  weightRowLabel,
} from './font-pane-model';
import {
  facesOf,
  familyDetail,
  heeboDetail,
  poppinsDetail,
  secularOneDetail,
} from './test-fixtures';

const NOW = Date.parse('2026-10-24T10:00:00.000Z');

describe('the header', () => {
  it('says style, script and the weights', () => {
    expect(paneSubtitle(heeboDetail())).toBe('Sans · Hebrew + English · 9 weights');
    expect(paneSubtitle(poppinsDetail())).toBe('Sans · English only · 9 weights');
    expect(paneSubtitle(secularOneDetail())).toBe('Display · Hebrew + English · 1 weight');
  });
});

describe('the faces', () => {
  it('lists the weights lightest first, an italic after the upright of its weight', () => {
    const faces = [
      ...facesOf('Merriweather', [700, 400]),
      ...facesOf('Merriweather', [400], 1000, true),
      ...facesOf('Merriweather', [300]),
    ];
    expect(sortFaces(faces).map(faceKey)).toEqual(['300', '400', '400i', '700']);
  });

  it('leaves out a second face with the same weight and slant', () => {
    const one = facesOf('Rubik', [400])[0];
    if (!one) throw new Error('no face');
    expect(sortFaces([one, { ...one, fileId: 'another-file' }])).toHaveLength(1);
  });

  it('opens on Regular, else on the weight nearest to 400', () => {
    expect(defaultFace(heeboDetail().faces)?.weight).toBe(400);
    expect(defaultFace(secularOneDetail().faces)?.weight).toBe(400);
    expect(defaultFace(facesOf('Test', [300, 700]))?.weight).toBe(300);
    expect(defaultFace(facesOf('Test', [500, 700, 900]))?.weight).toBe(500);
    expect(defaultFace(facesOf('Test', [100, 200]))?.weight).toBe(200);
    // Light and Medium are equally near: the lighter one.
    expect(defaultFace(facesOf('Test', [300, 500]))?.weight).toBe(300);
    expect(defaultFace([])).toBeNull();
  });

  it('prefers an upright face to an italic one that is nearer', () => {
    const faces = [...facesOf('Test', [400], 1000, true), ...facesOf('Test', [700])];
    expect(nearestFace(faces, 400)).toMatchObject({ weight: 700, italic: false });
    expect(nearestFace(facesOf('Test', [400], 1000, true), 400)?.italic).toBe(true);
  });

  it('chooses the remembered face when the family still has it, else the default', () => {
    const faces = heeboDetail().faces;
    expect(chooseFace(faces, undefined)?.weight).toBe(400);
    expect(chooseFace(faces, '700')?.weight).toBe(700);
    expect(chooseFace(faces, '700i')?.weight).toBe(400);
    expect(chooseFace(secularOneDetail().faces, '900')?.weight).toBe(400);
  });

  it('remembers a face for each family and changes nothing for the same choice', () => {
    const bold = heeboDetail().faces.find((face) => face.weight === 700);
    if (!bold) throw new Error('no bold');
    const first = rememberFace({}, 'heebo', bold);
    expect(first).toEqual({ heebo: '700' });
    expect(rememberFace(first, 'heebo', bold)).toBe(first);
    expect(rememberFace(first, 'poppins', { weight: 300, italic: false })).toEqual({
      heebo: '700',
      poppins: '300',
    });
    expect(rememberFace(first, 'heebo', { weight: 400, italic: true })).toEqual({ heebo: '400i' });
  });

  it('names a row by its weight, and what they type by faceName', () => {
    expect(weightRowLabel({ weight: 700, italic: false })).toBe('Bold');
    expect(weightRowLabel({ weight: 400, italic: false })).toBe('Regular');
    expect(weightRowLabel({ weight: 200, italic: false })).toBe('ExtraLight');
    expect(weightRowLabel({ weight: 400, italic: true })).toBe('Regular Italic');
    const heebo = heeboDetail();
    expect(faceTag(heebo, { weight: 700, italic: false })).toBe('@Heebo Bold');
    expect(faceTag(heebo, { weight: 400, italic: false })).toBe('@Heebo');
    expect(faceTag(heebo, { weight: 900, italic: false })).toBe('@Heebo Black');
    expect(faceTag(heebo, { weight: 400, italic: true })).toBe('@Heebo Italic');
    expect(faceTag({ name: 'IBM Plex Sans Hebrew' }, { weight: 200, italic: false })).toBe(
      '@IBM Plex Sans Hebrew ExtraLight',
    );
  });

  it('knows the two views', () => {
    expect(FONT_PANE_VIEWS.map((view) => view.label)).toEqual(['Text', 'On a frame']);
    expect(isFontPaneView('frame')).toBe(true);
    expect(isFontPaneView('wall')).toBe(false);
  });
});

describe('the facts', () => {
  it('lists Script, Style, Weights, Files, Used in and Added', () => {
    expect(paneFacts(heeboDetail({ addedAt: '2026-10-22T10:07:00.000Z' }), NOW)).toEqual([
      { label: 'Script', value: 'Hebrew + English' },
      { label: 'Style', value: 'Sans' },
      { label: 'Weights', value: 'Thin–Black' },
      { label: 'Files', value: '9 TTF · 0.4 MB' },
      { label: 'Used in', value: '14 jobs' },
      { label: 'Added', value: '2 days ago' },
    ]);
  });

  it('says the weights by name for one to three of them', () => {
    const value = (detail: ReturnType<typeof heeboDetail>) =>
      paneFacts(detail, NOW).find((fact) => fact.label === 'Weights')?.value;
    expect(value(secularOneDetail())).toBe('Regular');
    expect(value(familyDetail('Alef', [400, 700]))).toBe('Regular, Bold');
    expect(value(familyDetail('Fredoka', [300, 400, 500, 600, 700]))).toBe('Light–Bold');
  });

  it('says how many files and how big, over every file of the family', () => {
    const files = (detail: ReturnType<typeof heeboDetail>) =>
      paneFacts(detail, NOW).find((fact) => fact.label === 'Files')?.value;
    expect(files(poppinsDetail())).toBe('9 TTF · 1.3 MB');
    expect(files(secularOneDetail())).toBe('1 TTF · 0.1 MB');
  });

  it('says Not used yet, or leaves "Used in" out while nothing records the use', () => {
    const labels = (detail: ReturnType<typeof heeboDetail>) =>
      paneFacts(detail, NOW).map((fact) => fact.label);
    const value = paneFacts(heeboDetail({ usedIn: 0 }), NOW).find(
      (fact) => fact.label === 'Used in',
    )?.value;
    expect(value).toBe('Not used yet');
    expect(paneFacts(heeboDetail({ usedIn: 1 }), NOW)[4]?.value).toBe('1 job');
    expect(labels(heeboDetail({ usedIn: null }))).toEqual([
      'Script',
      'Style',
      'Weights',
      'Files',
      'Added',
    ]);
  });
});

describe('the fonts a view is set in', () => {
  const heeboBold = { fileId: 'heebo-700' };
  const poppins = { fileId: 'poppins-400' };

  it('sets everything in the face itself when the font has Hebrew', () => {
    const fonts = paneFonts({ he: true }, heeboBold, null);
    expect(fonts).toEqual({
      english: '"fe-heebo-700", sans-serif',
      hebrew: '"fe-heebo-700", sans-serif',
      mixed: '"fe-heebo-700", sans-serif',
      hebrewOpacity: 1,
      noHebrew: false,
    });
  });

  it('sets the Hebrew of a font without it in Heebo, dimmed, and the try text in both', () => {
    const fonts = paneFonts({ he: false }, poppins, { fileId: 'heebo-400' });
    expect(fonts.english).toBe('"fe-poppins-400", sans-serif');
    expect(fonts.hebrew).toBe('"fe-heebo-400", "Heebo", "Noto Sans Hebrew", sans-serif');
    expect(fonts.mixed).toBe(
      '"fe-poppins-400", "fe-heebo-400", "Heebo", "Noto Sans Hebrew", sans-serif',
    );
    expect(fonts.hebrewOpacity).toBe(DIMMED_HEBREW_OPACITY);
    expect(fonts.hebrewOpacity).toBe(0.55);
    expect(fonts.noHebrew).toBe(true);
  });

  it('falls back to a system Heebo when the library has none', () => {
    const fonts = paneFonts({ he: false }, poppins, null);
    expect(fonts.hebrew).toBe('"Heebo", "Noto Sans Hebrew", sans-serif');
  });

  it('words the note with Heebo, the font the edits keep for Hebrew', () => {
    expect(noHebrewNote()).toBe(
      'No Hebrew letters in this font. Hebrew text keeps the font it has now (Heebo here); only the English words change.',
    );
  });
});
