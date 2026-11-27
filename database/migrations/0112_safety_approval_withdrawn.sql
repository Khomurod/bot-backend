-- Migration 0112: safety approval withdrawn
-- migrate:kind: schema
--
-- A decision the bot posted can be WITHDRAWN by Safety (owner, 27 November
-- 2026). On 27 November the bot posted "APPROVED by Aubrey Davis" for a
-- candidate after "PSP is clean, if CLH is clean we can hire" — a condition,
-- not a decision — and Aubrey answered the post "I did not approve him yet".
-- The bot did not understand the answer, the APPROVED stayed in the topic,
-- and a real #Approved later would have posted nothing (the same decision is
-- never posted twice).
--
-- Now a Safety reply to the bot's own post that says it was not a decision
-- ("not yet", "I did not approve him", "wrong", "mistake") marks that post
-- WITHDRAWN (its caption is edited; nothing else is written), and the
-- withdrawal is recorded as the driver's latest decision on that post, so the
-- real decision, when it comes, is posted.
--
--   safety_approval_announcements.decision  + 'withdrawn' (a row is added,
--                                            never deleted: the history stays)
--   safety_approval_reviews.status          + 'withdrawn' (the reply that did it)
--
-- Both checks are only WIDENED; every existing value stays valid. Idempotent.

ALTER TABLE safety_approval_announcements
  DROP CONSTRAINT IF EXISTS safety_approval_announcements_decision;
ALTER TABLE safety_approval_announcements
  ADD CONSTRAINT safety_approval_announcements_decision
  CHECK (decision IN ('approved', 'not_approved', 'withdrawn'));

ALTER TABLE safety_approval_reviews
  DROP CONSTRAINT IF EXISTS safety_approval_reviews_status;
ALTER TABLE safety_approval_reviews
  ADD CONSTRAINT safety_approval_reviews_status
  CHECK (status IN ('pending', 'published', 'unclear', 'no_post', 'gave_up', 'withdrawn'));
