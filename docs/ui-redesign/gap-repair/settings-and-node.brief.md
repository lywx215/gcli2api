# Settings and node parity repair · 2026-10-15

This is one official Antigravity development module for Issue #40: R07, L01, L02 and L07. The request has four ordered tasks, a 1800-second timeout and one attempt. The root session supplies the current authorization ID and stages this brief plus `docs/ui-redesign/PARITY_GAP_REPAIR_SCOPE_20261015.json`; this template grants no authorization by itself. Codex owns inspection and command verification. No tests are added or changed.

## Exact write scope

1. `frontend/src/pages/settings/components/UnsavedChangesGuard.tsx`
2. `frontend/src/pages/settings/components/ManagementToken.tsx`
3. `frontend/src/pages/settings/components/NativeSettingsTools.tsx`
4. `frontend/src/pages/overview/index.tsx`
5. `frontend/src/pages/settings/index.tsx`

The fifth file is required for L07 execution admission, not incidental cleanup: `handleConfirmMigration` currently consumes the ticket at line 244 and calls `switchStorageEngine` at line 273 without reading MySQL availability. A disabled child button alone does not constrain a retained confirmation callback or an availability change while the dialog is open.

## Evidence and intended behavior

Evidence is the read-only `windows-close-20261015/functional-recheck-20261015-01/FUNCTIONAL_RECHECK.json`, `workflows-audit.md` and `global-audit.md`, checked against W (`C:/Users/lywx2/.codex/worktrees/ui-full-parity/gcli2api`). These findings were not runtime reproductions.

- **R07 / UI-COMP-041:** `UnsavedChangesGuard.tsx:24–40` watches anchor clicks. `app/routes.ts:421–422` also receives hashchange/popstate; its shared `registerRouteGuard` supplies a single-use `retry()` fenced by navigation generation and session. Add this path without changing the shared router. `settings/hooks.ts:33,59` deliberately carries only non-sensitive drafts; cancel must preserve secrets, accepted same-document departure clears only secrets, and ordinary carriedDraft/unconfirmed-save reminders survive. A stale retry must not clear a draft. Session expiry/cleanup must still proceed without a navigation confirmation. The read-only model-routing guard is a mechanism reference, not authority to discard all settings drafts or block logout.
- **L01 / UI-SUPP-006:** the existing `overview/nodeInfo.ts` DTO already projects `source_ref`, `full_hash`, `message`, `commit_date`, `date`. `overview/index.tsx:415–427` omits the metadata; `NativeSettingsTools.tsx:1004–1022` shows only eight hash characters and no date fallback. Old `front/common.js:5139–5142` uses source, full hash, message and `commit_date || date`. Both native displays need complete accessible public metadata; missing values remain unknown, and a short version string cannot be presented as a complete commit hash. Preserve `Observation.issue` and existing refresh ownership.
- **L02 / UI-COMP-044:** `settings/api.ts:92–98` already reads token source. `src/management/auth.py:53–65` reports `environment`, `storage` or `none`. Render fixed safe labels in `ManagementToken.tsx`; an unknown value must not silently become storage. Keep configured/locked and every existing generate/copy/save/clear/session rule.
- **L07 / UI-COMP-047:** `NativeSettingsTools.tsx:510–514` currently checks name/owner only. Use its existing storage observation for a MySQL-only disabled reason and handler admission. After explicit confirmation the parent must consume/reserve the single-use intent before awaiting a fresh `getStorageState`, then recheck owner/attempt/abort and require `mysqlAvailable === true` before POST. Availability failure means **not submitted**, not unknown migration/write or data damage. Preserve actual earlier migration evidence, SQLite-target behavior, copied preview and backend refusal. The backend still independently rejects unavailable MySQL (`src/panel/config_routes.py:685–688`). A fresh GET is not an atomic guarantee against subsequent server configuration changes.

## Boundaries and host acceptance

Public types, component props, migration tickets, APIs, ENV locks and shared routing/auth implementations stay unchanged. Keep saved-password plaintext behind explicit per-open confirmation; no extra secret reads, raw payload output, persistence, backend edits, true migration/API operations, model calls, commits, pushes, deployments, Docker or generated bundle edits. Cancelled MGMT work is not resumed.

The existing related tests are read-only context. After delivery the root should inspect the five-file diff, run typecheck and existing settings exit/hooks/page, ManagementToken, storage-system and overview tests. Verify meaningful behavior for back/forward/programmatic secret exits, safe-only carry, stale retry/session cleanup, both complete node metadata displays, known/unknown token sources, and MySQL false/unknown/true-to-false at confirmation with zero POST until a current true read. Existing test results alone must not be represented as newly added coverage for scenarios they do not exercise. Any missing dynamic evidence remains explicit.

This package reads `app/routes.ts`, auth/session, domain/panel, API client and settings/overview dependencies. It does not read credential/import business-page write sets. The root confirmed batch/core do not write these dependencies; shared read-only context is allowed. Stage and recheck this exact write/context separation before dispatch.
