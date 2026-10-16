# Optional upload byte observation — fixed v1 contract

Capability: `panel.credentials.upload_progress.v1`. This additive panel API does not change Management schema or capabilities and requires no manager action (`no_counterpart_action`). The original `POST /creds/upload` response, multipart parser, import limits and persistence decisions remain authoritative. A received-byte percentage is transport evidence, never proof of credential import or storage success.

All requests below use the same current panel `Authorization: Bearer <panelToken>` and existing `verify_panel_token`. Keep the shared fetch client's `redirect: "error"`. Never use XHR or place the token in query parameters. The progress ID is a 128-bit random nonce (32 lowercase hex characters), not an authorization credential. Knowledge of it never substitutes for authentication and matching owner/mode.

## 1. Discover support

`GET /creds/upload-progress/capabilities` → HTTP 200:

```json
{"capability":"panel.credentials.upload_progress.v1","supported":true,"reason":null,"modes":["geminicli","antigravity"],"ttl_seconds":900,"poll_interval_ms":500}
```

Fields: `capability` is that exact literal; `supported` is boolean; `reason` is null when supported, otherwise `"multi_worker" | "worker_count_invalid" | "single_worker_unconfirmed"`; `modes` is the two supported channel strings; `ttl_seconds` and `poll_interval_ms` are integers. Multiple workers, invalid `WORKERS`, or an external ASGI launcher without confirmed single-worker operation are explicitly unsupported. HTTP 404/405 on an older server also means unavailable; do not invent percentage progress. Authentication failures follow existing auth behavior (HTTP 401 wrong password; the installed HTTPBearer implementation owns missing/malformed authorization behavior).

The normal `python web.py` entrypoint confirms its actual worker count. An artifact preview launcher that directly serves `web.app` may call `from src.panel.upload_progress import confirm_native_single_worker; confirm_native_single_worker(1)` **only when that launcher actually controls a single ASGI server worker in this process**, before serving requests. The confirmation is process-local; it is not a setting, endpoint, environment override or proof from `WORKERS=1` alone. Do not call it from general ASGI module import. `WORKERS` must also be unset or parse to integer 1. Multi-worker/reloader workers or unknown external launchers stay unsupported.

## 2. Create one ticket per upload request

`POST /creds/upload-progress?mode=antigravity` (no body) → HTTP 201, a `Progress` snapshot. `mode` is required and exactly one of `geminicli | antigravity`. Do not send mode in JSON.

```json
{"progress_id":"0123456789abcdef0123456789abcdef","mode":"antigravity","received_bytes":0,"total_bytes":null,"phase":"receiving","http_status":null,"bound":false,"expires_in_seconds":900}
```

The sample ID is documentation only. Each response supplies a fresh actual ID. Creation stores only nonce, mode, monotonic deadline, HMAC owner digest and progress fields. No raw panel token, filename, credential, file bytes, body or upload result is stored/logged by this feature. Tokens are bound by constant-time HMAC digest comparison. Users sharing the same panel password share the same owner identity; this is not a separate browser/user-session authentication system.

## 3. Upload with optional observation

Send the existing multipart request unchanged to `POST /creds/upload?mode=antigravity&progress_id=<ID>`, using the same panel token and matching mode. The optional parameters are query parameters; no multipart progress field or custom body wrapper is required. Never manually set multipart `Content-Type`/`Content-Length` in browser code. Browser/server HTTP supplies framing.

Without `progress_id`, the middleware passes the original scope/receive/send directly through, including its previous authentication order, budgets, exceptions and output. With it, authentication and ticket validation occur before receive. The original route still performs its existing authentication dependency. Invalid or replayed tickets do not run the underlying upload or read the body. These explicit opt-in rejections close an HTTP/1 connection with unread body bytes. Do not automatically retry an upload after an upload request has started: an uncertain outcome is not evidence that persistence did not occur.

## 4. Poll the matching ticket

`GET /creds/upload-progress/<ID>?mode=antigravity` → HTTP 200 `Progress`:

