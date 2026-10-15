# Shared Claude / Antigravity workflow

This file documents the one user-level workflow at `C:/Users/lywx2/.codex/review/hook.py`.
Existing project `.codex/review.json` files are reused. New local projects use source-file defaults
without needing another runner. Git worktrees inherit main-checkout configuration but operate
on their own files. All external-agent calls are off by default.

## User authorization

| User prompt | Effect |
| --- | --- |
| `请 Claude 审核：<task>` | Existing Claude review |
| `请反重力审核：<task>` | Antigravity plan/code review |
| `继续反重力审核` | Continue the same Antigravity review, including another group of at most 3 attempts |
| `授权反重力开发：<task>` | Permit Codex to dispatch Antigravity file-development requests within this task |

Aliases: `/claude-review <task>`, `/antigravity-review <task>`, `/antigravity-develop <task>`.
Review does not authorize Antigravity development, and development does not authorize a reviewer call.
Configuration, ordinary task completion, a generic “继续”, and discussion of review do not authorize calls.
A normal new user prompt revokes old authorization. Only the workflow's own continuation feedback is
accepted automatically. Antigravity review attempts, including failures, are persisted before dispatch;
after 3 automatic attempts, another review requires `继续反重力审核` from the customer.

## Review

Write or update the session-specific plan path supplied by the UserPromptSubmit hook.
The Stop hook reviews the plan, provides findings, then reviews implementation after the plan passes.
It uses `gemini-3.8-flash-high` with the globally registered `codex-reviewer` role.
Each Antigravity call uses a fresh conversation. The agent sees an evidence copy, and no review
file writes are applied to the project. In CLI 1.3.4 the initial tool inventory includes more than
the custom role's tools, so role metadata alone is not treated as a filesystem security boundary.
Actual tool events are checked, evidence-copy hashes are verified, and changed inputs invalidate results.

## Codex-dispatched file development

After the user explicitly grants development, the hook provides the current session ID and authorization ID.
Codex writes a request file relative to the project root, for example:

```json
{
  "authorization_id": "<exact ID from this session's hook feedback>",
  "task": "Implement the scoped subtask described by Codex",
  "allowed_files": ["src/example.py"],
  "context_files": ["AGENTS.md", "requirements.md"],
  "acceptance": "Describe the observable behavior and checks Codex must run"
}
```

The lists name individual files, not globs or directories. Source must be UTF-8 text.
Include relevant project instructions as context. The child may create new allowed files, but file deletion,
credential files and databases are outside this file-delivery workflow. Shell-command verification stays with Codex.

Invoke the same installed dispatcher with the actual root, current session and request path:

```powershell
& 'C:/Users/lywx2/AppData/Local/Programs/Python/Python312/python.exe' `
  'C:/Users/lywx2/.codex/review/hook.py' --dispatch `
  --cwd '<project-root>' --session '<current-Codex-session-id>' `
  --request '.codex/antigravity-task.json'
```

The dispatcher checks stored authorization and consumes the request once, copies specified files into
a temporary workspace, invokes `codex-developer` with `--mode accept-edits`, and inspects actual file changes.
Out-of-scope changes, revoked authorization and changed original/context files cause rejection before delivery.
Only allowed changed files are copied back. Codex receives changed paths and the child summary and then performs
acceptance checks. No automatic commit, push, release or reviewer call is performed.

For one to sixteen independent subtasks, repeat `--request` in the **same** command:

```powershell
& 'C:/Users/lywx2/AppData/Local/Programs/Python/Python312/python.exe' `
  'C:/Users/lywx2/.codex/review/hook.py' --dispatch `
  --cwd '<project-root>' --session '<current-Codex-session-id>' `
  --request '.codex/antigravity-task-a.json' --request '.codex/antigravity-task-b.json' `
  --request '.codex/antigravity-task-c.json' --request '.codex/antigravity-task-d.json'
