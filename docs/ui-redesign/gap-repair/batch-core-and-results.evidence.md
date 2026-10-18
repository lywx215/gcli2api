# Controlled public contract evidence: batch core and results

Prepared from current W on 2026-10-15. Static source evidence only; no tests, CLI, APIs, credentials or models were accessed. Root stages this at docs/ui-redesign/gap-repair/batch-core-and-results.evidence.md. Source code below is backend/legacy public response evidence, not new frontend sample code. Raw upstream text in the legacy behavior is NOT an authorization to expose it.

## Confirmed recheck scope

- R01: 批量额度未保留服务端“未开始”和自动停止条件. 服务端started:false项目被标completed；预算配置异常或多数quota_queue_full后仍启动尚未发送的后续块，区别于已修复的用户停止按钮。

- R02: 单份与批量检验/测试/Preview结果详情丢失. 单份项目ID/订阅等级/积分、Preview设置与绑定ID/失败步骤、批量冷却变更/Opus汇总/失败原因未进入安全DTO或视图；仅成功/HTTP/写回徽章不能替代旧结果。

- R03: 旧GCLI默认消息测试流程没有原生入口. 新单项/批量强制填写并发送model；后端据此跳过旧默认消息测试中的Preview二次探测。独立配置Preview是另一操作。

- R04: 批量额度写回pending后缺少一次延迟状态补刷. 只有立即onRefresh；后台稍后结算后用户需自行刷新。旧页pending后30秒只补读一次缓存列表，不重复额度查询。

## Producer and legacy excerpts

### src/panel/antigravity_manual.py:82-87
Source file SHA-256: 7a6b452ce9e8106cc4f5b6b5e7c8862699e889546bf60043cc12ab83038c424a
```text
82: def quota_error(filename, code, phase, *, started=False, pending=False):
83:     return {"filename": filename, "success": False, "status_code": 504 if code == "quota_timeout" else 503,
84:             "upstream_status": None, "response_source": "local", "error_code": code,
85:             "phase": phase, "started": started, "error": "Quota query could not complete.",
86:             "state_update": {phase: {"status": "pending", "reason": "settlement_unconfirmed"}} if pending else {},
87:             "cleared": [], "added": []}
```

### src/panel/antigravity_manual.py:311-321
Source file SHA-256: 7a6b452ce9e8106cc4f5b6b5e7c8862699e889546bf60043cc12ab83038c424a
```text
311:         pending = isinstance(exc, SettlementPending)
312:         if result is not None and result.get("upstream_status") is not None:
313:             result.update(error_code=exc.code, phase=exc.phase, started=started)
314:             update = {"status": "pending" if pending else "skipped",
315:                       "reason": "settlement_unconfirmed" if pending else exc.code}
316:             result.setdefault("state_update", {})[exc.phase] = update
317:             if exc.phase == "model_access":
318:                 result["model_access_update"] = update
319:             result.setdefault("cleared", [])
320:             result.setdefault("added", [])
321:             return result
```

### src/panel/antigravity_manual.py:353-355
Source file SHA-256: 7a6b452ce9e8106cc4f5b6b5e7c8862699e889546bf60043cc12ab83038c424a
```text
353:     success = isinstance(project_id, str) and bool(project_id.strip())
354:     result = {"filename": filename, "success": success, "project_id": project_id,
355:               "subscription_tier": tier, "credit_amount": credit, "upstream_status": status,
```

### src/panel/creds.py:2530-2535
Source file SHA-256: 2f6056f3d802776809a54eb379b691d8800cdc455f442c599d8fb90977dc7ec8
```text
2530:                     "filename": filename,
2531:                     "preview": False,
2532:                     "message": f"创建 Release Channel Setting 失败: HTTP {setting_status}",
2533:                     "error": error_text,
2534:                     "step": "create_setting"
2535:                 }
```

### src/panel/creds.py:2560-2570
Source file SHA-256: 2f6056f3d802776809a54eb379b691d8800cdc455f442c599d8fb90977dc7ec8
```text
2560:             return JSONResponse(content={
2561:                 "success": True,
2562:                 "filename": filename,
2563:                 "preview": True,
2564:                 "message": "Preview 通道配置成功，已将 preview 属性设置为 true",
2565:                 "setting_id": setting_id,
2566:                 "binding_id": binding_id,
2567:                 "state_update": {"preview": {"status": "applied"} if saved is True else
2568:                                  {"status": "failed", "reason": "state_update_failed"}},
2569:             })
2570:         elif binding_status == 409:
```

### src/panel/creds.py:2595-2600
Source file SHA-256: 2f6056f3d802776809a54eb379b691d8800cdc455f442c599d8fb90977dc7ec8
```text
2595:                     "filename": filename,
2596:                     "preview": False,
2597:                     "message": f"创建 Setting Binding 失败: HTTP {binding_status}",
2598:                     "error": error_text,
2599:                     "step": "create_binding"
2600:                 }
```

### src/panel/creds.py:2736-2740
Source file SHA-256: 2f6056f3d802776809a54eb379b691d8800cdc455f442c599d8fb90977dc7ec8
```text
2736:         # 使用指定的模型或默认模型
2737:         test_model = model if model else "gemini-2.5-flash"
2738:         # 如果指定了具体模型，则跳过后续的 preview 模型测试
2739:         skip_preview_test = model is not None
2740:         strict_antigravity_model_test = mode == "antigravity" and model is not None
```

