# 人工直连测试方案：Claude 审核记录

日期：2026-09-29。实际模型：`claude-opus-5-5`。

通过共享 `C:/Users/lywx2/.codex/review/hook.py` 调用；会话 `01a0d68a-cea6-77b0-8813-913a1cd57632`。

## 当前结论

**Claude Opus 5.5 已通过 Antigravity v10 方案审核。** 本组实际执行2轮：第1轮1项问题，第2轮findings=[]。
总历史8轮；前6轮是此前包含Gemini CLI的范围，本次范围已由用户明确收窄。

- 最新完整方案：[v10](MANUAL_TEST_DIRECT_PLAN.md)，与`.codex/review-plan.md`完全一致。
- 批准时间：2026-09-29T09:12:30.899319+00:00。
- Hook批准摘要（含需求/方案/本次任务）：`29a276f8ec5c326fb10927347bf5f922b905e85ce987bad341e2a7029aa65d3b`。
- 方案文件SHA-256：`9ae8c2eed84b48590f3fac7fbcb422482c70e1045dfeb2017a797b769d8ddbb7`。
- 批准后不再修改方案内容，避免把批准错误套用到新版本；文档顶部“待复审”是被审快照文字，最终状态以本记录及Hook批准摘要为准。
- 只通过方案，**未实施业务代码、未执行开发验证、未进行代码审核、未调用真实Google、未改真实凭证/冷却、未提交推送部署**。

### 本次范围与原fork参照

用户要求“继续 Claude 审核，尽量参照原来fork的方案，另外可以忽略Gemini Cli的内容”。
方案仅覆盖Antigravity；Gemini CLI SMART、健康版本、Token/Project、统计等专属改造全部移除，
历史相关findings作为范围外记录保留，不能算已修复。共享代码仅保证其他模式不回归。
核对本地upstream/master缓存87f56c8及本fork拦截引入前4232efc，沿用直接请求、旧请求构造、
按额度查询解冷，保留本用户确认的组级恢复、禁用不自动开启、真实状态、错误脱敏及必要并发保护。
未把本地上游缓存当远程最新版本，未同步或合并上游。

### 本组处理

1. v9：Claude指出旧记录缺少quota_credential_generation会导致所有回写冲突。核对现有
   quota_snapshot/quota_credential_fence初始化逻辑后，补充复用quota_ensure_generation，
   不解码坏额度策略、重读一致身份/内容、处理删除重建及失败分项结果，形成v10。
2. v10：Claude返回findings=[]，共享Hook记录approved_plan。未自动进入Hook通用提示里的开发，
   因本次仅授权方案审核；方案审核结束后关闭本任务自动review状态并保留真实批准与全部历史。

### Hook续审状态说明

本次带附加说明的续审消息被Hook当作普通新提示关闭。按用户明确续审授权恢复同一任务，
保留前六轮history和之前task文本，用task_revisions记录本次Antigravity-only范围，再交原Hook
处理标准续审指令并重置本组预算。本次未修改Hook代码、未新增runner、未伪造findings或批准。
状态备份：本机临时目录`gcli-manual-review-state-before-third-group.json`。v8/v9审核前快照
分别为该临时目录`gcli-manual-test-plan-v8.md`、`gcli-manual-test-plan-v9.md`。

## 原始 Claude 结果

### 第1轮

- 时间：2026-09-29T08:34:33.981514+00:00
- 审核摘要：`c71bff77583e2a3c191af55f5f54111b7def480c567e8c9befd3a9978c2053db`
- Findings：5

1. `.codex/review-plan.md`

