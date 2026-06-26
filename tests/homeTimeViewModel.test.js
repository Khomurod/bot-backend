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
