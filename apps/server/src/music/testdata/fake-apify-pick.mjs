// The real trending pick (assets/music/trending-pick.mjs) with fake Apify answers and the fake
// getter, for the song command's tests (MUSIC_TRENDING_PICK points the script here). The scenario
// file is the one fake-get-song.mjs reads: `apify` has the items each actor answers (hashtags,
// accounts, sounds), `apifyLog` gets one JSON line per Apify call (the actor, the Authorization
// header, the query and the body). The beat finder is the real one, which the script's
// MUSIC_HYPERFRAMES points at fake-hyperframes.mjs; the key file is one that does not exist.

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pickTrending as realPick } from '../../../assets/music/trending-pick.mjs';
import { getSong } from './fake-get-song.mjs';

export async function pickTrending(options) {
  const scenarioFile = process.env.FAKE_SONG_SCENARIO;
  const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    const actor = parsed.pathname.split('/')[3];
    appendFileSync(
      scenario.apifyLog,
      `${JSON.stringify({
        actor,
        auth: init.headers.Authorization,
        query: Object.fromEntries(parsed.searchParams),
        body: JSON.parse(init.body),
      })}\n`,
    );
    const kind = actor.startsWith('apify~instagram-hashtag')
      ? 'hashtags'
      : actor.startsWith('apify~instagram-reel')
        ? 'accounts'
        : 'sounds';
    return new Response(JSON.stringify(scenario.apify?.[kind] ?? []), { status: 201 });
  };
  return realPick({
    ...options,
    fetch,
    getSong,
    envFile: join(dirname(scenarioFile), 'no.env'),
    retryMs: 1,
  });
}
