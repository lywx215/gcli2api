# Frontend foundation

This branch provides the independent Antigravity console foundation. Every route currently lazy-loads `app/PlaceholderPage`; it does not implement a business page or change the legacy panel. Integration replaces the loader with each default `pages/<name>/index.tsx` export (`overview`, `credentials`, `import`, `settings`, `logs`). Do not put page implementation in App.

## Run and verify

Use Node 24 LTS (tested 24.19.0), or the compatible Node range in package.json. From `frontend/`:

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run check:build
$env:VITE_UI_FIXTURES='true'
npm run dev
```

The dev server binds loopback; fixtures accept any nonempty synthetic password. Unknown fixture routes return 501 and never fall through to a backend. Page-specific synthetic adapters remain page-owned. Set no real secrets in Vite environment variables. Without fixtures, the dev proxy targets `http://127.0.0.1:7861` (override with server-only `UI_PROXY_TARGET`); only `/auth`, `/creds`, `/config`, `/version`, `/model-routing` HTTP and `/logs` HTTP/WS are proxied. No Python server is launched.

Vite uses `base: './'`, hashed JS/CSS, dynamic imports, and `../ui-dist`. Serve production through the Python owner's canonical `/ui/` route, including a prefix-preserving redirect from `/ui`. Static preview alone deliberately fails initialization until `gcli-service-base` is safely injected. The server HTML-escapes `__GCLI_SERVICE_BASE__` and `__GCLI_EMBED_POLICY__` meta attributes, applies HTML no-store and CSP, and owns rollback. There is no inline secret/bootstrap script or legacy manage-ready message.

The service base is a same-origin absolute URL or origin-relative path ending `/`; query, fragment, userinfo, whitespace, percent-encoded or traversal roots are rejected. DEV missing injection defaults to the origin root; production missing/invalid injection shows a safe initialization error. Resource base and API root are independent.

## Public modules

`@/api/client` exports `ApiError`, `Query`, `RequestOptions`, `BlobResult`, `getServiceBase`, `createServiceUrl`, `requestJson`, `requestBlob`.

```ts
import { requestJson, requestBlob, createServiceUrl, ApiError } from '@/api/client'
// Illustrative types: each page owns the real response validator and business semantics.
const result = await requestJson<unknown>('creds/status', {
  query: { mode: 'antigravity', page: 1 }, signal: controller.signal,
})
const { blob, response } = await requestBlob('logs/download')
const filenameHeader = response.headers.get('content-disposition')
const socketUrl = createServiceUrl('logs/stream', { token })
socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
// Never log socketUrl; the legacy WS protocol carries the token in its query.
```

`getServiceBase(): string` is an absolute validated trailing-slash URL. `createServiceUrl(path, query?): URL` rejects absolute/root-relative paths, traversal and encoded path escapes. Query null/undefined are omitted. `RequestOptions` has `method?: string`, `query?: Query`, `body?: unknown | FormData`, `signal?: AbortSignal`; default method is GET. JSON is serialized with content type; FormData keeps the browser boundary. `requestBlob` returns `{blob, response}` so result-count and filename headers remain available (body is already consumed). Non-2xx throws `ApiError {status, payload, message}`; messages never echo response payloads, and non-JSON error bodies are not retained. Raw structured payload is for a page's validated projection, never a toast/log. Abort and network errors remain distinct. No request is automatically retried. HTTP 200 is not business success; every endpoint adapter must validate its actual result shape. A 204 returns null.

Token headers are automatic except login. Authenticated redirects are refused. Mode placement follows the endpoint: query for list/actions, body for OAuth and refresh-token import. The API does not infer a mode, retry writes, prefetch quota, or infer capability support. Quota reads can write state/contact upstream and require explicit user action.

`@/auth` exports `AuthProvider`, `useAuth`, `registerSessionCleanup`. `@/auth/AuthProvider` exports the same provider/hook for direct imports.

```ts
const { token, authenticated, sessionEpoch, login, logout } = useAuth()
// registerSessionCleanup is optional for non-React read caches / polling / sockets.
useEffect(() => registerSessionCleanup(() => readCache.clear()), [])
```

Login calls `auth/login` with `{password}` and requires a nonempty token, rejecting semantic false. `authenticated` means a local token exists; the server remains authority. Storage uses only `gcli2api_auth_token`, with memory fallback. Login/logout/auth invalidation and cross-tab token changes advance the epoch. Concurrent login attempts cannot resurrect an older session; in-flight client requests are aborted and also checked after their body resolves. Clear code must not depend solely on AbortController.

