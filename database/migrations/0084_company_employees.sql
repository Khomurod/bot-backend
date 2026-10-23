-- Migration 0084: company employees
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR. The owner, 23 October 2026: an employee's birthday is
-- posted to the staff group as a CARD in the company's own template — the
-- employee's photo, their full first name and their American name — with a
-- fixed caption that tags them in Telegram. The admin's Users page lists every
-- employee as "Company Employees", where the American name, the Telegram
-- account and the photo are filled in. See
-- docs/architecture/employee-birthday-cards.md.
--
--   employee_birthdays.american_name      the name colleagues and drivers know
--                                         ("Sam Example"); on the card under
--                                         the first name.
--   employee_birthdays.telegram_username  stored without '@', lowercased.
--   employee_birthdays.telegram_user_id   tags someone with no public username.
--   employee_birthdays.telegram_match     'suggested' (matched by name, not yet
--                                         checked by a person) or 'confirmed'
--                                         (typed or checked in the admin). A
--                                         suggestion pass never overwrites a
--                                         confirmed account.
--   employee_photos                       one photo per employee, re-encoded to
--                                         a square JPEG on upload. A table of
--                                         its own so the employee list never
--                                         reads the bytes. Never in the repo.
--
-- ai_instructions / fallback_template in employee_birthday_settings are no
-- longer read (the caption is fixed, never written by a model). They keep
-- their defaults and are left in place: dropping columns is not additive.

ALTER TABLE employee_birthdays ADD COLUMN IF NOT EXISTS american_name TEXT;
ALTER TABLE employee_birthdays ADD COLUMN IF NOT EXISTS telegram_username TEXT;
ALTER TABLE employee_birthdays ADD COLUMN IF NOT EXISTS telegram_user_id BIGINT;
ALTER TABLE employee_birthdays ADD COLUMN IF NOT EXISTS telegram_match TEXT;
ALTER TABLE employee_birthdays ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employee_birthdays_telegram_match_check'
  ) THEN
    ALTER TABLE employee_birthdays ADD CONSTRAINT employee_birthdays_telegram_match_check
      CHECK (telegram_match IS NULL OR telegram_match IN ('suggested', 'confirmed'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS employee_photos (
  employee_id INTEGER PRIMARY KEY REFERENCES employee_birthdays(id) ON DELETE CASCADE,
  image BYTEA NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
