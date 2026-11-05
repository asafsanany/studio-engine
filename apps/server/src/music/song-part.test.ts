import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SONG_LIMITS, instagramLine as sharedInstagramLine } from '@studio/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bassOnsetAfter,
  choosePart,
  clockText,
  energyEnvelope,
  envelopeFromPower,
  INSTAGRAM_LINE_MAX,
  instagramLine,
  LOW_BAND_FILTER,
  PART,
  parseHyperframes,
  partAroundFirstWord,
  partFromStart,
  peakAt,
  readWavInfo,
  riseDb,
  windowPower,
} from '../../assets/music/song-part.mjs';
import { resolveFfmpeg } from '../pipeline/fake-media.js';

// The song measuring (assets/music/song-part.mjs): the energy of a decoded WAV, the beat finder's
// answer, and the choice of the part from them. The envelopes here are made by hand (a quiet
// intro, a verse, a drop); the WAV reading is checked on audio made with ffmpeg.

const ffmpeg = await resolveFfmpeg('ffmpeg');

/** An envelope with `levels` (dB, mean power) holding for the given seconds each. */
function envelopeOf(levels: [seconds: number, db: number][]) {
  const hop = PART.hopMs;
  const power: number[] = [];
  for (const [seconds, db] of levels) {
    for (let i = 0; i < Math.round((seconds * 1000) / hop); i++) power.push(10 ** (db / 10));
  }
  return envelopeFromPower(power, hop);
}

/** The same for the low band's envelope (the music script's second decode), in its own hop. */
function lowOf(levels: [seconds: number, db: number][]) {
  return envelopeFromPower(
    levels.flatMap(([seconds, db]) =>
      Array.from({ length: Math.round((seconds * 1000) / PART.lowHopMs) }, () => 10 ** (db / 10)),
    ),
    PART.lowHopMs,
  );
}

/** Downbeats every `bar` s from `first`, up to `until` s, in ms. */
function downbeats(first: number, bar: number, until: number): number[] {
  const out: number[] = [];
  for (let t = first; t < until; t += bar) out.push(Math.round(t * 1000));
  return out;
}

describe('the rise of the energy', () => {
  const env = envelopeOf([
    [10, -30],
    [10, -20],
    [20, -10],
  ]);
  const duration = 40_000;

  it('is how much louder the next bars are than the last ones', () => {
    expect(riseDb(env, 10_000, 4_000, duration)).toBeCloseTo(10, 5);
    expect(riseDb(env, 20_000, 4_000, duration)).toBeCloseTo(10, 5);
    expect(riseDb(env, 15_000, 4_000, duration)).toBeCloseTo(0, 5);
    expect(riseDb(env, 30_000, 4_000, duration)).toBeCloseTo(0, 5);
  });

  it('is nothing in the first seconds, where there is no music before it', () => {
    expect(riseDb(env, 0, 4_000, duration)).toBe(0);
    expect(riseDb(env, 1_500, 4_000, duration)).toBe(0);
  });

  it('is nothing when there is hardly any song left after it', () => {
    expect(riseDb(env, 39_000, 4_000, duration)).toBe(0);
  });

  it('is capped, so a track that starts from silence cannot score without limit', () => {
    const quiet = envelopeOf([
      [5, -100],
      [10, -10],
    ]);
    expect(riseDb(quiet, 5_000, 4_000, 15_000)).toBe(30);
  });

  it('reads the mean power of a window', () => {
    expect(windowPower(env, 0, 10_000)).toBeCloseTo(10 ** -3, 9);
    expect(windowPower(env, 5_000, 15_000)).toBeCloseTo((10 ** -3 + 10 ** -2) / 2, 9);
    expect(windowPower(env, 50_000, 60_000)).toBe(0);
  });
});

