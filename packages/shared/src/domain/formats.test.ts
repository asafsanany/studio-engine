import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  canvasesOfFormats,
  extraExportSuffix,
  extraFinalName,
  extraFormatsOf,
  extraPreviewDirName,
  extraReviewExportName,
  formatIdOf,
  formatPreviewPath,
  type JobFormat,
  jobFormatSchema,
  jobFormatsOf,
  jobOutputFileSchema,
  parseCanvas,
  reviewExportFileName,
} from './formats.ts';
import { jobOutputSchema, jobSchema } from './job.ts';
import { makeJob } from './test-fixtures.ts';

const SAMPLE_JOB = makeJob();

describe('parseCanvas', () => {
  it('reads a size', () => {
    expect(parseCanvas('1080x1920')).toEqual({ width: 1080, height: 1920 });
    expect(parseCanvas('1080x1080')).toEqual({ width: 1080, height: 1080 });
  });

  it.each(['', '1080', '1080x', 'x1920', '1080X1920', '1080x1920x1', '0x1920', '1080x0', 'abc'])(
    'refuses %j',
    (text) => {
      expect(parseCanvas(text)).toBeNull();
    },
  );
});

describe('formatIdOf', () => {
  it('is the ratio in lowest terms', () => {
    expect(formatIdOf(1080, 1920)).toBe('9x16');
    expect(formatIdOf(1920, 1080)).toBe('16x9');
    expect(formatIdOf(1080, 1080)).toBe('1x1');
    expect(formatIdOf(1080, 1350)).toBe('4x5');
  });
});

describe('jobFormatsOf', () => {
  it('is empty for no formats, and for one: a job with one format is a job as it always was', () => {
    expect(jobFormatsOf(null)).toEqual([]);
    expect(jobFormatsOf(undefined)).toEqual([]);
    expect(jobFormatsOf([])).toEqual([]);
    expect(jobFormatsOf(['1080x1920'])).toEqual([]);
  });

  it('lists two or more, the main one first, with their labels, sizes and preview paths', () => {
    expect(jobFormatsOf(['1080x1920', '1080x1080'])).toEqual([
      {
        id: '9x16',
        label: '9:16',
        width: 1080,
        height: 1920,
        previewPath: 'preview/index.html',
      },
      { id: '1x1', label: '1:1', width: 1080, height: 1080, previewPath: 'preview/1x1/index.html' },
    ]);
    expect(jobFormatsOf(['1080x1080', '1080x1920', '1080x1350']).map((f) => f.id)).toEqual([
      '1x1',
      '9x16',
      '4x5',
    ]);
  });

  it('leaves out a size that repeats and text that is not a size', () => {
    expect(jobFormatsOf(['1080x1920', '1080x1920'])).toEqual([]);
    expect(jobFormatsOf(['1080x1920', 'square'])).toEqual([]);
    expect(jobFormatsOf(['1080x1920', '1080x1920', '1080x1080']).map((f) => f.id)).toEqual([
      '9x16',
      '1x1',
    ]);
  });

  it('gives formats the schema accepts', () => {
    for (const format of jobFormatsOf(['1080x1920', '1080x1080', '1920x1080'])) {
      expect(jobFormatSchema.parse(format)).toEqual(format);
    }
    expectTypeOf<JobFormat>().toEqualTypeOf<{
      id: string;
      label: string;
      width: number;
      height: number;
      previewPath: string;
    }>();
  });
});

describe('canvasesOfFormats', () => {
  it('turns formats back into the sizes they were made from', () => {
    const canvases = ['1080x1920', '1080x1080'];
    expect(canvasesOfFormats(jobFormatsOf(canvases))).toEqual(canvases);
  });

  it('is null for none', () => {
    expect(canvasesOfFormats(undefined)).toBeNull();
    expect(canvasesOfFormats([])).toBeNull();
  });
});

describe('what a format owns', () => {
  const formats = jobFormatsOf(['1080x1920', '1080x1080', '1080x1350']);

  it('has no extra formats without a second one', () => {
    expect(extraFormatsOf(undefined)).toEqual([]);
    expect(extraFormatsOf([])).toEqual([]);
  });

  it('has every format but the main one as an extra', () => {
    expect(extraFormatsOf(formats).map((f) => f.id)).toEqual(['1x1', '4x5']);
  });

  it('names the folder, the video and the export of an extra format by its id', () => {
    expect(extraPreviewDirName('1x1')).toBe('preview-1x1');
    expect(extraFinalName('1x1')).toBe('final-1x1.mp4');
    expect(extraExportSuffix('1x1')).toBe(' (1x1)');
  });

  it('names the Review export of an extra format apart from the main one', () => {
    expect(extraReviewExportName('1x1')).toBe('review-export-1x1.mp4');
    expect(reviewExportFileName('Spring promo')).toBe('Spring promo.mp4');
    expect(reviewExportFileName('Spring promo', null)).toBe('Spring promo.mp4');
    expect(reviewExportFileName('Spring promo', '1x1')).toBe('Spring promo (1x1).mp4');
  });

  it('serves the main preview where it always was, and an extra one under its id', () => {
    expect(formatPreviewPath('9x16', true)).toBe('preview/index.html');
    expect(formatPreviewPath('1x1', false)).toBe('preview/1x1/index.html');
  });
});

describe('the contract on Job and JobOutput', () => {
  const formats = jobFormatsOf(['1080x1920', '1080x1080']);
  const outputs = [
    { format: '9x16', fileName: 'Acme/Teaser.mp4', bytes: 1000 },
    { format: '1x1', fileName: 'Acme/Teaser (1x1).mp4', bytes: 800 },
  ];

  it('is absent on a job as it was: formats and outputs are optional', () => {
    expect(jobSchema.parse(SAMPLE_JOB)).not.toHaveProperty('formats');
    const output = {
      fileName: 'Acme/Teaser.mp4',
      durationSec: 30,
      width: 1080,
      height: 1920,
      sizeBytes: 1000,
    };
    expect(jobOutputSchema.parse(output)).toEqual(output);
  });

  it('carries the formats of a job that has two or more', () => {
    expect(jobSchema.parse({ ...SAMPLE_JOB, formats }).formats).toEqual(formats);
  });

  it('refuses formats with fewer than two entries: one format is no key at all', () => {
    expect(jobSchema.safeParse({ ...SAMPLE_JOB, formats: [] }).success).toBe(false);
    expect(jobSchema.safeParse({ ...SAMPLE_JOB, formats: formats.slice(0, 1) }).success).toBe(
      false,
    );
  });

  it('carries one output file per format, the main one first', () => {
    const output = jobOutputSchema.parse({
      fileName: 'Acme/Teaser.mp4',
      durationSec: 30,
      width: 1080,
      height: 1920,
      sizeBytes: 1000,
      outputs,
    });
    expect(output.outputs).toEqual(outputs);
    expect(output.outputs?.[0]?.fileName).toBe(output.fileName);
  });

  it('checks an output file', () => {
    expect(jobOutputFileSchema.safeParse(outputs[0]).success).toBe(true);
    expect(jobOutputFileSchema.safeParse({ ...outputs[0], format: 'square' }).success).toBe(false);
    expect(jobOutputFileSchema.safeParse({ ...outputs[0], fileName: '' }).success).toBe(false);
    expect(jobOutputFileSchema.safeParse({ ...outputs[0], bytes: -1 }).success).toBe(false);
  });
});
