'use strict';

/**
 * Answering a candidate when the recruiting team has gone home.
 *
 * A Facebook lead is texted within seconds of arriving, from the assigned
 * recruiter's own number. A lead that arrives at 9pm on a Friday is answered by
 * the candidate within minutes — and then hears nothing until Monday, by which
 * time the good ones have taken a job that answered.
 *
 * THE SHAPE OF THE SAFETY HERE IS DIFFERENT FROM EVERYTHING ELSE IN THIS
 * REPOSITORY, and it is worth saying why. Elsewhere AI wording sits on top of a
 * decision arithmetic already made, and the deterministic answer is the one
 * that ships when anything goes wrong. A conversation has no deterministic
 * answer: there is no fixed sentence that responds to "does the truck have an
 * APU". So the protection is not a better fallback. It is a gate on both ends:
 *
 *   BEFORE  the model may only speak from `recruiting_knowledge` — statements
 *           an administrator typed and then confirmed. With none, it does not
 *           speak at all, because it has nothing it is allowed to say.
 *   AFTER   lib/recruiting/replyGuard.js refuses the whole reply if it contains
 *           a figure no approved statement contains, or grants anything.
 *
 * And when either end refuses, the candidate is not left in silence: they get
 * ONE fixed acknowledgement saying a recruiter will follow up. It is true, it
 * commits nothing, and it is better than Monday.
 *
 * NOTHING HERE MAKES AN EMPLOYMENT DECISION. It cannot hire, reject, promise a
 * truck, set a start date or grant an exception — `replyGuard` refuses each of
 * those in as many words, and `docs/architecture/recruiting-after-hours.md`
 * records the reasoning.
 *
 * EVERY EXIT IS A NAMED REASON, asserted in tests. "Why did Wenze not answer
 * this candidate" is a question somebody will ask, and `false` is not an answer
 * to it.
 */
const { evaluateHours } = require('../../lib/recruiting/workingHours');
const {
  buildThread, lastCandidateMessage, recruiterSpokeAfterWenze,
} = require('../../lib/recruiting/thread');
const {
  CAPABILITY, acknowledgementText, describeNextOpen, inQuietHours,
  loadApprovedKnowledge, composeReply,
} = require('./afterHoursCompose');

/** How many turns the model is shown. Enough for context, short enough to stay cheap. */
const THREAD_TURNS = 12;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    hours: require('../../database/recruitingHours'),
    conversations: require('../../database/recruitingConversations'),
    knowledge: require('../../database/recruitingKnowledge'),
    mirrors: require('../../database/facebookLeads'),
    rc: require('../../database/ringcentral'),
    sendSmsAsRecruiter: require('../ringCentralSmsService').sendSmsAsRecruiter,
    runCapability: require('../ai/router').runCapability,
    isCapabilityEnabled: require('../ai/capabilityGate').isCapabilityEnabled,
    notify: require('../notifications/send').notify,
    // Injected by the mirror service, which owns Telegram. Requiring it here
    // would close a cycle: the mirror service calls into this module.
    postToThread: null,
  };
  /* eslint-enable global-require */
}

/** A stand-down, with its name. Never throws, never sends. */
function skip(reason, extra = {}) {
  return { sent: false, reason, ...extra };
}

/**
 * Consider answering one inbound candidate SMS.
 *
 * Called from the mirror registration, fire-and-forget: an SMS is recorded
 * whether or not Wenze has anything to say about it, so every failure in here
 * becomes a named skip rather than breaking the thing that logs the
 * candidate's message.
 */
