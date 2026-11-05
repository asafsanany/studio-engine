import { SONG_FAILURE_CODES } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { classifyYtDlpError } from '../../assets/music/yt-dlp-errors.mjs';

// What yt-dlp's complaints mean (assets/music/yt-dlp-errors.mjs): each string the orchestrator
// named, the codes they map to (all of them the shared contract's), and the sentences.

const context = { song: '"נתתי לך בית" by אופק אדנק', site: 'YouTube Music' };

describe('classifyYtDlpError', () => {
  const cases: [string, string, string][] = [
    // update needed: yt-dlp is too old for YouTube
    [
      'update_needed',
      'WARNING: [youtube] abc: n challenge solving failed: Some formats may be missing',
      'brew upgrade yt-dlp',
    ],
    [
      'update_needed',
      'WARNING: [youtube] No supported JavaScript runtime could be found',
      'brew upgrade yt-dlp',
    ],
    [
      'update_needed',
      'ERROR: [youtube] abc: Requested format is not available. Use --list-formats',
      'too old',
    ],
    [
      'update_needed',
      'ERROR: [youtube] abc: Unable to extract initial data; please report this issue on https://github.com/yt-dlp/yt-dlp',
      'too old',
    ],
    // blocked: YouTube refuses this Mac
    [
      'blocked',
      "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser",
      'bot',
    ],
    ['blocked', 'ERROR: [youtube] abc: Sign in to confirm you’re not a bot', 'bot'],
    ['blocked', 'ERROR: [youtube] abc: Your IP is likely being blocked by YouTube', 'refusing'],
    ['blocked', 'ERROR: unable to download video data: HTTP Error 403: Forbidden', 'refusing'],
    [
      'blocked',
      'ERROR: unable to download video data: HTTP Error 429: Too Many Requests',
      'refusing',
    ],
    // unavailable: the video is closed, or YouTube could not be reached
    [
      'unavailable',
      "ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video",
      'private',
    ],
    ['unavailable', 'ERROR: [youtube] abc: This video has been removed by the uploader', 'removed'],
    [
      'unavailable',
      'ERROR: [youtube] abc: The uploader has not made this video available in your country',
      'country',
    ],
    [
      'unavailable',
      'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.',
      'age-restricted',
    ],
    ['unavailable', 'ERROR: [youtube] abc: Video unavailable', 'not available'],
    [
      'unavailable',
      'ERROR: [youtube] Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known>',
      'did not answer',
    ],
    // not found
    ['not_found', 'ERROR: No video results found for the search', 'Nothing'],
    ['not_found', 'ERROR: Unsupported URL: https://example.com/x', 'Nothing'],
    // tools
    [
      'tool_missing',
      'ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location',
      'brew install ffmpeg',
    ],
    ['tool_missing', 'sh: yt-dlp: command not found', 'brew install yt-dlp deno'],
  ];

  it.each(cases)('%s: %s', (code, stderr, words) => {
    const out = classifyYtDlpError(stderr, context);
    expect(out.code).toBe(code);
    expect(out.message.toLowerCase()).toContain(words.toLowerCase());
    expect(SONG_FAILURE_CODES).toContain(out.code);
  });

  it('names the song and the site, and has no URL in the sentence', () => {
    const out = classifyYtDlpError(
      'ERROR: [youtube] abc: Private video https://www.youtube.com/watch?v=abc',
      context,
    );
    expect(out.message).toContain('נתתי לך בית');
    expect(out.message).toContain('YouTube Music');
    expect(out.message).not.toMatch(/https?:/);
  });

  it('an age check is not a bot check', () => {
    expect(classifyYtDlpError('Sign in to confirm your age').code).toBe('unavailable');
    expect(classifyYtDlpError("Sign in to confirm you're not a bot").code).toBe('blocked');
  });

  describe('YouTube refusing this Mac for a while (HTTP 429, "not a bot"), C81', () => {
    // What yt-dlp really printed on 26 Oct, after many test downloads.
    const TOO_MANY =
      'ERROR: [youtube] jNQXAC9IVRw: Unable to download API page: HTTP Error 429: Too Many Requests (caused by <HTTPError 429: Too Many Requests>)';
    const NOT_A_BOT =
      "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies. Also see  https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies  for tips on effectively exporting YouTube cookies";

    it.each([
      ['a 429 on the API page', TOO_MANY],
      ['the "not a bot" check', NOT_A_BOT],
      ['the same with the curly apostrophe', NOT_A_BOT.replace("you're", 'you’re')],
      ['a 429 as the getter hands it over (stderr, then stdout)', `${TOO_MANY}\n`],
      [
        'a 429 after a harmless warning',
        `WARNING: [youtube] jNQXAC9IVRw: Some web client https formats have been skipped\n${TOO_MANY}\n`,
      ],
    ])('%s is blocked, never "unavailable"', (_name, stderr) => {
      const out = classifyYtDlpError(stderr, context);
      expect(out.code).toBe('blocked');
      expect(SONG_FAILURE_CODES).toContain(out.code);
    });

    it('says YouTube is refusing right now and to try again in a while, never to check the internet', () => {
      for (const stderr of [TOO_MANY, NOT_A_BOT]) {
        const { message } = classifyYtDlpError(stderr, context);
        expect(message).toContain('YouTube Music is refusing requests from this Mac right now');
        expect(message).toContain('נתתי לך בית');
        expect(message).toContain('Try again in a while.');
        expect(message.toLowerCase()).not.toContain('internet');
        expect(message).not.toMatch(/https?:/);
        expect(message).not.toMatch(/brew/);
      }
    });

    it('a 429 says why in its own words: this Mac asked too many times; the bot check says the bot', () => {
      expect(classifyYtDlpError(TOO_MANY).message).toContain('asked too many times lately');
      expect(classifyYtDlpError(NOT_A_BOT).message).toContain('takes them for a bot');
    });

    it('a video that is really unavailable is still unavailable, and does not say to try again later', () => {
      for (const stderr of [
        'ERROR: [youtube] abc: Video unavailable',
        'ERROR: [youtube] abc: Video unavailable. This video is not available',
        "ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video",
        'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.',
      ]) {
        const out = classifyYtDlpError(stderr, context);
        expect(out.code, stderr).toBe('unavailable');
        expect(out.message).not.toContain('Try again in a while');
      }
    });

    it('YouTube really not answering (no internet) is still unavailable, and still says to check the connection', () => {
      const out = classifyYtDlpError(
        'ERROR: [youtube] Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known>',
        context,
      );
      expect(out.code).toBe('unavailable');
      expect(out.message).toContain('Check the internet connection');
    });

    it('403 stays after unavailable, and the other classifications keep their order', () => {
      // A region block that says 403 is the video being closed.
      expect(
        classifyYtDlpError(
          'ERROR: [youtube] abc: Video unavailable. This video contains content from X, who has blocked it in your country on copyright grounds (HTTP Error 403)',
        ).code,
      ).toBe('unavailable');
      // A plain 403 and "Your IP is likely being blocked" are still blocked.
      expect(
        classifyYtDlpError('ERROR: unable to download video data: HTTP Error 403: Forbidden').code,
      ).toBe('blocked');
      expect(classifyYtDlpError('ERROR: [youtube] abc: Your IP is likely being blocked').code).toBe(
        'blocked',
      );
      // An old yt-dlp with no JavaScript runtime that then meets the bot check needs the update first.
      expect(
        classifyYtDlpError(
          `WARNING: [youtube] No supported JavaScript runtime could be found\n${NOT_A_BOT}`,
        ).code,
      ).toBe('update_needed');
    });
  });

  it('a region block that says 403 is still the video being closed', () => {
    const text =
      'ERROR: [youtube] abc: Video unavailable. This video contains content from X, who has blocked it in your country on copyright grounds (HTTP Error 403)';
    expect(classifyYtDlpError(text).code).toBe('unavailable');
  });

  it('anything else is failed, with the last thing yt-dlp said', () => {
    const out = classifyYtDlpError(
      'WARNING: something\nERROR: [youtube] abc: Something odd happened with https://x.test/y',
      context,
    );
    expect(out.code).toBe('failed');
    expect(out.message).toContain('Something odd happened');
    expect(out.message).not.toContain('https://');
  });

  it('empty or odd input is failed and still a sentence', () => {
    for (const input of ['', undefined, null, 42]) {
      const out = classifyYtDlpError(input);
      expect(out.code).toBe('failed');
      expect(out.message.length).toBeGreaterThan(10);
    }
  });

  it('defaults the names to "that song" and "YouTube"', () => {
    expect(classifyYtDlpError('Private video').message).toBe('that song is private on YouTube.');
  });

  it('cuts a very long last line', () => {
    const out = classifyYtDlpError(`ERROR: ${'x'.repeat(1000)}`);
    expect(out.message.length).toBeLessThan(260);
  });
});
