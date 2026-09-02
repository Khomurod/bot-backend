# `lib/` — pure helpers and constants

The bottom of the dependency chain in `CLAUDE.md` → Module design:

```
routes/controllers → service façade/orchestrators → focused domain services
  → database and external integrations → pure helpers/constants
```

This directory is that last link. **Every module here is pure**: no database
access, no HTTP, no Telegram, no filesystem, no shared mutable state. That is
what makes it safe for any layer — including `database/` — to depend on.

## Why it exists

These nine modules used to live under `services/`, a layer *above* the database.
Nineteen `database/**` modules therefore had to reach upward to use them, which
inverted the stated dependency direction and made the data layer non-testable in
isolation. Moving them fixed the direction rather than papering over it with a
lazy `require()`.

## The rule for adding something here

A module belongs in `lib/` only if all of these hold:

1. it performs **no I/O of any kind** and holds no mutable state;
2. it is used by **more than one layer** (typically a database module and a
   service or route);
3. it has a real **domain** to sit in — `lib/` is organized by subject, not by
   shape.

If it does I/O, it is a service. If only one caller needs it, keep it next to
that caller. **Do not add a `lib/utils/`, `lib/helpers/` or `lib/common/`** —
a module with no domain to name is a sign the boundary is wrong, not that it
needs a drawer.

## Contents

| Module | What it is |
|---|---|
| `security/facebookCrypto.js` | Symmetric encrypt/decrypt + masking for stored secrets. Named for its first caller, but used for RingCentral, ELD and GMaps credentials too. |
| `rbac/roleKeys.js` | Canonical role keys and the super-admin identity check. |
| `drivers/driverGroupTitle.js` | Parsing a driver group's Telegram title into name / unit / type. |
| `drivers/driverProfileParse.js` | Driver type inference and the inactive-group verdict. |
| `telegram/telegramUsername.js` | Normalizing a Telegram `@username` and numeric user id. |
| `routeControl/routeControlConstants.js` | Route Control thresholds and label tables. |
| `trailers/normalize.js` | Trailer-number normalization for the master list and its aliases. |
| `trailers/statusDerivation.js` | Deriving an agreement's status from its dates and rows. |
| `trailers/trailerBilling.js` | Rental day counts and money rounding. Pure date/money maths — the `Service` suffix it carried under `services/` was misleading. |
