/**
 * Reproduces the server's single-line sweep byte-for-byte.
 *
 * Every character in Unicode categories Cc, Cf, Cs, Co, Zl and Zp becomes a
 * single space before storage. No Unicode normalization is applied, so NFC
 * and NFD forms stay distinct. Under the /u flag surrogate pairs are read as
 * whole code points, so emoji survive and only lone surrogates are swept.
 */
const SWEEP = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

export function sanitize(text: string): string {
  return text.replace(SWEEP, ' ');
}
