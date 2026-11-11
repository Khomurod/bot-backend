'use strict';

/**
 * What the bot itself may do about one Board ↔ Bitrix difference — the
 * buttons under a question (owner, 11 November 2026: "suggest it with buttons
 * if it can do it itself"). PURE.
 *
 * THE LIST IS CLOSED AND BUILT BY RULES. Each action is derived from the
 * difference's own facts, the Board being the source of truth:
 *
 *   set_stage        move the deal to a stage of its pipeline — the one the
 *                    Board's status maps to, or a closing stage (TERMINATED,
 *                    LEFT, RESIGNED) for a driver no longer on the Board
 *   set_title        rename the deal to the name on the Board
 *   set_driver_type  set the deal's driver type to the Board's fleet
 *   set_truck        point the deal at the truck the Board names
 *   truck_on_road    move a truck the Board shows driving to "On the road"
 *
 * A model may CHOOSE among these and explain them (services/boardBitrix/
 * advice.js); it can never add one. Every action carries what Bitrix said
 * when it was offered (`from…`), and services/boardBitrix/apply.js re-reads
 * Bitrix at the press and refuses an action whose starting point has moved.
 */

const { dealStageName, fleetLabel, EXPECTED_ROLE_FOR_BOARD_STATUS } = require('./vocabulary');

const TYPES = Object.freeze(['set_stage', 'set_title', 'set_driver_type', 'set_truck', 'truck_on_road']);
/** Buttons per question: Telegram shows them one per row; more is a wall. */
const MAX_ACTIONS = 4;

/** The Bitrix driver-type value for a fleet, from the schema's own map. */
function driverTypeValue(schema, fleet) {
  const entry = Object.entries(schema?.fleetByDriverType || {}).find(([, f]) => f === fleet);
  return entry ? String(entry[0]) : null;
}

const stage = (deal, stageId, stageName) => ({
  type: 'set_stage',
  label: `Move "${deal.title}" to ${stageName}`,
  params: {
    dealId: deal.id, stageId, stageName, fromStageId: deal.stageId || null,
  },
});

function forPair(x, schema) {
  const { deal, board } = x;
  switch (x.kind) {
    case 'status_differs':
    case 'inactive_in_bitrix': {
      const role = EXPECTED_ROLE_FOR_BOARD_STATUS[String(board.status || '').toUpperCase()] || null;
      const target = x.expectedStageId || (role ? schema?.stageByRole?.[role] : null) || null;
      return target ? [stage(deal, target, dealStageName(target))] : [];
    }
    case 'fleet_missing':
    case 'fleet_differs': {
      const value = driverTypeValue(schema, board.fleetType);
      return value ? [{
        type: 'set_driver_type',
        label: `Set "${deal.title}" to ${fleetLabel(board.fleetType)}`,
        params: {
          dealId: deal.id, value, fleet: board.fleetType, fromFleet: deal.fleetType || null,
        },
      }] : [];
    }
    case 'truck_missing':
    case 'truck_differs':
      return board.truck ? [{
        type: 'set_truck',
        label: `Assign truck ${board.truck} to "${deal.title}"`,
        params: {
          dealId: deal.id, truckNumber: board.truck, fleet: board.fleetType || null, fromTruckId: deal.truckId || null,
        },
      }] : [];
    case 'truck_inactive':
      return x.truck ? [{
        type: 'truck_on_road',
        label: `Move truck ${x.truck.number || x.truck.title} to "On the road"`,
        params: { truckId: x.truck.id, fromStageId: x.truck.stageId || null },
      }] : [];
    default:
      return [];
  }
}

/**
 * @param {object} details  the discrepancy (lib/boardBitrix/compare.js)
 * @param {{schema?: object, closeStages?: {id: string, name: string}[]}} ctx
 *   closeStages: the deal pipeline's closing stages, as Bitrix names them
 * @returns {{type, label, params}[]}
 */
function candidateActions(details, { schema = null, closeStages = [] } = {}) {
  const x = details || {};
  let out = [];
  if (x.kind === 'not_on_board' && x.deal) {
    out = closeStages.map((s) => stage(x.deal, s.id, s.name));
  } else if (x.kind === 'name_differs' && x.board?.length === 1 && x.deals?.length === 1) {
    const deal = x.deals[0];
    out = [{
      type: 'set_title',
      label: `Rename "${deal.title}" to "${x.board[0].name}"`,
      params: { dealId: deal.id, title: x.board[0].name, fromTitle: deal.title },
    }];
  } else if (x.deal && x.board) {
    out = forPair(x, schema);
  }
  return out.filter((a) => TYPES.includes(a.type)).slice(0, MAX_ACTIONS);
}

// ── how advice shows under a question ──────────────────────────────────────

const CALLBACK_PATTERN = /^bbx:(\d{1,12}):(\d|s)$/;
const LINE_LIMIT = 150;

/** Words wrapped into lines the notice composer will not clip (it cuts at 160). */
function wrap(text, limit = LINE_LIMIT) {
  const out = [];
  let line = '';
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > limit) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/** "💡 …" lines, then what each button does. */
function adviceLines(advice) {
  const lines = [];
  if (advice?.recommendation) lines.push(...wrap(`💡 ${advice.recommendation}`));
  if (advice?.actions?.length) lines.push('Tap a button and I will do it in Bitrix, or fix it yourself and reply "done".');
  return lines;
}

/** One button per action, then Skip. Callback data: `bbx:<question id>:<index | s>`. */
function adviceKeyboard(questionId, advice) {
  const id = Number(questionId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const rows = (advice?.actions || []).slice(0, MAX_ACTIONS).map((a, i) => [{
    text: `✅ ${String(a.label).slice(0, 60)}`, callback_data: `bbx:${id}:${i}`,
  }]);
  rows.push([{ text: '⏭ Skip — ask me tomorrow', callback_data: `bbx:${id}:s` }]);
  return { inline_keyboard: rows };
}

module.exports = {
  TYPES, MAX_ACTIONS, CALLBACK_PATTERN, candidateActions, driverTypeValue, wrap, adviceLines, adviceKeyboard,
};
