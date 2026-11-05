import type { FontFaceInfo } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { type FontPickerCatalog, fontPickerCatalog } from '@/features/library-picker/font-picker';
import { FONT_LIST, libraryItems } from '@/features/library-picker/test-helpers';
import {
  FONT_PREVIEW_TEXT,
  type FontPreviewPlan,
  fontPillOf,
  fontPreviewPlan,
} from './font-preview';

// What the note box asks to be seen on the captions and on the titles (board FOReview, chip and
// two), over the 40 real families of the owner's library. Plain functions; the page they restyle is
// font-preview-dom.test.ts, the markup is FontPreviewPill.test.tsx.

const catalog: FontPickerCatalog = fontPickerCatalog(FONT_LIST);
const items = libraryItems();

function plan(text: string): FontPreviewPlan | null {
  return fontPreviewPlan(text, catalog, items);
}

/** The labels of the plan: captions, titles. */
function labels(text: string): [string | null, string | null] {
  const found = plan(text);
  return [found?.captions?.label ?? null, found?.titles?.label ?? null];
}

describe('fontPreviewPlan: which font goes on which text', () => {
  it('asks for nothing when the note names no font', () => {
    expect(plan('')).toBeNull();
    expect(plan('make the captions bigger')).toBeNull();
    expect(plan('mail me at owner@heebo.com')).toBeNull();
  });

  it('asks for nothing for a name the library does not have, or only a LUT or a graphic', () => {
    expect(plan('captions in @Gotham Bold')).toBeNull();
    expect(plan('make it @luts/cinematic')).toBeNull();
    expect(plan('put @graphics/follow-card at the end')).toBeNull();
  });

  it('puts a font named with "captions" on the captions only', () => {
    expect(labels('Make the captions @Heebo Bold ')).toEqual(['@Heebo Bold', null]);
    expect(labels('the subtitles in @Rubik Black')).toEqual(['@Rubik Black', null]);
  });

  it('puts a font named with "titles" on the titles only', () => {
    expect(labels('The titles in @Rubik Black')).toEqual([null, '@Rubik Black']);
    expect(labels('a heading in @Secular One')).toEqual([null, '@Secular One']);
  });

  it('puts a font named with neither word on both: all the text', () => {
    const found = plan('Use @Heebo Bold for the text');
    expect(found?.captions?.label).toBe('@Heebo Bold');
    expect(found?.titles?.label).toBe('@Heebo Bold');
    expect(found?.fonts).toHaveLength(1);
  });

  it('reads Hebrew: "הכתוביות" is the captions, "הכותרות" the titles, after a hyphen too', () => {
    expect(labels('תשנה את הכתוביות ל-@Heebo Bold')).toEqual(['@Heebo Bold', null]);
    expect(labels('הכותרת ב-@Rubik Black')).toEqual([null, '@Rubik Black']);
  });

  it('gives each of two fonts its own text, in the order the note writes them', () => {
    const found = plan('Titles in @Rubik Black and captions in @Heebo Medium ');
    expect(found?.captions?.label).toBe('@Heebo Medium');
    expect(found?.titles?.label).toBe('@Rubik Black');
    expect(found?.fonts.map((font) => font.label)).toEqual(['@Rubik Black', '@Heebo Medium']);
  });

  it('lets a font for one text beat a font for all text on that text, and take the rest', () => {
    const found = plan('Captions in @Heebo Bold. Everything else in @Rubik Black');
    expect(found?.captions?.label).toBe('@Heebo Bold');
    expect(found?.titles?.label).toBe('@Rubik Black');
  });

  it('shows the font written first when two are named for the same text', () => {
    expect(labels('captions in @Heebo Bold, no wait, captions in @Rubik Black')).toEqual([
      '@Heebo Bold',
      null,
    ]);
    // The one left out is not shown, so the pill does not count it.
    expect(plan('captions in @Heebo Bold, no wait, captions in @Rubik Black')?.fonts).toHaveLength(
      1,
    );
  });

  it('puts one font on both texts when it is named for each', () => {
    const found = plan('Captions in @Heebo Bold, and titles in @Heebo Bold');
    expect(found?.captions?.label).toBe('@Heebo Bold');
    expect(found?.titles?.label).toBe('@Heebo Bold');
    expect(found?.fonts).toHaveLength(1);
  });

  it('tells Regular from Bold: @Heebo is Regular, @Heebo Bold is 700', () => {
    expect(plan('captions in @Heebo')?.captions?.weight).toBe(400);
    expect(plan('captions in @Heebo Bold')?.captions?.weight).toBe(700);
    expect(plan('captions in @Heebo Bold')?.captions?.italic).toBe(false);
  });

  it('reads a name with another case or doubled spaces, and calls it as the library does', () => {
    expect(labels('the captions in @HEEBO   bold')).toEqual(['@Heebo Bold', null]);
  });

  it('takes the words between a font and the next token as the next token reads them', () => {
    // "title" is part of the graphic's slug: with the graphic read as a token it is not a word.
    expect(labels('@graphics/opening-title then @Heebo Bold for the captions')[0]).toBe(
      '@Heebo Bold',
    );
  });
});

