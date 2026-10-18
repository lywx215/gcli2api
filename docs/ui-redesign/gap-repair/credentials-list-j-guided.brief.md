# J guided navigation: complete list module

This is the current navigation brief replacing credentials-list-j.brief.md for the same single task list_cache_display_diagnostics_j. All original ordered functional task/acceptance strings and effective top-level acceptance remain verbatim, as do the three allowed files, original ID mappings and full actual production closure. The only top-level task edits mechanically update the brief filename and execution sequence. Complete the internal parts in their original order: saved-status expiry read, shared display clock, then safe diagnostics. Do not emit three task_results; the final result array has exactly one complete logical-task entry.

Current execution gate is I2 actual delivery/inspection → K actual delivery/inspection → J fresh binding. H failed with zero delivery; its still-uncompleted Legacy goal is assigned to K, and the guided template now explicitly uses I2 then K then J instead of the obsolete H-before-I schedule. Do not infer I2 or K is already complete from this brief. Root will bind their actual delivered source later; no assumed I/K hash is supplied. All callers/Legacy/Files remain readonly in J.

## A short reading path, with the full closure retained

First read AGENTS.md, docs/MAINTENANCE_SCOPE.md, current parity scope, the narrow LIST_TEST_SCOPE_ADDENDUM_20261015.json and this brief. The 72 retained context files are an integrity and optional lookup set, not a checklist to open every dependency. Do not repeat a full parent/auth/API audit, read old suites or every historical brief. Use the exact local anchors below; expand a small range only to resolve a concrete missing fact. Implement the task using your own judgment within full acceptance, inspect the changed local regions, and return the required JSON promptly. This brief supplies navigation and preservation facts, not an implementation patch.

The line numbers below are from current actual source and may shift. Match the named anchors after root's final binding.

## Part 1 — useCredentials.ts: expiry-cache path

| Current anchor | Relevant actual behavior / preservation boundary |
| --- | --- |
| 22–53: useCredentials, scopeKey, isScopeValid | Existing admission combines authenticated/current channel, token-backed verified validation, session epoch and isPanelScopeCurrent. Preserve it. A fresh frozen scope object is created during render; use semantic owner/query identity for timer/event ownership, not callback/object churn as permission to rearm. |
| 55–75: state and Generation refs | Existing filters/offset/limit/data/caps/selected/refresh/detailEpoch plus reads/tasks/session and request controller are the state boundaries. Add only the bounded automatic expiry scheduling/consumption needed by the original task; no module-global timer or ledger. |
| 77–103 and 149–154: scope replacement and unmount | Existing paths invalidate all generations, abort owned reads, clear obsolete owner data/capabilities and selection, and retire the owner. Preserve real invalidation and also retire any new timer/read; ignored abort must not publish later. Do not turn ordinary refresh/clock ticks into scope replacement. |
| 105–146: clearScope, acceptCapabilities, revoke | clearScope cancels selection work and increments detailEpoch. acceptCapabilities retains withdrawal semantics; revoke records denied capability and requests refresh. Do not call clearScope merely to refresh an expired saved status. Preserve legitimate capability withdrawal and existing error handling; group capability is required before automatic AG expiry admission. |
| 156–193: ordinary list-read effect | Current reader captures reads/session generations and AbortController, uses boundApi.list(filters,capsRef.current,offset,limit), checks current ownership/abort before publication, processes capabilities, normalizes filters and bounds empty pages. Its dependencies are filters/offset/limit/refresh/scopeKey. Reuse these protections; an auto response must not overwrite a newer manual/filter/page read. Do not add a capability probe or all-page materialization. |
| 195–210 and 247–304: user changes and public controller | applyFilters deliberately clears scope; invalidateReads aborts/clears current data; refresh invalidates reads then increments refresh; setOffset/setLimit invalidate reads; toggle/clearSelection affect selection tasks. Keep the returned shape and these user-facing semantics. An automatic saved-status read must preserve current selection/view/detail/tool ownership; unchanged past deadlines cannot be reopened by ordinary refresh or these state publications. |
| 212–245: selectAll | Existing explicit full-match materialization is outside the new automatic path. Leave it unchanged; expiry reads only the current page via existing list API. |

The current hook has no visibility listener, expiry timer or automatic event ledger. Those are part of the missing task, not existing guarantees. The original acceptance remains decisive: admit only visible/current/verified AG with group capability; validate positive finite Unix seconds and date range; consider both stats.quota_next_expiry and current saved group cooldownUntil; reserve/coalesce the owner/query/deadline event before work; one pending wakeup/read, bounded timer delay, minimum 15 seconds between automatic reads, and bounded memory that cannot evict/rearm the same old event. Identical old response, failure, callback rerender, visibility repeat, refresh or TTL must not loop. A distinct later deadline may cause one new read. No quota/model/health action.

Exact readonly contract lookup if needed: credentials/api.ts:664–674 contains the existing scope-bound list GET creds/status; model.ts:8 and 19–20 define group capability and page shape, 55–69 project stats.quota_next_expiry/parsePage, 84–138 handle existing filters/query, and 180 defines Generation. Do not open the entire 1,000-line API or change these dependencies.

