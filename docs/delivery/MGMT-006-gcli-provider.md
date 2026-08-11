# MGMT-006 gcli2api active-operation provider delivery

Status: ready for the manager final compatibility matrix after the dev7 merge

## Contract and behavior

- Advances the additive Management API contract to schema `1.1` and adds safe,
  typed results for Preview enable, Credit enable/disable, quota, error summaries,
  message tests, risk checks, and cooldown synchronization.
- Reuses the existing provider operations through a narrow adapter. Preview and
  risk remain GeminiCLI-only, Credit remains Antigravity-only, and Preview disable
  is intentionally not advertised because no reversible provider operation exists.
- Declares active capabilities only when the selected storage backend and runtime
  feature support the required operation. Risk capability follows the SMART 429
  runtime state.
- Preserves durable provider idempotency. Confirmable Preview/Credit outcomes are
  recovered by readback; an unconfirmable external outcome returns
  `OUTCOME_UNKNOWN` and is never replayed with the same key.
- Limits external active operations to three concurrent starts and ten starts per
  minute per process. A preflight rate rejection is persisted as a stable,
  retryable result.
- Returns only contract-whitelisted result and side-effect fields. Stored upstream
  error bodies, credentials, tokens, project data, and unknown nested fields are
  discarded.

## Verification

- Windows Python 3.12: 90 tests passed, including all Legacy regressions and four
  default-adapter tests that stub every external provider call.
- Management module coverage: 89.05%; the active-operation adapter is 86% covered.
- OpenAPI baseline, sensitive-literal scan, Python compilation, focused Ruff fatal
  checks, and Git whitespace checks passed.
- No real credential, Google endpoint, production node, registry, image publish,
  database migration, deployment, or macOS environment was used.

## Limits and rollback

`disable_preview` remains a recognized schema action so unsupported requests get a
stable capability error, but `credential.preview.disable` is not declared. The
provider does not cache quota responses; manager owns its ten-minute cache.

Rollback is to remove the schema 1.1 active capability declarations and revert the
MGMT-006 dev7 merge. Schema 1.0 readers continue to tolerate the additive response
field, ordinary MGMT-005 state actions remain available, and all Legacy routes are
unchanged.