describe('where the bass comes in', () => {
  // 30 s of quiet low band with the bass (-10 dB) coming in at 18 s and staying.
  const low = lowOf([
    [18, -45],
    [12, -10],
  ]);

  it('is the first strong onset of the low band after the loudness step', () => {
    // It is on the first 20 ms of the bass, not up to 120 ms before it (the window that spots it).
    expect(bassOnsetAfter(low, 17_300, 19_300)).toBe(18_000);
  });

  it('is the same wherever the loudness step was, up to 1.5 s before the bass', () => {
    const first = bassOnsetAfter(low, 17_300, 19_300);
    for (const step of [16_600, 17_000, 17_600, 17_900]) {
      expect(bassOnsetAfter(low, step, step + PART.bassSearchMs), String(step)).toBe(first);
    }
  });

  it('looks from one loudness step before the step, and only until its end', () => {
    // An onset more than a step (100 ms) before `fromMs` is not "after" it ...
    expect(bassOnsetAfter(low, 18_300, 20_300)).toBeNull();
    // ... and one past `toMs` is too far from it.
    expect(bassOnsetAfter(low, 15_000, 17_700)).toBeNull();
  });

  it('skips a ghost note: a blip that is not near the song’s loud bass', () => {
    const ghost = lowOf([
      [10, -45],
      [0.2, -30],
      [7.8, -45],
      [12, -10],
    ]);
    // The blip at 10 s is 15 dB up but 20 dB under the loud bass: not an onset.
    expect(bassOnsetAfter(ghost, 9_800, 20_000)).toBe(18_000);
  });

  it('is null for a bass that never rises, a silent one, and an envelope that is too short', () => {
    expect(bassOnsetAfter(lowOf([[30, -20]]), 10_000, 12_000)).toBeNull();
    expect(bassOnsetAfter(lowOf([[30, -200]]), 10_000, 12_000)).toBeNull();
    expect(bassOnsetAfter(lowOf([[0.3, -10]]), 0, 1_000)).toBeNull();
  });

  it('takes the first onset when there are several', () => {
    const twice = lowOf([
      [10, -45],
      [3, -10],
      [2, -45],
      [3, -10],
      [12, -45],
    ]);
    expect(bassOnsetAfter(twice, 9_000, 20_000)).toBe(10_000);
  });
});