第3节“人工模型及凭证测试”对 Antigravity 来说目前无法落地。现有测试结果全部通过 `quota_record_result` 写回（src/panel/creds.py:2370），而该函数在 admission 为空时直接返回 False（src/storage/antigravity_quota.py:365-367）。所以一旦按方案去掉 `quota_admit`（creds.py:2480），计数、冷却、error_codes 和 manual_override 都不会写入。另外 `quota_snapshot` 会先执行 `_decode`（antigravity_quota.py:212-222），状态损坏时直接抛异常，和方案“损坏状态不阻止请求 Google”相冲突。最小修正：在方案里写明新增一个人工结算原子操作。它只以 `quota_credential_fence` 的 generation 和 credential_version 作为围栏，不依赖 admission，也不校验策略；在同一个 `_quota_atomic` 内完成计数、cycle_stats、冷却或 manual_override、error_codes 的更新，并自带“只结算一次”标记。stats buffer 和 PostgreSQL daily_stats 只在写回成功后执行一次（参照 :393-403）。身份读取改用 `quota_credential_fence`，不再用 `quota_snapshot`。

2. `.codex/review-plan.md`

“人工额度查询与刷新冷却”一节缺少可执行的规则。(1) 当前 `quota_sync` 在 `required_models=None` 时永远不会解冷（antigravity_quota.py:466），而面板和管理接口都传入 None（creds.py:211），所以不能只改调用方，必须新增人工同步分支。(2) 当 reset 是滚动 168 小时时，现有代码会通过 `observe_week` 新写入或刷新 blocked_unknown（:438-440），同时把这类零额度排除在 zeros 之外（:441-442）。方案没有说明人工路径遇到“正额度+滚动 reset”时是否仍记录观察，也没有说明“零额度+滚动 reset”算不算“明确零额度、有效 reset”，否则可能写入 7 天冷却。(3) 方案没有规定正额度解除异常拦截的方式。如果直接删除组状态，下一次后台观察会立刻重新写成 blocked_unknown，应和测试成功一样改为 manual_override 并递增 revision。(4) revision 或 lastSeen 不一致时，现有逻辑会静默跳过（:435-437），需要映射为 `state_update` 的“并发变化未更新”。(5) 同组某模型为正、其他已冷却模型缺失时，是否解除整组冷却需要写明；建议组内至少有一个合法正值、没有明确零值时才解除整组冷却。

3. `.codex/review-plan.md`

管理接口兼容措施不够具体。src/management/active_operations.py:99-117 和 :175-186 直接调用 `_fetch_quota_for_credential`、`test_credential_common`、`immediately_recheck_risk_control`（这个本身就是面板路由函数）和 `sync_model_cooldowns_from_quota`，并没有经过 HTTP 入口。如果方案在这些函数内部加上人工语义，或者删除“SMART 停止时返回 409”的判断（creds.py:1839-1840），管理接口的 test、quota、risk_check、sync 状态码和副作用都会被静默改变，例如 Antigravity 的 424/502 会变成 200。最小修正：写明这些共享函数新增仅限关键字的来源参数，默认值等于当前 f9d48c0 的旧行为，只有面板路由（/test、/batch-test、/quota、/risk-check、/batch-refresh-cooldown、verify-project）显式传入人工来源；risk-check 要拆成面板包装层和管理层仍调用的旧核心函数。验收第 8 项需要逐一断言上述 4 个管理动作的状态码和副作用不变。

4. `.codex/review-plan.md`

Gemini CLI 的人工 SMART 路径只覆盖了“即时复查”。在 SMART 开启时，单项额度（creds.py:1767-1771）、批量刷新（:1932-1939）和消息测试遇到未分类 429（:2544-2547）都会调用 `smart_429_service.verify_credential`。这个函数会复用后台正在运行的任务（smart_429.py:241-243），带有 1 秒全局限速，并且在 epoch 或 version 变化时丢弃结果、不返回 quota（:338、:369）。于是面板会把已经拿到的 Google 结果显示为失败，也违背“使用本次 Google 反馈”的要求。`mark_checking`（:272-293）还会把 health_status 写成 checking，这属于风险隔离写入。最小修正：人工额度和测试路径不管 SMART 是否开启，都直接调用 `fetch_geminicli_quota_info` 或按原测试请求执行，不调用 `mark_checking`，也不复用任务。结果通过一次带版本围栏的写回，更新健康状态、冷却和隔离；围栏冲突时通过 `state_update` 报告，同时仍返回 Google 结果。

