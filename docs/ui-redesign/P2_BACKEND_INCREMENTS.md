# P2 legacy panel response increments

Scope: both channels' existing panel restoration. Cancelled MGMT work remains cancelled; no `/management/v1`, schema, database migration or manager task changes. `no_counterpart_action`; no deployment or real credential operation was performed.

`POST /auth/callback` and `POST /auth/callback-url` accept optional body `include_credentials` (boolean, default `true`). Omitted/true keeps the complete legacy success response. False keeps the same OAuth ownership, session, one-shot completion and persistence flow, but the successful response is a whitelist with `Cache-Control: no-store`:

- Common: `success: true`, `mode`, `filename` (basename), `project_id: string|null`, `subscription_tier: string|null`, fixed local `message`, `auto_detected_project: boolean`.
- Gemini CLI: nullable string `tier_raw_id`, `tier_raw_name`, `tier_detection_status`; `tier_detected_at: integer|null`.
- Antigravity: `email_enrichment: null|{job_id: string|null, accepted: integer, skipped: integer, status_url: string|null}`. A job ID must be 32 lowercase hexadecimal characters; the relative status URL is rebuilt locally. `warnings` contains only the service's fixed local warning. Existing AG OAuth flow does not return Tier metadata, so its `subscription_tier` is normally null.

The safe success response excludes `credentials`, full `file_path`, arbitrary extra properties, nested credential data and upstream warning text. Existing failure responses and their manual project-selection navigation remain unchanged. Complete content remains available through the existing authenticated `/creds/detail/{filename}?mode=...` only after UI confirmation for that opening; the server does not implement that UI confirmation itself.

`POST /creds/configure-preview/{filename}?mode=geminicli` keeps existing `success`, `preview`, `message`, `filename` and optional setting/binding IDs. A successful binding response (HTTP 200/201 or already-existing 409) additionally reports `state_update.preview` as `{status: "applied"}` only when the adapter state write returns true; otherwise `{status: "failed", reason: "state_update_failed"}`. Legacy `success: true` continues to describe upstream configuration; it does not establish local state persistence. State-write exceptions retain the legacy failure behavior. Antigravity remains HTTP 400 unsupported; this is configuration/enable only, with no disable capability.

`GET /creds/status?mode=...` adds implemented response capabilities to `panel_capabilities` independently of optional storage-field capabilities: `geminicli.oauth.safe_response`, `antigravity.oauth.safe_response`, and only Gemini CLI `geminicli.preview.state_update`. These declarations do not claim Google account eligibility or introduce additional write gates.

Rollback: remove these optional request/response fields and capability declarations. Legacy default callers and existing storage require no migration or manager action.
