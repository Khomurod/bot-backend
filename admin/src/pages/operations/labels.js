/**
 * Turning a finding into something a dispatcher can act on. PURE.
 *
 * The engine speaks in check keys and JSONB. A person needs to know what is
 * wrong, how sure the system is, and what would change — in that order. These
 * are the rules that translate, kept out of the components so they can be
 * tested without rendering anything.
 *
 * The wording matters more than it looks. `home_time.closable_open_cycle` is
 * technically accurate and tells an operator nothing; "a home stay that never
 * got closed" is the same fact in words someone can decide about. A page that
 * needs the schema open beside it to be read does not get read.
 */

export const SEVERITY_META = {
  serious: { label: 'Serious', pill: 'status-pill--danger', order: 0 },
  warning: { label: 'Warning', pill: 'status-pill--warning', order: 1 },
  info: { label: 'Info', pill: 'status-pill--info', order: 2 },
};

/**
 * What the system is allowed to do about a finding, said plainly.
 *
 * `auto` does NOT mean "this already happened" — it means the value is recorded
 * elsewhere so software COULD copy it, once a person has granted that specific
 * check permission. Every check ships disabled, so the honest label is about
 * eligibility, not activity.
 */
export const TIER_META = {
  auto: {
    label: 'Can be corrected',
    hint: 'The corrected value is already recorded elsewhere in our own data, so nothing is guessed.',
    pill: 'status-pill--success',
  },
  approval: {
    label: 'Needs a decision',
    hint: 'The evidence is strong, but the call is a business one. A person picks.',
    pill: 'status-pill--info',
  },
  warning: {
    label: 'Report only',
    hint: 'Nothing is registered to change this automatically — it is here to be seen.',
    pill: 'status-pill--neutral',
  },
};

/** Plain-language names for the checks, keyed by their check_key. */
const CHECK_LABELS = {
  'home_time.closable_open_cycle': 'Home stay never closed',
  'home_time.home_stay_past_allowance': 'Home longer than the allowance',
  'home_time.road_clock_past_allowance': 'On the road past the allowance',
  'home_time.ghost_home_status': 'Tracked driver whose group is gone',
  'identity.status_disagreement': 'Group and profile disagree on status',
  'identity.duplicate_unit': 'One unit on several active drivers',
  'identity.same_person_two_groups': 'One person on two active groups',
  'identity.unit_number_mismatch': 'Profile unit differs from the group title',
  'identity.bot_left_active_group': 'Bot removed from a group still marked active',
  'identity.silent_active_group': 'Active group with no messages for months',
  'identity.non_driver_typed_as_driver': 'Admin chat typed as a driver group',
  'identity.group_without_person': 'Driver group with no permanent identity yet',
  'identity.person_on_two_active_groups': 'One person on two active groups',
  'identity.unit_contested': 'Profile claims a truck recorded to someone else',
  'identity.stale_unit_assignment': "Driver's recorded truck is behind the profile",
  'samsara.vehicle_on_two_active_groups': 'One Samsara vehicle on two active groups',
  'samsara.vehicle_link_disagrees': "Group's Samsara vehicle differs from the driver's truck",
  'fuel.watch_on_inactive_group': 'Fuel watch running for an inactive group',
  'dispatch.team_driver_on_inactive_group': "Team seat points at a chat the driver left",
  'raise.progress_without_person': 'Mileage drivers not matched to an identity',
  'route_control.assignment_on_inactive_group': 'Active route on an inactive group',
  'home_time.clock_reset_on_group_change': 'Road clock restarted on a new chat',
  'home_time.returned_to_road': 'Driver looks back on the road',
  'home_time.return_to_road_unclear': 'Unclear whether the driver is back on the road',
  'load.phase_unclear': "Unclear what a load is actually doing",
  'operations.auto_apply_capped': 'A check wanted to change too much and stopped',
  'board.unknown_fleet_label': 'Dispatcher board fleet label Wenze cannot read',
  'board.duplicate_row_key': 'Two dispatcher board lines Wenze cannot tell apart',
  'board.fleet_label_typo': 'Dispatcher board fleet label is misspelled',
  'board.unknown_status': 'Dispatcher board status outside the known list',
  'board.team_flag_mismatch': 'Dispatcher board unclear whether a row is a team',
  'board.truck_on_multiple_rows': 'One truck on two dispatcher board rows',
  'board.row_vanished': 'A driver left the dispatcher board',
};

export function checkLabel(checkKey) {
  return CHECK_LABELS[checkKey] || checkKey;
}

