/**
 * Reading dispatch FIELDS out of raw text — the deterministic parser.
 *
 * This is the fallback that makes the feature work when both AI providers fail:
 * regex/section-based extraction of pickup and delivery stops, load type, and
 * the reference numbers. `mergeDispatchFields` then decides field-by-field
 * whether the AI answer or this one wins.
 *
 * Split out of server/services/dispatchParserService.js.
 */
const { DISPATCH_WARNING_LINES } = require('./constants');
const { stripMarkdownFences, sanitizeDispatchOutput } = require('./aiFailures');
const {
  normalizeDispatchValue, splitInstructionTail, normalizeDispatchDateTime,
  normalizeDispatchCompany, normalizeDispatchStreet, normalizeDispatchCity,
  normalizeDispatchRate, normalizeDispatchMiles, normalizeDispatchReference,
  firstNonEmpty, chooseDispatchPoNumber,
} = require('./fieldNormalizers');

function matchFirstGroup(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) {
      return normalizeDispatchValue(match[1]);
    }
  }
  return '';
}

function extractSection(text, startPattern, endPattern) {
  const source = String(text || '');
  const startIndex = source.search(startPattern);
  if (startIndex === -1) return '';
  const remainder = source.slice(startIndex);
  const endIndex = remainder.search(endPattern);
  return endIndex === -1 ? remainder : remainder.slice(0, endIndex);
}

function inferDispatchLoadType(rawText) {
  const source = String(rawText || '').toLowerCase();

  if (/drop trailer|drop and hook|hook and drop|drop\/hook|drop trailer delivery/.test(source)) {
    return 'DROP AND HOOK';
  }
  if (/live load/.test(source) && /live unload/.test(source)) {
    return 'LIVE / LIVE';
  }
  if (/hook/.test(source) && /drop/.test(source)) {
    return 'DROP AND HOOK';
  }
  if (/live load|live unload/.test(source)) {
    return 'LIVE';
  }
  return '';
}

