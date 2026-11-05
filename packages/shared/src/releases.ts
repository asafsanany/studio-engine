// Release notes: what changed in each version, written for the owner in plain language (not a commit
// log). The app shows them in the "What's new" dialog; `pnpm release:check` guards this file.
//
// The rule (CLAUDE.md, "Versioning"):
// - Versions are X.Y.Z. X is changed by the owner only. Y = a new user-visible capability, Z = fixes
//   and small tweaks.
// - Every change that alters app behaviour bumps Y or Z in the root package.json and adds an entry
//   here, in the same change.
// - Newest first: add the new entry at the top of RELEASES. Versions strictly decrease down the
//   list (release:check fails otherwise).
// - Each item is one short sentence about what the owner sees or can do now, never a code change.
// - `date` is the day the version is released, as YYYY-MM-DD.

import { z } from 'zod';

/** Plain `X.Y.Z` with whole numbers (no leading zeros, no `v` prefix, no pre-release suffix). */
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const versionSchema = z
  .string()
  .regex(VERSION_PATTERN, 'Expected a version like 0.1.0 (X.Y.Z)');

export const releaseSchema = z.strictObject({
  version: versionSchema,
  /** The day it was released, YYYY-MM-DD. */
  date: z.iso.date(),
  /** What changed, in plain language: one short sentence each, at least one. */
  items: z.array(z.string().trim().min(1)).min(1),
  /**
   * A screenshot of what changed, for versions that change the UI: the file name of an image in
   * apps/web/src/assets/whats-new/ (e.g. "0.13.0-whats-new.jpg"). The dialog shows it under the
   * bullets.
   */
  screenshot: z
    .string()
    .regex(/^[\w.-]+\.(png|jpe?g|webp)$/i, 'Expected an image file name like 0.13.0-jobs.png')
    .optional(),
});
export type Release = z.infer<typeof releaseSchema>;

export const releasesSchema = z.array(releaseSchema);

