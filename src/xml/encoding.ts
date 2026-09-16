import iconv from "iconv-lite";

/**
 * mServer speaks Windows-1250. iconv-lite silently replaces characters outside
 * that code page with "?" — a customer named "Kovář" survives, "₿" or "你" does
 * not, and the document would be imported with the data quietly mangled.
 * The connector refuses such input up front instead.
 */
export const POHODA_ENCODING = "win1250";
const MAX_REPORTED_CHARS = 10;

export class EncodingError extends Error {
  readonly code = "unencodable";
  constructor(readonly characters: string[]) {
    super(`text contains ${characters.length} character(s) outside Windows-1250: ${characters.map((c) => JSON.stringify(c)).join(" ")}`);
  }
}

const roundTripCache = new Map<string, boolean>();

/** One code point at a time: an astral character (emoji) encodes to two "?" and would misalign a whole-string diff. */
function survivesRoundTrip(char: string): boolean {
  const cached = roundTripCache.get(char);
  if (cached !== undefined) return cached;
  const ok = iconv.decode(iconv.encode(char, POHODA_ENCODING), POHODA_ENCODING) === char;
  roundTripCache.set(char, ok);
  return ok;
}

/** Pure: which characters of `text` cannot round-trip through Windows-1250 (unique, in order of first occurrence). */
export function unencodableCharacters(text: string): string[] {
  return [...new Set([...text])].filter((ch) => !survivesRoundTrip(ch)).slice(0, MAX_REPORTED_CHARS);
}

/** Returns a plain ArrayBuffer-backed view so it satisfies fetch's BodyInit under strict TS. */
export function encodeForPohoda(xml: string): Uint8Array<ArrayBuffer> {
  const bad = unencodableCharacters(xml);
  if (bad.length > 0) throw new EncodingError(bad);
  const encoded = iconv.encode(xml, POHODA_ENCODING);
  const copy = new Uint8Array(new ArrayBuffer(encoded.length));
  copy.set(encoded);
  return copy;
}

export function decodeFromPohoda(buffer: Buffer): string {
  return iconv.decode(buffer, POHODA_ENCODING);
}
