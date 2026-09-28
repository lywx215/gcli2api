-- Inspect INFORMATION_SCHEMA.COLUMNS before applying either missing column.
-- The service's _ensure_quota_columns performs that idempotent check on startup.
ALTER TABLE gcli_antigravity_credentials ADD COLUMN quota_group_states LONGTEXT;
ALTER TABLE gcli_antigravity_credentials ADD COLUMN quota_credential_generation VARCHAR(32);
-- NULL quota_group_states means {}; UUID initialization is lazy, row locked.
-- MySQL DDL auto-commits. Back up/restore an isolated database to rehearse first.
-- Preserve both fields when rolling back; the old scheduler must remain stopped.
