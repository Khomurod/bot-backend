'use strict';

/**
 * What can be read off a recruiter's post WITHOUT a model. Pure.
 *
 * Posts are free-form, but they follow a habit:
 *
 *   Company Driver - 80 CPM
 *   PHILLIPS SAMUEL JAHBARI
 *   3+ yrs of exp
 *   (704) 493-1180
 *   Matthew's referral
 *
 * A NAME is a line of two to four words made only of letters, each starting
 * with a capital (as written, or ALL CAPS; "van", "de", "bin" may stay small),
 * none of which is a word a recruiter uses about the job or the candidate
 * ("company", "driver", "exp", "referral", "signed" …). A line with a digit, an
 * @ or a link is never a name. Neither is a line about somebody else's thing —
 * "Matthew's referral", "Polvon's truck": a possessive describes, it does not
 * name the driver. Nor is a labelled field ("Referral: Ann Lee", "Recruiter -
 * Ann Lee") unless the label says it is the driver's name ("Name:",
 * "Driver:", "Co-driver:"), which also waives the capitals.
 *
 * WHY THIS MATTERS. Every name read here is a driver of the post. Until
 * November 2026 "Matthew's referral" read as a second driver, so a one-driver
 * card looked like a team and every `#Approved` under it was asked about
 * ("Which driver is this about?") instead of posted.
 *
 * WHAT IS NOT CERTAIN IS SAID SO. A name-shaped line in small letters ("john
 * smith") might be a driver and might be chatter; it is counted as `doubtful`,
 * and the caller asks a model for the names rather than trusting the count. A
 * post that SAYS it is a team ("team drivers", "(main)", "co-driver") but
 * yields fewer than two names is marked `team` for the same reason — the
 * caller must never treat it as one driver.
 *
 * Names are shown as written, in title case: "PHILLIPS SAMUEL JAHBARI" →
 * "Phillips Samuel Jahbari". Which word is the surname is not guessed.
 */

const NOT_A_NAME = new Set(`
  company driver drivers team solo owner operator lease leased cpm exp experience year years yrs
  ready asap otr home regional local dedicated week weeks day days month months the and for with of
  he she his her him is are was will can could we us our please wanna want come back worked works
  new old cdl class hazmat tanker reefer dry van flatbed wenze unit safety mvr psp clh approved not
  test drug sap tomorrow today tonight monday tuesday wednesday thursday friday saturday sunday office
  truck trailer hire rehire main also planning arrive arriving coming info information need needs
  good morning hello hi thanks thank you done ok okay no yes per mile miles hour hours pay rate
  states state only all any team's ny nj ca tx fl ga
  referral referrals referred refer ref recruiter recruiters recruited recruiting status position job
  role consent consents signed sign signature awaiting pending review reviewed mro lab negative
  positive released arrived arrival orientation accepted available update updates license licence
  disqualified violation violations accident accidents ticket tickets dui program contract contracts
  deadline task tasks email phone tel cell number note notes by from via aka it its on at this that
  still sent clean check checked hired start started starting date dtr med medical card endorsement
  endorsements hotel train bus flight escrow friend friends brother sister daughter wife husband
  father mother cousin uncle aunt previous current former prior
  hey dear greetings salam salom assalomu assalamu alaikum alaykum alekum
`.trim().split(/\s+/));

/** Small words inside a name ("Ludwig van Beethoven", "Maria de la Cruz", "Omar bin Laden"). */
const PARTICLES = new Set('da de del della der den di do dos das du la le bin ibn al el ter st y e'.split(' '));

/** A label that says the line IS the driver's name: "Name:", "Driver 2:", "Co-driver -". */
const NAME_LABEL = /^(?:(?:full|first|1st|2nd|second|main|team|driver'?s?)[\s-]+)*(?:name|driver|co-?driver)(?:\s*#?\s*[12])?$/i;
/** "Label: rest" or "Label - rest" (a dash between spaces; "Jean-Marie" is not a label). */
const LABELLED = /^([\p{L}\d][\p{L}\d .'()#-]{0,30}?)\s*(?::\s*|\s+[-–—]\s+)(.+)$/u;
/** The post says it is about two drivers. "Good morning team," is not one. */
const TEAM_SIGNAL = /\bteam\s+(?:drivers?|position|cpm|\d)|\bco-?drivers?\b|\b(?:2nd|second)\s+driver\b|\bdriver\s*#?\s*2\b|\((?:main|co-?driver|second|2nd|1st)\)|^\s*team\s*(?:[-–:]|$)|[-–:/]\s*team\b/im;
const MARKER = /\((?:main|co-?driver|second|2nd|1st)\)/gi;

function titleCase(word) {
  return word
    .toLowerCase()
    .replace(/(^|[-'])([a-zà-ɏ])/g, (_m, sep, ch) => `${sep}${ch.toUpperCase()}`);
}

const bare = (word) => word.toLowerCase().replace(/[.']+$/, '');
const isPossessive = (word) => /['’]s$|s['’]$/i.test(word);
const isCapital = (word) => /^\p{Lu}/u.test(word);

/**
 * One line, read: `{ name }`, `{ doubtful: true }` (name-shaped, but in small
 * letters), or null (not a name).
 */
function readLine(line) {
  let text = String(line || '').replace(/’/g, "'").replace(/^[^\p{L}]+/u, '').trim();
  let labelled = false;
  const label = text.match(LABELLED);
  if (label) {
    if (NAME_LABEL.test(label[1].trim())) {
      text = label[2];
      labelled = true;
    } else if (label[1].split(/[\s-]+/).some((w) => NOT_A_NAME.has(bare(w)))) {
      return null; // "Referral: Ann Lee", "Ready - ASAP": a field about something else
    }
  }
  text = text.replace(MARKER, '').replace(/,/g, ' ').trim();
  if (!text || /[\d@#]|https?:|www\./i.test(text)) return null;
  // A lone "-" or "." between words ("Hills Emanuel . JR") is spacing, not a word.
  const words = text.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length < 2 || words.length > 4) return null;
  if (!words.every((w) => /^\p{L}[\p{L}'.-]*$/u.test(w))) return null;
  if (words.some(isPossessive)) return null;
  if (words.some((w) => NOT_A_NAME.has(bare(w)))) return null;
  const capitals = words.filter(isCapital).length;
  const shaped = words.every((w) => isCapital(w) || PARTICLES.has(w.toLowerCase())) && capitals >= 2;
  if (!labelled && !shaped) return { doubtful: true };
  return { name: words.map(titleCase).join(' ') };
}

/** One line as a name, or null. */
function nameOfLine(line) {
  return readLine(line)?.name || null;
}

/**
 * Everything the post's words say about who it is about.
 * @returns {{names: string[], doubtful: number, team: boolean}}
 */
function readPostNames(text) {
  const seen = new Set();
  const names = [];
  let doubtful = 0;
  for (const line of String(text || '').split(/\n+/)) {
    const read = readLine(line);
    if (read?.doubtful) doubtful += 1;
    const key = read?.name?.toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      names.push(read.name);
    }
  }
  return { names, doubtful, team: TEAM_SIGNAL.test(String(text || '')) };
}

/** The names written in a post, in order, each once. */
function namesInPost(text) {
  return readPostNames(text).names;
}

/** A Telegram name without the job title people put after a bar: "Amelia Carter | Driver Relations" → "Amelia Carter". */
function personName(fromName) {
  const name = String(fromName || '').split('|')[0].trim();
  return name || null;
}

module.exports = {
  namesInPost, nameOfLine, readPostNames, personName, titleCase,
};
