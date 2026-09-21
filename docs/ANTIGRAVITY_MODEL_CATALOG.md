# Antigravity model catalog

Updated: 2026-09-21

The public Antigravity model-list endpoints advertise the intersection of the
current credential's live `fetchAvailableModels` response and the model slugs
documented for Antigravity CLI 1.2.7. Quota details continue to expose every
raw upstream model so operators can inspect and test compatibility and service
models without advertising those IDs to ordinary API clients.

References:

- <https://www.antigravity.google/docs/models/>
- <https://www.antigravity.google/docs/cli/headless/>
- <https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md>
- `mulan777/gcli2api@a7b5c9d` for dynamic upstream discovery behavior

Compatibility notes:

- Existing OpenAI and Gemini model-list response schemas are unchanged.
- Raw, legacy, `tiered`, `chat_*`, `tab_*`, and `*-agent` IDs remain directly
  routable but are not advertised by the public list endpoints.
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
