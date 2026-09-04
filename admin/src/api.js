/**
 * The admin API client.
 *
 * This file is a re-export façade: `import * as api from "./api"` keeps
 * working unchanged, and every call still resolves to the same name. The
 * implementations live in ./api/<domain>.js, one module per feature area,
 * mirroring the server route modules they talk to.
 *
 * Add new calls to the domain module they belong to and export them from
 * there — this file only forwards.
 */

export * from './api/auth';
export * from './api/groups';
export * from './api/questions';
export * from './api/broadcast';
export * from './api/media';
export * from './api/dispatch';
export * from './api/scheduled';
export * from './api/leads';
export * from './api/aiReports';
export * from './api/birthdays';
export * from './api/facebookLeads';
export * from './api/mileageBonus';
export * from './api/raise';
export * from './api/homeTime';
export * from './api/groupAccess';
export * from './api/fuelMonitor';
export * from './api/bot';
export * from './api/settings';
export * from './api/routeControl';
export * from './api/recruiters';
export * from './api/liveLocations';
export * from './api/safetyMusic';
export * from './api/trailerTracking';
export * from './api/system';
