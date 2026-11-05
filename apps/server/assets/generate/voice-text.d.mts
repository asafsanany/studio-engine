// Types of voice-text.mjs, the word comparison of `make-voice.mjs check` (Generated videos, GN2).

export function numberWords(n: number): string;
export function ordinalWords(n: number): string;
export function spellNumbers(text: string): string;

/** One word of a text: `norm` is what is compared, `surface` is the word as it was written. */
export interface VoiceToken {
  norm: string;
  surface: string;
}

export function tokens(text: string): VoiceToken[];

export function compareWords(
  scriptText: string,
  heardTexts: string[],
): { match: boolean; missing: string[]; extra: string[] };
