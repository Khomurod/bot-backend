export const STATUS_FILTERS = [
  { value: "active", label: "All active drivers" },
  { value: "company", label: "Only company drivers" },
  { value: "owner", label: "Only owner operators" },
  { value: "inactive", label: "Only inactive drivers" },
  { value: "road", label: "Only on the road drivers" },
  { value: "home", label: "Only at home drivers" },
  { value: "home_company", label: "Only at home company drivers" },
  { value: "home_owner", label: "Only at home owner operators" },
];

export const HOME_TIME_SORT_COLUMNS = [
  "unit_number",
  "driver_name",
  "driver_type",
  "state",
  "current_cycle_days",
  "state_since",
  "next_home_time_date",
  "requests_count",
  "completed_trips_count",
  "pending_bonus_usd",
  "lifetime_bonus_usd",
];

export function driverTypeLabel(type) {
  if (type === "company_driver") return "Company driver";
  if (type === "owner") return "Owner operator";
  return "Unknown";
}

export function isCompanyDriver(type) {
  return type === "company_driver";
}

export function matchesStatusFilter(status, filter) {
  switch (filter) {
    case "active":
      return !status.inactive;
    case "company":
      return !status.inactive && isCompanyDriver(status.driver_type);
    case "owner":
      return !status.inactive && status.driver_type === "owner";
    case "inactive":
      return Boolean(status.inactive);
    case "road":
      return !status.inactive && status.state === "road";
    case "home":
      return !status.inactive && status.state === "home";
    case "home_company":
      return !status.inactive && status.state === "home" && isCompanyDriver(status.driver_type);
    case "home_owner":
      return !status.inactive && status.state === "home" && status.driver_type === "owner";
    default:
      return !status.inactive;
  }
}

function normalizeGroupId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUnitForSort(value) {
  if (value == null || value === "") return null;
  const digits = String(value).match(/\d+/);
  if (!digits) return null;
  return Number.parseInt(digits[0], 10);
}