function isDispatchDetailLine(line) {
  return /^(Expected Date:|Appointment Time:|Appointment\b|Appt\b|Contact:|Phone\/?Contact:|Pickup Number:|Delivery Number:|Instructions:|Hours\s*:|Pieces:|Weight:|Seal\s*#|Ref\s*#)/i.test(line);
}

function parseDispatchLocationLines(lines) {
  const cleaned = lines
    .map((line) => normalizeDispatchValue(line).replace(/\s+(?:Appointment|Appt Notes?:?|Hours\s*:|Pieces:|Weight:|Seal\s*#|Ref\s*#).*/i, '').trim())
    .filter(Boolean);
  const cityIndex = cleaned.findIndex((line) => /\b[A-Za-z.' -]+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(line));
  const city = cityIndex === -1 ? '' : normalizeDispatchCity(cleaned[cityIndex]);
  const streetIndex = cleaned.findIndex((line, idx) => idx !== cityIndex && /^\d/.test(line));
  const street = streetIndex === -1 ? '' : normalizeDispatchStreet(cleaned[streetIndex]);
  const name = cleaned.find((line, idx) => idx !== cityIndex && idx !== streetIndex && !/^\d/.test(line)) || '';
  return {
    name: normalizeDispatchCompany(name),
    street,
    city,
  };
}

function inferDeliveryFallbackFromRawText(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const allCityIndices = lines
    .map((line, idx) => ({ idx, line }))
    .filter((entry) => /\b[A-Za-z.' -]+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(entry.line))
    .map((entry) => entry.idx);
  const pickIndex = lines.findIndex((line) => /^PICK\s*1\b/i.test(line));
  const hardStopIndex = lines.findIndex((line) => /^ALL CARRIER PAYMENTS/i.test(line));
  const scopedCityIndices = allCityIndices.filter((idx) => {
    if (pickIndex !== -1 && idx <= pickIndex) return false;
    if (hardStopIndex !== -1 && idx >= hardStopIndex) return false;
    return true;
  });
  const cityIndices = scopedCityIndices.length >= 2 ? scopedCityIndices : allCityIndices;
  if (cityIndices.length < 2) {
    return {
      dateTime: '',
      name: '',
      street: '',
      city: '',
    };
  }

  const deliveryCityIndex = cityIndices[1];
  const deliveryCityLine = lines[deliveryCityIndex];
  let streetLine = '';
  for (let idx = deliveryCityIndex - 1; idx >= 0 && idx >= deliveryCityIndex - 5; idx -= 1) {
    const candidate = lines[idx];
    if (/^(Hours|Pieces|Weight|Seal|Ref|Phone\/?Contact|Appt Notes)/i.test(candidate)) continue;
    if (/^\d/.test(candidate)) {
      streetLine = candidate;
      break;
    }
  }

  let nameLine = '';
  if (streetLine) {
    const streetIndex = lines.indexOf(streetLine);
    for (let idx = streetIndex - 1; idx >= 0 && idx >= streetIndex - 3; idx -= 1) {
      const candidate = lines[idx];
      if (/^(Hours|Pieces|Weight|Seal|Ref|Phone\/?Contact|Appt Notes|Appointment)/i.test(candidate)) continue;
      if (/\b[A-Za-z.' -]+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(candidate)) continue;
      if (/Pieces:|Weight:|Hours\s*:/i.test(candidate)) continue;
      if (!/^\d/.test(candidate)) {
        nameLine = candidate;
        break;
      }
    }
  }

  const date = matchFirstGroup(`${streetLine}\n${deliveryCityLine}\n${lines.slice(deliveryCityIndex, deliveryCityIndex + 3).join('\n')}`, [
    /Appointment\s*:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
  ]);
  const time = matchFirstGroup(lines.slice(deliveryCityIndex, deliveryCityIndex + 4).join('\n'), [
    /Hours\s*:?\s*([0-9]{3,4}\s*-\s*[0-9]{3,4})/i,
  ]);

  return {
    dateTime: normalizeDispatchValue([date, time].filter(Boolean).join(' ')),
    name: normalizeDispatchCompany(nameLine),
    street: normalizeDispatchStreet(streetLine),
    city: normalizeDispatchCity(deliveryCityLine),
  };
}

function extractStopDetails(sectionText, kind) {
  const section = String(sectionText || '');
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const bodyLines = lines.filter((line, idx) => {
    if (idx === 0 && /^(Shipper Pickup|Consignee Delivery|PICK\s*\d+|STOP\s*\d+)\b/i.test(line)) {
      return false;
    }
    return true;
  });
  const locationLines = bodyLines.filter((line) => !isDispatchDetailLine(line));
  const location = parseDispatchLocationLines(locationLines);

  const referenceLabel = kind === 'pickup'
    ? /Pickup Number:\s*([^\n]+)/i
    : /Delivery Number:\s*([^\n]+)/i;

  const date = matchFirstGroup(section, [
    /Expected Date:\s*([^\n]+)/i,
    /Appointment\s*:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
  ]);
  const time = matchFirstGroup(section, [
    /Appointment Time:\s*([^\n]+)/i,
    /Hours\s*:?\s*([0-9]{3,4}\s*-\s*[0-9]{3,4})/i,
  ]);

  return {
    dateTime: normalizeDispatchValue([date, time].filter(Boolean).join(' ')),
    name: location.name,
    street: location.street,
    city: location.city,
    referenceNumber: normalizeDispatchReference(matchFirstGroup(section, [referenceLabel])),
  };
}

function extractDispatchFields(rawText) {
  const text = String(rawText || '');
  const pickupSection = firstNonEmpty(
    extractSection(text, /Shipper Pickup \(Stop 1\)/i, /Consignee Delivery \(Stop 2\)/i),
    extractSection(text, /(?:^|\n)\s*PICK\s*1\b/i, /(?:^|\n)\s*STOP\s*1\b/i)
  );
  const deliverySection = firstNonEmpty(
    extractSection(text, /Consignee Delivery \(Stop 2\)/i, /--\s*1 of\b/i),
    extractSection(
      text,
      /(?:^|\n)\s*STOP\s*1\b/i,
      /(?:^|\n)\s*(?:ALL CARRIER PAYMENTS|Rate Confirmation Details on Next Page|--\s*\d+\s*of\b)/i
    )
  );
  const pickup = extractStopDetails(pickupSection, 'pickup');
  const delivery = extractStopDetails(deliverySection, 'delivery');
  const deliveryFallback = inferDeliveryFallbackFromRawText(text);

  const usdMatches = Array.from(text.matchAll(/USD\s*([0-9,]+\.\d{2})/gi)).map((match) => match[1]);
  const directRate = matchFirstGroup(text, [
    /Rate\s*:?\s*USD?\s*\$?\s*([0-9,]+\.\d{2})/i,
    /Total Cost[\s\S]*?USD\s*([0-9,]+\.\d{2})/i,
  ]);
  const rawRate = directRate || usdMatches[usdMatches.length - 1] || '';

  return {
    loadType: inferDispatchLoadType(text),
    loadNumber: matchFirstGroup(text, [
      /Load Number:\s*([A-Za-z0-9-]+)/i,
      /Load #:\s*([^\n]+)/i,
      /\bPRO\s*#\s*([A-Za-z0-9-]+)/i,
    ]),
    puNumber: pickup.referenceNumber || delivery.referenceNumber,
    poNumber: normalizeDispatchReference(matchFirstGroup(text, [
      /(?:^|\n)PO(?:\s*#| Number)?\s*:\s*([^\n]+)/i,
      /Purchase Order(?: Number)?\s*:\s*([^\n]+)/i,
    ])),
    puDateTime: pickup.dateTime,
    pickupName: pickup.name,
    pickupStreet: pickup.street,
    pickupCity: pickup.city,
    delDateTime: firstNonEmpty(delivery.dateTime, deliveryFallback.dateTime),
    deliveryName: firstNonEmpty(delivery.name, deliveryFallback.name),
    deliveryStreet: firstNonEmpty(delivery.street, deliveryFallback.street),
    deliveryCity: firstNonEmpty(delivery.city, deliveryFallback.city),
    loadedMiles: normalizeDispatchMiles(matchFirstGroup(text, [/Loaded miles\s*:?\s*([^\n]+)/i])),
    totalMiles: normalizeDispatchMiles(matchFirstGroup(text, [/Total miles\s*:?\s*([^\n]+)/i])),
    rate: normalizeDispatchRate(rawRate),
  };
}

function parseDispatchTemplate(text) {
  const lines = sanitizeDispatchOutput(stripMarkdownFences(text)).split(/\r?\n/);
  const afterLabel = (label) => {
    const line = lines.find((entry) => entry.startsWith(label));
    return line ? line.slice(label.length).trim() : '';
  };
  const lineAfter = (label, offset) => {
    const index = lines.findIndex((entry) => entry.startsWith(label));
    if (index === -1) return '';
    return String(lines[index + offset] || '').trim();
  };

  return {
    loadType: afterLabel('Load type:'),
    loadNumber: afterLabel('Load #:'),
    puNumber: afterLabel('PU # :'),
    poNumber: afterLabel('PO # :'),
    puDateTime: afterLabel('PU :'),
    pickupName: lineAfter('PU :', 1),
    pickupStreet: lineAfter('PU :', 2),
    pickupCity: lineAfter('PU :', 3),
    delDateTime: afterLabel('DEL :'),
    deliveryName: lineAfter('DEL :', 1),
    deliveryStreet: lineAfter('DEL :', 2),
    deliveryCity: lineAfter('DEL :', 3),
    loadedMiles: afterLabel('Loaded miles :'),
    totalMiles: afterLabel('Total miles :'),
    rate: afterLabel('Rate:'),
  };
}

function mergeDispatchFields(parsedFields, aiFields) {
  const mergedPuNumber = firstNonEmpty(parsedFields.puNumber, aiFields.puNumber);

  return {
    loadType: firstNonEmpty(parsedFields.loadType, aiFields.loadType),
    loadNumber: firstNonEmpty(parsedFields.loadNumber, aiFields.loadNumber),
    puNumber: mergedPuNumber,
    poNumber: chooseDispatchPoNumber(parsedFields.poNumber, aiFields.poNumber, mergedPuNumber),
    puDateTime: firstNonEmpty(parsedFields.puDateTime, aiFields.puDateTime),
    pickupName: firstNonEmpty(parsedFields.pickupName, aiFields.pickupName),
    pickupStreet: firstNonEmpty(parsedFields.pickupStreet, aiFields.pickupStreet),
    pickupCity: firstNonEmpty(parsedFields.pickupCity, aiFields.pickupCity),
    delDateTime: firstNonEmpty(parsedFields.delDateTime, aiFields.delDateTime),
    deliveryName: firstNonEmpty(parsedFields.deliveryName, aiFields.deliveryName),
    deliveryStreet: firstNonEmpty(parsedFields.deliveryStreet, aiFields.deliveryStreet),
    deliveryCity: firstNonEmpty(parsedFields.deliveryCity, aiFields.deliveryCity),
    loadedMiles: firstNonEmpty(parsedFields.loadedMiles, aiFields.loadedMiles),
    totalMiles: firstNonEmpty(parsedFields.totalMiles, aiFields.totalMiles),
    rate: firstNonEmpty(parsedFields.rate, aiFields.rate),
  };
}

function sanitizeDispatchTemplateFields(fields) {
  const pickupNotes = [];
  const deliveryNotes = [];

  const cleanPickup = (value, isDateTime = false) => {
    const { clean, note } = isDateTime ? normalizeDispatchDateTime(value) : splitInstructionTail(value);
    if (note) pickupNotes.push(note);
    return clean;
  };
  const cleanDelivery = (value, isDateTime = false) => {
    const { clean, note } = isDateTime ? normalizeDispatchDateTime(value) : splitInstructionTail(value);
    if (note) deliveryNotes.push(note);
    return clean;
  };

  const dedupe = (values) => {
    const seen = new Set();
    return values
      .map((entry) => normalizeDispatchValue(entry))
      .filter(Boolean)
      .filter((entry) => {
        const key = entry.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };

  return {
    cleaned: {
      ...fields,
      puDateTime: cleanPickup(fields.puDateTime, true),
      pickupName: normalizeDispatchCompany(cleanPickup(fields.pickupName)),
      pickupStreet: normalizeDispatchStreet(cleanPickup(fields.pickupStreet)),
      pickupCity: normalizeDispatchCity(cleanPickup(fields.pickupCity)),
      delDateTime: cleanDelivery(fields.delDateTime, true),
      deliveryName: normalizeDispatchCompany(cleanDelivery(fields.deliveryName)),
      deliveryStreet: normalizeDispatchStreet(cleanDelivery(fields.deliveryStreet)),
      deliveryCity: normalizeDispatchCity(cleanDelivery(fields.deliveryCity)),
    },
    pickupNotes: dedupe(pickupNotes),
    deliveryNotes: dedupe(deliveryNotes),
  };
}

function buildDispatchFieldsFromObject(aiObject) {
  const source = aiObject && typeof aiObject === 'object' ? aiObject : {};
  return {
    loadType: normalizeDispatchValue(source.loadType),
    loadNumber: normalizeDispatchValue(source.loadNumber),
    puNumber: normalizeDispatchReference(source.puNumber),
    poNumber: normalizeDispatchReference(source.poNumber),
    puDateTime: normalizeDispatchValue(source.puDateTime),
    pickupName: normalizeDispatchCompany(source.pickupName),
    pickupStreet: normalizeDispatchStreet(source.pickupStreet),
    pickupCity: normalizeDispatchCity(source.pickupCity),
    delDateTime: normalizeDispatchValue(source.delDateTime),
    deliveryName: normalizeDispatchCompany(source.deliveryName),
    deliveryStreet: normalizeDispatchStreet(source.deliveryStreet),
    deliveryCity: normalizeDispatchCity(source.deliveryCity),
    loadedMiles: normalizeDispatchMiles(source.loadedMiles),
    totalMiles: normalizeDispatchMiles(source.totalMiles),
    rate: normalizeDispatchRate(source.rate),
  };
}

module.exports = {
  extractDispatchFields,
  parseDispatchTemplate,
  mergeDispatchFields,
  sanitizeDispatchTemplateFields,
  buildDispatchFieldsFromObject,
};
