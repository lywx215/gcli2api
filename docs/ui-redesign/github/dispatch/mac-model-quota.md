# LegacyModelQuota — queued Mac module

Status: queued; not dispatched, not implemented, not accepted.

Source baseline: `e0931c83365b6277d5ba0b3f6040fb5bd8af85b4`. PR base: `codex/ui-parity-integration`. This coordinator-authored document only opens the delivery branch; it is not frontend implementation.

Read `../TASKS.json`, `../MAC_MODULES.md`, `../MAC_TASK_PACKAGES.json` and the Mac installation audit before starting. The exact module entry in TASKS.json is authoritative for the frozen interface and acceptance commands. A fresh local human development grant is required; no Windows grant/session/request is transferred.

Allowed frontend output:
- `frontend/src/pages/credentials/LegacyModelQuota.tsx`
- `frontend/src/pages/credentials/LegacyModelQuota.test.tsx`

Ordered work: implement the complete independent component; add focused regressions; check exports and deliver. Official Antigravity CLI authors frontend files; Codex inspects changes and runs the listed commands. Do not modify parent pages, adapters, Core, shared UI, tests/config or styles outside this allowlist.

Use a single coherent request, not a stream of tiny edits. Only genuinely independent requests may share one local hook batch. Preserve authorization, revocation, input hashes, file scopes and consumed-request checks. Bounded transient retries require the current local grant; at most three total attempts. No reviewer calls, real credentials, database operations, Docker or deployment.

When delivered, update the linked Issue/PR with actual files, commands/results and blockers. This start document alone must never be marked as restored functionality.
