'use strict';

/**
 * Telling the owner that a hand-over PDF went out with photos NO MODEL LOOKED
 * AT (the owner, 23 November 2026: "send it with a mark and tell me right
 * away"). From 18 to 23 November every truck photo went into the PDFs
 * unchecked — the Claude key was rejected, Gemini's credit was spent, and no
 * free model in the chain was known to see pictures — and nobody was told.
 *
 * One notice per report, through the one door (services/notifications/send.js,
 * category `system_errors`): the outbox's unique key makes a second copy for
 * the same report impossible. Sentences only — never a provider's raw error,
 * which can carry an account id. Never throws.
 */

const CATEGORY = 'system_errors';
const SUBJECT_TYPE = 'truck_photo_report';

function defaultDeps() {
  // eslint-disable-next-line global-require
  return { notify: (notice) => require('../notifications/send').notify(notice) };
}

/** The notice's words. Pure. */
function uncheckedNoticeText({
  kind, chatTitle, unchecked, total, stopped,
}) {
  const word = kind === 'inbound' ? 'INBOUND' : 'OUTBOUND';
  const how = unchecked >= total ? `none of the ${total} photos were` : `${unchecked} of ${total} photos were not`;
  return {
    title: `Truck Photos: ${how} checked by AI`,
    lines: [
      `${word} in "${chatTitle || 'a driver group'}": the PDF was sent with every photo and "NOT CHECKED BY AI" on its cover.`,
      stopped === 'deadline'
        ? 'Why: the check ran out of time before it reached them.'
        : 'Why: no AI model that can look at pictures answered.',
    ],
    action: 'Settings → AI: replace a key that was rejected or add credit, or choose the providers for '
      + '"Check a truck hand-over and its photos" under "Providers for one task".',
  };
}

/**
 * @returns {Promise<{notified: boolean}>}
 */
async function tellOwnerUnchecked({
  reportId, kind, chatTitle, unchecked, total, stopped = null, groupId = null,
}, deps = defaultDeps()) {
  if (!reportId || !(unchecked > 0)) return { notified: false };
  try {
    const sent = await deps.notify({
      category: CATEGORY,
      ...uncheckedNoticeText({
        kind, chatTitle, unchecked, total, stopped,
      }),
      subjectType: SUBJECT_TYPE,
      subjectId: String(reportId),
      groupId,
      evidence: { reportId, unchecked, total, stopped },
    });
    return { notified: Boolean(sent?.recorded) };
  } catch (err) {
    console.warn('[TRUCK PHOTOS] could not tell the owner the photos were not checked:', err?.message || String(err));
    return { notified: false };
  }
}

module.exports = {
  CATEGORY, SUBJECT_TYPE, uncheckedNoticeText, tellOwnerUnchecked,
};
