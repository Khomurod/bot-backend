'use strict';

/**
 * One read of Datatruck for the Board ↔ Wenze ↔ Datatruck comparison: who is
 * which driver type, and which truck each load of the last week ran on.
 *
 * Shared by the report a person opens (`report.js`, at most once per ten
 * minutes) and the daily check (`daily.js`, once a day) — one shape, one place
 * that knows Datatruck's field names.
 *
 * GET only, through the shared client (`services/datatruckApiService.js`).
 * Datatruck's allowance is shared with the Gross Grand Prix
 * (`docs/architecture/gross-race.md`): a driver list and a week of orders is a
 * handful of pages. A failure is returned as `{read:false, reason}` in words a
 * page may show — a status code, never the URL or the token.
 */

const ORDER_DAYS = 7;

function fullName(account = {}) {
  return account.full_name || [account.first_name, account.last_name].filter(Boolean).join(' ') || null;
}

/** Datatruck: who is which type, and which truck each recent load ran on. */
async function readDatatruck(datatruck, nowMs) {
  if (!datatruck.isConfigured()) return { read: false, reason: 'Datatruck is not connected (no token in Settings → Secrets).' };
  try {
    const startIso = new Date(nowMs - ORDER_DAYS * 86_400_000).toISOString();
    const endIso = new Date(nowMs + 86_400_000).toISOString();
    const [drivers, orders] = [await datatruck.fetchAllDrivers(), await datatruck.fetchOrdersByPickupWindow(startIso, endIso)];
    return {
      read: true,
      drivers: (drivers || []).map((d) => ({ name: fullName(d.account), driverType: d.driver_type || null })).filter((d) => d.name),
      orders: (orders || []).map((o) => ({
        label: o?.trip?.truck__unit_number || o?.assigned_driver_n_truck?.truck_unit_number || null,
        drivers: [o?.trip?.driver__full_name, o?.trip?.team_driver__full_name].filter(Boolean),
        at: o?.pickup_time || o?.pickup_appointment_time || null,
      })).filter((o) => o.label),
    };
  } catch (err) {
    const status = err && (err.status || err.statusCode);
    return { read: false, reason: `Datatruck could not be read${status ? ` (HTTP ${status})` : ''}.` };
  }
}

module.exports = { readDatatruck, ORDER_DAYS };