describe('choosing the part', () => {
  // A quiet intro, a verse and a drop at 20 s that holds to the end: 60 s at 120 BPM (a bar is 2 s).
  const song = {
    envelope: envelopeOf([
      [8, -30],
      [12, -22],
      [40, -10],
    ]),
    durationMs: 60_000,
    downbeatsMs: downbeats(0.1, 2, 60),
    beatsMs: downbeats(0.1, 0.5, 60),
    sectionStartsMs: [8_100, 20_100],
    bpm: 120,
  };

  it('starts on the last downbeat at or just before the biggest rise, the drop', () => {
    const part = choosePart({ ...song, cutMs: 25_000 });
    expect(part).toMatchObject({
      startMs: 20_100,
      lengthMs: 25_000,
      how: 'measured',
      dropMs: 20_100,
      clear: true,
    });
    expect(part.riseDb).toBeGreaterThan(8);
  });

  it('puts dropMs on the bass coming in just after the loudness step (C73)', () => {
    // The loudness steps at 20 s; the bass is heard at 20.9 s.
    const lowEnvelope = lowOf([
      [20.9, -45],
      [39.1, -10],
    ]);
    const part = choosePart({ ...song, cutMs: 25_000, lowEnvelope });
    expect(part.dropMs).toBe(20_900);
    // Nothing else changes: the same part for the same loudness.
    const without = choosePart({ ...song, cutMs: 25_000 });
    expect({ ...part, dropMs: 0 }).toEqual({ ...without, dropMs: 0 });
    expect(without.dropMs).toBe(20_100);
  });

  it('keeps dropMs at the step when the bass has no onset within 2 s of it', () => {
    const late = lowOf([
      [23.5, -45],
      [36.5, -10],
    ]);
    expect(choosePart({ ...song, cutMs: 25_000, lowEnvelope: late }).dropMs).toBe(20_100);
    // A song with no low band at all, or one that does not rise, is the step too.
    const none = lowOf([[60, -200]]);
    expect(choosePart({ ...song, cutMs: 25_000, lowEnvelope: none }).dropMs).toBe(20_100);
    expect(choosePart({ ...song, cutMs: 25_000, lowEnvelope: null }).dropMs).toBe(20_100);
  });

  it('does not look for the bass when no step is clear, or past the end of the part', () => {
    const lowEnvelope = lowOf([
      [10, -45],
      [50, -10],
    ]);
    const flat = choosePart({
      ...song,
      envelope: envelopeOf([[60, -14]]),
      cutMs: 20_000,
      lowEnvelope,
    });
    expect(flat.dropMs).toBeNull();
    // The step is 1.5 s from the part’s end: a bass after the end is not the part’s drop.
    const whole = choosePart({
      ...song,
      envelope: envelopeOf([
        [10, -30],
        [8, -10],
      ]),
      durationMs: 18_000,
      cutMs: 25_000,
      lowEnvelope: lowOf([
        [17.9, -45],
        [0.1, -10],
      ]),
    });
    expect(whole.how).toBe('whole');
    expect(whole.dropMs).toBe(10_000);
  });

  it('is the cut long, and at most two minutes', () => {
    expect(choosePart({ ...song, cutMs: 12_345 }).lengthMs).toBe(12_345);
    const long = choosePart({
      ...song,
      envelope: envelopeOf([
        [30, -30],
        [250, -10],
      ]),
      durationMs: 280_000,
      downbeatsMs: downbeats(0.1, 2, 280),
      sectionStartsMs: [30_100],
      cutMs: 200_000,
    });
    expect(long.lengthMs).toBe(PART.maxMs);
    expect(long.startMs).toBe(30_100);
  });

  it('prefers a rise after the intro to a bigger one inside it', () => {
    // The intro fades in from silence (a huge rise at 6 s); the song's real drop is at 24 s.
    const part = choosePart({
      cutMs: 20_000,
      durationMs: 60_000,
      envelope: envelopeOf([
        [5, -60],
        [19, -18],
        [36, -12],
      ]),
      downbeatsMs: downbeats(0.1, 2, 60),
      sectionStartsMs: [6_100, 24_100],
      bpm: 120,
    });
    expect(part.startMs).toBe(24_100);
  });

  it('takes a rise inside the intro when nothing after it rises', () => {
    const part = choosePart({
      cutMs: 20_000,
      durationMs: 60_000,
      envelope: envelopeOf([
        [3, -60],
        [57, -18],
      ]),
      downbeatsMs: downbeats(0.1, 2, 60),
      sectionStartsMs: [6_100, 24_100],
      bpm: 120,
    });
    // The music comes in at 3 s: the last downbeat before it.
    expect(part.startMs).toBe(2_100);
    expect(part.clear).toBe(true);
  });

  it('counts a downbeat a little after the drop as on it, and takes the one before otherwise', () => {
    const base = {
      cutMs: 20_000,
      durationMs: 60_000,
      envelope: envelopeOf([
        [20, -30],
        [40, -12],
      ]),
      bpm: 120,
    };
    // A downbeat 200 ms late is on the drop (the beat finder is a little behind) …
    expect(choosePart({ ...base, downbeatsMs: [100, 2_100, 20_200, 22_200] }).startMs).toBe(20_200);
    // … one 900 ms late is not: the part starts on the bar before and holds the drop.
    expect(choosePart({ ...base, downbeatsMs: [100, 18_200, 20_900, 22_900] }).startMs).toBe(
      18_200,
    );
  });

  it('slides earlier, onto a downbeat, when the drop is too near the end for a whole window', () => {
    const part = choosePart({ ...song, cutMs: 50_000 });
    // 20.1 + 50 > 60: the last window that fits starts at the last downbeat at or before 10 s.
    expect(part.startMs).toBe(8_100);
    expect(part.startMs + part.lengthMs).toBeLessThanOrEqual(60_000);
    // The drop is where the loudness steps (20 s), not at the downbeat the beat finder gave.
    expect(part.dropMs).toBe(20_000);
  });

  it('uses the whole song when it is no longer than the cut', () => {
    const part = choosePart({ ...song, durationMs: 18_000, cutMs: 25_000 });
    expect(part).toMatchObject({ startMs: 0, lengthMs: 18_000, how: 'whole' });
    expect(choosePart({ ...song, durationMs: 25_000, cutMs: 25_000 })).toMatchObject({
      startMs: 0,
      lengthMs: 25_000,
      how: 'whole',
    });
  });

  it('starts a reel’s own audio at its start, as it is', () => {
    const part = choosePart({ ...song, durationMs: 45_000, cutMs: 30_000, asIs: true });
    expect(part).toMatchObject({ startMs: 0, lengthMs: 30_000, how: 'whole' });
    expect(choosePart({ ...song, durationMs: 20_000, cutMs: 30_000, asIs: true }).lengthMs).toBe(
      20_000,
    );
  });

  it('starts after the intro when no rise is clear, and says so', () => {
    const flat = choosePart({
      ...song,
      envelope: envelopeOf([[60, -14]]),
      cutMs: 20_000,
    });
    expect(flat).toMatchObject({ how: 'measured', clear: false, dropMs: null });
    expect(flat.startMs).toBe(8_100);
  });

  it('works without sections: every downbeat is a candidate', () => {
    const part = choosePart({ ...song, sectionStartsMs: [], cutMs: 25_000 });
    expect(part.startMs).toBeGreaterThanOrEqual(19_900);
    expect(part.startMs).toBeLessThanOrEqual(20_300);
    expect(part.clear).toBe(true);
  });

  it('works without downbeats, from the beats (every fourth)', () => {
    const part = choosePart({ ...song, downbeatsMs: [], cutMs: 25_000 });
    expect(part.startMs).toBe(20_100);
  });

  it('works with no beats at all: it starts on the drop itself, by loudness alone', () => {
    const part = choosePart({
      ...song,
      downbeatsMs: [],
      beatsMs: [],
      sectionStartsMs: [],
      bpm: null,
      cutMs: 25_000,
    });
    expect(part.how).toBe('measured');
    expect(part.startMs).toBe(20_000);
  });

  it('keeps every window inside the song', () => {
    for (const cutMs of [5_000, 17_000, 33_000, 59_000, 60_000]) {
      const part = choosePart({ ...song, cutMs });
      expect(part.startMs).toBeGreaterThanOrEqual(0);
      expect(part.startMs + part.lengthMs).toBeLessThanOrEqual(60_000);
      expect(part.lengthMs).toBe(cutMs);
    }
  });
});

