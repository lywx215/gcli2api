# Windows / Mac UI collaboration

This branch is a frozen work-in-progress source baseline for the existing UI restoration. It is not a release or deployment. The original Windows worktree is unchanged. The source snapshot includes the already-authored uncommitted files from the verified handoff; frontend files were copied without edits.

## Code and task handoff

Use `codex/ui-parity-integration` as the PR base. Each independent module has its own Issue, branch and draft PR. `TASKS.json` defines exact file ownership, frozen dependencies, ordered steps and acceptance commands; `MAC_MODULES.md` and its JSON contract define module interfaces. An Issue means queued work, not running or verified work. Source/test output remains authored only by official Antigravity CLI; Codex inspects it and runs commands. Windows owns backend and final parent-page integration.

Mac already has a Git clone. Obtain the published integration commit and create a separate worktree rather than overwriting existing work:

```sh
git fetch origin codex/ui-parity-integration
git worktree add --no-track -b codex/mac-ui-work ../gcli2api-mac-ui FETCH_HEAD
```

If a branch or destination exists, inspect it and reuse only a suitable clean checkout. Do not force checkout, reset, clean, or overwrite. Once GitHub module PRs exist, check out the relevant module branch or PR in its own worktree. Do not run two independent CLI dispatch commands in one project/session; submit independent requests in one shared-hook batch.

## Mac environment

Read `DISPATCHER_MAC_AUDIT.md` and `DISPATCHER_MAC_INSTALL.md`. Shared public source is in `review/shared-distribution/`; install the same hook and role in the Mac user-level locations, with Mac absolute executable paths. No new project runner is introduced. CLI discovery, local login, role discovery and host hook registration still need actual Mac verification. Never copy Windows authorization/session/request state or login storage. Python >=3.10 is needed; use the frontend package's Node range and lockfile without upgrades.

## Starting and coordinating work

Execution remains queue_only with zero automatic model runs. A human starts the Mac project/session using its required development prefix. Issue text, PR comments and GitHub Actions cannot grant or broaden authorization. No scheduled polling, issue-triggered agent calls or automatic review is installed.

The coordination budget is at most sixteen total CLI workers and at most eight per host, reduced to the number of genuinely independent packages and the current local human grant. The shared dispatcher accepts at most sixteen requests in one local batch; it does not provide a cross-host semaphore or guarantee account quota. Existing grants and running batches retain their narrower limits. The first Mac wave still has two packages; do not invent extra work to fill slots. Mac must inspect and install the updated shared user-level source before relying on the new technical capacity. Both write/write and write/read conflicts matter. Windows must leave the recorded Mac context unchanged during this wave. A changed dependency pauses only the affected package until a new base/contract is agreed.

Retries require a fresh request and current local opt-in: at most three total attempts. Transient errors use backoff; rate limits use batch cooldown. Authentication, permission, revocation, scope, hash or malformed-output errors are not replayed. Locks and cooldowns are local; a coordinator records active counts and pauses new dispatch on both hosts when quota is shared. A terminal consumed request cannot be reopened.

## Delivery and checks

Author a coherent module and focused tests in one request. Codex inspects only the allowed files and runs the documented commands. Push module commits and open/update a draft PR to this integration branch; record actual commands and limitations. Do not mark functionality complete based on a file count or CLI summary. Windows accepts deliveries and performs parent integration, then runs the full frontend suite, production build and six-page output check once.

`ui-module-checks.yml` runs only coordination validation for docs-only module PRs; frontend changes additionally run typecheck and the relevant module tests. It has no Docker, deployment, model, database or credential steps. Existing Docker/version workflows do not target this integration branch. The default branch remains unchanged.

## Known baseline limitations

Read `STATUS_AND_VALIDATION.md`. This snapshot has a documented ImportFilePicker test type-import issue, incomplete parent activation/integration and unperformed full current-snapshot acceptance. Do not conceal a baseline failure or infer that all features work. Fixes outside a module's allowlist remain with Windows. Docker and deployment remain skipped. No cancelled MGMT work or unrelated Gemini CLI maintenance is restarted.

## Progress reports

Use Issue status `queued / running / blocked / review / accepted`; name the execution host and exact source commit. Only the local coordinator changes running status after a real dispatch. Report delivered files, test results and blockers at module boundaries. A draft PR may contain only the coordinator's start document until CLI development actually happens; such a PR is not a functional delivery. GitHub contains no local grants or private data.
