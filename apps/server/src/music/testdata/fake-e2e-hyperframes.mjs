#!/usr/bin/env node
// The stand-in for `hyperframes audio <file> --only beats,downbeats,bpm,sections --json` that the e2e
// engine sets as MUSIC_HYPERFRAMES (SG12): the beat finder's answer for the song fake-e2e-songs.mjs makes
// (40 s, 120 BPM, a bar every 2 s, a drop at 0:20 that sits 0.9 s after a bar line, as it does on the
// real tracks), whatever file it is asked about. Run as a program, so it is executable.

const SECONDS = 40;
const DROP = 20;

const every = (first, step) => {
  const out = [];
  for (let t = first; t < SECONDS; t += step) out.push(Math.round(t * 1000) / 1000);
  return out;
};

process.stdout.write(
  JSON.stringify({
    version: 1,
    items: [
      {
        file: 'song.wav',
        duration: SECONDS,
        beats: { times: every(0.1, 0.5), confidence: 0.98 },
        downbeats: { times: every(1.1, 2), meter: 4, confidence: 'low' },
        bpm: { value: 120, curve: [] },
        sections: {
          spans: [
            { start: 0, end: DROP + 0.1, label: 'A' },
            { start: DROP + 0.1, end: SECONDS, label: 'B' },
          ],
        },
      },
    ],
    _meta: { version: '0.0.0' },
  }),
);
