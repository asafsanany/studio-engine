// What a spec knows about the sound in a file: how long it is, how loud, and what pitch. The fake
// music is a tone with its own note for every version (440 Hz for v1, 523.25 Hz for v2 …) and No music is
// silence, so "the export has the music that was picked" is read from the export's decoded audio:
// the pitch of the tone and its loudness, with the audio stream's length from ffprobe. Decoding
// (ffmpeg) rather than comparing bytes, because the export's sound went through AAC.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The decoded rate: 8 kHz holds the tones of the fake music (about 400 to 700 Hz) with room to spare. */
const RATE = 8_000;

export interface AudioFingerprint {
  /** The audio stream's length in seconds (ffprobe), or the file's when the stream has none. */
  durationSec: number;
  /** Loudness: the RMS of the samples, 0 (silence) to 1 (full scale). */
  rms: number;
  /** Pitch of a tone, from the zero crossings of the samples; 0 for silence. */
  hz: number;
}

/** The fingerprint of the audio in `file` (an mp3, or an mp4 with a sound track). */
export async function audioFingerprint(file: string): Promise<AudioFingerprint> {
  const { stdout: pcm } = await execFileAsync(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      file,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(RATE),
      '-f',
      's16le',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
  );
  // A copy, so the samples start on an even byte (a Buffer may sit anywhere in a shared pool).
  const even = pcm.length - (pcm.length % 2);
  const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + even));
  let sum = 0;
  let crossings = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] as number;
    sum += (value / 32768) ** 2;
    if (i > 0 && (samples[i - 1] as number) < 0 !== value < 0) crossings += 1;
  }
  const seconds = samples.length / RATE;
  const probe = async (entries: string, stream?: string): Promise<number> => {
    const args = ['-v', 'error', ...(stream ? ['-select_streams', stream] : [])];
    const { stdout } = await execFileAsync('ffprobe', [
      ...args,
      ...['-show_entries', entries, '-of', 'default=noprint_wrappers=1:nokey=1', file],
    ]);
    return Number.parseFloat(stdout.trim());
  };
  const streamLength = await probe('stream=duration', 'a:0').catch(() => Number.NaN);
  const length = Number.isFinite(streamLength) ? streamLength : await probe('format=duration');
  return {
    durationSec: length,
    rms: samples.length === 0 ? 0 : Math.sqrt(sum / samples.length),
    hz: seconds === 0 ? 0 : crossings / 2 / seconds,
  };
}

/** Whether a fingerprint is of silence: nothing a person would hear (about -60 dBFS). */
export function isSilent(sound: AudioFingerprint): boolean {
  return sound.rms < 0.001;
}

/** Whether two fingerprints are of the same tone: the same pitch (2 %) and about as loud (within a quarter). */
export function sameSound(a: AudioFingerprint, b: AudioFingerprint): boolean {
  const pitch = a.hz > 0 && Math.abs(a.hz - b.hz) / a.hz < 0.02;
  const level = a.rms > 0 && Math.abs(a.rms - b.rms) / a.rms < 0.25;
  return pitch && level;
}