async function considerReply({
  driverPhone, leadName = null, recruiterId = null, telegramChatId = null, at = null,
}, deps = defaultDeps()) {
  const phone = String(driverPhone || '').trim();
  if (!phone) return skip('no_phone');

  const settings = await deps.hours.getRecruitingHours();
  if (!settings.aiAfterHoursEnabled) return skip('disabled');

  const nowIso = at || new Date().toISOString();
  const hours = evaluateHours({ timezone: settings.timezone, windows: settings.windows }, nowIso);
  if (hours.open) {
    return skip(hours.reason === 'no_hours_configured' ? 'no_hours_configured' : 'within_working_hours');
  }

  // Shut AND asleep are different things. The office being closed is what makes
  // this feature's turn; 03:00 is what makes a text from it rude.
  const localHHMM = (hours.localTime || '').split(' ')[1] || null;
  if (localHHMM && inQuietHours(settings, localHHMM)) return skip('quiet_hours');

  if (!(await deps.isCapabilityEnabled(CAPABILITY))) return skip('capability_off');

  const conversation = await deps.conversations.ensureConversation({
    driverPhone: phone, leadName, recruiterId, telegramChatId,
  });
  if (!conversation) return skip('no_conversation');
  if (conversation.status !== 'active') return skip(`conversation_${conversation.status}`);

  const rows = await deps.mirrors.listSmsMirrorsByPhone(phone, { limit: 40 });
  const turns = buildThread(rows, { limit: THREAD_TURNS });
  const candidate = lastCandidateMessage(turns);
  if (!candidate) return skip('nothing_to_answer');

  // A person replied after Wenze did: the conversation is theirs again.
  if (recruiterSpokeAfterWenze(turns)) {
    await deps.conversations.closeConversation(phone, {
      status: 'handed_off', reason: 'a recruiter replied',
    });
    return skip('recruiter_took_over');
  }

  const nextOpenText = describeNextOpen(hours.nextOpenIso, hours.timezone);
  const firstName = String(leadName || conversation.leadName || '').trim().split(/\s+/)[0] || null;

  const recruiter = await loadRecruiter(conversation.recruiterId ?? recruiterId, deps);
  if (!recruiter) return skip('no_recruiter_can_send');

  const ackArgs = { phone, conversation, recruiter, firstName, nextOpenText, telegramChatId };

  // The cap. Past it the candidate still gets the fixed acknowledgement once,
  // because going quiet mid-conversation is the failure this feature exists to
  // fix, and a cap is not a reason to reproduce it.
  if (conversation.repliesSent >= settings.maxRepliesPerConversation) {
    const out = await sendAcknowledgement(ackArgs, deps);
    await deps.conversations.closeConversation(phone, {
      status: 'stopped', reason: `reply cap of ${settings.maxRepliesPerConversation} reached`,
    });
    await notifyHandoff({
      phone, firstName, conversation, candidate, reason: 'reached the reply limit',
    }, deps);
    return skip('reply_cap', { acknowledged: out.sent });
  }

  const approved = await loadApprovedKnowledge(deps);
  if (!approved.entries.length) {
    // NOTHING APPROVED MEANS NOTHING TO SAY. Not a degraded answer — no answer,
    // plus the acknowledgement, plus somebody told that an empty knowledge base
    // is why a candidate went unanswered.
    const out = await sendAcknowledgement(ackArgs, deps);
    await notifyHandoff({
      phone, firstName, conversation, candidate,
      reason: 'nothing has been approved for Wenze to say — Settings → Recruiting → Teach Wenze',
    }, deps);
    return skip('no_approved_knowledge', { acknowledged: out.sent });
  }

  const composed = await composeReply({ turns, approved, recruiter, nextOpenText }, deps);

  if (!composed.ok) {
    if (composed.refusal) await deps.conversations.recordRefusal(phone, composed.refusal);
    const out = await sendAcknowledgement(ackArgs, deps);
    await notifyHandoff({
      phone, firstName, conversation, candidate,
      reason: composed.refusal
        ? `Wenze's draft was refused: ${composed.refusal}`
        : 'Wenze could not compose a safe answer',
    }, deps);
    return skip(composed.reason, { acknowledged: out.sent, refusal: composed.refusal || null });
  }

  const sms = await deps.sendSmsAsRecruiter(recruiter, phone, composed.text);
  if (!sms?.ok) return skip('sms_failed', { detail: sms?.reason || null });

  await deps.conversations.recordReply(phone);
  await mirrorIntoThread({
    telegramChatId: telegramChatId ?? conversation.telegramChatId,
    phone,
    text: composed.text,
    recruiter,
    leadName: leadName || conversation.leadName,
    ringcentralMessageId: sms.messageId || null,
  }, deps);

  if (composed.handOff) {
    await deps.conversations.closeConversation(phone, {
      status: 'handed_off', reason: composed.handOffReason || 'Wenze asked for a person',
    });
    await notifyHandoff({
      phone, firstName, conversation, candidate,
      reason: composed.handOffReason || 'the candidate needs a person',
    }, deps);
  }

  return { sent: true, reason: 'replied', text: composed.text, handOff: composed.handOff };
}

