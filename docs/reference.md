# Studio Engine reference

Studio Engine is a local app that watches `~/Studio Inbox/<Client>/<Job>` folders, edits each job with the video-use skill through headless Claude Code and shows live progress on a Jobs web page. Each edit waits in [Review](#review) as a live preview, where the owner leaves typed or voice notes or approves it. After Approve the engine renders the final video and exports it to `_Exports/<Client>/<Job>.mp4`.

## Prerequisites

- Node 22 (see `.nvmrc`)
- pnpm (the exact version is pinned in `package.json`; `corepack enable` picks it up)

## Getting started

```bash
pnpm i
mkdir -p ~/.studio-engine
cp config.example.json ~/.studio-engine/config.json
cp money.example.json ~/.studio-engine/money.json
cp .env.example .env
pnpm dev
```

## Make it yours

Nothing in the code is tied to one person. What is yours lives in three files outside it:

| File | What goes in it |
| --- | --- |
| `~/.studio-engine/config.json` | Your settings. `config.example.json` is a starting point; a key the engine does not know is an error. |
| `.env` | Your API keys. `.env.example` lists every key, what it is for and where to get it. All are optional: a feature with no key says so. |
| `~/.studio-engine/money.json` | What you charge and what you pay. See [Money](#money). |

The settings that are most likely yours:

| Key in `config.json` | What it is | Default |
| --- | --- | --- |
| `inboxPath` | The folder watched for `<Client>/<Job>` | `~/Studio Inbox` |
| `currencySymbol` | The symbol money is shown with | `$` |
| `usdToHomeCurrency` | What a dollar is worth in your currency, unless `money.json` says | `1` |
| `instagramDmFrom` | The Instagram usernames whose DMs the DMs page keeps | none |
| `apiCreditsMonthlyUsd` | Your month's API credits, for Analytics | `200` |
| `planMonthlyUsd` | Your Claude plan's price a month, for Analytics | `200` |
| `generateVoiceId` | The ElevenLabs voice of a generated video | a library voice |

`apps/server/src/config.ts` documents every other key and its `STUDIO_*` environment variable. Restart the engine after changing `config.json`.

## Run it in the background (macOS)

Studio Engine can run as a launchd agent. It starts at login, restarts if it stops, and serves the app at http://localhost:4310, so you don't need a terminal.

### Prerequisites

1. Run `pnpm run doctor`. It checks the Claude CLI and its login, the video-use skill, ffmpeg and the rest, and prints the fix for anything missing. Each item is explained under "Running edits" below. Note that bare `pnpm doctor` runs pnpm's own built-in check, not this script.
2. Node 22 and pnpm, with the dependencies installed (`pnpm i`).

### Install

```bash
pnpm agent:install
```

This builds the app with `pnpm build`, writes `~/Library/LaunchAgents/com.studio-engine.server.plist` and loads it with `launchctl bootstrap`. Then open http://localhost:4310. The port is 4310 unless `port` is set in `~/.studio-engine/config.json`.

The plist stores the absolute paths of node, pnpm, the Claude CLI and ffmpeg as they are at install time. Run `pnpm agent:install` again after you change Node, and after the Claude desktop app updates, because its bundled CLI moves to a new folder. Running it again is safe: it replaces the running agent.

### Restart and uninstall

- `pnpm agent:restart` restarts the running server. After you change the code, run `pnpm build` and then `pnpm agent:restart`.
- `pnpm agent:uninstall` stops the agent and removes its plist. The logs and data in `~/.studio-engine` are kept.

### Logs

Everything is in `~/.studio-engine/logs/`:

| File | What it holds |
| --- | --- |
| `server.log` | The server's own log: startup, config and errors. |
| `server.err.log` | Anything written to stderr, including a crash before the logger starts. |
| `jobs/<jobId>.log` | The raw Claude stream and errors for one job: its Brief runs and its edit runs. |
| `clients/<clientId>.log` | The raw Claude stream and errors of one client's style runs (see [Client styles](#client-styles)). |

To follow the server live: `tail -f ~/.studio-engine/logs/server.log`.

If http://localhost:4310 does not open, read `server.err.log` first. A port that another process already uses, or a broken `config.json`, shows up there. launchd keeps restarting the server until the cause is fixed, so the log keeps growing while it fails.

### Fake runner

The fake runner writes the same files as video-use into `<job>/edit/` in about a minute, without starting Claude Code and without spending tokens: a transcript per video or audio file, `takes_packed.md`, `project.md`, `edl.json`, placeholder graphics and `verify/pass_N.jpg` (ffmpeg test patterns). With Review on (the default) it ends with a sample composition in `edit/preview/`; with Review off it ends with `preview.mp4` and `final.mp4`. Before it, the fake Brief run takes about a second and writes a stand-in transcript per audio file under `edit/brief/transcripts/` and a canned `edit/brief.json`, which the engine turns into `edit/brief.md` as it does for a real brief (see [The Brief step](#the-brief-step)). It reports the eight steps as it goes, so the Jobs page moves like a real edit. It's for trying the UI and the pipeline, and it needs ffmpeg.

- **Dev server:** `STUDIO_RUNNER=fake pnpm dev`. Add `STUDIO_FAKE_SPEED=10` to run ten times faster (default 1, about 60 s).
- **Background agent:** it does not read your shell's environment. Put `{ "runner": "fake" }` in `~/.studio-engine/config.json` and run `pnpm agent:restart`; remove that line and restart to go back to Claude. The agent always runs the fake at normal speed.
- **Make it fail:** create an empty file called `.fail-at-render` in the job folder (next to the footage, not inside `edit/`). The job fails at step 8, Render, with "Render failed: injected failure (.fail-at-render)". Delete the file and press Retry to see it finish. The same works for the other steps: `.fail-at-brief`, `.fail-at-transcribe`, `.fail-at-scan`, `.fail-at-plan`, `.fail-at-cut`, `.fail-at-preview`, `.fail-at-check`. `.fail-at-brief` fails the Brief step even for a job whose brief would be reused or skipped.
- **Review (the default):** the fake edit stops after Check. Instead of `preview.mp4` and `final.mp4` it writes the sample composition (about 6 s, the job's name as its title) into `edit/preview/`, and the job goes to Review. After Send notes the fake revise run reads `edit/review/round-N.md`, adds a "## Round N" section to `project.md` (one line per note), retitles the composition "Round N" and goes back to Review. After Approve the fake render run writes `final.mp4`, which is exported as before. Neither runs the Brief step, and a revise run fails at Plan (4) with "Plan failed: edit/review/round-N.md is missing" when the round file is not there. An empty `.fail-transcribe` in `edit/review/voice/` makes the fake transcript of a voice note fail. With `STUDIO_REVIEW=0` (see [Review](#review)) the fake edit goes on to `preview.mp4` and `final.mp4` and the job is ready, as before Phase 3.
- **Styles:** a client's style run takes about a second (divided by `STUDIO_FAKE_SPEED`) and writes a canned `style.md` that names the new files, or, learning from a finished job, says "Learned from <job>" and names the kit the engine copied. An empty `.fail-style` in the client's `_Style` folder makes it fail with "Style stopped: injected failure (.fail-style)"; delete it and retry.

## Open it on your phone

The phone opens the engine at `https://<mac>.<tailnet>.ts.net` (for example `https://studio-mac.tail1234.ts.net`) through [Tailscale Serve](https://tailscale.com/kb/1312/serve). Serve answers only devices signed in to your tailnet and passes their requests on to a server on this Mac's loopback address, which is the only place Studio Engine listens. Below 768 px the app shows its phone layout (Jobs, the job sheet, Settings). It is on by default: `STUDIO_PHONE=0`, or `"phone": false` in `~/.studio-engine/config.json`, turns it off and keeps the Mac layout at every width.

### Everyday: the background agent, Serve to 4310

The everyday setup is the [background agent](#run-it-in-the-background-macos) on port 4310. It serves the built app and the API from the same port, starts at login and restarts if it stops, so the phone works whenever the Mac is awake and Tailscale is on. Point Serve at 4310 once.

### While you develop: Serve to the dev server, 5173

`pnpm dev` starts two servers: the engine on 4310 under `tsx watch`, which serves the API and **no pages**, and the Vite dev server on 5173, which serves the pages and hands `/api` on to the engine. So while you develop, the phone needs Serve pointed at 5173, not 4310 (4310 answers "Not found" to the page). Switch Serve between the two; the doctor accepts both (green, with a note when it is the dev server):

```bash
tailscale serve --bg http://localhost:5173   # while pnpm dev runs
tailscale serve --bg 4310                    # everyday: the background agent
```

The engine behind either one still checks the Tailscale name and login (see Who gets in).

### Turn it on

1. Install Tailscale on the Mac and on the iPhone, and sign in to both with the same account.
2. Keep the engine running (the [background agent](#run-it-in-the-background-macos) does that).
3. On the Mac, run once:

   ```bash
   tailscale serve --bg 4310
   ```

   If Terminal says `command not found: tailscale`, the Mac app hasn't put its command on your PATH. Use the app's own copy instead:

   ```bash
   /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 4310
   ```

   (Or choose Install CLI in the Tailscale app's settings once, and the short command works from then on.) If it prints a link to turn on HTTPS or Serve for your tailnet, open it, approve, and run the command again.

   `--bg` keeps it on after the Terminal closes and after a restart. Use your own port if `port` in `~/.studio-engine/config.json` is not 4310. (Checked with Tailscale 1.104.1.)
4. Run `pnpm run doctor`. Its Tailscale line shows the address, `Serve: https://<mac>.<tailnet>.ts.net → 127.0.0.1:4310` (for the dev server: `→ 127.0.0.1:5173 (the dev server)`). Open that address on the iPhone.

### Add it to the Home Screen

In Safari on the iPhone, open the address, tap Share, then Add to Home Screen, and open Studio Engine from its icon. It opens like an app, without Safari around it, dark from the first frame. The first visit in the browser shows a card with these three steps above the page; "Not now" hides it for 30 days, and the app itself never shows it. The icon is drawn in `scripts/app-icon.svg`; after changing it, `node scripts/make-app-icons.ts` renders the PNGs in `apps/web/public` (it draws with Google Chrome).

### Turn it off

```bash
tailscale serve --https=443 off
```

`tailscale serve reset` also works, but it clears every Serve setting on this Mac, not just this one.

### Never use Funnel

`tailscale funnel` puts the engine on the public internet, where anyone can reach it. Never use it for Studio Engine. While Funnel is on for the engine, `pnpm run doctor` fails and prints the command that turns it off.

### Who gets in

Before any page or API route answers, every request passes three checks. A request that fails one gets 403 "Not allowed.":

- **Host:** `localhost`, `127.0.0.1` or `[::1]` (any port), or the Mac's Tailscale name. This also stops a web page that points its own name at your Mac (DNS rebinding).
- **Tailscale login:** Serve adds the login of the person whose device sent the request (`Tailscale-User-Login`). Only listed logins get in, and by default that is the account this Mac is signed in with. Other people on your tailnet, such as someone you shared a device with, get "Not allowed". Requests from this Mac itself need no login.
- **Same-origin writes:** a change (anything but reading) sent from another web page is refused.

The engine reads the Mac's name and owner from `tailscale status --json` when it starts and every 5 minutes after that. To set them yourself, add either list to `~/.studio-engine/config.json` and restart (`pnpm agent:restart`):

```json
{
  "remoteHosts": ["studio-mac.tail1234.ts.net"],
  "remoteLogins": ["you@example.com", "partner@example.com"]
}
```

Each list replaces what Tailscale says. `"remoteHosts": []` lets nobody in from outside this Mac.

When the phone wakes the app, the page checks its live updates: if nothing has arrived for 20 seconds (the engine pings every 15), it reconnects and reloads.

## Try it on a scratch inbox

A second engine can run next to the dev server or the background agent, on its own inbox, database and port. Nothing in `~/Studio Inbox` or `~/.studio-engine` is touched, apart from reading `config.json` (see the first warning). The `pnpm e2e` test boots an engine the same way. It is a good way to try the app, or a change to it, with the [fake runner](#fake-runner), without a real Claude run.

```bash
pnpm build

SCRATCH="$(cd "$(mktemp -d)" && pwd -P)"
mkdir -p "$SCRATCH/inbox" "$SCRATCH/data"

PATH="$(dirname "$(command -v node)"):/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
NODE_ENV=production \
STUDIO_DATA_DIR="$SCRATCH/data" \
STUDIO_INBOX="$SCRATCH/inbox" \
STUDIO_PORT=4311 \
STUDIO_RUNNER=fake \
STUDIO_SETTLE_MS=2000 \
node apps/server/dist/index.js
```

Then open http://localhost:4311. The server runs in this terminal; press Ctrl+C to stop it.

- `pnpm build` comes first: the server is the built `apps/server/dist/index.js`. With `NODE_ENV=production` it also serves the built web app on its own port, as the background agent does.
- `STUDIO_DATA_DIR` holds the database (`engine.db`) and the job logs. `STUDIO_INBOX` is the watched folder; finished videos go to `<inbox>/_Exports`. `STUDIO_PORT` must not be 4310 (the agent and `pnpm start`) or 5173 (the Vite dev server).
- `PATH` is the one the launchd agent gets: Node's folder, Homebrew (ffmpeg, ffprobe), `~/.local/bin` (uv) and the system folders. A bare launchd job has none of them. The agent also adds the folders of pnpm, Claude and ffmpeg as found at install time; its full value is in its plist: `/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PATH' ~/Library/LaunchAgents/com.studio-engine.server.plist`.
- `STUDIO_RUNNER=fake` makes the engine write fake edits instead of starting Claude Code, so it spends no tokens (see "Fake runner" above for `STUDIO_FAKE_SPEED` and the `.fail-at-*` files). Leave the line out, or use `STUDIO_RUNNER=claude`, for a real edit.
- `STUDIO_SETTLE_MS=2000` queues a job after 2 s of quiet instead of the default 60 s.
- Review is on by default: the fake edit ends in Review with a live composition, and Approve renders and exports it (see [Review](#review)). `STUDIO_REVIEW=0` gives the flow before Phase 3: the fake edit renders a video and the job is ready on its own.
- Series is on by default too: a ready job can start a series, and a new folder named after it joins that series. `STUDIO_SERIES=0` (or `"series": false` in `config.json`) turns it off: no job joins a series and the series routes answer 404.
- The phone layout is on too: a browser window narrower than 768 px shows the phone's Jobs list, job sheet and Settings instead of the sidebar app (see [Open it on your phone](#open-it-on-your-phone)). `STUDIO_PHONE=0` (or `"phone": false` in `config.json`) keeps the Mac layout at every width.
- The Graphics page is on too: it sits under Clients in the sidebar, and each graphic is made by a Claude run (with `STUDIO_RUNNER=fake`, a canned one). `STUDIO_GRAPHICS=0` (or `"graphics": false` in `config.json`) turns it off: no Graphics page, and the graphics routes answer 404.
- Graphics in edits is on too: every edit can use the library (see [Graphics in edits](#graphics-in-edits)). `STUDIO_GRAPHICS_IN_EDITS=0` (or `"graphicsInEdits": false` in `config.json`) turns it off.
- The LUTs page is on too: it sits under Graphics in the sidebar, shows every LUT as a before/after on a test frame and imports your own `.cube` and `.3dl` files into `<inbox>/_LUTs`. `STUDIO_LUTS=0` (or `"luts": false` in `config.json`) turns it off: no LUTs page, and the LUTs routes answer 404. Notes naming a LUT (`@luts/name`) are on too (see [Naming a LUT in a note](color-grade.md#naming-a-lut-in-a-note)): type `@` in a Review note or the job note and pick one, and the edit's colour grade uses it. `STUDIO_LUTS_IN_EDITS=0` (or `"lutsInEdits": false` in `config.json`) turns that off; it still does nothing while `STUDIO_LUTS` is off.
- The Fonts page is on too: it sits under LUTs in the sidebar, shows every font family in `<inbox>/_Fonts` set in English and Hebrew in every weight, and imports your own `.ttf`, `.otf`, `.woff` and `.woff2` files into it (see [Shared fonts](#shared-fonts)). `STUDIO_FONTS=0` (or `"fonts": false` in `config.json`) turns it off: no Fonts page, and the Fonts routes answer 404. Notes naming a font (`@Heebo Bold`) are on too (see [Shared fonts](#shared-fonts)): `STUDIO_FONTS_IN_NOTES=0` (or `"fontsInNotes": false` in `config.json`) turns them off.
- The Settings page (bottom of the sidebar, admin only) turns the Graphics, Fonts and LUTs switches on and off: it writes `graphics`, `fonts` and `luts` to `~/.studio-engine/config.json` (Music and Songs are not on it: they act only when a job asks for music, so turn them off with `STUDIO_MUSIC=0` and `STUDIO_SONGS=0`, or `"music": false` and `"songs": false` in `config.json`), and **Restart engine** on the page makes them count (the engine must run as the launchd agent to restart itself; an environment variable such as `STUDIO_FONTS` beats `config.json`, and then its switch is locked on the page).
- Quick fixes are on too (`STUDIO_QUICK_FIXES=0`, or `"quickFixes": false` in `config.json`, turns the switch off: Review is exactly as it was before Auto, and the fix routes answer 404): with Auto effort in Review, a note that only changes the layer on top of the cut (a font, a caption's words, a colour, a title) is sorted by a small pass and fixed in Review at once, in about a minute, and the bigger ones wait for Send. The engine sorts each new note of a job on Auto in the background (a small Haiku run, logged in `logs/fix-route.log`) and fix the quick ones (a Sonnet run, one at a time per job and two jobs at once, that changes only `edit/preview/` and `edit/project.md`, kept as a copy in `edit/review/fixes/<id>/before/` so Undo can put them back; `GET /api/jobs/:id/fixes`, `POST /api/jobs/:id/fixes/:fixId/undo` and the before/after stills at `GET /api/jobs/:id/fixes/:fixId/compare/before.png`). While a fix is queued or running, Approve, Send, Export MP4, going back to an earlier cut and the music's Make another and Pick wait. A note fixed this way stays in the list as unsent until the round ends: Send puts it in `edit/review/round-N.md` under "Already changed in Review (keep these)" (its time, its words and what the fix said) and needs at least one note that still waits; with Auto, Send also waits while a note is being sorted and saves the tier of the revise run (`jobs.revise_tier`: Revise is Sonnet at High with a slim self-check, Full is the configured model at Extra high with today's check; a level chosen in `PUT /api/jobs/:id/review-effort`, `auto` or Medium/High/Extra high, makes every note wait and run at that level, as before Auto). Approve works when every unsent note was fixed here; those notes are stamped sent with round `job.round + 1`. Both clear the round's `edit/review/fixes/` files. On screen, each note gets a line under it ("Reading the note…", "Fixing it now · Changing the caption font", "Fixed in 48 s" with Undo on the newest fix, or "Goes with Send" and why), the video gets a pill ("Fixing at 0:12…", then "Changed at 0:12" with a Compare button that shows the moment as it was before while it is held), the footer says what Send or Approve will do, and the Effort menu starts with Auto (Medium, High and Extra high are the levels as before: every note waits for Send and runs at that level). Two kinds of job never take a quick fix (`review/generated-route.ts`, a guard in front of whichever router the engine uses): on a generated video a note about what is in a clip or about how the voice says a line is sorted `full` (it needs a new take of a clip or the line made again, which only a revise run can make) by the same word lists and the same clock as the hint under the note in Review, before the Haiku router is even asked, and the router's prompt has one more section for the notes the words miss (`prompts/fix-generated.md`); on a job with two formats a note the router calls quick is raised to `revise` and waits for Send, because a quick fix changes only `edit/preview/` and would leave the second format as it was.
- Music is on too (`STUDIO_MUSIC=0`, or `"music": false` in `config.json`, turns the switch off: prompts are what they were, Review has no Music row or button, and every `/api/jobs/:id/music` route answers 404 "Music is off."; `/api/health` says `music`). On is not the same as music in every video: music is made or fetched **only when the job asks for it** (the owner's note or the client's words ask for it, a music file or a series kit supplies it, a series or client-style rule tells to have music, a song is asked for, or the owner makes it themselves in Review with **Make music for this video**). Otherwise the editor records "No music asked for" (the music script's `none --plan`: nothing is made, no ElevenLabs credit is spent, the composition gets silence of the cut's length so a version made later drops straight in) and Review and the job sheet say so. When it is asked for, ElevenLabs makes it from the brief, fitted to the cut (`apps/server/assets/music/make-music.mjs`: `make`, `pick`, `supplied`, `series`, `none`, `song`, `song-note`; its header lists the command lines); Review lists the versions, makes another and picks the one that goes in (`GET` and `POST /api/jobs/:id/music`, `PUT /api/jobs/:id/music/pick`). The ElevenLabs key is the one in `~/Developer/video-use/.env`, with the Music permission; `pnpm run doctor` checks it ("ElevenLabs music", a free plan call).
- Songs are on too (`STUDIO_SONGS=0`, or `"songs": false` in `config.json`, turns the switch off; `/api/health` says `songs`). It builds on Music, so it is off whenever music is (`STUDIO_MUSIC=0`); a `songs` written down as on while music is off is left off and the boot log says so. Like music it acts only when asked: the song Yael asks for (a screenshot of a reel, a link, a name, or "a trending song", in the note) gets into the edit, the editor cuts to it, and Approve gives two MP4s, one with the song to show (`<Job>.mp4`) and one without it to post (`<Job> · no song.mp4`, made after the first; `GET` and `POST /api/jobs/:id/no-song`, and `GET /api/jobs/:id/download?file=no-song`), plus a line for adding the song in Instagram. The screenshots go with the note (`GET /api/jobs/:id/note` and `POST`, `GET`, `DELETE /api/jobs/:id/note/attachments`). The editor gets the song with the music script's `song` command (the part of it that fits the cut is measured; a trending pick is ranked only by Instagram's own signals) and records a screenshot whose audio label says "Original audio" with `song-note`: there is no song to look up, so nothing is guessed. YouTube runs through `yt-dlp` and `deno` (`STUDIO_YT_DLP` and `STUDIO_DENO`, default `/opt/homebrew/bin/yt-dlp` and `/opt/homebrew/bin/deno`: the launchd agent has no Homebrew in its PATH), and Instagram and TikTok links through Apify with `APIFY_TOKEN` in `.env` (never through Instagram itself, never with your browser's cookies). While songs is on, `pnpm run doctor` also checks them and prints the one-line fix for each: `yt-dlp` (a failure when it is missing; a `!` when it is more than 60 days old), `deno` (2.3 or newer), `ffmpeg for songs`, `Apify key` (a `!` when `.env` has no `APIFY_TOKEN`: only reel links and trending songs need it), and, with the network checks, `YouTube` (a simulated download of a public test video, nothing is saved, that shows whether yt-dlp can use deno; after a lot of songs in a short time YouTube can answer "too many requests" (HTTP 429): the doctor then prints a `!` that says so, says it is not a problem with yt-dlp or deno and that it clears by itself, usually within an hour, so it does not look like a broken install) and `Apify` (a free account lookup that shows the key works and the month's credit left). With songs off the doctor prints nothing new.
- **Generated videos on Kling 4.0, the way the test worked (U31, U32, v0.56.0, 27 Oct 2026).** This supersedes the Kling 3.0, looks, keyframes and reference-element parts of the next bullet. The Generate run plans in words (`edit/generate/story.md`), makes the voice, then writes each scene as ONE `kling4_0` text-to-video prompt at 720p of up to 30 seconds with timecoded shots on the scene’s own clock ("0:00-0:04: … 0:04-0:09: Hard cut. …"), timed to the voice windows; a 30 to 35 s video is two scenes of about 15 s. Kling 4.0 at 720p is 0.5 credits a second (a 30 s video is about 15 credits), and 1080p is double. No pictures are generated: no looks, no start or end frames, no reference elements (`cast` is always empty and a clip’s `start` and `end` are `null`, which the progress reader and the plan schema now allow). The one picture that goes in is the client’s own logo file, sent with `media_upload`, `make-shots.mjs put` and `media_confirm`, for the scenes that show a person in the uniform (`reference-to-video`, the logo as `image_references`): so the technician wears the logo. `make-shots.mjs save` takes the generated soundtrack out of every clip (`audio: dropped`; Kling 4.0 adds one whatever the prompt says), and the run joins the kept takes into `edit/generate/footage.mp4` with ffmpeg and looks at a one-frame-a-second sheet. The connector allowlist shrank to `generate_video`, `generate_video_batch`, `jobs_wait`, `media_upload`, `media_confirm`, `models_explore` and `balance`. The budget ladder is 720p, fewest seconds, no retakes. Verified on a 4 s test (27 Oct, 2 credits, reference-to-video with the logo as image_references): the logo came out correct on the left chest and large on the back, spelled right and with no black box, and stayed on the fabric as he walked; the prompt says it is printed directly on the fabric with no black box or background.
- **Generated videos on the Higgsfield plan (U26 to U29, v0.55.0, 27 Oct 2026).** The pictures and clips of a video with no footage are made on the Higgsfield PLAN’s credits through the "Higgsfield" connector of the Claude account (`https://mcp.higgsfield.ai/mcp`, tools `mcp__claude_ai_Higgsfield__*`), not through the API key and its separate dollar balance. This replaces what the next bullet says about the API, the key and the balance (the old `estimate`, `upload`, `still` and `clip` commands of `make-shots.mjs` are still in the script, unused, until a cleanup removes them). How it works: the Generate run (and the revise run of a generated video, for retakes) is started WITHOUT `--strict-mcp-config`, which would hide every connector, with `ToolSearch` and only the connector tools in `HIGGSFIELD_TOOLS` (`claude-command.ts`: generate_video, generate_image, their batch forms, jobs_wait, media_upload, media_confirm, manage_reference_elements, models_explore, balance); everything else the account has is denied. It always runs on the plan login (a claude.ai connector does not exist with an API key), whatever the "Claude plan only" switch says. The prompt (`generate.md` and `generate-connector.md`) has the run tell the video in words first (`edit/generate/story.md`), make a reference picture of each person and prop and turn it into a reference element, then make a few long Kling 3.0 scenes of 3 to 15 seconds (std, pro for hands and bodies, sound off, a start frame, the elements in the prompt) that the model cuts into shots itself. Every picture and scene is priced with `get_cost`, booked, made, waited for and saved with `make-shots.mjs` `book`, `save`, `void` and `put`, which keep the same files and `spend.json` as before: the plan’s credits are booked in dollars at `generateUsdPerCredit` (`STUDIO_GENERATE_USD_PER_CREDIT`, default 0.056, the 1,000 credit pack), so the Jobs row, Analytics and Money stay in dollars. `STUDIO_GENERATE_BUDGET_USD` now defaults to 5 (Kling 3.0 std with the sound off is 1.5 credits a second: a 35 s video is about $3 for one pass). On the Money page the Higgsfield charge is included in the plan when `~/.studio-engine/money.json` has a Higgsfield line (an `id` or name with "higgsfield", its price, `credits`). The doctor’s "Higgsfield key" check became "Higgsfield connector" (`claude mcp list`; the plan’s balance can only be read by a Claude run).
- Generated videos are on (`STUDIO_GENERATE=0`, or `"generate": false` in `config.json`, turns the switch off; first real job: PINEWOOD "97 Window Ad", 25 Oct 2026, 91 minutes from the folder to Review with no hands, $2.93 of the $3 on Higgsfield): a job with no footage, only a brief, a script and references, gets its voice (ElevenLabs), keyframes and short clips (Higgsfield's API) made before the edit, which then cuts them to the voice and stops at Review. `/api/health` says `generate`. It is being built: the switch, the contract and the Generate stage in the engine are in place (nothing else of the web app shows it yet, on or off) (`packages/shared/src/domain/generate.ts` is the contract: the files under `edit/generate/`, the state a generated job carries as `Job.generate` and at `GET /api/jobs/:id/generate`, the error texts, the budget ladder and the JSON lines of the two scripts in `apps/server/assets/generate/`, whose keyless stubs (`STUDIO_GENERATE_FAKE=1`) write placeholder files). `STUDIO_GENERATE_BUDGET_USD` (or `"generateBudgetUsd"`, default 3, above 0) is what one video may spend on Higgsfield, the first pass and every review round, all in; a note such as "budget $5" raises it for one job. The voice is made with ElevenLabs (`apps/server/assets/generate/make-voice.mjs`: `line`, `check`, `assemble`, `sfx`; its header lists the command lines): `STUDIO_GENERATE_VOICE_ID` (or `"generateVoiceId"`, default Kal Jones, a voice from ElevenLabs' voice library) names the voice, and the ElevenLabs key in `~/Developer/video-use/.env` must be allowed Text to Speech, Sound Effects and Speech to Text (and Voices (read), for the doctor's "ElevenLabs voice and sound effects" check, which runs only while Generated videos is on); `STUDIO_GENERATE_FAKE=1` makes that script a keyless stub for tests. The shots are made with Higgsfield's API (`apps/server/assets/generate/make-shots.mjs`: `estimate`, `upload`, `still`, `clip`; its header lists the command lines): every `still` and `clip` is priced with the free estimate first and refused with `over_budget` when `edit/generate/spend.json` plus the price would pass the budget, a `clip` waits at most about 9 minutes and then answers `pending` (the same command picks the request up again, never a second charge), and it has no `reframe` (Higgsfield has no model for it); `STUDIO_GENERATE_FAKE=1` makes it a keyless stub too. The Higgsfield key is `HIGGSFIELD_API_KEY` (`id:secret`) in the git-ignored `.env` (see `.env.example`); `STUDIO_ENV_FILE` moves that file, and a `claude` run will be given only its path, never the key. The doctor's "Higgsfield key" check (a free `GET /models`; the balance cannot be read) runs only while Generated videos is on. Steps 1 to 8 are not renumbered: Generate is not a ninth step, a generated job stays on step 1 while it works and carries its own state. The Generate stage (`apps/server/src/pipeline/generate-step.ts`) runs between the Brief step and the edit for a job whose brief says `production: generate`: a headless Claude run (the edit model and effort; Bash only for the two scripts, ffmpeg, ffprobe, ls, `mkdir -p ./edit/` and video-use's helpers; its environment holds only the path of the env file, the voice id and a 10-minute Bash timeout, and it may not read either `.env`) plans the shots, makes the voice and the clips and hands off `edit/generate/shots.json`; the engine reads the files it leaves about once a second to keep the row (`job_generate`, `Job.generate`, the `job.generate` event), the spend (the not-refunded entries of `spend.json`) and the History (`edit/generate/history.jsonl`, `GET /api/jobs/:id/generate/history`) current, copies the kept takes into `generate/shots/`, appends the "Generated footage" section to `brief.md` and lets the edit start. The run's prompt is `apps/server/prompts/generate.md` with two parts, `generate-checks.md` (how a clip take is checked) and `generate-use.md` (what exists is kept, what each script exit code means, when "Blocked:" is the answer); `generate-prompt.test.ts` pins its steps, its command lines (against the scripts' own flags and the run's Bash allow-list) and the two files the engine reads. In order it tells the run to read the brief and the client's files, watch the reference video into `edit/generate/reference.md`, write `plan.json`, make the voice first, price everything with the free estimates and walk the budget ladder (the cheap model, shorter clips, the calmest clip as a still with a slow push, no retakes, then "Blocked: this video needs about $N; the budget is $M"), make the looks and keyframes (looked at before use), one take of each clip checked with ffmpeg frame sheets (a failed take is retaken once, a clip that stays bad is `belowBar`), the sound effects, and hand off `shots.json` and `project.md`. Nothing times a silence (a clip is waited for for minutes); the only limit is four hours of wall clock. A last line "Blocked: …" or a script's refusal fails the job at step 1 with the plain sentence of the contract (an empty balance, a key not accepted, over the budget with the dollars); running out of budget in the middle is not an error, the run finishes with its best takes and lists the clips below the bar. Retry and Resume run the stage again from what is on disk: a complete hand-off of the brief's script finishes it with no run, otherwise the run is told what exists and makes only what is missing. With the fake runner (`STUDIO_RUNNER=fake`) the stage calls the two scripts' fake path (`pipeline/fake-generate.ts`, about 26 s at speed 1); a file `.fail-at-generate` in the job folder (`[code] [after=N] [voice]`, e.g. `balance_empty after=12`) makes them fail the way a service does. The edit and the revise prompts of a generated video (GN6; a job whose `edit/brief.json` says `production: generate`, read when the run starts): an edit run (start, resume, retry) gets `prompts/generated.md` after the footage rules (the clips of `shots.json` are the footage, `voice.mp3` is the speech with its word times in `voice-words.json` and is never transcribed again or stretched, the cut follows the voice, the captions are the script's words in the reference's look, and the alert glow, offer cards and end card are HyperFrames layers), and a revise run gets `prompts/generate-revise.md` in its list of notes: an edit change as ever, what is in a clip (one new take, from the same keyframe or a new one, within `budget - spend.json`, which the prompt states with the two scripts' paths) and the voice (that line made again, the others kept, the cut shifted by the length difference). That run is given the path of the env file, the voice id and the 10-minute Bash timeout (never a key), and may not read either `.env`. A footage job's and a render run's prompts are unchanged, byte for byte.
- Stock media is off (`STUDIO_STOCK=1`, or `"stock": true` in `config.json`, turns it on): an edit or revise run can get a sound effect from Openverse (free, CC0, public domain or CC BY, 15 s at most) or a photo from Unsplash when the footage has none, and the job sheet lists every item it took, with who made it and its license (a "Stock media" part, from `GET /api/jobs/:id/stock`; it shows only for a job that took something, switch on or off). The edit run is told how in `apps/server/prompts/stock.md` (a revise run gets `stock-revise.md`) and calls the stock script, `apps/server/assets/stock/stock.mjs` (`sfx`, `photo`, `get`, `list`; its header lists the command lines): a search prints up to 8 candidates with a `ref`, `get <ref>` downloads one into `edit/stock/` and records it in `edit/stock/stock.json` (the contract is `packages/shared/src/domain/stock.ts`), searches are kept in `edit/stock/cache.json` so a revise run does not ask again, and one run may make 6 searches and fetch 8 files. A photo's download is reported to Unsplash, as its API guidelines require. The keys are in the git-ignored `.env` (see `.env.example`): `UNSPLASH_ACCESS_KEY` for photos, and `OPENVERSE_CLIENT_ID` with `OPENVERSE_CLIENT_SECRET` for sound effects (optional: without them Openverse answers as an anonymous application, with low limits). Only the script reads them: a `claude` run is given the PATH of the file (`STUDIO_ENV_FILE`), never a key, and may not read it. `STUDIO_STOCK_FAKE=1` makes the script answer from canned data (two sound effects and two photos for any words, placeholder files, no key, no network), which the fake runner uses to take one of each in step 6. The doctor's "Openverse sound effects" and "Unsplash photos" checks run only while Stock media is on. With it off every prompt is what it was, byte for byte.

To give it a job, put a small video in the inbox:

```bash
mkdir -p "$SCRATCH/inbox/Acme/Spring promo"
ffmpeg -loglevel error -f lavfi -i testsrc=duration=3:size=640x360:rate=25 -pix_fmt yuv420p "$SCRATCH/inbox/Acme/Spring promo/clip.mp4"
```

The page shows it arrive, queue, edit and wait in Review. Open it with Review, then Approve: it renders and is ready.

When you are done, stop the server and run `rm -rf "$SCRATCH"`.

Two warnings:

- **`config.json` is always the real one.** The server reads `~/.studio-engine/config.json` even when `STUDIO_DATA_DIR` points somewhere else. The environment wins over the file, so every `STUDIO_*` value you set replaces the file's. Every key you leave unset still comes from it. In particular `exportsDir`, `dbPath` and `logsDir` in `config.json` beat the folders that follow `STUDIO_INBOX` and `STUDIO_DATA_DIR`, so the scratch engine would use your real exports, database or logs; set `STUDIO_EXPORTS_DIR`, `STUDIO_DB_PATH` and `STUDIO_LOGS_DIR` too if the file has them. A broken `config.json` stops the scratch engine as well. To ignore the file, also start the server with `HOME="$SCRATCH/home"` (create the folder first), as the e2e test does. Don't do that for a real Claude edit: Claude Code looks for its login and the skills under `HOME`.
- **Never let two engines watch the same inbox.** Each engine has its own database, so each would queue every job folder and edit it, at the same time, in the same `edit/` folder. The background agent and `pnpm dev` both watch `~/Studio Inbox` unless `config.json` says otherwise, so a scratch engine needs a different `STUDIO_INBOX`. It also needs its own `STUDIO_DATA_DIR` and its own port.

## Scripts

| Command                | What it does                                      |
| ---------------------- | ------------------------------------------------- |
| `pnpm dev`             | Runs every workspace's `dev` script in parallel   |
| `pnpm build`           | Builds every workspace                            |
| `pnpm start`           | Runs the built server (`NODE_ENV=production`), which serves the built app on port 4310. Run `pnpm build` first |
| `pnpm test`            | Runs all Vitest projects (`apps/*`, `packages/*`) |
| `pnpm lint`            | Biome lint + format check                         |
| `pnpm format`          | Biome: apply formatting and safe fixes            |
| `pnpm typecheck`       | TypeScript across the repo                        |
| `pnpm e2e`             | Builds the app, then runs the Playwright tests: the built server with the fake runner on a temp inbox, driven through the real pages: the review loop (`review.spec.ts`, with a fake microphone) and the flow without Review (`smoke.spec.ts`, `STUDIO_REVIEW=0`: the Jobs, Clients and client pages), the Brief, the queue place, client styles and new clients, the Analytics page and its switch (`analytics.spec.ts`), and the phone layout (`e2e/phone/`, its own Playwright project `phone`: Chrome at iPhone 15 size with touch; run it alone with `pnpm exec playwright test --project=phone`). It needs Google Chrome (used as installed, nothing is downloaded) and ffmpeg (for the test media) |
| `pnpm release:check`   | Versioning rule: release entry, order, X vs tag   |
| `pnpm check`           | `lint` + `typecheck` + `release:check` + `test` (must pass) |
| `pnpm run doctor`      | Checks the Claude CLI, the skills, ffmpeg and the rest (see "Running edits"). Use `run`: bare `pnpm doctor` is pnpm's own check |
| `pnpm agent:install`   | Builds the app and installs the background agent  |
| `pnpm agent:uninstall` | Stops the background agent and removes it         |
| `pnpm agent:restart`   | Restarts the background agent                     |
| `pnpm seed:canvas`     | Dev only: serves the built web app with the design canvas's twelve sample jobs, for design QA. No inbox, no edits, only a temp folder. `--phone` turns the Phone switch on, so a browser window under 768 px (390 px, say) shows the phone layout. `--analytics` replaces the twelve with about forty finished jobs over 13 weeks and the logs the Analytics page reads (`/analytics`); with `--empty` it shows the empty page. `--music` turns the Soundtrack switch on and replaces the twelve with one job for each state of the Soundtrack boards (the Music list in Review and the job sheet's Music row: made once or twice, being made, failed, off, a file in the folder, a style that says no music, a series episode), with their music files made by the music script's fake path (needs ffmpeg); Make another and Pick work on any job in Review. `--luts` writes four small generated LUTs of Yours into the seed's `_LUTs` (with used counts, one added two minutes ago so it carries New) and shows the built-in ones from the installed colour-grade skill; the stills are made by ffmpeg when it is there (`--lut-previews fake` skips it), and import, rename, duplicate and delete work for real inside the temp folder. `--luts-empty` seeds nothing of Yours. `--fonts` turns the Fonts switch on and copies five small test families into the seed's `_Fonts` (one added two minutes ago so it carries New); import, Show in Finder (recorded, not done) and delete (to the seed's own Trash) work for real inside the temp folder. `--fonts-empty` seeds an empty `_Fonts`. `--fonts-in-notes` is `--fonts` with the fontsInNotes switch on too (sample used counts in the list and the pane, Copy @name and "To use it", as in the boards). `--fonts-missing 3` is that with 1 to 3 open requests for a font the library does not have (Gotham Bold, Avenir Next, Proxima Nova Bold), for the banner on top of the page (its Not a font button dismisses a request). `--generate` turns the Generate switch on and replaces the twelve with the jobs of Generated videos: four in Review (a generated job with two formats and the board's three notes, a generated job with one format, an ordinary job, a footage job with two formats) and one "97 Window Ad · <state>" job of Pinewood for each state of the boards GNStates and GNSheet (the Brief at work, the voice, the looks, the keyframes, the clips, the Higgsfield balance empty, the key not accepted, over the budget, the budget ran out with a clip below the bar, and approved with a file for each format), each with the stage's History and step times, with no call to Higgsfield or ElevenLabs (Export MP4 works there too, per format, with the fake runner's stand-in clip). `--quick-fixes` turns the Quick fixes switch on and replaces the twelve with eleven jobs in Review, one for each state of the Quick fixes boards (reading a note, fixing it, fixed with Undo and Compare, two in a row, a round with a cut note and the music waiting for Send, a whole-video note, couldn't do it here, undone, all fixed with one Hebrew note, a level picked, and an empty round to type in); the note routing, the fix service and the fix routes are the real ones with the fake router and the fake fix, so a note typed in any of them is read, fixed and undone for real (`--fix-speed 0.5` slows the fix's steps down to look at them) |

`pnpm e2e` is not part of `pnpm check`, because it needs Chrome. Set `E2E_KEEP=1` to keep the run's temp folder for a look. The Quick fixes switch is on in every engine of the specs, as it is in the app (the engine's fake router and fake fix serve it); `E2E_QUICK_FIXES=0` turns it off for the engines that do not say (the review, music, fonts-preview and phone review specs pass both ways). Music and Songs are on in the app but pinned off in every engine of the specs that does not say (they make nothing unasked, but the specs are not about them): the music, songs, versions and phone music specs set them on, and `e2e/music-default.spec.ts` starts an engine with neither setting and checks the app's own default (on, and no music made for a job that did not ask). With music on, Review's footer says "without music" and the player's address carries the music's `&m=`, which the other specs' exact texts do not expect.

Agents: read [CLAUDE.md](../CLAUDE.md) first.

## Running edits

An edit is one headless Claude Code run with the job folder as its working directory. The run loads the video-use skill and writes everything to `<job>/edit/`, ending as a live HyperFrames composition in `edit/preview/`, and the job waits in [Review](#review). Send notes runs a revise run, and Approve runs a short render run (Sonnet) that writes `edit/final.mp4`; then the engine exports it. With Review off (`STUDIO_REVIEW=0`) the edit run renders `edit/final.mp4` itself and the job is ready. Before it, every edit run (start, resume and retry) goes through [the Brief step](#the-brief-step), which writes `edit/brief.md` for the edit run to read first. This was verified on 2026-10-20 with Claude Code 2.1.299 on macOS 26.6 (E1 · CVP-57). Sample streams and notes for the runner are in [`fixtures/stream/`](../fixtures/stream/README.md).

### Prerequisites

Run `pnpm run doctor`. It checks everything below and prints the fix for anything missing (exit code 1 if something fails, `--json` for machine-readable output). A `!` line is a warning: the check passed but something is worth knowing, and the exit code stays 0. There are four: ffmpeg's missing filters, described under "Known gap" below; "video-use skill … older copy" and "edit-video skill … older copy", shown when the installed `SKILL.md` differs from the one in `skills/`; and "HyperFrames CLI", shown only with Review off (`STUDIO_REVIEW=0`) when `npx hyperframes --version` fails (the first run downloads it, so it needs the network). With Review on, the default, the same failure is a `✗` and the exit code is 1, because every edit checks its live preview with the CLI and every Approve renders with it. For either skill warning, run the `cp` command the doctor prints (for example `cp skills/video-use/SKILL.md ~/.claude/skills/video-use/`); the warning goes away once the two files match. Note that bare `pnpm doctor` runs pnpm's own built-in health check, not this script.

| Needs | Where it lives | How to set it up |
| --- | --- | --- |
| Claude CLI, logged in | see "Which `claude`" below | `"<claude>" auth login` |
| video-use skill, Studio Engine version | `~/.claude/skills/video-use/SKILL.md` | `mkdir -p ~/.claude/skills/video-use && cp skills/video-use/SKILL.md ~/.claude/skills/video-use/` |
| edit-video skill (HyperFrames captions, reframing) | `~/.claude/skills/edit-video/SKILL.md` | `mkdir -p ~/.claude/skills/edit-video && cp skills/edit-video/SKILL.md ~/.claude/skills/edit-video/` |
| video-use repo and its Python env | `~/Developer/video-use` (+ `.venv`) | `git clone --depth 1 https://github.com/browser-use/video-use ~/Developer/video-use && cd ~/Developer/video-use && uv sync` |
| HyperFrames skills and Chrome (graphics) | `~/.claude/skills/hyperframes*`, `~/.cache/hyperframes/chrome` | `npx --yes hyperframes skills`, `npx --yes hyperframes browser ensure` |
| ffmpeg and ffprobe | Homebrew: `/opt/homebrew/bin` | `brew install ffmpeg` (install Homebrew from https://brew.sh first); for the filters Homebrew's plain `ffmpeg` lacks, see "Known gap" below |
| uv | `~/.local/bin/uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Node 22 | nvm | `nvm install 22` |
| ElevenLabs key (transcription) | `~/Developer/video-use/.env`, mode 600 | see "ElevenLabs key" below |

**edit-video** is in [`skills/edit-video`](../skills/edit-video/README.md). video-use looks for it only at `~/.claude/skills/edit-video`, and takes the captions builder and Mode B from it.

Only the Studio Engine version of the skill works unattended. It is in [`skills/video-use`](../skills/video-use/README.md), whose README lists what it changes from the original, right-to-left captions included. Upstream's own `SKILL.md` (which its installer symlinks into `~/.claude/skills/video-use`) stops to ask for approval before cutting, so the doctor rejects it.

**Which `claude`.** There's nothing to install. The engine and the doctor take the first of these:
1. `claudeBin` in `~/.studio-engine/config.json`.
2. `claude` on PATH.
3. `~/.local/bin/claude`, where the standalone CLI installs.
4. The newest binary the desktop app bundles: `~/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude`.

The bundled path changes with every desktop app update, so it's looked up on each run rather than stored. It uses the desktop app's claude.ai login.

**ElevenLabs key.** The key lives only in `~/Developer/video-use/.env` (mode 600), where video-use's `helpers/transcribe.py` reads it. The engine doesn't pass it to the Claude process, so it never shows up in a run's environment or logs. It never goes in this repo, `config.json` or a job folder. Voice notes left while reviewing an edit are transcribed by the engine itself, with the same helper and the same minimal environment, so they need the key in this file too. To add or change it without the key ending up in your shell history:

```bash
cd ~/Developer/video-use && cp -n .env.example .env; chmod 600 .env && open -e .env
```

Then paste the key after `ELEVENLABS_API_KEY=` and save.

### The command

The prompt below is what the engine sends for a first run with Review on (the default), with `<Client>` and `<Job>` standing for the folder names. It is `apps/server/prompts/start.md` with the shared `apps/server/prompts/brief-use.md` (read the brief first) and `apps/server/prompts/unattended.md` notes filled in, and `apps/server/prompts/preview-finish.md` at the end. A resume or a retry sends its own opening lines (`resume.md`, `retry.md`) and the same shared parts. The files are read on every run, so editing one takes effect on the next edit without a rebuild. A test in `apps/server/src/pipeline/prompts.test.ts` fails when the block below and the prompt files drift apart.

```bash
cd "$HOME/Studio Inbox/<Client>/<Job>"
PATH="/opt/homebrew/bin:$HOME/.local/bin:<node 22 bin>:/usr/bin:/bin:/usr/sbin:/sbin" \
CLAUDE_CODE_SHELL=/bin/bash \
"$CLAUDE_BIN" -p "$PROMPT" \
  --output-format stream-json --verbose \
  --model opus --effort xhigh \
  --permission-mode dontAsk --permission-prompts none \
  --tools "Bash,Read,Write,Edit,Skill,Task" \
  --allowedTools "Bash Read Write Edit Skill Task" \
  --strict-mcp-config \
  --settings '{"disableAllHooks":true,"permissions":{"deny":["Read(//…/Studio Inbox/<Client>/<Other job>/**)", …]}}' \
  < /dev/null >> "$HOME/.studio-engine/logs/jobs/<jobId>.log" 2>&1
```

```text
Edit the footage in this folder with the video-use skill and finish it as a live preview in edit/preview/ (Studio Engine renders the final video after the owner approves).

Job: client "<Client>", job "<Job>". The footage folder is the current working directory; treat its files as read-only and write everything to ./edit/.

Footage quality. Whatever the brief says, choose and trim the footage by these three rules:
- Stutters and misspeaks: read the word-level transcript and cut false starts, repeated words, trailing-off sentences and flubbed lines. When a line is said more than once, keep the cleanest take, not the first.
- Photos: check each photo’s resolution and look at it for blur and noise. Use a low-quality photo only as a last resort, when no video or better photo covers that beat.
- Shaky footage: avoid it. Check stability by looking at frames spread through each clip. When a clip shakes at the start and then settles, start it where it settles; use only its most stable stretch. Take a shaky clip only when nothing steadier covers the beat, and say so in project.md.
Self-eval before the final render: no stutter or misspoken line, no shaky stretch and no weak photo left in the cut, unless it was the last resort.

If edit/brief.md exists, read it before anything else (edit/brief.json is the same brief as data). It was written from the client’s instructions and the owner’s note:
- Where it says something, follow it over the §0 defaults table and over your own taste. Where it says nothing, use the defaults.
- Cut only the files it lists as footage. Use music, logo and reference files for what they are. Never put an instructions file (voice note, chat, screenshot) in the video.
- Keep every must-include item and check each one in self-eval before the final render. Nothing on the must-avoid list may appear.
- Use on-screen text word for word.
- Start project.md’s Assumptions line with the brief’s assumptions.
- A Series section, when there is one, is the format this job repeats: follow it exactly. The Client style section at the end is the client’s house style. The brief above them wins where they disagree, and the series wins over the style.

This run is unattended (Studio Engine): nobody will answer questions, so never ask any. Follow the skill's §0 and decide on judgment. Notes for this machine:
- Setup is already done: ~/Developer/video-use is cloned with its .venv, and the skill is installed at ~/.claude/skills/video-use. Skip the ln -sfn line in §1 (writes under ~/.claude are blocked here); run the rest of §1's checks.
- This is the local Mac, not a cloud container: work directly in ./edit/ and skip §4 (no staging, device_commit_files or SendUserFile).
- The job path contains spaces and may be Hebrew, so always double-quote paths and variables in Bash (`cd "$SH"`, never `cd $SH`). Never cd or write above ./edit/, and if a cd fails, stop instead of running the next command where you are: a stray folder in the client folder or the inbox gets picked up as a new job.
- Read only this folder. The client's style, this job's series (if it has one) and the shared fonts are already copied into edit/style/, edit/series/ and edit/fonts/, so don't open the client's other folders (other jobs, _Style, _Series, _Fonts) or anything else in the inbox. The one exception is the client's _Shared folder (../_Shared/) when brief.md lists its files: copy the ones you use into edit/shared/ and use them from there.
- macOS tools: Bash is bash 3.2 and sed is BSD sed, so in-place edits need sed -i '' (or use the Edit tool). The edit-video skill is at ~/.claude/skills/edit-video.
- Color grading: load the color-grade-ai skill (named color-grade) before grading; if Skill cannot find it, read ~/.claude/skills/color-grade-ai/SKILL.md. After the cuts are settled and before baking a cut, preview or final, build captions from the original edit/edl.json and transcripts, then run: bash '<Studio Engine>/scripts/color-grade/run.sh' --edl "./edit/edl.json" --output-dir "./edit/color-grade" --prepare-only. Add `--look cinematic` only when the brief asks for a cinematic, film or warm look (default natural). Use the conservative default correction strength 0.35 unless the brief or a checked reference calls for something else. Use a fresh output directory for a changed EDL or grade; on resume/retry reuse the existing outputs only when their sources, ranges and grading settings still match.
- Read the wrapper's report.json and inspect its before/after frames across every used range and at cuts. It normalizes iPhone HLG/PQ to SDR before fitting and applying LUTs, preserves display orientation, and writes edl.graded.json plus graded per-range sources. Camera log requires the correct camera/gamut conversion LUT in the EDL's color_grade.sources settings; never guess one, force log to display, or treat a skipped/ambiguous source as a successful grade. With no compatible conversion, finish independent work and report Blocked: with the missing camera LUT. A valid in-job reference can set color_grade.reference; without one use the wrapper's measured reference choice, and inspect its warnings and fallback decisions.
- Bake from edit/color-grade/edl.graded.json, whose top-level grade is "none", instead of grading again in render.py. For a HyperFrames cut, copy that graded EDL, clear overlays and subtitles, and bake with --no-subtitles --no-loudnorm; build output-timeline captions from the original EDL, because the graded EDL uses new source IDs and zero-based range times. When cropping from source clips instead of baking, use the wrapper's full-resolution graded per-range sources with their new times, make H.264/AAC SDR MP4 copies inside edit/preview/, and apply no additional grade or HDR conversion. Record the report, reference, LUTs, fallbacks and visual check in project.md; the browser assets must carry the same approved grade into the final.
- The ElevenLabs key is in ~/Developer/video-use/.env, where the transcribe helper reads it. Never print it, copy it or pass it on a command line: everything this run prints is logged.
- If you hit a real blocker, finish what does not depend on it, then make the very last line of your final message start with "Blocked:" followed by one plain sentence naming what is missing, for example "Blocked: ffmpeg is not installed (brew install ffmpeg)." Studio Engine shows that sentence to the user as the job's error.

Finish the edit as a live preview, not a rendered video. The owner watches it in Studio Engine and leaves notes; the final MP4 is rendered only after they approve.
- Build the finish as a HyperFrames composition (§3.5 Mode B), even when every graphic only sits on top of the footage.
- The project is edit/preview/. Its root composition is edit/preview/index.html, with data-composition-id, data-width, data-height and data-duration on the root element.
- Start the root composition's main script with `window.__timelines = window.__timelines || {};` (the player loads its runtime after the page's own scripts).
- Everything the composition loads sits inside edit/preview/ and is referenced by a relative path: the baked cut (edit/preview/cut.mp4, §3.5 step 2), music, fonts, GSAP, images and sub-compositions. No absolute paths and no URLs: a browser loads this folder as it is.
- Every video it plays is H.264 in SDR, so a browser can play it. When you crop hard and place clips from the sources (the exception in §3.5 step 2), make H.264 SDR intermediates of those clips inside edit/preview/ first.
- Do not run hyperframes render and do not write edit/final.mp4.
- Self-eval on the composition instead of a render: npx hyperframes lint with 0 errors, snapshots at every cut and at each graphic's payoff (npx hyperframes snapshot), the caption gate (§3.4 step 5) on those snapshots, and the loudness of cut.mp4 with the music under it.
- A graphic that fades or slides out must finish doing so inside its clip: a `class="clip"` element is hidden after data-start + data-duration, so that sum has to be at or after the end of the exit tween. Check a snapshot at the exit.
- Look at the snapshots for what each caption and graphic sits on: over every shot it appears on, it must not cover text, a face or a key object in the picture. If it would, use the nearest clear position (or a stronger caption background) and say so in project.md.
- Record the composition in project.md: where it is, its graphics and their timing.
- Mark the text so Studio Engine can show a font note live: the captions' host (the one with data-track-kind="captions") also carries data-timeline-role="captions"; every title, lower third, callout and end card (the host of its sub-composition, or the element itself when it sits in index.html) carries data-timeline-role="title". If the composition already exists, add the attributes where they are missing. They change nothing in the picture.
- The job is done when edit/preview/index.html passes lint and you have checked the snapshots. Do not leave anything running in the background when you finish.
```

`<Studio Engine>` in the grading command stands for this repository's absolute path, computed by the server; the [grading workflow](color-grade.md) covers installation, manifests and verification.

With the switch off (`STUDIO_REVIEW=0`), the first line says “deliver edit/final.mp4” instead, and the finish is `final-finish.md`'s one line. A round of notes sends `revise.md`, and Approve sends `render.md`.

Every flag was checked against `claude --help` (2.1.299) and in real headless runs:

| Flag | Why |
| --- | --- |
| `-p` | Non-interactive, and it skips the workspace trust dialog. |
| `--output-format stream-json --verbose` | One JSON event per line. `--verbose` is required: without it the CLI exits 1. |
| `--model opus` | The `model` value from `config.json`; `opus` is the alias for the latest Opus. |
| `--effort xhigh` | The effort of the job: Extra high unless you chose another level (Effort in the job's right-click menu, or the Effort button in the review dialog's footer before Send: `medium`, `high` or `xhigh`; Default is Extra high). Without the flag Claude Code uses its own level for the model, Medium for Opus 5.5. It applies to edit, resume, retry and revise runs, so the fixes round after Send notes uses the level set in Review; a render run never gets it. |
| `--permission-mode dontAsk` | Any tool call not pre-approved is denied, not asked about, so a run can never wait on a prompt. |
| `--permission-prompts none` | With `-p`, anything that would still prompt is denied automatically. |
| `--tools "Bash,Read,Write,Edit,Skill,Task"` | The only built-in tools the run gets. video-use needs Bash (ffmpeg, its Python helpers, `npx hyperframes`), the file tools, Skill (to load video-use and the HyperFrames skills) and Task (parallel sub-agents for graphics). Web, cron, notification and worktree tools are left out. |
| `--allowedTools "Bash Read Write Edit Skill Task"` | Pre-approves exactly those tools. Bash is allowed whole because the skill runs too many different commands for a pattern list. Reads and Bash reach `~/Developer/video-use` without `--add-dir`. Writes under `~/.claude` are still refused, because it's protected configuration, which is why the prompt says to skip §1's `ln -sfn`. |
| `--strict-mcp-config` | Loads no MCP servers: the run needs none, and it avoids the user's connectors and their auth. |
| `--settings '{"disableAllHooks":true,"permissions":{"deny":[…]}}'` | User and plugin hooks don't run. A plugin's SessionStart hook otherwise injects unrelated instructions. Personal skills still load. The `deny` list (left out when empty) is one `Read(//<path>/**)` rule for every folder of the inbox that is not on the way to the job: the client's other jobs, `_Style` and `_Series`, the other clients, `_Fonts` and `_Exports`. A run reads only its own job folder; its style, series and fonts are copied into `edit/` first (CVP-258). The rules stop the Read tool and the shell commands the CLI knows read a path (`cat`, `ls`, `find`, `grep`, `head`, `sed`, a `cd` first), not a program that opens the file itself, so the prompt says it too. A relative `Read(../**)` rule denies nothing in 2.1.299. |
| `< /dev/null` | Without it, `-p` waits 3 s for stdin and prints a warning. Spawn with stdin ignored. |

Deliberately not used:
- `--setting-sources` without `user`: it also drops the personal skills, so video-use disappears.
- `--bare`: not needed, and it changes what the run loads (it was ruled out while the login was the only billing; the API key now works without it).

**Billing.** Every `claude` process the server starts (edit, revise, render, brief, style, series, transcribe-notes, graphics, quick fixes, note topics) runs on the claude.ai plan login by default, never on an Anthropic API key (the owner, 25 Oct 2026). The switch is **Claude plan only** (Settings > Claude; `"claudePlanOnly"` in config.json; `STUDIO_CLAUDE_PLAN_ONLY=0/1` beats the file), on by default, and a change counts after the engine restarts. While it is on, an `ANTHROPIC_API_KEY` in the repo's `.env` or the server's environment is ignored and dropped from the server's own environment, and the server logs one line saying so at start. Turned off, the key is kept and given to those `claude` processes (and only those: `claudeEnv` adds it, `childEnv` never does), which then bill the API; with no key they still use the login. The Analytics plan probe always uses the plan. `ELEVENLABS_API_KEY` is never passed to a `claude` run either, and neither is any key to the music script or the transcribe helper.
- `--dangerously-skip-permissions`: `dontAsk` plus the allow list is enough.

Also available but not needed for a first run: `--session-id <uuid>` (choose the session id up front), `--max-budget-usd`, and `--append-system-prompt`.

Environment for the Claude process:
- `HOME` must be set.
- `PATH` must include `/opt/homebrew/bin` (ffmpeg, ffprobe), `~/.local/bin` (uv) and the Node 22 bin folder (`npx` for HyperFrames). A launchd job's default PATH has none of them. The doctor looks in those folders too and marks a tool "not on this shell's PATH" when this shell can't see it.
- `CLAUDE_CODE_SHELL=/bin/bash`. Without it the Bash tool uses the login shell, zsh, where a glob that matches nothing aborts the whole command. video-use's own `ls -d /mnt/skills/*/edit-video ~/.claude/skills/edit-video` lookup fails that way. The skill's snippets are written for bash.
- Don't set `ELEVENLABS_API_KEY`.

When is a run finished?
- **Done:** the process exits 0 and the run's result is there. For an edit run and a revise run that is `edit/preview/index.html` with `data-composition-id`, `data-width`, `data-height` and `data-duration` (see [Review](#review)). Render runs, and every edit run with Review off, finish with exit 0 and `edit/final.mp4`.
- **Blocked:** a run stopped by a blocker (no ffmpeg, no key) also exits 0, with a `result` event whose `subtype` is `success`. Its text names what's missing; use it as the error. The prompt asks the run to end with a last line that starts with `Blocked:`; that sentence becomes the job's error, or else the last paragraph of the final message.
- **Not done yet:** a run can write more than one `result` event when sub-agents run in the background, so read until the process exits. `edit/final.mp4` can also appear minutes before the end, and be deleted and rendered again after the self-check.

The sample run (a 15 s clip, from before Review, so the edit run rendered the video itself) took 7 min 50 s and 41 turns. It produced an 11.3 s `final.mp4` with the false start cut, three graphics and word-highlight captions. Its stream and the order its files appeared are in `fixtures/stream/`.

Known gap: Homebrew's plain `ffmpeg` (9.0.2) is built without zimg (the `zscale` filter), libass (`subtitles`, `ass`) and freetype (`drawtext`). The doctor reads `ffmpeg -hide_banner -filters` and shows a `!` warning, not a failure, for whichever of the three is missing. Edits still finish without them; this is what changes:

- **No `zscale`:** video-use's `render.py` can't tone-map iPhone HDR (HLG) clips to normal colours, so the model improvises with the VideoToolbox scaler (`scale_vt`). Before the run-prompt fix in the V4 acceptance run (commit `889b1c8`) that turned a portrait iPhone clip sideways.
- **No `subtitles`/`ass`:** `render.py`'s own subtitle burn-in can't run. The skill builds the captions as a HyperFrames layer instead, using edit-video's builder (in the V4 jobs, a HyperFrames or PIL overlay). That's also the path it uses for Hebrew, and the sample run shipped that way.
- **No `drawtext`:** ffmpeg can't draw text itself, so titles and labels are made as separate graphics.

To close the gap, use an ffmpeg that has those libraries. The doctor prints this fix:

```bash
brew install ffmpeg-full && brew unlink ffmpeg && brew link --force ffmpeg-full
```

`ffmpeg-full` is Homebrew's own build with zimg, libass, freetype and many more libraries. It is keg-only (Homebrew doesn't link it into `/opt/homebrew/bin` by itself), hence the unlink and `link --force`. It's a big install (about 90 packages, all pre-built). To go back: `brew unlink ffmpeg-full && brew link ffmpeg`.

A lighter alternative is the `homebrew-ffmpeg/ffmpeg` tap, which replaces the plain `ffmpeg` and compiles it on your Mac. There libass, freetype and fontconfig are always built in, so `--with-zimg` is the only option needed (the tap has no `--with-libass` or `--with-drawtext` option):

```bash
brew uninstall ffmpeg
brew trust homebrew-ffmpeg/ffmpeg
brew tap homebrew-ffmpeg/ffmpeg
brew install homebrew-ffmpeg/ffmpeg/ffmpeg --with-zimg
```

Run `pnpm run doctor` again afterwards: the `ffmpeg filters` line turns into a plain ✓.

### The Brief step

Before every edit run (start, resume and retry) a short headless Claude run (Sonnet) reads what the client sent and the owner's note, and writes the brief the edit follows. It is step 1, Brief, on the Jobs page. The design is on the Plane page "Phase 1 — Brief: architecture & dev plan", §2.

**What it reads.** Every file in the job folder that the scanner counts: everything except `edit/`, dotfiles and partial downloads (a `.pages` document counts as one file). Text, PDFs and Word files, WhatsApp chat exports, images, and voice notes, which it transcribes with video-use's helper. It doesn't transcribe the footage (the edit run does). And the owner's note for the job (right-click a job, "Add note…"), which beats everything the client sent.

**What it writes**, all inside `<job>/edit/`:

| File | What it is |
| --- | --- |
| `brief.json` | The brief as data. The run writes the draft (`briefDraftSchema` in `packages/shared`); the engine checks it, adds `"schema": 1` and the fingerprint, and writes it again. |
| `brief.md` | The same brief as text, rendered by the engine. The edit run reads this first and follows it over video-use's defaults. It ends with a "Client style" section when the job has a `style/` copy, then a "Fonts" section when it has a `fonts/` copy. |
| `style/` | The client's style, frozen into the job (Phase 2): a copy of `<Client>/_Style` (style.md, the files it was made from, `kit/`), without history. The engine makes it once, before the Brief run, when the job has none and the client has a `style.md`; Retry and Resume keep it, so a job keeps the style it started with. The Brief run doesn't read it. |
| `fonts/` | The shared fonts (see [Shared fonts](#shared-fonts)): a copy of the font files in `<inbox>/_Fonts`, made again before every edit run, so a font added before a Retry is there. |
| `brief/transcripts/<name>.json` | Voice-note transcripts. They are kept, and the helper reuses them, so a new brief doesn't pay for them again. They never go in `edit/transcripts/`, which is the edit run's. |

**When it runs.** The engine takes a fingerprint first: sha1 over the sorted lines `relPath<TAB>size<TAB>mtimeMs` of the files it reads, then the note.
- `brief.json` is complete and has that fingerprint: it is reused, nothing runs, and the job goes straight to the edit. So Retry and Resume normally skip it.
- Every file is a video and there is no note: the engine writes the brief itself ("No instructions in the folder.", each video as footage, everything else empty) without a Claude run.
- Anything else, including a changed file or a changed note: the Brief run runs. The job shows Brief with "reading N files" (N is the files that aren't video), then "voice notes n/M" as transcripts appear. Only then is step 1 timed for the ETA.

**When it fails**, the job fails at Brief, and Retry runs it again:
- "Brief stopped: brief.json didn’t match the schema (…)." when the file is missing or wrong. The bracket names the first problem, such as `goal: missing`.
- "Brief stopped: the brief took longer than 10 minutes." after its 10-minute limit.
- "Brief stopped: …" with the run's own reason when its last line starts with "Blocked:", or with the same explanations as an edit run (not logged in, usage limit).

Cancel stops it like any step (SIGTERM to the process group, SIGKILL after 10 s), and the job is cancelled at Brief. A job that failed or was cancelled at Brief carries on from whatever the edit already left in `edit/`. With a transcript, `takes_packed.md`, `project.md`, `edl.json`, graphics or a render there (a Retry's fresh brief failed after the edit had got further), the edit resumes or retries and the progress follows those files to the real step; with none of them it is a first edit and runs with the first-run prompt. A job that failed at a later step resumes or retries from that step as before. A Retry where only the export failed exports again and runs neither the brief nor the edit.

**The command** is the edit run's flag style with its own model and tools. In the job folder:

```bash
"$CLAUDE_BIN" -p "$BRIEF_PROMPT" \
  --output-format stream-json --verbose \
  --model sonnet \
  --permission-mode dontAsk --permission-prompts none \
  --tools "Read,Glob,Grep,Write,Bash" \
  --allowedTools "Read,Glob,Grep,Edit(./edit/**),Bash(ls),Bash(ls *),Bash(ffprobe *),Bash(textutil -convert txt -stdout *),Bash(~/Developer/video-use/.venv/bin/python ~/Developer/video-use/helpers/transcribe.py *),Bash($HOME/Developer/video-use/.venv/bin/python $HOME/Developer/video-use/helpers/transcribe.py *)" \
  --strict-mcp-config \
  --settings '{"disableAllHooks":true}' \
  < /dev/null
```

The environment is the edit run's. The allow list was checked against `claude --help` (2.1.299) in headless runs. Writes are allowed only under `./edit/`: an `Edit(…)` rule covers the Write tool too. Bash is allowed only for `ls`, `ffprobe`, `textutil -convert txt -stdout` and the transcribe helper, which is listed with `~` and with the home folder written out, because the run may type either. Claude Code also lets through commands it knows only read, such as `cat` and `echo`. Everything that changes something is refused: `rm`, `cp`, `mkdir`, `touch`, `ffmpeg`, `curl`, a `>` redirect, `textutil -convert html`, and python with any other script. In the job log the run sits between a `brief_start` and a `brief_end` marker, and every marker of it carries `"run":"brief"`. A retry's look at the last edit run never mistakes the brief's end for the edit's.

**Refused commands.** The prompt names the Bash forms that work (one per call, no pipes, `;`, `&&`, redirects, `find` or `xargs`) and says a denial means the form was wrong, not that Bash is off: in the acceptance run (CVP-133) one refused `find | xargs` made the run give up on Bash and skip both voice notes. The engine also reads every permission denial from the stream (the `permission_denied` event, the denied tool result and the result's `permission_denials`), logs each as a warning ("a tool call was denied by the permission rules") and lists them in the `brief_end` marker as `permissionDenials` (`[]` when there were none). The run still counts as succeeded. A brief that calls a voice note `instructions` without a transcript in `edit/brief/transcripts/` is also logged as a warning.

**The prompt files**, read on every run like the edit prompts:
- `apps/server/prompts/brief.md`: the Brief run's prompt. `{{note}}` is the note, or "(none)". `{{files}}` is the file list the engine makes (one line per file: path, kind, size, modified time in UTC, and the length of video and audio files from ffprobe), so the run's step 1 needs no Bash. `{{> brief-schema}}` is the JSON Schema of `briefDraftSchema`, made by the engine, so the prompt and the check can't drift apart.
- `apps/server/prompts/brief-use.md`: the lines that tell the edit run to read `edit/brief.md` first. `start.md`, `resume.md` and `retry.md` include it right after the job line.
- `apps/server/prompts/revise.md` and `render.md`: the prompts of the runs after Send notes and after Approve (see [Review](#review)). They have one file each for every mode; `{{round}}` is the round being applied and `{{again}}` is empty on a first try, else says what became of the last one.

### Review

Review is the normal flow. An edit run doesn't render a video: it builds the edit as a live HyperFrames composition in `edit/preview/`, and the job waits in Review. The owner plays it in the app (the job's Review button, or "Review…" in its right-click menu), leaves notes pinned to moments of the video, typed or spoken, and then sends them or approves. The design is on the Plane page "Phase 3 — Review: architecture & dev plan".

The flow: edit → Review → notes → Send notes → revise run → Review … → Approve → render run → Ready → export.
- **Edit.** The edit run (after the Brief step) ends with a composition that passes the check below. The job goes to Review at Check (7), with the preview's length and size, and nothing is exported.
- **Notes.** In the review dialog the owner adds a typed note, or records a voice note, at the playhead. A note can be marked Add to style. The engine transcribes voice notes itself, with the same helper and key as the Brief step (see "ElevenLabs key" above).
- **Send notes.** The notes of the round go to the editor together: the engine writes `edit/review/round-N.md` and the job queues again as a revise run, which starts at Plan (4) and ends in Review again with the composition it rewrote.
- **Approve.** The job queues a render run at Render (8), which renders the approved composition to `edit/final.mp4`. The engine then exports it to `_Exports/<Client>/<Job>.mp4` and the job is Ready.

**The files**, all inside `<job>/edit/` (the inbox watcher ignores that folder), apart from the last:

| File | What it is |
| --- | --- |
| `preview/` | The live composition the review dialog plays. Its root is `preview/index.html`. An edit run writes it, a revise run rewrites it. |
| `review/round-N.md` | The notes of round N, by time, which the revise run reads. Send notes writes it. |
| `review/voice/<id>.webm` or `.m4a` | A voice note's audio (`.m4a` when the browser records that). |
| `review/voice/transcripts/<id>.json` | Its transcript, made by the engine. |
| `project.md` | A revise run adds a `## Round N` section for the round it applied. |
| `final.mp4`, `final.srt` | Written by the render run after Approve. `final.srt` only when the captions are burned in. |
| `<Client>/_Style/Review notes – <job> – round N.md` | Not in `edit/`: the notes marked Add to style, written by Send notes and read into the client's style (see [Client styles](#client-styles)). |

**The prompts** are in `apps/server/prompts/` and are read on every run: `start.md`, `resume.md` and `retry.md` for an edit run, each ending with `preview-finish.md`; then `revise.md` after Send notes, and `render.md` after Approve, which ends with `final-finish.md`. `preview-finish.md` includes `composition-rules.md` (the exit rule of a `class="clip"` element and the look at what a caption sits on), which the quick fix run's prompt (`quick-fix.md`, not sent yet while the quick fixes switch is off) shares. It also includes the self-eval line as the partial `self-eval-full.md` (the whole check, for every run); a revise run that Send queued at the Revise tier gets `self-eval-slim.md` instead (only around what the round changed).

**How each run ends:**
- **Edit run.** The prompt ends with `preview-finish.md` (build the finish as a HyperFrames composition, the project is `edit/preview/`, lint it and look at snapshots instead of rendering). The done line about `edit/final.mp4` (`apps/server/prompts/final-finish.md`) is left out. Success is exit 0 plus an `edit/preview/index.html` whose first element with `data-composition-id` also has a `data-width`, `data-height` (whole numbers above 0) and `data-duration` (a number above 0) that parse. The engine reads the job's preview (length and size) from them. `edit/final.mp4` doesn't count. Otherwise the job fails at Preview (6) with "Finished without a preview: …", the run's `Blocked:` line or what is wrong with the composition.
- The job log's `end` marker records `succeeded` with the `preview` the run left. The worker applies PREVIEW_READY with it: the job goes to Review at Check (7), and nothing is exported. Progress reads the composition: Preview is `edit/preview/index.html` being written or a `hyperframes snapshot` or `preview` command, Check is `hyperframes lint` or `check`, `verify/` frames or a critic sub-agent. There is no Render.
- **The preview route** (`/api/jobs/<id>/preview/…`) serves that `index.html` with `<script>window.__timelines = window.__timelines || {};</script>` first in its `<head>`, because the player loads the HyperFrames runtime after the page's own scripts. The file on disk is never changed. Every other file is sent as it is.
- **Revise run (after Send notes).** The job queues again with `runKind` revise and `round` + 1, and the worker runs it without the Brief step. It starts at Plan (4) and ends in Review again, like an edit run, with the composition it rewrote in `edit/preview/`. Its prompt is `apps/server/prompts/revise.md`: it applies the notes of `edit/review/round-N.md` to the edit that is there, adds a "## Round N" section to `project.md`, and finishes with `preview-finish.md`. It uses the configured model (`STUDIO_MODEL`) at the edit's effort, like an edit run; with the Quick fixes switch on it takes the level chosen in Review (`jobs.review_effort`) or the tier its Send saved with Auto (`jobs.revise_tier`, see `TIER_RUNS` in `packages/shared/src/domain/quick-fixes.ts`) instead, and a retry or a resume of the round chooses the same. Its progress counts only what the run writes (the earlier round's composition and `verify/` frames are ignored), and its step timings are stored under `revise`.
- **Render run (after Approve).** The job queues with `runKind` render and runs at Render (8), again without the Brief step, with `--model sonnet`. Its prompt is `apps/server/prompts/render.md`: it renders the approved composition with `npx hyperframes render -q delivery --strict --no-best-effort -o ../final.mp4`, checks the render, and ends with `final-finish.md`. Success is exit 0 and a non-empty `edit/final.mp4`; the worker then exports it to `_Exports/<Client>/<Job>.mp4` and the job is Ready. A Retry after a render whose export failed exports again without a new run, as for an edit run with Review off; it does not for an edit run with Review on, or for a revise run, since they deliver no `final.mp4`.
- A resumed or retried revise or render run says so in the `{{again}}` sentence of its prompt ("An earlier run of this round was stopped at step N of 8…", "The previous attempt at this round failed at step N of 8 (…) with: …"; "render" in place of "run of this round", "the render" in place of "this round").
- The ETA of a revise or render run comes from the earlier runs of the same kind (`step_runs.run_kind`), and from the edit run's figure for the step until it has enough of its own. A run that ends in a preview is estimated up to Check. A whole run's time is the sum of its timed steps, so hours spent in Review do not count.

**The switch (the way back).** `STUDIO_REVIEW=0` (the environment takes `1`, `0`, `true` or `false` in any case; anything else stops the engine at boot) or `"review": false` in `~/.studio-engine/config.json` (a JSON boolean; the environment wins over the file) turns Review off. An edit run then renders `edit/final.mp4` and the job goes straight to Ready, as before Phase 3. It is on by default.
- **Dev server:** `STUDIO_REVIEW=0 pnpm dev`.
- **Background agent:** it doesn't read your shell. Put `{ "review": false }` in `~/.studio-engine/config.json` and run `pnpm agent:restart`. To go back to Review, remove that line (or set it to `true`) and restart.
- **Off, only the edit run changes.** A job already in Review stays there, and can still be sent notes or approved: a revise run always ends in Review, and a render run always ends in `final.mp4`. Jobs that are Ready stay Ready.
- **Off, the edit prompts** are byte for byte what they were before Phase 3, and a test compares them with the files in `apps/server/src/pipeline/testdata/prompts/` (never update those files).
- **A job that is editing when the engine restarts** carries on with the switch as it is after the restart. The engine doesn't store which setting a run started under: the worker reads it when the run starts. So a job that was editing when Review came on ends in Review (and is approved like any other job), and one that was editing when it went off ends Ready.

### Formats (a second video, only when asked)

A job makes one video in its canvas, as always, unless the client's instructions or the owner's note explicitly ask for more than one format ("deliver 9:16 and 1:1"). Then the Brief run fills `formats` in `edit/brief.json` (the main format first), the Brief step keeps the sizes on the job (`jobs.formats`, migration 0023) and the job reports them as `Job.formats`: `[{ id: "9x16", label: "9:16", width, height, previewPath }, { id: "1x1", … }]`. A job with no `formats` key (none asked for, or only one) is exactly what it was, in the prompts, the folder, the routes and the export.

- **Edit and revise runs** get `apps/server/prompts/formats-use.md` inside the preview finish: build one more composition for each extra format in `edit/preview-<id>/index.html` (`preview-1x1`, `preview-4x5`), the same cut, audio and length, with the captions, cards, badges and end card laid out again for that shape, a centre crop of the cut where the action fits, and a line in `project.md` for any crop that cuts something off. There is no reframe model: crops are ffmpeg and cost nothing. In a revise round every line of `edit/review/round-N.md` says which preview its note was written on, `- 0:32.0 (on 1:1) — …`, and the prompt tells the run that a note about the story (a clip, the voice, the words, the music, the timing) changes every format while one about size, position or crop changes only the format it names. The run ends in Review only when every composition is valid (`readPreview(jobDir, job.formats)`: its own `data-composition-id`, width, height and duration, the format's shape, and the main composition's length, give or take half a second).
- **Preview route:** `GET /api/jobs/:id/preview/<id>/…` serves `edit/preview-<id>/` (for example `/preview/1x1/index.html`); every other path is the main preview, as before.
- **Music** in Review: Make another and Pick change `edit/preview/music.mp3`, and the music service then copies it into `edit/preview-<id>/music.mp3` of every other format whose folder exists (`apps/server/src/music/format-music.ts`), so the second format previews the picked track and not the old one. A job with one format is untouched.
- **Render run** gets `formats-render.md`: it renders each format from its own folder to `edit/final.mp4` and `edit/final-<id>.mp4`, and needs all of them. Approve never reuses Review's Export MP4 for such a job (its render run makes every format).
- **Export** (`finalize.ts`) copies each video to the exports folder, `<Client>/<Job>.mp4` and `<Client>/<Job> (1x1).mp4`, by the same rules (a hidden partial, an earlier export moves to the first free `(n)`: `<Job> (1x1) (1).mp4`; if one file cannot be placed the others are taken back out). `Job.output` is still the main file; `output.outputs` lists every file, `[{ format, fileName, bytes }]`, the main one first. It is still one job in Deliveries, Money and Analytics. `GET /api/jobs/:id/download?format=1x1` downloads that format's file (without `format`, the main one); deleting the job deletes them all.
- **Review** (GN8): a job with two formats shows a switch "9:16 | 1:1" in Review's header (on the phone, a row above the player). It picks the composition the player loads (`/preview/<id>/index.html`, the dialog keeps the size of the largest format so the switch never moves) and the format a new note is written on: `review_notes.format` (migration 0024) holds the extra format's id, `null` for the main format, for a job with one format and for every note from before. `POST /api/jobs/:id/notes` takes `format` (`format` is a form field on the voice route); an id the job does not have is 400. The notes list prints a note's format after its time ("0:32 1:1") when it is not the main one, and the timeline marks the notes written on the format on show plus those that change every format (a note with a size or position word, like "logo bigger", belongs to its own format only). With two formats Approve says it renders both.
- **Export MP4 in Review** (C65): on a job with two formats the header's button exports the format on show, and its label says which: "Export MP4 · 1:1", then "Save MP4 · 1:1" (a job with one format says "Export MP4" and "Save MP4", as before). Each format has an export of its own, rendered from its own composition at delivery quality (`edit/preview/` to `edit/review-export.mp4`, `edit/preview-<id>/` to `edit/review-export-<id>.mp4`), with its own status, staleness (its composition and its music) and failure, so switching the format shows that format's state. `POST|GET /api/jobs/:id/review-export` and `GET …/review-export.mp4` take `?format=<id>`: no `format`, or the main format's own id, is the main export as before; an extra format's id is that format's; any other size (and any size at all on a job with one format) is 404, never the other size's file. The file is saved as `<Job>.mp4` for the main format and `<Job> (1x1).mp4` for an extra one. The phone has no Export MP4 (its share icon sends the main format's small preview video and is not shown while another format is on).
- **Note hints on a generated job** (GN8): under each note a line says what Send will probably do and what it costs: "New take of clip B on Send · about $0.51 · both formats" (a clip word, with a clip on screen at that moment), "Remakes voice line 2 on Send · ElevenLabs, nothing spent on Higgsfield" (a voice word), or "Edit change · both formats" / "· 1:1 only". The footer adds up one new take per clip against what is left of the budget ("New takes use about $0.51 of the $0.67 left of the $3."). It is a hint, from the word lists and `generateNoteHint` in `packages/shared/src/domain/generate-note-hint.ts`; the revise run does the real sorting. The clips, their windows and what each kept take cost come from `GET /api/jobs/:id/generate/review-plan` (read from `edit/generate/shots.json` and `voice-words.json`; the files stay agent-only), the budget and what is spent from `Job.generate`. `pnpm seed:canvas --generate` seeds a generated job with two formats and the board's notes, to look at all of it with no key.
- **A generated job on the Jobs row, the sheet and the phone** (GN9): while the stage works the row says what it makes ("Generate · voice 3/7", "Generate · clips 4/6 · $1.65"); a stop reads "Higgsfield balance is empty", "Higgsfield key not accepted" or "Needs about $4.10, the budget is $3" with "Retry from Generate" as its next step; a review row says "Ready to review · 0:35 · 1 clip below the bar" (or "· 9:16 and 1:1"), an approved one "2 files · 9:16 and 1:1 · 0:35" (`jobListDetail`, `packages/shared/src/domain/generate-job.ts`). The job sheet adds a Generate row between Brief and Transcribe in Steps, the Generated part (voice, looks, keyframes, clips and what was spent, from `Job.generate`, the stage's History from `GET /api/jobs/:id/generate/history` and, for the clip below the bar, the review plan), the error box with its title, code line and help, the stage's History lines, a Download for each format, and the format of each sent note ("0:32 1:1"). The phone has the same with nine step segments, and a job that stops in Generate pushes "<Job> stopped" with what to do (`generatePing`). Left for later: a "Higgsfield (API)" line on the Money page (it needs the month's spend per job on the server).
- **Fake runner:** a note that names two of 9:16, 16:9, 1:1 and 4:5 makes the fake Brief ask for both, and the fake runner writes a sample composition at each size and a video for each.

### Where logs go

- The engine appends every stream line and stderr to `~/.studio-engine/logs/jobs/<jobId>.log` (architecture page, §3).
- Claude Code also keeps each session's transcript under `~/.claude/projects/<folder-slug>/<session_id>.jsonl`. `session_id` is on every stream event. To open a run interactively afterwards: `cd "<job folder>" && "$CLAUDE_BIN" --resume <session_id>`.
- The video-use workspace itself is `<job>/edit/`: `project.md` (decisions and assumptions), `transcripts/`, `takes_packed.md`, `edl.json`, `verify/`, `preview/` (the live composition), `review/` (the notes and voice notes) and, after Approve, `final.mp4`. With Review off, `preview.mp4` and `final.mp4` come from the edit run.

## Client styles

Every client has one style, `style.md`, that its next edits follow. The design is on the Plane page "Phase 2 — Clients & styles: architecture & dev plan", §4 and §5.

**The folder.** `<inbox>/<Client>/_Style/` holds `style.md`, the files it was made from, and `kit/` (graphics a style learned from a job keeps). The engine makes it in every client folder it sees; it is never a job. `style.md` is plain Markdown: `# Style: <client>`, one line saying where the style came from, then the sections it has of `## Look`, `## Editing`, `## Do`, `## Don’t`, `## Kit` and `## Reference`. Editing it in a text editor works; the engine never overwrites it without keeping a copy (see History).

**Clients.** A client is any folder directly in the inbox that the inbox rules don't skip (dot-folders, `_Exports` and the exports folder), with jobs or without. The engine lists them at start and keeps the list current from the inbox watcher, so a client folder made or deleted in Finder comes and goes at once. A client with no job has a Style page, takes style files, reveals in Finder and undoes like any other.
- `GET /api/clients` answers one row per client folder, sorted by name: `{ clientId, client, jobs, lastJobAt, style: { state, updatedAt } }`. `jobs` counts the jobs the engine knows for it and `lastJobAt` is the newest job's `addedAt` (`null` without jobs).
- `POST /api/clients` with `{ name }` makes `<inbox>/<name>/` and its `_Style/` and answers the new row (201); it never makes a job. The name is trimmed and written in NFC; it must not be empty, longer than 80 characters, contain `/` or `:`, or start with `.` or `_` (400 with a plain message), and the inbox must not have it already, in NFC or NFD (409).
- The event stream carries `client.added` and `client.removed` (`{ clientId, client }`) for folders made in the app and in Finder alike.

**Three ways to add files:**
- **Upload** (the client's Style page; the API is `POST /api/clients/:clientId/style/files`, multipart `files[]` and `mode`). The files are copied into `_Style`; a name that is taken gets " (1)" (`logo (1).png`), and `style.md`, `style.md.new` and `kit` are never taken by an upload. Up to 2 GB together (413 above that). While the client's style is being analysed, a new upload is refused (409).
- **Finder**: drop files into `_Style`, in folders or not. Once the folder has been quiet for the settle time (`settleMs`, 60 s), the engine reads the new and changed files in one pass, in add mode. It ignores `style.md`, `style.md.new`, `kit/`, dotfiles and partial downloads, and the files an upload put there. Files dropped while the engine is off are not noticed; touch them, or drop them again, once it runs.
- **Review notes** (Add to style): when the owner sends their notes from a job in Review, the notes they marked "Add to style" are written as one file, `Review notes – <job> – round N.md`, into the client's `_Style` (a taken name gets " (1)"), and one Read pass in add mode turns them into rules in `style.md`. It goes through the same code as an upload, so the Finder watcher doesn't read it a second time, but it does not answer 409 while the style is being analysed: its pass waits for the one that is running. Sending never fails because of the style; a failed pass shows on the client's Style page like any other.

**Add or replace.**
- **Add** merges the new files into the current style: everything they don't contradict stays, and where they disagree the new files win. The line under the title gets "Plus <files> (<date>)." and `## Kit` stays as it is.
- **Replace** writes a new style from the new files only. The line under the title is "From your files: <files>." and `## Kit` stays as it is.
- Without a `style.md` either one creates the first style, from the new files.

**The run (Read pass).** A short headless Claude run (Sonnet) in the `_Style` folder reads the new files (text as it is, PDFs with the Read tool, Word files through `textutil`, images by looking at them, fonts by their file name, a reference video through `ffprobe` and three frames) and writes `style.md.new`. The engine then checks that the file exists, isn't empty and starts with "# Style:", keeps the old `style.md` in history, renames the new one to `style.md` and adds 1 to the version. The prompt files are `apps/server/prompts/style-read.md` and the shape it includes, `style-shape.md`, read on every run like the other prompts. The prompt names the Bash forms the allow list takes (`ls -la`, `ffprobe` for the duration, `ffmpeg` for one frame per call into `/tmp/ref-<n>.jpg`, `textutil`), one per call with no pipes, `;`, `&&`, loops, `$( )` or redirects, and says a denial means the form was wrong, not that Bash is off (CVP-193: the first real reference-clip run tried one compound loop, was denied, and never looked at the clip). `style_end` in the client's log lists every denial as `permissionDenials`.

```bash
"$CLAUDE_BIN" -p "$STYLE_READ_PROMPT" \
  --output-format stream-json --verbose \
  --model sonnet \
  --permission-mode dontAsk --permission-prompts none \
  --tools "Read,Glob,Grep,Write,Bash" \
  --allowedTools "Read,Glob,Grep,Edit(./style.md.new),Bash(ls),Bash(ls *),Bash(ffprobe *),Bash(ffmpeg * -frames:v 1 /tmp/*),Bash(textutil -convert txt -stdout *)" \
  --strict-mcp-config \
  --settings '{"disableAllHooks":true}' \
  < /dev/null
```

**Learned from a finished job (Learn pass).** A style is also learned from finished videos:
- **Every finished job.** When a job reaches ready (after the export, whichever run got it there), the engine adds its look to its client's style. With the Review switch on, a job reaches ready only after Approve and its render run, so a preview in Review never counts: only a video the owner approved does. The first one creates the style (mode `create`). Every later one merges into it (mode `merge`): everything the new video doesn't contradict stays, where they disagree the new video wins, and the line under the title gets "Plus <job> (<date>).". The edit queue waits for that Learn pass only when the next job it would start is an edit of the same client, so that edit's Brief step copies the updated style; an edit of another client starts at once, beside it. The job stays ready whatever the Learn pass does; a failed one only fails the client's style. Learn passes of two jobs never join: each one runs in turn.
- **Use this look** (`POST /api/jobs/:jobId/use-look`) learns the style from any ready job and replaces the current one (mode `replace`). 409 unless the job is ready, and while the client's style is being analysed.
- **The first start with client styles** (nothing stored in `client_styles` yet): every client that has a ready job and no `style.md` learns its style from its newest ready job.

Before the run, the engine copies the job's graphics, `edit/animations/slot_*/`, into a fresh `_Style/kit/`, without the render outputs (`*.mov`, `*.mp4`, `*.webm`) and dot files: the newest approved video's graphics are the kit the next edits reuse, in every mode. A graphic of the Graphics library that the edit mounted (`compositions/lib-<id>.html` and `lib/<id>/` in its project) is never copied, here or into a series' `kit/`: the library is its only source, so the next job gets its current version, and turning it off or deleting it stops it. The run names it in `style.md` (the library's name and when it played, never its look) and not under `## Kit`. The run (Sonnet again) works in the job folder: it reads `edit/project.md`, `edit/brief.md`, the graphics' `index.html` files and four frames of `edit/final.mp4`, and writes `_Style/style.md.new`. `create` and `replace` write the style from this video, with "Learned from <job> (<date>)." under the title. `merge` also reads the current `_Style/style.md` and writes it again with this video's look merged in, keeping `## Do`, `## Don’t` and `## Reference` and adding only rules from this video's `edit/brief.md`. Every mode names the new kit under `## Kit`. Write is limited to that one file by its absolute path (`Edit(//…/_Style/style.md.new)`), and Bash to `ls`, `ffprobe` and single `ffmpeg` frames into /tmp; a merge's rules also name `Read(//…/_Style/style.md)`. If the run fails the old kit is put back. The style's `sourceJobId` is the job. A Learn queued as `create` that finds a `style.md` by the time its turn comes (an upload made one meanwhile) merges into it instead. The prompt is `apps/server/prompts/style-learn.md`; only its step 5 changes with the mode. Like the Read prompt it names the Bash forms that work (`ls -la`, `ffprobe` for the duration, `ffmpeg` one frame per call into `/tmp/learn-<n>.jpg`), one per call, and says a denial means the form was wrong.

**States.** A client's style is `none` until it has one, `analysing` while a style run is queued or running, `ready`, or `failed` with "Style stopped: …": the run didn't write `style.md.new`, it is empty or doesn't start with "# Style:", the run took longer than its 10-minute limit, or its last line said "Blocked: …". Retry (`POST /api/clients/:clientId/style/retry`) runs the same pass again. Every change is a `client.upsert` event; while the style is analysing, its `pass` says what the run does (`{ kind: 'read' | 'learn', mode, fileCount, jobId, job }`, `null` otherwise; a Learn pass's `mode` is `create`, `merge` or `replace`). Style runs go one at a time, apart from the edits, so a style can be made while a video is being edited. A pass waiting for its turn takes in files dropped meanwhile. A shutdown stops the run and leaves the style analysing; the next start runs it again.

**History and Undo.** Before `style.md` is replaced, the engine copies it to `~/.studio-engine/clients/<clientId>/history/<version>.md`, with `<version>.json` naming the job it was learned from, if it was. When a Learn pass replaces the kit, the old kit goes to `history/<version>-kit/` (empty when that style had none). Undo (`POST /api/clients/:clientId/style/undo`) puts the newest kept style back, and its kit when the kit changed after it, keeps the current one in history and adds 1 to the version, so a second Undo goes back again. 409 when nothing was kept, and while the style is being analysed. The style run's stream goes to `~/.studio-engine/logs/clients/<clientId>.log`, between a `style_start` and a `style_end` marker.

**Stills.** `GET /api/jobs/:jobId/still` answers one JPEG frame of the job's export, at 25% of its length and 360 px wide, for the Use this look dialog. It is made with ffmpeg once and kept as `edit/still.jpg` (made again when the export is newer); 404 when the job has no export.

## Shared fonts

`<inbox>/_Fonts/` (so `~/Studio Inbox/_Fonts`) holds fonts every client's jobs can use, so the same font doesn't have to go into each client's `_Style`. The engine makes the folder at start. It is never a client or a job: the scanner, the client list and the watcher skip it like `_Exports`, in any case.

- **What counts.** `.ttf`, `.otf`, `.woff` and `.woff2` files anywhere in it, in folders or not (`Rubik/Rubik-Bold.ttf`). Dotfiles, partial downloads and every other file (a licence, a `.zip`) are left out, so unzip a download first. Name the file after the family and weight (`Heebo-Bold.ttf`): that is how the edit tells them apart.
- **Into the job.** Each time the Brief step writes `brief.md` (before every edit run: start, resume and retry), it copies those files into `<job>/edit/fonts/` at the same paths, in place of the copy before (an APFS clone where it can, made next to its place and renamed). Without fonts there is no `edit/fonts/`. A copy that fails is a warning in the job's log and the job goes on with the fonts it had; fonts never fail a brief.
- **What the edit is told.** `brief.md` ends with a "Fonts" section that lists them one line per folder, the files at the top of `edit/fonts/` first. A folder's names that start the same way are folded, as in `- Hebrew + English/Heebo/: Heebo-{Black,Bold,Thin}.ttf`, so a library of a few hundred files stays a few thousand characters. When a folder path says "English only" (in any case), the section says those fonts have no Hebrew letters, so keep fonts without Hebrew in a folder with that name. It then says to use the file from there where the brief or the client's style names one of these fonts, otherwise pick one that fits the look if it wants, copy each font it uses into the graphics' `assets/fonts/` and load it with `@font-face`, and check that it has the letters of the video's language. The code is `apps/server/src/pipeline/shared-fonts.ts` and `fontLines` in `packages/shared/src/brief/render.ts`.

- **Fonts in notes.** A note can name a font by its full name (`@Heebo Bold`, picked from the `@` list). It is on by default (`STUDIO_FONTS_IN_NOTES=0`, or `"fontsInNotes": false` in `config.json`, turns it off) and acts only while the Fonts switch is on. The run is told which file in `edit/fonts/` each named font is, Review shows the named fonts on the video's captions and titles before anything is sent (a "Previewing" pill, with Compare), a font the library doesn't have is asked for on the Fonts page and the edit uses the closest one, and the Fonts page counts the jobs that used each family ("Used in", "Copy @name"). Off, the `@` list has no fonts, runs ignore font names, Review shows no preview and the page has no used column.

A font a client's style should always use is still best named in that client's style (a note in `_Style` such as "Heebo Bold for titles"): the shared folder only makes the file available.

## Graphics in edits

Every edit can use the Graphics library. It is on by default, and it acts only while the Graphics switch is on too (also by default). `STUDIO_GRAPHICS_IN_EDITS=0` (or `"graphicsInEdits": false` in `config.json`) turns it off: the Brief step copies nothing, `brief.md` has no Graphics library section and the prompts are what they always were.

- **Into the job.** Each time the Brief step writes `brief.md` (before every edit run: start, resume and retry), it copies every live graphic that has a version and "Edits can use it" on, from `<inbox>/_Graphics/<folder>/versions/vN/` (the version edits use) to `<job>/edit/graphics/<id>/`, whole, in place of the copy before (made next to its place and renamed, an APFS clone where it can). A graphic that is deleted, turned off or changed since is gone or new in the next copy. A graphic that can't be copied (its folder is gone, its version has no `compositions/lib-<id>.html`) is left out with a warning in the job's log; graphics never fail a brief. Revise and render runs have no Brief step, so they keep the copy and a video never changes under a later change to a graphic.
- **What the edit is told.** `brief.md` ends with a "Graphics library" section after "Fonts": one line per graphic (name, folder, kind, length, When and its text fields), then how to mount one: copy `compositions/lib-<id>.html` and `lib/<id>/` to the root of the composition project (`edit/preview/` or an animation slot), mount it with a host div sized by CSS (`position:absolute; inset:0`, never `data-width`/`data-height`) and `data-variable-values` filled from the video, keep its look and timing, and keep it off faces and text. A graphic's When is the owner's own rule: the graphic is used wherever its When fits the video, even when the brief doesn't mention a graphic there, and wherever the brief or the owner's note names it; the Series and Client style sections win where they set a graphic for that moment. The text is pinned in `packages/shared/src/brief/render.test.ts`.
- **The prompts.** `apps/server/prompts/unattended-graphics.md` (one line: the library is already in `edit/graphics/`, don't open `_Graphics`) and `apps/server/prompts/brief-use-graphics.md` (one line: the order above) are added only while the switch is on: the first to the edit, revise and render prompts (it sits in the unattended notes), the second to the edit and revise prompts (the ones that read the brief).
- **Not in a kit (CVP-279).** The library is the only source of a library graphic, so neither the client's style kit nor a series' kit copies `compositions/lib-<id>.html` or `lib/<id>/` (`isLibraryGraphicPath` in `apps/server/src/clients/style-kit.ts`). The Learn prompts (`style-learn.md`, `series-learn.md`) have the run write one line naming the graphic and when it played, from `edit/graphics/<id>/about.json` or `brief.md`, else its id. The series shape (`series-shape.md`) says that if the graphic is gone or off for edits, the episode builds that moment in the series' look. To keep a graphic exactly as it is in a series, duplicate it in the library.

The code is `refreshGraphics` in `apps/server/src/pipeline/brief-step.ts` and `graphicLines` in `packages/shared/src/brief/render.ts`.

## Money

Everything you pay, and the price you charge, live in one file you edit by hand: `money.json` in the data folder, `~/.studio-engine/money.json` unless `STUDIO_DATA_DIR` (or `dataDir` in `config.json`) moves it. Nothing creates it; without it the price is ₪200 per job and there are no expenses. The loader reads it at start and again, about 300 ms after you save, whenever it changes, so editing it never needs a restart. The engine reads it too: the price of each job it delivers comes from it, and `GET /api/money?month=2026-10` works out a month's income, expenses and profit from it and from the delivered jobs. The Money page that shows those numbers is still being built (Phase 4).

```json
{
  "currency": "ILS",
  "usdToIls": 3.7,
  "pricePerJob": 200,
  "clientPrices": { "Lumen Yoga": 250 },
  "subscriptions": [
    { "id": "claude", "name": "Claude Max plan", "amount": 200, "currency": "USD", "every": "month", "day": 12, "since": "2026-08-12" },
    { "id": "elevenlabs", "name": "ElevenLabs", "amount": 22, "currency": "USD", "every": "month", "day": 3, "since": "2026-08-03" },
    { "id": "music", "name": "Music library", "amount": 49, "currency": "ILS", "every": "month", "day": 1, "since": "2026-09-01" }
  ],
  "charges": [
    { "date": "2026-10-14", "item": "Stock footage", "what": "Clip licence #4831", "amount": 7.5, "currency": "ILS", "job": "Lumen Yoga/Retreat teaser" }
  ]
}
```

- **Every field is optional.** `{}` is a valid file. Leave out what you don't need; the lists default to empty. A key the engine doesn't know (a typo such as `pricePerjob`) is an error, not ignored.
- **`currency`** is `"ILS"`, the only one, and it means your home currency: the symbol shown is `currencySymbol` in `config.json`. **`usdToIls`** is what a dollar is worth in it (default: `usdToHomeCurrency` in `config.json`); every `"USD"` amount is converted at it, to the agora. **`pricePerJob`** is what a delivered job earns (default 200), and **`clientPrices`** gives a client its own price, keyed by the client's folder name in the inbox (a client not listed pays `pricePerJob`). A price of 0 is allowed.
- **`subscriptions`** are payments that come back. Each one makes a charge on its day every month, or every year, from `since` to `until` (optional), both days included. `id` is any short name, unique in the file. `amount` and `currency` (`"ILS"` or `"USD"`) say what is paid. `every` is `"month"` or `"year"`, and `day` is the day of the month, 1 to 31; in a month that is too short the charge falls on its last day (day 31 is February 28 or 29, April 30). A yearly one also needs `month`, 1 to 12, and a monthly one must not have it:
  ```json
  { "id": "domain", "name": "Domain", "amount": 120, "currency": "ILS", "every": "year", "month": 3, "day": 5, "since": "2026-03-05" }
  ```
- **`charges`** are one-off or per-use payments: `date`, `item` (who you paid), `what` (what for), `amount` and `currency`. Set `job` to the job's `Client/Job` path, as in the inbox, when it was paid for that video alone; it is then that job's expense. A charge without `job` is a general expense.
- **Dates** are calendar days written `YYYY-MM-DD`, and `2026-02-30` is an error. They are plain days, not moments, so the time zone of the Mac doesn't matter.
- **A mistake never stops the engine.** If the file can't be read as JSON or doesn't fit, the loader logs each problem with where it is (`subscriptions[0].day: Too big: expected number to be <=31`) and keeps the last good version. Every valid read is also saved as `money.last-good.json` next to the file, so a restart with the file still wrong starts from that copy. With no good version at all (the file was already wrong and no copy was saved) the defaults are used for the Money page, but **Mark delivered is refused** ("money.json is invalid – run pnpm run doctor"), so a default price is never frozen into a delivery. The Money page says so too: one warning line under its title ("money.json has a mistake, so this page shows the last good numbers…", or, with no good version, that prices and expenses are defaults and Mark delivered is off), with the first problem under it; it appears and goes away as you save the file. Fix the file and save it; the next read picks it up. A file that is deleted means the defaults.
- **`pnpm run doctor`** reads the file the same way and prints one line: `money.json  not found (200 per job, no expenses yet)`, `money.json  2 subscriptions, 1 charge`, or `money.json  invalid – <the first problem>` (a failure, with the other problems under it).

The schema and the money maths (`priceForClient`, `toIls`, `subscriptionCharges`, `chargesBetween`, the month helpers and the shape of the `GET /api/money` answer) are in `packages/shared/src/domain/money.ts`, and `computeMoney`, which works a month out, is in `money-compute.ts` next to it; the loader, the only code that reads the file, is `apps/server/src/money/money-file.ts`, and the route is `apps/server/src/routes/money.ts`.
