/**
 * The faked dependency map behind `/api/health`'s `operations` block.
 *
 * EVERY block in that summary is composed from its own dependency, so a
 * missing one shows up as "cannot read properties of undefined" rather than as
 * a useful failure. The map had grown a dependency four times for exactly that
 * reason, and it is shared here rather than copied because a second copy is a
 * second thing to forget to update when a block is added.
 *
 * Pass `overrides` to replace any one dependency — that is how each test makes
 * one block fail without touching the others.
 */
function summaryDeps(overrides = {}) {
  return {
    consistency: {
      getConsistencyStatus: () => ({
        running: true,
        lastRun: { at: '2026-09-10T12:00:00.000Z', summary: { found: 12, filed: 3, resolved: 4 } },
        lastCorrections: { at: '2026-09-10T12:00:01.000Z', summary: { applied: 65, held: 3, stale: 0, failed: 0, capped: [{ checkKey: 'identity.group_without_person', wanted: 151, cap: 150, findingId: 9 }] } },
      }),
    },
    findings: { async summariseFindings() { return { info: 1, warning: 2, serious: 0, total: 3 }; } },
    people: {
      async summariseTelegramIdentities() {
        return { available: true, linked: 71, people: 70, closed: 2 };
      },
      async summariseIdentityCoverage() { return { people: 200, activeDriverGroups: 205, groupsWithoutPerson: 0, openUnits: 190, unstamped: { roadHistory: 0, requests: 0, mileage: 0 } }; } },
    integrity: { async countDuplicateOpenStays() { return []; }, async indexExists() { return true; } },
    observations: {
      async gatherAllObservations() {
        return [
          { component: 'fuel_risk', state: 'healthy', ok: true, critical: true, reason: 'ran', lastRunAt: '2026-09-20T17:50:00.000Z' },
          { component: 'retention_watch', state: 'stale_stopped', ok: false, critical: true, reason: 'no pass has finished in 900 minutes', lastRunAt: '2026-09-20T03:00:00.000Z' },
          { component: 'ai_providers', state: 'needs_human_attention', ok: true, critical: true, reason: 'no AI provider is enabled' },
        ];
      },
    },
    fuelReadings: {
      async summariseFuelReadings() {
        return { trucks: 110, withFuel: 104, comparable: 61, newestReading: '2026-09-20T17:40:00.000Z' };
      },
    },
    // The safety block is composed in, so it is faked in.
    safety: {
      async summariseSafety() {
        return {
          windowDays: 14, events: 9, byBehavior: { harsh_braking: 6, speeding: 3 },
          driversWithEvents: 2, coachingSent: 1, coachingToDrivers: 1,
        };
      },
    },
    // Each block below is composed into the same summary, so each is faked in.
    // (This harness has now grown a dep four times for exactly that reason;
    // a missing one shows up as "cannot read properties of undefined".)
    systemHealth: {
      async summariseHealthStates() {
        return { ok: 2, failed: 1, unchecked: 0, flapping: 0, down: ['ai_providers'] };
      },
    },
    learning: {
      async summariseSuggestions() { return { proposed: 1, accepted: 0, dismissed: 2 }; },
    },
    retention: {
      async summariseRetention() { return { urgent: 1, watch: 3, acknowledged: 1, lastPassAt: null }; },
    },
    learningPass: {
      getLearningStatus: () => ({
        running: true,
        lastRun: { at: '2026-09-11T04:40:00.000Z', ok: true, found: 0, proposed: 0, announced: 0, errors: 0 },
      }),
    },
    retentionWatch: {
      getRetentionStatus: () => ({
        running: true,
        lastRun: { at: '2026-09-11T04:40:00.000Z', ok: true, checked: 108, flagged: 2, notified: 1, urgent: 1, errors: 0 },
      }),
    },
    notificationSettings: {
      async getNotificationSettings() {
        return { enabled: true, defaultChatId: '-1005052301861', categoryChatIds: { fuel: '-100999' } };
      },
    },
    // The load lifecycle block is composed in, so it is faked in.
    loads: {
      async summariseLoadPhases() {
        return { total: 12, byPhase: { in_transit: 7, at_pickup: 3, delivered: 2 }, unclear: 2, conflicted: 1 };
      },
    },
    // The live Home Time block is composed in, so it is faked in.
    homeTimeHealth: {
      async getHomeTimeHealth() {
        return {
          available: true,
          returnWatch: { watching: 2, anchored: 2, high: 0, medium: 1, low: 1, lastCheckedAt: '2026-09-10T12:00:00.000Z', oldestCheckedAt: '2026-09-10T11:48:00.000Z' },
          managerNotices: { arrived_home: { rows: 3, events: 3, delivered: 3, pending: 0, failed: 0, abandoned: 0 } },
          requestsByStatus: { recorded: 4, pending: 79 },
          automaticReturns: { applied: 1, reverted: 0, lastAppliedAt: '2026-09-10T11:00:00.000Z' },
          aiResponsibilities: { registered: 17, switchedOff: 0, mayAutoApply: 0 },
        };
      },
    },
    aiProviders: {
      async listProvidersForAdmin() {
        return [
          { providerKey: 'gemini', enabled: true, modelChain: ['gemini-2.5-flash'], discoveredModels: [{ id: 'a' }, { id: 'b' }], modelsRefreshedAt: '2026-09-10T06:00:00.000Z', modelsRefreshError: null },
          { providerKey: 'groq', enabled: true, modelChain: ['x'], discoveredModels: [], modelsRefreshedAt: null, modelsRefreshError: `401 Unauthorized: ${'the provider said many words '.repeat(20)}` },
        ];
      },
    },
    // The control channel: counts only, never an operator id and never the
    // text somebody typed into a group chat.
    controlSettings: { async getControlSettings() { return { enabled: true }; } },
    controlOperators: {
      async listControlOperators() {
        return [{ telegramUserId: '2117922421', label: 'Owner' }];
      },
    },
    // Only the control-question summary: the discard counter is deliberately
    // left out, because two tests below assert what the block looks like
    // WITHOUT it, and a harness that supplied everything would quietly make
    // those two assertions untestable.
    notificationStore: {
      async summariseControlQuestions() {
        return {
          available: true, asked: 6, delivered: 6, answered: 4, outstanding: 2,
          lastAskedAt: '2026-09-12T11:00:00.000Z',
        };
      },
    },
    controlReplies: {
      async summariseControlReplies() {
        return { available: true, total: 9, refused: 2, last7d: 4, lastAt: '2026-09-12T10:00:00.000Z' };
      },
    },
    controlKnowledge: {
      async summariseKnowledge() {
        return {
          available: true, live: 3, revoked: 1, applied: 7,
          lastAppliedAt: '2026-09-12T09:00:00.000Z',
        };
      },
    },
    ...overrides,
  };
}

module.exports = { summaryDeps };
