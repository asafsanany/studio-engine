import { describe, expect, it } from 'vitest';
import {
  CAMERA_CURVE_IDS,
  CAMERA_LUT_WAIT_PREFIX,
  type CameraLutCandidate,
  cameraCurveLabel,
  cameraCurveOfClip,
  cameraLutAskedFor,
  cameraLutWaitSentence,
  curvesNamedIn,
  matchCameraLuts,
  parseCameraLutWait,
} from './camera-luts.ts';

function lut(name: string, kind: CameraLutCandidate['kind'] = 'camera'): CameraLutCandidate {
  return {
    slug: name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
    name,
    kind,
    file: `${name}.cube`,
  };
}

describe('curvesNamedIn', () => {
  it.each([
    ['A7S_S-Log3_0001.mp4', ['slog3']],
    ['SonySLog3_to_Rec709', ['slog3']],
    ['sony s-log3 cine', ['slog3']],
    ['Sony S-Log2', ['slog2']],
    ['Panasonic V-Log L', ['vlog']],
    ['VLog_to_V709', ['vlog']],
    ['Canon C-Log3 to Rec709', ['clog3']],
    ['CanonCLog2', ['clog2']],
    ['Canon C-Log to Rec709', ['clog']],
    ['ARRI LogC3 EI800', ['logc3']],
    ['ARRI LogC4', ['logc4']],
    ['RED Log3G10 REDWideGamutRGB', ['log3g10']],
    ['Nikon N-Log', ['nlog']],
    ['Z6_NLog_001', ['nlog']],
    ['Fujifilm F-Log2', ['flog2']],
    ['X-H2S F-Log', ['flog']],
    ['DJI D-Log M to Rec709', ['dlogm']],
    ['DJI D-Log', ['dlog']],
    ['Blackmagic Film Gen 5', ['bmdfilm']],
  ])('%s names %j', (text, expected) => {
    expect(curvesNamedIn(text)).toEqual(expected);
  });

  it.each([
    'my vlog 001.mp4',
    'IMG_9509.MOV',
    'Canon Log',
    'canon-log',
    'S-Gamut3 to Cine',
    'Rec709',
    'Golden Hour Warm',
    'world log',
    'Apple iPhone 14',
  ])('%s names no curve', (text) => {
    // ("canon-log" must not read as Nikon's n-log, "my vlog" is a video blog, and a gamut change is no curve)
    expect(curvesNamedIn(text)).toEqual([]);
  });

  it('keeps similar curves apart', () => {
    expect(curvesNamedIn('c-log3')).toEqual(['clog3']);
    expect(curvesNamedIn('c-log-3')).toEqual(['clog3']);
    expect(curvesNamedIn('f-log2')).toEqual(['flog2']);
    expect(curvesNamedIn('d-log-m')).toEqual(['dlogm']);
    expect(curvesNamedIn('logc4')).toEqual(['logc4']);
    expect(curvesNamedIn('s-log2')).toEqual(['slog2']);
  });

  it('has a label for every curve', () => {
    for (const id of CAMERA_CURVE_IDS) expect(cameraCurveLabel(id)).not.toBe(id);
  });
});

describe('cameraCurveOfClip', () => {
  it('takes the one curve the texts name', () => {
    expect(cameraCurveOfClip(['Apple', 'C0003_S-Log3.MP4', 'XAVC S'])).toBe('slog3');
    expect(cameraCurveOfClip(['A7S3 slog3', 'SLog3 again'])).toBe('slog3');
  });

  it('says nothing when no text names one', () => {
    expect(cameraCurveOfClip(['Apple', 'iPhone 14', 'IMG_9509.MOV'])).toBeNull();
    expect(cameraCurveOfClip([])).toBeNull();
  });

  it('says nothing when the texts name two different curves', () => {
    expect(cameraCurveOfClip(['S-Log3', 'V-Log'])).toBeNull();
  });
});

