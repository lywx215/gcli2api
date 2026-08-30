# MGMT-012 gcli2api secure console embedding

Status: node candidate complete; manager compatibility-matrix and two-node G6.6
validation remain the next explicit cross-repository step. No production node
was deployed and MGMT-009 was not started.

## Delivered

- `/#manage` is read only from an explicit tab allowlist. It remains requested
  while logged out, activates after interactive or stored-session login, and
  remains active after refresh. Unknown hashes return to `#oauth`.
- `switchTab` receives an explicit event or target and updates the hash without
  relying on the browser global `event`.
- `GCLI_EMBED_ALLOWED_ORIGINS` is parsed atomically as unique, canonical HTTPS
  Origins. Wildcards, HTTP, whitespace padding, paths, queries, fragments,
  user information, duplicate values and non-canonical default ports fail
  closed; no partial allowlist is accepted.
- The panel root sends an HTTP `Content-Security-Policy` with only the exact
  configured `frame-ancestors`. Missing or invalid configuration returns
  `frame-ancestors 'none'`; the application sends no `X-Frame-Options`.
- After authenticated `manage` activation, the panel uses exact allowlisted
  `targetOrigin` delivery for only
  `{type: "gcli2api.console.ready", version: 1, tab: "manage"}`. The message
  contains no login state, token, password, credential, config, internal path
  or business data.
- `ui.credential_console.embed` is declared only when a valid non-empty Origin
  policy is available. Management response metadata and its reviewed OpenAPI
  baseline are additive schema 1.2; endpoint paths and action semantics remain
  unchanged.

## Compatibility and safety

Modern nodes without a configured allowlist do not declare the capability.
Legacy Current, Legacy Minimal and Unknown remain unchanged and must use the
manager new-tab fallback; nothing is inferred from a version string. There is
no SSO, password or Management Token exchange, reverse proxy, HTML rewriting,
iframe DOM access, credential migration/copy/synchronization, SQLite migration,
Legacy endpoint change or quota behavior change.

## Verification

- Shared SHA-256: roadmap
  `4b6736859bfabfa5a6b549297d4743b410e0db3076af79b8f2a815956d1b14f2`;
  coordination spec
  `dd7a0375a4d6511a00a3eabdd56493a90c452d15e314a1c38d28c97a81990925`;
  Management contract
  `cd7ecdc83bdaf04d543d0b560775995f34ca2f255c25820c63c2ef0d3e00ecc0`.
- Local Python 3.12 full suite: 141 passed. Focused panel, Management API,
  Management service, OpenAPI and frontend/Legacy suite: 47 passed.
- A real browser preserved unauthenticated `#manage`, activated it after login,
  retained it after refresh, normalized an unknown hash to `#oauth`, and
  reported no console errors.
- PR #29 Python 3.13 tests, OpenAPI check, sensitive scan and non-publishing
  multi-architecture build passed.
- Fixed non-production candidate:
  `ghcr.io/lywx215/gcli2api:sha-b8daa69`, revision
  `b8daa693d9be62896eb74146cac917717ad9caff`, manifest digest
  `sha256:f9cca0f5e0ebe65b0a110c9338ee48f6c241a85ac4cc8a5cbeb29be984130900`.
  Publication run: <https://github.com/lywx215/gcli2api/actions/runs/33314116918>.

## Rollback and next step

Rollback removes `GCLI_EMBED_ALLOWED_ORIGINS` (immediately suppressing the
capability and returning `frame-ancestors 'none'`) and returns candidate nodes
to the previous fixed image. No database restore or action replay is required.

Manager must explicitly run its Modern candidate, current stable, Legacy
Current, Legacy Minimal and Unknown compatibility matrix plus the two
non-critical-node G6.6 validation. Only after that evidence is complete may
MGMT-012 become `done` and MGMT-009 become `ready`; neither step starts
automatically.
