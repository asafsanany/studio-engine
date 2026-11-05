import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  GRAPHIC_MESSAGES,
  graphicVoiceResponseSchema,
  VOICE_NOTE_MAX_BYTES,
} from '@studio/shared';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { GraphicRepository } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { GRAPHICS_ASSETS_DIR } from '../graphics/graphic-assets.js';
import { createDisabledGraphicService } from '../graphics/graphic-service.js';
import {
  createVoiceTranscriber,
  FAKE_VOICE_TEXT,
  TranscriptionError,
  type VoiceJob,
  type VoiceTranscriber,
} from '../pipeline/voice-transcriber.js';
import { createGraphicVoiceRoutes, GRAPHIC_VOICE_DIR_NAME } from './graphic-voice.js';

// The route on its own Hono app (the way app.ts mounts it at /api/graphics), the engine's fake
// voice transcriber (or a stand-in that fails), a temp data folder, `app.request` for the HTTP.

const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 10, 11, 12, 13, 14, 15]);

const dirs: string[] = [];
const transcribers: VoiceTranscriber[] = [];

afterEach(async () => {
  for (const transcriber of transcribers.splice(0)) await transcriber.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  app: Hono;
  dataDir: string;
  /** What is left in <data>/graphic-voice/ (names). */
  leftovers(): Promise<string[]>;
}

function harness(
  options: {
    transcriber?: VoiceTranscriber;
    voiceMaxBytes?: number;
    onTranscribed?: () => void;
  } = {},
): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-graphic-voice-'));
  dirs.push(dataDir);
  let transcriber = options.transcriber;
  if (transcriber === undefined) {
    transcriber = createVoiceTranscriber({ kind: 'fake', sleep: async () => {} });
    transcribers.push(transcriber);
  }
  const app = new Hono();
  app.route(
    '/api/graphics',
    createGraphicVoiceRoutes({
      transcriber,
      dataDir,
      voiceMaxBytes: options.voiceMaxBytes,
      onTranscribed: options.onTranscribed,
    }),
  );
  return {
    app,
    dataDir,
    leftovers: async () => {
      try {
        return await readdir(join(dataDir, GRAPHIC_VOICE_DIR_NAME));
      } catch {
        return [];
      }
    },
  };
}

/** A transcriber that settles with `outcome` after looking at the job it was given. */
function standIn(
  outcome: () => Promise<{ text: string }>,
  seen: (job: VoiceJob) => void = () => {},
): VoiceTranscriber {
  return {
    kind: 'fake',
    enqueue: (job) => {
      seen(job);
      return outcome();
    },
    stop: async () => {},
  };
}

function form(audio: Blob | null = new Blob([WEBM], { type: 'audio/webm' })): FormData {
  const body = new FormData();
  if (audio !== null) body.append('audio', audio, 'voice.webm');
  return body;
}

const postVoice = (
  h: Harness,
  body: FormData | string = form(),
  headers?: Record<string, string>,
) => h.app.request('/api/graphics/voice', { method: 'POST', body, headers });

async function errorOf(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/json');
  return apiErrorSchema.parse(await res.json()).error;
}

