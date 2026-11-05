// A stand-in for trending-pick.mjs (SG10) for the song command's tests (MUSIC_TRENDING_PICK). The
// scenario file is the same one fake-get-song.mjs reads: `trendingLog` gets what pickTrending was
// called with (without the environment), `trending` is the answer, `trendingFail` a failure.

import { appendFileSync, readFileSync } from 'node:fs';

export async function pickTrending(options) {
  const scenario = JSON.parse(readFileSync(process.env.FAKE_SONG_SCENARIO, 'utf8'));
  const { env: _env, ...rest } = options;
  appendFileSync(scenario.trendingLog, `${JSON.stringify(rest)}\n`);
  if (scenario.trendingFail) {
    const error = new Error(scenario.trendingFail.message);
    error.code = scenario.trendingFail.code;
    throw error;
  }
  return scenario.trending;
}
