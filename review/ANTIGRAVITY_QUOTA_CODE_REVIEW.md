# Antigravity 额度保护：Claude 代码审核

用户于 2026-09-27 明确授权代码审核。本组最多 3 轮，使用本机共享 `C:/Users/lywx2/.codex/review/hook.py` 的 `ask_claude` 入口和实际 `claude-opus-5-5`；只读工具 Read/Glob/Grep。此前三轮方案审核不算作本次代码批准。

**最新结论：用户授权继续后的第二组第 3 轮（累计代码第 6 轮）返回 `findings=[]`，代码审核通过。** 以下逐轮保留历史发现、修复和当时状态。最终测试结果见文末。

## 第 1 轮

代码快照摘要：`4c875a94d54ec2f072db26fed4530f1cdaff8af998c5b055ceee240c5da7d342`。Claude 返回 **8 项 findings**。

### 1. `src/storage/antigravity_quota.py`

Lines 324-327, quota_sync: if any model in a group matches rolling_week, the code calls observe_week and then `continue`, so it skips the zero-remaining branch for that same group. Example: one gemini model shows a rolling 168h reset while another shows remaining=0 with a real 41h reset. Only the unknown block is written; the 41h timed cooldown is never persisted. Once an admin runs release_quota_group, the group becomes manual_override with no timed cooldown and is admitted again, even though quota exhaustion was known. This breaks plan items 3 (exhaustion takes priority) and 6 (release keeps timed cooldowns). Fix: write the explicit zero/reset timers in the same transaction, in addition to observe_week.

### 2. `src/storage/antigravity_quota.py`

Lines 272-276, quota_record_result: error_codes and the explicit quota cooldown are only written when `same_revision` is true. The revision changes whenever another actor makes a policy transition. Examples: a concurrent request's 429 re-blocks manual_override and bumps the revision, or a sync creates a new blocked_unknown state (revision 0→1 in observe_week). In those cases an in-flight request's real QUOTA_EXHAUSTED 429 with a valid reset is silently dropped. After the next admin release, no timed cooldown exists and the credential is admitted despite a known exhausted quota. The revision fence should only guard the override/re-block transition. The timed cooldown should always go through prepare_antigravity_cooldown, which never shortens, as long as the generation matches (plan items 6: explicit quota can write timed cooldowns; release keeps timed cooldowns).

### 3. `src/api/antigravity.py`

Lines 573-577 (stream) and 907-911 (non-stream): when quota_admit returns None, the whole request ends immediately with local '当前无可用凭证' instead of excluding that candidate and trying another. This is reached in normal concurrency. The retry prefetch at ~633-639 calls get_valid_credential before record_api_call_error writes the group cooldown or re-block, so the prefetched candidate can be the same credential. Admission then rejects it and the user gets a 500/LOCAL503 while other credentials are free. A capacity cooling check inside quota_admit has the same effect. Plan item 7 says selection is only a filter and admission is authoritative; a stale candidate should be skipped, and the request should end only when no candidates remain.

### 4. `src/storage/antigravity_quota.py`

Lines 195-228, get_next_available_credential: it runs a full _quota_atomic write transaction for every candidate returned by list_credentials, which includes disabled ones: BEGIN IMMEDIATE on SQLite, SELECT ... FOR UPDATE on PostgreSQL/MySQL, a CAS update_one on Mongo. With a pool of many disabled or cooling credentials, each request takes up to N serialized write locks before it finds a candidate. On SQLite this puts every concurrent request behind a single writer lock with a 30s timeout. On Mongo, the CAS compares every counter field (success_count, call_count, cycle_stats, ...), so selection, admission and settlement all invalidate each other on hot credentials. After 32 misses it raises quota_state_contention, which record_api_call_result turns into a LOCAL 503. Selection filtering should be a read-only query; only the final admission and settlement need the locked or CAS transaction.

### 5. `src/credential_manager.py`

