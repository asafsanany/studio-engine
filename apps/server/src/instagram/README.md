# Clients × Instagram: the Apify scan

What is here (IG2): the Apify client, the two actors' inputs and outputs written down, and the answers
of real runs as test fixtures. Mapping the answers into the engine's tables is IG3, when scans run is
IG4, and what they cost on the Money page is IG7.

| File | What |
| --- | --- |
| `apify.ts` | `runActor(actorId, input, options)`, `ApifyError`, `readApifyToken`, `profileScraperInput`, `reelScraperInput` |
| `apify.test.ts` | the client against a fake Apify (no network) and checks on the fixtures |
| `testdata/` | the answers of real runs (and one hand-written), see "Fixtures" below |

## The client

```ts
const { items, runId, costUsd } = await runActor(REEL_ACTOR, reelScraperInput({ ... }), {
  signal,                 // aborting it stops the run on Apify too
  timeoutMs: 10 * 60_000, // the cap for the whole run (default 10 minutes)
  maxChargeUsd: 0.5,      // optional: Apify stops a pay-per-event run at this cost
});
```

It is plain fetch to `https://api.apify.com` (`fetch` is injected in tests):

1. `POST /v2/acts/<user>~<actor>/runs?timeout=<cap in s>[&maxTotalChargeUsd=…]` with the input as the body.
   The run's own `timeout` is the cap, so Apify stops it even if this process is gone.
2. `GET /v2/actor-runs/<id>?waitForFinish=<up to 30>` in a loop until the status is SUCCEEDED, FAILED,
   ABORTED or TIMED-OUT. A wait that breaks (network, 5xx, 429) is tried again, up to 3 times.
3. At the cap: `POST /v2/actor-runs/<id>/abort`, one more read of the run for its cost (on the error as
   `costUsd`), then `timeout`.
4. `GET /v2/datasets/<defaultDatasetId>/items?format=json&clean=1`.

`costUsd` is the run's `usageTotalUsd` (`null` when Apify does not say) **as it stood when the run ended,
which is early**: Apify tallies a pay-per-event run's charges a few seconds later (see "What a scan costs"
below). `readRunCost(runId, options)` reads a run again (`GET /v2/actor-runs/<id>`, a read that breaks is
tried again up to 3 times) and gives `{ status, finished, costUsd }`.

The token is `APIFY_TOKEN` (`APIFY_TOKEN_ENV` in `config.ts`; the environment, then the repo's
git-ignored `.env`; the key Songs uses). It goes in an `Authorization: Bearer` header only, and is taken
out of every error message.

### Errors (`ApifyError.code`)

| code | when |
| --- | --- |
| `no-token` | no `APIFY_TOKEN` (nothing is sent), or Apify answers 401 / `invalid-token` / `token-not-provided` / `missing-api-token` / `user-or-token-not-found` |
| `no-credit` | HTTP 402, or the error type is `not-enough-usage-to-run-paid-actor`, `apify-plan-required-to-use-paid-actor`, `failed-to-charge-user` or `x402-payment-required` (any status) |
| `timeout` | the run went over `timeoutMs` (it is aborted), or Apify's own status is TIMED-OUT |
| `failed` | the run FAILED or was ABORTED (the message has Apify's status message), Apify answered another error (the message has the status, the type and the text), the network broke, or an answer was not the JSON expected. `cancelled` is true when the caller's signal stopped it |

An error also has `status` (the HTTP status when there was one), `runId` (when the run had started: look
it up in the Apify console) and `costUsd` (what the run cost until it stopped, when Apify said).
What Apify documents for a run that cannot be paid for: HTTP 402, "the user has exceeded their usage
limit, does not have enough credits, or the request lacks authentication and payment credentials". Its
list of `error.type` values has `not-enough-usage-to-run-paid-actor` (the one a paid actor's start gives
when the account is out of usage) and `apify-plan-required-to-use-paid-actor`; the docs' own 402 example
shows `x402-payment-required`. A real refusal was not provoked (it needs an account with no credit), so
the client trusts the 402 status first and the types second.

## The actors (read from Apify on 30 Oct 2026)

Prices are the pay-per-event prices of the FREE plan tier that the token's account is on (cheaper on
the paid tiers). Apify bills the events, compute is included.

### `apify/instagram-profile-scraper`

Input (`profileScraperInput`):