5. `.codex/review-plan.md`

错误脱敏的前提与现状不符。方案写的是“继续使用”固定英文错误文案，但当前 Gemini CLI 人工测试失败时，会在响应中原样返回 Google 正文（creds.py:2746-2756），并把完整正文写入日志（:2702）；`record_failure` 也会把原文写入 error_messages（:2667-2673、:2704-2711）。批量测试、批量刷新和额度查询还通过 `str(e)` 返回异常文本（:2819、:2114、:1830）。另外，参照 4232efc 恢复 Antigravity 通用流程时，同样会把这些原文输出带回来。最小修正：在方案第 2 节列出这些位置，要求人工路径的响应、日志和持久化 error_messages 统一使用 `safe_error` 或固定分类，并在验收第 2 项加上“Google 错误正文和原生模型名不出现在响应、日志和状态中”的断言。

### 第2轮

- 时间：2026-09-29T08:38:41.634793+00:00
- 审核摘要：`58cfd826aab765cf29b2fa6117aae975b81509d74d38d5de5a356b4dcb90645b`
- Findings：4

1. `.codex/review-plan.md`

第95、139、147–149行：Antigravity 的“请求前策略快照”没有安全来源，方案前后说法对不上。方案不允许用 quota_snapshot，但 quota_credential_fence（src/storage/antigravity_quota.py:224–235）只返回 generation/version，没有目标组 revision、冷却映射和 lastSeen。第148行要求比较这三项，现有接口拿不到。另外，当前人工路径在发 Google 请求前都会调用会 _decode 的函数：src/panel/creds.py:1736（/quota）、1912（_fetch_quota_for_credential）、2414（test）。Token 刷新失败时的回退 _save_refreshed_quota_credential → quota_current_credential（creds.py:1892，antigravity_quota.py:241）也会 _decode。策略损坏时这些调用会先抛 InvalidQuotaState，与第49行“状态损坏不阻止请求 Google”冲突。最小修正：新增一个不抛异常的人工快照方法，返回 fence 身份，加上按组计算的原始策略指纹（或 invalid 标记）。方案中逐一写明，人工 test、/quota、batch-refresh、verify-project，以及刷新回退里的 quota_current_credential，都改用这个方法或另一个不解码的等价读取。

2. `.codex/review-plan.md`

第43行和第62行对不指定模型的连通性测试有冲突。第43行要求保留原有测试请求构造，即 creds.py:2443–2452：不指定模型时用 gemini-2.5-flash、maxOutputTokens=1、提示词 "hi"。第62行又规定空结果、仅思考、不符合回复要求就不算成功，也不解冷。现有 Antigravity 校验（src/antigravity_completion.py:15–16、113–114）本来就判空内容的 MAX_TOKENS 和仅思考输出无效。对思考型模型只给 1 个 token，很容易触发这种情况。方案把同样的判定推广到 Gemini CLI 后，/batch-test 和默认消息测试可能大面积误报失败，也永远不会解冷，与“参照 4232efc 人工流程”不符。最小修正：分别写出严格模型测试（指定模型，校验回复标记）和不指定模型的连通性探测的成功标准及解冷规则。例如连通性探测以 Google 200、响应体内无错误为成功，只清除该探测模型对应的范围。或者明确调整探测的请求构造，并把它列入回归测试。

3. `.codex/review-plan.md`

