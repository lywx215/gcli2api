# Mulan selective integration delivery

## Scope and provenance

- Development baseline: `origin/master@f95e3da`, the reviewed `dev0916` content promoted
  from the `dev8` management-development line.
- Reference fork baseline: `mulan777/master@a7b5c9d`.
- This is a semantic port, not a merge or bulk cherry-pick. Referenced fork commits:
  `97627ed`, `f0331b4`, `5ded7fd`, `e6575da`, `d0ed50e`, and `0fee696`.
- Explicitly excluded: delayed first-token hedging (`1c0b8d2`), automatic Google Cloud
  project creation (`9e1ecf9`), a `licensable` database field, per-credential Claude
  disablement, and changes already represented by current tool-call indexing/model/text
  normalization behavior.

## Delivered behavior

- Antigravity retries remain available before meaningful response content. Once a body
  chunk has reached the client, later upstream exceptions are propagated without replaying
  the whole response. Empty frames, SSE comments, and `[DONE]` do not count as body
  content. Downstream cancellation explicitly closes the upstream async generator.
- Antigravity cooldown lookup and clearing share one implementation across SQLite,
  MongoDB, PostgreSQL, and MySQL:
  - `gemini-3.1-pro*` and `gemini-3.5/3.6/3.7-flash*` share a family.
  - `claude-*` and `gpt-oss-*` share a family.
  - Unlisted models, including Gemini 3.8, remain independent.
  - Legacy `gemini-shared` and `claude-gpt-shared` keys remain readable. New writes keep
    the actual model name, and family clearing removes concrete and legacy sibling keys.
  - Credential selection, family clearing, and Pro/Flash panel filtering use the same
    family rules. No storage schema or data migration is required.
- Refresh-token imports persist a detected Antigravity tier. Automatically generated
  filenames use a timestamp plus random UUID and do not derive from project IDs or token
  material. Explicit custom filenames retain their previous basename/`.json` behavior.
- The authenticated Legacy panel API adds:
  - `POST /creds/download-selected?mode=...`
  - `POST /creds/copy-emails?mode=...`
  Both accept `{"filenames": [...]}`, de-duplicate safe `.json` basenames, and enforce a
  1–100 item request bound. ZIP metadata contains counts only; stored-email reads perform
  no external lookup. Desktop and mobile panels expose selection-aware controls and a
  manual-copy fallback when Clipboard APIs are unavailable.

## Compatibility and management impact

- Management schema remains `1.4`.
- The Management API capability list is unchanged.
- `/management/v1` receives no route, schema, or response-body change and does not expose
  bulk credential export or credential contents.
- Existing `/creds/*`, model APIs, and control-panel behavior remain compatible; the two
  Legacy routes are additive.
- `panel-version.txt` is unchanged because no version-number update was authorized.
- Manager action: none. This delivery is `no_counterpart_action`; no handoff artifact is
  required and no manager task should be started.

## Verification evidence

- Full test suite: `279 passed`.
- Focused selective-integration and frontend tests: `28 passed`.
- Management/OpenAPI contract tests passed as part of the full suite.
- `node --check front/common.js` passed.
- Python compilation checks passed for all modified Python modules.
- Changed-content sensitive-literal scan found no access-token, refresh-token, or client
  secret literals. Tests use synthetic credentials only.

## Deployment and rollback

- No real credential, existing SQLite row, database schema, or Zeabur Volume is modified
  by this code delivery.
- Production deployment is outside this integration authorization. Validate the candidate
  image with non-production credentials and the configured storage backends first.
- Functional commits are independently revertible. Reverting cooldown-family behavior
  requires no data recovery because new cooldown writes continue to use real model keys.
