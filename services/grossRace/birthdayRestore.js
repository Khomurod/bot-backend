'use strict';

/**
 * Today's birthdays back on the race boards after a restart.
 *
 * The board's list lives in memory (birthdays.js), so a deploy in the middle
 * of a birthday would take it off the screens. ONCE PER RESTART this reads
 * what the birthday services recorded as sent in the last day (their own
 * `service_runs` keys), the names and trucks, and draws each employee's card
 * again — one set of queries per restart, never per board poll.
 *
 * Never throws: a failed restore leaves the boards without birthdays until the
 * next post, and costs nothing else.
 */
const raceDb = require('../../database/raceBirthdays');
const { board: defaultBoard, driverBoardName } = require('./birthdays');
const { prepareCard: defaultPrepareCard } = require('../employees/cardForEmployee');
const { cardFirstName, cardAmericanName } = require('../employees/birthdayText');

const EMPLOYEE_SENT = /^employee:\d{4}-\d{2}-\d{2}:(\d+):sent$/;
const DRIVER_SENT = /^driver:(\d+):\d{4}-\d{2}-\d{2}$/;

/** The sends worth showing again, newest per person: `{ employees, drivers }`, each `[{ id, sentAt }]`. */
function readSends(rows, at) {
  const pick = (re) => {
    const byId = new Map();
    for (const row of rows) {
      const m = re.exec(String(row.runKey || ''));
      if (!m || !Number.isFinite(row.ageSeconds)) continue;
      const sentAt = at - Math.max(0, row.ageSeconds) * 1000;
      const id = Number(m[1]);
      if (!byId.has(id) || byId.get(id) < sentAt) byId.set(id, sentAt);
    }
    return [...byId].map(([id, sentAt]) => ({ id, sentAt }));
  };
  return { employees: pick(EMPLOYEE_SENT), drivers: pick(DRIVER_SENT) };
}

async function restoreRaceBirthdays({
  db = raceDb, board = defaultBoard, prepareCard = defaultPrepareCard, now = () => Date.now(), log = console,
} = {}) {
  let restored = 0;
  try {
    const at = now();
    const { employees, drivers } = readSends(await db.getRecentBirthdaySends(), at);
    if (!employees.length && !drivers.length) return 0;

    const people = new Map((await db.getEmployeesForCards(employees.map((e) => e.id))).map((r) => [Number(r.id), r]));
    for (const { id, sentAt } of employees) {
      const employee = people.get(id);
      if (!employee) continue;
      let card = null;
      try {
        card = await prepareCard(employee);
      } catch (err) {
        log.warn(`[GROSS-RACE] Could not draw employee ${id}'s birthday card again:`, err.message);
      }
      if (board.noteBirthday({
        kind: 'employee', id, name: cardFirstName(employee), subtitle: cardAmericanName(employee), sentAt, card,
      })) restored += 1;
    }

    const faces = new Map((await db.getDriverFaces(drivers.map((d) => d.id))).map((r) => [Number(r.id), r]));
    for (const { id, sentAt } of drivers) {
      const face = faces.get(id);
      if (!face) continue;
      if (board.noteBirthday({
        kind: 'driver', id, name: driverBoardName(face.group_name), truck: face.unit_number || null, sentAt,
      })) restored += 1;
    }
    if (restored) log.log(`[GROSS-RACE] ${restored} birthday(s) from the last day back on the race boards`);
  } catch (err) {
    log.warn('[GROSS-RACE] Could not restore the race boards\' birthdays:', err.message);
  }
  return restored;
}

module.exports = { restoreRaceBirthdays, readSends };