第88行和第105–106行只写了 Gemini CLI 的有围栏自动禁用，没写 Antigravity 人工测试是否恢复自动禁用、用什么方式写入。当前 f9d48c0 的 _finish_antigravity_test（creds.py:2345–2377）不做自动禁用。4232efc 的旧路径用的是无围栏的 credential_manager.set_cred_disabled（参照 creds.py:2729–2736）。按旧流程照搬会在凭证被替换或重建后误禁新凭证，违反第140行的围栏要求。最小修正：写明 Antigravity 人工结果触发自动禁用时，只能通过 quota_disable(generation, expected_version)（antigravity_quota.py:264），或放进同一个人工结算事务里有条件写入；围栏失败时如实返回 state_update 冲突。如果不恢复，也要写明不恢复，并补对应测试。

4. `.codex/review-plan.md`

第67–69行的脱敏清单漏了 Gemini CLI 额度查询的错误出口。fetch_geminicli_quota_info 返回的 error 会拼接 Google 原始错误正文（src/api/geminicli.py:1112 为 f"HTTP {status}: {err_str}"，1173 为 str(e)）。这些内容会原样传到面板 /quota 响应（creds.py:1822）和批量刷新的逐项结果（creds.py:1998）。/quota 的异常出口 creds.py:1830、批量刷新的 2114、2145 也会输出 str(e)。这些都是本次要改的人工入口，可能泄露 Google 原文和原生模型名。最小修正：把人工额度查询、批量刷新、即时复查的 error 字段和异常 detail 都加进脱敏清单，只输出固定英文分类加 upstream_status。legacy 管理路径保持不变。

### 第3轮

- 时间：2026-09-29T08:42:21.419332+00:00
- 审核摘要：`72448863ae6026aca66adb49000b40275398c1ef84ea11a6a4a469938cbbfda9`
- Findings：4

1. `.codex/review-plan.md`

第87–91、134、143–145行把缺失的 remainingFraction 一律视为“未知”，这和要参照的 4232efc 旧流程冲突。旧版 Antigravity 解析是 `quota.get('remainingFraction', 0)`（见 .codex/review-code-diff.patch:841），当前 Gemini CLI（src/api/geminicli.py:1127 附近）也是缺失即 0。Google 返回的是 proto3 JSON，额度为 0 时这个字段会被省略，所以“quotaInfo 存在、有 resetTime、没有 remainingFraction”通常就是额度耗尽。按方案的组级规则“至少一个合法正值且没有明确零值就整组解冷”，同组里实际已耗尽的模型会被一起解冷，人工刷新也不会给它补冷。最小修正：人工路径中，quotaInfo 存在但缺少 remainingFraction 时按明确零处理，与 4232efc 一致；只有 quotaInfo 本身缺失或值非法时才算未知。Gemini CLI 的 bucket 也照此处理。验收时补充“同组一个正值、一个缺字段”的用例：该组不得解冷，缺字段的模型要补冷。

2. `.codex/review-plan.md`

第99行和第148行要求人工成功或正额度时“创建或更新 manual_override”。但对原本没有组状态的正常组新建 manual_override，会改变自动保护行为：src/storage/antigravity_quota.py:353-360 的 quota_business_result 和 372-375 的 quota_record_result 会在之后任意一次业务 429（包括容量不足或原因不明的 429）时，把 manual_override 改成 blocked_unknown（override_failed_429）。结果是做一次人工测试或额度刷新，反而会让正常组今后更容易被长期拦截。现有 quota_release（第343–351行）也只转换已存在的状态。最小修正：只在该组已有 blocked_unknown 或 manual_override 状态，或本次响应带有 rolling168h 观测时，才写入或更新 manual_override 并递增 revision；没有既有状态的组只清除计时冷却，不新建组状态。验收补充：正常组人工解冷后，后台业务 429 的行为与修复前一致。

3. `.codex/review-plan.md`

