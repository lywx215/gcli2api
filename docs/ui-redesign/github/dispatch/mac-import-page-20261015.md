# Mac ImportPage complete module — ready, not started

Task `mac-import-page-20261015`; source baseline `3282f5e21bc35de75e0117067d60ab1e449a2120`; branch `codex/ui-parity-mac-import-baseline-20261015`.

Fetch the exact coordination child commit from Issue34 into an independent clean checkout using `core.autocrlf=false`. Verify this commit is a docs-only child of source baseline, then compare every SHA256 in [mac-import-page-20261015.manifest.json](mac-import-page-20261015.manifest.json). Manifest SHA256: `a1e54aa0f47302d8ca85d94511616b09230132f1935d43a389e4176f3fc7d27a`. Stop on a mismatch, unexpected existing edits, undeclared dependency or missing CLI grant; do not overwrite old Mac work.

Author only the five `allowed_files` in [mac-import-page-20261015.request-template.json](mac-import-page-20261015.request-template.json), through official Antigravity CLI and the installed shared hook. Keep all 41 `context_files` readonly. Send the complete module once as one request. No extra tasks, old module replay, Files/Email reassignment or R206 recovery. Codex may inspect and run declared commands, never author frontend/test code directly.

Use `codex/mac-import-page-20261015` based on the exact published coordination commit. Future implementation PR base is `codex/ui-parity-mac-import-baseline-20261015`; logical final integration remains `codex/ui-parity-integration`. Do not target stale original Mac snapshots. No auto merge, force push, deployment or Docker. Request/authorization state is generated only on Mac from the real human prompt, never copied from Windows.

Baseline typecheck is exit2 with exactly one Windows-owned TS6133 at `frontend/src/pages/credentials/CredentialBatchPanel.test.tsx:3` (unused React). This file is neither allowed nor a dependency. Mac runs only `npm run typecheck`, reports actual exit/log and zero new diagnostics; it must not report PASS while this diagnostic remains or edit that file. No suites, new detailed tests, build/browser or real API/auth/DB/model calls. Existing hook/page tests may receive necessary interface/type adaptations only; preserve assertions. Windows performs final whole-app type/build/six-page checks. Page acceptance is human and pending.

Windows reserves credentials/index, CredentialDetail, App activation, Batch test one-line fix, backend and final integration. Files/Email/overview/runner corrections have already ended; only accepted delivered source is supplied. Batch actor correction was CLI ERROR with zero delivery and is not accepted.

Report changed paths/hashes, actual exported contracts and actual typecheck result. If ordinary scoped implementation commit/push/draft PR is explicitly authorized by the pasted startup prompt, keep it to the five allowed files and target the branch above; no other commits, PR merge or branch rewrite. Issue readiness alone authorizes no model calls.
