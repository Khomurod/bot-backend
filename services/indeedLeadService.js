/**
 * Indeed lead ingestion (Phase 1).
 *
 * A small Google Apps Script running on each recruiter's Gmail forwards new
 * Indeed application emails to POST /api/internal/indeed/lead. This module
 * parses the applicant's name from the email, pulls a real phone (and email
 * when present) from the attached résumé PDF if available, records the lead,
 * and forwards it to Bitrix24 using the SAME pipeline as Facebook leads.
 *
 * Indeed deliberately omits applicant contact info from notification emails,
 * so phone/email come from the résumé attachment when the recruiter enables
 * "email me the résumé". Name-only leads are still recorded and forwarded.
 */
const db = require('../database/db');
const { createCrmRecordFromLead } = require('./bitrix24Service');

// Indeed often rewrites the applicant's email to a relay address.
const RELAY_EMAIL_DOMAINS = ['indeedemail.com', 'indeed.com'];

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// US/NANP-style phone with 10 (or 11 with country code) digits.
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

function cleanLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Reject generic phrases that match name patterns but aren't real names,
// e.g. "A candidate applied", "Someone applied", "New candidate".
function looksGeneric(name) {
  const n = String(name || '').toLowerCase().trim();
  if (!n) return true;
  if (/\b(candidate|applicant|someone|job ?seeker)\b/.test(n)) return true;
  if (/^(a|an|the|new|your)\s/.test(n)) return true;
  return false;
}

/**
 * Best-effort applicant name from the Indeed email subject/body.
 * Indeed formats vary, so we try several common shapes and fall back to a
 * generic label. (Tune once a real sample email is available.)
 */
function parseIndeedName({ subject = '', body = '' } = {}) {
  const subj = cleanLine(subject);
  const subjectPatterns = [
    /^(.+?)\s+applied\b/i, // "John Doe applied to ..."
    /\bapplication\s+(?:from|by|received from)\s*[:-]?\s*(.+?)(?:\s+for\b|$)/i,
    /\bnew\s+(?:applicant|candidate)[^:]*:\s*(.+)$/i,
    /\bcandidate\b[^:]*:\s*(.+)$/i,
  ];
  for (const re of subjectPatterns) {
    const m = subj.match(re);
    if (m && m[1] && m[1].trim().length >= 2) {
      const candidate = cleanLine(m[1]);
      if (!looksGeneric(candidate)) return candidate;
    }
  }

  // Body fallback: look for "Name: X" or a likely name line near the top.
  const lines = String(body || '')
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);
  for (const line of lines.slice(0, 15)) {
    const m = line.match(/^name\s*[:-]\s*(.+)$/i);
    if (m && m[1].trim().length >= 2) {
      const candidate = cleanLine(m[1]);
      if (!looksGeneric(candidate)) return candidate;
    }
  }
  return 'Indeed Applicant';
}

/** Best-effort job title from the Indeed email subject. */
function parseIndeedJobTitle({ subject = '' } = {}) {
  const subj = cleanLine(subject);
  const m = subj.match(/\b(?:applied to|application for|for the position of|for)\s+(.+?)(?:\s+(?:job|position|role))?$/i);
  if (m && m[1] && m[1].trim().length >= 2) return cleanLine(m[1]);
  return null;
}

/** Extract a phone and email from free text (résumé or email body). */
function parseContactFromText(text) {
  const raw = String(text || '');
  const emailMatch = raw.match(EMAIL_RE);
  const phoneMatch = raw.match(PHONE_RE);
  let email = emailMatch ? emailMatch[0].trim() : null;
  const emailIsRelay = Boolean(
    email && RELAY_EMAIL_DOMAINS.some((d) => email.toLowerCase().endsWith(`@${d}`) || email.toLowerCase().includes(`@${d.split('.')[0]}.`))
  );
  let phone = phoneMatch ? phoneMatch[0].trim() : null;
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) phone = null;
  }
  return { email, phone, emailIsRelay };
}

