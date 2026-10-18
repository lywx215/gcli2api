# Detail and legacy quota — complete follow-on module

Prepared 2026-10-15 from current Windows source and the existing credentials/detail-quota functional recheck. Covers single-item R02/R03, R08/R09/R10 and L03/L04. Root stages this file at `docs/ui-redesign/gap-repair/detail-quota.brief.md`. This is a queued template, not an authorization, CLI dispatch or acceptance result.

## Dispatch gate and ownership

The batch-core package must finish first. Root must inspect its real delivered `api.ts` and `advancedApi.ts`, bind this package to those exact exports/hashes, and adjust the anticipated names below if delivery differs. Do not dispatch against an imagined or old API, rerun a consumed request, copy a previous authorization ID, or have this package repair its read-only dependencies. Root supplies a fresh current authorization and the precise file freeze under `PARITY_GAP_REPAIR_SCOPE_20261015.json`.

Only `CredentialDetail.tsx`, `ResultView.tsx`, and `LegacyModelQuota.tsx` under `frontend/src/pages/credentials/` are writable. Three ordered tasks form one complete detail module in one official CLI process, timeout 1800 seconds, one attempt. Tests, index.tsx, API modules and AgQuotaEvidence.tsx are read-only. No model/API/credential access, backend work, dependency changes, new UI samples, test authoring/runs, Git writes, Docker or deployment.

## Manual results, tests and cycle display

Consume the batch package's actual additive public-result contract, currently anticipated as `SafeManualPublicDetails`, `projectManualPublicDetails(value, httpStatus?)`, optional `publicDetails`, and `getPreviewFailureReceipt(error)`. Restore project ID/subscription tier/credit and Preview setting ID/binding ID/fixed failure step in the single-item result. Safe errors remain recognized codes/steps/status-derived text; raw response/error/message fields never enter the view. Recognized safe non-2xx Preview receipts are presentation failures, not successful response evidence. Current status/writeback/phase details remain available.

The `result` returned from a genuine current operation and the ManualResult stored as `AgQuotaEvidenceReceipt.result` must remain the exact original object. Compute public presentation separately. Never write a presentation projection back into that receipt, mutate its raw data, or manufacture release authority from the public DTO, a Preview failure receipt, a batch result or saved state. Additional ResultView props/exports must be optional so existing callers still compile.

GCLI gets explicit default-message and chosen-model test choices. Default invokes the existing manual test with the model parameter omitted; supplying `gemini-2.5-flash` explicitly would still skip the old Preview probe. Chosen-model requires a trimmed nonempty model. Legacy model-card tests always use their explicit existing test target and cannot accidentally use the default choice. AG keeps its existing chosen-model path. Use explicit user actions and preserve any existing confirmation/admission behavior; no effect, open, render or state change may automatically launch a test. Explain the default test may also probe Preview and that tests contact the upstream.

Restore L03 by displaying the existing `last_cycle_stats.cooldown_family` as a safe bounded public label with unknown fallback. Preserve the already-correct flat numeric pro/flash/other/total values and both cycle sections. Do not add unsupported started_at/ended_at fields or resurrect historical statistics work.

## Saved evidence and current-query lifetime

R08 uses AgQuotaEvidence's existing `source: saved` support for the row's saved quota groups/group states/invalid marker and Opus families. Show all saved groups and existing Opus checks/attempts/recheck/pause times and known reasons, including before a query and after a failed query. Construct a separate stable readonly receipt only from those public fields, label it saved, give it no success/verified generation/HTTP-response claims, and always pass disabled=true. Reuse AgQuotaEvidence's existing validation and display. Do not merge saved blocks into a response receipt or mutate AgQuotaEvidence/advancedApi. Current successful response evidence remains a separate original receipt and retains its established legal release flow; saved evidence never renders or enables a release button.

R10 uses the minimal clear-on-new-quota policy: only after beforeManual accepts a new quota attempt, clear prior model cards and obsolete quota presentation/response receipt before the request. On quota failure, ignored-abort late response or Stop, do not restore old percentages or a prior release ticket. A current well-formed successful quota result can populate the cards; missing/malformed models leave them empty/unknown. Unrelated verify/test actions should not spuriously erase valid model cards. Preserve the actual result of the latest completed operation for safe display, and keep saved evidence separately identifiable.

The parent Page's current invocation is required context. `index.tsx:1140-1180` guards owned calls by active opening, filename and manual reservation. `1207-1259` creates a beforeManual(token) lease and releases only the matching token in afterManual, then does a saved-list refresh. `1279-1328` supplies opening-keyed props and nested Email session callbacks. Keep public props, one-shot finishOnce, exact opening/owner/validation/filename, independent tool reservations, focus restoration, the already-fixed Email exit controls and Stop-waiting explanation. Old callbacks must not target a replacement opening or release a newer lease. A stopped HTTP wait does not mean backend rollback.

## Legacy model cards

R09 adds visible h/m/s remaining time and an elapsed “已重置” marker from the already-strictly-validated resetTimeRaw deadline, alongside the existing absolute Beijing time. Missing/malformed/rolling168h remains unknown. A marker indicates the deadline elapsed, not proof of restored quota. Use one bounded display ticker for the mounted visible card list, stop it when no future deadline remains, and clean it on unmount/owner change. It performs no network operation. Preserve the existing deadline readback scheduler, busy deferral, exact captured owner/callback checks, per-deadline consumption and coalescing; adding display ticks must not duplicate that GET or create quota refreshes.

L04 restores AG sorting inside each existing group by validated displayName with the old raw map-key fallback and a stable raw-key tie-breaker. Preserve group order, visibility, badges, friendly/raw toggle and explicit testModel mapping; do not reorder GCLI based on an AG-only legacy comparator. Clock ticks cannot reorder cards or alter model identity.

## Source evidence and acceptance ownership

- R02: `CredentialDetail.tsx:72-91/585-588` strips project/Preview fields; `ResultView.tsx:63-79` lacks them. Existing backend public producer fields are recorded in the batch-core evidence file.
- R03: `CredentialDetail.tsx:120/264/536-538` forces the model path. Backend `src/panel/creds.py:2737-2739/2923-2950` distinguishes omitted model from explicit model.
- R08: `AgQuotaEvidence.tsx:30/804-806` supports saved source, but current Detail only wires response. `398-431` rejects release for saved source; preserve this guard. Old `front/common.js:3354-3365/3764-3770` supplies saved fallback; `3300-3315/3438-3448` displays detailed Opus/all-group evidence.
- R09/R10: `LegacyModelQuota.tsx:246-266/589-590` has only absolute time; `358-467` already owns expiry GET. `CredentialDetail.tsx:258-289/573-582` retains old cards across failure. Old `front/common.js:3598-3613` has elapsed/remaining text, and `3506/3752-3770` clears old model output on refresh/failure.
- L03/L04: `front/common.js:1635-1636` shows last-cycle cooldown family; `3553-3562` sorts AG group members by displayName or map key. Current LegacyModelQuota sorts raw keys instead.

Context includes the three files' full local import closure, current Page caller and saved-list controller, four existing read-only focused tests, and required instructions. It deliberately does not copy every unrelated sibling merely because the Page imports it; those siblings are not dependencies of these three implementation files. Root re-evaluates dependencies after the API package is delivered. Any additional import needed must be declared before dispatch.

CLI returns ordered task_results, exact changed_files and actual source-review notes. Root performs minimum necessary type/build and focused confirmations, including legitimate response release still working and saved failure fallback never releasing. Do not expand to full suites, change/skips tests, or label source inspection as runtime proof. This preparation performed no tests/build/CLI or real service calls.
