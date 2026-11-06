'use strict';

/**
 * Text a PDF's built-in font can print. Pure.
 *
 * The PDF is drawn with Helvetica, one of the fonts every PDF reader has, so
 * nothing is embedded and the file stays small. Helvetica speaks WinAnsi —
 * Latin letters and common punctuation — and pdf-lib REFUSES the whole page on
 * a letter it cannot encode. Driver groups carry Russian and Uzbek names
 * ("Шерзод"), emoji and curly quotes, so every string that reaches the PDF
 * comes through here: Cyrillic is written in Latin letters, accents are taken
 * off, typographic punctuation is made plain, and anything else becomes "?".
 *
 * The PDF is in English (the owner, 6 November 2026); a name in Latin letters
 * is what an English reader can use.
 */

const CYRILLIC = Object.freeze({
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Uzbek Cyrillic
  ў: "o'", қ: 'q', ғ: "g'", ҳ: 'h',
  // Ukrainian / Kazakh letters that turn up in names
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ң: 'ng', ү: 'u', ұ: 'u', ө: 'o', ә: 'a',
});

const PUNCTUATION = Object.freeze({
  '‘': "'", '’': "'", '‚': "'", '‛': "'", 'ʼ': "'", 'ʻ': "'",
  '“': '"', '”': '"', '„': '"', '«': '"', '»': '"',
  '–': '-', '—': '-', '−': '-', '…': '...', '•': '*', '·': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', '№': 'No.',
});

function transliterate(ch) {
  const lower = ch.toLowerCase();
  const latin = CYRILLIC[lower];
  if (latin === undefined) return null;
  if (ch === lower || !latin) return latin;
  return latin.charAt(0).toUpperCase() + latin.slice(1);
}

/**
 * @param {*} value
 * @param {number} [maxLength]
 * @returns {string} printable ASCII only
 */
function pdfSafeText(value, maxLength = 300) {
  const source = value === null || value === undefined ? '' : String(value);
  let out = '';
  for (const ch of source) {
    const latin = transliterate(ch);
    if (latin !== null) { out += latin; continue; }
    if (PUNCTUATION[ch] !== undefined) { out += PUNCTUATION[ch]; continue; }
    // Accents off ("é" → "e"), then only printable ASCII survives.
    const plain = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    if (/^[\x20-\x7e]+$/.test(plain)) { out += plain; continue; }
    if (/\s/.test(ch)) { out += ' '; continue; }
    // Emoji, their joiners and selectors are dropped; any other letter is "?".
    if (/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍︎️⃣]/u.test(ch)) continue;
    out += '?';
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = { pdfSafeText };