/** `[major, minor, patch]` of an `X.Y.Z` string, or null when it is not one. */
export function parseVersion(text: string): [major: number, minor: number, patch: number] | null {
  const match = VERSION_PATTERN.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Numeric semver order: -1 when `a` is older than `b`, 1 when newer, 0 when equal
 * (so "0.10.0" is newer than "0.9.0", which a string compare gets wrong).
 * Throws a RangeError when either side is not `X.Y.Z`; check with `parseVersion` first on
 * untrusted input such as localStorage.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    throw new RangeError(`Not an X.Y.Z version: ${JSON.stringify(left ? b : a)}`);
  }
  for (let i = 0; i < 3; i++) {
    const l = left[i] as number;
    const r = right[i] as number;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * How a release date is shown: "2026-10-22" becomes "22 Oct 2026". Read from the text, never
 * through `Date`, so no time zone can move the day. Anything that is not YYYY-MM-DD comes back
 * unchanged.
 */
export function formatReleaseDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return date;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/** The entry for exactly this version, if there is one. */
export function findRelease(releases: readonly Release[], version: string): Release | undefined {
  return releases.find((release) => release.version === version);
}

/**
 * The releases to greet the user with on app load, oldest first.
 * - Seen before (`lastSeen` is a valid version): every release after it, up to and including
 *   `current`. A release newer than the running app is never shown.
 * - First ever open (`lastSeen` missing or not a version): only the current version.
 * - Nothing newer than `lastSeen`, or `current` has no entry on a first open: an empty list.
 */
export function releasesToShow(
  releases: readonly Release[],
  lastSeen: string | null | undefined,
  current: string,
): Release[] {
  if (parseVersion(current) === null) return [];
  const seen = lastSeen != null && parseVersion(lastSeen) !== null ? lastSeen : null;
  if (seen === null) {
    const release = findRelease(releases, current);
    return release ? [release] : [];
  }
  return releases
    .filter((r) => compareVersions(r.version, seen) > 0 && compareVersions(r.version, current) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Newest first. The root package.json version must have an entry here (`pnpm release:check`).
 * Every finished work item moves the version: the orchestrator's merge commit bumps it and adds
 * the entry at the top (CLAUDE.md, "Versioning").
 */
export const RELEASES: readonly Release[] = [
  {
    version: '0.67.2',
    date: '2026-11-01',
    items: [
      'On the phone, a short client name in the By client list (like Shira) is no longer split across two lines; the name and its job count now sit on one line.',
    ],
  },
  {
    version: '0.67.1',
    date: '2026-10-31',
    items: [
      'A note like “start the song at 0:37” now works: the editor gets the same song again and starts it at exactly that moment, instead of leaving the music as it was.',
    ],
  },
  {
    version: '0.67.0',
    date: '2026-10-31',
    items: [
      'A click on a job now opens it right under its row, in the list, instead of a drawer from the side: the jobs above and below stay in view, and a second click on the row (or Esc) closes it.',
      'Click another job and that one opens instead. Show in Finder and ⋯ sit at the top right of the open job.',
    ],
    screenshot: '0.67.0-job-under-row.jpg',
  },
  {
    version: '0.66.10',
    date: '2026-10-31',
    items: [
      'Approve is no longer inside Review: right-click the job in the list and choose Approve. Review’s footer says where it is, so a job is approved when it’s done, not to see the video sooner.',
      'On the phone, press and hold a job in the list: its sheet opens, with Approve in it.',
    ],
    screenshot: '0.66.10-approve-in-menu.jpg',
  },
  {
    version: '0.66.9',
    date: '2026-10-31',
    items: [
      'A client’s Instagram chart of likes, comments and shares now has views too: a green line of each reel’s views against their usual reel’s, with the views in the hover card.',
    ],
    screenshot: '0.66.9-views-line.jpg',
  },
  {
    version: '0.66.8',
    date: '2026-10-31',
    items: [
      'Settings has a Quick fixes switch: turn it off and every note in Review waits for Send instead of small ones being fixed right away. It counts after the engine restarts.',
    ],
    screenshot: '0.66.8-quick-fixes-switch.jpg',
  },
  {
    version: '0.66.7',
    date: '2026-10-31',
    items: [
      'On a client’s Instagram section, hovering the Followers or Shares a week line shows its whole hover card instead of one cut off at the bottom of the box.',
    ],
  },
  {
    version: '0.66.6',
    date: '2026-10-31',
    items: [
      'A client’s Instagram reels now include the collab reels it posted with another client, so the your studio page lists all of @studio_account’s reels, not only the ones no other client had.',
      'A client’s Instagram picture is saved even when Instagram sends it from its other picture server, and is tried again when Instagram doesn’t answer the first time, so @studio_account has its picture.',
    ],
  },
  {
    version: '0.66.5',
    date: '2026-10-31',
    items: [
      'A job with no footage of its own whose brief names clips that are in the client’s _Shared folder is now edited from those clips, instead of being made as a Generated video that stops for want of a voice-over script.',
      'Press Retry on such a job (like Good Morning) and its brief is read again with the client’s shared files; it stops showing as Generated.',
    ],
  },
  {
    version: '0.66.4',
    date: '2026-10-30',
    items: [
      'The DMs page reads the chat with @owner_account in one request instead of one per message, so it stays well inside what Instagram allows an hour.',
    ],
  },
  {
    version: '0.66.3',
    date: '2026-10-30',
    items: [
      'An Uploaded job on the Jobs page now says how many plays its reel has, like "Posted Fri 30 Oct · 1.5K plays", and the numbers follow each scan. What the client still owes is in the row’s tooltip.',
      'In the Instagram dialog, "Working together since" shows the day as "1 Aug 2026" and takes it typed that way (or as 1/8/2026), with a calendar button at its end.',
      'The Clients list leaves out the "Assigned to" column while you have no editor and no client is assigned, and a client whose Instagram is private keeps its initials.',
    ],
    screenshot: '0.66.3-uploaded-plays.jpg',
  },
  {
    version: '0.66.2',
    date: '2026-10-30',
    items: [
      'On a client’s page, Style and the ⋯ button stay on the right even when the client’s Instagram bio is long; the bio keeps to one line and shows in full when you point at it.',
    ],
  },
  {
    version: '0.66.1',
    date: '2026-10-30',
    items: [
      'A client’s page has a ⋯ button next to Style with the same menu as the client’s row in the Clients list: Instagram…, Assign to…, Rename…, Show in Finder and Delete…. After a rename the page follows the new name, and after a delete it goes back to Clients.',
      'On a client’s page the Instagram photo is bigger (56 px), the bars of Plays of every reel are wider, and the Reels list shows each song’s name whole with the artist after it in a lighter grey.',
    ],
    screenshot: '0.66.1-client-menu.jpg',
  },
  {
    version: '0.66.0',
    date: '2026-10-30',
    items: [
      'Clients × Instagram is now on by default (the Settings switch can still turn it off): each client with an Instagram account gets an Instagram section on their page (followers, plays, likes and shares of our reels next to theirs), their Instagram photo as their picture, and a scan every Monday. Right-click a reel to link it to the job it came from; the job then shows as Uploaded.',
      'Checked against Instagram itself: the followers match for Falcon, the winery and Orbit, and the likes and comments of a reel match for Falcon and the winery (Double has no reels yet).',
    ],
    screenshot: '0.66.0-instagram.jpg',
  },
  {
    version: '0.65.12',
    date: '2026-10-30',
    items: [
      'The DMs page shows only reels: the ones @owner_account sends @studio_account and the ones @studio_account sends back, each saying who sent it.',
      'It reads only the chat with @owner_account, and when Instagram asks it to slow down it waits 15 minutes before checking again.',
    ],
  },
  {
    version: '0.65.11',
    date: '2026-10-30',
    items: [
      'The DMs page reads @studio_account with the key Meta makes for new apps, which never runs out, and its steps for making the key now match what Meta shows today.',
    ],
  },
  {
    version: '0.65.10',
    date: '2026-10-30',
    items: [
      'Behind the scenes: a test engine on the fake runner now scans sample Instagram accounts without Apify, there is a seed with every Instagram state, and an end-to-end test walks through adding an account, linking a reel and unlinking it.',
    ],
  },
  {
    version: '0.65.9',
    date: '2026-10-30',
    items: [
      'Instagram shares are back now that Apify is on a paid plan, so the cost reads about $0.05 a client a week, shares included (what today’s scans really cost: $0.02 to $0.05).',
    ],
  },
  {
    version: '0.65.8',
    date: '2026-10-30',
    items: [
      'Money lists the Apify Starter plan ($19 a month, from 30 Oct), and the Instagram scans from then on are shown as paid by that plan, so the month doesn’t count them twice.',
    ],
  },
  {
    version: '0.65.7',
    date: '2026-10-30',
    items: [
      'An Instagram account with no reels yet (only photos, like Orbit’s) now scans fine: its followers, bio and photo show, with no reels to list, instead of “The scan failed”.',
    ],
  },
  {
    version: '0.65.6',
    date: '2026-10-30',
    items: [
      'The Clients list shows each client’s Instagram: followers, this week’s change and how our videos do next to theirs (× their usual). A client without an account has Add Instagram, a private one Edit account.',
      'A client’s picture is now their Instagram photo, in the Clients list, the job sheet and on the phone.',
      'A delivered video’s sheet has an On Instagram line: its reel’s plays, likes, comments and shares, with Open reel, or a reminder to link it from the client’s page.',
    ],
  },
  {
    version: '0.65.5',
    date: '2026-10-30',
    items: [
      'The DMs page’s steps for the Instagram key now match Meta’s site: start at developers.facebook.com/apps, register as a developer first if it shows Get started, then Create app.',
    ],
  },
  {
    version: '0.65.4',
    date: '2026-10-30',
    items: [
      'Since us on a client’s Instagram now counts the reels from the day you started working together, not from the first scan, so Falcon’s and the winery’s reels from before this week show up.',
      'A Hebrew Instagram bio on the client page sits on the right, where Hebrew starts.',
    ],
  },
  {
    version: '0.65.3',
    date: '2026-10-30',
    items: [
      'Deleting a job while its preview video or download video is still being made stops that video first, so the deleted job can’t come back as an empty folder in the inbox.',
    ],
  },
  {
    version: '0.65.2',
    date: '2026-10-30',
    items: [
      'Add or change a client’s Instagram from its right-click menu, from New client, or from the empty Instagram box on its page; the dialog also removes it.',
      'The Instagram section now shows the first scan while it reads, a clear line when a scan can’t run (private, not found, no Apify key, no credit, failed) with what to do, and a note when none of our videos is linked yet.',
      'Settings › Instagram has the weekly scan switch and Which clients (Active or All); the cost now reads about $0.03 a client a week, what Apify really charges.',
    ],
  },
  {
    version: '0.65.1',
    date: '2026-10-30',
    items: [
      'A client’s _Shared files are no longer copied into every job: the editor picks from the _Shared folder and copies in only the files it uses.',
    ],
  },
  {
    version: '0.65.0',
    date: '2026-10-30',
    items: [
      'New DMs page: send a reel, post, sound or photo to @studio_account from @owner_account in an Instagram DM and it shows up here within a minute, with the reel, photo or voice note downloaded to play or save.',
      'It needs a key from Instagram, made once; until it has one, the page lists the steps.',
    ],
    screenshot: '0.65.0-instagram-dms.jpg',
  },
  {
    version: '0.64.3',
    date: '2026-10-30',
    items: [
      'The Money page now shows what Apify really charged for each Instagram scan (about $0.03 a client), not $0.001; the first two scans are corrected on their own a few minutes after the update.',
    ],
  },
  {
    version: '0.64.2',
    date: '2026-10-30',
    items: [
      'A client’s Instagram section lists every reel (plays, × usual, likes, comments, shares, sound, tags, ours or theirs). Right-click a reel › Link to job to mark it as our video; only delivered videos that aren’t linked yet are offered, and a linked one has Unlink, with Undo on both.',
    ],
  },
  {
    version: '0.64.1',
    date: '2026-10-30',
    items: [
      'Deleting a video right as its preview or a quick fix was starting no longer leaves an empty folder behind in the inbox that could come back as a new job.',
    ],
  },
  {
    version: '0.64.0',
    date: '2026-10-30',
    items: [
      'A client can have a _Shared folder next to its jobs: put a logo, b-roll or footage there once and every video of that client can use it, without copying it into each job.',
    ],
  },
  {
    version: '0.63.16',
    date: '2026-10-30',
    items: [
      'Behind the Clients × Instagram switch: the Shares a week tile draws its weekly line, and the Followers line has a dot on each week one of our videos went up.',
    ],
  },
  {
    version: '0.63.15',
    date: '2026-10-30',
    items: [
      'Behind the Clients × Instagram switch: each client’s Instagram is read every Monday at 06:00, and at once when you add it or press Scan now, one client at a time; renaming or deleting a client waits while it is being read.',
    ],
  },
  {
    version: '0.63.14',
    date: '2026-10-30',
    items: [
      'Behind the Clients × Instagram switch: a client’s page gets an Instagram section with the handle and followers in the header, Since us / 90 days / 30 days, Scan now, four tiles (followers, plays and likes per reel ours against theirs, shares a week), Plays of every reel, and likes, comments and shares against their usual reel.',
    ],
  },
  {
    version: '0.63.13',
    date: '2026-10-30',
    items: [
      'Each Instagram scan’s cost will show on the Money page under Apify, as “Instagram scan · <client>” on the day it ran, with no job; Analytics › Services says what Apify is used for now.',
    ],
  },
  {
    version: '0.63.12',
    date: '2026-10-30',
    items: [
      'Behind the scenes for Clients × Instagram: the engine works out the numbers for the client page (followers this week and since we started, plays and likes per reel ours against theirs, shares a week, every reel against their usual one) and a short summary for the Clients list.',
    ],
  },
  {
    version: '0.63.11',
    date: '2026-10-30',
    items: [
      'Behind the scenes for Clients × Instagram: a reel can be linked to the job it came from, and a linked job turns Uploaded with its reel’s link and posting day. The right-click menu for it comes next.',
    ],
  },
  {
    version: '0.63.10',
    date: '2026-10-30',
    items: [
      'Nothing changes in the app: the Clients list waits for the client folders only from the moment the engine starts, so tools that build the engine without starting it are not held up.',
    ],
  },
  {
    version: '0.63.9',
    date: '2026-10-30',
    items: [
      'The Clients page no longer says “No clients yet” when it is opened just after the engine starts: the engine reads the client folders first thing, and the list waits for them instead of answering with none.',
    ],
  },
  {
    version: '0.63.8',
    date: '2026-10-30',
    items: [
      'Behind the scenes for Clients × Instagram: the engine can read a client’s Instagram page (profile, recent reels with their plays, likes, comments and shares, and the profile photo) and file it with what the scan cost. Nothing runs yet.',
    ],
  },
  {
    version: '0.63.7',
    date: '2026-10-30',
    items: [
      'Nothing changes in the app: the design sample’s approved Songs job shows its second file as made again.',
    ],
  },
  {
    version: '0.63.6',
    date: '2026-10-30',
    items: [
      'Jobs has a new status, Uploaded, between Delivered and Paid, with its own tab and a violet arrow. A delivered video turns Uploaded once its Instagram reel is linked to it (that part comes with Clients × Instagram). Its next step is still Mark paid…, its menu has Open reel, and Not delivered yet waits until the reel is unlinked.',
    ],
    screenshot: '0.63.6-uploaded.jpg',
  },
  {
    version: '0.63.5',
    date: '2026-10-30',
    items: [
      'Nothing changes in the app: a check that shutting down closes every open connection was out of date, and is fixed.',
    ],
  },
  {
    version: '0.63.4',
    date: '2026-10-30',
    items: [
      'Settings has a new switch, Clients × Instagram. It stays off for now; it will turn on the weekly Instagram scan and the Instagram part of each client’s page once they are built.',
    ],
  },
  {
    version: '0.63.3',
    date: '2026-10-30',
    items: [
      'Behind the scenes for Clients × Instagram: the engine has a place to keep each client’s Instagram account, scans and reels. Renaming or deleting a client takes them along. Nothing shows in the app yet.',
    ],
  },
  {
    version: '0.63.2',
    date: '2026-10-30',
    items: [
      'Behind the scenes for Clients × Instagram: Studio Engine can now ask Apify for a client’s Instagram profile and recent reels and read what each run cost. Nothing shows in the app yet.',
    ],
  },
  {
    version: '0.63.1',
    date: '2026-10-30',
    items: [
      'The preview player’s bar fits again with the speed slider: the full screen button is back at the right, and on a tall video the music name stays in the header only.',
    ],
    screenshot: '0.63.1-player-bar.jpg',
  },
  {
    version: '0.63.0',
    date: '2026-10-30',
    items: [
      'You can delete a client: right-click it on the Clients page and choose Delete…. Its folder and its exports go to the Trash, and its videos and their payments are removed from the app and from Money.',
      'A client with a video that is arriving or being edited waits until it is done, and the dialog says so.',
      'Renaming a client now shows its “Renamed to …” message on the Clients page.',
    ],
    screenshot: '0.63.0-delete-client.jpg',
  },
  {
    version: '0.62.0',
    date: '2026-10-30',
    items: [
      'The preview player has a speed slider next to the volume, from 0.3× to 3×. Click the speed it shows to go back to 1×.',
      'The speed stays as it is when the music changes under the video.',
    ],
    screenshot: '0.62.0-speed.jpg',
  },
  {
    version: '0.61.1',
    date: '2026-10-29',
    items: [
      'On Analytics, the Clients line now has a point for every day: how many clients had a job finished in the 7 days up to that day (Month: the 30 days), so it ends on the tile’s number.',
    ],
    screenshot: '0.61.1-clients-line.jpg',
  },
  {
    version: '0.61.0',
    date: '2026-10-29',
    items: [
      'Mark paid now asks what was paid for each video. Each one starts at its price, and you can type any amount, ₪0 included, for a client who doesn’t pay for now. Typing an amount ticks the video.',
      'The Money page counts what was actually paid for a paid video, and its row says so, for example "Paid 29 Oct · ₪0". Not paid yet puts it back to its price.',
    ],
    screenshot: '0.61.0-amount-paid.jpg',
  },
  {
    version: '0.60.1',
    date: '2026-10-29',
    items: [
      'With two jobs editing at once, starting the second one no longer stops the first one. It used to fail with "exit code 143".',
    ],
  },
  {
    version: '0.60.0',
    date: '2026-10-29',
    items: [
      'Two jobs now edit at the same time, so the line moves faster: the first two in line start together, and the next one starts as soon as either finishes. Each has its own Cancel.',
      'You can go back to one at a time with Settings › Two jobs at once. It counts after the engine restarts.',
    ],
    screenshot: '0.60.0-two-jobs-at-once.jpg',
  },
  {
    version: '0.59.0',
    date: '2026-10-29',
    items: [
      'You can now rename a client: right-click it on the Clients page and pick Rename…. Its folder in Studio Inbox, its exports and all its videos take the new name, and its style, series, payments and editors stay with it. It waits while one of its videos is still arriving or being edited.',
    ],
    screenshot: '0.59.0-rename-client.jpg',
  },
  {
    version: '0.58.2',
    date: '2026-10-29',
    items: [
      'With Draft & chat on, the video side of a job’s chat now plays the cut while the job works on it, instead of Claude’s newest picture. Before there is a cut 1 it just says so. Claude’s pictures are still in the chat.',
    ],
  },
  {
    version: '0.58.1',
    date: '2026-10-29',
    items: [
      'With Draft & chat on, clicking a job that is working or waiting for your review opens its chat straight away, on the Mac and the phone, instead of the side panel. Other jobs still open the side panel.',
    ],
  },
  {
    version: '0.58.0',
    date: '2026-10-28',
    items: [
      'Draft & chat is built and waits behind a switch: turn on Settings › Draft & chat and restart the engine to try it. Each edit is then one video-use run, the Draft, that reads the client’s instructions itself, and Review becomes a chat with everything it says, runs and looks at: its commands, the frames and sound waves it opens, the transcript, the plan, the cut list and the loudness, live while it works, on the Mac and the phone.',
    ],
    screenshot: '0.58.0-draft-chat.jpg',
  },
  {
    version: '0.57.0',
    date: '2026-10-28',
    items: [
      'The Jobs page can now group by client, like the phone: open View and turn on By client, and each client’s jobs sit under its name, with how many there are and a link to its page, joined by a thin line. The clients come in order of their latest activity and all the jobs are on one page; turn it off for the plain list again. The app remembers your choice.',
    ],
  },
  {
    version: '0.56.2',
    date: '2026-10-28',
    items: [
      'The downloaded and approved video now matches what you see in the live editor after a colour-grade round: the app used to keep the video it made before the grade changed, so it came out darker. Now any change to the cut, the music, the sounds or the pictures makes it render a new one.',
    ],
  },
  {
    version: '0.56.1',
    date: '2026-10-27',
    items: [
      'The logo test worked: the technician wears the PINEWOOD logo on their shirt, small on the chest and large on the back, spelled right and with no black box, in a 4 s clip that cost 2 credits; the prompt now asks for exactly that wording.',
    ],
  },
  {
    version: '0.56.0',
    date: '2026-10-27',
    items: [
      'A video with no footage is now made with Kling 4.0, the way your test worked: the story is written as timecoded shots with hard cuts, and each scene is one clip of up to 30 seconds at 720p, about 15 credits for 30 seconds.',
      'No pictures are generated any more, only the client\u2019s own logo is sent, so the technician wears the logo on their shirt; the clips come back silent and are joined into one preview video.',
    ],
  },
  {
    version: '0.55.1',
    date: '2026-10-27',
    items: [
      'The first real test on your Higgsfield plan worked from start to finish (one picture and one 5 s Kling 3.0 scene for 7.62 credits). A picture is now booked at its exact credit price (0.12, not 1), and the run no longer stops at the connector’s preset suggestions.',
    ],
  },
  {
    version: '0.55.0',
    date: '2026-10-27',
    items: [
      'A video with no footage is now made on your Higgsfield plan credits, through the Higgsfield connector in Claude, instead of the separate dollar balance of the API.',
      'It plans the whole video in words first, makes a reference picture of each person and prop, then makes a few long Kling 3.0 scenes of 5 to 15 seconds that cut between several shots by themselves.',
      'What a video spends still shows in dollars (a plan credit counts as $0.056), and a video may spend $5 by default: one pass and a few scenes made again.',
      'The doctor now checks that the Higgsfield connector is connected in Claude, instead of checking an API key.',
    ],
  },
  {
    version: '0.54.0',
    date: '2026-10-27',
    items: [
      'Every chart on Analytics now shows details when you hover it: the lines and bars, the little graphs in the top tiles, each delivery day, the steps of a typical job and the note topics.',
      'The charts fill their whole card, and "API credits and plan" follows the Week | Month switch: Week is the last 7 days, and "Jobs delivered per day" becomes the last 14 days as bars.',
    ],
    screenshot: '0.54.0-analytics-charts.jpg',
  },
  {
    version: '0.53.0',
    date: '2026-10-27',
    items: [
      'Settings has a new "Claude plan only" switch, on by default: every Claude run, whatever it does, uses your claude.ai plan and never the API key, even if a key is in the .env file.',
      'To bill the API key again, turn the switch off in Settings and restart the engine; with no key in the .env file, the runs still use your plan.',
    ],
    screenshot: '0.53.0-claude-plan-only.jpg',
  },
  {
    version: '0.52.0',
    date: '2026-10-26',
    items: [
      'You can now rename a video: right-click it (or open its ⋯ menu in the sheet) and choose Rename…. Its folder in the inbox and its exported MP4 get the new name too, and its notes, cuts, delivery and payment stay with it.',
      'Rename is off while a video is arriving, queued or being edited, and the dialog tells you if another video of that client already has the name.',
    ],
    screenshot: '0.52.0-rename.jpg',
  },
  {
    version: '0.51.0',
    date: '2026-10-26',
    items: [
      'The Claude use part of Analytics now has the API credits on the left and your Max plan on the right all the way down: the two lists of what used them are one card with the same columns, each ending with its slice of its budget.',
      "The two charts at the bottom show both budgets: one draws how much of the credits and of the plan's weekly limit is used through the month, the other puts what the app spent next to the plan's busiest week (or day), blue for the credits and orange for the plan.",
      '"API cost per finished minute" is gone from the page.',
    ],
    screenshot: '0.51.0-claude-use.jpg',
  },
  {
    version: '0.50.2',
    date: '2026-10-26',
    items: [
      'As soon as an edit is ready for your review, the engine now starts making its videos by itself: the small one for your phone and the full-quality one to download, so both are there when you open them.',
      'Approve waits for a video that is still being made instead of rendering the same one again.',
    ],
  },
  {
    version: '0.50.1',
    date: '2026-10-26',
    items: [
      'A note like "music only at first, then the lyrics when the images start" now makes the editor pick a different part of the song, one that opens on the song\'s own instrumental intro and sings the moment you named, instead of only moving the cuts around the same slice.',
      'The same works from the brief: when it says the song starts without lyrics and the lyrics come in at a moment of the picture, the editor cuts the song so its first word lands there, and the music plays from the first frame.',
    ],
  },
  {
    version: '0.50.0',
    date: '2026-10-26',
    items: [
      'The Money page now lists every job, not only the delivered ones: a job still in Review or Approved shows with "Not delivered yet", no income and what it already cost you.',
      "What Higgsfield and ElevenLabs cost a video now shows in that job's expenses on the Money page: the dollars Higgsfield took for the shots, and the ElevenLabs credits of the voice and the music priced at your plan (already paid by the plan, so the month does not count them twice).",
      'Analytics has a new Services section: every API the app uses, paid or free, with its plan from money.json, what it was used for and what it cost. Higgsfield shows "No plan in money.json yet" until its subscription is added there.',
    ],
    screenshot: '0.50.0-services.jpg',
  },
  {
    version: '0.49.4',
    date: '2026-10-25',
    items: [
      "Behind the scenes: four browser tests (Archive, the job sheet, the first-run walkthrough and the client Style page) were brought up to date with the app's current menus and texts, so they pass again.",
    ],
  },
  {
    version: '0.49.3',
    date: '2026-10-26',
    items: [
      'A song you name in the brief ("Music: title - artist") is now read as a song and fetched, and an older brief that never read its song is read again on Retry or Resume instead of being reused with no music.',
    ],
  },
  {
    version: '0.49.2',
    date: '2026-10-26',
    items: [
      'Stock media (still off): a real edit with your Unsplash key now opens on a night-street photo with a whoosh over the cut, and the sound-effect search finds real sounds on Freesound instead of nothing.',
    ],
  },
  {
    version: '0.49.1',
    date: '2026-10-25',
    items: [
      'When YouTube says too many requests (or takes your Mac for a bot) while the editor is getting a song, Review and the job sheet now say YouTube is refusing right now and to try again in a while, instead of telling you to check your internet.',
    ],
  },
  {
    version: '0.49.0',
    date: '2026-10-26',
    items: [
      'Music is allowed on every project, and the editor uses it only when you ask for it. A video nobody asked music for says "No music asked for" in Review.',
      "Ask in a note for music to be made, or send Yael's song as a screenshot, a link or a name, or ask for a trending song, and the editor cuts to it.",
      'Approve gives two files, with and without the song, and a line to copy for adding the song in Instagram.',
    ],
    screenshot: 'songs.jpg',
  },
  {
    version: '0.48.2',
    date: '2026-10-25',
    items: [
      "Behind the scenes: with the music switch on, music is made only when the job asks for it (a note, the client's words, a song, or Make music in Review). A video nobody asked music for now says No music asked for instead of getting a track. The music and songs switches are still off.",
    ],
  },
  {
    version: '0.48.1',
    date: '2026-10-26',
    items: [
      'There’s a Hebrew brief template for the editor now (docs/brief-template-he.txt): job name, music (name, link, screenshot or a trending song), video length, plus ten more fields worth filling in. Drop the filled-in file in the job folder and the editor reads it.',
    ],
  },
  {
    version: '0.48.0',
    date: '2026-10-26',
    items: [
      'There’s a Settings page now, at the bottom of the sidebar, with a switch for Graphics, Fonts and LUTs so you can turn off the ones you don’t use.',
      'A switch saves at once and counts after the engine restarts; the page has a Restart engine button for that, and edits in progress pick up again afterwards.',
    ],
    screenshot: '0.48.0-settings.jpg',
  },
  {
    version: '0.47.5',
    date: '2026-10-25',
    items: [
      'Behind the scenes: two more tests no longer fail now and then when the computer is busy, and the stand-in for the video-making service writes its cost line before the clip, like the real one.',
    ],
  },
  {
    version: '0.47.4',
    date: '2026-10-25',
    items: [
      'A flat clip like a calm sky is no longer mistaken for log footage, so an otherwise finished edit no longer ends as Waiting for a camera LUT. Real log footage still waits for its camera LUT.',
    ],
  },
  {
    version: '0.47.3',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the tests for generated videos no longer fail now and then when the computer is busy.',
    ],
  },
  {
    version: '0.47.2',
    date: '2026-10-26',
    items: [
      'Behind the scenes: videos made without footage go back to the earlier rule, which was the intended one: the AI never makes captions, prices, offer cards, badges, end cards or any other graphic (the edit builds all of those), and the client\u2019s own logo on clothing or equipment may still be in the picture. A note about the logo goes to a new clip again.',
    ],
  },
  {
    version: '0.47.1',
    date: '2026-10-26',
    items: [
      'A video made without footage now gets stock footage only: the pictures and clips the AI makes never hold any text, logo or graphic (the first PINEWOOD video had the logo printed on the technician’s shirt). Every word, logo, card and badge you see is added by the edit, so it can be changed in a note; a note about the logo is now an edit, never a new clip.',
    ],
  },
  {
    version: '0.47.0',
    date: '2026-10-26',
    items: [
      'A client folder with no footage, only a brief with the script and some reference pictures or a video, now makes its own video: the app writes the voiceover (ElevenLabs), makes the pictures and short clips (Higgsfield, up to $3 a video; a note like "budget $5" changes it), edits them to the voice with captions, offer cards, an end card and music, and stops at Review like any other job. The first one, PINEWOOD, took 91 minutes with nothing touched.',
      'In Review, a note about what is in a clip makes a new clip within what is left of the budget, and a note about how the voice says a line makes that line again; each note shows what Send will do and what it costs. The job sheet shows what was made and what it cost, and an approved two-size video has a Download for each size.',
    ],
    screenshot: '0.47.0-generated-videos.jpg',
  },
  {
    version: '0.46.18',
    date: '2026-10-25',
    items: [
      "Behind the scenes: songs that people upload as sounds (like Somewhere only we know by Keane) now count when picking a trending song, and are looked up by the real song and artist instead of the uploader's name. The songs switch is still off.",
    ],
  },
  {
    version: '0.46.17',
    date: '2026-10-25',
    items: [
      "Behind the scenes: a song asked by name is now taken from YouTube Music's own track (Sia's own Snowman, The Weeknd's own Blinding Lights) instead of whichever YouTube upload came first; the plain YouTube search is still the fallback. The songs switch is still off.",
    ],
  },
  {
    version: '0.46.16',
    date: '2026-10-26',
    items: [
      'Behind the scenes: on a video made without footage, a note like "budget $4" now gives it more to spend in a review round (before, the $3 it started with stayed), and Review shows the new total.',
    ],
  },
  {
    version: '0.46.15',
    date: '2026-10-25',
    items: [
      'Behind the scenes: a song with no steady beat (a ballad) no longer says the cuts sit on its beat in Review, and the drop that the song command reports is now where the bass really comes in (it was half a second early). The songs switch is still off.',
    ],
  },
  {
    version: '0.46.14',
    date: '2026-10-25',
    items: [
      "Behind the scenes: when a reel or TikTok uses a real song that someone uploaded as a sound (it says original but is not the creator's own), Songs now looks the song up by name instead of refusing it as original audio, and original audio is recognised in more languages. The songs switch is still off.",
    ],
  },
  {
    version: '0.46.13',
    date: '2026-10-25',
    items: [
      'Behind the scenes: Songs was run for real (a screenshot, a reel link, a trending song, an Original audio screenshot) and three small bugs it showed are fixed. A hit song such as Blinding Lights is now found by name (it often was not), a reel whose audio will not download still gets its song by name, and a TikTok link can be read. The songs switch is still off.',
    ],
  },
  {
    version: '0.46.12',
    date: '2026-10-25',
    items: [
      'Stock media, off for now: when you turn it on, an edit can fetch a sound effect from Openverse or a photo from Unsplash when the footage has none, and the job sheet lists each one with who made it and its license.',
    ],
  },
  {
    version: '0.46.11',
    date: '2026-10-25',
    items: [
      'Behind the scenes: automatic end-to-end tests now follow a video made without footage from the folder to Review on the Mac and the phone (both sizes, the notes and their cost lines, Approve with two files, and the three ways it can stop with Retry); nothing in the app changes.',
    ],
  },
  {
    version: '0.46.10',
    date: '2026-10-25',
    items: [
      'Behind the scenes: some tests of the video-generating step no longer fail when the whole test suite runs on a busy computer; nothing in the app changes.',
    ],
  },
  {
    version: '0.46.9',
    date: '2026-10-25',
    items: [
      'Behind the scenes: after a review round on a video made without footage, the money shown as spent (in Review and on the job sheet) now counts the new clips that round made.',
    ],
  },
  {
    version: '0.46.8',
    date: '2026-10-25',
    items: [
      'Behind the scenes: on a video made without footage, a note like "the caption is hard to read" or "louder music" is no longer taken for a note about a clip or the voice, so it can be fixed on the spot instead of waiting for Send.',
    ],
  },
  {
    version: '0.46.7',
    date: '2026-10-25',
    items: [
      'Behind the scenes: a generated video can now open with a few seconds of picture and an alert before the first word is spoken (the voice track starts with that silence, so the captions, windows and your review notes keep one timeline).',
    ],
  },
  {
    version: '0.46.6',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the instructions that tell the video-making run what to do for a client with no footage are written and tested (it watches the reference, plans the shots, makes the voice first, prices everything and cuts the plan down to the budget, checks every picture and clip, and hands off to the edit); nothing changes for you until Generated videos is switched on.',
    ],
  },
  {
    version: '0.46.5',
    date: '2026-10-25',
    items: [
      'Behind the scenes: videos made without footage will use the Kal Jones voice (deep, smoky, reliable) by default instead of Brian; this stays off until generated videos go live.',
    ],
  },
  {
    version: '0.46.4',
    date: '2026-10-25',
    items: [
      'A quick fix in Review can now use a font you name with @ even on an older video that never had it: the engine puts the font in the video first, so "change the subtitles to @Rubik Glitch" no longer says edit/fonts is missing.',
    ],
  },
  {
    version: '0.46.3',
    date: '2026-10-25',
    items: [
      'A video made in two sizes now shows both sizes on the Jobs list ("9:16 and 1:1") and, once approved, lists each file in the job sheet with its own Download.',
      'Behind the scenes: a video made without footage will show its progress on the Jobs list ("Generate · clips 4/6 · $1.65"), say plainly when the Higgsfield balance is empty, the key is refused or the budget is too small (with Retry from Generate), show its voice, clips and spend on the job sheet on the Mac and the phone, and ping your phone with what to do when it stops; this stays off until generated videos go live.',
    ],
  },
  {
    version: '0.46.2',
    date: '2026-10-25',
    items: [
      'Behind the scenes: a video made without footage now has its own edit and revise instructions (cut the clips to the voice, captions and graphics built in the edit, a note about a hand or a face makes one new clip within what is left of the $3, a note about the voice makes that line again), and notes like these, and every note on a video in two sizes, always wait for Send instead of being fixed on the spot; ordinary videos are untouched.',
    ],
  },
  {
    version: '0.46.1',
    date: '2026-10-25',
    items: [
      'Behind the scenes: a test for the Songs stand-ins no longer fails when the whole test suite runs on a busy computer; nothing in the app changes.',
    ],
  },
  {
    version: '0.46.0',
    date: '2026-10-25',
    items: [
      'An approved video now has Unapprove at the end of its menu (the right-click menu on the Mac, the ⋯ menu on the phone): it sends the video back to Review so you can change it or approve it again. A video you already marked delivered needs Not delivered yet first.',
    ],
  },
  {
    version: '0.45.4',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the practice edit now gets the song you ask for in Review (a name, a link or a trending one) when you press Send, so that whole path is tested end to end. The songs switch stays off.',
    ],
  },
  {
    version: '0.45.3',
    date: '2026-10-25',
    items: [
      'Behind the scenes: when Yael\'s screenshot only says "Original audio", Review and the job sheet now say so plainly and ask for the reel\'s link, instead of showing nothing about the song. The songs switch stays off.',
    ],
  },
  {
    version: '0.45.2',
    date: '2026-10-25',
    items: [
      'On a video made in two sizes, the Export MP4 button in Review now exports the size you are looking at (9:16 or 1:1), says which one on the button, and saves the square one as "Name (1x1).mp4".',
    ],
  },
  {
    version: '0.45.1',
    date: '2026-10-25',
    items: [
      'Behind the scenes: videos made without footage now go through a real Generate step in the engine (it keeps its progress, the money spent and a history up to date, picks up where it stopped after a Retry, and stops with a plain sentence when the balance is empty or the budget is too small); with the Generated videos switch off, nothing changes.',
    ],
  },
  {
    version: '0.45.0',
    date: '2026-10-25',
    items: [
      'When a video is asked for in two sizes (for example 9:16 and 1:1), Review now has a 9:16 | 1:1 switch, on the Mac and on the phone: you watch each size, your notes remember which size you wrote them on, and Approve renders both.',
      'Behind the scenes: for generated videos, each note will say what Send will probably do and what it costs (a new take of a clip, a voice line made again, or just an edit); this stays off until generated videos go live.',
    ],
    screenshot: '0.45.0-review-sizes.jpg',
  },
  {
    version: '0.44.15',
    date: '2026-10-25',
    items: [
      "Behind the scenes: Songs can now be tried end to end without the internet or any key. pnpm seed:canvas --songs shows every state of the Songs screens on the Mac and the phone, and two automatic tests walk the whole flow. One small fix on screen: when the editor couldn't get a song and the message starts with a Hebrew name, the sentence now reads left to right.",
    ],
  },
  {
    version: '0.44.14',
    date: '2026-10-25',
    items: [
      "Behind the scenes: the part that talks to Higgsfield is built and tested (it prices a clip first, refuses to go over the video's budget, and can pick a slow clip up again without paying twice); nothing changes for you yet.",
    ],
  },
  {
    version: '0.44.13',
    date: '2026-10-25',
    items: [
      'Behind the scenes: with a video made in two sizes, picking music or pressing Make another in Review now changes the music of both previews, so the second size no longer plays the old track.',
    ],
  },
  {
    version: '0.44.12',
    date: '2026-10-25',
    items: [
      'Behind the scenes: going back to an earlier cut of a video made in two sizes now brings back both sizes together, so they never go out of step.',
    ],
  },
  {
    version: '0.44.11',
    date: '2026-10-25',
    items: [
      'Behind the scenes: with the Generated videos switch on, a client folder with a script, a references zip and no footage is now read properly. The zip is unpacked, the script is copied word for word into the brief, and both sizes are picked up. Nothing changes while the switch is off.',
    ],
  },
  {
    version: '0.44.10',
    date: '2026-10-25',
    items: [
      'Behind the scenes: when a client or your note asks for two sizes (for example 9:16 and 1:1), the engine now builds, previews, renders and exports both videos as one job, each laid out for its own shape. With one size nothing changes. The Review switch for the two sizes comes in a later step.',
    ],
  },
  {
    version: '0.44.9',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the voice-over maker for videos made without footage is built. It makes the narrator\'s lines, checks each take word for word against the script (so a dropped "But" is caught), joins the lines with pauses, and makes sound effects. It still needs your ElevenLabs key allowed to use Text to Speech before it can speak.',
    ],
  },
  {
    version: '0.44.8',
    date: '2026-10-25',
    items: [
      "Behind the scenes: when a video's music is a song, its job sheet (Mac and phone) shows both files after Approve (with the song, to show the client; without it, to post), the line to send with the second file with a Copy button, the song in Details and its steps in History. On the phone, Share video sends the file without the song with that line. Nothing changes on screen while the songs switch is off.",
    ],
  },
  {
    version: '0.44.7',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the groundwork for videos made without footage. A "Generated videos" switch (off), the new brief fields (a script to voice, formats, a budget), a record of what a generated job has made and spent, and test stand-ins for the voice and clip scripts. Nothing changes for you yet.',
    ],
  },
  {
    version: '0.44.6',
    date: '2026-10-25',
    items: [
      'Behind the scenes: "a trending song" now has an engine behind it. It looks at the most played Reels in the client\'s niche, ranks the songs only by what Instagram itself shows (how many of the top Reels use it, Instagram\'s trending flag, how many Reels use it), checks that the top ones fit the cut and picks one. Learn style may also add a "Reels niche:" line to a client\'s style, marked as a guess you can edit. Nothing changes on screen and the songs switch stays off.',
    ],
  },
  {
    version: '0.44.5',
    date: '2026-10-25',
    items: [
      'Behind the scenes: when a video\'s music is a song, Approve now also makes "[Job] · no song.mp4" next to the normal export (the same video with the song silenced, rendered by the engine with no Claude run). The job sheet will show it in the next step, and the songs switch stays off.',
    ],
  },
  {
    version: '0.44.4',
    date: '2026-10-25',
    items: [
      'Everything now runs on your Claude plan, only: no job, note or fix can bill the API key any more, even if one is put back in the .env file.',
    ],
  },
  {
    version: '0.44.3',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the music script can now get the song Yael asked for and cut the part that fits the video, starting at its drop, at the same volume as the other music. Nothing changes on screen and the songs switch stays off.',
    ],
  },
  {
    version: '0.44.2',
    date: '2026-10-25',
    items: [
      "Behind the scenes: on the phone, Note for the editor becomes a bottom sheet with an Add photo button that opens Photos or Files, so Yael's screenshot can be attached from the phone. A HEIC photo is kept as a JPEG so the Brief can read it. It only shows while the songs switch is on, which stays off.",
    ],
  },
  {
    version: '0.44.1',
    date: '2026-10-25',
    items: [
      'Review\'s footer gives a time range for the notes that wait for Send, from that job\'s own earlier rounds ("12 to 40 min"), instead of one guess.',
      'A note like "cut on the beat" on a cut that is already on the beat is now a smaller re-edit, not a full revise.',
    ],
  },
  {
    version: '0.44.0',
    date: '2026-10-25',
    items: [
      'Notes can now name a LUT: type @ in a Review note or the job note and pick one. The video follows it, and the player shows the look on the paused frame.',
    ],
    screenshot: 'luts-at.jpg',
  },
  {
    version: '0.43.7',
    date: '2026-10-25',
    items: [
      'Behind the scenes: with Songs switched on, the doctor now checks yt-dlp, deno, ffmpeg and the Apify key and prints a one-line fix for each. With Songs off nothing changes.',
    ],
  },
  {
    version: '0.43.6',
    date: '2026-10-25',
    items: [
      "Behind the scenes: Add note… can now take Yael's screenshot (paste it with ⌘V, drop it, or Choose a file), and the Brief reads it. It only shows while the songs switch is on, which stays off.",
    ],
  },
  {
    version: '0.43.5',
    date: '2026-10-25',
    items: [
      "Behind the scenes: Review's Music list now shows the song Yael asked for, with its artist and a bar for the part of it the video uses. It says why when a song could not be got, and has an Another song box (a link or a name, or Pick a trending one) that adds a note for the editor. Nothing changes on screen while the songs switch is off.",
    ],
  },
  {
    version: '0.43.4',
    date: '2026-10-25',
    items: [
      'On the Jobs page, a video that is being edited now says how long it has been running ("Cut · graphics 2/5 · ~4 min left · running 3:42"), counting up live with no click needed.',
    ],
  },
  {
    version: '0.43.3',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the part that fetches a song is built (reel links through Apify, song names and YouTube links through YouTube Music). Nothing calls it yet and the songs switch stays off, so nothing changes on screen.',
    ],
  },
  {
    version: '0.43.2',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the Brief now reads the song off Yael\'s reel screenshot (or a link, or "a trending song"), and the editor knows how to get it and cut to it. Nothing changes on screen and the songs switch stays off.',
    ],
  },
  {
    version: '0.43.1',
    date: '2026-10-25',
    items: [
      'A fixed note\'s answer in Hebrew now sits on its own line, reading right to left, instead of getting tangled with "Fixed in 45 s."',
    ],
  },
  {
    version: '0.43.0',
    date: '2026-10-25',
    items: [
      'Small notes are fixed right in Review: write "change the caption font to Heebo Bold" and about a minute later the video shows it, with Undo and Compare.',
      'Effort for review rounds now starts on Auto (sparkles): each note is sorted by how big it is, and the ones that wait for Send run on the model and effort they need.',
    ],
    screenshot: '0.43.0-quick-fixes.jpg',
  },
  {
    version: '0.42.22',
    date: '2026-10-25',
    items: [
      "Behind the scenes: the shapes Songs is built on are in place (a song in the music record, the song the Brief reads off Yael's screenshot, screenshots attached to a note, the second file without the song, the songs switch). Nothing changes on screen and the switch stays off.",
    ],
  },
  {
    version: '0.42.21',
    date: '2026-10-25',
    items: [
      'The Jobs list says when a note is being fixed in Review ("Review · fixing a note at 0:12…") and how many were fixed there ("Review · cut 2 · 1 fixed here"), once quick fixes are on.',
    ],
  },
  {
    version: '0.42.20',
    date: '2026-10-25',
    items: [
      'On the phone, the quick fix pill ("Fixing at 0:12…", "Changed at 0:12 · Compare") is no longer cut off on the small video while the notes are open, and Compare is big enough for a finger. Quick fixes are still off.',
    ],
  },
  {
    version: '0.42.19',
    date: '2026-10-25',
    items: [
      "Quick fixes, step 9: tested end to end on the Mac and the phone and checked against the design; Undo now also moves the player, and the job sheet shows Review's effort. Still off, so nothing changes yet.",
    ],
  },
  {
    version: '0.42.18',
    date: '2026-10-25',
    items: [
      'Quick fixes, step 8: when a note is fixed in Review the player reloads, jumps to that moment and stops there with "Changed at", and holding Compare shows it before the fix. Still off, so nothing changes yet.',
    ],
  },
  {
    version: '0.42.17',
    date: '2026-10-25',
    items: [
      'Quick fixes, step 7: each note in Review answers in a line under it (reading it, fixing it, fixed with Undo, or goes with Send), and the footer says what happens next. Still off, so nothing changes yet.',
    ],
  },
  {
    version: '0.42.16',
    date: '2026-10-25',
    items: [
      'Quick fixes, step 6: notes fixed in Review go along with Send as already changed, Approve works when every note was fixed, and Auto sends a cut change to Sonnet at High and a whole-video note to the full run. Still off, so nothing changes yet.',
    ],
  },
  {
    version: '0.42.15',
    date: '2026-10-25',
    items: [
      'Behind the scenes: a job shot in camera log with no camera LUT now waits for one even when the editor left a half-made preview behind, instead of landing in Review with a broken player (still switched off).',
    ],
  },
  {
    version: '0.42.14',
    date: '2026-10-25',
    items: ['Undid the last phone tweak that made the tab bar slip off the bottom of the screen.'],
  },
  {
    version: '0.42.13',
    date: '2026-10-25',
    items: [
      'Quick fixes, step 5: small notes are fixed one at a time while the job stays in Review, with Undo, and Approve and Send wait for a fix to finish. Still off, so nothing changes yet.',
    ],
  },
  {
    version: '0.42.12',
    date: '2026-10-25',
    items: [
      'Behind the scenes: a LUT is now counted as used in a job only after the edit actually succeeds, not when a round that then fails (like on the usage limit) was merely started.',
    ],
  },
  {
    version: '0.42.11',
    date: '2026-10-25',
    items: [
      'Quick fixes, step 4: the run that makes a small fix (a font, a caption, a size) in the live preview in about a minute. Still off, so nothing changes yet.',
    ],
  },
  {
    version: '0.42.10',
    date: '2026-10-25',
    items: [
      'Quick fixes, step 3: once quick fixes are on, Effort gets an Auto choice (sparkles) in Review, in the right-click menu and on the phone. Still off, so nothing changes yet.',
    ],
  },
  {
    version: '0.42.9',
    date: '2026-10-25',
    items: [
      'Quick fixes, step 2: with quick fixes on, each new review note is read in the background and sorted as a small fix or a bigger one. Still off, so nothing changes yet.',
    ],
  },
  {
    version: '0.42.8',
    date: '2026-10-25',
    items: [
      'On the Home Screen app the phone now fills the whole screen height, so the tab bar sits at the very bottom with no dead strip under it.',
    ],
  },
  {
    version: '0.42.7',
    date: '2026-10-25',
    items: [
      'The phone tab bar never leaves more than a thin strip under its labels, even when the phone reports a tall home-bar area.',
      'Groundwork for quick fixes, where small notes like a font or a caption are fixed right in Review. Nothing changes yet: it stays off until it is ready.',
    ],
  },
  {
    version: '0.42.6',
    date: '2026-10-25',
    items: [
      'The phone tab bar is shorter: there is much less empty space under Jobs, Clients and Money.',
    ],
  },
  {
    version: '0.42.5',
    date: '2026-10-25',
    items: [
      'The side panel is back to one plain list: Graphics, LUTs and Fonts sit one after the other again, with no Assets heading.',
    ],
  },
  {
    version: '0.42.4',
    date: '2026-10-25',
    items: [
      'Click the "Assets" heading in the side panel to fold Graphics, LUTs and Fonts away, and again to bring them back.',
    ],
  },
  {
    version: '0.42.3',
    date: '2026-10-25',
    items: [
      'The side panel now groups Graphics, LUTs and Fonts under one "Assets" heading, right after Clients.',
    ],
    screenshot: '0.42.3-assets.jpg',
  },
  {
    version: '0.42.2',
    date: '2026-10-25',
    items: [
      'LUTs: under the preview, the photo credit no longer sits on top of the Interior button; when it does not fit next to Person, Street and Interior it moves to its own line.',
    ],
  },
  {
    version: '0.42.1',
    date: '2026-10-25',
    items: [
      'Fonts: when a note has a word with an @ that isn\'t a font (like @Falcon), the bar on the Fonts page now has a "Not a font" button next to "Import fonts". Press it and that word goes away, the bar shows the next one if there is one, and later rounds of the same job won\'t bring it back.',
    ],
  },
  {
    version: '0.42.0',
    date: '2026-10-25',
    items: [
      'In a note, type @ and pick a font, like @Heebo Bold. The edit uses it, and Review shows it first.',
    ],
  },
  {
    version: '0.41.10',
    date: '2026-10-25',
    items: [
      'Fonts: in Review\'s live preview a font you name in a note no longer makes the video\'s own Hebrew words heavier (only the English letters take it); the missing-font bar on the Fonts page now says the edit "is using" the closest font while it is still running (and "used" once it has finished); and a note that names a font you don\'t have now says under the note that the edit will use the closest one. All of this shows once fonts in notes is on.',
    ],
  },
  {
    version: '0.41.9',
    date: '2026-10-25',
    items: [
      "On the Fonts page the search box no longer sticks out over the preview's edge at a 1280 px window (it shrinks to fit next to the tabs), and when the window is under about 1000 px the preview pane gets narrower (down to 320 px) instead of squeezing the list, so the tabs always stay fully visible.",
    ],
  },
  {
    version: '0.41.8',
    date: '2026-10-25',
    items: [
      'On a narrower window (around 1024 px) the Fonts list showed no font names at all. Now the names always show, and the less important columns (when it was added, weights, then the script) step out of the way when the list gets narrow, with the search moving under the tabs. Wider windows look exactly the same.',
    ],
  },
  {
    version: '0.41.7',
    date: '2026-10-25',
    items: [
      'Behind the scenes: when a note names a font (@Heebo Bold), Review now shows it live on the captions and titles of the video, with a Previewing pill and a Compare button that shows the original while you hold it; nothing changes on screen until the fonts-in-notes switch is on.',
    ],
  },
  {
    version: '0.41.6',
    date: '2026-10-25',
    items: [
      "Behind the scenes: the note you can write on a job before the edit (Add note…) can now point at a font with @ like the review notes box does, and a font you name in a job's note shows as a chip in the job sheet and in the note's hover on the Jobs page; nothing changes on screen until the fonts-in-notes switch is on.",
    ],
  },
  {
    version: '0.41.5',
    date: '2026-10-25',
    items: [
      'Behind the scenes: a font you name in a note (@Heebo Bold) now shows as a chip under the box with a card on hover and an ×, and a sent note says which text the next edit sets in it; nothing changes on screen until the fonts-in-notes switch is on.',
    ],
  },
  {
    version: '0.41.4',
    date: '2026-10-25',
    items: [
      'Behind the scenes: an open Fonts page now drops the "a note asked for a font you don\'t have" bar, and shows the new face, when you copy only an italic of a weight a font already had into the Fonts folder in Finder.',
    ],
  },
  {
    version: '0.41.3',
    date: '2026-10-25',
    items: [
      'Behind the scenes: a font you copy into the Fonts folder in Finder now clears the "a note asked for a font you don\'t have" bar, the same way importing it on the Fonts page does.',
    ],
  },
  {
    version: '0.41.2',
    date: '2026-10-25',
    items: [
      "Behind the scenes: typing @ in Review's note box can now offer your fonts, set in their own letters with a Hebrew and English sample; nothing changes on screen until the fonts-in-notes switch is on.",
    ],
  },
  {
    version: '0.41.1',
    date: '2026-10-25',
    items: [
      "Behind the scenes: when a note asks for a font you don't have (for example @Gotham Bold), the edit now carries on with the closest font and says which one, and the Fonts page shows a bar with the job and the font until you import it; it stays off until the notes switch is turned on.",
    ],
  },
  {
    version: '0.41.0',
    date: '2026-10-25',
    items: ['New Fonts page: see every font in English and Hebrew, and import your own.'],
  },
  {
    version: '0.40.22',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the checks no longer leave thousands of temporary folders (several GB) on the disk, and the engine tests run faster.',
    ],
  },
  {
    version: '0.40.21',
    date: '2026-10-25',
    items: [
      'Behind the scenes: a Fonts test that failed now and then when the computer was busy no longer does, so the checks are steadier (nothing changes in the app).',
    ],
  },
  {
    version: '0.40.20',
    date: '2026-10-25',
    items: [
      'The LUTs, Fonts and Graphics pages no longer scroll a few pixels past the window when there is nothing to scroll to.',
    ],
  },
  {
    version: '0.40.19',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the Fonts page now has a test seed and a browser test that walks the whole page (list, tabs, preview, import, delete, offline). Its offline bar sits under the header like on the other pages, and the preview pane stays in view while the list scrolls. Still hidden behind the Fonts switch.',
    ],
  },
  {
    version: '0.40.18',
    date: '2026-10-25',
    items: [
      "Behind the scenes: in Review, when a note names a LUT and the video is paused, the player now shows that frame with the look applied (with a Compare button), and the @ picker previews LUTs on the video's own frame (switched on later).",
    ],
  },
  {
    version: '0.40.17',
    date: '2026-10-25',
    items: [
      'Behind the scenes: after each edit the engine now reads which of your fonts the video really uses (and once, which ones your finished jobs used), so the Used in numbers on the Fonts page will be real once the page is switched on; nothing changes on screen yet.',
    ],
  },
  {
    version: '0.40.16',
    date: '2026-10-25',
    items: [
      'Editors no longer receive prices or pay dates from the engine at all, and a video you have been paid for just shows as Delivered on their side.',
    ],
  },
  {
    version: '0.40.15',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the note you write for the editor now offers your LUTs and graphics when you type @, shows them as chips, and the job sheet shows them in your note (switched on later).',
    ],
  },
  {
    version: '0.40.14',
    date: '2026-10-25',
    items: [
      "Behind the scenes: the engine can now take in fonts you drop or pick, single files or a whole folder: it reads each file, groups them by family, says which are new, add weights, are already here or can't be imported, and copies the ones you choose into your fonts folder without ever replacing a file. Hidden behind the Fonts switch.",
    ],
  },
  {
    version: '0.40.13',
    date: '2026-10-25',
    items: [
      'Behind the scenes: when a note names a font you have, for example @Heebo Black, the edit or revise run is now told exactly which font file to use and for what, and the use is counted; it stays off until the notes switch is turned on.',
    ],
  },
  {
    version: '0.40.12',
    date: '2026-10-25',
    items: [
      'Deleting a client folder now also removes the editors who were assigned to it, so a new client with the same name no longer shows up for the earlier editor.',
    ],
  },
  {
    version: '0.40.11',
    date: '2026-10-25',
    items: [
      'New client names with hidden characters or double spaces are now refused with a plain message, so nobody can create a client that looks identical to another.',
    ],
  },
  {
    version: '0.40.10',
    date: '2026-10-25',
    items: [
      'Behind the scenes: a job shot in camera log with no matching camera LUT now says "Waiting for a camera LUT", the LUTs page offers to import it, and after the import you can resume it (still switched off).',
    ],
  },
  {
    version: '0.40.9',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the engine can now move a whole font family to the Trash and show its folder in Finder; nothing changes on screen yet.',
    ],
  },
  {
    version: '0.40.8',
    date: '2026-10-25',
    items: [
      "A new end-to-end check makes sure Yael and Amit can only see and open their own clients' videos, and that a person who isn't on the team can't get in.",
    ],
  },
  {
    version: '0.40.7',
    date: '2026-10-25',
    items: [
      "Behind the scenes: on the Fonts page the side pane's On a frame view now shows the Hebrew and English caption in the chosen font and weight over a test photo, and says when a font has no Hebrew; nothing shows until the Fonts switch is on.",
    ],
  },
  {
    version: '0.40.6',
    date: '2026-10-25',
    items: [
      'Behind the scenes: typing @ in a Review note now offers your LUTs and graphics with a preview, and a note that names one shows it as a chip (switched on later).',
    ],
  },
  {
    version: '0.40.5',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the engine now reads your _Fonts folder and keeps a live list of every font family, weight and file (40 families and 237 files today), serves the font files with the right caching and notices fonts you drop in; nothing changes on screen yet.',
    ],
  },
  {
    version: '0.40.4',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the Fonts page can now take in fonts (drop files or a folder, or use Import fonts, see which families are new, add weights or already exist, then import); it stays hidden until the Fonts switch is on and the server side is built.',
    ],
  },
  {
    version: '0.40.3',
    date: '2026-10-25',
    items: [
      "Behind the scenes: the Fonts page's side pane now shows a font in its real file, in English and Hebrew, with every weight, the facts and the name to write in a note; nothing shows until the Fonts switch is turned on.",
    ],
  },
  {
    version: '0.40.2',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the Fonts page now has its list (tabs with counts, search, right-click menu, delete confirm, empty and loading states), still hidden until the Fonts switch is turned on.',
    ],
  },
  {
    version: '0.40.1',
    date: '2026-10-25',
    items: [
      'Behind the scenes: a new end-to-end test checks the whole Versions flow (three cuts, go back to Cut 1, then Send notes makes Cut 4) and that an earlier cut plays with its own music.',
    ],
  },
  {
    version: '0.40.0',
    date: '2026-10-25',
    items: [
      'New LUTs page: see every look on a test frame with a before/after slider, and import your own .cube or .3dl files by dropping them anywhere on the page.',
    ],
    screenshot: 'luts.jpg',
  },
  {
    version: '0.39.2',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the Fonts page now has its empty shell, its place in the sidebar, two small usage tables and its server routes, all behind the Fonts switch, which is still off; nothing changes on screen yet.',
    ],
  },
  {
    version: '0.39.1',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the part that reads a font file and says what it is (name, weight, Hebrew or not) is ready and checked against all 237 of your fonts; nothing changes on screen yet.',
    ],
  },
  {
    version: '0.39.0',
    date: '2026-10-25',
    items: [
      'On your phone, the job sheet now has a Versions list: watch an earlier cut, and go back to it from a bottom sheet.',
    ],
    screenshot: '0.39.0-phone-versions.jpg',
  },
  {
    version: '0.38.1',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the code that finds a font you name in a note (@Heebo Bold, even inside Hebrew text) and works out which text it is for is built; nothing changes on screen yet.',
    ],
  },
  {
    version: '0.38.0',
    date: '2026-10-25',
    items: [
      'You can now watch any earlier cut of a video from the Versions list, and go back to it right from the player.',
    ],
    screenshot: '0.38.0-viewer.jpg',
  },
  {
    version: '0.37.2',
    date: '2026-10-25',
    items: [
      'Behind the scenes: a note that names a LUT (@luts/name) now reaches the colour grade: the engine copies the LUT into the job, counts the use and tells the editor to apply it at full strength (still switched off).',
    ],
  },
  {
    version: '0.37.1',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the groundwork for the Fonts page is in (shared names, limits and messages, two switches that are off, and a few small test fonts). Nothing changes on screen yet.',
    ],
  },
  {
    version: '0.37.0',
    date: '2026-10-25',
    items: [
      'The job sheet has a new Versions section that lists every cut of a video, and you can go back to an earlier cut while the video is in Review.',
      'The row menu has a new "Versions…" entry that opens the job sheet right at that section.',
    ],
    screenshot: '0.37.0-versions.jpg',
  },
  {
    version: '0.36.1',
    date: '2026-10-25',
    items: [
      "Editors can look at and go back to the earlier versions of their own clients' videos, and nobody else's.",
    ],
  },
  {
    version: '0.36.0',
    date: '2026-10-25',
    items: [
      "New Team page in the sidebar: add Yael and Amit, then right-click a client › Assign to… (also on the phone's client page) to choose who sees it. The Clients list shows who each client is assigned to.",
    ],
  },
  {
    version: '0.35.21',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the built-in LUTs and their before/after test photos now work (all 19 looks, including Cinematic), still hidden until the LUTs page is switched on.',
    ],
  },
  {
    version: '0.35.20',
    date: '2026-10-25',
    items: [
      'Behind the scenes: importing and managing your own LUTs now works on the engine side (checking .cube and .3dl files, converting .3dl, importing, renaming, duplicating and deleting), still hidden until the page is switched on.',
    ],
  },
  {
    version: '0.35.19',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the code that reads @luts/name and @graphics/name in a note is built (not used yet), so notes can soon name a LUT or a graphic.',
    ],
  },
  {
    version: '0.35.18',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the LUTs import dialog and the drop-anywhere overlay are built (hidden for now), so importing .cube and .3dl files is ready to be wired into the page.',
    ],
  },
  {
    version: '0.35.17',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the LUTs page now has its list, with tabs, search, a right-click menu, rename and delete (still hidden for now).',
    ],
  },
  {
    version: '0.35.16',
    date: '2026-10-25',
    items: [
      "Behind the scenes: the LUTs page now has its preview side, a before/after slider on three test frames with the LUT's details, still hidden for now.",
    ],
  },
  {
    version: '0.35.15',
    date: '2026-10-25',
    items: [
      'The engine can now put an earlier cut of a video in Review back as the live preview, with its music and edit notes, without losing the other saved cuts.',
    ],
  },
  {
    version: '0.35.14',
    date: '2026-10-25',
    items: [
      "Editors now see a trimmed-down app: no Money, Analytics, Graphics or LUTs pages, no Mark delivered, Mark paid, Delete or Show in Finder buttons, a Jobs and Clients tab bar on the phone, and their name and role in the sidebar and in the phone's Settings.",
    ],
  },
  {
    version: '0.35.13',
    date: '2026-10-25',
    items: [
      "Editors now see only their own clients' videos, live updates and phone notifications, and each person's phone registers under their own login.",
    ],
  },
  {
    version: '0.35.12',
    date: '2026-10-25',
    items: [
      'Behind the scenes: the groundwork for a LUTs page is in (hidden for now), so the list, the preview and the import can be built side by side.',
    ],
  },
  {
    version: '0.35.11',
    date: '2026-10-25',
    items: [
      "An editor can now only open, change or download the videos, clients and series assigned to them; anything of another client looks like it doesn't exist, and money, analytics, graphics, Mark delivered, Mark paid and Finder actions stay yours alone.",
    ],
  },
  {
    version: '0.35.10',
    date: '2026-10-25',
    items: [
      "The engine can now manage your team: add or remove editors and choose which clients each one sees. Only you can do it, and an editor's new clients are assigned to them automatically.",
    ],
  },
  {
    version: '0.35.9',
    date: '2026-10-25',
    items: [
      'The engine now knows who is opening it: you are the admin, and Yael and Amit can be added to a team file with their own login, with anything an editor creates assigned to them.',
    ],
  },
  {
    version: '0.35.8',
    date: '2026-10-25',
    items: [
      'Every time a cut reaches Review, the engine now quietly keeps a copy of it (the last 10 per video), so earlier versions will be there to go back to.',
    ],
  },
  {
    version: '0.35.7',
    date: '2026-10-24',
    items: [
      "The phone opens the app again when Studio Engine runs in the background on the Mac: it was refusing the phone because it could not ask Tailscale for the Mac's name.",
    ],
  },
  {
    version: '0.35.6',
    date: '2026-10-24',
    items: [
      'On the phone, "Download MP4" is now "Share" everywhere: on finished and paid videos, and on the preview in Review.',
    ],
    screenshot: '0.35.6-share.jpg',
  },
  {
    version: '0.35.5',
    date: '2026-10-24',
    items: [
      'The phone app no longer gets stuck on a dark screen: it shows what went wrong with a Reload button, or "Connecting…", and recovers on its own when you come back to it.',
    ],
    screenshot: '0.35.5-connecting.jpg',
  },
  {
    version: '0.35.4',
    date: '2026-10-24',
    items: [
      'A phone app left open across an update now fails cleanly instead of showing a blank screen.',
    ],
  },
  {
    version: '0.35.3',
    date: '2026-10-24',
    items: [
      'If the app can\'t finish opening (a weak connection on the phone), it now says "Couldn\'t load Studio Engine" with a Try again button after a few seconds, instead of staying on a black screen.',
    ],
  },
  {
    version: '0.35.2',
    date: '2026-10-24',
    items: [
      'On the phone, the Jobs list no longer hides its first client behind the top bar, and the big gap under the clock is gone; Clients, a client and Style are fixed the same way.',
      'The tab bar now sits at the very bottom of the screen, with no empty strip under it.',
    ],
  },
  {
    version: '0.35.1',
    date: '2026-10-24',
    items: [
      'On the phone, the top bar and the tab bar at the bottom no longer move: only the page between them scrolls, and the screen no longer bounces, so it feels like an app.',
    ],
  },
  {
    version: '0.35.0',
    date: '2026-10-24',
    items: [
      'Analytics now splits Claude use into your two budgets: a gauge for the $200 of API credits, with how fast you are spending them and when they run out, and a gauge for the Max plan’s weekly limit.',
      'Under the gauges, what used each budget is listed biggest first, and the small items fold into one row you can open.',
      'The plan gauge stays current: opening Analytics checks the plan’s limit with a tiny run when the last reading is over 10 minutes old.',
    ],
    screenshot: '0.35.0-two-budgets.jpg',
  },
  {
    version: '0.34.1',
    date: '2026-10-24',
    items: [
      'On the phone, a short Hebrew job name is no longer split in the middle of the word in the Jobs list.',
    ],
  },
  {
    version: '0.34.0',
    date: '2026-10-24',
    items: [
      'A job’s sheet and its row menu now have View preview, which plays the job’s preview video without opening Review.',
      'In a job’s sheet, the next step has its own full-width row, and View preview and Download MP4 sit side by side under it, so nothing runs off the edge.',
    ],
    screenshot: '0.34.0-view-preview.jpg',
  },
  {
    version: '0.33.2',
    date: '2026-10-24',
    items: [
      'On the phone, a job’s sheet now shows the Review button first, right under the progress bar, so you no longer scroll past the notes to find it.',
      'On the phone, long job names, client names and the line under each job now wrap instead of being cut off with “…”.',
    ],
  },
  {
    version: '0.33.1',
    date: '2026-10-24',
    items: [
      'You can ask for a cinematic look in your notes: the video gets more contrast and warm highlights on top of the matched grade.',
    ],
  },
  {
    version: '0.33.0',
    date: '2026-10-24',
    items: [
      'Your videos now get an automatic color grade: every clip is matched to one shared look, so shots from different cameras sit together and stay natural.',
      'iPhone HDR clips and portrait clips are handled before the grade, so colors and orientation come out right.',
    ],
  },
  {
    version: '0.32.0',
    date: '2026-10-23',
    items: [
      'Review has an Export MP4 button: it renders the full-quality video right away, before you approve, and then you can save it.',
      'If you approve after exporting, the video that was already rendered is used, so nothing is rendered twice.',
    ],
  },
  {
    version: '0.31.1',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the phone Review’s tests now follow the preview video the phone plays, so the next change to it is caught.',
    ],
  },
  {
    version: '0.31.0',
    date: '2026-10-23',
    items: [
      'Every video job (edit, revise, render, brief, style, series, graphics) can now bill to your Claude API credits: put ANTHROPIC_API_KEY in the .env file and restart the engine; without it, jobs keep using your Claude login.',
    ],
  },
  {
    version: '0.30.2',
    date: '2026-10-23',
    items: [
      'Soundtrack, still switched off: tested end to end, including that Approve renders with the music you picked. On the phone the Music button is easier to hit, and in a vertical video’s review the job name keeps its room.',
    ],
  },
  {
    version: '0.30.1',
    date: '2026-10-22',
    items: [
      'On your phone, the ‹ Jobs link in Settings and the Back button sit where the design has them.',
    ],
  },
  {
    version: '0.30.0',
    date: '2026-10-22',
    items: [
      'On your phone: Clients and Money tabs, with each client’s videos and this month’s income, expenses and what’s not paid yet.',
    ],
  },
  {
    version: '0.29.6',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the app’s browser tests work again after jobs started waiting for you to start them.',
    ],
  },
  {
    version: '0.29.5',
    date: '2026-10-23',
    items: [
      'Soundtrack, still switched off: the editor now checks that the music’s drop lands where the cut needs it, tries once more when it misses, and sets the music louder where nobody is talking.',
    ],
  },
  {
    version: '0.29.4',
    date: '2026-10-23',
    items: [
      'Soundtrack, still switched off: behind the scenes it can now make real music with ElevenLabs, fitted to the cut, and pnpm doctor checks that your ElevenLabs key is allowed to make music.',
    ],
  },
  {
    version: '0.29.3',
    date: '2026-10-23',
    items: [
      'The small graph on each Analytics tile now turns green when the number got better and red when it got worse, matching the arrow under it.',
    ],
  },
  {
    version: '0.29.2',
    date: '2026-10-23',
    items: [
      'Soundtrack, still switched off: Review is ready with a Music button, on the Mac and the phone, to pick a version of the music, make another or turn it off. The Mac preview switches at the same moment; the phone plays the live edit with the new music until its small preview video is made again.',
    ],
  },
  {
    version: '0.29.1',
    date: '2026-10-23',
    items: [
      'The Analytics tiles now show a small arrow next to the change line: green up for better, red down for worse, a grey dash when nothing changed or there is nothing to compare yet.',
    ],
  },
  {
    version: '0.29.0',
    date: '2026-10-23',
    items: [
      'On the phone, Review now plays a small preview video instead of the live edit, so it no longer lags.',
      'A new Download button next to the music button saves that preview video to your phone.',
      'The preview video is made as soon as a job reaches Review; if it cannot be made, the phone shows the live preview as before.',
    ],
  },
  {
    version: '0.28.2',
    date: '2026-10-23',
    items: [
      'The re-runs per approved job graph on Analytics now sits below the Reviews graphs, not at the top of the page.',
    ],
    screenshot: '0.28.2-analytics-reruns-moved.jpg',
  },
  {
    version: '0.28.1',
    date: '2026-10-23',
    items: [
      'Soundtrack, still switched off: Make another and picking a version of a video’s music now work behind the scenes, and Approve and Send wait while a new version is being made.',
    ],
  },
  {
    version: '0.28.0',
    date: '2026-10-23',
    items: [
      'Analytics has a new graph at the top: the median number of re-runs per approved job, week by week (day by day in the Week view).',
    ],
    screenshot: '0.28.0-analytics-reruns.jpg',
  },
  {
    version: '0.27.3',
    date: '2026-10-23',
    items: [
      'Soundtrack, still switched off: the editor is ready to plan music from the cut, have ElevenLabs make it, and line the cuts up with its beats. The job shows “making the music” while it does.',
    ],
  },
  {
    version: '0.27.2',
    date: '2026-10-23',
    items: [
      'Soundtrack, still switched off: the job sheet is ready to show where a video’s music came from (made by ElevenLabs, which version, from your folder, or none and why), with the music’s story in History.',
    ],
  },
  {
    version: '0.27.1',
    date: '2026-10-23',
    items: [
      'Groundwork for Soundtrack, music made for your videos by ElevenLabs. It stays switched off until it’s ready, so nothing changes yet.',
    ],
  },
  {
    version: '0.27.0',
    date: '2026-10-23',
    items: [
      'You can now delete a video: right-click it and choose Delete…. It removes the video’s folder, its export and everything the app knows about it, the payment included, so the income leaves Money too. It asks first, and it can’t be undone.',
    ],
  },
  {
    version: '0.26.0',
    date: '2026-10-23',
    items: [
      'Jobs no longer start by themselves: a new job waits as Held until you press Start.',
      'Only clients you added with New client are picked up; a stray folder dropped in Studio Inbox is ignored.',
    ],
  },
  {
    version: '0.25.0',
    date: '2026-10-22',
    items: [
      'Money now works on your phone: a new Money tab shows the month’s income, expenses and profit, every video you delivered and whether it’s paid, and your subscriptions, with the same numbers as on the Mac.',
    ],
  },
  {
    version: '0.24.1',
    date: '2026-10-22',
    items: [
      'On your phone: episodes show their series, and a review note can change the whole series.',
    ],
  },
  {
    version: '0.24.0',
    date: '2026-10-22',
    items: [
      'Every edit can now use your graphics: a video gets one where its “When edits use it” line fits, or where your note names it, with its text filled from that video. A graphic’s page shows how many videos used it. Turn “Edits can use it” off on a graphic to keep it out of edits.',
    ],
    screenshot: '0.24.0-graphics-in-edits.jpg',
  },
  {
    version: '0.23.5',
    date: '2026-10-22',
    items: [
      'A graphic whose text box is left empty (say, a lower third with a name but no role) now hides that box by itself instead of showing an empty pill. Graphics you make from now on follow this.',
    ],
  },
  {
    version: '0.23.4',
    date: '2026-10-22',
    items: [
      'Behind the scenes: a client’s style or a series learned from a video that used a library graphic now names the graphic instead of keeping a frozen copy, so the next video uses its current version.',
    ],
  },
  {
    version: '0.23.3',
    date: '2026-10-22',
    items: [
      'Behind the scenes: edits will treat a graphic’s “When edits use it” line as your rule, and use the graphic even where the brief doesn’t ask (still switched off).',
    ],
  },
  {
    version: '0.23.2',
    date: '2026-10-22',
    items: [
      'Behind the scenes: edits can copy your Graphics library and be told how to use it, still switched off.',
    ],
  },
  {
    version: '0.23.1',
    date: '2026-10-22',
    items: [
      'Behind the scenes: Graphics can count the videos that used each graphic, for when edits start using them (still off).',
    ],
  },
  {
    version: '0.23.0',
    date: '2026-10-22',
    items: [
      'New Graphics page: ask for a graphic in a chat, watch it play, and change it by chatting. Find it in the sidebar under Clients. Every reply is a new version, and you can go back to any of them.',
    ],
    screenshot: '0.23.0-graphics.jpg',
  },
  {
    version: '0.22.2',
    date: '2026-10-22',
    items: [
      'On your phone, the Review player shows the video’s first frame instead of a black screen until you tap Play.',
    ],
  },
  {
    version: '0.22.1',
    date: '2026-10-22',
    items: [
      'On your phone, a finished video’s sheet shows a short Details list (when it was approved or delivered, the price, whether it is paid, the file), and no History.',
    ],
  },
  {
    version: '0.22.0',
    date: '2026-10-22',
    items: [
      'On your phone: a tab bar at the bottom with Jobs (and a badge for what needs you) and Clients; open a client to see its jobs and its style.',
    ],
  },
  {
    version: '0.21.0',
    date: '2026-10-22',
    items: [
      'On your phone: share a finished video straight to WhatsApp, mark it delivered, and mark payments, with Undo.',
    ],
  },
  {
    version: '0.20.0',
    date: '2026-10-22',
    items: [
      'Review on your phone: watch the edit full screen, write or record notes, and approve or send them, from anywhere.',
    ],
  },
  {
    version: '0.19.2',
    date: '2026-10-22',
    items: [
      'Behind the scenes: Graphics has sample data, an end-to-end test and a design pass; still switched off.',
    ],
  },
  {
    version: '0.19.1',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the Claude run that makes and changes a graphic, still switched off.',
    ],
  },
  {
    version: '0.19.0',
    date: '2026-10-22',
    items: [
      'Notifications on your phone: hear when an edit is ready to review, when a job fails and when a video is ready to send. Pick which ones in Settings.',
    ],
  },
  {
    version: '0.18.12',
    date: '2026-10-22',
    items: [
      'On your phone, Write and Record work in Review: type a note right above the keyboard, or record a voice note pinned where you paused; it is transcribed for you.',
    ],
  },
  {
    version: '0.18.11',
    date: '2026-10-22',
    items: [
      'On your phone, Mark paid opens as a bottom sheet, and messages pop up at the bottom of the screen with an Undo button.',
    ],
  },
  {
    version: '0.18.10',
    date: '2026-10-22',
    items: [
      'On the iPhone, the Review player plays again: tapping Play starts the video instead of leaving a black screen.',
    ],
  },
  {
    version: '0.18.9',
    date: '2026-10-22',
    items: [
      'Analytics remembers Week or Month: it stays on your last choice when you go to another page and come back, or reload.',
    ],
  },
  {
    version: '0.18.8',
    date: '2026-10-22',
    items: ["The version pill in What's new is now evenly spaced left to right."],
  },
  {
    version: '0.18.7',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the version that brought in the Graphics engine changes listed under 0.18.6.',
    ],
  },
  {
    version: '0.18.6',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the Graphics engine can now make, change, copy and delete graphics, still switched off.',
    ],
  },
  {
    version: '0.18.5',
    date: '2026-10-22',
    items: ['The browser tab now shows the Studio Engine icon.'],
  },
  {
    version: '0.18.4',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the Graphics page can now play a graphic on a loop at any size, still switched off.',
    ],
  },
  {
    version: '0.18.3',
    date: '2026-10-22',
    items: [
      'Behind the scenes: a Graphics page for one graphic, with its chat, its text and details, still switched off.',
    ],
  },
  {
    version: '0.18.2',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the Graphics list page (rename, duplicate, delete from its right-click menu), still switched off.',
    ],
  },
  {
    version: '0.18.1',
    date: '2026-10-22',
    items: [
      'On your phone, drag any bottom sheet down from anywhere on it to close it, not only by its handle. A long press no longer selects text.',
    ],
  },
  {
    version: '0.18.0',
    date: '2026-10-22',
    items: [
      'Analytics has a Week / Month switch at the top right. Month is the page you know.',
      'Week compares the last 7 days with the 7 before, and the charts go day by day for the last 14 days; Busiest week becomes Busiest day.',
    ],
    screenshot: '0.18.0-analytics-week.jpg',
  },
  {
    version: '0.17.5',
    date: '2026-10-22',
    items: ['Behind the scenes: groundwork for a Graphics page, switched off for now.'],
  },
  {
    version: '0.17.4',
    date: '2026-10-22',
    items: [
      'Notifications on your phone: in the Home Screen app, turn them on once, pick which events notify you in Settings, and see how many jobs need you on the app icon. Tapping “Ready to review” opens the review.',
    ],
  },
  {
    version: '0.17.3',
    date: '2026-10-22',
    items: [
      'On your phone, Share video sends a finished video straight to WhatsApp from the iPhone share sheet, then asks “Sent it to the client?” so you can mark it delivered in one tap.',
    ],
  },
  {
    version: '0.17.2',
    date: '2026-10-22',
    items: [
      'On your phone, a video in Review now opens full screen: watch the live preview, scrub it with your finger, see your notes on the timeline, and Approve or Send them with an Effort level. Writing and recording notes on the phone come next.',
    ],
  },
  {
    version: '0.17.1',
    date: '2026-10-22',
    items: [
      "The job sheet shows every step a job went through, even ones the editor didn't time, and when each review round was ready.",
    ],
  },
  {
    version: '0.17.0',
    date: '2026-10-22',
    items: [
      'Studio Engine on your phone: open it from anywhere over Tailscale and add it to your Home Screen. Your jobs are grouped under each client, a tap opens a job’s sheet with its next step, and Settings, What’s new and a “Can’t reach your Mac” screen are there too.',
    ],
    screenshot: '0.17.0-phone.jpg',
  },
  {
    version: '0.16.1',
    date: '2026-10-22',
    items: ["A finished job's steps now show the first cut and every review round, in order."],
  },
  {
    version: '0.16.0',
    date: '2026-10-22',
    items: [
      'New: click a job to see everything about it: its steps, notes, files and history, with the next step one click away.',
    ],
    screenshot: '0.16.0-job-sheet.jpg',
  },
  {
    version: '0.15.0',
    date: '2026-10-22',
    items: [
      'New: Analytics in the sidebar. Five numbers up top: jobs finished, clients, files in to ready, editing time and approved first time.',
      'A typical job, step by step, shows where the time goes and marks the slowest step, so you can see the bottlenecks.',
      'Reviews: how often you approve first time each week, and what your review notes are about, grouped into topics with who got them.',
      'Claude use: your busiest week against the limit, the API value of each finished minute of video, and where your Claude use went each week.',
    ],
    screenshot: '0.15.0-analytics.jpg',
  },
  {
    version: '0.14.3',
    date: '2026-10-22',
    items: [
      'Behind the scenes: tap a job on your phone and its sheet rises from the bottom: the next step is one big button, the menu is a list, and Effort opens right inside it. It shows once the phone layout is switched on.',
    ],
  },
  {
    version: '0.14.2',
    date: '2026-10-22',
    items: [
      'Behind the scenes: your jobs on the phone are ready: a list with status tabs, search, jobs grouped under each client, and a View sheet for By client and Show archived. It shows once the phone layout is switched on.',
    ],
  },
  {
    version: '0.14.1',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the engine can now send notifications to your phone: when an edit is ready to review, when a job fails, when a video is approved and ready to send, and, if you want, when the queue is empty. Turning them on, on the phone, comes next.',
    ],
  },
  {
    version: '0.14.0',
    date: '2026-10-22',
    items: [
      'Series: start a series from an approved video, and new folders named after it come out in the same design with only the clips and words changed.',
    ],
  },
  {
    version: '0.13.39',
    date: '2026-10-22',
    items: [
      'Behind the scenes: when you approve an episode that had notes marked Series, it becomes the series’ new format, with the exact timings its fixes settled on. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.38',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the phone version now has its Settings page, What’s new that slides up from the bottom, and a clear “Can’t reach your Mac” message. They show once the phone layout is switched on.',
    ],
  },
  {
    version: '0.13.37',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the Analytics page can now show the API value of each finished minute of video, and where your Claude use went each week. It stays switched off for now.',
    ],
  },
  {
    version: '0.13.36',
    date: '2026-10-22',
    items: [
      'Add Studio Engine to your iPhone’s Home Screen: it opens like an app, dark from the first moment, with its own icon. The card that walks you through it comes with the phone layout.',
    ],
  },
  {
    version: '0.13.35',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the Analytics page can now show jobs finished, clients, files-in-to-ready, editing time and approved first time, plus deliveries per day and footage per week. It stays switched off for now.',
    ],
  },
  {
    version: '0.13.34',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the version you are developing can now be opened on your phone through Tailscale too.',
    ],
  },
  {
    version: '0.13.33',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the Analytics page can now show a typical job step by step, with the slowest step marked. It stays switched off for now.',
    ],
  },
  {
    version: '0.13.32',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the engine now keeps a log of how much of your Claude limits each run leaves, so Analytics can show your busiest week. Analytics stays switched off for now.',
    ],
  },
  {
    version: '0.13.31',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the Analytics page can now show how often you approve a video first time, week by week, and what your review notes are about. It stays switched off for now.',
    ],
  },
  {
    version: '0.13.30',
    date: '2026-10-22',
    items: [
      'Behind the scenes: once Analytics is switched on, your review notes are grouped into short topics in the background. It stays switched off for now.',
    ],
  },
  {
    version: '0.13.29',
    date: '2026-10-22',
    items: [
      'Behind the scenes: an episode’s brief now says it is rebuilt from its series instead of following defaults. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.28',
    date: '2026-10-22',
    items: [
      'An edit now reads only its own folder, so one job can no longer pick up another job’s or another show’s look.',
    ],
  },
  {
    version: '0.13.27',
    date: '2026-10-22',
    items: [
      'Behind the scenes: starting a series no longer wipes the client’s own reusable graphics, and waits for the style to finish instead of refusing. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.26',
    date: '2026-10-22',
    items: [
      'Behind the scenes: a series’ description no longer contradicts itself about captions. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.25',
    date: '2026-10-22',
    items: [
      'Behind the scenes: a review note marked Series is now worded for that series, never for the client’s whole style. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.24',
    date: '2026-10-22',
    items: [
      'Behind the scenes: a series now keeps its own music and sound effects, so an episode no longer needs the first episode’s folder. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.23',
    date: '2026-10-22',
    items: [
      'Behind the scenes: Studio Engine is ready to be opened from your phone over Tailscale. Only your own devices and login get in, and live updates come back by themselves when the phone wakes the app. pnpm run doctor shows whether it is turned on.',
    ],
  },
  {
    version: '0.13.22',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the first pieces of the phone version are in place and switched off, so nothing looks different yet.',
    ],
  },
  {
    version: '0.13.21',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the start of the Analytics page, with the engine side and an empty page. It stays switched off for now.',
    ],
  },
  {
    version: '0.13.20',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the job sheet itself, which opens from a job row with its address, keys and menu. It stays switched off for now.',
    ],
  },
  {
    version: '0.13.19',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the job sheet now reads the review notes you already sent, so its notes and history can show them. The job sheet stays switched off for now.',
    ],
  },
  {
    version: '0.13.18',
    date: '2026-10-22',
    items: [
      "Behind the scenes: the engine can now list a job's step times and the review notes you sent, and show a job in Finder, ready for the job sheet.",
    ],
  },
  {
    version: '0.13.17',
    date: '2026-10-22',
    items: [
      "Behind the scenes: the job sheet's Now part, with where the job is, the error and the next-step button. The job sheet stays switched off for now.",
    ],
  },
  {
    version: '0.13.16',
    date: '2026-10-22',
    items: [
      "Behind the scenes: the job sheet's Steps part, with each step's time and length. The job sheet stays switched off for now.",
    ],
  },
  {
    version: '0.13.15',
    date: '2026-10-22',
    items: [
      "Behind the scenes: the job sheet's Details and History parts. The job sheet stays switched off for now.",
    ],
  },
  {
    version: '0.13.14',
    date: '2026-10-22',
    items: [
      "Behind the scenes: the job sheet's Notes part, with your note for the editor, the effort and the review notes you sent. The job sheet stays switched off for now.",
    ],
  },
  {
    version: '0.13.13',
    date: '2026-10-22',
    items: [
      'Behind the scenes: an automatic test now walks a whole series, from starting it to an episode and its notes. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.12',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the series screens now match their design. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.11',
    date: '2026-10-22',
    items: [
      'Behind the scenes: groundwork for the job sheet, a panel that shows everything about a job when you click it. It stays switched off for now.',
    ],
  },
  {
    version: '0.13.10',
    date: '2026-10-22',
    items: [
      'Behind the scenes: every Claude run now records what it was for (edit, design, development…) and what it did, so the Analytics page can show where your usage went. Nothing changes on screen yet.',
    ],
  },
  {
    version: '0.13.9',
    date: '2026-10-22',
    items: [
      'Behind the scenes: a review note on an episode can be marked Series, next to Style. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.8',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the design-check tool can now show the series screens with sample episodes. Nothing changes in the app.',
    ],
  },
  {
    version: '0.13.7',
    date: '2026-10-22',
    items: [
      'The list of shared fonts each edit reads is now a third of the length, one font family to a line, and it says that fonts in an “English only” folder have no Hebrew letters.',
    ],
  },
  {
    version: '0.13.6',
    date: '2026-10-22',
    items: [
      'Behind the scenes: a client’s page can now list its series, and each series has its own page with its episodes and its format. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.5',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the Jobs list can now mark a series’ episodes and has the right-click items and windows to start a series or change its format. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.4',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the engine can now learn a series’ format from an approved episode, change it later, and undo starting one. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.3',
    date: '2026-10-22',
    items: [
      'Behind the scenes: a review note on an episode will be able to change the whole series when you send it. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.2',
    date: '2026-10-22',
    items: [
      'Behind the scenes: a new folder named after a series plus a number, like “Myth or fact 6”, will join that series by itself. Series stay switched off for now.',
    ],
  },
  {
    version: '0.13.1',
    date: '2026-10-22',
    items: [
      'Jobs: a delivered video whose folder you deleted now stays on the Jobs page, muted and marked "Folder deleted", until it is paid. Mark it paid from there, or take it back with Not delivered yet.',
    ],
  },
  {
    version: '0.13.0',
    date: '2026-10-22',
    items: [
      'Every release that changes how the app looks now shows a screenshot of the change right here in What’s new, under its notes.',
    ],
    screenshot: '0.13.0-whats-new.jpg',
  },
  {
    version: '0.12.13',
    date: '2026-10-22',
    items: [
      'Click a client’s name in the Jobs list or in the Money ledger to open that client’s page.',
    ],
  },
  {
    version: '0.12.12',
    date: '2026-10-22',
    items: [
      'A video you haven’t chosen an effort for now runs at Extra high. The choices are Medium, High and Extra high; Low and Max are gone, and a video that had one of them moved to the nearest level.',
    ],
  },
  {
    version: '0.12.11',
    date: '2026-10-22',
    items: [
      'Money: if money.json has a mistake, the Money page now says so in one line under the title, with what is wrong and how to check it (pnpm run doctor).',
    ],
  },
  {
    version: '0.12.10',
    date: '2026-10-22',
    items: [
      'Behind the scenes: an episode of a series will be rebuilt from the series’ own design, with only its clips and words changed. Series stay switched off for now, so nothing changes yet.',
    ],
  },
  {
    version: '0.12.9',
    date: '2026-10-22',
    items: [
      'Money: an archived video no longer counts as “not paid yet”. It still counts as income, and its Paid column says “Archived”.',
    ],
  },
  {
    version: '0.12.8',
    date: '2026-10-22',
    items: [
      'Messages no longer have a little × in the corner: they are just the text and Undo, and they go away on their own.',
    ],
  },
  {
    version: '0.12.7',
    date: '2026-10-22',
    items: [
      'Behind the scenes: the app can now ask the engine about series and hear when one changes. Series stay switched off for now, so nothing changes on screen.',
    ],
  },
  {
    version: '0.12.6',
    date: '2026-10-22',
    items: [
      'Money: in Expenses, every amount and the total under it show agorot (₪899.90 instead of ₪900), so the rows always add up to the total.',
    ],
  },
  {
    version: '0.12.5',
    date: '2026-10-22',
    items: [
      'Money: if money.json has a mistake, Studio Engine keeps your last good prices and expenses even after a restart, and Mark delivered waits until the file is fixed instead of charging the old ₪200 default.',
    ],
  },
  {
    version: '0.12.4',
    date: '2026-10-21',
    items: [
      'The View menu on Jobs now opens right under its button, and the button no longer keeps a ring after you click it.',
      'The archive messages fit on one line, and Undo fades in gently when you point at it.',
    ],
  },
  {
    version: '0.12.3',
    date: '2026-10-21',
    items: [
      'Archived videos are no longer suggested for payment: Mark paid leaves them out, and an archived video has no Mark paid step. Archived means paid already or not needed.',
    ],
  },
  {
    version: '0.12.2',
    date: '2026-10-21',
    items: [
      'Mark paid also lists archived videos the client hasn’t paid for, with “archived” after the name.',
    ],
  },
  {
    version: '0.12.1',
    date: '2026-10-21',
    items: [
      'Jobs and Money: small fixes so delivering and getting paid match the design. The Delivered and Paid messages now fit on one line.',
    ],
  },
  {
    version: '0.12.0',
    date: '2026-10-21',
    items: [
      'Jobs: right-click a video › Archive to put it away. It still counts on Money and in the client’s jobs.',
      'View › Show archived brings archived videos back into the lists, faded with a small box. A search tells you when archived videos match too.',
    ],
  },
  {
    version: '0.11.3',
    date: '2026-10-21',
    items: [
      'Jobs: Mark paid on a delivered video lets you tick every video one payment covers and the day it came in. The message has Undo.',
    ],
  },
  {
    version: '0.11.2',
    date: '2026-10-21',
    items: [
      'Behind the scenes: videos can now be archived, so a finished video can leave the lists and still count on Money. The buttons come in the next version.',
    ],
  },
  {
    version: '0.11.1',
    date: '2026-10-21',
    items: [
      'Behind the scenes: the groundwork for series, where every episode of a show keeps the same design and only the clips and words change. Nothing changes on screen yet.',
    ],
  },
  {
    version: '0.11.0',
    date: '2026-10-21',
    items: [
      'You can now change a video’s effort while you review it, then send your notes: the fixes run at the level you chose. In the review window, the Effort button sits next to Send, and the right-click menu has it too.',
    ],
  },
  {
    version: '0.10.0',
    date: '2026-10-21',
    items: [
      'Shared fonts: put font files in the _Fonts folder in your Studio Inbox, and every client’s videos can use them. Name a font in a client’s style or note to have it used.',
    ],
  },
  {
    version: '0.9.0',
    date: '2026-10-21',
    items: [
      'Jobs: Ready is now Approved. When you have sent a video, click the send icon on its row to mark it delivered; it then counts as income on the Money page.',
      'Jobs: new Delivered and Paid tabs. A delivered video shows when it was delivered and that it is not paid yet; right-click a row to undo either step.',
    ],
  },
  {
    version: '0.8.1',
    date: '2026-10-21',
    items: ['Behind the scenes: test runs no longer leave stray processes running on your Mac.'],
  },
  {
    version: '0.8.0',
    date: '2026-10-21',
    items: [
      'You can now choose how hard the editor works on a video before it runs. Right-click a video that is waiting, pick Effort, then a level from Low to Max. Default is how videos run now.',
      'A video with an effort level shows a small gauge by its name, and its needle moves from Low on the left to Max on the right.',
    ],
  },
  {
    version: '0.7.13',
    date: '2026-10-21',
    items: ['Replacing a client’s style now also clears its old graphics; Undo brings both back.'],
  },
  {
    version: '0.7.12',
    date: '2026-10-21',
    items: ['A reference video you add to a client’s style now shapes the style.'],
  },
  {
    version: '0.7.11',
    date: '2026-10-21',
    items: ['A new client’s first video no longer looks for saved graphics that don’t exist yet.'],
  },
  {
    version: '0.7.10',
    date: '2026-10-21',
    items: [
      'Money: see which delivered videos are paid, and how much is still owed this month: a Paid column in the Ledger, and a "not paid yet" line under Income and in the month summary.',
    ],
  },
  {
    version: '0.7.9',
    date: '2026-10-21',
    items: [
      'Behind the scenes: Studio Engine can now record when a video is delivered and paid. The buttons on the Jobs page come next.',
    ],
  },
  {
    version: '0.7.8',
    date: '2026-10-21',
    items: [
      'Edits, and the rounds of changes after your review notes, are back to Claude Code’s normal effort level, so they take as long as they did before the highest-effort change.',
    ],
  },
  {
    version: '0.7.7',
    date: '2026-10-21',
    items: [
      'Money: a video now counts as income when you mark it delivered, not when its export finishes. Your 3 videos from today are back to Approved; the Mark delivered button on the Jobs page comes next.',
    ],
  },
  {
    version: '0.7.6',
    date: '2026-10-21',
    items: [
      'Money: small layout fixes so the page matches its design. Every table now says "Showing 1–10 of 26" under it, and By client opens the first client for you.',
    ],
  },
  {
    version: '0.7.5',
    date: '2026-10-21',
    items: [
      'The Jobs page is now a quiet list: one line per job, with a status icon, its details and time on the right, and the next step at the end. Column headers and the Columns menu are gone.',
    ],
  },
  {
    version: '0.7.4',
    date: '2026-10-21',
    items: [
      'Money: the Ledger lists every job you delivered this month with its income, expenses and profit, by job or by client. Open a job to see every detail and what an hour of your time earned, with a month summary that adds up to the banners.',
    ],
  },
  {
    version: '0.7.3',
    date: '2026-10-21',
    items: [
      'The doctor now fails, instead of just warning, when the HyperFrames tool is missing, because every edit and every Approve needs it while Review is on.',
    ],
  },
  {
    version: '0.7.2',
    date: '2026-10-21',
    items: [
      'Money: Expenses lists every subscription and charge you paid this month, by item or by date. Open an item to see each of its charges.',
    ],
  },
  {
    version: '0.7.1',
    date: '2026-10-21',
    items: ['Tooltips no longer pop up by themselves after a dialog closes.'],
  },
  {
    version: '0.7.0',
    date: '2026-10-21',
    items: [
      'Review every edit before it’s rendered: open a finished edit with the Review button, watch it in the app, leave typed or voice notes, and approve to render and export the final video.',
    ],
  },
  {
    version: '0.6.0',
    date: '2026-10-21',
    items: [
      'New Money page in the sidebar: this month’s income, expenses and profit, each compared with last month and coloured green or red by whether it got better.',
      'Pick any month at the top. Every job’s numbers and the list of everything you pay come next.',
    ],
  },
  {
    version: '0.5.11',
    date: '2026-10-21',
    items: [
      'Undo right after Use this look now always works, even while the new style is still being written.',
    ],
  },
  {
    version: '0.5.10',
    date: '2026-10-21',
    items: [
      'Small polish on the Clients and Style pages: list bullets, the Browse files button, the Use this look pictures and keyboard focus now match the design.',
    ],
  },
  {
    version: '0.5.9',
    date: '2026-10-21',
    items: [
      'Approving a video whose graphics live in one composition now saves them to the client’s kit, and a video with no graphics no longer clears it.',
    ],
  },
  {
    version: '0.5.8',
    date: '2026-10-21',
    items: [
      'When the edit moves captions or a graphic, it now checks what they sit on and picks a clear spot if they would cover text, a face or a key object in the picture.',
    ],
  },
  {
    version: '0.5.7',
    date: '2026-10-21',
    items: [
      'When a review note asks to keep a graphic on screen longer, the edit now moves its fade-out with it, so the graphic still fades out instead of vanishing.',
    ],
  },
  {
    version: '0.5.6',
    date: '2026-10-21',
    items: [
      'Every video you approve now adds its look to the client’s style: the old rules stay, and the newest video wins where they differ. A preview never changes the style.',
    ],
  },
  {
    version: '0.5.5',
    date: '2026-10-21',
    items: [
      'Behind the scenes: the engine now works out each month’s income, expenses and profit from your delivered jobs and money.json, ready for the Money page.',
    ],
  },
  {
    version: '0.5.4',
    date: '2026-10-21',
    items: [
      'On a 1280 px window the Jobs table fits without scrolling sideways: Inputs hides itself when there is no room, so Status and the row’s button stay in view. Turn it on in Columns to keep it.',
    ],
  },
  {
    version: '0.5.3',
    date: '2026-10-21',
    items: ['Fix: a note made right after you jump in the video is pinned at the right time.'],
  },
  {
    version: '0.5.2',
    date: '2026-10-21',
    items: [
      'Every edit, and every round of changes after your review notes, now runs at the highest effort level, so the videos come out better (a job can take a little longer).',
    ],
  },
  {
    version: '0.5.1',
    date: '2026-10-21',
    items: [
      'Behind the scenes: Studio Engine notes how long you spend reviewing each job (only while the Review window is open and you’re using it, voice notes included), for the coming Money page.',
    ],
  },
  {
    version: '0.5.0',
    date: '2026-10-21',
    items: [
      'New client button on the Clients page: create a client before its first video and go straight to its Style page.',
      'Shape a new client’s style by dropping screenshots, clips, a logo or notes there; its first video will follow it.',
    ],
  },
  {
    version: '0.4.6',
    date: '2026-10-21',
    items: [
      'Polish: the Review window and its rows match the design more closely: button spacing and corners, the red recording marker, and a Review row’s round number no longer cut off.',
    ],
  },
  {
    version: '0.4.5',
    date: '2026-10-21',
    items: [
      'Behind the scenes: a folder in your inbox counts as a client straight away, even before its first video (the New client button comes next).',
    ],
  },
  {
    version: '0.4.4',
    date: '2026-10-21',
    items: [
      'Right-click a finished video and choose “Use this look” to make its look the client’s style. The dialog shows the current look and the new one side by side.',
    ],
  },
  {
    version: '0.4.3',
    date: '2026-10-21',
    items: [
      'Behind the scenes: an automatic test now takes a job through the whole review loop: notes, a voice note, Send, a second round and Approve.',
    ],
  },
  {
    version: '0.4.2',
    date: '2026-10-21',
    items: [
      'Behind the scenes: your prices, subscriptions and charges can now live in money.json (see the README), ready for the Money page. The doctor checks the file.',
    ],
  },
  {
    version: '0.4.1',
    date: '2026-10-21',
    items: [
      'Behind the scenes: Studio Engine keeps a permanent record of every delivered job and its price, for the coming Money page.',
    ],
  },
  {
    version: '0.4.0',
    date: '2026-10-21',
    items: [
      'Each client has a Style page: open it from the client’s page or by right-clicking the client.',
      'Add a logo, fonts, screenshots, clips, a brand guide or notes there (or drop them on the page), and they’re worked into the client’s style.md. Choose whether they add to the style or replace it.',
    ],
  },
  {
    version: '0.3.9',
    date: '2026-10-21',
    items: [
      'Behind the scenes: sent notes now become a new live preview, and approving renders and exports the final video (still behind the Review switch).',
    ],
  },
  {
    version: '0.3.8',
    date: '2026-10-21',
    items: [
      'Behind the scenes: the Review dialog records voice notes pinned to the video, plays them back and shows their transcripts.',
    ],
  },
  {
    version: '0.3.7',
    date: '2026-10-21',
    items: [
      'A client’s first finished video now sets its style.md by itself, and clients with finished videos get one from their newest video.',
      'Behind the scenes: the engine can now take a finished video’s look as the client’s style, undo that, and show a still from a video (the buttons come later).',
    ],
  },
  {
    version: '0.3.6',
    date: '2026-10-21',
    items: [
      'Behind the scenes: the Review dialog takes typed notes pinned to the video, shows them on the timeline, and sends them or approves the edit.',
    ],
  },
  {
    version: '0.3.5',
    date: '2026-10-21',
    items: [
      'Behind the scenes: with the new Review switch on, an edit can finish as a live preview instead of a rendered video (it stays off for now).',
    ],
  },
  {
    version: '0.3.4',
    date: '2026-10-21',
    items: [
      'Behind the scenes: review notes marked Add to style become rules in the client’s style when you send them.',
    ],
  },
  {
    version: '0.3.3',
    date: '2026-10-21',
    items: [
      'Jobs waiting for your review get their own tab, counter and Review button, which opens the live preview (Review itself is switched on later).',
    ],
  },
  {
    version: '0.3.2',
    date: '2026-10-21',
    items: ['The note tooltip no longer stays open when the list re-orders under your pointer.'],
  },
  {
    version: '0.3.1',
    date: '2026-10-21',
    items: [
      'Behind the scenes: review notes can now be saved, transcribed and sent with a round (nothing visible yet).',
    ],
  },
  {
    version: '0.3.0',
    date: '2026-10-21',
    items: [
      'New Clients page: every client, with how many jobs it has and when its last one came in.',
      'Click a client to open its own page with just its jobs. Right-click a client to open it or show its folder in Finder.',
    ],
  },
  {
    version: '0.2.22',
    date: '2026-10-21',
    items: [
      'Edits now cut stutters and misspoken lines, avoid shaky footage (trimming a shaky start) and use low-quality photos only as a last resort.',
    ],
  },
  {
    version: '0.2.21',
    date: '2026-10-21',
    items: [
      'Drop a logo, fonts, notes or a brand guide into a client’s _Style folder, and a minute later they’re turned into that client’s style.md.',
    ],
  },
  {
    version: '0.2.20',
    date: '2026-10-21',
    items: [
      'Groundwork for reviewing edits before they’re rendered: the engine now knows the Review step, revisions and the final render (nothing visible yet).',
    ],
  },
  {
    version: '0.2.19',
    date: '2026-10-21',
    items: [
      'Behind the scenes: the player for watching live edits is ready, with its own controls and keyboard shortcuts; it appears in the Review dialog soon.',
    ],
  },
  {
    version: '0.2.18',
    date: '2026-10-21',
    items: ['New edits follow the client’s style, as soon as the client has one.'],
  },
  {
    version: '0.2.17',
    date: '2026-10-21',
    items: ['Each client’s avatar now has its own colour, generated from the client’s name.'],
  },
  {
    version: '0.2.16',
    date: '2026-10-21',
    items: [
      'Behind the scenes: the engine can now transcribe a voice note by itself (Hebrew or English, from Chrome or Safari), ready for voice notes in Review.',
    ],
  },
  {
    version: '0.2.15',
    date: '2026-10-21',
    items: ['Every client folder now has a _Style folder, ready to hold that client’s style.'],
  },
  {
    version: '0.2.14',
    date: '2026-10-21',
    items: [
      'Groundwork for reviewing edits: the engine can now send a job’s live preview to the browser (nothing visible yet).',
    ],
  },
  {
    version: '0.2.13',
    date: '2026-10-21',
    items: [
      'Groundwork for reviewing edits: the files that carry your review notes to the editor and into a client’s style (nothing visible yet).',
    ],
  },
  {
    version: '0.2.12',
    date: '2026-10-21',
    items: [
      'Writing a note on a waiting job no longer costs it its turn: after you save or cancel, the job is back at the same place in line.',
    ],
  },
  {
    version: '0.2.11',
    date: '2026-10-21',
    items: [
      'Behind the scenes: the demo data used for design checks now matches the Phase 1 Jobs page.',
    ],
  },
  {
    version: '0.2.10',
    date: '2026-10-21',
    items: [
      'After a failed brief, Retry and Resume now tell the editor the step the job really reached, and Check keeps a closer pass count after a resume.',
    ],
  },
  {
    version: '0.2.9',
    date: '2026-10-21',
    items: [
      "When your note gives the size (like 1080x1920), the brief now treats it as your decision instead of marking it assumed, so the edit won't second-guess it.",
    ],
  },
  {
    version: '0.2.8',
    date: '2026-10-21',
    items: [
      'The note window now has the same spacing as the design, and menus, dialogs and tooltips open and close with the same smooth easing as the rest of the app.',
    ],
  },
  {
    version: '0.2.7',
    date: '2026-10-21',
    items: [
      'Transcribe now counts only the clips that get edited, so a job with voice notes or a ruled-out clip reaches its last count instead of stopping short.',
    ],
  },
  {
    version: '0.2.6',
    date: '2026-10-21',
    items: [
      'The Brief now listens to the client\'s voice notes: what they say, like "30 seconds at most" or "open on the espresso shot", ends up in the brief the editor follows.',
    ],
  },
  {
    version: '0.2.5',
    date: '2026-10-21',
    items: [
      'The progress bar no longer jumps to Render when the editor makes its first rough cut. It shows Render only when the finished video starts being written.',
    ],
  },
  {
    version: '0.2.4',
    date: '2026-10-21',
    items: [
      "The brief's file list no longer hides a clip the client ruled out: footage is listed as separate ranges around it.",
    ],
  },
  {
    version: '0.2.3',
    date: '2026-10-21',
    items: [
      'If the brief fails before a Retry, the next Retry now carries on from the edit already done instead of starting the edit over.',
    ],
  },
  {
    version: '0.2.2',
    date: '2026-10-21',
    items: [
      'Right-click a job and choose "Add note…" to tell the editor anything the client\'s files don\'t say. Your note wins over everything the client sent.',
      'The job waits while you write and goes back in line when you save. A small note icon next to its name shows what you wrote.',
    ],
  },
  {
    version: '0.2.1',
    date: '2026-10-21',
    items: [
      'A folder with footage and a Final Cut or Premiere project file now skips the Brief, like any footage-only folder.',
      'The voice-note count during the Brief no longer gets stuck when the folder has a music track.',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10-21',
    items: [
      'Every edit now starts with a Brief. The engine reads what the client sent in the job folder (documents, WhatsApp chats, voice notes, logos), writes it up for the editor, and the edit follows it: length, format, must-include moments and on-screen text.',
      'A job that holds only video skips the Brief, and Retry or Resume reuses the brief when nothing in the folder changed.',
    ],
  },
  {
    version: '0.1.21',
    date: '2026-10-21',
    items: [
      'Each job row now shows only the one button that moves it forward: Start now, Release, Retry, Resume or Download.',
      'Everything else, like Hold, Cancel and Copy error, is in the menu when you right-click a job.',
    ],
  },
  {
    version: '0.1.20',
    date: '2026-10-21',
    items: [
      'Start a job right away with the new Start now button, instead of waiting a minute for its files to settle.',
      'Behind the scenes: each job can now keep a note from you. Adding one from the Jobs page comes in an upcoming update.',
    ],
  },
  {
    version: '0.1.19',
    date: '2026-10-21',
    items: [
      "The progress bar now has eight steps, starting with Brief. Brief is quick for now; from the next update it reads the client's files before the edit starts. Jobs already in the list keep the step they were on.",
    ],
  },
  {
    version: '0.1.18',
    date: '2026-10-21',
    items: [
      'Behind the scenes: groundwork for the coming Brief step. The brief the editor will read before each edit now has a fixed format, so what the client asked for and your note get written down the same way every time.',
    ],
  },
  {
    version: '0.1.17',
    date: '2026-10-21',
    items: [
      '"What\'s new" is now a single scrollable dialog that lists everything you missed, newest first, with one "Got it" button.',
    ],
  },
  {
    version: '0.1.16',
    date: '2026-10-20',
    items: [
      'The "Reconnecting to the engine…" note now also shows on the dev server, and it goes away within a few seconds of the engine coming back.',
    ],
  },
  {
    version: '0.1.15',
    date: '2026-10-20',
    items: [
      'If Hold, Release, Resume or Retry is refused after the job has moved to another page of the list, a small message at the bottom right now says which job and why.',
    ],
  },
  {
    version: '0.1.14',
    date: '2026-10-20',
    items: [
      'If the engine stops or restarts while the Jobs page is open, the header now says "Reconnecting to the engine…" instead of quietly showing old numbers.',
      "The page no longer waits forever on an engine that never answers: after 10 seconds it says it can't reach it.",
    ],
  },
  {
    version: '0.1.13',
    date: '2026-10-20',
    items: [
      "The engine's log now warns as soon as a new folder shows up in your inbox while a video is being edited, so a stray folder made by an edit is easy to spot.",
    ],
  },
  {
    version: '0.1.12',
    date: '2026-10-20',
    items: [
      'Restarting the engine is now instant, even with the app open in a browser.',
      'A job stopped by a restart is now marked as stopped in its log, instead of as cancelled.',
    ],
  },
  {
    version: '0.1.11',
    date: '2026-10-20',
    items: [
      'The README now explains how to try the app on a scratch inbox without touching your real one, lists every script, and shows the exact instructions the editor receives.',
    ],
  },
  {
    version: '0.1.10',
    date: '2026-10-20',
    items: [
      'Releasing a held job now shows the right state straight away, even when the engine runs with a custom settle time.',
    ],
  },
  {
    version: '0.1.9',
    date: '2026-10-20',
    items: [
      'The "~N min left" estimate now shows up after three finished jobs, even if some edits were interrupted or skipped a step.',
    ],
  },
  {
    version: '0.1.8',
    date: '2026-10-20',
    items: [
      'The "Stop this edit?" box now stays open even if the job moves to another page while you decide.',
      'Right-clicking another column header while the Columns menu is open keeps the menu working, keyboard included.',
    ],
  },
  {
    version: '0.1.7',
    date: '2026-10-20',
    items: [
      'The doctor now warns you when edits are using an older copy of the video-use skill than the updated one in the handoff folder, and shows the one command that fixes it.',
    ],
  },
  {
    version: '0.1.6',
    date: '2026-10-20',
    items: [
      'Pressing Retry on a job that only failed at the export step now just exports the finished video again, without starting a new Claude edit.',
    ],
  },
  {
    version: '0.1.5',
    date: '2026-10-20',
    items: [
      'When the engine isn\'t running, the Jobs page now says "Can\'t reach the engine" right away and fills in by itself as soon as the engine is back.',
      'The header no longer shows 0 editing, 0 queued and 0 need attention before the job list has loaded.',
    ],
  },
  {
    version: '0.1.4',
    date: '2026-10-20',
    items: [
      "The doctor now warns you when your ffmpeg can't tone-map iPhone HDR clips, burn in captions or draw text, and tells you how to fix it.",
    ],
  },
  {
    version: '0.1.3',
    date: '2026-10-20',
    items: ['Edits of jobs whose names have spaces no longer leave stray folders in the inbox.'],
  },
  {
    version: '0.1.2',
    date: '2026-10-20',
    items: [
      'The "settles in" countdown and the Release button now follow the settle time you configured, instead of always assuming one minute.',
    ],
  },
  {
    version: '0.1.1',
    date: '2026-10-20',
    items: [
      'Each fix and change now gets its own version number and a note here, so you can always see what changed and when.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-20',
    items: [
      'Every folder in Studio Inbox/<Client>/<Job> now shows up here as a job.',
      'Edits start on their own a minute after the files stop changing. Hold a job to keep it waiting.',
      'Follow each edit live: Transcribe, Scan, Plan, Cut, Preview, Check, Render.',
      "Download finished videos here. They're also saved in Studio Inbox/_Exports.",
      'If an edit fails, retry it. If you stop one, resume it later.',
      'Studio Engine starts when you log in to your Mac, so this page is always at localhost:4310.',
    ],
  },
];