第34–35行打算让管理适配器改为直接调用另一个旧核心函数。但 src/management/active_operations.py:84、109 是按名称导入 `immediately_recheck_risk_control`，test_management_active_operations.py:105、190 也对 `panel_creds.immediately_recheck_risk_control` 做了 monkeypatch。如果适配器改调新名字，这些管理回归测试的替身不再生效，测试会走到真实核心，和“管理契约与旧副作用逐一回归”的目标冲突。最小修正：保留 `immediately_recheck_risk_control(filename, token=...)` 作为兼容旧行为的核心函数，函数名和签名都不变，管理适配器不用改；另外新建一个面板路由函数绑定 `/risk-check/{filename}`，传入 origin="manual"。这样无需修改管理测试。

4. `.codex/review-plan.md`

第106行要求人工项目检验不再自动启用凭证，但方案没有列出需要同步修改的用户可见文案。src/panel/creds.py:1077 的成功消息仍写着“已解除禁用状态并清除错误码”，第1066行日志写“已解除禁用”，front/common.js:1070 的按钮提示是“可恢复403错误”，都会误导用户以为凭证已重新启用，违背“禁用保持不变”的已确认决定。最小修正：在第2节“响应与界面”或第4节第4步中明确，人工项目检验的消息和日志改为“已更新 Project ID、清除错误码，禁用状态未改变”，并在单项及批量检验（front/common.js:2055、2092、2901、2979 附近）按新字段展示；legacy 默认路径保持原文案。

## 文件与保护边界

- 原有未提交审核计划已原样备份到 `C:/Users/lywx2/AppData/Local/Temp/gcli-review-plan-before-manual-20260929.md`。
- v1/v2/v3审核前快照分别位于该临时目录的 `gcli-manual-test-plan-v1.md`、`gcli-manual-test-plan-v2.md`、`gcli-manual-test-plan-v3.md`。
- `.codex/review-code-diff.patch` 保留；业务代码和测试未修改。
- 本报告仅描述实际审核和方案修订；前三轮各自的findings不因后续修订被改写。

## 本次续审原始 Claude 结果

### 第4轮（本组第1轮）

- 被审方案：v5
- 时间：2026-09-29T08:54:47.076789+00:00
- 审核摘要：`37f723dfa87ea59bf49f96030ecfcc4463f8dab453bf16efb01972bfb9baece2`
- Findings：2

1. `.codex/review-plan.md`

第3节第120-128行与第113-115行把人工结算里的计数、错误白名单、自动禁用和统计出口都绑在“目标策略可安全解析且策略快照未变化”上。策略损坏或策略并发变化时，一次真实发出的 Google 请求不会计入 success/failure/call_count、stats buffer 和 PostgreSQL daily_stats。真实 401/403 等配置内自动禁用错误码也会因为不相关的额度 JSON 损坏或组状态变化而被跳过。现有 quota_record_result（src/storage/antigravity_quota.py:376-404）中的计数、错误码和 disabled 本身不依赖策略解码，只依赖身份围栏。最小修正：把人工结算拆成两个围栏层级。第一层只校验身份 generation/content version：通过即更新计数、错误白名单和配置内自动禁用（仍在同一事务内有条件写），并在提交后恰好一次更新 stats buffer/daily_stats。第二层额外校验目标策略快照，只控制冷却、manual_override 和 cycle_stats 这类策略字段；策略损坏或冲突时只跳过这一层，并在 state_update 中分项报告。身份冲突时两层都不写。验收里补充：损坏策略下真实请求仍计数一次、401/403 仍可按配置禁用。

2. `.codex/review-plan.md`

