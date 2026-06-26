const test = require("node:test");
const assert = require("node:assert/strict");

let modulePromise;

async function loadViewModel() {
  if (!modulePromise) {
    modulePromise = import("../admin/src/pages/homeTimeViewModel.js");
  }
  return modulePromise;
}

test("buildHomeTimeViewModel applies filters and groups activity by driver", async () => {
  const { buildHomeTimeViewModel } = await loadViewModel();

  const statuses = [
    {
      group_id: 10,
      driver_name: "Alice Driver",
      driver_type: "company_driver",
      unit_number: "501",
      state: "road",
      inactive: false,
      over_limit: true,
    },
    {
      group_id: 20,
      driver_name: "Bob Owner",
      driver_type: "owner",
      unit_number: "777",
      state: "home",
      inactive: false,
      over_limit: false,
    },
    {
      group_id: 30,
      driver_name: "Carol Inactive",
      driver_type: "company_driver",
      unit_number: "909",
      state: "home",
      inactive: true,
      over_limit: false,
    },
  ];

  const requests = [
    { id: 1, group_id: 10, requested_at: "2026-06-10", status: "approved" },
    { id: 2, group_id: 10, requested_at: "2026-06-01", status: "pending" },
    { id: 3, group_id: 999, requested_at: "2026-06-15", status: "denied", driver_name: "Old Driver" },
  ];

  const history = [
    { id: 11, group_id: 10, home_arrived_at: "2026-06-20", bonus_usd: 300 },
    { id: 12, group_id: 10, home_arrived_at: "2026-05-20", bonus_usd: 0 },
    { id: 13, group_id: null, home_arrived_at: "2026-06-18", driver_name: "Manual Trip", bonus_usd: 0 },
  ];

  const result = buildHomeTimeViewModel({
    statuses,
    history,
    requests,
    statusFilter: "company",
    searchQuery: "alice",
    sortKey: "unit_number",
    sortDirection: "asc",
  });

  assert.equal(result.onRoad.length, 1);
  assert.equal(result.atHome.length, 1);
  assert.equal(result.overLimit.length, 1);
  assert.equal(result.inactiveCount, 1);
  assert.equal(result.companyCount, 1);
  assert.equal(result.ownerCount, 1);
  assert.equal(result.filteredStatuses.length, 1);
  assert.equal(result.filteredStatuses[0].group_id, 10);
  assert.equal(result.requestsByGroupId.get(10).length, 2);
  assert.equal(result.historyByGroupId.get(10).length, 2);
  assert.equal(result.unlinkedActivity.length, 2);
  assert.equal(result.unlinkedActivity[0].id, "trip-13");
  assert.equal(result.filteredStatuses[0].requests_count, 2);
  assert.equal(result.filteredStatuses[0].pending_requests_count, 1);
  assert.equal(result.filteredStatuses[0].completed_trips_count, 2);
  assert.equal(result.filteredStatuses[0].lifetime_bonus_usd, 300);
});

test("buildDriverTimeline merges requests and trips in descending date order", async () => {
  const { buildDriverTimeline } = await loadViewModel();

  const timeline = buildDriverTimeline({
    requests: [
      { id: 100, requested_at: "2026-06-11", status: "pending", home_from: "2026-06-20", home_to: "2026-06-24" },
      { id: 101, requested_at: "2026-06-21", status: "approved", home_from: "2026-06-28", home_to: "2026-07-02" },
    ],
    history: [
      { id: 200, road_started_at: "2026-05-01", home_arrived_at: "2026-06-15", days_on_road: 45, bonus_usd: 100, driver_type: "company_driver" },
    ],
  });

  assert.deepEqual(
    timeline.map((item) => item.id),
    ["request-101", "trip-200", "request-100"]
  );
  assert.equal(timeline[1].kind, "trip");
  assert.equal(timeline[2].kind, "request");
});

test("buildHomeTimeViewModel sorts by truck number numerically and toggles descending", async () => {
  const { buildHomeTimeViewModel } = await loadViewModel();

  const statuses = [
    { group_id: 1, driver_name: "Zulu", driver_type: "company_driver", unit_number: "313", state: "road", inactive: false, days_on_road: 4 },
    { group_id: 2, driver_name: "Alpha", driver_type: "owner", unit_number: "007", state: "home", inactive: false, days_home: 3 },
    { group_id: 3, driver_name: "Beta", driver_type: "company_driver", unit_number: "88", state: "road", inactive: false, days_on_road: 8 },
  ];

  const asc = buildHomeTimeViewModel({
    statuses,
    history: [],
    requests: [],
    sortKey: "unit_number",
    sortDirection: "asc",
  });

  const desc = buildHomeTimeViewModel({
    statuses,
    history: [],
    requests: [],
    sortKey: "unit_number",
    sortDirection: "desc",
  });

  assert.deepEqual(asc.filteredStatuses.map((row) => row.unit_number), ["007", "88", "313"]);
  assert.deepEqual(desc.filteredStatuses.map((row) => row.unit_number), ["313", "88", "007"]);
});

test("buildHomeTimeViewModel sorts request and bonus columns from aggregated row data", async () => {
  const { buildHomeTimeViewModel } = await loadViewModel();

  const statuses = [
    { group_id: 1, driver_name: "A", driver_type: "company_driver", unit_number: "11", state: "road", inactive: false, days_on_road: 20, pending_bonus_usd: 0 },
    { group_id: 2, driver_name: "B", driver_type: "company_driver", unit_number: "12", state: "road", inactive: false, days_on_road: 50, pending_bonus_usd: 200 },
  ];

  const requests = [
    { id: 1, group_id: 1, requested_at: "2026-06-01", status: "pending" },
    { id: 2, group_id: 1, requested_at: "2026-06-02", status: "approved" },
    { id: 3, group_id: 2, requested_at: "2026-06-03", status: "pending" },
  ];

  const history = [
    { id: 11, group_id: 1, home_arrived_at: "2026-06-10", bonus_usd: 100 },
    { id: 12, group_id: 2, home_arrived_at: "2026-06-11", bonus_usd: 400 },
  ];

  const byRequests = buildHomeTimeViewModel({
    statuses,
    requests,
    history,
    sortKey: "requests_count",
    sortDirection: "desc",
  });

  const byLifetimeBonus = buildHomeTimeViewModel({
    statuses,
    requests,
    history,
    sortKey: "lifetime_bonus_usd",
    sortDirection: "desc",
  });

  assert.deepEqual(byRequests.filteredStatuses.map((row) => row.group_id), [1, 2]);
  assert.deepEqual(byLifetimeBonus.filteredStatuses.map((row) => row.group_id), [2, 1]);
  assert.equal(byRequests.filteredStatuses[0].requests_count, 2);
  assert.equal(byLifetimeBonus.filteredStatuses[0].lifetime_bonus_usd, 400);
});
