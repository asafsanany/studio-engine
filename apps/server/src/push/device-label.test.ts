import { describe, expect, it } from 'vitest';
import { deviceLabelFromUserAgent } from './device-label.js';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const WINDOWS_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

describe('deviceLabelFromUserAgent', () => {
  it('names the phones and tablets by the device', () => {
    expect(deviceLabelFromUserAgent(IPHONE)).toBe('iPhone');
    expect(deviceLabelFromUserAgent(IPAD)).toBe('iPad');
    expect(deviceLabelFromUserAgent(ANDROID)).toBe('Android');
  });

  it('names a computer with its browser', () => {
    expect(deviceLabelFromUserAgent(MAC_CHROME)).toBe('Mac · Chrome');
    expect(deviceLabelFromUserAgent(MAC_SAFARI)).toBe('Mac · Safari');
    expect(deviceLabelFromUserAgent(WINDOWS_EDGE)).toBe('Windows · Edge');
    expect(deviceLabelFromUserAgent(LINUX_FIREFOX)).toBe('Linux · Firefox');
  });

  it('says Device when there is nothing to go on', () => {
    expect(deviceLabelFromUserAgent(undefined)).toBe('Device');
    expect(deviceLabelFromUserAgent(null)).toBe('Device');
    expect(deviceLabelFromUserAgent('  ')).toBe('Device');
    expect(deviceLabelFromUserAgent('curl/8.4.0')).toBe('Device');
  });
});
