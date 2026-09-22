# Antigravity model catalog

Updated: 2026-09-21

The public Antigravity model-list endpoints advertise the intersection of the
current credential's live `fetchAvailableModels` response and the model slugs
documented for Antigravity CLI 1.2.7. Quota details continue to expose every
raw upstream model so operators can inspect and test compatibility and service
models without advertising those IDs to ordinary API clients. Each raw quota
entry also has presentation-only `visible`, `availability`, and optional
`badge` metadata. This metadata never changes the raw response, model routing,
or public model-list contract.

References:

- <https://www.antigravity.google/docs/models/>
- <https://www.antigravity.google/docs/cli/headless/>
- <https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md>
- `mulan777/gcli2api@a7b5c9d` for dynamic upstream discovery behavior

Compatibility notes:

- Existing OpenAI and Gemini model-list response schemas are unchanged.
- Raw, legacy, `tiered`, `chat_*`, `tab_*`, and `*-agent` IDs remain directly
  routable but are not advertised by the public list endpoints.
- The quota panel filters only entries with `visible: false`; raw quota API
  responses still include them. `chat_20706`, `chat_23310`,
  `tab_flash_lite_preview`, `tab_jump_flash_lite_preview`, `gemini-2.5-pro`,
  `gemini-3-flash-agent`, `gemini-3.5-flash-extra-low`,
  and `gemini-3.5-flash-low` are currently hidden as unavailable.
- `gemini-3.5-flash-lite` remains visible because the corrected native route
  returned the exact strict probe marker during live validation.
- `gemini-3.1-flash-image` remains visible as a normal internal/compatibility
  model because the latest live probe returned the exact strict marker.
- `gemini-3-flash` remains a visible, directly routable quota model without an
  internal/compatibility badge. It is intentionally not added to the public
  `/antigravity/v1/models` or `/antigravity/v1beta/models` catalog.
- Bare Gemini family names and Claude/GPT compatibility names are normalized
  to current upstream IDs at the Antigravity route boundary.
- The public `gemini-3.1-pro-high` slug uses the current
  `gemini-pro-agent` service route. GPT-OSS requests omit Gemini-only safety,
  `topK`, and thinking fields that its route rejects.
- `/management/v1` remains schema 1.4 with an unchanged capability list.
- No database migration or manager-side action is required.

Live validation can be run without modifying the source database:

```powershell
python scripts/validate_antigravity_model_catalog.py `
  --source-db C:\path\to\credentials.db `
  --port 7862
```

The validator opens the source SQLite database read-only, copies one enabled
Pro credential to a temporary SQLite database, uses a random local API
password, suppresses service logs, reports only model/status/timing metadata,
and deletes the temporary database after stopping the candidate service.

To probe every live raw model concurrently with strict semantic validation:

```powershell
python scripts/validate_antigravity_model_catalog.py `
  --source-db C:\path\to\credentials.db `
  --all-models --workers 6
```

Each probe asks the model to reply only `测试成功`. HTTP 2xx, non-empty
reasoning, or a retirement/migration notice does not pass unless the final
answer matches that marker. The panel's per-model test uses the same rule and
returns HTTP 424 with a short reply preview when an upstream HTTP 200 contains
an unavailable-model notice.

`--live-url http://127.0.0.1:7861` sends the probes through the running
gcli2api service and therefore updates its normal SQLite usage statistics.
The dashboard counts upstream attempts rather than only final client
responses, so retries can make the statistics delta larger than the number of
logical probes. Isolated validation remains the safe default because failed
internal models cannot change production credential health state.
