/**
 * QBQ / SOS assessment — shared constants.
 *
 * PATTERNS is the closed set of thinking-pattern keys used by content options,
 * scoring, storage (CHECK constraints in migration 0003) and the UI. Do not
 * rename a key without a coordinated migration.
 */

const PATTERNS = ['victim', 'complaint', 'waiting', 'blame', 'ownership', 'builder'];

/**
 * Tie-break precedence for primary/secondary selection: when two patterns have
 * the same score, the more constructive one wins. Fixed and deterministic.
 */
const PATTERN_PRECEDENCE = ['ownership', 'builder', 'waiting', 'complaint', 'blame', 'victim'];

const LANGUAGES = ['uz', 'ru', 'en'];

/** Department keys are stable identifiers; labels are display-only. */
const DEPARTMENTS = [
  { key: 'hr', label: { uz: 'HR / Rekruting', ru: 'HR / Рекрутинг', en: 'HR / Recruiting' } },
  { key: 'safety', label: { uz: 'Xavfsizlik boʻlimi (Safety)', ru: 'Отдел безопасности (Safety)', en: 'Safety Department' } },
  { key: 'dispatch', label: { uz: 'Dispetcherlik (Dispatch)', ru: 'Диспетчерская (Dispatch)', en: 'Dispatch' } },
  { key: 'trailer', label: { uz: 'Treyler boʻlimi', ru: 'Трейлерный отдел', en: 'Trailer Department' } },
  { key: 'samsara', label: { uz: 'Samsara monitoring boʻlimi', ru: 'Отдел мониторинга Samsara', en: 'Samsara Monitoring Department' } },
  { key: 'accounting', label: { uz: 'Buxgalteriya (Accounting)', ru: 'Бухгалтерия (Accounting)', en: 'Accounting Department' } },
  { key: 'updaters', label: { uz: 'Updaterlar boʻlimi', ru: 'Отдел апдейтеров (Updaters)', en: 'Updaters' } },
];

const DEPARTMENT_KEYS = DEPARTMENTS.map((d) => d.key);

module.exports = { PATTERNS, PATTERN_PRECEDENCE, LANGUAGES, DEPARTMENTS, DEPARTMENT_KEYS };