Line 368 together with src/api/antigravity.py:924-927 and 1044-1046: if the storage settlement fails after the response has already passed validate_json, record_api_call_result raises ModelApiErrorException(LOCAL 503). The non-stream handler catches it and returns build_error_response('Invalid upstream response', 502). So a fully valid upstream answer is thrown away and reported to the client as an upstream format error, under a LOCAL origin with contradictory text. Combined with the Mongo CAS contention above, this can turn valid responses into errors under load. A settlement or storage failure should not be presented as an invalid upstream response.

### 6. `src/antigravity_completion.py`

Line 107, Completion.finish: every candidate must have effective content, and only promptFeedback.blockReason is exempt. A candidate that ends with finishReason SAFETY, RECITATION, PROHIBITED_CONTENT or similar and has no parts is a legitimate filtered completion. It is now reported as BAD_FORMAT (502), and the stream is not retried. Before this change it reached the converters as a content-filter finish. Plan item 8 keeps legal block semantics, and these terminals are even listed in TERMINALS. No test covers an empty candidate with a SAFETY or RECITATION finish (tests only cover promptFeedback).

### 7. `src/storage/antigravity_quota.py`

Lines 161-167, quota_refresh_credential: the refresh write is fenced only by quota_credential_generation. Overwriting a credential under the same name deliberately keeps the generation (store_credential plus storage_adapter.quota_snapshot). An in-flight token refresh that started before the admin overwrite (credential_manager.py:506, panel _save_refreshed_quota_credential) therefore passes the fence. It replaces the newly uploaded credential_data with the refreshed tokens of the old credential JSON. This contradicts the claim in docs/ANTIGRAVITY_QUOTA_PROTECTION.md:57 that old refreshes cannot overwrite new state. The refresh needs a content or version fence, for example comparing the refresh_token or a stored credential revision, not just the generation.

### 8. `src/storage_adapter.py`

Lines 228-289: store_credential and get_credential_state (mode=antigravity) now call quota_snapshot unconditionally. _decode raises InvalidQuotaState for any malformed model_cooldowns value or quota state. store_credential then raises after the row is already written, so the upload reports failure even though the data was stored. get_credential_state raises for that credential, which breaks the panel detail and management state reads. quota_release goes through the same _decode, so the admin cannot repair or release the row either. Plan item 7 only allows skipping a bad candidate during selection. Control-plane reads and writes should degrade instead of failing.

## 第 1 轮修复核对

1. 同组动态 168h 与真实零额度并存时，在一个事务中同时保存异常拦截和非异常零额度的计时冷却；动态占位时间仍不作为期限。
2. revision 只保护 override 重拦和旧错误摘要；同一代次返回的明确额度冷却仍按组最长写入，不因并发 revision 变化丢失。
3. 最终准入拒绝候选后排除它并重新选择，直到候选耗尽；该过程不消耗上游尝试次数，SMART 关闭也保留本地排除集。
4. 选择与已有代次的快照改为只读查询，过滤禁用行；只有旧行缺 UUID 时做一次初始化。Mongo 准入 CAS 只比较策略/身份/启用字段，不比较使用量计数，统计写入不再无意义地冲突准入。
5. 结算失败仍明确返回本地 503，不能包装成上游 BAD_FORMAT/502；不把未完成记账宣称为成功。
6. SAFETY/RECITATION 等合法过滤终态允许空 candidate，保留过滤语义；普通 STOP 空内容仍拒绝。
7. Token 刷新增加内部凭证内容版本 CAS，既有 UUID 不变时的同名覆盖也不会被旧刷新覆盖。内部版本不写入 Token JSON，不返回面板状态。
8. 上传后的 UUID 初始化与损坏策略校验解耦；控制读取返回 quota_state_invalid/unavailable 标识，不隐式解除限制。对损坏状态的普通解除明确返回 409，要求修复；不自动丢弃不可解释的冷却数据。管理员仍可用既有禁用/删除重建操作处理，普通启用不能绕过准入。

新增复现测试 `test_antigravity_review_regressions.py`：15 passed；已有额度/后端/完整性相关测试：100 passed。第 1 轮修复后全量：1522 passed、1 skipped、6 warnings（143.54 秒）。