describe('what the beat finder says', () => {
  const answer = {
    version: 1,
    items: [
      {
        file: 'song.wav',
        beats: { times: [0.5, 1, 1.5, 2], confidence: 0.9 },
        downbeats: { times: [0.5, 2.5], meter: 4 },
        bpm: { value: 120, curve: [] },
        sections: {
          spans: [
            { start: 0, end: 20.005, label: 'A' },
            { start: 20.005, end: 40, label: 'B' },
            { start: 40, end: 60, label: 'C' },
          ],
        },
      },
    ],
    _meta: { version: '0.8.198' },
  };

  it('reads the times as ms, and the section starts without the first', () => {
    expect(parseHyperframes(JSON.stringify(answer))).toEqual({
      beatsMs: [500, 1000, 1500, 2000],
      downbeatsMs: [500, 2500],
      bpm: 120,
      sectionStartsMs: [20_005, 40_000],
    });
  });

  it('finds its answer among the lines around it', () => {
    const text = `npm notice something\n${JSON.stringify(answer)}\n  4 HyperFrames skills out of date\n`;
    expect(parseHyperframes(text)?.bpm).toBe(120);
  });

  it('copes with what it leaves out', () => {
    const empty = { items: [{ file: 'x.wav' }] };
    expect(parseHyperframes(JSON.stringify(empty))).toEqual({
      beatsMs: [],
      downbeatsMs: [],
      bpm: null,
      sectionStartsMs: [],
    });
    const odd = {
      items: [
        { beats: { times: [1, 'x', null, -1, 0.5] }, bpm: { value: 0 }, sections: { spans: [] } },
      ],
    };
    expect(parseHyperframes(JSON.stringify(odd))).toMatchObject({
      beatsMs: [500, 1000],
      bpm: null,
    });
  });

  it('is null for anything that is not its answer', () => {
    for (const text of ['', 'not json', '{"items":[]}', '{"ok":false}', '[1,2]', '{broken']) {
      expect(parseHyperframes(text), text).toBeNull();
    }
  });
});

