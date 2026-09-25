# DIAG-02 HTTP header inventory

Baseline: `1f65d3ec10830245f22a58691e124c5129f75707`.

| Boundary | Actual input / target | Order and redirects |
| --- | --- | --- |
| `src/router/antigravity/{gemini,openai,anthropic}.py` | Calls `stream_request` / `non_stream_request` with body and mode; **no inbound headers argument** | No automatic inbound header copy; no source filter change warranted |
| `src/api/antigravity.py:build_antigravity_headers` | Explicit optional `extra_headers`; constructs authorization, content type, UA and requestType for configured Antigravity URL | Existing trace whitelist retained; credential retries update authorization and project, retain explicit headers |
| `src/httpx_client.py:get_async/post_async/stream_post_async` | Explicit caller headers, OAuth/metadata/provider/model calls | httpx builds per-request headers, runs caller request hooks, then diagnostic final boundary; existing redirect policy retained |
| `src/api/geminicli.py` | Explicit optional headers update; model routes do not automatically copy inbound headers | Shared HTTP observation only; no GeminiCLI business modifications |
| `src/api/vertex.py`, `src/google_oauth_api.py`, panel calls | Explicit business/auth headers | Shared helper calls observed; clients built outside helper are not covered |
| `src/api/antigravity.py` and `src/httpx_client.py` response construction | Upstream headers copied into local error/nonstream Response | Pure ASGI response commit strips all upstream X-Diag-* and sets exactly two local IDs; old X-Request-Id/X-Trace-Id untouched |

Repository search found no automatic inbound-to-outbound copying source in these
paths. Merely accepting explicit headers is not proof of an automatic copy.

Implementation uses a private httpx client subclass, not a transport replacement.
The final send boundary clones the request, checks its normalized actual URL and
escaped target, creates a separate call, and retains ownership only in local
request extensions. Redirect construction uses the actual sent request copy,
preserves httpx's redirect/auth/cookie rules, and removes diagnostic-owned fields
before the next request hooks. Each actual redirect has a new call span.
Explicit new-hop business trace headers survive nonpeer sends. No value-based
ownership inference and no mutation of client-global headers.

Contract copied byte-for-byte from CLIProxyAPI commit
`bb291667f7b6bd7a1dab6f9b7f906b5871d1306c`; artifact `1.0.0-rc.1`;
SHA256SUMS SHA-256:
`ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4`.