第 1 轮状态：已核对并修复后提交第 2 轮，不能单独视为最终通过。

## 第 2 轮

代码快照摘要：`001546925c50309e74edddeb84dc149cb95515b896bdfea73e4f0300446ad5d1`。Claude 返回 **4 项 findings**。

### 1. `src/storage/antigravity_quota.py`

Lines 67 and 74-76 (new read-only selection from fix 4): the WHERE clause is `COALESCE(disabled, FALSE) = FALSE`, but `antigravity_credentials.disabled` is `INTEGER DEFAULT 0` on PostgreSQL (src/storage/psql_manager.py:174). PostgreSQL raises 'COALESCE types integer and boolean cannot be matched', so every `_quota_rows()` call fails there. get_next_available_credential then raises, and get_valid_credential (credential_manager.py:110-114) turns that into None. Result: on PostgreSQL, every Antigravity model request reports 'no credential available'. SQLite/MySQL accept the expression, and PostgreSQL is only tested with a driver double, so the tests do not catch this. Use `COALESCE(disabled, 0) = 0`, or skip the SQL filter and rely on the Python check at line 269.

### 2. `src/storage/antigravity_quota.py`

Lines 422-424, quota_sync early clear on MongoDB: `required` adds the stored model_cooldowns keys, but on Mongo those keys are escaped (`_quota_cooldown` line 373 stores 'gemini-3.1-pro' as 'gemini-3-1-pro'). `entries` holds the unescaped upstream names, so `required <= entries.keys()` is always false whenever an active cooldown key contains a dot. A trusted, complete, all-positive snapshot therefore never clears the group on Mongo, even though SQL backends clear it. This fails plan item 3 for four-backend parity. Compare using escaped names on Mongo, or normalize both sides.

### 3. `src/credential_manager.py`

Lines 505-511 with 125-138 (regression from fix 7): the new content-version CAS makes every concurrent token refresh except the first fail. When N requests pick the same expired credential, all N call Google refresh successfully. Only the first quota_refresh_credential write matches expected_version; the others return None, discard their valid new access token, and get_valid_credential adds that healthy credential to `excluded`. On a small pool (for example one credential), these concurrent requests get LOCAL 'no credential available' 500/503. The old last-write-wins path succeeded. When the CAS fails but the generation still matches, re-read the row and use the stored (already refreshed) token, or keep the in-memory refreshed token for this attempt, instead of treating it as a refresh failure. The CAS should only reject a real overwrite or rebuild.

### 4. `src/antigravity_completion.py`

Lines 14-15 and 112 (fix 6 is incomplete): only the FILTERED_TERMINALS set may end with an empty candidate. Gemini also returns legitimate content-less terminals: MALFORMED_FUNCTION_CALL (the common case when tool-call generation fails), UNEXPECTED_TOOL_CALL, TOO_MANY_TOOL_CALLS, NO_IMAGE, LANGUAGE and OTHER. These are all in TERMINALS but still fail finish() and become BAD_FORMAT 502, with no retry. The converters used to receive them as real finish reasons, so this changes upstream semantics (plan item 8: keep legitimate terminal semantics). Allow these explicit non-STOP/non-MAX_TOKENS terminals to have an empty candidate too. Keep rejecting an empty STOP, an empty MAX_TOKENS, and thought-only output. Add tests for an empty MALFORMED_FUNCTION_CALL candidate in both stream and non-stream paths.

## 第 2 轮修复及验证

1. PostgreSQL 整数 disabled 列使用 `COALESCE(disabled, 0) = 0`；驱动替身新增整数列 SQL 不得混用布尔的断言。真实 PostgreSQL 仍未连接，迁移演练门禁不变。
2. Mongo 完整快照覆盖检查在存储转义命名空间比较；要求发生名字碰撞的每一项都为合法正值，避免误清。
3. 并发刷新 CAS 输家重新读取同代次权威凭证，已有新鲜 Token 就返回它；不覆盖持久数据，不把正常并发刷新当成失效。面板额度刷新也复用这一结果；代次已变化或仍过期则拒绝。
4. 明确非 STOP/MAX_TOKENS 终态允许空候选，保留工具生成失败、语言、无图像等原有语义；仅思考输出仍拒绝。新增流式/非流式 MALFORMED_FUNCTION_CALL 验证。

