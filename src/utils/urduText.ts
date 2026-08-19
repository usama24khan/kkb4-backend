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
 * A comma-separated list needs both passes: the items reverse, and so do the
 * words inside each item, or a multi-word item reads backwards ("پلاٹ نمبر"
 * rendered as "نمبر پلاٹ").
 */
export function rtlWords(text: string): string {
  const words = (t: string) => t.split(" ").reverse().join(" ");
  if (text.includes("، ")) {
    return text.split("، ").reverse().map(words).join("، ");
  }
  return words(text);
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
