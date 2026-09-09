# SUBS-LINK-20260909 node delivery

Status: implementation complete on a short branch created from `dev8` commit `7b1c0f8`.

## Contract

- Management schema: `1.4`, additive under `/management/v1`.
- New capabilities: `credential.list.bounded`, `credential.detail`,
  `credential.enable.conditional`, `credential.test.precise`.
- SQLite declares all four capabilities. PostgreSQL, MySQL and MongoDB do not declare the
  first three because this work item does not add verified transactional implementations to
  those backends.
- `GET /credentials?mode=...&after=&limit=...` uses an exclusive filename keyset. `after`,
  `cursor` and `offset` are mutually exclusive. When another page exists, `page.next_after`
  is the last filename returned; `page.next_cursor` is null.
- `GET /credentials/{mode}/{filename}` returns the safe `CredentialSummary` plus
  `state_token`, `observed_at`, `metadata_complete` and `missing_fields`.
- Conditional enable uses the existing action route with both `expected_state_token` and
  non-empty `required_models`. Success is HTTP 200 with the existing action envelope,
  `credential.status=enabled`, `result=null`, and an occurred `credential_state_updated`
  side effect. Missing credentials return 404. Failed preconditions return 409 with a safe
  `details.reason`.
- Precise test results retain legacy `outcome` and add `upstream_status`, `classification`
  and `call_succeeded`. Only an actual HTTP 200 sets `call_succeeded=true`; a legacy payload
  marked successful at HTTP 429 can retain `outcome=passed` while being classified
  `rate_limited` with `call_succeeded=false`.

## Safety and compatibility

SQLite conditional enable executes `BEGIN IMMEDIATE`, reads and validates the current row,
recomputes the domain-separated state token, and updates the row before committing the same
transaction. It fails closed for missing identity/health/error/cooldown metadata, 403,
permanent disable, active target-model cooldown, non-healthy or isolated state, and payload
replacement. No schema migration is required and no production storage was accessed.

Existing `/creds/*`, cursor/offset list requests, empty-parameter enable requests and legacy
test `outcome` remain supported. Rollback is the single code commit; no data rollback is
required.

## Verification

- Focused Management/OpenAPI/Legacy suite: 44 passed.
- Full repository suite: 220 passed before the final idempotency-only hardening; the focused
  suite was rerun after that hardening.
- OpenAPI baseline check: current.
- Warnings: existing Pydantic v2 class-config and Starlette/httpx deprecations only.

No image was built, no deployment or GitHub Actions was run, and no real token, credential,
provider, Google account or production database was accessed.