## Part 2/3 — CredentialTable.tsx: one clock and two render paths

| Current anchor | Relevant actual behavior / requested local surface |
| --- | --- |
| 1–79: imports, props, safe GCLI health/Preview/tier helpers | Preserve public props, literal Preview and unknown/known safe labels. The seven new diagnostic fields remain own validated primitives; no API/model type changes or new probe semantics. |
| 81–135: parseModelCooldowns, formatCooldownDeadline, renderGcliCooldowns | Parser already rejects non-number/nonfinite/negative/out-of-date-range values and preserves Unix seconds/fractions. Today valid zero/past entries still render active. Apply the original active-expiry/remaining-time behavior while retaining unknown malformed sets and valid large dates. A well-formed empty active set alone gets 模型冷却：无. |
| 137–147 and 281: component/columns memo | Both branches belong to the same component. Introduce one bounded visible component clock, at most one tick/second while relevant future times exist; use the same now in desktop and mobile and avoid a stale columns closure. Stop/cleanup on hidden, no changing deadlines, owner mode/rows replacement and unmount; return-visible recomputes time. No per-row timers/network. |
| 191–242: desktop status/quota cells | Existing GCLI health/tier and cooldown render sites are here. Add safe diagnostics and remaining times here while retaining AG QuotaStateBadge/protection semantics. Do not mutate raw rows or infer permission when time expires. |
| 324–385: mobile branch | Matching health/tier/cooldown/AG saved-group sites are here; mirror the same validated helper/clock data, not a second timer. Preserve stable filename keys/selection. |
| 253–280, 389–405: action controls | Existing explicit detail/quota controls and disabled/capability behavior are preservation boundaries. Clock/diagnostic changes do not trigger them. |

The seven diagnostic names remain exactly tier_detected_at, quarantine_reason, probe_stage, next_probe_at, last_health_check_at, health_check_started_at and health_state_version. Own dates require finite positive Unix seconds and valid range; stage/version require finite nonnegative integers including 0. Known risk_control_429 gets a fixed safe label; unknown/error objects remain unknown. Never infer healthy/completed/available state.

Readonly AG boundary if needed: StatusBadges.tsx:11–14 delegates to model.ts quotaState/quotaText; model.ts:150–164 contains invalid/blockedUnknown/manualOverride/restricted semantics. Do not edit either file or use elapsed display time to grant unrestricted state.

## The only two existing test edit regions

Read the staged narrow addendum first. In CredentialTable.test.tsx:

- Imports at 1–4 and syntheticGcliRow1 cooldown fixture at 28–40 support the existing test beginning at 159. Read 159–209, especially expired active expectations 206–209; update only these obsolete expectations and strictly necessary count/time setup, retaining the surrounding AG/Preview/tier/health assertions.
- The existing test begins at 378. Read 378–420: fixtures model-large=1e12, model-zero=0 and model-frac=1750000000.5 at 388–392; outdated expectedZero/expectedFrac and assertions are at 409–416. Preserve valid-large Unix-second handling, no millisecond inference and unrelated later nonfinite/range checks. Do not create a new test/matrix or change unrelated assertions. Deterministic time setup/cleanup is allowed only if needed for these existing two cases.

Do not read or run old full tests. The absence of runtime checks in this CLI task must be reported honestly; root decides the necessary minimal verification afterward.

## Minimal readonly parent lookup

credentials/index.tsx:163–178 shows useCredentials(mode), separate detail state and parent view mode; 941–954 shows the actual CredentialTable props with c.data.items/c.selected, guarded toggle, blocked, explicit open/openQuota and capability. The separate parent card view after 955 is not an authorized edit target. All actual parent closure remains present, but reading the rest of the page is unnecessary unless a specific unresolved reference requires it. Public controller/props, selection and owner/tool reservations must remain compatible.

## Completion boundary

Every original task/acceptance paragraph in the request remains binding; this guide does not replace or weaken it. Only CredentialTable.tsx, useCredentials.ts and the narrow existing CredentialTable.test.tsx may change. Keep readonly parent/API/Legacy/Files, protected41, all authorization/hash/strict complete-result checks and no-partial-apply. A functional blocker must be reported, never omitted or labelled complete.

Return the supplied schema's full structured JSON promptly with exactly one task_results object, id list_cache_display_diagnostics_j, status completed only after all three original parts, and string notes. No extra entries for original provenance IDs, missing/null array or prose instead of final JSON. Timeout 1800 seconds, max_attempts 1. No commands/tests/builds, unsafe casts, real endpoints/credentials/models/reviewers, shared Hook edits, dependency/assets/backend/data/Git/Docker/deployment. This artifact does not dispatch or claim I2/K/J delivery or final build success.

Current inspected target hashes (navigation baseline only): useCredentials b1725ec9a94abfde1fb212948d9a708030354e23fdce6a7bad66241c8921b681; CredentialTable 9a14136a9b549bad6c5f3369eed845260c3c2f29dfb4bc8333b55e47b82a0786; CredentialTable.test ffe0c209334924925ac5c58e968435ade832a06160314314a7b4e55e22552cb2. Root must freshly bind all real source after K delivery/inspection; no prior I/K hash is assumed.