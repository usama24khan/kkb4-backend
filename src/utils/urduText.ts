/**
 * Laying out Urdu text in PDFKit.
 *
 * PDFKit places glyph runs left to right whatever the script. Fontkit shapes
 * each Nastaliq word correctly — the letters join and read right to left — but
 * the *word order* stays logical, so the first word lands on the left. A label
 * written "موصولی کی تاریخ" comes out reading "تاریخ کی موصولی": every word
 * present, in the wrong order, which is exactly as wrong as a mirrored sentence.
 *
 * Reversing the words before drawing means PDFKit's left-to-right placement puts
 * the first logical word on the right, which is what an Urdu reader expects.
 * This is not a bidi implementation — it is the narrow trick that works for
 * labels, short values and month lists, which is all these documents contain.
 *
 * Latin-only strings (numbers, dates, e-mail, plot codes) are left untouched:
 * they read left to right inside an Urdu line, as they should.
 */

/** Does this string contain anything outside ASCII — i.e. is it Urdu at all? */
export function hasNonLatin(text: string): boolean {
  return Array.from(text || "").some((c) => c.charCodeAt(0) > 127);
}

/**
 * Reverse word order so a left-to-right renderer draws Urdu right to left.
 *
 * Punctuation is left where it is: fontkit already places a trailing mark on the
 * correct side of the word it belongs to, so moving it by hand puts it back on
 * the wrong side — "ای میل:" came out as "ای: میل".
 *
 * Runs of Latin words keep their own order. An owner called "Muhammad Ahmed
 * Khan" is not three Urdu words: reversing them turned the name into "Khan
 * Ahmed Muhammad". So the whole line reverses, then each Latin run is put back
 * the right way round — which is what a reader expects of a Latin name or an
 * address inside an Urdu sentence.
 *
 * A comma-separated list needs no special case. Reversing every word already
 * puts both the items and their words in reading order, and it keeps each comma
 * attached to the word it follows. Treating the list as items instead moved the
 * comma onto the next item — a sentence came out reading "…روپے سال، 2024" where
 * the comma belongs after "روپے".
 */
function reverseWordsKeepingLatinRuns(text: string): string {
  const tokens = text.split(" ");
  const reversed = tokens.reverse();

  // A token counts as Latin only if it has no Urdu letters at all; "صاحب،" is
  // Urdu, "0300-1234567" and "Phase" are not.
  const isLatin = (t: string) => t.length > 0 && !hasNonLatin(t);

  let i = 0;
  while (i < reversed.length) {
    if (!isLatin(reversed[i])) { i += 1; continue; }
    let j = i;
    while (j + 1 < reversed.length && isLatin(reversed[j + 1])) j += 1;
    if (j > i) {
      const run = reversed.slice(i, j + 1).reverse();
      reversed.splice(i, run.length, ...run);
    }
    i = j + 1;
  }
  return reversed.join(" ");
}

export function rtlWords(text: string): string {
  return reverseWordsKeepingLatinRuns(text || "");
}

/**
 * What to actually draw for a string: reversed when it is Urdu, as-is when it is
 * Latin. Use this at every draw site rather than deciding case by case.
 */
export function forPdf(text: string): string {
  const str = text || "";
  return hasNonLatin(str) ? rtlWords(str) : str;
}

/**
 * Draw one line, handling the Urdu word order.
 *
 * The caller sets the font, size and colour first — this only owns direction and
 * placement, so a mixed document can keep choosing fonts per field.
 */
export function urduLine(
  doc: PDFKit.PDFDocument,
  str: string,
  x: number,
  y: number,
  width: number,
  align: "left" | "right" | "center" = "left",
  lineBreak = true,
): void {
  doc.text(forPdf(str), x, y, { width, align, lineBreak });
}

/**
 * Break Urdu prose into lines that fit a width, in logical order.
 *
 * Letting PDFKit wrap the text itself is not an option: the string handed to it
 * has already had its words reversed, so PDFKit would break it at what is
 * visually the start of the sentence and the lines would come out in the wrong
 * order. Wrapping here, before the reversal, keeps each line a self-contained
 * unit that is then drawn right to left.
 *
 * The caller must have selected the font and size already — the measurement
 * depends on both.
 */
export function wrapUrdu(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
): string[] {
  const words = (text || "").split(" ").filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    // Measured on the drawn form, which is what has to fit.
    if (current && doc.widthOfString(forPdf(candidate)) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
