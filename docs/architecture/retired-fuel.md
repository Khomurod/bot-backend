# Fuel: stop reminders, the risk watch, the readings, and what is left of them

**Retired:** 2026-10, at the owner's request — "полностью все, что связано с
топливом, убираем" (everything to do with fuel goes, completely) and
"распознавание адреса заправок… полностью удаляем" (the gas-station address
recognition is deleted completely). · **Pre-removal source:** any `main` commit
before this removal merged; the code is recoverable with `git log
--diff-filter=D -- services/fuelStopAlertService.js`.

Fuel was three features that grew around one another:

- **Fuel-stop reminders (the Fuel Monitor).** When the Fuel Monitoring team
  posted a message opening with the *FUEL MONITORING DEPARTMENT* banner into a
  company driver's group, the bot pulled the station address out of it (a
  regex first, Gemini only when the pattern failed), geocoded it and recorded a
  `watching` row in `fuel_stop_alerts`. A 150-second due-scan
  (`fuel_stop_alerts` service) followed the truck's live GPS and, once it was
  within 50 miles of the station, replied to the original post tagging the
  driver. Every banner post was also kept in `fuel_monitor_inbox` so the admin
  *Refresh* button could retry a failed detection. The admin **Fuel Monitor**
  page listed company drivers with their watched stops and could send a
  reminder by hand.
- **The fuel risk watch** (`fuel_risk`, every 20 minutes). It asked what the
  reminder could not: can the truck reach its stop, did it drive past it, is
  the instruction from last trip, is it below the 30% operational threshold
  (15% short, 8% critical), and is it burning abnormally. Findings went only to
  the operations chat as `fuel` operational notifications, never to a driver,
  and it changed no record. Most of the fleet reports no fuel level at all, so
  a missing reading was silence, never a low one.
- **Truck fuel readings** (`truck_fuel_readings`, migration 0038): one upserted
  row per truck with the latest fuel % and odometer plus an older baseline, so
  abnormal burn could be measured over a real distance and reset on a refuel.
  Only the risk watch wrote it.

## What was removed

| | |
|---|---|
| `services/fuelStopAlertService.js`, `services/fuelStop/*` (`capture`, `detection`, `reminders`, `riskWatch`, `textRules`, `constants`, `telegramClient`, `driverTag`) | the banner filter, address detection and geocoding, the watch-row capture, the proximity reminder, the risk watch and its Telegram client |
| `lib/fuel/risk.js`, `lib/fuel/planning.js` | the pure risk assessor (thresholds, range estimate) and the reachability plan |
| `database/fuelMonitoring.js`, `database/truckFuelReadings.js` | the watch/inbox queries and the readings store |
| `server/routes/fuelMonitorRoutes.js` | `/api/fuel-monitor` (list, refresh, send-reminder) now answers 404 like any unknown API path |
| Admin **Fuel Monitor** page (`FuelMonitorPage.jsx`, sidebar key `fuel_monitor`, `admin/src/api/fuelMonitor.js`) | `/admin#fuel_monitor` is an unknown page key now |
| The driver-group fan-out call | `bot/handlers/groupCaptureHandlers.js` no longer calls `handleFuelStopMessage`; a driver-group message is not read for a fuel stop |
| Background services `fuel_stop_alerts` and `fuel_risk` | gone from `lib/operations/backgroundServiceCatalog.js`, the roster in `services/backgroundServices.js`, and `ECONOMY_PAUSED_KEYS` in `lib/operations/economyMode.js` |
| Notification category `fuel` (*Fuel risks*) | gone from `lib/notifications/categories.js` and its ⛽ icon from `services/notifications/send.js`; Settings → Notifications no longer offers a fuel chat override |
| Fuel facts in `lib/notifications/priority.js` | `rangeMiles`, `milesToStation` and the critical-tank `fuelPercent` rule are gone; urgency now comes only from `hoursUntilDue` and `driversAffected` |
| AI capabilities `fuel_stop_detection` and `fuel_stop_message` | gone from `lib/ai/capabilityCatalog.js` (and so from Settings → AI) |
| Consistency check `fuel.watch_on_inactive_group` | its key moved to `services/operations/checks/retired.js`, so open findings close; the layer snapshot no longer reads `fuel_stop_alerts` |
| The driver context's `fuel` section | `database/driverContext.js` / `lib/drivers/context.js` have five sections (identity, homeTime, loads, safety, retention). `quiet_but_active` counts a safety event or a moving load; the contradiction screen no longer reads `truck_fuel_readings` |
| Person stamping | `fuel_stop_alerts` left `GROUP_KEYED_TABLES` in `database/driverPeople/lookups.js` |
| The `eld_location_freshness` health observation | see below |
| `/api/health → operations.fuel` | the *Smart Fuel comparable* block is gone from `services/operations/healthSummary.js` |
| Its tests | `driverTagMention`, `fuelPlanWiring`, `fuelPlanning`, `fuelRisk`, `fuelRiskWatch`, `fuelStopAlertService`, `truckFuelReadings`, `truckFuelReadingsPg` |

