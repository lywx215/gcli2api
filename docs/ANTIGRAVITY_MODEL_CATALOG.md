# Antigravity model catalog

Updated: 2026-10-03

The public Antigravity model-list endpoints advertise the intersection of the
current credential's live `fetchAvailableModels` response and the project's
current canonical model catalog. Opus 5.5 uses the `low`, `medium`, and `high`
IDs returned directly by Google's official endpoint on 2026-10-03; see
[Opus 5.5 evidence and compatibility](ANTIGRAVITY_OPUS_55.md).
Quota details continue to expose every
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
  routable but are not advertised by the public list endpoints, except for
  explicitly rejected models such as Opus 4.6.
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
- Bare `claude-opus-5-5` defaults to `claude-opus-5-5-medium`; explicit Opus
  5.5 `low`, `medium`, and `high` IDs preserve their requested effort tier.
  Opus 4.6 requests return local HTTP 400 without an upstream request or a
  redirect to 5.5. Opus 4.6 is absent from public lists and hidden in the quota
  panel; raw quota API entries and historical cooldown/statistics remain intact.
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

To validate only the three Opus 5.5 effort IDs, once each without automatic
generation retries, add `--models claude-opus-5-5-low claude-opus-5-5-medium
claude-opus-5-5-high --workers 1`. This exact selection is mutually exclusive
with family/all-model selection and cannot be combined with `--live-url`.
Every requested ID must be present in the current public list before any
generation is dispatched. See the linked Opus 5.5 evidence for the current
validation status.

To probe every live raw model concurrently with strict semantic validation:

```powershell
python scripts/validate_antigravity_model_catalog.py `
  --source-db C:\path\to\credentials.db `
  --all-models --workers 6
```

Each probe asks the model to reply only `测试成功`. HTTP 2xx, non-empty
reasoning, or a retirement/migration notice does not pass unless the final
answer matches that marker. The panel's per-model test uses the same rule and
preserves Google HTTP 200 with success=false and a fixed English error when
the reply fails validation or contains a known retirement notice. It does not
return a raw reply preview on failure; verified_reply and state_update describe
validation and persistence separately.

`--live-url http://127.0.0.1:7861` sends the probes through the running
gcli2api service and therefore updates its normal SQLite usage statistics.
The dashboard counts upstream attempts rather than only final client
responses, so retries can make the statistics delta larger than the number of
logical probes. Isolated validation remains the safe default because failed
internal models cannot change production credential health state.

## Manual quota sampling and recovery

Antigravity panel tests dispatch with the selected credential regardless of local
cooldowns, quota-group blocks or disabled flags. Success may restore that quota
group, but never enables a disabled credential. Quota reads use the Google quota
response to restore scheduling without extra generation probes. Unknown returned
quota entries preserve state; explicit zero takes precedence over positive values.

Both diagnostic scripts use the authenticated panel quota endpoint. Sampling can
therefore clear cooldowns, release blocks and update manual override revisions.
The measurement script targets its running service; catalog validation defaults
to a temporary instance but `--live-url` changes the specified running service.
Read-only source SQLite access does not make these HTTP operations read-only.
Measurements include manual recovery effects and cannot establish admission
behavior under the original cooldown/block state. The existing `models` and
`quota_group_states` response fields and diagnostic protocol remain unchanged.