第172行承诺“凭证被替换、删除重建时不覆盖”，第179-184行也只给 Gemini CLI 的健康状态和冷却字段设计了条件写入。但 Gemini CLI 人工路径还会无条件写凭证内容：Token 刷新后调用 store_credential（src/panel/creds.py:1897，被 /test 的 2427 行、/quota 的 1755 行、_fetch_quota_for_credential 的 1921 行使用），项目检验也会写 store_credential（src/panel/creds.py:979、1040）；项目检验还会无条件写 update_credential_state（1043 行起）。人工请求进行中如果用户替换了同名凭证，旧凭证加新 Token 或旧 project_id 会覆盖新凭证，和方案的并发承诺矛盾。最小修正：方案明确 Gemini CLI 人工路径的 Token 刷新回存和项目检验的凭证/状态写入，也使用基于请求前凭证内容版本的条件写（SQL 加锁或 Mongo CAS），失败时报告 state_update 冲突，并复用当前有效 Token 或报告本地准备失败。或者明确声明这部分沿用 4232efc 的无条件写入、不在本次承诺范围内，并删除第172行对 Gemini CLI 的覆盖承诺。验收第6项补充 Gemini CLI 凭证替换期间的人工测试、额度查询和项目检验用例。

### 第5轮（本组第2轮）

- 被审方案：v6
- 时间：2026-09-29T08:58:10.976307+00:00
- 审核摘要：`ae314da07f25f7ded7b16d0ac7922c0b6d8def6b6d299f35e561d8ce4562208d`
- Findings：2

1. `.codex/review-plan.md`

第140–144、189–194行：Gemini CLI 的人工写入（清除健康隔离、写 risk 隔离、自动禁用）只要求先比对版本再有条件写入，没有要求递增 health_state_version。当前后台 SMART 检查只在版本变化时放弃结果：_verify_once 在 await Google 前记下版本（src/smart_429.py:311–338），apply_health_check_result 在 src/smart_429.py:363–369 只比对 health_state_version，然后在 :416 无条件写入。现有状态写入方 set_cred_disabled 就是通过递增版本让进行中的后台检查失效的（src/credential_manager.py:242）。如果人工写入不递增版本，请求前已开始的后台检查（scheduled_probe、runtime）返回后版本比对仍然一致，会把人工刚清除的隔离写回 risk_quarantined/checking，或覆盖人工写入的状态。此外 apply_health_check_result 本身是“先读、再无条件写”，人工条件写入落在这段窗口内时同样会被覆盖。最小修正：写明人工 Gemini CLI 的健康、隔离、禁用条件写入必须在同一事务内把 health_state_version 加一；并把 apply_health_check_result 的最终写入改为使用同一个新增原语，带 expected health_state_version 条件执行（只加版本条件，不改变后台分类语义）。在验收中补充“后台检查进行中执行人工操作，人工结果不被后台旧结果覆盖”。

2. `.codex/review-plan.md`

第34、203、230–231行只把前端面板和 Management 列为 /quota 的调用方。scripts/measure_antigravity_quota.py:336 和 scripts/validate_antigravity_model_catalog.py:312 也用面板 Token 调用 GET /creds/quota/{filename}?mode=antigravity，测量脚本还会多次轮询（stable_quota_baseline / delayed_quota_snapshots）。方案把 /quota 改为 manual 入口后，这两个脚本每次查询都会按人工规则解除冷却、把异常组转为 manual_override 并递增 revision，遇到滚动 168h 正额度还会新建 manual_override。这会改变测量期间业务请求的准入状态和测量结果，而方案没有声明这一副作用，也没有相应回归。最小修正：在第2节入口清单和第4节兼容边界中列出这两个脚本，明确它们今后走人工语义并有状态副作用（在脚本说明中写明），或者让它们改用不回写状态的查询方式；在第5节补一条回归：脚本读取的响应字段（models、quota_group_states）保持不变。

### 第6轮（本组第3轮）

- 被审方案：v7
- 时间：2026-09-29T09:01:34.649608+00:00
- 审核摘要：`b4b8e0fd7c69bc4478854f479fe89bcb80e2d904bb73a230ab7ac0a99ddfc6c8`
- Findings：2

1. `.codex/review-plan.md`