```

The same actual project/session and current development authorization cover the whole batch.
At most sixteen requests are accepted; seventeen or more are rejected before any CLI call. The dispatcher
validates every request and all request pairs, then reserves the entire batch's IDs atomically
before any CLI call. Write/write and write/context overlaps, including path aliases and file/parent
collisions, are rejected up front. Shared read-only context is permitted. Declare every project file
that the subtask depends on as context; tasks that depend on each other's output must run serially.
Each worker runs a separate ordinary CLI process in its own temporary copy. The project/session
workflow lock spans the whole batch, so another dispatch/review in that project/session still rejects.
This does not enable the CLI's agent-to-agent delegation tool or change tool permissions.

The coordinator validates and delivers each completed job serially, using a short state lock shared
with prompt/review state updates. A prompt can revoke/replace authorization while CLI calls are
running; every subsequent delivery checks the current grant. The short commit transaction either
finishes before that prompt's revocation or sees and respects it. Successful independent delivery
is retained if any other request fails. Batch output contains one result per request and status
`delivered`, `partial`, or `failed`; partial/failed batches exit nonzero. Every reserved request
remains consumed, including failures or interruption. Requests default to one attempt; a fresh request
may opt into bounded internal retries as described below. Terminal failed/interrupted requests are
never reopened. A legacy one-attempt request keeps its existing output shape. Codex must inspect
every delivered result and run acceptance checks.

On sandboxed Codex sessions, use the normal execution permission flow when invoking the dispatcher needs
network access or writes to the authorized project. Do not bypass a rejected permission decision.

### Windows login errors inside Codex

The CLI reads cached login from Windows Credential Manager and writes user-level CLI logs. A sandbox
can deny these operations and make a logged-in account appear logged out. Execute the already-authorized
dispatcher through `exec_command` with `sandbox_permissions="require_escalated"` and a justification
limited to that dispatch. This means execution under the current Windows user outside the Codex sandbox;
it does not require switching accounts or running as Administrator. Use the normal approval flow and
respect rejected decisions. The shared hook never escalates itself or refreshes login. Internal
retries require the fresh-request opt-in below; a terminal failed job is not relaunched.

Verify authentication using a real, no-tool request in the same execution context:

```powershell
& 'C:/Users/lywx2/AppData/Local/agy/bin/agy.exe' -p 'Reply with exactly OK. Do not use tools.' `
  --model gemini-3.8-flash-high --disable-slash-commands --output-format json --print-timeout 60s
```

`status=SUCCESS` and response `OK` prove that request authenticated. Version/help/model lists do not.
If normal-user execution succeeds but sandbox execution fails, report an execution-permission problem
and dispatch through the approved normal-user context. Ask for interactive `agy` login only if the
normal-user request also fails specifically for authentication. Do not export or copy credential tokens.
A failed request remains consumed: after resolving the cause, create a distinct scoped request under
the still-valid authorization. A new ordinary user prompt revokes authorization, so obtain a new explicit
development grant in that window if needed. Review failures still count toward the three-attempt limit.

## CLI and verification

Official executable: `C:/Users/lywx2/AppData/Local/agy/bin/agy.exe`.
Validated version: 1.3.4. Validated model: `gemini-3.8-flash-high`.
Global roles: `C:/Users/lywx2/.gemini/config/agents/codex-reviewer.md` and `codex-developer.md`.
Each dispatch now uses the official single-turn `--print <prompt> --output-format stream-json` path.
Output streaming remains enabled so actual tool calls can still be checked. No conversation is resumed.
On 2026-10-14, both stdin-stream and print no-tool probes succeeded under the normal Windows user.
Background logs also contained unspecified-auth/not-logged-in warnings during successful probes;
these log substrings alone do not prove foreground authentication failure or a transport-specific bug.
Use the foreground result status and actual response as evidence. The current signed binary was 1.3.5.
No `--dangerously-skip-permissions` flag is used. No latest-conversation resume is used.
The CLI's structured output is validated; the observed CLI 1.3.4 Python-literal review format is parsed
with `ast.literal_eval`, never executed. Unsupported review output is reported as a failed review.

Official documentation:
- https://www.antigravity.google/docs/cli/install/
- https://www.antigravity.google/docs/cli/headless/
- https://www.antigravity.google/docs/subagents/

Eight-way capacity was enabled on 2026-10-14 and increased to sixteen on 2026-10-15. A batch may contain 1–16 independent requests. Use fewer requests when dependencies or file conflicts prevent safe concurrency. This changes capacity only; it does not authorize development, launch extra CLI sessions, alter model limits, or enable native subagents.

## Scoped dispatch efficiency and failure diagnostics (2026-10-14)

Developer prompts now recommend reading exact listed files with view_file, using replace_file_content/write_to_file, avoiding known grep parsing trouble and deprecated multi_replace_file_content, and returning the final JSON promptly after the scoped change. These are advisory instructions; the role-specific tool allowlists are unchanged.

Prefer a complete coherent module per request, grouping related implementation, wiring and necessary
regressions into an ordered task package instead of separate requests for tiny edits. Preserve separate
source modules. Keep required project instructions and actual dependencies as context, without repeated
historical evidence. Freeze shared public interfaces before dependent page work; run independent
modules in the same batch (up to sixteen). Dependencies inside one ordered package run serially in its
single temporary workspace. Dependencies across packages must run in later batches. Do not omit
necessary context or replay consumed requests.