| Field | Type | Meaning |
| --- | --- | --- |
| `usernames` | string[], required | Instagram usernames (it also takes ids) |
| `includeAboutSection` | boolean, default false | the "about this account" add-on (date joined, country); left off |

Price: `Profile` $0.0026 per profile written to the dataset; add-on "About account" $0.007 per profile (off).

Output (one item per username), the fields we read: `id`, `username`, `url`, `fullName`, `biography`,
`followersCount`, `followsCount`, `postsCount`, `private` (boolean), `verified`, `isBusinessAccount`,
`profilePicUrlHD` (a link on the Instagram CDN host cdninstagram.com or fbcdn.net, signed: the query
string expires).
It also returns `latestPosts`, `latestIgtvVideos`, `relatedProfiles`, `externalUrl(s)` and more, which
are not kept. `testdata/profile.json` has them trimmed.

### `apify/instagram-reel-scraper`

Input (`reelScraperInput`):

| Field | Type | Meaning |
| --- | --- | --- |
| `username` | string[], required | usernames, profile links, ids or direct reel links (singular: not `usernames`) |
| `resultsLimit` | integer | the most reels per username (ignored for direct reel links) |
| `onlyPostsNewerThan` | string | `YYYY-MM-DD`, an ISO timestamp, or relative (`1 day`, `2 weeks`, `3 months`, `28 days` works); UTC |
| `skipPinnedPosts` | boolean, default false | leave pinned reels out |
| `skipTrialReels` | boolean, default false | leave trial reels out (they are not marked in the output) |
| `includeSharesCount` | boolean, default false | the **shares** add-on |
| `includeTranscript` | boolean, default false | the transcript add-on; left off (`reelScraperInput` sets it false) |
| `includeDownloadedVideo` | boolean, default false | the video download add-on; left off |

Price: `Actor start` $0.001 per run; `Reel` $0.0026 per reel written; add-ons: `Shares count` $0.007 per
reel, `Transcript` $0.048 per started minute per reel, `Video download` $0.02 per started MB per reel.
So a scan of one client with 25 reels costs about $0.066 without shares and about $0.24 with them.

Output (one item per reel), the fields we read: `id`, `type` (`Video`), `productType` (`clips`),
`shortCode`, `url`, `timestamp` (ISO, UTC), `caption`, `videoDuration` (seconds), `videoPlayCount`,
`videoViewCount` (null in every item of the real run: use the play count), `likesCount`, `commentsCount`,
`musicInfo` (`artist_name`, `song_name`, `uses_original_audio`, `should_mute_audio`,
`should_mute_audio_reason`, `audio_id`), `coauthorProducers` (a list of `id`, `username`, `full_name`,
`is_verified`, and a signed `profile_pic_url`; absent when the reel has none), `hashtags` (a list of
strings), `isPinned`, `paidPartnership` (boolean; the sponsors are in a `sponsors` list), `isCommentsDisabled`,
`inputUrl` (the profile that was asked for), and the owner: `ownerUsername`, `ownerId`, `ownerFullName`.
Be aware of the owner: a collaboration reel in a profile's list can belong to another account (in the
fixture, `DfBUU0nDswI` is owned by `natgeoscience` and lists `natgeo` as a co-author).
Other fields (`videoUrl`, `audioUrl`, `displayUrl`, `images`, `dimensions…`, `firstComment`,
`latestComments`, `taggedUsers`, `mentions`, `transcript` with its add-on) are not kept.

**Shares.** The README and the input say the shares come with `includeSharesCount`, "available for
paying users only (the Starter plan)". The real run below was made with the add-on on, from an account
on the Free plan, and the answer had **no shares field at all** (no error, and the run's fields list has
nothing like it). So the name of the shares field is **not confirmed**: the actor's page does not show
it in its example output either. Until a run on a paid plan shows it, treat it as unknown; IG3 should
read it defensively (look for a key matching `/share/i` on the item) and a scan must not fail when it is
missing. The field to look for first is `sharesCount`, like `likesCount` and `commentsCount`.

### Accounts that cannot be read

Both actors answer a missing account with one item and no error status; the run SUCCEEDED:

```json
{ "url": "https://www.instagram.com/<name>", "username": "<name>", "error": "not_found", "errorDescription": "Profile does not exist" }
```

(`testdata/profile-not-found.json` and `reels-not-found.json`, both real). A private account is not a
real answer here: the profile scraper's item for one has `private: true` with the counts and no
posts (`testdata/profile-private.json` is **hand-written** in that shape, not captured), and what the
reel scraper answers for a private account was not captured (its README only says private reels cannot be
read). The mapper (IG3) must treat an item with an `error` field as "this account failed", and a profile
with `private: true` as "no reels to read".