describe('matchCameraLuts', () => {
  const sonyLog3 = lut('Sony S-Log3 to Rec709');
  const sonyLog2 = lut('Sony S-Log2 to Rec709');
  const canon = lut('Canon C-Log3 to Rec709');
  const gamut = lut('S-Gamut3 to Cine');
  const lookNamedLog3 = lut('S-Log3 teal look', 'look');

  it('one match: the one camera LUT that names the curve', () => {
    expect(matchCameraLuts('slog3', [canon, sonyLog2, sonyLog3, gamut])).toEqual({
      kind: 'one',
      lut: sonyLog3,
    });
  });

  it('two matches: it does not choose', () => {
    const second = lut('SLog3 SGamut3.Cine to Rec709');
    const match = matchCameraLuts('slog3', [sonyLog3, second, canon]);
    expect(match).toEqual({ kind: 'several', luts: [sonyLog3, second] });
  });

  it('no match: nothing names the curve', () => {
    expect(matchCameraLuts('vlog', [sonyLog3, canon, gamut])).toEqual({ kind: 'none' });
    expect(matchCameraLuts('slog3', [])).toEqual({ kind: 'none' });
  });

  it('an unknown curve matches nothing, however many camera LUTs there are', () => {
    expect(matchCameraLuts(null, [sonyLog3, canon])).toEqual({ kind: 'none' });
  });

  it('a Look or Fix LUT never matches, even with the curve in its name', () => {
    expect(matchCameraLuts('slog3', [lookNamedLog3, lut('S-Log3 skin', 'fix')])).toEqual({
      kind: 'none',
    });
  });

  it('a gamut change does not name a log curve', () => {
    expect(matchCameraLuts('slog3', [gamut])).toEqual({ kind: 'none' });
  });

  it('reads the slug and the file name too', () => {
    const odd: CameraLutCandidate = {
      slug: 'camera-a',
      name: 'Camera A',
      kind: 'camera',
      file: 'Camera_A_SLog3.cube',
    };
    expect(matchCameraLuts('slog3', [odd])).toEqual({ kind: 'one', lut: odd });
  });

  it('Canon C-Log is not C-Log3', () => {
    expect(matchCameraLuts('clog', [canon])).toEqual({ kind: 'none' });
    expect(matchCameraLuts('clog3', [canon])).toEqual({ kind: 'one', lut: canon });
  });
});

describe('the waiting sentence', () => {
  it('is one plain sentence naming the curve', () => {
    expect(cameraLutWaitSentence({ curve: 'slog3' })).toBe(
      'Waiting for a camera LUT: the clips are Sony S-Log3.',
    );
  });

  it('names the file the curve was read from', () => {
    expect(cameraLutWaitSentence({ curve: 'slog3', source: 'C0003.MP4' })).toBe(
      'Waiting for a camera LUT: the clips are Sony S-Log3 (C0003.MP4).',
    );
  });

  it('says log footage when no curve is known, and drops the file', () => {
    expect(cameraLutWaitSentence({ curve: null, source: 'x.mp4' })).toBe(
      'Waiting for a camera LUT: the clips are log footage.',
    );
  });

  it('says when more than one camera LUT matches', () => {
    const sentence = cameraLutWaitSentence({ curve: 'vlog', several: true });
    expect(sentence).toBe(
      'Waiting for a camera LUT: the clips are Panasonic V-Log, and more than one of your camera LUTs match, so name one in the job’s note.',
    );
    expect(sentence).not.toContain('\n');
    expect(sentence.length).toBeLessThan(300);
  });

  it('reads back what it writes', () => {
    for (const wait of [
      { curve: 'slog3', source: null, several: false },
      { curve: 'slog3', source: 'C0003.MP4', several: false },
      { curve: 'dlogm', source: 'DJI 0042.MP4', several: false },
      { curve: 'clog3', source: null, several: true },
      { curve: null, source: null, several: false },
    ] as const) {
      expect(parseCameraLutWait(cameraLutWaitSentence(wait))).toEqual(wait);
    }
  });

  it('every curve round-trips', () => {
    for (const curve of CAMERA_CURVE_IDS) {
      expect(parseCameraLutWait(cameraLutWaitSentence({ curve }))?.curve).toBe(curve);
    }
  });

  it('finds the sentence inside a longer error, in any case, with or without the full stop', () => {
    expect(
      parseCameraLutWait(
        'Finished without a final video: Waiting for a camera LUT: the clips are Sony S-Log3.',
      ),
    ).toEqual({ curve: 'slog3', source: null, several: false });
    expect(parseCameraLutWait('waiting for a camera lut: the clips are sony s-log3')).toEqual({
      curve: 'slog3',
      source: null,
      several: false,
    });
  });

  it('is not fooled by other errors', () => {
    expect(parseCameraLutWait(null)).toBeNull();
    expect(parseCameraLutWait(undefined)).toBeNull();
    expect(parseCameraLutWait('')).toBeNull();
    expect(parseCameraLutWait('Finished without a final video: ffmpeg is missing.')).toBeNull();
    expect(parseCameraLutWait(`${CAMERA_LUT_WAIT_PREFIX} something else entirely`)).toBeNull();
  });

  it('a label it does not know is read as no curve, not as an error', () => {
    expect(parseCameraLutWait('Waiting for a camera LUT: the clips are Foo Bar Log.')).toEqual({
      curve: null,
      source: null,
      several: false,
    });
  });

  it('asks for the right LUT in words', () => {
    expect(cameraLutAskedFor({ curve: 'slog3' })).toBe('a Sony S-Log3 to Rec709 camera LUT');
    expect(cameraLutAskedFor({ curve: null })).toBe('a camera LUT for its log footage');
  });
});