### src/panel/creds.py:2923-2926
Source file SHA-256: 2f6056f3d802776809a54eb379b691d8800cdc455f442c599d8fb90977dc7ec8
```text
2923:                 # 如果是 geminicli 模式且第一次测试成功，继续测试 gemini-3-flash-preview（仅在未指定具体模型时）
2924:                 if mode == "geminicli" and not skip_preview_test:
2925:                     preview_model = "gemini-3-flash-preview"
2926:                     log.info(f"开始测试 preview 模型: {'[credential]' if mode == 'antigravity' else filename} (model={preview_model})")
```

### front/common.js:3123-3135
Source file SHA-256: 7def66a5144c1f829d3d3b59389e691ef55198b8d90e84a4b41fd8d4abf826ed
```text
3123:                     malformed = true;
3124:                     continue;
3125:                 }
3126:                 const outcome = result.started === false ? 'unexecuted' : (result.success ? 'success' : 'failure');
3127:                 batch.items.set(filename, {outcome, result});
3128:                 if (result.error_code === 'quota_queue_full') queueFull++;
3129:                 if (result.error_code === 'quota_budget_configuration') configuration = true;
3130:             }
3131:             if (configuration) batch.stopReason = '额度预算配置异常，已停止后续批次';
3132:             else if (queueFull * 2 >= group.length) batch.stopReason = '服务端队列繁忙，已停止后续批次';
3133:             else if (malformed) batch.stopReason = '逐项结果不完整，已停止后续批次';
3134:             renderAntigravityQuotaBatch(batch);
3135:         }
```

### front/common.js:3150-3158
Source file SHA-256: 7def66a5144c1f829d3d3b59389e691ef55198b8d90e84a4b41fd8d4abf826ed
```text
3150:             // must not overwrite the persistent progress/result region.
3151:             Promise.resolve(manager.refresh({afterMutation: true, silent: true})).catch(() => {});
3152:             if (counts.pending) {
3153:                 manager.quotaBatchFollowupTimer = setTimeout(() => {
3154:                     if (!current()) return;
3155:                     manager.quotaBatchFollowupTimer = null;
3156:                     Promise.resolve(manager.refresh({afterMutation: true, silent: true})).catch(() => {});
3157:                 }, 30000);
3158:             }
```

### front/common.js:3293-3298
Source file SHA-256: 7def66a5144c1f829d3d3b59389e691ef55198b8d90e84a4b41fd8d4abf826ed
```text
3293: function modelAccessStatus(families, family, now = Date.now() / 1000) {
3294:     const entry = families?.[family] || {};
3295:     const checked = entry.checked_at;
3296:     if (entry.state === 'supported' && Number.isFinite(checked) && checked <= now && now < checked + 43200) return 'supported';
3297:     return entry.state === 'unavailable' ? 'unavailable' : 'unknown';
3298: }
```

## Additional public field and consumer facts
- front/common.js:3026-3060 summarizes cleared/added or added_cooldown arrays, affected credential counts, two known Opus families with effective state, pending/incomplete writeback counts and individual result descriptions. Count only validated returned evidence; missing is unknown. The newer display must use safe reasons, not legacy arbitrary error/message text.
- front/common.js:3201-3213 exposes per-model cleared, added_cooldown, skipped_no_quota and skipped_unknown. front/common.js:4024-4030 and 4103-4109 expose project ID/credit/status; 4188-4195 expose Preview result/failure step.
- src/panel/creds.py:3091 default batch-test submits no model. Explicit model presence makes skip_preview_test true, even when that string equals the default. On omitted-model successful GCLI default testing, existing backend follows the Preview probe. Restoring this UI choice does not authorize an actual model request during implementation verification.
- src/panel/creds.py:2216-2222 returns AG quota per-row results. quota_budget_configuration and quota_queue_full can be ordinary valid result rows with started=false; HTTP transport success cannot establish row execution.
- src/panel/antigravity_manual.py:313-320 may report pending under the actual phase (including quota_sync or model_access). The old batch writeback-name allowlist is too narrow for reliable pending detection; compute the bounded pending bit without exposing an arbitrary key or value.
- frontend/src/pages/credentials/model.ts:175-178 currently creates ManualResult with the original data object, success, httpStatus, upstreamStatus, verifiedReply and updates. Keep data and semantics intact; publicDetails is presentation-only.
- frontend/src/pages/credentials/index.tsx:318-342 captured createToolRefresh checks the current reservation/owner then calls c.refresh. useCredentials refresh clears/reloads the saved creds/status list. Reuse this onRefresh; do not call the legacy quota endpoint from a timer.
- frontend/src/pages/credentials/CredentialDetail.tsx:290-299 stores the original ManualResult in AgQuotaEvidenceReceipt with source=response, filename, scope and exact validation. AgQuotaEvidence gates release on original identity, source=response, success and current ownership; saved, batch and display-only projections cannot substitute.
- frontend/src/pages/credentials/advancedApi.ts configurePreview presently rejects a sanitized ApiError on non-2xx; its raw payload is removed. Preserve this rejection contract. The additive branded failure-receipt extractor allows later Detail and current Batch display without exposing raw error bodies.
- Existing CredentialBatchPanel.test.tsx explicitly exercises two quota requests in flight and one later pending chunk; keep max-two behavior. Its no-pending settlement refresh expectation remains one; the new pending-only delayed GET is an authorized behavioral addition, not permission to weaken existing owner/Stop tests.

## Evidence integrity
FUNCTIONAL_RECHECK.json SHA-256: 26a5be3c52aa66446238c2d6c690bacf946c2e694fea045b157d347ea88c21a2
credentials-audit.md SHA-256: acaf79fce1e6a29eff75a3242323ff529591bec912f61f5e1ecb326d25ec2ca4
detail-quota-audit.md SHA-256: bd2895342960179cf7bca6f2274aa50bb5a3c1f3173c8cf36e3ca1ddedd5030b