function matchesDriverSearch(status, searchQuery) {
  if (!searchQuery) return true;
  const haystack = [
    status.driver_name,
    status.unit_number,
    status.driver_type,
    status.state,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(searchQuery.trim().toLowerCase());
}

function compareDateDesc(a, b) {
  const aTime = a ? new Date(a).getTime() : 0;
  const bTime = b ? new Date(b).getTime() : 0;
  return bTime - aTime;
}

function compareNullableNumbers(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

function compareNullableStrings(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function compareNullableDates(a, b) {
  const left = a ? new Date(a).getTime() : Number.NaN;
  const right = b ? new Date(b).getTime() : Number.NaN;
  const leftValid = Number.isFinite(left);
  const rightValid = Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return 1;
  if (!rightValid) return -1;
  return left - right;
}

function compareDriverRows(a, b, sortKey, sortDirection) {
  let result = 0;
  switch (sortKey) {
    case "unit_number":
      result = compareNullableNumbers(a.unit_number_sort, b.unit_number_sort);
      if (result === 0) result = compareNullableStrings(a.unit_number, b.unit_number);
      break;
    case "driver_name":
      result = compareNullableStrings(a.driver_name, b.driver_name);
      break;
    case "driver_type":
      result = compareNullableStrings(a.driver_type, b.driver_type);
      break;
    case "state":
      result = compareNullableStrings(a.state, b.state);
      break;
    case "current_cycle_days":
      result = compareNullableNumbers(a.current_cycle_days, b.current_cycle_days);
      break;
    case "state_since":
      result = compareNullableDates(a.state_since, b.state_since);
      break;
    case "next_home_time_date":
      result = compareNullableDates(a.next_home_time_date, b.next_home_time_date);
      break;
    case "requests_count":
      result = compareNullableNumbers(a.requests_count, b.requests_count);
      break;
    case "completed_trips_count":
      result = compareNullableNumbers(a.completed_trips_count, b.completed_trips_count);
      break;
    case "pending_bonus_usd":
      result = compareNullableNumbers(a.pending_bonus_usd, b.pending_bonus_usd);
      break;
    case "lifetime_bonus_usd":
      result = compareNullableNumbers(a.lifetime_bonus_usd, b.lifetime_bonus_usd);
      break;
    default:
      result = compareNullableNumbers(a.unit_number_sort, b.unit_number_sort);
      if (result === 0) result = compareNullableStrings(a.driver_name, b.driver_name);
      break;
  }

  if (result === 0) {
    result = compareNullableStrings(a.driver_name, b.driver_name);
  }

  return sortDirection === "desc" ? result * -1 : result;
}

function groupRowsByGroupId(rows, dateField) {
  const grouped = new Map();
  for (const row of rows || []) {
    const groupId = normalizeGroupId(row.group_id);
    if (groupId == null) continue;
    if (!grouped.has(groupId)) grouped.set(groupId, []);
    grouped.get(groupId).push(row);
  }
  for (const items of grouped.values()) {
    items.sort((a, b) => compareDateDesc(a[dateField], b[dateField]));
  }
  return grouped;
}

function buildUnlinkedActivity(statuses, requests, history) {
  const statusIds = new Set((statuses || []).map((row) => normalizeGroupId(row.group_id)).filter((id) => id != null));
  const items = [];

  for (const request of requests || []) {
    const groupId = normalizeGroupId(request.group_id);
    if (groupId != null && statusIds.has(groupId)) continue;
    items.push({
      id: `request-${request.id}`,
      kind: "request",
      timestamp: request.requested_at || request.home_from || request.home_to || null,
      driver_name: request.driver_name || request.group_name || "Unknown driver",
      driver_type: request.driver_type || null,
      unit_number: request.unit_number || null,
      status: request.status,
      home_from: request.home_from || null,
      home_to: request.home_to || null,
      source: request.source || null,
    });
  }

  for (const trip of history || []) {
    const groupId = normalizeGroupId(trip.group_id);
    if (groupId != null && statusIds.has(groupId)) continue;
    items.push({
      id: `trip-${trip.id}`,
      kind: "trip",
      timestamp: trip.home_arrived_at || trip.road_started_at || null,
      driver_name: trip.driver_name || trip.group_name || "Unknown driver",
      driver_type: trip.driver_type || null,
      unit_number: trip.unit_number || null,
      road_started_at: trip.road_started_at || null,
      home_arrived_at: trip.home_arrived_at || null,
      bonus_usd: trip.bonus_usd || 0,
    });
  }

  return items.sort((a, b) => compareDateDesc(a.timestamp, b.timestamp));
}

function buildDriverRows(statuses, requestsByGroupId, historyByGroupId) {
  return (statuses || []).map((status) => {
    const groupId = normalizeGroupId(status.group_id);
    const driverRequests = requestsByGroupId.get(groupId) || [];
    const driverHistory = historyByGroupId.get(groupId) || [];
    const pendingRequestsCount = driverRequests.filter((row) => row.status === "pending").length;
    const lifetimeBonusUsd = driverHistory.reduce((sum, row) => sum + Number(row.bonus_usd || 0), 0);
    return {
      ...status,
      unit_number_sort: normalizeUnitForSort(status.unit_number),
      current_cycle_days: status.state === "road" ? Number(status.days_on_road || 0) : Number(status.days_home || 0),
      requests_count: driverRequests.length,
      pending_requests_count: pendingRequestsCount,
      completed_trips_count: driverHistory.length,
      lifetime_bonus_usd: lifetimeBonusUsd,
      pending_bonus_usd: Number(status.pending_bonus_usd || 0),
    };
  });
}

export function buildHomeTimeViewModel({
  statuses = [],
  history = [],
  requests = [],
  statusFilter = "active",
  searchQuery = "",
  sortKey = "unit_number",
  sortDirection = "asc",
}) {
  const activeStatuses = statuses.filter((row) => !row.inactive);
  const onRoad = activeStatuses.filter((row) => row.state === "road");
  const atHome = activeStatuses.filter((row) => row.state === "home");
  const overLimit = onRoad.filter((row) => isCompanyDriver(row.driver_type) && row.over_limit);
  const inactiveCount = statuses.filter((row) => row.inactive).length;
  const companyCount = activeStatuses.filter((row) => isCompanyDriver(row.driver_type)).length;
  const ownerCount = activeStatuses.filter((row) => row.driver_type === "owner").length;
  const requestsByGroupId = groupRowsByGroupId(requests, "requested_at");
  const historyByGroupId = groupRowsByGroupId(history, "home_arrived_at");
  const driverRows = buildDriverRows(statuses, requestsByGroupId, historyByGroupId);

  const filteredStatuses = driverRows
    .filter((row) => matchesStatusFilter(row, statusFilter) && matchesDriverSearch(row, searchQuery))
    .sort((a, b) => compareDriverRows(a, b, sortKey, sortDirection));

  return {
    activeStatuses,
    onRoad,
    atHome,
    overLimit,
    inactiveCount,
    companyCount,
    ownerCount,
    filteredStatuses,
    requestsByGroupId,
    historyByGroupId,
    unlinkedActivity: buildUnlinkedActivity(statuses, requests, history),
  };
}

export function buildDriverTimeline({ requests = [], history = [] }) {
  const items = [];

  for (const request of requests) {
    items.push({
      id: `request-${request.id}`,
      kind: "request",
      timestamp: request.requested_at || request.home_from || request.home_to || null,
      status: request.status,
      source: request.source || null,
      policy_met: request.policy_met,
      days_on_road: request.days_on_road,
      home_from: request.home_from || null,
      home_to: request.home_to || null,
      decided_by_username: request.decided_by_username || null,
    });
  }

  for (const trip of history) {
    items.push({
      id: `trip-${trip.id}`,
      kind: "trip",
      timestamp: trip.home_arrived_at || trip.road_started_at || null,
      road_started_at: trip.road_started_at || null,
      home_arrived_at: trip.home_arrived_at || null,
      days_on_road: trip.days_on_road,
      exceeded_weeks: trip.exceeded_weeks,
      bonus_usd: trip.bonus_usd,
      driver_type: trip.driver_type || null,
    });
  }

  return items.sort((a, b) => compareDateDesc(a.timestamp, b.timestamp));
}
