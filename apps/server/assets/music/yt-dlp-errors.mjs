// What yt-dlp's complaints mean (Songs, SG2). yt-dlp is used for YouTube and YouTube Music only;
// when it fails, `classifyYtDlpError(stderr)` turns what it printed into one of the song failure
// codes (SONG_FAILURE_CODES in the shared contract) and a plain sentence the owner can read. Plain Node,
// no dependencies, so the getter (get-song.mjs) and, later, the doctor can both import it.
//
//   update_needed  yt-dlp is too old for YouTube ("n challenge solving failed", "No supported
//                  JavaScript runtime", "Requested format is not available", "Unable to extract")
//   blocked        YouTube refuses this Mac ("Sign in to confirm you're not a bot", "Your IP is
//                  likely being blocked", HTTP 403, HTTP 429 "Too Many Requests"); it clears by
//                  itself, so the sentence says to try again in a while
//   unavailable    the video is private, removed, age-restricted or not shown in this country, or
//                  YouTube could not be reached
//   not_found      no results
//   tool_missing   yt-dlp, deno or ffmpeg is not installed
//   failed         anything else, with the last thing yt-dlp said

/** Straight and curly apostrophes, as YouTube's messages use both. */
const APOSTROPHE = "['’]";

/**
 * The sentence for `blocked`: YouTube is refusing this Mac for now, and it passes. A 429 says the Mac
 * asked too many times lately; the bot check and the rest say YouTube takes the Mac for a bot.
 */
function blockedMessage(context) {
  const why = /http error 429|too many requests/i.test(context.text)
    ? 'it says this Mac asked too many times lately'
    : 'it takes them for a bot';
  return `${context.site} is refusing requests from this Mac right now (${why}), so ${context.song} could not be got. Try again in a while.`;
}

/**
 * The rules, in the order they are tried: the first whose pattern matches decides. Order matters:
 * an age check ("Sign in to confirm your age") is a video that is closed, not a bot check; a region
 * block says 403 in some versions of yt-dlp, so 403 is read after `unavailable`; and yt-dlp words a
 * 429 as "Unable to download API page: HTTP Error 429: Too Many Requests", which `unavailable`
 * would take for the internet being down, so 429 and the bot check are read before it.
 */
const RULES = [
  {
    code: 'tool_missing',
    patterns: [
      /ffprobe and ffmpeg not found/i,
      /ffmpeg not found/i,
      /ffmpeg is not installed/i,
      /ffprobe not found/i,
      /\bENOENT\b/,
      /\bcommand not found\b/i,
    ],
    message: (context) =>
      /ffmpeg|ffprobe/i.test(context.text)
        ? `ffmpeg is missing, so ${context.song} could not be converted. Run: brew install ffmpeg`
        : `yt-dlp or deno is missing, so ${context.song} could not be got from ${context.site}. Run: brew install yt-dlp deno`,
  },
  {
    code: 'update_needed',
    patterns: [
      /n challenge solving failed/i,
      /no supported javascript runtime/i,
      /requested format is not available/i,
      /unable to extract/i,
      /please report this issue/i,
      /signature extraction failed/i,
      /yt-dlp is out of date|update yt-dlp|newer version of yt-dlp/i,
    ],
    message: (context) =>
      `${context.site} changed and yt-dlp is too old to read it, so ${context.song} could not be got. Run: brew upgrade yt-dlp, then ask again.`,
  },
  {
    // YouTube answering "too many requests" (HTTP 429), or taking this Mac for a bot. Not a video
    // that is gone and not a broken install: it clears by itself, so the answer is to try again
    // later, never "check the internet".
    code: 'blocked',
    patterns: [
      new RegExp(`sign in to confirm you${APOSTROPHE}re not a bot`, 'i'),
      /http error 429/i,
      /too many requests/i,
    ],
    message: blockedMessage,
  },
  {
    code: 'unavailable',
    patterns: [
      /age-restricted|age restricted|confirm your age/i,
      /not made this video available in your country/i,
      /blocked it in your country|not available in your country|geo.?restrict/i,
      /private video|video is private/i,
      /has been removed|was removed|removed by the uploader|has been terminated|account associated with this video/i,
      /video unavailable|this video is unavailable|this video is not available|no longer available/i,
      /members-only|join this channel|premieres in|live event will begin/i,
      /copyright (claim|grounds)/i,
      /temporary failure in name resolution|unable to download (webpage|api|json)|network is unreachable|connection (reset|refused|timed out)|timed? ?out|nodename nor servname|getaddrinfo/i,
    ],
    message: (context) => {
      const text = context.text;
      if (/age/i.test(text) && /restrict|confirm your age/i.test(text)) {
        return `${context.site} says ${context.song} is age-restricted, so it cannot be downloaded.`;
      }
      if (/country|geo/i.test(text)) {
        return `${context.song} is not available in this country on ${context.site}.`;
      }
      if (/private/i.test(text)) return `${context.song} is private on ${context.site}.`;
      if (/removed|terminated|copyright/i.test(text)) {
        return `${context.song} was removed from ${context.site}.`;
      }
      if (
        /name resolution|unable to download|unreachable|connection|time|getaddrinfo|nodename/i.test(
          text,
        )
      ) {
        return `${context.site} did not answer for ${context.song}. Check the internet connection and try again.`;
      }
      return `${context.song} is not available on ${context.site}.`;
    },
  },
  {
    code: 'blocked',
    patterns: [/your ip is likely being blocked/i, /http error 403/i, /\b403\b.{0,20}forbidden/i],
    message: blockedMessage,
  },
  {
    code: 'not_found',
    patterns: [
      /no (video |search )?results/i,
      /did(?: not|n['\u2019]t) match any/i,
      /unsupported url/i,
      /\bnothing (was )?found\b/i,
    ],
    message: (context) => `Nothing for ${context.song} was found on ${context.site}.`,
  },
];

/** The words yt-dlp's complaint is read as, cut down to one line. */
function lastLine(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const errors = lines.filter((line) => /^ERROR:/i.test(line));
  const line = (errors.length > 0 ? errors[errors.length - 1] : (lines[lines.length - 1] ?? ''))
    .replace(/^ERROR:\s*/i, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/**
 * What yt-dlp's stderr (or stdout) means. Always returns `{ code, message }`: `message` is a plain
 * sentence, with no URL and nothing that looks like a key. `context` names the song and the site
 * for the sentence: `{ song: '"נתתי לך בית" by Ofek Adanek', site: 'YouTube Music' }`; both default
 * to "that song" and "YouTube".
 */
export function classifyYtDlpError(stderr, context = {}) {
  const text = String(stderr ?? '');
  const named = { song: context.song ?? 'that song', site: context.site ?? 'YouTube', text };
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return { code: rule.code, message: rule.message(named) };
    }
  }
  const said = lastLine(text);
  return {
    code: 'failed',
    message:
      said === ''
        ? `${named.site} did not give ${named.song}.`
        : `${named.site} did not give ${named.song}: ${said}`,
  };
}
