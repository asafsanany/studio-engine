// A stand-in for the browser's XMLHttpRequest, for the tests of style uploads. Not imported by the app.

import type { XhrLike } from './api';

/** A stand-in for the browser's XMLHttpRequest that the test drives by hand. */
export class FakeXhr implements XhrLike {
  method = '';
  url = '';
  body: FormData | null = null;
  aborted = false;
  status = 0;
  statusText = '';
  responseText = '';
  upload: XhrLike['upload'] = { onprogress: null };
  onload: XhrLike['onload'] = null;
  onerror: XhrLike['onerror'] = null;
  onabort: XhrLike['onabort'] = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.({} as ProgressEvent);
  }

  /** Bytes have gone: `loaded` of `total`. */
  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ loaded, total, lengthComputable } as ProgressEvent);
  }
  /** The server answered. */
  answer(status: number, body: unknown, statusText = '') {
    this.status = status;
    this.statusText = statusText;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.({} as ProgressEvent);
  }
  /** The connection broke. */
  fail() {
    this.onerror?.({} as ProgressEvent);
  }
}