The fixed CLI stderr marker Print mode: print timeout is reported as an explicit CLI print timeout even when the CLI exits zero with an empty SUCCESS. Failures now include elapsed seconds, fixed event/tool counts, an allowlisted final status, exit code and response character count. Raw output, prompts, tool parameters, paths, credentials and account/session identity are excluded from these diagnostic summaries. Existing unrelated task/state fields retain their existing behavior.

That diagnostics revision preserved successful result/return formats, model, CLI arguments, 9-minute
print limit, 600-second process timeout, eight-way capacity, authorization/revocation, request consumption,
file scopes/hashes, locks and rollback. The opt-in additions below leave legacy requests at those defaults.
Timings and counts are diagnostic evidence; improved real throughput has not yet been measured.

## Ordered module packages and bounded retry opt-in (2026-10-15)

Capacity is sixteen independent CLI processes. Each slot may now receive one request containing
two to five related tasks (up to twelve), executed in the supplied order within ONE CLI session.
Use the union of their individual file allowlists and all actual read dependencies. Keep source files
modular. Do not group unrelated modules merely to fill a slot, or send concurrent requests which write or
depend on each other's files.

Example new request fields, alongside the existing authorization_id/task/allowed_files/context_files/acceptance:

```json
{
  "tasks": [
    {"id": "implement", "task": "Implement the scoped module", "acceptance": "Preserve the frozen interface"},
    {"id": "wire", "task": "Wire its existing native page entry", "acceptance": "Explicit actions only"},
    {"id": "regressions", "task": "Add the necessary focused regressions", "acceptance": "Real owner and synthetic transport"}
  ],
  "retry_policy": {"max_attempts": 3, "initial_delay_seconds": 20, "max_delay_seconds": 120},
  "timeout_seconds": 900
}
```

The developer returns task_results in exact task-ID order, each with id/status/notes. Every status
must be completed for delivery. A blocked, incomplete or misordered package is rejected without
applying partial edits. This report is not proof of correctness; Codex still inspects the changes
and runs command acceptance. Only development supports packages; review rounds remain unchanged.

Legacy requests keep one attempt and a 540-second print/600-second process timeout. Ordered packages
default to a 900-second print limit; an explicit timeout_seconds may be 60–1800, with a 60-second
process grace. The selected model, official CLI, permissions and tool/file checks remain unchanged.

An explicit retry_policy permits at most THREE total CLI attempts (two retries) within one fresh,
still-running logical request. Generic foreground CLI execution errors and explicit temporary
UNAVAILABLE/INTERNAL/DEADLINE_EXCEEDED errors use exponential backoff plus jitter. RESOURCE_EXHAUSTED
or HTTP429 uses a shared batch cooldown of at least 60 seconds, then 120 seconds, bounded by the
configured delay cap. Retry waits recheck authorization and inputs at most every five seconds.

Each attempt has its own persisted number/status. Every retry uses a NEW temporary workspace seeded
only from the original frozen inputs; failed partial edits are never reused. Authorization ID,
running reservation and original/context hashes are rechecked before every call and during backoff.
Out-of-scope edits, deletion, changed files, revoked/replaced grants, authentication/permission/config
errors, cancellations, local print/process timeouts and malformed/incomplete results do not retry.
No login bypass, role change, production operation or recursive replay of a consumed request occurs.

Retries are sequential within their worker slot, so sixteen slots never become thirty-two or forty-eight
concurrent CLI processes. A final failure remains consumed; manual redispatch of the same request is
still rejected. Existing delivered or failed requests are unaffected. The opt-in must be covered by
the human's current development authorization; changing this capability does not create that grant.

## Sixteen-slot capacity (2026-10-15)

The human requested a capacity increase to sixteen. MAX_DEVELOPMENT_JOBS is now 16;
17 requests reject before any CLI call. This is local batch capacity, not an account
quota promise or a distributed semaphore. The current two-host coordination budget
is at most 16 total and at most 8 per host; narrower existing grants and module
ownership still win. Windows and Mac independently sum their active counts.

Already-running batches retain their loaded code and worker count. Existing 3-, 4-
and 8-slot grants are not widened and stored authorizations are not rewritten.
The project staging helper recognizes a distinct future sixteen-slot task, only
after a real matching human development grant in that project/session. Capacity
setup alone starts no CLI, creates no grant and consumes no request. Sequential
bounded retries, review rounds, scopes, conflict/hash checks and revocation stay
unchanged. Sync this same source to Mac through its normal user-level installation;
no second project runner is introduced.
