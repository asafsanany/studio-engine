// Dev check for the voice-note transcriber (W6 · CVP-115): transcribes one recording and prints the text.
//   pnpm --filter @studio/server exec tsx src/dev/transcribe-voice.ts /abs/note.webm --language he
//   pnpm --filter @studio/server exec tsx src/dev/transcribe-voice.ts /abs/note.m4a --out /abs/dir
//   pnpm --filter @studio/server exec tsx src/dev/transcribe-voice.ts /abs/note.webm --fake
// A real run uploads the audio to ElevenLabs (a fraction of a cent for a few seconds). The JSON goes to
// <out>/transcripts/<stem>.json (default <out>: the recording's folder); running it again reads that back for free.
//
// Options: --language <xx> (a two-letter code; none means auto-detect), --out <dir>, --fake (the fake
// transcriber, no helper and no upload), --timeout-ms <n> (default 120000). Ctrl+C cancels the run.
// It prints the result and nothing else: no environment, no key. Dev-only: nothing imports it.

import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createVoiceTranscriber, TranscriptionError } from '../pipeline/voice-transcriber.js';

const USAGE =
  'Usage: tsx src/dev/transcribe-voice.ts <absolute recording path> [--language xx] [--out dir] [--fake] [--timeout-ms n]';

async function main(): Promise<number> {
  // `pnpm … -- --fake` reaches here as `-- --fake`: drop the separator.
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    allowPositionals: true,
    options: {
      language: { type: 'string' },
      out: { type: 'string' },
      fake: { type: 'boolean' },
      'timeout-ms': { type: 'string' },
    },
  });
  const [recording] = positionals;
  const timeoutMs = values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']);
  if (
    recording === undefined ||
    positionals.length !== 1 ||
    (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0))
  ) {
    console.error(USAGE);
    return 2;
  }

  const audioPath = resolve(recording);
  const outDir = resolve(values.out ?? dirname(audioPath));
  const transcriber = createVoiceTranscriber({
    kind: values.fake ? 'fake' : 'real',
    concurrency: 1,
    timeoutMs,
  });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());

  const startedAt = Date.now();
  try {
    const { text } = await transcriber.enqueue({
      audioPath,
      outDir,
      language: values.language,
      signal: controller.signal,
    });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`${basename(audioPath)}: "${text}" (${seconds} s)`);
    return 0;
  } catch (err) {
    const error =
      err instanceof TranscriptionError ? err : new TranscriptionError('failed', String(err));
    console.error(`${basename(audioPath)}: not transcribed [${error.code}] ${error.message}`);
    return 1;
  } finally {
    await transcriber.stop();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
