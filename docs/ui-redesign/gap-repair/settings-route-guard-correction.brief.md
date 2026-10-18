# Settings route confirmation correction · 2026-10-15

This is a fresh official Antigravity development request prepared for the parent to bind and dispatch. It does not reuse the consumed settings/node request. Only `frontend/src/pages/settings/components/UnsavedChangesGuard.tsx` may change. All listed context files, including the other four delivered settings/overview files and every test, are read-only. Do not run shell commands, tests, builds, external reviews, real APIs, or Git operations. Do not add tests or test matrices.

The earlier delivery connects settings route/mode departure to `registerRouteGuard`, but the confirmation callback currently accepts target equality after `attempt.retry()` without requiring a new accepted navigation. A shared route retry can legitimately do nothing for an obsolete/used attempt. Render-captured authentication and pending values also cannot establish that a retained callback still owns the current confirmation. The current same-document anchor confirmation additionally clears secrets before calling `navigateFromSettings`; this is a real current handler and predates the new route guard. Cover both current paths while retaining existing product behavior.

The source inspection report distinguishes ordinary current confirmation from a retained old callback: normal back/forward/programmatic confirmation is wired and is not claimed to fail. The retained scenario is A being superseded by B to the same target, followed by a fresh secret and an obsolete A callback; target equality alone must not clear the fresh secret. The parent performs acceptance after delivery.

## Task 1 — Claim only the current confirmation

Use the actual `auth/session.ts` APIs and `app/routes.ts` types in this bound source snapshot. `getSessionSnapshot()` supplies the synchronous current owner/session epoch; inspect its real validation snapshot API as well and require the current verified session, rather than trusting render-captured `authenticated` alone. Never print, persist or include the token in dialog state or diagnostic output.

Give each pending confirmation an explicit current identity and mount/setup lifetime. Validate current mounted lifetime, current pending identity, latest owner/session and originating accepted navigation snapshot before any discard or retry. Synchronously claim a valid confirmation once, before calling its retry/navigation action. Cancel, replacement, session cleanup and unmount must revoke prior identities. Repeating an already claimed callback is a no-op; an old closure cannot consume or clear a newer pending dialog. React StrictMode cleanup/setup must establish a new valid lifetime without reviving old callbacks or permanently disabling the fresh registration.

Preserve cancellation/focus return. Session invalidation/logout clears pending confirmation and permits exit; the settings guard must never turn authentication loss into a navigation block. Preserve current ordinary carriedDraft and secret handling, modifier/new-tab anchor behavior, and full-document/beforeunload protection.

## Task 2 — Clear only for this accepted departure

Use `getAcceptedPanelRouteSnapshot()` and its real `navigationEpoch`. The shared `RouteNavigation` carries expected `to`/`toMode`, from route/mode and `retry()`; the routing implementation already makes a retry single-use and rejects stale route generation, removed registration and changed owner epoch. Its no-op return is not authorization to clear anything.

For a current claimed route attempt, capture the accepted snapshot immediately before retry, call retry once, then obtain the accepted snapshot again. Clear secrets only when this operation caused an accepted navigation epoch advance, the accepted route/mode matches this attempt's exact expected target, and the relevant live owner/lifetime/identity is still valid. Mere route equality or `window.location.href` equality is insufficient and must not be an OR fallback. Preserve the originating snapshot fence so an attempt superseded by unrelated accepted navigation cannot later clear a newer draft. Do not use global route state or a new private router to bypass the existing transition mechanism.

A stale/used/no-op retry, another guard's refusal, session change or unrelated accepted destination must not call discard. An actual synchronous unmount cannot authorize a retained callback to clear state owned by a later Settings instance; use existing cleanup semantics and a safe current-owner/lifetime design rather than weakening the fence.

Route supported same-document anchor departures through the existing shared route guard/attempt semantics so the actually callable anchor handler also clears only after accepted navigation. Read the existing exported helpers and anchor behavior from the provided source; do not invent parser signatures or unsupported navigation APIs. Keep one confirmation per departure, avoid a second interception prompt, and treat same route/mode/canonicalization no-ops as no discard. A successful internal departure clears secrets while ordinary carriedDraft survives. A current explicitly confirmed full-document departure may discard all once before leaving, under the same latest-owner/identity claim; do not conflate that path with a shared in-document accepted transition.

## Acceptance and handoff

Complete these two tasks in order as one module. Maximum one attempt, timeout 900 seconds. Deliver only the one allowed source file; no package, API, shared routing/auth, settings parent, overview or test changes. Preserve ENV lock, migration admission, safe source labels, metadata fallback and confirmation-before-plaintext behavior in all read-only components.

Inspect the existing test expectations as context only. If a preexisting mock cannot express shared route acceptance, report that limitation instead of changing a test or weakening production acceptance. Do not add ad hoc fixtures, matrices or commands. Describe the static path for current route confirmation, current anchor confirmation, cancellation, logout and stale/consumed callbacks, clearly distinguishing inspected reasoning from executed validation.

The parent binds hashes against the final stable public contexts, owns authorization/ownership/staging, and dispatches a fresh request. This template contains no authorization ID and is not itself permission to invoke CLI or replay a consumed request.
