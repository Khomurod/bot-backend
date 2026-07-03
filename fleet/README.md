# FleetView — Fleet Operations Platform

A self-contained, multi-tenant fleet-operations workspace built from the
Clarvio-style development specification. It reproduces the observed product's
routes, page controls, tables, filters, statuses, and workflows while applying
the spec's correctness/safety fixes (tenant isolation, explicit state machines,
single-source finance/ETA formulas, mutation confirmation, and explicit
loading / empty / error / stale states).

> **Isolation:** this module shares **nothing** with the existing
> driver-feedback application or its PostgreSQL database. The only integration
> point with the host app is a single line in `server/api.js`:
> `require('./fleet').mountFleet(app)`.

## Where it runs

| Surface | Path |
| --- | --- |
| SPA (React + Vite) | `/update/` |
| JSON API | `/api/v1/*` |

On this deployment: `https://bot-backend-x9lc.onrender.com/update/`

## Architecture

- **Frontend** — `fleet/` — React 18 + Vite + React Router (hash routing),
  Leaflet map, custom enterprise component library with light/dark design
  tokens. Built to `fleet/build` by the root `postinstall`.
- **Backend** — `server/fleet/` — a self-contained Express router:
  - `store.js` — deterministic **synthetic** tenant-scoped seed data (two
    tenants). No production PII, per spec §5.4 / §25.
  - `domain.js` — single source of truth for state machines (load / task /
    equipment), finance formulas (rate savings, RPM, final balance) and ETA
    timing (Early/Late, never an ambiguous signed "delay").
  - `auth.js` — JWT auth, RBAC permission gates, tenant scoping, audit log.
  - `router.js` — all `/api/v1` endpoints with the standard response envelope
    and error shape.
  - `index.js` — `mountFleet(app)` wires the API + SPA into any Express app.

## Demo logins (synthetic data, password `demo1234`)

| Role | Email |
| --- | --- |
| Company Administrator | `admin@wenzel.example.com` |
| Dispatcher | `disp0@wenzel.example.com` |
| Viewer | `viewer@wenzel.example.com` |
| Second tenant (isolation demo) | `admin@redline.example.com` |

## Develop

```bash
cd fleet && npm install && npm run dev   # http://localhost:5174 (proxies /api → :3001)
npm run build                            # → fleet/build
```

## Tests

Backend tests (tenant isolation, state machines, permissions, finance formulas)
live in `tests/fleet.test.js` and run with the repo's `npm test`
(`node --test`).

## What is real vs. simulated

Everything in the UI and API is real, working code backed by the synthetic
store: authentication, RBAC, tenant isolation, CRUD, state machines, finance
and ETA math, pagination/filtering, the standard envelope, audit logging, and
all four page states. **Simulated** (a single environment cannot do otherwise):
live third-party ELD/TMS/email *connections* and WebSocket push — represented
with synthetic data and a polling/health model. These are isolated behind the
integration endpoints and can be swapped for real provider adapters.
