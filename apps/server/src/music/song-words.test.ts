import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { firstSungWordMs, firstWordMs } from '../../assets/music/song-words.mjs';

// Where a song's words start (assets/music/song-words.mjs): Scribe's answer read for its first
// word, and the call to Scribe, against a small local server standing in for ElevenLabs.

describe('the first word in Scribe’s answer', () => {
  it('is the start of the first word, in ms', () => {
    expect(
      firstWordMs({
        words: [
          { text: 'Che', start: 16.16, end: 16.4, type: 'word' },
          { text: 'confusione,', start: 16.4, end: 17.1, type: 'word' },
        ],
      }),
    ).toBe(16_160);
  });

  it('skips spacings, audio events and marks with no letter in them', () => {
    expect(
      firstWordMs({
        words: [
          { text: ' ', start: 0, end: 0.5, type: 'spacing' },
          { text: '(music)', start: 0.5, end: 4, type: 'audio_event' },
          { text: '♪', start: 4, end: 5, type: 'word' },
          { text: 'Sarà', start: 5.25, end: 5.9, type: 'word' },
        ],
      }),
    ).toBe(5_250);
  });

  it('reads Hebrew words too, and words with no type', () => {
    expect(firstWordMs({ words: [{ text: 'אותה', start: 2, end: 2.4 }] })).toBe(2_000);
  });

  it('is none for an instrumental, an empty answer or something else', () => {
    expect(firstWordMs({ words: [] })).toBeNull();
    expect(
      firstWordMs({ words: [{ text: '(music)', start: 0, end: 9, type: 'audio_event' }] }),
    ).toBeNull();
    expect(firstWordMs({})).toBeNull();
    expect(firstWordMs(null)).toBeNull();
  });
});

describe('listening to the start of a song', () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  async function scribe(
    answer: (request: IncomingMessage) => { status: number; body: unknown },
  ): Promise<{ base: string; requests: IncomingMessage[] }> {
    const requests: IncomingMessage[] = [];
    const server: Server = createServer((request, response) => {
      requests.push(request);
      request.resume();
      request.on('end', () => {
        const { status, body } = answer(request);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    closers.push(() => server.close());
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
  }

  function songStart(): string {
    const dir = mkdtempSync(join(tmpdir(), 'studio-words-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'song-start.mp3');
    writeFileSync(file, Buffer.from('not really an mp3'));
    return file;
  }

  it('answers where the first word starts, sending the key in a header only', async () => {
    const { base, requests } = await scribe(() => ({
      status: 200,
      body: { words: [{ text: 'Che', start: 16.16, end: 16.4, type: 'word' }] },
    }));
    const heard = await firstSungWordMs({ file: songStart(), key: 'sk_test_key', base });
    expect(heard).toEqual({ ms: 16_160, why: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/v1/speech-to-text');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers['xi-api-key']).toBe('sk_test_key');
    expect(requests[0]?.headers['content-type']).toMatch(/^multipart\/form-data/);
  });

  it('says why when there is no key, without calling anything', async () => {
    const { base, requests } = await scribe(() => ({ status: 200, body: {} }));
    const heard = await firstSungWordMs({ file: songStart(), key: null, base });
    expect(heard).toEqual({ ms: null, why: 'there is no ElevenLabs key to listen with' });
    expect(requests).toHaveLength(0);
  });

  it('says why when no words are heard', async () => {
    const { base } = await scribe(() => ({ status: 200, body: { words: [] } }));
    expect(await firstSungWordMs({ file: songStart(), key: 'k_123456789', base })).toEqual({
      ms: null,
      why: 'no words were heard in the first two minutes',
    });
  });

  it('says why when ElevenLabs refuses', async () => {
    const { base } = await scribe(() => ({ status: 401, body: { detail: 'bad key' } }));
    const heard = await firstSungWordMs({ file: songStart(), key: 'k_123456789', base });
    expect(heard).toEqual({ ms: null, why: 'ElevenLabs answered 401 when listening' });
  });

  it('says why when ElevenLabs cannot be reached', async () => {
    const heard = await firstSungWordMs({
      file: songStart(),
      key: 'k_123456789',
      base: 'http://127.0.0.1:9',
    });
    expect(heard.ms).toBeNull();
    expect(heard.why).toBe('ElevenLabs could not be reached');
  });
});