Only the existing FastAPI panel dependency's exact detail-only errors (`密码错误`, `Not authenticated`, `Invalid authentication credentials`) on 401/403 invalidate the session. Upstream quota provenance, other business payloads, unknown 401/403, and login failures remain ApiError without logout. This deliberately favors not misclassifying upstream errors; changing backend auth payloads requires an explicit contract update/test.

The shell keeps visited pages mounted but hidden/inert while reauthenticating so page-owned memory drafts can survive. Pages MUST watch `authenticated` and `sessionEpoch` to clear protected read data, selections and sensitive inputs, release polling/WS, and mark drafts as needing reauthentication. After login, never replay writes or silently overwrite drafts with a GET. Pages own per-request sequence checks and draft persistence across route changes. The foundation does not cache API data. Render boundaries provide explicit reload on chunk failures, with unsaved-content warning; never auto-reload.

`@/domain/shared` exports `cn`, `Query`, `QueryValue`. `@/app/routes` exports `routes`, `RouteId`, `routeFromHash`, `useRoute`. `@/components/layout/*` exports `Sidebar`, `Header`, `AppShell`. `@/app/fixtures` exports `registerFixtureHandler` and `fixtureFetch` only for DEV fixture registration; handlers return 404 to defer. Import it only behind `import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true'`. Production eliminates the fixture dynamic import; verify with `npm run check:build` even when VITE_UI_FIXTURES=true is set for a production build.

## Component provenance and exports

Generated using official `@shadcn` registry via `shadcn@4.21.4 add`, Radix **default** variant, neutral semantic tokens, alias `@/domain/shared`. Registry command and component imports were verified with the shadcn MCP tools. CLI is a source generator, not a project runtime/build dependency; it was removed after generation. No manual imitation of registry component markup. For future updates use the pinned generator explicitly and review changes:

```sh
npx shadcn@4.21.4 add button card input select badge sheet dialog alert-dialog tabs progress skeleton field checkbox switch scroll-area table textarea separator label
```

Official setup: https://ui.shadcn.com/docs/installation/vite and https://ui.shadcn.com/docs/components-json . Theme uses semantic CSS variables and the system font; no brand theme commitment. Foundation installs TanStack Table v8, RHF, Zod/resolvers, and React Router for page compatibility. Existing hash shell stays deliberately small.

| Module | Actual named exports |
| --- | --- |
| `@/components/ui/alert-dialog` | AlertDialog, AlertDialogPortal, AlertDialogOverlay, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel |
| `@/components/ui/badge` | Badge, badgeVariants |
| `@/components/ui/button` | Button, buttonVariants |
| `@/components/ui/card` | Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent |
| `@/components/ui/checkbox` | Checkbox |
| `@/components/ui/dialog` | Dialog, DialogPortal, DialogOverlay, DialogClose, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription |
| `@/components/ui/field` | Field, FieldLabel, FieldDescription, FieldError, FieldGroup, FieldLegend, FieldSeparator, FieldSet, FieldContent, FieldTitle |
| `@/components/ui/input` | Input |
| `@/components/ui/label` | Label |
| `@/components/ui/progress` | Progress |
| `@/components/ui/scroll-area` | ScrollArea, ScrollBar |
| `@/components/ui/select` | Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator, SelectScrollUpButton, SelectScrollDownButton |
| `@/components/ui/separator` | Separator |
| `@/components/ui/sheet` | Sheet, SheetPortal, SheetOverlay, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription |
| `@/components/ui/skeleton` | Skeleton |
| `@/components/ui/switch` | Switch |
| `@/components/ui/table` | Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption |
| `@/components/ui/tabs` | Tabs, TabsList, TabsTrigger, TabsContent |
| `@/components/ui/textarea` | Textarea |

## Scope and validation

55 synthetic Vitest/RTL tests cover service roots and malicious paths, request encodings, structured and non-JSON failures, upstream-vs-panel authentication, stale body/session races, no retry, fixture fail-closed behavior, restricted storage, cross-tab changes, concurrent login, and login/navigation/logout. Typecheck/build pass. Build check enforces hashed independent CSS/JS, a manifest dynamic entry, both meta injection markers, and no DEV fixture strings. No production, OAuth, model, real credential/database, Python service, deployment, full backend or cross-browser verification is implied. The foundation changes no Management schema/capability; manager action: `no_counterpart_action`.

The latest frozen shared contract is implemented, including relative asset base and Blob+Response. This task does not edit the coordination contract. Root integration must wire actual page lazy imports, combine deploy owner's ignore/HTML serving changes, and perform final integrated behavior/browser/Legacy gates. Generated ui-dist is a build artifact, not part of this source commit.