describe('the line for Instagram', () => {
  const part = (startMs: number) => ({
    startMs,
    endMs: startMs + 30_000,
    how: 'measured' as const,
  });

  it('is the shared contract’s, word for word', () => {
    const cases = [
      { title: 'נתתי לך בית', artist: 'Ofek Adanek', startMs: 42_000 },
      { title: 'Song', artist: 'Artist', startMs: 0 },
      { title: 'Song', artist: 'Artist', startMs: 59_499 },
      { title: 'Song', artist: 'Artist', startMs: 59_500 },
      { title: 'Long one', artist: 'Someone', startMs: 3_725_000 },
      { title: 'T'.repeat(120), artist: 'A'.repeat(120), startMs: 61_000 },
      { title: 'T'.repeat(120), artist: 'short', startMs: 61_000 },
      { title: 'short', artist: 'A'.repeat(120), startMs: 61_000 },
      { title: '🎵'.repeat(60), artist: '🎶'.repeat(60), startMs: 90_000 },
    ];
    for (const { title, artist, startMs } of cases) {
      const song = { title, artist, part: part(startMs) };
      const line = instagramLine(song);
      expect(line).toBe(sharedInstagramLine(song));
      expect(line.length).toBeLessThanOrEqual(INSTAGRAM_LINE_MAX);
    }
    expect(INSTAGRAM_LINE_MAX).toBe(SONG_LIMITS.instagramLineMax);
    expect(PART.minMs).toBe(SONG_LIMITS.partMinMs);
    expect(PART.maxMs).toBe(SONG_LIMITS.partMaxMs);
  });

  it('says the start as m:ss', () => {
    expect(clockText(42_000)).toBe('0:42');
    expect(clockText(61_400)).toBe('1:01');
    expect(clockText(3_725_000)).toBe('1:02:05');
    expect(clockText(-5)).toBe('0:00');
  });
});

describe.skipIf(ffmpeg === null)('the decoded song', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-song-part-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A 48 kHz stereo float WAV: 2 s of a quiet sine, then 2 s of one 20 dB louder. */
  const wav = join(dir, 'steps.wav');
  const made = spawnSync(
    ffmpeg ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(lt(t,2),0.01,0.1)*sin(2*PI*440*t)|if(lt(t,2),0.01,0.1)*sin(2*PI*440*t)':s=48000:d=4",
      '-c:a',
      'pcm_f32le',
      wav,
    ],
    { encoding: 'utf8' },
  );
  if (ffmpeg !== null) expect(made.status, made.stderr).toBe(0);

  it('knows where its audio is', () => {
    const info = readWavInfo(wav);
    expect(info.rate).toBe(48_000);
    expect(info.frames).toBe(192_000);
    expect(info.dataStart).toBeGreaterThanOrEqual(44);
  });

  it('measures the power of a sine and the step between two', () => {
    const info = readWavInfo(wav);
    const env = energyEnvelope(wav, info);
    expect(env.power.length).toBe(80);
    // A sine of amplitude a has a mean power of a² / 2.
    expect(windowPower(env, 0, 2_000)).toBeCloseTo(0.01 ** 2 / 2, 7);
    expect(windowPower(env, 2_000, 4_000)).toBeCloseTo(0.1 ** 2 / 2, 5);
    // The step is 20 dB, and it is at 2 s.
    expect(riseDb(env, 2_000, 2_000, 4_000)).toBeCloseTo(20, 1);
    expect(riseDb(env, 1_000, 2_000, 4_000)).toBe(0);
  });

  it('finds the loudest sample in a stretch', () => {
    const info = readWavInfo(wav);
    expect(peakAt(wav, info, 0, 1_440)).toBeCloseTo(0.01, 3);
    expect(peakAt(wav, info, 100_000, 1_440)).toBeCloseTo(0.1, 2);
    expect(peakAt(wav, info, 1_000_000, 10)).toBe(0);
  });

  it('reads the bass out of the low band: a loud mid tone is no onset, a 60 Hz one is (C73)', () => {
    // 3 s of silence, a loud 1 kHz tone from 3 s (the loudness steps, the bass does not), a 60 Hz
    // tone from 4.5 s (the bass comes in).
    const mix = join(dir, 'mix.wav');
    const low = join(dir, 'low.wav');
    const tone =
      "aevalsrc='(if(gte(t,3),0.2*sin(2*PI*1000*t),0)+if(gte(t,4.5),0.3*sin(2*PI*60*t),0))|(if(gte(t,3),0.2*sin(2*PI*1000*t),0)+if(gte(t,4.5),0.3*sin(2*PI*60*t),0))':s=48000:d=8";
    const run = (args: string[]) =>
      spawnSync(ffmpeg ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
        encoding: 'utf8',
      });
    expect(run(['-f', 'lavfi', '-i', tone, '-c:a', 'pcm_f32le', mix]).status).toBe(0);
    const filtered = run(['-i', mix, '-ac', '2', '-af', LOW_BAND_FILTER, '-c:a', 'pcm_f32le', low]);
    expect(filtered.status, filtered.stderr).toBe(0);

    const info = readWavInfo(mix);
    const lowInfo = readWavInfo(low);
    expect(lowInfo.rate).toBe(PART.lowSampleRate);
    const loud = energyEnvelope(mix, info);
    const bass = energyEnvelope(low, lowInfo, PART.lowHopMs);
    // The broadband loudness steps at 3 s ...
    expect(riseDb(loud, 3_000, 1_000, 8_000)).toBeGreaterThan(20);
    // ... the 1 kHz tone hardly reaches the low band, which steps up at 4.5 s.
    expect(windowPower(bass, 3_100, 4_300)).toBeLessThan(windowPower(bass, 4_600, 5_800) / 100);
    const at = bassOnsetAfter(bass, 3_000, 3_000 + PART.bassSearchMs);
    // On the 60 Hz tone's first 20 ms (the filters delay it by a few ms at most).
    expect(at).toBeGreaterThanOrEqual(4_480);
    expect(at).toBeLessThanOrEqual(4_520);
  });

  it('refuses a file that is not a stereo float WAV', () => {
    const bad = join(dir, 'mono.wav');
    writeFileSync(bad, 'RIFF....WAVEfmt ');
    expect(() => readWavInfo(bad)).toThrow();
    const notWav = join(dir, 'x.wav');
    writeFileSync(notWav, 'hello');
    expect(() => readWavInfo(notWav)).toThrow(/not a WAV/);
  });
});