describe('POST /api/graphics/voice', () => {
  it('types the recording out with the engine’s transcriber and answers the text', async () => {
    const h = harness();
    const res = await postVoice(h);
    expect(res.status).toBe(200);
    expect(graphicVoiceResponseSchema.parse(await res.json())).toEqual({ text: FAKE_VOICE_TEXT });
  });

  it('keeps the recording under <data>/graphic-voice/ while it is typed out, then deletes it', async () => {
    let seenJob: VoiceJob | null = null;
    let bytes: Uint8Array | null = null;
    const h = harness({
      transcriber: standIn(
        async () => ({ text: 'שלום, make it slower' }),
        (job) => {
          seenJob = job;
          bytes = readFileSync(job.audioPath);
        },
      ),
    });
    const res = await postVoice(h);
    expect(await res.json()).toEqual({ text: 'שלום, make it slower' });

    const job = seenJob as VoiceJob | null;
    expect(job).not.toBeNull();
    expect(job?.audioPath.startsWith(join(h.dataDir, GRAPHIC_VOICE_DIR_NAME))).toBe(true);
    expect(job?.audioPath.endsWith('.webm')).toBe(true);
    // The transcript goes next to the recording, and both are gone once the answer is out.
    expect(job?.outDir.startsWith(join(h.dataDir, GRAPHIC_VOICE_DIR_NAME))).toBe(true);
    expect(Array.from(bytes as unknown as Uint8Array)).toEqual(Array.from(WEBM));
    expect(existsSync(job?.audioPath ?? '')).toBe(false);
    expect(await h.leftovers()).toEqual([]);
  });

  it('leaves no file behind with the fake transcriber either (recording and transcript)', async () => {
    const h = harness();
    expect((await postVoice(h)).status).toBe(200);
    expect(await h.leftovers()).toEqual([]);
  });

  it('takes Safari’s audio/mp4 and names the file .m4a', async () => {
    let name = '';
    const h = harness({
      transcriber: standIn(
        async () => ({ text: 'ok' }),
        (job) => {
          name = job.audioPath;
        },
      ),
    });
    const res = await postVoice(h, form(new Blob([WEBM], { type: 'audio/mp4' })));
    expect(res.status).toBe(200);
    expect(name.endsWith('.m4a')).toBe(true);
  });

  it('takes a type with parameters (audio/webm;codecs=opus)', async () => {
    const h = harness();
    const res = await postVoice(h, form(new Blob([WEBM], { type: 'audio/webm;codecs=opus' })));
    expect(res.status).toBe(200);
  });

  it('asks for no language, so Hebrew and English notes are both detected', async () => {
    let language: unknown = 'unset';
    const h = harness({
      transcriber: standIn(
        async () => ({ text: 'ok' }),
        (job) => {
          language = job.language;
        },
      ),
    });
    await postVoice(h);
    expect(language).toBeUndefined();
  });

  it('tells the engine once the note is typed out (for the usage line)', async () => {
    const onTranscribed = vi.fn();
    const h = harness({ onTranscribed });
    await postVoice(h);
    expect(onTranscribed).toHaveBeenCalledTimes(1);
  });

  it('does not fail the note when the usage line throws', async () => {
    const h = harness({
      onTranscribed: () => {
        throw new Error('disk full');
      },
    });
    expect((await postVoice(h)).status).toBe(200);
  });

  it('does not report a usage line for a note that failed', async () => {
    const onTranscribed = vi.fn();
    const h = harness({
      onTranscribed,
      transcriber: standIn(async () => {
        throw new TranscriptionError('failed', 'nope');
      }),
    });
    await postVoice(h);
    expect(onTranscribed).not.toHaveBeenCalled();
  });

  it('answers 400 for a type that is not a recording', async () => {
    const h = harness();
    const res = await postVoice(h, form(new Blob([WEBM], { type: 'audio/ogg' })));
    expect(await errorOf(res, 400)).toBe(GRAPHIC_MESSAGES.badRecording);
    expect(await h.leftovers()).toEqual([]);
  });

  it('answers 400 for an empty recording', async () => {
    const h = harness();
    const res = await postVoice(h, form(new Blob([], { type: 'audio/webm' })));
    expect(await errorOf(res, 400)).toBe(GRAPHIC_MESSAGES.badRecording);
  });

  it('answers 400 for a form with no audio, and for a body that is not a form', async () => {
    const h = harness();
    expect(await errorOf(await postVoice(h, form(null)), 400)).toBe(GRAPHIC_MESSAGES.badRecording);
    const json = await postVoice(h, '{"audio":"x"}', { 'Content-Type': 'application/json' });
    expect(await errorOf(json, 400)).toBe(GRAPHIC_MESSAGES.badRecording);
  });

  it('answers 400 when the audio field is plain text, not a file', async () => {
    const h = harness();
    const body = new FormData();
    body.append('audio', 'not a file');
    expect(await errorOf(await postVoice(h, body), 400)).toBe(GRAPHIC_MESSAGES.badRecording);
  });

  it('answers 413 for a recording over the limit, before it is read', async () => {
    const h = harness({ voiceMaxBytes: 1024 });
    const res = await postVoice(h, form(new Blob([new Uint8Array(2048)], { type: 'audio/webm' })));
    expect(await errorOf(res, 413)).toBe(GRAPHIC_MESSAGES.recordingTooLarge);
    expect(await h.leftovers()).toEqual([]);
  });

  it('answers 413 for a body far over the limit', async () => {
    const h = harness({ voiceMaxBytes: 1024 });
    const res = await postVoice(
      h,
      form(new Blob([new Uint8Array(200 * 1024)], { type: 'audio/webm' })),
    );
    expect(await errorOf(res, 413)).toBe(GRAPHIC_MESSAGES.recordingTooLarge);
  });

  it('uses the same limit as the review voice notes by default', async () => {
    expect(VOICE_NOTE_MAX_BYTES).toBe(25 * 1024 * 1024);
    const h = harness();
    const res = await postVoice(
      h,
      form(new Blob([new Uint8Array(1024 * 1024)], { type: 'audio/webm' })),
    );
    expect(res.status).toBe(200);
  });

  it('answers 422 when nothing was said', async () => {
    const h = harness({
      transcriber: standIn(async () => {
        throw new TranscriptionError('no_speech', 'No speech was heard in the voice note.');
      }),
    });
    expect(await errorOf(await postVoice(h), 422)).toBe(GRAPHIC_MESSAGES.noSpeech);
    expect(await h.leftovers()).toEqual([]);
  });

  it('answers 422 when the transcript comes back blank', async () => {
    const h = harness({ transcriber: standIn(async () => ({ text: '  ' })) });
    expect(await errorOf(await postVoice(h), 422)).toBe(GRAPHIC_MESSAGES.noSpeech);
  });

  it.each(['failed', 'timed_out', 'cancelled', 'stopped'] as const)(
    'answers 500 with a plain sentence when the transcriber says %s, and deletes the file',
    async (code) => {
      const h = harness({
        transcriber: standIn(async () => {
          throw new TranscriptionError(code, 'internal detail with sk_abcdef123456');
        }),
      });
      const res = await postVoice(h);
      const message = await errorOf(res, 500);
      expect(message).toBe(GRAPHIC_MESSAGES.voiceFailed);
      expect(message).not.toContain('sk_');
      expect(await h.leftovers()).toEqual([]);
    },
  );

  it('answers 500 for anything unexpected', async () => {
    const h = harness({
      transcriber: standIn(async () => {
        throw new Error('boom');
      }),
    });
    expect(await errorOf(await postVoice(h), 500)).toBe(GRAPHIC_MESSAGES.voiceFailed);
    expect(await h.leftovers()).toEqual([]);
  });

  it('answers 500 when the recording cannot be saved', async () => {
    const h = harness();
    // The data folder is a file, so <data>/graphic-voice/ cannot be made.
    rmSync(h.dataDir, { recursive: true, force: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(h.dataDir, 'not a folder');
    expect(await errorOf(await postVoice(h), 500)).toBe(GRAPHIC_MESSAGES.voiceFailed);
  });

  it('handles two recordings at once, each in its own folder', async () => {
    const dirsSeen = new Set<string>();
    const h = harness({
      transcriber: standIn(
        async () => ({ text: 'ok' }),
        (job) => dirsSeen.add(job.outDir),
      ),
    });
    const [a, b] = await Promise.all([postVoice(h), postVoice(h)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(dirsSeen.size).toBe(2);
    expect(await h.leftovers()).toEqual([]);
  });
});

// The route as app.ts mounts it: before the graphics routes, so "voice" is not taken for a
// graphic's id, and only while the Graphics switch is on.
describe('POST /api/graphics/voice in the app', () => {
  function appWith(graphics: boolean) {
    const dataDir = mkdtempSync(join(tmpdir(), 'studio-graphic-voice-app-'));
    dirs.push(dataDir);
    const transcriber = createVoiceTranscriber({ kind: 'fake', sleep: async () => {} });
    transcribers.push(transcriber);
    const db = memoryDb();
    const app = createApp({
      graphics,
      graphicsRoutes: {
        graphics: { service: createDisabledGraphicService() },
        files: {
          graphics: new GraphicRepository(db),
          inboxPath: dataDir,
          assetsDir: GRAPHICS_ASSETS_DIR,
        },
        voice: { transcriber, dataDir },
      },
    });
    return { app, db };
  }

  it('types the recording out while Graphics are on', async () => {
    const { app, db } = appWith(true);
    const res = await app.request('/api/graphics/voice', { method: 'POST', body: form() });
    expect(res.status).toBe(200);
    expect(graphicVoiceResponseSchema.parse(await res.json())).toEqual({ text: FAKE_VOICE_TEXT });
    db.close();
  });

  it('answers 404 "Graphics are off." while the switch is off', async () => {
    const { app, db } = appWith(false);
    const res = await app.request('/api/graphics/voice', { method: 'POST', body: form() });
    expect(await errorOf(res, 404)).toBe(GRAPHIC_MESSAGES.off);
    db.close();
  });
});
