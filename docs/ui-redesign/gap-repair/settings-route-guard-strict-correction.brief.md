# Strict settings route guard correction · 2026-10-15

Fresh official CLI correction after delivered Guard B. Only `frontend/src/pages/settings/components/UnsavedChangesGuard.tsx` may change. Parent owns current authorization, context hashes and dispatch; no consumed request replay. Single attempt, timeout 600 seconds, two ordered tasks. Do not run commands/tests/builds, call external review or APIs, edit tests or any other source.

The delivered Guard at SHA-256 `a53b125049bed72cc1e396bf76609d7b0ffc01f1919b8db819d366ca5e8a750b` still has two precise acceptance failures:

- Line 82's `expectedEpoch > 0 && session.sessionEpoch === 0` returns true with a null token, ignoring validation. This is a mock compatibility concession. Standard current AuthProvider ordinarily prevents that contradictory state, so this is not claimed as a demonstrated anonymous production exploit; nevertheless production guard logic must not accept any unverified or contradictory session snapshot.
- Line 427 unconditionally calls `navigateFromSettings(pending.href)` after the same-document shared navigation attempt. Its real implementation in exitProtection.ts:45 is `window.location.assign(href)`. If a different guard rejects shared navigation, the current confirmation still triggers a second raw navigation. If an earlier guard rejects before the local registration consumes `approvedDepartureRef`, that approval can remain for a later matching navigation.

## 1. Remove every unverified-session exception

Use actual `getSessionSnapshot()` and `getSessionValidationSnapshot()`. A confirmation is valid only with authenticated render context **and** current non-null token, exact pending/session epoch equality, matching validation epoch and verified validation status. Null token or mismatched/unverified state always fails closed for confirmation; do not add test flags, mock detection, epoch-zero exceptions, missing-provider fallbacks or catch-to-success behavior. Read-only tests/mocks may need parent handling; never weaken production checks to satisfy them.

Keep the current pending identity, synchronous one-use claim, mount/setup lifetime, originating accepted navigation fence and cleanup behavior. Authentication loss must revoke pending work and remain free to exit: route and anchor entry points must not create a blocking secret confirmation based solely on stale captured authenticated values after the live session has invalidated. Preserve StrictMode fresh setup and normal valid route retry.

## 2. Use only shared acceptance for same-document anchors

Remove the unconditional raw `navigateFromSettings` call from the internal anchor branch. A same-document anchor confirmation must perform only the shared `navigatePanel` attempt, inspect accepted snapshots and clear secrets only when `navigationEpoch` advances to the expected route/mode and current owner/lifetime remain valid. A refused/no-op transition remains on the shared accepted route; never retry it through a raw location/hash fallback.

Scope `approvedDepartureRef` to the synchronous shared navigation call and clear it in `finally`, including throws, no-ops and refusal before the local guard is reached. It may bypass only this already-confirmed matching navigation, cannot become permission for a later attempt, and must retain identity/owner/lifetime checks. Preserve one prompt and do not add another private router. The distinct explicitly confirmed full-document branch may retain its existing `navigateFromSettings` use and discard-all semantics under current confirmation checks.

Do not alter successful retry acceptance, stale/consumed callback rejection, cancellation, focus return, carriedDraft, secret cleanup, logout, ENV lock or read-only delivered components. Do not add or edit tests. Report these two precise changes and any unexecuted validation honestly; parent performs acceptance.
