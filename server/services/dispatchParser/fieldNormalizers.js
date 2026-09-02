/**
 * Normalizing one parsed dispatch FIELD — pure functions.
 *
 * Rate confirmations are written by hundreds of brokers in inconsistent
 * formats, so each field has its own tolerant reader: dates and times, company
 * and street, city/state, rate, miles and reference numbers. Keeping them
 * separate from the extraction that calls them is what makes each format quirk
 * testable on its own.
 *
 * Split out of server/services/dispatchParserService.js.
 */

function normalizeDispatchValue(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitInstructionTail(value) {
  const text = normalizeDispatchValue(value);
  if (!text) return { clean: '', note: '' };
  const markerIndex = text.search(/\b(?:Pickup Instructions?|Delivery Instructions?|Instructions?|Contact|Pickup Number|Delivery Number|Appt Notes?|Ref\s*#|Seal\s*#)\b/i);
  if (markerIndex === -1) {
    return { clean: text, note: '' };
  }
  return {
    clean: text.slice(0, markerIndex).trim(),
    note: text.slice(markerIndex).trim(),
  };
}

function normalizeDispatchDateTime(value) {
  const text = normalizeDispatchValue(value)
    .replace(/Expected Date:\s*/ig, '')
    .replace(/Appointment Time:\s*/ig, '')
    .replace(/\bAppointment:\s*/ig, '')
    .replace(/Hours\s*:\s*/ig, '');
  const split = splitInstructionTail(text);

  const dateMatch = split.clean.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/);
  const timeMatch = split.clean.match(/\b(?:\d{1,2}:\d{2}\s*(?:AM|PM)?\s*-\s*\d{1,2}:\d{2}\s*(?:AM|PM)?|\d{4}\s*-\s*\d{4}|\d{1,2}:\d{2}\s*(?:AM|PM)?)\b/i);
  if (dateMatch || timeMatch) {
    return {
      clean: normalizeDispatchValue([dateMatch?.[0] || '', timeMatch?.[0] || ''].filter(Boolean).join(' ')),
      note: split.note,
    };
  }

  return split;
}

function normalizeDispatchCompany(value) {
  const cleaned = normalizeDispatchValue(value)
    .replace(/^SEAL\s*#?\s*/i, '')
    .replace(/^STOP\s*\d+\s*/i, '')
    .trim();
  if (!cleaned || /^\d/.test(cleaned)) {
    return '';
  }
  return cleaned;
}

function normalizeDispatchStreet(value) {
  return normalizeDispatchValue(value)
    .replace(/\s+(?:Appointment|Appt Notes?:?|Hours\s*:|Pieces:|Weight:|Seal\s*#|Ref\s*#).*/i, '')
    .trim();
}

function normalizeDispatchCity(value) {
  const cleaned = normalizeDispatchValue(value)
    .replace(/\s+(?:Appointment|Appt Notes?:?|Hours\s*:|Pieces:|Weight:|Seal\s*#|Ref\s*#).*/i, '')
    .replace(/\bUS\b\s+(?=\d{5}(?:-\d{4})?$)/i, '')
    .replace(/\s+,/g, ',');
  const compact = cleaned.replace(/\s{2,}/g, ' ');
  const stateZip = compact.match(/^(.+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
  if (stateZip) {
    return `${stateZip[1].trim().replace(/,\s*$/, '')}, ${stateZip[2].toUpperCase()} ${stateZip[3]}`;
  }
  return compact;
}

function normalizeDispatchRate(value) {
  const cleaned = normalizeDispatchValue(value).replace(/^USD\s*/i, '').replace(/^\$+/, '');
  return cleaned ? `$${cleaned}` : '';
}

function normalizeDispatchMiles(value) {
  const match = normalizeDispatchValue(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return match ? match[0] : '';
}

function normalizeDispatchReference(value) {
  const cleaned = normalizeDispatchValue(value);
  if (!cleaned) return '';
  const numericMatches = cleaned.match(/\b\d{5,}\b/g);
  if (numericMatches && numericMatches.length > 0) {
    return numericMatches[numericMatches.length - 1];
  }
  return cleaned;
}

function firstNonEmpty(...values) {
  return values.map((value) => normalizeDispatchValue(value)).find(Boolean) || '';
}

function chooseDispatchPoNumber(parsedPoNumber, aiPoNumber, mergedPuNumber) {
  const parsedValue = normalizeDispatchValue(parsedPoNumber);
  if (parsedValue) return parsedValue;

  const aiValue = normalizeDispatchValue(aiPoNumber);
  if (!aiValue) return '';
  if (mergedPuNumber) {
    const normalizedPickupReference = normalizeDispatchReference(mergedPuNumber);
    const normalizedPoReference = normalizeDispatchReference(aiValue);
    if (aiValue === mergedPuNumber || (
      normalizedPickupReference
      && normalizedPoReference
      && normalizedPickupReference === normalizedPoReference
    )) {
      return '';
    }
  }
  return aiValue;
}

module.exports = {
  normalizeDispatchValue,
  splitInstructionTail,
  normalizeDispatchDateTime,
  normalizeDispatchCompany,
  normalizeDispatchStreet,
  normalizeDispatchCity,
  normalizeDispatchRate,
  normalizeDispatchMiles,
  normalizeDispatchReference,
  firstNonEmpty,
  chooseDispatchPoNumber,
};
