-- Migration 0077: Safety decisions by hashtag — without a reply, and on forwarded posts
-- migrate:kind: schema
--
-- Keep it additive and idempotent. Review the full diff before pushing — this
-- repo can auto-deploy. See database/migrations/README.md.
--
-- The team now marks decisions with #Approved / #NotApproved (owner, 20
-- October 2026).
--
-- 1. A decision written on its own in General — not as a reply — is no longer
--    dropped: the reviewer finds the post it is about from the messages just
--    before it, or asks Safety. Such a review has no post yet, so
--    `post_message_id` may be NULL. Relaxing NOT NULL loses nothing.
--
-- 2. Safety sometimes FORWARDS a recruiter's post into the group. The message
--    is then Safety's own, and was refused as "a Safety message is not a
--    post" — which is why John Bolling's #Approved on 20 October posted
--    nothing. Who the post is really from is now kept beside the sender.

ALTER TABLE safety_approval_reviews ALTER COLUMN post_message_id DROP NOT NULL;

ALTER TABLE safety_approval_messages ADD COLUMN IF NOT EXISTS forwarded_from_user_id BIGINT;
ALTER TABLE safety_approval_messages ADD COLUMN IF NOT EXISTS forwarded_from_name TEXT;