针对性审核复现测试累计 25 项通过；配合额度后端、完整性、边界共 98 项通过。第 2 轮修复后全量回归：1532 passed、1 skipped、6 warnings（141.71 秒）。

## 第 3 轮

代码快照摘要：`b7b5f2ddf85953662d4866606042f851eea39395dd61ef497aa7292d463bd6fd`。实际 Claude 返回 **2 项 findings**；原始结果保存在 `.codex/claude-quota-code-round-3.json`，前两轮对应 round-1/round-2 文件。

### 1. 同名覆盖后旧请求仍可能自动禁用新内容：确认并修复

Claude 指出 `quota_disable` 只比较 UUID，而覆盖导入会保留 UUID。管理员换入新凭证后，旧请求的缺 refresh_token、永久刷新失败或业务 403 仍能将新内容禁用。

修复：四后端的自动禁用在同一事务中同时比较 UUID 与凭证内容版本；业务请求票据携带内部内容版本，刷新失败路径使用选取时版本。最终准入同时核对选取时版本，避免旧预取 Token 获得新内容的票据。正常刷新保存后更新内部版本，并发刷新输家使用已保存赢家的版本。

新增回归覆盖：SQLite 上旧业务 403、缺刷新令牌、永久刷新失败不能禁用覆盖后的内容；三个远端驱动替身检查同样的事务条件；新内容本身仍可被合法自动禁用；正常并发刷新返回的两个凭证都可通过最终准入。针对性审核复现累计 31 项，联合额度边界/后端/完整性共 104 项通过。

### 2. 仅思考加失败终态是否保留：按用户决定不采纳

Claude 建议仅思考输出若以 MALFORMED_FUNCTION_CALL、SAFETY 等明确失败终态结束，应保留上游终态。该建议与原方案“仅思考返回 BAD_FORMAT”存在冲突。

用户明确选择：**“沿用原方案：仅思考仍返回 BAD_FORMAT”。** 因此不采纳这一修改建议；STOP、MAX_TOKENS、MALFORMED_FUNCTION_CALL、SAFETY 的仅思考回归均保持拒绝。没有思考、没有正文的合法非成功终态仍保留原语义。此项属于已确认的产品规则，不伪称 Claude 已接受这一决定。

## 第一组结束时的审核状态

本组已完成 3 轮实际 Claude 代码审核。确认的代码问题已修复；最后的修复在第 3 轮之后完成，**尚未再次经过 Claude 审核，不能标记代码最终审核通过**。第 3 轮的第二项建议按用户明确决定保留原规则。

仓库 `AGENTS.md` 规定：“方案和代码审核合计最多自动执行3轮”，达到上限后“只有用户发送 `继续 Claude 审核` 才能继续下一组审核”。本组未发起第 4 轮。

最后修复后完整回归：**1538 passed、1 skipped、6 warnings，113.30 秒**。输出保存在 `C:/Users/lywx2/AppData/Local/Temp/antigravity-claude-round3-full.txt`。唯一跳过项为 Windows 不支持的 POSIX fork；警告为现有 Pydantic/Starlette 弃用提示。Python 编译、前端 JS 语法和 `git diff --check` 均通过。

所有验证只使用合成凭证、临时 SQLite、驱动替身与本机假上游；未执行真实额度查询、模型调用、生产迁移或部署。真实 PostgreSQL/MySQL/MongoDB 迁移与故障演练、线上面板人工验收仍待发布前执行。

## 第二组第 1 轮（累计第 4 轮）

用户明确发送“继续 Claude 审核”，授权下一组最多 3 轮。实际 `claude-opus-5-5` 审核快照 `8f97f4378790de8caf9a152a588bf1fbae16c53a5069c9a606d1f8edad06986f` 返回 2 项发现；原始记录 `.codex/claude-quota-code-round-4.json`。

