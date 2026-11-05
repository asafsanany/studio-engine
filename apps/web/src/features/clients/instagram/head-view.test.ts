import { noClientInstagram } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { followersNow, headerFacts, scanLine } from './head-view';
import {
  FALCON_NEXT_SCAN_AT,
  FALCON_NOW,
  FALCON_TIME_ZONE,
  falconInstagram,
} from './test-instagram';

const OPTIONS = { timeZone: FALCON_TIME_ZONE, now: FALCON_NOW };

describe('the line under "Instagram"', () => {
  it('says when the page was scanned and when the next scan is', () => {
    expect(scanLine(falconInstagram(), OPTIONS)).toBe('Scanned Mon 26 Oct · next scan Mon 2 Nov');
  });

  it('says the scan is on, with the last one before it', () => {
    expect(scanLine({ ...falconInstagram(), scanning: true }, OPTIONS)).toBe(
      'Scanning now · last scan Mon 26 Oct',
    );
  });

  it('says only that it is scanning before the first scan has ended', () => {
    const data = { ...noClientInstagram(), scanning: true, nextScanAt: FALCON_NEXT_SCAN_AT };
    expect(scanLine(data, OPTIONS)).toBe('Scanning now');
  });

  it('says it was not scanned yet, with the next scan when there is one', () => {
    expect(scanLine({ ...noClientInstagram(), nextScanAt: FALCON_NEXT_SCAN_AT }, OPTIONS)).toBe(
      'Not scanned yet · next scan Mon 2 Nov',
    );
    expect(scanLine(noClientInstagram(), OPTIONS)).toBe('Not scanned yet');
  });

  it('says a scan that read nothing could not read the page', () => {
    const data = falconInstagram();
    if (data.lastScan === null) throw new Error('the fixture has a scan');
    data.lastScan = { ...data.lastScan, outcome: 'failed', error: 'Instagram did not answer' };
    expect(scanLine(data, OPTIONS)).toBe(
      'The scan of Mon 26 Oct could not read the page · next scan Mon 2 Nov',
    );
  });

  it('writes the day in the viewer’s time zone', () => {
    // Monday 06:00 in Israel is still Sunday evening in Los Angeles.
    expect(scanLine(falconInstagram(), { timeZone: 'America/Los_Angeles' })).toBe(
      `Scanned Sun 25 Oct · next scan Sun 1 Nov`,
    );
  });
});

describe('what the page header adds', () => {
  it('has the handle as a link to Instagram, the followers and the bio', () => {
    expect(headerFacts(falconInstagram())).toEqual({
      handle: 'falcon.fpv',
      url: 'https://www.instagram.com/falcon.fpv/',
      followers: '12,480 followers',
      bio: 'FPV drone pilot. Bookings in DM.',
    });
  });

  it('adds nothing for a client with no account, with the switch off or before the answer', () => {
    expect(headerFacts(undefined)).toBeNull();
    expect(headerFacts(noClientInstagram())).toBeNull();
  });

  it('leaves the followers and the bio out before the first scan has read the profile', () => {
    const data = { ...falconInstagram(), numbers: null, lastScan: null };
    if (data.account === null) throw new Error('the fixture has an account');
    data.account = { ...data.account, bio: null, fullName: null };
    expect(headerFacts(data)).toEqual({
      handle: 'falcon.fpv',
      url: 'https://www.instagram.com/falcon.fpv/',
      followers: null,
      bio: null,
    });
  });

  it('says "1 follower" for one', () => {
    const data = falconInstagram();
    if (data.numbers === null) throw new Error('the fixture has numbers');
    data.numbers.tiles.followers.now = 1;
    expect(headerFacts(data)?.followers).toBe('1 follower');
  });

  it('takes the followers of the last scan when the numbers are not there yet', () => {
    const data = { ...falconInstagram(), numbers: null };
    expect(followersNow(data)).toBe(12_480);
    expect(headerFacts(data)?.followers).toBe('12,480 followers');
  });

  it('leaves out a bio that is only spaces', () => {
    const data = falconInstagram();
    if (data.account === null) throw new Error('the fixture has an account');
    data.account.bio = '   ';
    expect(headerFacts(data)?.bio).toBeNull();
  });
});