describe('the part from a moment of the song (--start-ms)', () => {
  const song = { durationMs: 182_000, cutMs: 20_000 };

  it('starts exactly there', () => {
    expect(partFromStart({ ...song, startMs: 37_000 })).toEqual({
      startMs: 37_000,
      lengthMs: 20_000,
      how: 'measured',
      dropMs: null,
      riseDb: 0,
      clear: false,
    });
    expect(partFromStart({ ...song, startMs: 0 })).toMatchObject({ startMs: 0 });
  });

  it('slides earlier as far as the song’s end needs', () => {
    expect(partFromStart({ ...song, startMs: 178_000 })).toMatchObject({
      startMs: 162_000,
      lengthMs: 20_000,
    });
  });

  it('is as long as the longest part there can be for a longer cut', () => {
    expect(partFromStart({ ...song, cutMs: 400_000, startMs: 9_000 })).toMatchObject({
      startMs: 9_000,
      lengthMs: PART.maxMs,
    });
  });

  it('is none for a song no longer than the cut', () => {
    expect(partFromStart({ durationMs: 20_000, cutMs: 20_000, startMs: 5_000 })).toBeNull();
    expect(partFromStart({ durationMs: 8_000, cutMs: 20_000, startMs: 2_000 })).toBeNull();
  });
});

describe('the part around the first word (--lyrics-at)', () => {
  const song = { durationMs: 182_000, cutMs: 20_000 };

  it('starts that long before the first word, so the intro leads in', () => {
    expect(partAroundFirstWord({ ...song, firstMs: 16_160, lyricsAtMs: 7_000 })).toEqual({
      startMs: 9_160,
      lengthMs: 20_000,
      how: 'measured',
      dropMs: null,
      riseDb: 0,
      clear: false,
    });
  });

  it('starts at the song’s start when the word comes sooner than asked', () => {
    expect(partAroundFirstWord({ ...song, firstMs: 3_000, lyricsAtMs: 7_000 })).toMatchObject({
      startMs: 0,
      lengthMs: 20_000,
    });
  });

  it('slides earlier as far as the song’s end needs', () => {
    expect(partAroundFirstWord({ ...song, firstMs: 178_000, lyricsAtMs: 7_000 })).toMatchObject({
      startMs: 162_000,
      lengthMs: 20_000,
    });
  });

  it('is as long as the longest part there can be for a longer cut', () => {
    expect(
      partAroundFirstWord({ ...song, cutMs: 400_000, firstMs: 16_000, lyricsAtMs: 7_000 }),
    ).toMatchObject({ startMs: 9_000, lengthMs: PART.maxMs });
  });

  it('is none for a song no longer than the cut', () => {
    expect(
      partAroundFirstWord({ durationMs: 20_000, cutMs: 20_000, firstMs: 5_000, lyricsAtMs: 1_000 }),
    ).toBeNull();
    expect(
      partAroundFirstWord({ durationMs: 8_000, cutMs: 20_000, firstMs: 2_000, lyricsAtMs: 1_000 }),
    ).toBeNull();
  });
});