1. `src/panel/creds.py` 的项目校验入口在刷新 Token 和查询项目后，仍用无版本条件的 `store_credential`，可能覆盖期间同名导入的新凭证。
2. `src/credential_manager.py` 的邮箱查询入口也会无条件保存刷新后的旧 JSON，存在相同窗口。

两项均确认并修复。Antigravity 控制调用在读取凭证前捕获代次/内容版本；项目校验在最终事务同时保存凭证、套餐、启用状态和错误码，内容变化则返回 409。邮箱刷新使用版本条件保存，查询邮箱后的缓存写入再次核对版本，失败则不写。共享四后端事务增加受限的控制状态字段，防止 Token 已防护但关联邮箱/套餐仍晚到覆盖。Gemini CLI 原写入路径保留。

新增 9 项回归覆盖刷新/项目查询/邮箱查询期间覆盖导入、正常保存和三个远端驱动替身的状态事务。审核复现累计 40 项，联合边界和后端共 79 项通过。修复后完整回归：1547 passed、1 skipped、6 warnings，156.09 秒（`C:/Users/lywx2/AppData/Local/Temp/antigravity-claude-round4-full.txt`）。

## 第二组第 2 轮（累计第 5 轮）

实际 Claude 审核快照 `730a21100c2cf720d743f1957ec3f5784dcf1f7e5c0cef9efd3c11e309409a49` 返回 1 项发现；原始记录 `.codex/claude-quota-code-round-5.json`。

Claude 指出两个新控制面入口使用严格 quota_snapshot/quota_refresh 校验，额度状态损坏时会阻止项目校验及邮箱查询，而这些操作不依赖额度策略。

确认并修复：新增内部 `quota_credential_fence`，只读取代次与凭证内容版本，不解析额度状态；项目校验和邮箱查询使用该方法。条件刷新/控制元数据事务使用 `validate=False`，仍核对代次和内容版本，只保存白名单字段，不修改原始损坏额度数据。模型选择和准入仍严格校验，不能借控制面恢复准入。

新增 7 项回归覆盖两个入口分别遇到损坏组状态/冷却数据，以及三个远端后端驱动替身。审核复现累计 47 项，联合边界和后端共 86 项通过。修复后提交本组第 3 轮复审。

## 第二组第 3 轮（累计第 6 轮）：通过

实际 `claude-opus-5-5` 返回 **`findings=[]`**。审核快照：`a06c29d37b76169be2baab04b78894a9ace6b4e8a9c9fe0b91d357d160e2f049`。原始结构化结果：`.codex/claude-quota-code-round-6.json`。审核包含当前 46 个交付文件、要求及完整差异，用户关于仅思考输出的最终规则明确包含在审核要求中。

收到结果后，重新计算并确认全部被审文件与该快照一致；之后仅更新审核/交付结果文档。原始记录另保存实现文件清单及摘要，以区分审核后的结果文档变化和实现变化。

最新完整回归首次运行在 `test_real_openai_reasoning_is_separate[13-False]` 附近提前退出（退出码 1，无失败堆栈或 pytest 汇总），不能算通过。单独复跑该组 4 项均通过（14.02 秒）；未改代码即完整重跑通过，保留首次异常记录 `C:/Users/lywx2/AppData/Local/Temp/antigravity-claude-round5-full.txt`，提前退出原因未确认。

最终完整回归：**1554 passed、1 skipped、6 warnings，151.41 秒**。输出：`C:/Users/lywx2/AppData/Local/Temp/antigravity-claude-round5-full-rerun.txt`。审核复现回归累计 47 项；Python 编译、JS 语法、diff 空白检查通过。跳过项仍为 Windows 不支持的 POSIX fork，警告为既有弃用提示。

代码审核已通过，不等同于生产发布批准。真实远端数据库迁移/故障演练和线上面板人工验收仍未执行；未部署、未提交或推送 Git，也未使用用户真实凭证进行额度或模型调用。
