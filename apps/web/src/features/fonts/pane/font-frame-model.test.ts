import { FONT_FRAMES, HEBREW_FALLBACK_FONT } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FONT_FRAME,
  FONT_FRAME_CHIPS,
  FONT_PANE_FRAME,
  fontFrameCredit,
  fontFrameUrl,
  frameNoHebrewNote,
  isFontFrame,
} from './font-frame-model';

describe('the test frames', () => {
  it('start on Person, the first chip', () => {
    expect(DEFAULT_FONT_FRAME).toBe('person');
    expect(FONT_FRAME_CHIPS[0]?.frame).toBe(DEFAULT_FONT_FRAME);
  });

  it('have the chips Person · Street · Interior, in that order', () => {
    expect(FONT_FRAME_CHIPS).toEqual([
      { frame: 'person', label: 'Person' },
      { frame: 'street', label: 'Street' },
      { frame: 'interior', label: 'Interior' },
    ]);
    expect(FONT_FRAME_CHIPS.map((chip) => chip.frame)).toEqual([...FONT_FRAMES]);
  });

  it('are shown 252×448, the board’s size', () => {
    expect(FONT_PANE_FRAME).toEqual({ width: 252, height: 448 });
  });

  it('come from the engine, one address each, with no flat twin to ask for', () => {
    expect(fontFrameUrl('person')).toBe('/api/fonts/frame/person.jpg');
    expect(fontFrameUrl('street')).toBe('/api/fonts/frame/street.jpg');
    expect(fontFrameUrl('interior')).toBe('/api/fonts/frame/interior.jpg');
    for (const frame of FONT_FRAMES) expect(fontFrameUrl(frame)).not.toContain('-log');
  });

  it('are credited to the photographer, as the page says it under the frame', () => {
    expect(fontFrameCredit('person')).toBe('Photo: Benjamin Combs, Unsplash');
    expect(fontFrameCredit('street')).toBe('Photo: Nicholas Swanson, Unsplash');
    expect(fontFrameCredit('interior')).toBe('Photo: The Anchor, Unsplash');
  });

  it('are told apart from anything else by isFontFrame', () => {
    for (const frame of FONT_FRAMES) expect(isFontFrame(frame)).toBe(true);
    for (const other of ['', 'Person', 'person-log', 'night', null, undefined, 3]) {
      expect(isFontFrame(other)).toBe(false);
    }
  });
});

describe('frameNoHebrewNote', () => {
  it('says the Hebrew line is in Heebo, the one fallback the app has', () => {
    expect(HEBREW_FALLBACK_FONT).toBe('Heebo');
    expect(frameNoHebrewNote()).toBe(
      'No Hebrew letters in this font, so the Hebrew line is in Heebo.',
    );
    expect(frameNoHebrewNote('Assistant')).toBe(
      'No Hebrew letters in this font, so the Hebrew line is in Assistant.',
    );
  });
});