## Real runs (30 Oct 2026, through the Apify MCP, so no key was handled)

| Actor | Input | Run | Items |
| --- | --- | --- | --- |
| profile scraper | `usernames: ["natgeo"]` | `EcqZ6T3g9yn0AXJdv`, SUCCEEDED in 7 s | 1 |
| reel scraper | `username: ["natgeo"]`, `resultsLimit: 5`, `onlyPostsNewerThan: "28 days"`, `includeSharesCount: true` | `lNTjDO0lABgGDA4M5`, SUCCEEDED in 26 s | 5 |
| profile scraper | `usernames: ["studio_engine_no_such_user_8f3k2"]` | `NVXBinmqbAqnNFJFY` | 1 (error item) |
| reel scraper | `username: ["studio_engine_no_such_user_8f3k2"]`, `resultsLimit: 5`, `onlyPostsNewerThan: "28 days"` | `VyC94rVUOKWE826ik` | 1 (error item) |

Cost: the Apify MCP's `get-actor-run` does not show `usageTotalUsd`, so the cost could not be read from
the runs. From the price list above it is $0.0026 (profile) + $0.014 (start + 5 reels) + at most $0.0026
+ $0.0036 (the two not-found runs) = about $0.02; $0.035 more only if the shares add-on had been charged,
and it was not applied. **The first live scan should compare its `costUsd` with the Apify console's
usage for the run**, because the price per event is the only thing this was checked against.

## What a scan costs (C90)

The first two live scans (30 Oct) each wrote `cost_usd = 0.001`, where Apify's runs say $0.0348 and $0.027:
`usageTotalUsd` is read as the run ends and the pay-per-event charges arrive a few seconds after. So the
scan writes the early number, and a cost check (`scan-costs.ts`) corrects it later:

- **When.** The scan queue calls `scanner.settleCosts()` at start and at every 15-minute check. It reads
  the scans that ended at least 3 minutes ago and were never checked (`instagram_scans.cost_settled_at` is
  `null`), one after another, and never holds or fails a scan: it runs beside them.
- **What it writes.** The runs of the scan (`apify_run_ids`) are read again; the cost becomes the larger of
  the stored one and the sum of what the runs say now (the cost only goes up). A run Apify no longer has
  (404), or that says no number, keeps its share of the stored cost. Then `cost_settled_at` is set, so each
  scan is read once. A change publishes `money.changed`, so the Money page refreshes; Money and Analytics
  read `cost_usd` and need nothing else.
- **When it cannot read.** A read that breaks (5xx, 429, a run still going) leaves the scan for the next
  check; no key, or no answer from Apify at all, ends the pass and everything left waits. A scan that still
  cannot be read a week after it ended keeps the cost it has.
- **Scans stored before the check existed** have `cost_settled_at = null` (migration 0027), so the first
  check after the update finds them and corrects them: the two live scans (ids 1 and 2) need no hand edit.
- **Tests** use a fake Apify (`readRunCost` is injected; the fake scanner reads its own made-up runs back),
  so they never reach Apify.

## Fixtures (`testdata/`)

All trimmed to the fields above: nothing else is kept, no key, and no signed link (`profilePicUrlHD` has
its query string cut off, the co-authors have no picture link).

| File | What | From |
| --- | --- | --- |
| `profile.json` | the natgeo profile | real run |
| `reels.json` | 5 natgeo reels from 27 to 30 Oct (one with another owner, three with co-authors, none with shares) | real run |
| `profile-not-found.json`, `reels-not-found.json` | a username that does not exist | real runs |
| `profile-private.json` | a private account (`private: true`) | **hand-written** from the profile shape |

## Services and Money

Apify is in `SERVICES` (`packages/shared/src/domain/services.ts`): paid, pay per run, and its Money
connection is still a `gap` (what a run costs is not recorded per job). IG7 connects the scans' `costUsd`
(corrected by the cost check above).
The hosts this code reaches are `api.apify.com` (covered by `apify.com`) and the Instagram CDN host of
the profile picture link: cdninstagram.com, or Meta's fbcdn.net (`instagram.<place>.fna.fbcdn.net`) on
some runs. Both are in the Apify entry. The pictures of co-authors, tagged users and commenters come from
fbcdn hosts too; nothing here fetches them.
