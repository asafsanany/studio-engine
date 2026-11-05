// A test helper: a real font file under another family name, so a test (or the e2e) has a font that
// is not in the library yet without a second set of font files in the repo. It rewrites every
// occurrence of the old name in the file, in both ways the name table spells a string (UTF-16BE on
// the Windows and Unicode platforms, one byte per letter on the Mac platform), so "Bellefair" /
// "Bellefair Regular" / "Bellefair-Regular" become "Karantina" / "Karantina Regular" /
// "Karantina-Regular" and the family the reader finds is the new one. The new name must have as many
// letters as the old one, so no table changes size or moves. The table checksums are not redone
// (the reader and the browser's font loader do not check them), and the copyright line inside the
// file now names the new family too: this is a test file, never a font to ship.

/** The text as the name table's UTF-16BE records spell it. */
function utf16be(text: string): Buffer {
  const out = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i += 1) out.writeUInt16BE(text.charCodeAt(i), i * 2);
  return out;
}

/** Replaces every `from` in `font` with `to` (the same number of bytes), in place. */
function replaceAll(font: Buffer, from: Buffer, to: Buffer): void {
  for (let at = font.indexOf(from); at !== -1; at = font.indexOf(from, at + from.length)) {
    to.copy(font, at);
  }
}

/** A copy of the font file with the family name `from` rewritten as `to` (the same length). */
export function renameFontFamily(font: Buffer, from: string, to: string): Buffer {
  if (from.length !== to.length) {
    throw new Error(`"${from}" and "${to}" must have the same number of letters.`);
  }
  const copy = Buffer.from(font);
  replaceAll(copy, utf16be(from), utf16be(to));
  replaceAll(copy, Buffer.from(from, 'latin1'), Buffer.from(to, 'latin1'));
  return copy;
}
