// A stand-in for song-words.mjs (the script loads MUSIC_SPEECH instead): answers what the file
// FAKE_SPEECH_SCENARIO names says, {"ms":16000} for a first word 16 s into the song, or
// {"ms":null,"why":"…"}, or {"throws":"…"} for a finder that breaks. "log" names a file each call is
// appended to (JSON lines: whether the song's start was there to listen to, and how big it was).

import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';

export async function firstSungWordMs({ file, base, timeoutMs }) {
  const scenario = JSON.parse(readFileSync(process.env.FAKE_SPEECH_SCENARIO, 'utf8'));
  if (scenario.log) {
    appendFileSync(
      scenario.log,
      `${JSON.stringify({
        file: existsSync(file),
        bytes: existsSync(file) ? statSync(file).size : 0,
        base: base ?? null,
        timeoutMs,
      })}\n`,
    );
  }
  if (scenario.throws) throw new Error(scenario.throws);
  return { ms: scenario.ms ?? null, why: scenario.why ?? null };
}
