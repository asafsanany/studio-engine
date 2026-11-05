// A short device name from the user agent that registered a push device: "iPhone", "Mac · Chrome".

function browserOf(ua: string): string | null {
  if (/Edg(?:e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return null;
}

/** "iPhone", "iPad", "Android", or the computer with its browser ("Mac · Chrome"); "Device" when unknown. */
export function deviceLabelFromUserAgent(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').trim();
  if (ua === '') return 'Device';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  const computer = /Macintosh|Mac OS X/.test(ua)
    ? 'Mac'
    : /Windows/.test(ua)
      ? 'Windows'
      : /CrOS/.test(ua)
        ? 'Chromebook'
        : /Linux|X11/.test(ua)
          ? 'Linux'
          : null;
  if (computer === null) return 'Device';
  const browser = browserOf(ua);
  return browser === null ? computer : `${computer} · ${browser}`;
}