/** The recruiter whose name this goes out in, or null when none can send. */
async function loadRecruiter(recruiterId, deps) {
  const id = Number(recruiterId);
  if (!Number.isFinite(id) || id <= 0) return null;
  try {
    const recruiter = await deps.rc.getRecruiterById(id);
    if (!recruiter || !deps.rc.recruiterCanSendSms(recruiter)) return null;
    return recruiter;
  } catch (err) {
    console.warn('[RecruitingAfterHours] could not load the recruiter:', err.message);
    return null;
  }
}

/** The fixed line, at most once per conversation. */
async function sendAcknowledgement({
  phone, conversation, recruiter, firstName, nextOpenText, telegramChatId,
}, deps) {
  // Once. A candidate told twice that somebody will be in touch has learned
  // that nobody is.
  if (conversation.acknowledgedAt) return { sent: false, reason: 'already_acknowledged' };
  const text = acknowledgementText({ firstName, nextOpenText });
  const sms = await deps.sendSmsAsRecruiter(recruiter, phone, text);
  if (!sms?.ok) return { sent: false, reason: 'sms_failed' };
  await deps.conversations.markAcknowledged(phone);
  await mirrorIntoThread({
    telegramChatId: telegramChatId ?? conversation.telegramChatId,
    phone,
    text,
    recruiter,
    leadName: conversation.leadName,
    ringcentralMessageId: sms.messageId || null,
  }, deps);
  return { sent: true, text };
}

/**
 * Put what Wenze said into the recruiter's Telegram thread.
 *
 * Not optional politeness. A recruiter arriving on Monday has to be able to
 * read what went out in their name before they answer, and the mirror row is
 * also what makes the NEXT turn's thread complete. A Telegram failure is logged
 * and swallowed: the SMS has already gone, and unsending it is not a thing.
 */
async function mirrorIntoThread(args, deps) {
  if (!deps.postToThread) return { ok: false, reason: 'no_thread_poster' };
  try {
    return await deps.postToThread(args);
  } catch (err) {
    console.warn('[RecruitingAfterHours] could not mirror the reply into Telegram:', err.message);
    return { ok: false, reason: 'mirror_failed' };
  }
}

/** Tell a person, once a day at most, that this conversation needs them. */
async function notifyHandoff({ phone, firstName, conversation, reason, candidate }, deps) {
  return deps.notify({
    category: 'needs_attention',
    title: `Recruiting: ${firstName || phone} needs a recruiter`,
    lines: [
      candidate?.text ? `They asked: ${candidate.text}` : null,
      `Wenze has answered ${conversation.repliesSent} time(s) on this conversation.`,
    ].filter(Boolean),
    reason,
    action: 'A recruiter should pick this up in the morning',
    subjectType: 'lead',
    subjectId: phone,
    discriminator: new Date().toISOString().slice(0, 10),
  }).catch(() => ({ recorded: false }));
}

module.exports = {
  CAPABILITY,
  THREAD_TURNS,
  defaultDeps,
  skip,
  considerReply,
  loadRecruiter,
  sendAcknowledgement,
  notifyHandoff,
};
