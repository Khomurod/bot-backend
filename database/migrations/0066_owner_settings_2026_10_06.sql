-- Migration 0066: owner settings 2026-10-06
-- migrate:kind: seed
--
-- Two settings the owner chose in so many words on 2026-10-06. They are
-- written here because this session has no admin login; each remains an
-- ordinary setting afterwards, changed from the admin like any other.
--
-- 1. RECRUITING WORKING HOURS: Monday–Friday, 07:00–17:00 Central.
--    The stored schedule left no hour in the week outside both working hours
--    and quiet hours, which /api/health reported as "no moment in the week
--    when Wenze may answer a candidate". Wenze answering candidates itself
--    stays OFF — the owner wants only the automatic SMS for now, and a
--    conversation once a knowledge base exists. `ai_after_hours_enabled` is
--    therefore set FALSE explicitly rather than left to whatever it was.
--
-- 2. FINANCE DOCUMENTS MAY BE READ BY AI ("Да, пусть читает"). Photos and
--    scans of finance documents went straight to "needs review"; they are
--    now read, which sends their content to the configured AI providers. The
--    totals in every report still come from SQL, never from a model.
--
-- Run once (ledger). Re-running is harmless: both are plain assignments.

UPDATE recruiting_hours_settings
   SET timezone = 'America/Chicago',
       windows = '[{"label": "Office", "days": [1, 2, 3, 4, 5], "start": "07:00", "end": "17:00"}]'::jsonb,
       ai_after_hours_enabled = FALSE,
       updated_at = NOW(),
       updated_by = 'owner decision 2026-10-06 (migration 0066)'
 WHERE id = 1;

UPDATE finance_settings
   SET ai_reading_enabled = TRUE,
       updated_at = NOW()
 WHERE id = 1;