| Field | Type | Exact meaning |
|---|---|---|
| `progress_id` | string | Ticket nonce, 32 lowercase hex characters. |
| `mode` | `"geminicli" \| "antigravity"` | Ticket channel. |
| `received_bytes` | nonnegative integer | Sum of `len(body)` for real ASGI `http.request` messages consumed by the original application/budget layer. Includes multipart boundaries/headers, not just selected file bytes. Counts neither buffered replay nor estimated transmission. |
| `total_bytes` | nonnegative integer or null | A single syntactically valid request `Content-Length`, assigned at binding. Missing, duplicate, malformed, negative or longer-than-15-digit length is null. It is a framing hint, not a budget override. |
| `phase` | `"receiving" \| "processing" \| "finished" \| "interrupted"` | See below. |
| `http_status` | integer or null | Status from an observed successfully sent `http.response.start`; null until observed. An exception handled outside this observation layer may leave null. |
| `bound` | boolean | False before the one upload binds; true permanently after binding. |
| `expires_in_seconds` | nonnegative integer | Ceiling of remaining monotonic TTL; polling/receiving never extends expiry. |

`receiving`: ticket exists; `bound:false` means upload has not bound yet. `bound:true` means waiting for/receiving actual body bytes (possibly waiting for the existing import gate). `processing`: the last ASGI request body message was consumed; server processing/result remains pending. `finished`: final ASGI response body was sent successfully; this includes HTTP errors such as 413/422 and does **not** mean import succeeded. `interrupted`: disconnect, cancellation, receive/send failure or application return without a final response; existing exceptions/cancellation propagate. An already completed response remains finished if later application cleanup raises. This observation cannot prove database rollback or cancellation.

Calculate a bounded percentage only when `total_bytes > 0`, using received bytes divided by that total. `null` or zero total means an indeterminate indicator/byte count; do not divide by zero or use file-size sums as the multipart total. Reaching 100% means body receipt only. Continue to use the actual upload response for item counts/errors and durable results. Progress polling failure, TTL expiry, process restart or unsupported capability must produce progress unavailable/unknown, and must not report upload failure/success or replay it. Stop polling after upload settles, ticket finishes/interrupts/expires, channel/logout change or local UI cleanup. Do not persist the ID/token in storage or log them.

## Errors and cache behavior

New endpoints and explicit progress upload responses send `Cache-Control: no-store`, including normal auth/validation errors. New errors are JSON `{"detail":"<code>"}`:

| HTTP | Code | Applies |
|---|---|---|
| 503 | `upload_progress_unsupported` | Ticket create/read or opt-in upload when capability unsupported. |
| 429 | `upload_progress_capacity` | Ticket create: at most 256 retained tickets process-wide and 8 per owner, including unbound/active/completed tickets. No live-ticket eviction. |
| 404 | `upload_progress_not_found` | Poll: missing, malformed, expired, wrong-owner or wrong-mode ID; same error for all. |
| 409 | `upload_progress_unavailable` | Opt-in upload: missing/malformed/expired/wrong-owner/wrong-mode/replayed ID, or duplicate progress_id query values; same error for all. No existing ticket is altered. |
| 400 | `upload_progress_invalid_mode` | Duplicate mode values on new create/read routes; missing/invalid/duplicate mode on opt-in upload. |
| 422 | standard FastAPI validation detail array | Missing or invalid mode on new create/read routes. |

The capabilities endpoint must be authenticated even when unsupported. New create/read endpoints also authenticate every request. Creation and observation expire after 900 seconds from creation, never extended by polling or traffic. Expired entries are removed during ticket create/read/bind. Requests may complete after observation expires; expiry does not cancel imports. A server process restart forgets tickets and HMAC key. If discovery/ticket creation is unsupported/unavailable before an upload begins, fall back to the original upload without progress_id and display progress unavailable. Never retry the original upload just because a later poll failed.

## Integration and verification boundary

Install `UploadProgressMiddleware` outside the existing `AntigravityUploadMiddleware` and inside CORS. This preserves original budget/multipart order while observing the actual receiver before its bounded buffering/replay. Progress paths use Starlette's `get_route_path` helper, so a service mounted at `/base` is observed at `/base/creds/upload` and `/base/creds/upload-progress` with `root_path=/base`; `/base2` is not incorrectly stripped. The original scope is passed unchanged to downstream middleware/routes. The observer neither buffers/parses/pre-reads body nor changes original successful upload output. `web.py` only imports/installs this module and confirms native single-worker launch. No changes to `creds.py`, authentication core, frontend, dependencies, database schema or existing data are needed.

Candidate-only probes use synthetic ASGI request chunks, synthetic auth strings and a synthetic FastAPI upload target without importing web/lifespan or any database. Their actual results are recorded separately; full suites and production calls are not claimed.
