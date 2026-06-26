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

export function buildHomeTimeViewModel({
  statuses = [],
  history = [],
  requests = [],
  statusFilter = "active",
  searchQuery = "",
}) {
  const activeStatuses = statuses.filter((row) => !row.inactive);
  const onRoad = activeStatuses.filter((row) => row.state === "road");
  const atHome = activeStatuses.filter((row) => row.state === "home");
  const overLimit = onRoad.filter((row) => isCompanyDriver(row.driver_type) && row.over_limit);
  const inactiveCount = statuses.filter((row) => row.inactive).length;
  const companyCount = activeStatuses.filter((row) => isCompanyDriver(row.driver_type)).length;
  const ownerCount = activeStatuses.filter((row) => row.driver_type === "owner").length;

  const sortedStatuses = [...statuses].sort((a, b) => {
    const inactiveDiff = (a.inactive ? 1 : 0) - (b.inactive ? 1 : 0);
    if (inactiveDiff !== 0) return inactiveDiff;
    if (a.state !== b.state) return a.state === "road" ? -1 : 1;
    return String(a.driver_name || "").localeCompare(String(b.driver_name || ""));
  });

  const filteredStatuses = sortedStatuses.filter((row) => {
    return matchesStatusFilter(row, statusFilter) && matchesDriverSearch(row, searchQuery);
  });

  return {
    activeStatuses,
    onRoad,
    atHome,
    overLimit,
    inactiveCount,
    companyCount,
    ownerCount,
    sortedStatuses,
    filteredStatuses,
    requestsByGroupId: groupRowsByGroupId(requests, "requested_at"),
    historyByGroupId: groupRowsByGroupId(history, "home_arrived_at"),
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