describe('fontPreviewPlan: what the player is told', () => {
  it('points at the engine’s file with its version, and says its real weight and slant', () => {
    const font = plan('captions in @Heebo Bold')?.captions;
    expect(font?.src).toBe('url("/api/fonts/file/heebo-700?v=1761350400000") format("truetype")');
    expect(font?.weight).toBe(700);
  });

  it('tells two weights of one variable file apart, each with its own weight', () => {
    const faces: FontFaceInfo[] = FONT_LIST.catalog
      .filter((face) => face.family === 'Rubik' && (face.weight === 400 || face.weight === 700))
      .map((face) => ({ ...face, fileId: 'rubik-variable' }));
    const list = {
      ...FONT_LIST,
      catalog: [...FONT_LIST.catalog.filter((f) => f.family !== 'Rubik'), ...faces],
    };
    const catalog = fontPickerCatalog(list);
    const bold = fontPreviewPlan('captions in @Rubik Bold', catalog)?.captions;
    const regular = fontPreviewPlan('captions in @Rubik', catalog)?.captions;
    expect(bold?.weight).toBe(700);
    expect(regular?.weight).toBe(400);
    // The same file, two weights: two fonts, so each gets a family held at its own weight.
    expect(bold?.src).toBe(regular?.src);
    expect(bold?.key).not.toBe(regular?.key);
  });

  it('is the same key for the same asks, however the rest of the note changes', () => {
    const a = plan('captions in @Heebo Bold');
    const b = plan('Make the captions in @Heebo Bold much bigger');
    expect(a?.key).toBe(b?.key);
    expect(plan('captions in @Heebo Bold')?.key).not.toBe(plan('captions in @Heebo Medium')?.key);
    expect(plan('captions in @Heebo Bold')?.key).not.toBe(plan('titles in @Heebo Bold')?.key);
  });

  it('drops a font when its token is taken out, and everything when the last one is', () => {
    const text = 'Titles in @Rubik Black and captions in @Heebo Medium ';
    expect(plan(text)?.fonts).toHaveLength(2);
    const one = plan('Titles in @Rubik Black and captions in ');
    expect(one?.captions).toBeNull();
    expect(one?.titles?.label).toBe('@Rubik Black');
    expect(plan('Titles in  and captions in ')).toBeNull();
  });
});

describe('the pill’s words', () => {
  const heebo = { label: '@Heebo Bold' };
  const rubik = { label: '@Rubik Black' };

  it('names the font when there is one, and counts them when there are more', () => {
    expect(FONT_PREVIEW_TEXT.pill([heebo])).toBe('Previewing @Heebo Bold');
    expect(FONT_PREVIEW_TEXT.pill([heebo, rubik])).toBe('Previewing 2 fonts');
  });

  it('has Compare’s words of the look on the paused frame', () => {
    expect(FONT_PREVIEW_TEXT.compare).toBe('Compare');
    expect(FONT_PREVIEW_TEXT.compareTip).toBe('Hold to see the original');
  });
});

describe('fontPillOf: when the pill is on the video', () => {
  const asked = plan('captions in @Heebo Bold');
  const status = { shown: [{ key: 'a', label: '@Heebo Bold' }] };
  const base = { asVideo: false, ready: true, plan: asked, status };

  it('is what the page shows, once the player is ready and a plan is asked for', () => {
    expect(fontPillOf(base)).toBe(status);
  });

  it('is none while the page shows nothing of the plan (its text was not found, or it is on its way)', () => {
    expect(fontPillOf({ ...base, status: { shown: [] } })).toBeNull();
    expect(fontPillOf({ ...base, status: null })).toBeNull();
  });

  it('is none when no font is asked for, even if an old answer is still there', () => {
    expect(fontPillOf({ ...base, plan: null })).toBeNull();
  });

  it('is none before the player is ready, and on the phone’s MP4', () => {
    expect(fontPillOf({ ...base, ready: false })).toBeNull();
    expect(fontPillOf({ ...base, asVideo: true })).toBeNull();
  });

  // The look on the paused frame no longer hides it: the font pill wins over the look and the fix
  // pill (pill-choice.ts).
});