/** Group findings by check so 46 drivers past their allowance read as one problem. */
export function groupByCheck(findings) {
  const groups = new Map();
  for (const finding of findings) {
    if (!groups.has(finding.checkKey)) {
      groups.set(finding.checkKey, {
        checkKey: finding.checkKey,
        label: checkLabel(finding.checkKey),
        severity: finding.severity,
        items: [],
      });
    }
    const group = groups.get(finding.checkKey);
    group.items.push(finding);
    // A group is as loud as its loudest member.
    if (SEVERITY_META[finding.severity]?.order < SEVERITY_META[group.severity]?.order) {
      group.severity = finding.severity;
    }
  }
  return [...groups.values()].sort(
    (a, b) => (SEVERITY_META[a.severity]?.order ?? 9) - (SEVERITY_META[b.severity]?.order ?? 9)
      || b.items.length - a.items.length
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function displayValue(value) {
  if (value === null || value === undefined) return '—';
  if (value === '') return '(empty)';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (isPlainObject(value) || Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

/**
 * The proposed change as explicit before/after rows.
 *
 * THE CHECKS EMIT TWO SHAPES, and handling only one is a quiet, ugly bug:
 * `home_time.closable_open_cycle` writes a nested pair per column
 * (`{ returnToRoadAt: { from, to } }`), while `identity.status_disagreement`
 * writes ONE named field flat on the object (`{ field: 'status', from, to }`).
 * Reading only the nested form made a status disagreement render as "nothing is
 * proposed" directly beside a live Apply button — the page contradicting itself
 * about a change to a driver's record.
 *
 * Everything else on the object is context (which table, which id). Showing
 * that as though it were an edit would make a one-column change look like a
 * rewrite of the row, so it is kept separate.
 */
const FLAT_KEYS = new Set(['field', 'from', 'to']);

function hasFlatChange(proposedChange) {
  return typeof proposedChange.field === 'string' && ('to' in proposedChange);
}

export function changeRows(proposedChange) {
  if (!isPlainObject(proposedChange)) return [];
  const rows = [];
  if (hasFlatChange(proposedChange)) {
    rows.push({
      field: proposedChange.field,
      from: displayValue(proposedChange.from),
      to: displayValue(proposedChange.to),
    });
  }
  for (const [field, value] of Object.entries(proposedChange)) {
    if (isPlainObject(value) && ('to' in value)) {
      rows.push({ field, from: displayValue(value.from), to: displayValue(value.to) });
    }
  }
  return rows;
}

/** The non-change parts of a proposal — which row it touches. */
export function changeContext(proposedChange) {
  if (!isPlainObject(proposedChange)) return [];
  const flat = hasFlatChange(proposedChange);
  return Object.entries(proposedChange)
    .filter(([field, value]) => !(isPlainObject(value) && ('to' in value))
      && !(flat && FLAT_KEYS.has(field)))
    .map(([field, value]) => ({ field, value: displayValue(value) }));
}

/** Every field a correction actually changed, old beside new. */
export function correctionRows(correction) {
  const oldValues = isPlainObject(correction?.oldValues) ? correction.oldValues : {};
  const newValues = isPlainObject(correction?.newValues) ? correction.newValues : {};
  const fields = [...new Set([...Object.keys(oldValues), ...Object.keys(newValues)])];
  return fields.map((field) => ({
    field,
    from: displayValue(oldValues[field]),
    to: displayValue(newValues[field]),
  }));
}

/**
 * Who did this.
 *
 * `system` is spelled out rather than left as a bare word, because "who changed
 * my driver's status" is the first question asked and "system" alone invites
 * the wrong answer — a model. No model ever authors a correction.
 */
export function initiatorLabel(initiator) {
  if (!initiator) return 'Unknown';
  if (initiator === 'system') return 'Automatically, from recorded evidence';
  if (initiator.startsWith('admin:')) return `Administrator #${initiator.slice(6)}`;
  // An operator who answered a question in the notification group. Shown as a
  // person rather than as a machine, because that is what it is.
  if (initiator.startsWith('telegram:')) return 'Answered in Telegram';
  return initiator;
}

export function formatWhen(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** "3 minutes ago" for the sweep line; exact times live in the drawer. */
export function formatAgo(value) {
  if (!value) return 'never';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return 'never';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** How confident, in words. A bare "90" invites false precision. */
export function confidenceLabel(confidence) {
  if (confidence === null || confidence === undefined) return null;
  const n = Number(confidence);
  if (!Number.isFinite(n)) return null;
  if (n >= 95) return `Very high (${n}%)`;
  if (n >= 80) return `High (${n}%)`;
  if (n >= 50) return `Moderate (${n}%)`;
  return `Low (${n}%)`;
}
