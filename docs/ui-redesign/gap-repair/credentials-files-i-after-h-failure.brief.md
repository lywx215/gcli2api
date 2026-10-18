# Files I after H failure: precise local completion

Implement the whole uncompleted Files read-failure interaction now, only in frontend/src/pages/credentials/FilesDialog.tsx. H actually failed and applied zero files. Legacy countdown/sorting is not a functional prerequisite for Files; the former H-before-I sequence was a read/write isolation schedule. The new order is I → K → J, with actual full delivery inspection and fresh binding each time. Keep current Legacy and every real parent/caller dependency readonly. The original I template stays unchanged; this is a new scoped variant, not replay or recovery of H/G temporary work.

## Required local reading and edit anchors

First read AGENTS.md, docs/MAINTENANCE_SCOPE.md, current PARITY_GAP_REPAIR_SCOPE_20261015.json and this brief. The original 73 context files and full recursive production closure remain; only the brief reference changes. Do not open every context, all historical briefs, old full tests, full parent pages or every API/auth module. Read the following actual source ranges and consult other readonly material only for a concrete missing fact. After the minimal edit, inspect changed local ranges and return final JSON promptly; no broad audit/planning loop.

Current FilesDialog SHA-256 is d7108b8f54f91c908fb6908fe06fe2d2488f5bd9ebb23845b69afa6d468d2cc2. Lines are navigation aids; use named anchors if shifted.

| Range / anchor | Relevant current behavior and exact scope |
| --- | --- |
| FilesDialog 39–71, 135–212 | Existing props/actor and retireActor/isActorValid/isLifetimeValid hold the owner/session/channel/validation/current/opening contract. Read these local guards once and preserve them; no new authorization mechanism. |
| FilesDialog 248–284 | A new keyed view creates a new actor with confirmationConsumed=false; cleanup retires it. readError/readBusy/jsonContent are existing React state. A consumed opening stays consumed across ordinary rerenders. No need to inspect unrelated sibling components. |
| FilesDialog 296–324, handleConfirmRead | Existing admission checks reject retired/invalid/consumed/busy/invalid-target calls. At 301 it consumes BEFORE the single readContent call at 309. Success and catch recheck actor validity; AbortError remains ignored. At 317 the current '稍后重试' wording is misleading because consumption stays true. Replace it with safe close/reopen-and-confirm guidance; do not reset consumption, resend, loosen guards or expose the exception body. |
| FilesDialog 428–445, 查看完整 JSON button | The current button checks validity/readBusy/downloadBusy but not consumption; its click opens a second inert confirmation after failure. Disable or replace this consumed-opening action and prevent its handler from reopening confirmation, preserving its initial explicit-confirmation flow. Keep the adjacent download control and success display/copy behavior unchanged. |
| FilesDialog 490–491, readError display | Existing role=alert safely renders the controlled failure text. Use this existing path; no new retry workflow is needed. |
| FilesDialog 556–580, confirmation dialog | Keep explicit user confirmation and existing cancel/close behavior. Retained handlers/double clicks must remain harmless after consumption; handleConfirmRead already enforces it. No automatic request or reset on error/rerender. |
| FilesDialog 587–608, outer wrapper/viewKey | Existing subscriptions and isLifetimeValid control teardown; viewKey includes mode/session/channel/owner/validation/target identity. Do not weaken them to allow retry. Close/reopen naturally creates a fresh actor and requires a new explicit confirmation. |
| credentials/index.tsx 829–844 only | Actual Files caller passes toolSession scope, validation, ownerRevision, createToolOwnerPredicate, open/target and createToolClose, gated by the active reservation ID. This is the required parent context; a full parent traversal is unnecessary. |

Download/export helper regions are readonly preservation boundaries inside this allowed file; do not edit them. Full API/auth/parent dependencies remain available if an exact unresolved call needs lookup, not as mandatory reading. Root freshly binds actual source after any relevant concurrent change.

## Original acceptance remains complete

The request retains the original files-consumed-read-failure task and acceptance verbatim, mapped to single result ID files_consumed_read_i2. Opening and first view click issue zero sensitive GETs until explicit confirmation. One confirmation admits at most one read. Failed consumption remains consumed; show safe guidance such as '本次读取未完成。请关闭后重新打开，并再次确认查看。' and remove/disable the misleading second action. Do not revive actors, reset consumption or add automatic retries. Closing/reopening needs a fresh explicit confirmation.

Preserve successful plaintext/copy and clearing on close/unmount/owner/target/session/channel/validation replacement even with ignored abort; callback-only rerender and StrictMode isolation; single JSON, selected ZIP limits/duplicates/empty checks and all-channel exports; safe filenames and object URL/timer cleanup. No tests or any other source edits. No new API or authorization mechanism.

Final structured JSON must contain exactly one task_results object: id files_consumed_read_i2, status completed only when the complete target is implemented, and string notes; include other ordinary fields required by the provided schema. Missing/null/extra entries or partial work are rejected under unchanged authorization/order/hash/allowed/no-partial-apply checks. Timeout 900 seconds, max_attempts 1. No commands/tests/builds, real requests/credentials/models/reviewers, unsafe casts, backend/data/dependency/assets/Git/Docker/deployment. Root performs necessary acceptance. This artifact has no authorization ID and performs no dispatch.

I may share a batch with E2 only if root's actual full closure check proves zero write/write and both-direction write/read overlap. Never remove dependencies to permit concurrency. K must later rebind the actual delivered I; J likewise remains a fresh later serial package.