# Test fonts (Fonts · FN0 · CVP-333)

Six small real font files and one broken one, for the font reader, the check and the import of the
Fonts feature. Tests copy what they need into a temp inbox; they never read or write the owner's real
`~/Studio Inbox/_Fonts`.

**Source and licence.** All six real files come from Google Fonts and are licensed under the SIL
Open Font License 1.1 (<https://openfontlicense.org>). They are copies of the files in the owner's
`_Fonts` folder (copied, not moved), unchanged. Copyright lines are inside each file's name table:
Bellefair (The Bellefair Project Authors), Oswald (The Oswald Project Authors), Outfit (The Outfit
Project Authors), Secular One (The Secular One Project Authors), Varela Round (The Varela Round
Project Authors). `broken-cut-short.ttf` is made from Outfit Regular, so it carries Outfit's licence.

"Hebrew" below means the file's cmap covers every letter U+05D0–U+05EA, which is how the app tells
(never the folder the file sits in). The values were read from the files themselves.

| File | Family | Weight | Italic | Hebrew | Script label | Style (from the plan) | Bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SecularOne-Regular.ttf` | Secular One | 400 | no | yes | Hebrew + English | Display | 79,828 |
| `Bellefair-Regular.ttf` | Bellefair | 400 | no | yes | Hebrew + English | Serif | 62,548 |
| `VarelaRound-Regular.ttf` | Varela Round | 400 | no | yes | Hebrew + English | Rounded | 129,520 |
| `Outfit-Regular.ttf` | Outfit | 400 | no | no | English only | Sans | 47,844 |
| `Outfit-Bold.ttf` | Outfit | 700 | no | no | English only | Sans | 48,340 |
| `Oswald-Regular.ttf` | Oswald | 400 | no | no | English only | Condensed | 86,068 |
| `broken-cut-short.ttf` | (none: not readable) | | | | | | 2,048 |

Face names the app derives from them: `Secular One`, `Bellefair`, `Varela Round`, `Outfit`,
`Outfit Bold`, `Oswald` (a Regular face is named by its family alone).

## The web-font samples (FN2 · CVP-335)

`Outfit-Bold.woff` and `Outfit-Bold.woff2` are `Outfit-Bold.ttf` wrapped as a web font, for the font
reader's .woff and .woff2 tests. They read as the same face: Outfit, 700, no Hebrew, format `woff`
and `woff2`. Same licence as Outfit (SIL OFL 1.1). The .woff has each table deflated with zlib; the
.woff2 was made with the `wawoff2` encoder (Google's woff2 library), so its glyf table is
transformed like a real web font's.

## The broken file

`broken-cut-short.ttf` is the first 2048 bytes of `Outfit-Regular.ttf`: it starts like a TrueType
file (the `00 01 00 00` header and the table directory are intact) but ends before its tables do.
The check must answer "Not a font: the file is cut short." Make it again with:

```sh
head -c 2048 Outfit-Regular.ttf > broken-cut-short.ttf
```

## Handy combinations for tests

- Import one family: `Outfit-Regular.ttf` + `Outfit-Bold.ttf` are two weights of the same family
  ("Outfit", English only); either alone is `new`, and with the other already in the library it
  `adds 1 weight to Outfit.`
- The same file twice is `same`: "Already here with the same 1 weight. Skipped."
- Hebrew + English vs English only: the three Hebrew files go to `Hebrew + English/<Family>/`, the
  three English ones to `English only/<Family>/`.
- A lone `.txt` or a `.ttc` is a bad item with its own sentence (see `FONT_MESSAGES` in
  `packages/shared/src/domain/fonts.ts`); these are not stored here, tests write them.
