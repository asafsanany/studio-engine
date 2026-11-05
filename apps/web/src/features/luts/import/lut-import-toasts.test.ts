import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

const { LUT_IMPORT_TOAST_ID, announceLutsImported, lutImportToast } = await import(
  './lut-import-toasts'
);

const luts = (...slugs: string[]) => slugs.map((slug) => ({ slug }));

describe('lutImportToast', () => {
  it('says how many went in, and how to use one while notes can name a LUT', () => {
    expect(lutImportToast(luts('golden-hour', 'soft-pastel'), 0, true)).toEqual({
      tone: 'success',
      title: 'Imported 2 LUTs',
      description: 'Write @luts/golden-hour in a note to use one.',
    });
  });

  it('leaves the second sentence out while lutsInEdits is off', () => {
    const toast = lutImportToast(luts('golden-hour'), 0, false);
    expect(toast.title).toBe('Imported 1 LUT');
    expect(toast.description).toBeUndefined();
  });

  it('counts the files that could not be added', () => {
    expect(lutImportToast(luts('golden-hour'), 1, true)).toEqual({
      tone: 'success',
      title: 'Imported 1 LUT. 1 could not be added.',
    });
  });

  it('is an error when nothing went in', () => {
    expect(lutImportToast([], 2, true)).toEqual({
      tone: 'error',
      title: '2 LUTs could not be added.',
    });
  });
});

describe('announceLutsImported', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a success toast, replacing the one before', () => {
    announceLutsImported(luts('a', 'b'), 0, true);
    expect(toastMock.success).toHaveBeenCalledWith('Imported 2 LUTs', {
      id: LUT_IMPORT_TOAST_ID,
      description: 'Write @luts/a in a note to use one.',
    });
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('shows an error toast when none went in', () => {
    announceLutsImported([], 1, false);
    expect(toastMock.error).toHaveBeenCalledWith('1 LUT could not be added.', {
      id: LUT_IMPORT_TOAST_ID,
      description: undefined,
    });
  });
});
