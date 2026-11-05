import { describe, expect, it } from 'vitest';
import { ProbeError, parseProbeJson } from './probe-video.js';

// ffprobe's JSON as the installed version prints it, cut down to what the parser reads.

function probeOutput(video: Record<string, unknown>, format: Record<string, unknown> = {}) {
  return JSON.stringify({
    streams: [
      { codec_type: 'audio', codec_name: 'aac' },
      { codec_type: 'video', ...video },
    ],
    format: { duration: '2.000000', size: '54756', ...format },
  });
}

describe('parseProbeJson', () => {
  it('reads the length and the size of a plain video', () => {
    expect(parseProbeJson(probeOutput({ width: 320, height: 240 }))).toEqual({
      durationSec: 2,
      width: 320,
      height: 240,
    });
  });

  it('keeps millisecond precision and no more', () => {
    const facts = parseProbeJson(
      probeOutput({ width: 10, height: 10 }, { duration: '12.3456789' }),
    );
    expect(facts.durationSec).toBe(12.346);
  });

  it.each([90, -90, 270, -270, 89.999, 450])(
    'swaps width and height for a display matrix rotation of %s degrees',
    (rotation) => {
      const side_data_list = [{ side_data_type: 'Display Matrix', rotation }];
      expect(
        parseProbeJson(probeOutput({ width: 1920, height: 1080, side_data_list })),
      ).toMatchObject({ width: 1080, height: 1920 });
    },
  );

  it.each([0, 180, -180, 360])('keeps the size for a rotation of %s degrees', (rotation) => {
    const side_data_list = [{ side_data_type: 'Display Matrix', rotation }];
    expect(
      parseProbeJson(probeOutput({ width: 1920, height: 1080, side_data_list })),
    ).toMatchObject({ width: 1920, height: 1080 });
  });

  it('reads the older rotate tag when there is no display matrix', () => {
    expect(
      parseProbeJson(probeOutput({ width: 1920, height: 1080, tags: { rotate: '90' } })),
    ).toMatchObject({ width: 1080, height: 1920 });
  });

  it('ignores side data that is not a rotation (HDR metadata)', () => {
    const side_data_list = [
      { side_data_type: 'Mastering display metadata' },
      { side_data_type: 'Content light level metadata', max_content: 1000 },
    ];
    expect(
      parseProbeJson(probeOutput({ width: 3840, height: 2160, side_data_list })),
    ).toMatchObject({ width: 3840, height: 2160 });
  });

  it('takes the stream duration when the container has none', () => {
    const json = JSON.stringify({
      streams: [{ codec_type: 'video', width: 8, height: 8, duration: '1.5' }],
      format: { duration: 'N/A' },
    });
    expect(parseProbeJson(json).durationSec).toBe(1.5);
  });

  it('does not take a cover image for the picture', () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: 'video', width: 500, height: 500, disposition: { attached_pic: 1 } },
        { codec_type: 'video', width: 640, height: 360 },
      ],
      format: { duration: '3' },
    });
    expect(parseProbeJson(json)).toMatchObject({ width: 640, height: 360 });
  });

  it('says so when there is no picture', () => {
    const json = JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '3' } });
    expect(() => parseProbeJson(json)).toThrow(ProbeError);
    expect(() => parseProbeJson(json)).toThrow('The finished video has no picture');
  });

  it('says so when the length is unknown', () => {
    const json = probeOutput({ width: 8, height: 8 }, { duration: 'N/A' });
    expect(() => parseProbeJson(json)).toThrow("The finished video's length can't be read");
  });

  it('says so when the picture has no size', () => {
    expect(() => parseProbeJson(probeOutput({ width: 0, height: 0 }))).toThrow(
      "The finished video's picture has no size",
    );
  });

  it('says so when ffprobe did not print JSON', () => {
    expect(() => parseProbeJson('')).toThrow(
      "The finished video can't be read (ffprobe gave no answer)",
    );
  });
});
