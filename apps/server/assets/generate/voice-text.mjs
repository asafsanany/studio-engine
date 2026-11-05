// The words of a voice line, for `make-voice.mjs check` (Generated videos, GN2): turns the script's
// text and the words Scribe heard into the same plain tokens, then says which script words were
// not heard (`missing`) and which heard words are not in the script (`extra`).
//
// Both sides go through the same steps, so "$97", "97 dollars" and "ninety-seven dollars" are the
// same three tokens; case, punctuation, hyphens and apostrophes do not matter. Plain Node, no
// dependencies.

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = [
  [1_000_000_000, 'billion'],
  [1_000_000, 'million'],
  [1_000, 'thousand'],
];

/** Every word `numberWords` can say: "and" between two of these is not a word of the script. */
const NUMBER_WORDS = new Set([
  ...ONES,
  ...TENS.filter(Boolean),
  'hundred',
  'thousand',
  'million',
  'billion',
]);

/** A whole number as English words: 97 is "ninety seven", 101 is "one hundred one". */
export function numberWords(n) {
  if (!Number.isSafeInteger(n) || n < 0) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return n % 10 === 0 ? TENS[n / 10] : `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}`;
  if (n < 1000) {
    const rest = n % 100;
    return `${ONES[Math.floor(n / 100)]} hundred${rest === 0 ? '' : ` ${numberWords(rest)}`}`;
  }
  for (const [size, name] of SCALES) {
    if (n >= size) {
      const rest = n % size;
      return `${numberWords(Math.floor(n / size))} ${name}${rest === 0 ? '' : ` ${numberWords(rest)}`}`;
    }
  }
  return String(n);
}

const ORDINAL_IRREGULAR = {
  one: 'first',
  two: 'second',
  three: 'third',
  five: 'fifth',
  eight: 'eighth',
  nine: 'ninth',
  twelve: 'twelfth',
};

/** A whole number as an ordinal: 3 is "third", 21 is "twenty first", 40 is "fortieth". */
export function ordinalWords(n) {
  const words = numberWords(n).split(' ');
  const last = words.pop();
  if (last in ORDINAL_IRREGULAR) words.push(ORDINAL_IRREGULAR[last]);
  else if (last.endsWith('y')) words.push(`${last.slice(0, -1)}ieth`);
  else words.push(`${last}th`);
  return words.join(' ');
}

const CURRENCY = { $: 'dollars', '€': 'euros', '£': 'pounds', '₪': 'shekels' };

/** "4.5" as "four point five"; a number too big to be exact stays digits. */
function decimalWords(text) {
  const [whole, fraction] = text.replace(/,/g, '').split('.');
  const spelled = numberWords(Number(whole));
  if (fraction === undefined) return spelled;
  return `${spelled} point ${[...fraction].map((digit) => ONES[Number(digit)]).join(' ')}`;
}

/** Digits, "$" and "%" spelled as words; nothing else changes. */
export function spellNumbers(text) {
  return text
    .replace(/([$€£₪])\s?(\d[\d,]*(?:\.\d+)?)/g, (_all, sign, amount) => {
      return ` ${decimalWords(amount)} ${CURRENCY[sign]} `;
    })
    .replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, (_all, amount) => ` ${decimalWords(amount)} percent `)
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, (_all, n) => ` ${ordinalWords(Number(n))} `)
    .replace(/\d[\d,]*(?:\.\d+)?/g, (amount) => ` ${decimalWords(amount)} `);
}

/** Words that are only the speaker clearing their throat: never an "extra" word of a take. */
const FILLERS = new Set(['um', 'uh', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm']);

/**
 * The tokens of a text: `norm` is what is compared (lower case, letters and digits only, numbers
 * spelled, apostrophes dropped), `surface` is the word as it was written, for the report.
 */
export function tokens(text) {
  const spelled = spellNumbers(
    String(text)
      .normalize('NFKC')
      .replace(/[’‘`´]/g, "'")
      .replace(/&/g, ' and '),
  );
  const out = [];
  for (const piece of spelled.split(/[^\p{L}\p{N}']+/u)) {
    const surface = piece.replace(/^'+|'+$/g, '');
    const norm = surface.replace(/'/g, '').toLowerCase();
    if (norm !== '') out.push({ norm, surface });
  }
  // "one hundred and one" and "one hundred one" are the same number.
  return out.filter(
    (token, at) =>
      !(
        token.norm === 'and' &&
        at > 0 &&
        at < out.length - 1 &&
        NUMBER_WORDS.has(out[at - 1].norm) &&
        NUMBER_WORDS.has(out[at + 1].norm)
      ),
  );
}

/**
 * Compares the script's text with the words that were heard: the longest run of words they have
 * in common is the match, what the script has besides is `missing`, what was heard besides is
 * `extra` (fillers aside). A word said wrong is one missing and one extra. `match` is true when
 * both are empty.
 */
export function compareWords(scriptText, heardTexts) {
  const script = tokens(scriptText);
  const heard = tokens(heardTexts.join(' ')).filter((token) => !FILLERS.has(token.norm));
  const rows = script.length + 1;
  const cols = heard.length + 1;
  // lcs[i][j]: the common run of the last (script.length - i) script words and (heard.length - j) heard words.
  const lcs = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = script.length - 1; i >= 0; i -= 1) {
    for (let j = heard.length - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        script[i].norm === heard[j].norm
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const missing = [];
  const extra = [];
  let i = 0;
  let j = 0;
  while (i < script.length && j < heard.length) {
    if (script[i].norm === heard[j].norm) {
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      missing.push(script[i].surface);
      i += 1;
    } else {
      extra.push(heard[j].surface);
      j += 1;
    }
  }
  for (; i < script.length; i += 1) missing.push(script[i].surface);
  for (; j < heard.length; j += 1) extra.push(heard[j].surface);
  return { match: missing.length === 0 && extra.length === 0, missing, extra };
}
