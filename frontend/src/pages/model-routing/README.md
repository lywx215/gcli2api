# Model routing page

Integration contract (2026-10-13):

- `index.tsx` default-exports `ModelRoutingPage` for the lazy `#/model-routing` route.
- All page requests use shared `requestJson` with `config/model-routing` (GET and PUT `{ routes }`) and an AbortSignal. The page API never imports fixtures.
- Explicit DEV fixture transport can dynamically import `fixtures.ts` and call `fixtureModelRoutingRequest(url: URL, init: RequestInit): Response | Promise<Response>`. Unmatched requests return HTTP 404. Data stays in synthetic in-memory storage.
- The page consumes `app/routes.registerRouteGuard((attempt: { from: string; to: string; href: string; retry(): void }) => boolean): () => void`. False retains the rendered page and restores its address. Confirmation calls retry once, only in the original session epoch.
- Header logout provides `data-panel-action="logout"` on its button. Page capture intercepts logout while dirty, busy, or awaiting confirmation and calls shared `auth.logout()` after explicit discard. Text matching is not used.
- Shared guard code stays independent of business-page imports. Old `/model-routing` remains the legacy document entry.

The shared dependency is foundation commit `312ce959e92f27f4bc446227073cc5589472dc12` (locally cherry-picked as `492d7de`). Integrate that dependency together with the page commit. The page itself writes only this directory.

Behavior:

- Antigravity is the default view. Global row numbering follows the complete interleaved array, and edits preserve both channels, unknown fields, raw types and array order. Invalid names/types are only changed by an explicit field edit; unknown fields require explicit deletion and recreation.
- Only the existing `model.routing.aliases` capability and both declared channels enable editing. Missing capability/channel support leaves the table read-only. No Management schema, capability, model runtime or database change is needed; manager action is `no_counterpart_action`.
- PUT sends the complete `{ routes }` table. An authoritative, valid and equal full response confirms success. HTTP 4xx is a rejection; network, 5xx, malformed or mismatched 2xx leaves an unknown result. There is no automatic PUT retry.
- Manual GET creates an observation without replacing the draft or clearing an unknown result. Explicit adoption discards the draft; explicit completion of comparison retains the draft. Both actions have confirmation dialogs and send no write.
- Only the exact dedicated GET 503 `MODEL_ROUTING_UNAVAILABLE` permits offering an empty-table recovery. Establishing that draft and saving it require separate explicit confirmation. A later unrelated read failure removes the recovery offer.
- Dirty drafts, unknown submissions and pending requests protect hash/history navigation, old-document links, logout, refresh and closing. Cancel restores an available visible control, including after mobile navigation links unmount. Already dispatched saves cannot be undone by aborting or leaving.
- Session epoch changes clear all page data and dialogs, abort work, ignore late responses and start a fresh GET after login. Drafts are neither persisted nor carried to the next session, and PUT is never replayed after login.

Validation: `npm run typecheck` passes; `npm test -- src/pages/model-routing` passes 64 tests in four files. All requests use synthetic Vitest mocks, including real shared-client panel-auth rejection checks. Focus, keyboard tab-panel relationships and obsolete navigation retries have dedicated regression checks. The root integration owns production build/chunk checks and real-browser layout/navigation checks; this page-local result does not claim deployment or actual backend integration.
