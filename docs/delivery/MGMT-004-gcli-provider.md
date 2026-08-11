# MGMT-004 gcli2api provider delivery

Status: ready for the manager compatibility matrix

## Contract and capabilities

- Management schema: `1.0`
- Base path: `/management/v1`
- Read endpoints: `GET /capabilities`, `GET /summary`, `GET /credentials`, and
  `GET /stats`
- Independent authentication: `NODE_MANAGEMENT_TOKEN`; unset or empty disables
  every Management path with HTTP 503, and invalid credentials return HTTP 401
- Always truthful base capabilities: `node.summary`, `credential.list`
- SQLite and PostgreSQL additionally declare `stats.daily`, `stats.model`, and
  `stats.rpm`
- MySQL and MongoDB do not declare statistics that their current backends cannot
  produce; MongoDB no-op statistic stubs are explicitly excluded
- No write, Preview action, quota, test, risk, cooldown-sync, or batch capability
  is declared or implemented

Responses use strict schema envelopes, UTC ISO 8601 timestamps, nullable unknown
values, a paginated credential shell, and an explicit field whitelist. Credential
payloads and authentication material never cross the Management boundary.

## Verification

- Windows Python 3.12: 74 tests passed, including actual temporary SQLite storage,
  both credential modes, authentication, pagination, filtering, nullable values,
  capability truthfulness, Legacy route registration, and secret exclusion
- OpenAPI baseline export/check passed and declares only the four read endpoints,
  Bearer security, and contract HTTP 400 validation errors
- Sensitive-literal scan passed with an occurrence-counted digest baseline for
  pre-existing public client constants; any added literal or duplicate fails
- Python compile check and Git whitespace check passed
- PR #8 `gcli2api-ci` passed on Python 3.13
- PR #8 Docker build run 31519184271 built Linux amd64 and arm64 successfully with
  tags `ghcr.io/lywx215/gcli2api:pr-8` and `ghcr.io/lywx215/gcli2api:sha-68f6de1`
- The candidate was build-only: registry login was skipped and `push: false`; no
  image was published and no environment was deployed

## Known limits and rollback

Short-window request counts remain `null` when the backing store cannot derive the
requested window; the provider may still return the current RPM. Seven-day totals
are summed only from available daily rows. Unknown health and last-success values
remain `null` rather than being synthesized from storage defaults.

Rollback is to unset `NODE_MANAGEMENT_TOKEN` (immediate HTTP 503 for the Modern
surface) and let the manager use its reviewed Legacy/Unknown path. Reverting the
MGMT-004 dev7 merge removes the router. Neither rollback requires database changes.

The manager must now run the Modern candidate plus Legacy Current, Legacy Minimal,
and Unknown compatibility matrix. This delivery does not authorize production
nodes, production credentials, image publication, or deployment.
