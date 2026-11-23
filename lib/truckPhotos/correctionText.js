'use strict';

/**
 * What Wenze says back to a person correcting a hand-over PDF. Pure, fixed
 * words — never the person's own text, never a model's reasoning — in
 * English, like every other Truck Photos message. A rebuilt PDF needs no words:
 * it answers the message that asked for it, and its cover says what changed.
 */

const WORD = Object.freeze({ outbound: 'OUTBOUND', inbound: 'INBOUND' });

const EXAMPLES = 'For example: "truck number is 027", "remove photos 11 to 38", "keep only the truck", '
  + '"this is inbound", "use the photos from 3 PM to 6 PM", "put the documents back", "not a hand-over".';

const TEXT = Object.freeze({
  notAllowed: 'Only the person who receives the truck photo PDFs, or someone listed in Settings → Truck Photos, '
    + 'can correct them.',
  switchedOff: 'Truck Photos is switched off, so the PDF cannot be rebuilt.',
  empty: `Write what to change, as a reply to the PDF. ${EXAMPLES}`,
  unavailable: 'No AI model could read your answer right now, so nothing was changed. Please try again in a '
    + 'little while.',
  no_photos: 'There are no photos left to build it from: photos are kept for 30 days, and only the ones Wenze saw '
    + 'arrive. Nothing was changed.',
  download_failed: 'None of the photos could be downloaded from Telegram right now, so nothing was changed. '
    + 'Please try again in a little while.',
  all_excluded: 'With that change no photo or video would be left, so no PDF was sent and nothing was changed.',
  raced: 'Another correction of this PDF went first. Reply to the newest PDF to change it again.',
  error: 'Something went wrong while rebuilding the PDF, so nothing was changed. Please try again.',
  sentElsewhere: 'Done: the corrected PDF went to the person who receives the truck photo PDFs.',
});

/** Not understood: the model's one question back, when it had one, and what can be said. */
function unclearText(question) {
  const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return [
    q ? `I am not sure what to change: ${q}` : 'I did not understand what to change.',
    'Reply to this message with the change.',
    EXAMPLES,
  ].join('\n');
}

/** A part that could not be sent: which, and that nothing was recorded. */
function failedText(failure) {
  if (failure?.code === 'too_large') return 'The corrected PDF came out larger than Telegram takes, so nothing was changed.';
  return 'The corrected PDF could not be delivered, so nothing was changed. Please try again.';
}

function cancelledText({ kind, chatTitle }) {
  return `Done: the ${WORD[kind] || 'hand-over'} in "${chatTitle || 'the driver group'}" is no longer on record `
    + 'as a hand-over, and its photos can go into the next PDF.';
}

/** The Yes / No under a corrected truck number, when the profile says another. */
function profileQuestionText({ chatTitle, from, to }) {
  return `Also change the truck number in the profile of "${chatTitle || 'this driver'}" from ${from || 'none'} to ${to}? `
    + 'The map, /location and the next PDFs read the profile.';
}

function profileDoneText({ chatTitle, to, titleUnit }) {
  const rename = titleUnit && String(titleUnit).toUpperCase() !== String(to).toUpperCase()
    ? ` The chat title still says ${titleUnit}, so rename the chat in Telegram too.`
    : '';
  return `Done: the profile of "${chatTitle || 'this driver'}" says unit ${to} now.${rename}`;
}

function profileKeptText({ from }) {
  return `Left as it is: the profile still says unit ${from || 'none'}.`;
}

module.exports = {
  EXAMPLES,
  TEXT,
  unclearText,
  failedText,
  cancelledText,
  profileQuestionText,
  profileDoneText,
  profileKeptText,
};
