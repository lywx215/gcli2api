-- Additive only; run against an isolated restore before any authorized rollout.
BEGIN;
ALTER TABLE antigravity_credentials ADD COLUMN IF NOT EXISTS quota_group_states TEXT DEFAULT '{}';
ALTER TABLE antigravity_credentials ADD COLUMN IF NOT EXISTS quota_credential_generation TEXT;
COMMIT;
-- Existing generations are initialized with UUIDs under a row lock on first use.
-- Never reset these columns during refresh/overwrite. Do not drop on rollback.
