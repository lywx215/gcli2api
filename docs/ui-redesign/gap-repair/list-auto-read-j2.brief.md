# J2 — only the actual J1 list auto-read lifecycle residual

J1 was officially delivered. R09 Legacy narrow setup fix is already correct; all Table/test changes are under separate inspection. Do not redo J1 or touch any other source.

Writable: useCredentials.ts lifecycle plus the specific Table scalar-narrowing function described below.
Read precise anchors first: current effect around lines 276–389, original read effect around 205–253, generation refs and owner replacement around 108–160, refresh/applyFilters/invalidateReads/setOffset/setLimit. Read only real dependencies needed; full readonly import closure is an integrity boundary.

Confirmed actual blockers:
1. Expiry effect cleanup only clears timeout and removes visibility listener; no owned request abort or effect-local lifecycle fence.
2. Hidden visibility does not cancel timers/abort in-flight automatic GET. A request admitted while visible may still accept data/caps/errors after becoming hidden.
3. Old automatic request finally unconditionally sets expiryInFlightRef false even if another owner/request now owns it; only abort-ref cleanup is conditional.
4. A throttled callback can survive stale effect lifecycle without a disposed/actor check. Timer delay for the throttle must be bounded as well as deadline wakeup.

Fix only these lifecycle residuals, retaining current extraction, public API/return shape, bounded dedup ledger/high-water semantics and 15-second minimum automatic request separation. Use one effect-owned/request actor identity (or equivalent) that owns its timer/controller and cannot mutate a new actor's shared fields. Hidden, effect cleanup/query replacement, manual invalidation/refresh, scope/channel/session loss and unmount must cancel owned schedules, abort owned automatic requests and fence ignored-abort success/error/capability commits. Recheck current scope/read generation/actor/visible status immediately before automatic admission and all response/error commits. Old finally may only clear its own active controller/in-flight ownership. Cleanup must not abort or invalidate a newer manual request.

No new automatic requests beyond the current saved status cache list path. Keep exactly one owned pending wakeup and at most one automatic read. Consume due deadline(s) before admission as current code does; cancellation/failure/visibility/identical response/ordinary refresh must not reopen consumed markers or reset last-admission clock. A distinct later deadline remains eligible once. No periodic polling or automatic retries. Preserve row selection/detail/tools/view, capability withdrawal semantics, existing manual reads, offset/filter/capability handling and StrictMode behavior. Keep timer delays bounded when the clock changes. No module-global ledger.

All other delivered code and frozen dependencies are readonly. No Table changes outside the named scalar narrowing, test, Legacy, API, backend, auth core, new tests, dependencies, assets or database edits. Do not run commands/tests/builds/network/reviewer calls. Return exactly one completed task_results object with id list_auto_read_lifecycle_residual only when the full residual is fixed. A blocker is not completion.

Additional confirmed residual in the same hook: when current data contains consumed-due d1 and a distinct future d2, a failed d1 auto read currently leaves data/caps dependencies unchanged and never schedules d2. On safe owned settlement, reassess still-unconsumed distinct future deadlines and schedule the next bounded wakeup. Never retry d1, reopen consumed events or poll on TTL; preserve 15-second separation and own actor/visibility fencing.

One additional actual compile blocker is narrowly writable in CredentialTable.tsx renderAgGroupQuota only: tsc reports TS2365 at current line170,column202, Operator '>' cannot be applied to types '{}' and 'number'. The expression re-asserts Record<string,unknown> then uses non-null assertion to compare its unknown cooldownUntil. Locally extract the raw cooldownUntil once, use strict typeof-number/finite/positive narrowing, and use the resulting number or null in the existing return. Preserve all current valid-date/future/Badge rendering semantics. Only this local scalar narrowing is permitted in Table; no clock, diagnostics, columns, test or other Table changes. No casts that bypass unknown safety. This is an actual captured compile error (TYPECHECK_AFTER_J1 exit2), not speculation.

Both fixes form ONE logical narrow residual task. Writable files are useCredentials.ts and the named Table function only. Legacy and test remain readonly. Do not run commands or claim validation passed.