## The ELD-freshness observation went with it

`eld_location_freshness` ("truck locations and fuel from the ELDs") answered
"is the ELD feed still answering?" from the age of the newest row in
`truck_fuel_readings` — a table only the fuel watch wrote. Without the watch it
would have reported `unknown` for ever, a health line that observes nothing
([health-reporting.md](health-reporting.md)), so it and its catalogue entry
were removed rather than left blind. The ELDs are still read and still report
their own failures where they are used: Live Locations, return-to-road
detection and the load watch. Nothing now gives one fleet-wide "positions are
stale" answer; if one is wanted, it should be computed from a reader that still
runs, not resurrected from this table.

## What stayed, and why

- **The Samsara request itself** (`services/samsaraLocationService.js`) stays:
  Live Locations, ETA and return-to-road read its GPS. What it asked for on the
  fuel watch's behalf went in the cleanup below.
- **"Fuel advance" in the Finance Monitor** is money-code wording
  (`lib/finance/moneycode/*`), unrelated to this feature, and stays.
- **The tables** `fuel_stop_alerts`, `fuel_monitor_inbox` and
  `truck_fuel_readings` (migration 0038) are read and written by nothing. They
  stay on a deployed database until an administrator drops them from
  **Settings → Retired feature leftovers** (group `fuel`) after a backup. The
  baseline no longer creates them (`014_fuel_monitoring.sql`), so a drop stays
  done. Migration 0026 still adds `fuel_stop_alerts.person_id`, so a BRAND-NEW
  database — and only that, before its migration ledger exists — gets a
  two-column stub of it for its first boot.
- **Rows that outlived it.** The `fuel_risk`, `fuel_stop_alerts` and
  `eld_location_freshness` rows in `system_health_states` are deleted by
  migration 0073. The 105 historical `fuel` rows in `operational_notifications`
  stay as history. No `category_chat_ids.fuel` override was set in production.
- **What the fuel watch asked Samsara for.** The vehicle-stats request asks for
  `gps` only; `fuelPercents` and `obdOdometerMeters` went, with the
  `fuelPercent` / `odometerMiles` fields Live Locations mapped and nothing read.
  The notification settings' `repeat_after_hours` (migration 0031), whose only
  reader was the fuel watch, is no longer read or written; the column keeps its
  default.
- **`operational_notification_settings.repeat_after_hours`** was read only by
  the fuel watch, as a ceiling on its per-risk quiet windows. It is stored and
  read by nothing again, and the admin has no field for it.
- **The sales deck.** `server/presentation/` still shows Route Control and fuel
  scenes; the owner chose not to update it.

`tests/removedFeaturesStayRemoved.test.js` ("everything fuel stays removed")
fails if any of it comes back.
