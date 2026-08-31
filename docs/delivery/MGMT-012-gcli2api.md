# MGMT-012 gcli2api configurable security delivery

Status: schema 1.3 node implementation is merged to `dev8` at
`b743394`. Manager compatibility was merged first. Fixed candidate publication
is blocked because GitHub Actions is disabled for both repositories; no
production node was changed and MGMT-009 was not started.

## Delivered

- `dev8` fast-forwards to the complete reviewed `origin/dev7` history and is
  now the management integration branch. CI, image, handoff and review rules
  follow `dev8`.
- `NODE_MANAGEMENT_TOKEN` keeps environment priority. Without that environment
  value, authenticated desktop and mobile panels can set, rotate or clear a
  32-512 character Token and can generate a 32-byte Web Crypto base64url value.
  The backend stores only `sha256:<digest>`, authenticates in constant time and
  never returns the Token or digest. Clearing the stored digest disables the
  Management API with `503 MANAGEMENT_API_DISABLED`.
- `GET /config/get` returns only Token `{configured, source, locked}` status.
  `PUT /config/management-token` and `DELETE /config/management-token` are the
  only page routes allowed to change it; the generic config route rejects the
  internal digest key.
- Embedding has three panel-configurable modes: `any_https` (default), `exact`
  and `disabled`. They emit `frame-ancestors https:`, the canonical exact HTTPS
  Origins, or `frame-ancestors 'none'`, respectively.
- A non-empty `GCLI_EMBED_ALLOWED_ORIGINS` atomically overrides storage as
  locked `exact` mode. HTTP, wildcard, padding, path, query, fragment, userinfo,
  duplicate and non-canonical Origins fail closed and declare no embed
  capability. Empty or absent environment values use persisted page settings;
  no persisted setting defaults to `any_https`.
- Schema 1.3 declares exactly one of `ui.credential_console.embed` for exact
  mode or `ui.credential_console.embed.any_https` for any-HTTPS mode. Disabled
  or invalid policies declare neither.
- The ready message remains limited to
  `{type: "gcli2api.console.ready", version: 1, tab: "manage"}`. Any-HTTPS mode
  sends it only to the immediate parent with `targetOrigin="*"`; its HTTPS
  parent restriction is enforced by the response CSP. Exact mode retains
  allowlisted target Origins.

## Compatibility and safety

Management schema 1.3 is additive. Existing schema 1.2 exact-capability nodes,
Legacy Current, Legacy Minimal and Unknown behavior are unchanged. There is no
database table or migration, credential transfer, SSO, reverse proxy, HTML
rewriting, Legacy endpoint change or quota behavior change.

The Token input is write-only after save. Responses, logs, config merges and
the sensitive-literal gate exclude both raw Tokens and stored digests. Desktop
and mobile panels expose the same mode validation, source indication and
environment lock state.

## Verification

- Shared SHA-256: roadmap
  `b0101481d53dfbde15fd25c58774258570ffc852f1797561ca04c33062ae3d38`;
  coordination spec
  `2277de941d106f5c891e065c8174c6d18f1aec18369758485e15a4ae212c968a`;
  Management contract
  `4aed44bde7843a72c1ee3c2add02de3a3bdd17b3c12044d3cd4c23196ee16177`.
- Local full pytest: 150 passed. Focused Token, embedding, Management, OpenAPI
  and desktop/mobile static coverage: 54 passed.
- Management OpenAPI baseline, sensitive-literal scan and Git whitespace check
  pass.

## Rollback and release gate

First select `disabled` in the panel, then return nodes to the previous fixed
image. Environment-managed exact mode can instead be disabled by removing the
environment value and selecting `disabled`. No database restore or action
replay is required.

Manager must publish schema 1.3 capability tolerance before the node candidate
is deployed. After fixed candidate publication, run the Modern schema 1.2 exact,
schema 1.3 any-HTTPS, capability-missing, Legacy Current, Legacy Minimal and
Unknown matrix plus forged-message, wrong-origin and two-node G6.6 checks.

The single candidate workflow run
`https://github.com/lywx215/gcli2api/actions/runs/33397536006` targets verified
revision `7f5d2899d3330cb3efc0ce3f84fd9f1a382d7d1f` and remains queued while
repository Actions permission is `enabled=false`. Do not create a duplicate
publication run. Enabling Actions or approving another publication mechanism is
an explicit repository-owner action.
