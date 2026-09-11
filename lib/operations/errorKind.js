'use strict';

/**
 * What KIND of failure this is, in a word that cannot contain a value.
 *
 * WHY THIS EXISTS. A critical worker reached eighteen consecutive failures in
 * production and the only thing any public surface could say about it was "18
 * consecutive failures". True, and impossible to act on. The message itself is
 * in the ledger and on the authenticated admin screen, where it belongs — an
 * `err.message` can quote a value a database rejected, and `/api/health` is
 * read by Render and an uptime monitor.
 *
 * So the message stays private and its CLASSIFICATION travels. "A column is
 * missing" and "a connection timed out" are different afternoons, and a
 * category is enough to tell them apart while being, by construction, incapable
 * of carrying a driver's name or a row's contents: every value returned here is
 * one of a fixed list written in this file.
 *
 * THE FALLBACK IS `other`, NOT A GUESS. An unrecognised message classifies as
 * `other` rather than being squeezed into the nearest category — a wrong
 * category is worse than none, because somebody would go and look in the wrong
 * place.
 *
 * AND A BARE NUMBER IS NOT A STATUS CODE. The first version of this matched
 * `429`, `404`, `401` and `403` anywhere in the message, and this application
 * is full of numeric identifiers: "could not read group 429" classified as
 * rate-limited, and "road_history 404 is missing" as not-found. I believed one
 * of those readings about a live failure before noticing.
 *
 * That is the wrong-category failure this file warns about, committed by this
 * file. A numeric code now only counts beside something that makes it a code —
 * `HTTP 429`, `status: 404`, `401 Unauthorized` — and a number sitting next to
 * a noun is left to the word patterns or to `other`.
 */

/** Every value this can return. Nothing outside this list ever travels. */
const KINDS = Object.freeze([
  'missing_table',
  'missing_column',
  'constraint',
  'connection',
  'timeout',
  'permission',
  'rate_limited',
  'not_found',
  'type_error',
  'reference_error',
  'syntax_error',
  'out_of_memory',
  'bad_value',
  'decrypt',
  'other',
]);

/** Ordered: the first match wins, so the most specific patterns come first. */
const PATTERNS = [
  [/relation .* does not exist|no such table|undefined table/i, 'missing_table'],
  [/column .* does not exist|undefined column|no such column/i, 'missing_column'],
  [/violates .*constraint|duplicate key|foreign key|not-null|check constraint/i, 'constraint'],
  [/ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|connection terminated|could not connect/i, 'connection'],
  [/ETIMEDOUT|timed? ?out|deadline exceeded|AbortError/i, 'timeout'],
  [
    new RegExp(
      'permission denied|not authori[sz]ed|forbidden'
      // A code only counts beside something that makes it a code.
      + '|(?:http|status|code|statuscode|status code|api)\\W{0,3}(?:401|403)\\b'
      + '|\\b(?:401|403)\\s+(?:unauthori[sz]ed|forbidden)\\b',
      'i'
    ),
    'permission',
  ],
  [
    new RegExp(
      'rate.?limit|too many requests|quota'
      + '|(?:http|status|code|statuscode|status code|api)\\W{0,3}429\\b'
      + '|\\b429\\s+too\\s+many\\b',
      'i'
    ),
    'rate_limited',
  ],
  [
    new RegExp(
      'not found'
      + '|(?:http|status|code|statuscode|status code|api)\\W{0,3}404\\b'
      + '|\\b404\\s+not\\s+found\\b',
      'i'
    ),
    'not_found',
  ],
  [/out of memory|heap|ENOMEM/i, 'out_of_memory'],
  // THE TWO COMMONEST `other`s IN THIS APPLICATION, and `other` is the one
  // category that tells a person nothing. A worker failing every pass for days
  // could only say "the message is on the What is running screen", which is not
  // an answer on a phone at night.
  //
  // A value that was refused is a DATA problem — a NaN where an integer
  // belongs, a string past its column width, a timestamp out of range — and it
  // is fixed in the code that produced the value, never by a restart. Usually
  // the refusal comes from Postgres, but Node raises the same shape, so the
  // sentence says "refused as invalid" rather than naming the database.
  // Nothing here can leak the value: the KIND is a word from the list above,
  // and the message that quotes it stays where it already was.
  [
    /invalid input syntax|value too long|out of range|field overflow|cannot be cast|invalid byte sequence/i,
    'bad_value',
  ],
  // And a stored secret that will not open. `unable to authenticate data` is
  // Node's AES-GCM failure and means the key changed or the ciphertext did;
  // no amount of retrying fixes it, and it looks like nothing else.
  [/unable to authenticate data|unsupported state|bad decrypt|wrong final block length/i, 'decrypt'],
  [/is not a function|cannot read propert|undefined is not|of undefined|of null/i, 'type_error'],
  [/is not defined/i, 'reference_error'],
  [/unexpected token|syntax error/i, 'syntax_error'],
];

/**
 * @param {string|Error|null} error
 * @returns {string|null} one of KINDS, or null when there is no error at all
 */
function classifyErrorKind(error) {
  if (error == null) return null;
  const text = typeof error === 'string' ? error : String(error?.message || error);
  if (!text.trim()) return 'other';
  for (const [pattern, kind] of PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return 'other';
}

/** A sentence for a person, built only from the category. */
function describeErrorKind(kind) {
  switch (kind) {
    case 'missing_table': return 'a table it reads does not exist';
    case 'missing_column': return 'a column it reads does not exist';
    case 'constraint': return 'a write was refused by the database';
    case 'connection': return 'it could not reach something it depends on';
    case 'timeout': return 'something it depends on did not answer in time';
    case 'permission': return 'it was refused access to something';
    case 'rate_limited': return 'it was rate-limited or out of quota';
    case 'not_found': return 'something it asked for was not there';
    case 'type_error': return 'a value was not the shape the code expected';
    case 'reference_error': return 'the code referred to something that does not exist';
    case 'syntax_error': return 'something it parsed was malformed';
    case 'out_of_memory': return 'it ran out of memory';
    case 'bad_value': return 'a value was refused as invalid or out of range';
    case 'decrypt': return 'a stored secret could not be decrypted';
    case 'other': return 'the reason is on the What is running screen';
    default: return null;
  }
}

module.exports = { KINDS, classifyErrorKind, describeErrorKind };