第3节第140–155行和第221–229行只规定了 Gemini CLI 的健康状态、隔离、禁用、凭证内容/Project/preview 采用带围栏的条件写入。第121–138行要求“逻辑统计只有一个出口，不同时走旧 record_failure/record_success”，但这条只写在 Antigravity 部分，没有覆盖 Gemini CLI 人工测试。当前 src/panel/creds.py:2614-2619、2667-2673、2704-2711 的 Gemini CLI 人工测试仍调用 record_success/record_failure。这两个函数（以 src/storage/sqlite_manager.py:2491-2523、2552-2568 为例）是按文件名无条件更新：成功时清除 error_codes/error_messages，并用“先 SELECT、再 UPDATE”删除被测模型冷却，中间不加锁；失败时直接覆盖错误字段。按现方案实施，Gemini CLI 人工结果会绕过第203–205行要求的身份、内容版本和字段快照围栏：凭证删除重建或并发写入冷却后，旧结果会清掉新凭证的冷却和错误字段，也会被计入统计。最小修正：明确 Gemini CLI 人工路径也不调用 record_success/record_failure。success/failure/call_count、cycle_stats、last_success、脱敏后的错误字段、被测模型冷却清除这几项，与健康状态写入放进同一个四后端条件事务，并比较请求前身份/版本和目标字段快照。只有事务提交后才调用一次 _bump_stats_buffer 等既有统计出口；身份冲突时不计数、不写入。legacy 默认路径继续使用原 record_*。

2. `.codex/review-plan.md`

第214行写的是“人工 test、/quota、_fetch_quota_for_credential（含 batch-refresh）……全部显式使用此身份路径”，没有写明按 origin 分支。但当前 src/management/active_operations.py:99 的 quota 动作和 :175 的 _sync_cooldown 都直接调用 _fetch_quota_for_credential(filename, mode=mode)；_sync_cooldown 在 :183-186 还会把返回的 _quota_snapshot（来自 quota_snapshot 的解码后公共状态，含 revision 等）传给 legacy quota_sync。如果照第214行把该函数整体改成 manual_snapshot 或人工 Token 回退，管理接口的 quota/sync_cooldown 会拿到结构不同的快照，并改用人工副作用，违反第241–242行“/management/v1 契约和调用语义不变”，也违反第275行要求逐一回归的旧副作用。最小修正：在第33行和第214行明确 _fetch_quota_for_credential 增加仅关键字参数 origin="legacy"。legacy 分支原样保留 quota_snapshot、_quota_snapshot、_save_refreshed_quota_credential 以及 SMART verify_credential 分支；只有 /batch-refresh-cooldown 显式传 origin="manual"，才走 manual_snapshot、manual_current_credential 和新的人工额度同步。验收中补一条：管理 quota/sync_cooldown 调用时 origin 仍为 legacy，返回的 _quota_snapshot 结构不变。

## 上一组结束时的文件核对（历史）

- v4/v5/v6/v7审核前快照保存在本机临时目录，命名为 `gcli-manual-test-plan-vN.md`。
- v8当前方案SHA-256：`dbec290424cac5e86ad4ad5087066fdf6b5c347e06aeb785e6052acc922b5ee6`，此摘要仅用于标识未复审版本，不是批准摘要。
- `.codex/review-code-diff.patch` 原样保留；本次仅更新方案与本报告。业务开发和测试尚未开始。

## 第三组原始 Claude 结果（Antigravity-only）

### 累计第7轮（本组第1轮，v9）

- 时间：2026-09-29T09:11:10.096805+00:00
- 摘要：`cca777e002551c43e8649b01e07d1e32c3d9bd86784d9f9a8dfa0c65e6344410`
- Findings：1

1. `.codex/review-plan.md`

