import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFontFamilySummary } from '@/data/test-utils';
import {
  announceFontsImported,
  FONT_IMPORT_TOAST_ID,
  fontImportToast,
  heaviestFaceName,
} from './font-import-toasts';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const karantina = makeFontFamilySummary({
  slug: 'karantina',
  name: 'Karantina',
  weights: [300, 400, 700],
});
const bebas = makeFontFamilySummary({ slug: 'bebas-neue', name: 'Bebas Neue', weights: [400] });

afterEach(() => vi.clearAllMocks());

describe('heaviestFaceName', () => {
  it('is the family with its heaviest weight’s word', () => {
    expect(heaviestFaceName(karantina)).toBe('Karantina Bold');
    expect(heaviestFaceName(makeFontFamilySummary({ name: 'Heebo' }))).toBe('Heebo Black');
    expect(heaviestFaceName(makeFontFamilySummary({ name: 'Rubik', weights: [300, 600] }))).toBe(
      'Rubik SemiBold',
    );
  });

  it('is the family’s name alone when Regular is all there is', () => {
    expect(heaviestFaceName(bebas)).toBe('Bebas Neue');
  });
});

describe('fontImportToast', () => {
  it('says how many fonts went in and what to write to use the one the page opens', () => {
    expect(fontImportToast([karantina, bebas], 0, true)).toEqual({
      tone: 'success',
      title: 'Imported 2 fonts',
      description: 'Write @Karantina Bold in a note to use one.',
    });
  });

  it('says "font" for one', () => {
    expect(fontImportToast([karantina], 0, true)).toEqual({
      tone: 'success',
      title: 'Imported 1 font',
      description: 'Write @Karantina Bold in a note to use one.',
    });
    expect(fontImportToast([bebas], 0, true).description).toBe(
      'Write @Bebas Neue in a note to use one.',
    );
  });

  it('leaves out how to use a font while no note can name one', () => {
    expect(fontImportToast([karantina, bebas], 0, false)).toEqual({
      tone: 'success',
      title: 'Imported 2 fonts',
    });
  });

  it('counts what could not be added when some failed', () => {
    expect(fontImportToast([karantina], 1, true)).toEqual({
      tone: 'success',
      title: 'Imported 1 font. 1 could not be added.',
    });
  });

  it('is an error when none went in', () => {
    expect(fontImportToast([], 2, true)).toEqual({
      tone: 'error',
      title: '2 fonts could not be added.',
    });
    expect(fontImportToast([], 1, true).title).toBe('1 font could not be added.');
  });
});

describe('announceFontsImported', () => {
  it('shows a success toast under one id, so a second import replaces the first', () => {
    announceFontsImported([karantina], 0, true);
    expect(toast.success).toHaveBeenCalledWith('Imported 1 font', {
      id: FONT_IMPORT_TOAST_ID,
      description: 'Write @Karantina Bold in a note to use one.',
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows an error toast when none went in', () => {
    announceFontsImported([], 1, false);
    expect(toast.error).toHaveBeenCalledWith('1 font could not be added.', {
      id: FONT_IMPORT_TOAST_ID,
      description: undefined,
    });
    expect(toast.success).not.toHaveBeenCalled();
  });
});