/** Parse a base64 résumé PDF and pull contact details out of its text. */
async function extractResumeContact(resumePdfBase64) {
  if (!resumePdfBase64) return { email: null, phone: null, emailIsRelay: false };
  try {
    const buffer = Buffer.from(String(resumePdfBase64), 'base64');
    if (!buffer.length) return { email: null, phone: null, emailIsRelay: false };
    // Lazy-require so the PDF parser is only loaded when actually needed.
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return parseContactFromText(result?.text || '');
    } finally {
      try { await parser.destroy(); } catch { /* ignore */ }
    }
  } catch (err) {
    console.error('[INDEED] Résumé parse failed:', err.message);
    return { email: null, phone: null, emailIsRelay: false };
  }
}

/**
 * Ingest one Indeed lead.
 * @param {{messageId:string, from?:string, subject?:string, body?:string, resumePdfBase64?:string}} input
 * @param {object} [deps] - injectable dependencies for testing.
 * @returns {Promise<{ok:boolean, deduped?:boolean, leadId?:number, bitrix?:object, reason?:string, lead?:object}>}
 */
async function ingestIndeedLead(input, deps = {}) {
  const database = deps.db || db;
  const crm = deps.createCrmRecordFromLead || createCrmRecordFromLead;
  const resumeExtractor = deps.extractResumeContact || extractResumeContact;

  const messageId = String(input?.messageId || '').trim();
  if (!messageId) {
    return { ok: false, reason: 'missing_message_id' };
  }

  const subject = input?.subject || '';
  const body = input?.body || '';
  const fullName = parseIndeedName({ subject, body });
  const jobTitle = parseIndeedJobTitle({ subject });

  // Prefer résumé contact; fall back to anything in the email body.
  const resumeContact = await resumeExtractor(input?.resumePdfBase64);
  const bodyContact = parseContactFromText(body);
  const phone = resumeContact.phone || bodyContact.phone || null;
  const email = resumeContact.email || bodyContact.email || null;

  // Claim the lead first (dedupe on gmail message id). A duplicate POST
  // returns null and we skip re-sending it to Bitrix.
  const lead = await database.createLeadIfNew({
    source: 'indeed',
    externalId: messageId,
    fullName,
    email,
    phone,
    jobTitle,
    message: cleanLine(subject) || null,
    raw: { subject: cleanLine(subject), from: cleanLine(input?.from), hasResume: Boolean(input?.resumePdfBase64) },
  });

  if (!lead) {
    return { ok: true, deduped: true };
  }

  // Forward to Bitrix24 via the shared lead pipeline.
  const fieldMap = { full_name: fullName };
  if (phone) fieldMap.phone_number = phone;
  if (email) fieldMap.email = email;
  if (jobTitle) fieldMap.job_title = jobTitle;

  let bitrixStatus = 'skipped';
  let bitrixId = null;
  let bitrix = null;
  try {
    bitrix = await crm({
      fieldMap,
      leadData: { source: 'indeed', subject: cleanLine(subject), from: cleanLine(input?.from) },
      connection: { page_name: 'Indeed', page_id: 'indeed', telegram_group_id: null, group_name: 'Indeed' },
      leadgenId: `indeed_${messageId}`,
    });
    if (bitrix?.ok) {
      bitrixStatus = 'created';
      bitrixId = bitrix.bitrixId || null;
    } else if (bitrix?.reason === 'not_configured') {
      bitrixStatus = 'disabled';
    } else {
      bitrixStatus = 'failed';
      console.error('[INDEED] Bitrix sync failed:', bitrix?.error || bitrix?.reason);
    }
  } catch (err) {
    bitrixStatus = 'failed';
    console.error('[INDEED] Bitrix sync error:', err.message);
  }

  try {
    await database.updateLeadBitrixResult(lead.id, { bitrixId, status: bitrixStatus });
  } catch (err) {
    console.error('[INDEED] Failed to update lead status:', err.message);
  }

  return { ok: true, leadId: lead.id, bitrix, lead: { ...lead, bitrix_status: bitrixStatus, bitrix_id: bitrixId } };
}

module.exports = {
  parseIndeedName,
  parseIndeedJobTitle,
  parseContactFromText,
  extractResumeContact,
  ingestIndeedLead,
};