§4 'Getting the credential and saving Token/Project safely' (lines 94-104) switches the manual test, /quota, the manual branch of _fetch_quota_for_credential and verify-project over to a new manual_snapshot. It explicitly stops calling quota_snapshot, but it doesn't say that manual_snapshot must initialize a missing identity first. The old quota_snapshot/quota_credential_fence (src/storage/antigravity_quota.py:212-235) call quota_ensure_generation when a legacy row has no quota_credential_generation. If manual_snapshot reads that row directly, the snapshot generation is None. _quota_atomic.apply (line 111) then assigns a new uuid to the row, and quota_refresh_credential (line 253) compares generations. So every Token save, test settlement and quota-based cooldown clearing on a legacy row is treated as an identity conflict and is never written. The Google request would still be sent, but the old flow's automatic write-back and cooldown clearing would never happen for these rows. Minimal fix: in manual_snapshot (and manual_current_credential), when the generation is missing, call the existing quota_ensure_generation (validate=False, which doesn't parse the quota policy). Then re-read the same row to get the identity and the raw fingerprint. Add an acceptance case: a legacy row without a generation, where a manual test/quota succeeds and the write-back is applied.

### 累计第8轮（本组第2轮，v10）

- 时间：2026-09-29T09:12:30.899319+00:00
- 摘要：`29a276f8ec5c326fb10927347bf5f922b905e85ce987bad341e2a7029aa65d3b`
- Findings：0
- 原始结构化结果：`findings=[]`。共享Hook实际返回“Claude approved the plan.”

## 前两组结束时的结论快照（历史，已由本次范围与结论取代）

### 当时结论

**两组累计六轮方案审核均有 findings，尚未通过。** 用户本次明确“继续 Claude 审核”，已执行新授权的三轮。当前方案v8已补入最后两项意见，但v8未由Claude复审；不能把修订视作通过。

- 上一组第1/2/3轮分别5/4/4项；原始结果完整保留在下方。
- 本组第1轮（累计第4轮，v5）：2项。真实请求计数不能依赖额度状态可解析；Gemini CLI Token/项目写入缺少条件更新。核实后补入v6。
- 本组第2轮（累计第5轮，v6）：2项。后台SMART旧结果可能覆盖人工状态；两个诊断脚本调用额度接口的副作用遗漏。核实后补入v7。
- 本组第3轮（累计第6轮，v7）：2项。Gemini CLI旧record_*仍可能绕过条件结算；共享额度函数的legacy分支需明确保留。核实后补入v8，**尚未复审**。
- 当前完整方案：[v8](MANUAL_TEST_DIRECT_PLAN.md)。`.codex/review-plan.md` 与其内容一致。
- 本组达到3轮上限；下一组须用户再次明确发送“继续 Claude 审核”。未实施业务代码、执行真实Google请求、修改凭证/冷却、运行真实诊断脚本、提交或推送。

### 额度缺失语义的核查

第三轮Claude断言缺失remainingFraction等于零，未作为已证实事实采纳。查阅Google官方Gemini CLI源码发现：字段是可选的，refreshUserQuota跳过缺失值；这不证明Antigravity协议语义。方案明确缺失为unknown；已返回同组条目混合正值与unknown时不整组解冷，但人工请求始终发送。完全未返回的模型保留既定部分正值组级恢复策略。本组复审未再提出这项问题，但整个方案仍未通过。

官方参考：[Gemini CLI config.ts](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/config/config.ts)、[types.ts](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/code_assist/types.ts)、[ProtoJSON](https://protobuf.dev/programming-guides/json/)、[Field Presence](https://protobuf.dev/programming-guides/field_presence/)。未调用真实Google接口核实协议，不把通用JSON默认值规则当成具体接口证据。

### 续审状态恢复说明

本次续审消息进入共享Hook后，原任务被当作普通新提示关闭，active变为false且awaiting_confirmation被删除，历史仍有3轮。本次按用户明确续审授权恢复同一任务的active/awaiting_confirmation，再将UTF-8的“继续 Claude 审核”交给原Hook；由Hook重置本组计数并确认最多三轮。原task、history和实际findings未删除或改写，未新建审核runner、未改Hook代码、未伪造通过状态。恢复前状态已备份到本机临时目录 `gcli-manual-review-state-before-resume.json`。
