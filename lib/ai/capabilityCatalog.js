/**
 * Every job Wenze uses a model for, in words an administrator can act on. PURE.
 *
 * WHY THIS FILE EXISTS. `ai_capabilities` has been in the schema since the AI
 * governance work and nothing ever wrote a row into it or read one back, so the
 * admin's "What AI is used for" table rendered nothing and its switch changed
 * nothing. Worse, the table could not have answered the question that actually
 * matters — WHICH of these can change a driver's record on their own? — because
 * a row had no way to say so.
 *
 * So this is the catalogue: one entry per business decision, with the plain
 * sentence a non-technical person needs and the two facts that decide how much
 * care it deserves.
 *
 *   changesState  Can a model's answer end up written into operational records?
 *                 Text this app sends to a driver is not state; a driver marked
 *                 inactive is.
 *   fallback      What happens with no model at all. "Wenze decides without AI"
 *                 is a very different risk from "the feature stops".
 *
 * `automationCheck` names the Needs Attention → Automation switch that governs
 * the AUTOMATIC application, where one exists. Two switches sound like one too
 * many until you need them: AI analysis on with automatic changes off is a
 * perfectly sensible way to run — Wenze reasons, a person applies.
 */

const CAPABILITIES = Object.freeze([
  // ── Home time ────────────────────────────────────────────────────────────
  {
    key: 'home_time_intent',
    label: 'Understand Home Time requests',
    what: 'Reads a driver-group message and decides whether someone is really asking for '
      + 'time off, whether the driver is saying they are home or back on the road, and which '
      + 'dates they mean.',
    group: 'Home Time',
    changesState: true,
    stateNote: 'Can open a Home Time request and, on a confident and corroborated message, '
      + 'move a driver between Home and Road.',
    sendsRawText: true,
    fallback: 'Wenze falls back to exact wording only: a clear "Status: Home" still works, and '
      + 'plainly worded time off ("I need 4 days home", "PTO") still opens a request. Anything '
      + 'ambiguous is left alone rather than guessed.',
  },
  {
    key: 'home_time_dates',
    label: 'Read Home Time dates from a reply',
    what: 'Turns "back Monday" or "18 to 22" into the two dates a home-time cycle needs.',
    group: 'Home Time',
    changesState: true,
    stateNote: 'Fills the dates on a request that is already open.',
    sendsRawText: true,
    fallback: 'A deterministic date parser handles the common formats; anything it cannot read '
      + 'is asked again.',
  },
  {
    key: 'home_time_return_to_road',
    label: 'Detect Driver Returned to Road',
    what: 'Reads the load and truck-movement evidence for a driver who is at home and says '
      + 'whether they have gone back to work.',
    group: 'Home Time',
    changesState: true,
    stateNote: 'Only ever makes an already-ambiguous case clearer. It cannot supply the '
      + 'movement itself, and the automatic change below is what actually writes.',
    automationCheck: 'home_time.returned_to_road',
    mediumNote: 'Medium confidence never changes anything — it appears in Needs Attention.',
    sendsRawText: false,
    fallback: 'The load and GPS rules decide alone, which is how they decide most of the time.',
  },
  {
    key: 'home_time_message',
    label: 'Write the Home Time replies to drivers',
    what: 'Writes the wording of the question Wenze asks a driver about their dates, and the '
      + 'acknowledgement afterwards.',
    group: 'Home Time',
    changesState: false,
    sendsRawText: false,
    fallback: 'A fixed, correct sentence is sent instead.',
  },
  {
    key: 'home_time_import',
    label: 'Read a Home Time screenshot',
    what: 'Extracts drivers, states and dates from a pasted tracker screenshot.',
    group: 'Home Time',
    changesState: true,
    stateNote: 'Creates and updates home-time records from the image.',
    sendsRawText: false,
    fallback: 'The import cannot run without a model.',
  },

  // ── Driver records ───────────────────────────────────────────────────────
  {
    key: 'driver_status_classification',
    label: 'Driver Active / Inactive classification',
    what: 'Reads a Telegram group title and judges whether that driver still works here.',
    group: 'Driver records',
    changesState: true,
    stateNote: 'Writes groups.active. A manual decision by an administrator is never '
      + 'overwritten, and a driver with recent operational activity is never deactivated.',
    sendsRawText: false,
    fallback: 'Only an explicit marker in the title (INACTIVE, TERMINATED, QUIT) is acted on; '
      + 'everything else is left unchanged.',
  },
  {
    key: 'driver_profile_extraction',
    label: 'Driver Profile extraction',
    what: 'Reads names, unit number and driver type out of a group title.',
    group: 'Driver records',
    changesState: true,
    stateNote: 'Fills driver profile fields. Anything an administrator typed by hand is protected.',
    sendsRawText: false,
    fallback: 'A deterministic title parser fills what it can and flags the rest for review.',
  },

  // ── Dispatch ─────────────────────────────────────────────────────────────
  {
    key: 'dispatch_load_extraction',
    label: 'Read the pinned load details',
    what: 'Extracts pickup, delivery and appointment times from a pinned rate confirmation.',
    group: 'Dispatch',
    changesState: true,
    stateNote: 'Caches the load context that ETA updates to drivers are built from.',
    sendsRawText: true,
    fallback: 'A deterministic destination guess is used; where there is not enough, the driver '
      + 'is told there is no current load info rather than a wrong one.',
  },
  {
    key: 'fuel_stop_detection',
    label: 'Find the fuel station in a message',
    what: 'Pulls the station name and address out of a fuel post so the truck can be watched '
      + 'for arrival.',
    group: 'Dispatch',
    changesState: true,
    stateNote: 'Creates a fuel watch and sends the driver a reminder.',
    sendsRawText: true,
    fallback: 'A pattern match finds most addresses; with none, no watch is created.',
  },
  {
    key: 'fuel_stop_message',
    label: 'Write the fuel reminder',
    what: 'Wording of the reminder sent as the truck nears the station.',
    group: 'Dispatch',
    changesState: false,
    sendsRawText: false,
    fallback: 'A fixed reminder sentence is sent.',
  },

  // ── Operations and reporting ─────────────────────────────────────────────
  {
    key: 'chat_annotation',
    label: 'Label chat messages',
    what: 'Tags driver messages with language, intent, urgency and tone, which the insight '
      + 'cards are built from.',
    group: 'Operations',
    changesState: true,
    stateNote: 'Stores a label per message.',
    sendsRawText: true,
    fallback: 'Messages are simply left unlabelled.',
  },
  {
    key: 'ai_insights_narration',
    label: 'Explain an operational issue',
    what: 'Writes the sentence and the suggested action on an insight card.',
    group: 'Operations',
    changesState: false,
    sendsRawText: false,
    fallback: 'The card still appears with its evidence and a severity worked out from the '
      + 'facts; only the wording is missing.',
  },
  {
    key: 'ai_report_generation',
    label: 'Draft a written report',
    what: 'Writes a driver or company report for a person to read, edit and send.',
    group: 'Operations',
    changesState: false,
    sendsRawText: true,
    fallback: 'Report generation is unavailable.',
  },
  {
    key: 'employee_birthday_message',
    label: 'Write the birthday message',
    what: 'Writes the greeting posted to the staff group on an employee birthday.',
    group: 'Messages people read',
    changesState: false,
    sendsRawText: false,
    fallback: 'A fixed greeting with the names filled in is posted instead.',
  },
  {
    key: 'datatruck_banter',
    label: 'Write the load-board banter line',
    what: 'Writes the one-line remark that goes out with a Datatruck load update.',
    group: 'Messages people read',
    changesState: false,
    sendsRawText: false,
    fallback: 'One of the stored lines is used, avoiding the ones sent recently.',
  },
  {
    key: 'dat_ui_inspection',
    label: 'Read a load-board page layout',
    what: 'Works out where the fields are on a DAT page whose layout has changed, '
      + 'so scraping keeps working after a redesign.',
    group: 'Operations',
    changesState: false,
    sendsRawText: false,
    fallback: 'The stored selectors are used; a genuine redesign has to be handled by hand.',
  },
  {
    key: 'safety_coaching_message',
    label: 'Write a driver safety note',
    what: 'Words the short note sent to a driver who shows a repeated driving habit, '
      + 'such as several hard stops in a fortnight.',
    group: 'Messages people read',
    changesState: false,
    sendsRawText: false,
    fallback: 'A fixed, friendly sentence naming the habit, the count and the one thing '
      + 'that helps. WHETHER a driver is coached is arithmetic and never involves a model, '
      + 'so with AI off every driver who should be coached still is.',
  },
  {
    key: 'recruiting_knowledge_reading',
    label: 'Understand something you taught Wenze',
    what: 'Reads a sentence an administrator typed about the company offer and reports '
      + 'what it believes should change, for that person to confirm.',
    group: 'Recruiting',
    changesState: false,
    sendsRawText: false,
    fallback: 'A deterministic reading classifies the sentence and restates it plainly. '
      + 'Nothing takes effect without a person confirming either way, so AI changes only '
      + 'how good the restatement is.',
  },
  {
    key: 'recruiting_after_hours_reply',
    label: 'Answer a candidate outside working hours',
    what: 'Continues a candidate\'s SMS conversation in the assigned recruiter\'s name '
      + 'when the office is closed, using only what an administrator has approved.',
    group: 'Recruiting',
    changesState: false,
    // The candidate's own words go to the provider — there is no way to answer a
    // question without reading it. The screen says so plainly rather than
    // letting an administrator discover it.
    sendsRawText: true,
    fallback: 'One fixed line saying a recruiter will follow up. Wenze never answers a '
      + 'question from its own knowledge: with nothing approved, or with the draft '
      + 'refused for naming a figure no approved statement contains, that line is what '
      + 'the candidate gets.',
  },
  {
    key: 'retention_summary',
    label: 'Summarise why a driver may be at risk of leaving',
    what: 'Turns reasons already established from company records into one sentence for '
      + 'the operations chat. It does not decide who is at risk.',
    group: 'Operations',
    changesState: false,
    // Counts and reason phrases only — no name, no message text, no location.
    sendsRawText: false,
    fallback: 'A fixed sentence naming the heaviest reason and how many others there are. '
      + 'The same drivers are flagged for the same reasons with AI switched off; only the '
      + 'wording changes.',
  },
  {
    key: 'translation',
    label: 'Translate a broadcast',
    what: 'Translates an announcement before an administrator sends it.',
    group: 'Operations',
    changesState: false,
    sendsRawText: true,
    fallback: 'Translation is unavailable; the original text can still be sent.',
  },

  {
    key: 'control_reply_reading',
    label: 'Understand an answer you typed in the chat',
    what: 'Reads a reply to an operational question when the fixed wording rules could not '
      + 'tell what it meant, and picks one of the answers that question already offered.',
    group: 'Operations',
    changesState: true,
    stateNote: 'Its choice can apply, dismiss or delay one finding — but only a choice the '
      + 'question already offered, and only after the deterministic reader gave up. It never '
      + 'supplies a value: no truck, no person, no date.',
    // The owner's own sentence goes to the provider. There is no way to read a
    // reply without reading it.
    sendsRawText: true,
    fallback: 'The reply is treated as unclear: Wenze says it did not follow, the question '
      + 'stays open, and nothing changes.',
  },

  // ── Finance ──────────────────────────────────────────────────────────────
  {
    key: 'finance_document_extraction',
    label: 'Read a finance document',
    what: 'Reads a receipt, invoice or transfer screenshot posted in the finance group and '
      + 'reports the code, amount, date and recipient PRINTED ON IT.',
    group: 'Finance',
    changesState: true,
    stateNote: 'Fills that one document\'s own record and nothing else. No total, no report '
      + 'figure and no duplicate decision is ever taken from it — those are counted in SQL '
      + 'from the captured text.',
    sendsRawText: true,
    rawTextNote: 'The document\'s text and its caption are sent, fenced as untrusted data. '
      + 'That text is payment information.',
    fallback: 'The document is marked as needing a person and the counts say so. It is never '
      + 'recorded as read, and never guessed at.',
  },

  // ── AI looking after itself ──────────────────────────────────────────────
  {
    key: 'policy_reading',
    label: 'Interpret a provider terms change',
    what: 'Reads the passages that changed in an AI provider\'s terms and says what they mean.',
    group: 'AI provider terms',
    changesState: true,
    stateNote: 'Files a finding. A provider is only ever paused by an explicit rule, never by '
      + 'the model\'s opinion.',
    sendsRawText: false,
    fallback: 'The finding is filed without an interpretation, marked as not AI-assisted.',
  },
  {
    key: 'policy_source_discovery',
    label: 'Find a moved terms page',
    what: 'Picks the real terms page when the old address stops working.',
    group: 'AI provider terms',
    changesState: true,
    stateNote: 'Updates the watched address — and only ever to a page already fetched and '
      + 'verified.',
    sendsRawText: false,
    fallback: 'The first verified candidate is used.',
  },
]);

const BY_KEY = new Map(CAPABILITIES.map((c) => [c.key, c]));

function getCapabilityMeta(key) {
  return BY_KEY.get(key) || null;
}

/** The keys that can end up written into operational records. */
function stateChangingCapabilities() {
  return CAPABILITIES.filter((c) => c.changesState).map((c) => c.key);
}

/** Grouped for display, in catalogue order. */
function groupedCapabilities() {
  const groups = [];
  for (const cap of CAPABILITIES) {
    let bucket = groups.find((g) => g.group === cap.group);
    if (!bucket) { bucket = { group: cap.group, capabilities: [] }; groups.push(bucket); }
    bucket.capabilities.push(cap);
  }
  return groups;
}

module.exports = {
  CAPABILITIES,
  getCapabilityMeta,
  stateChangingCapabilities,
  groupedCapabilities,
};
