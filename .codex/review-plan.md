# Antigravity 人工直连实现：Claude代码审核基准

2026-09-29。用户明确要求“请Claude 代码审核”。本次交付已实施，现申请实际代码审核。
本文件是本次审核入口；此前批准的完整v10方案原文保存在review/MANUAL_TEST_DIRECT_PLAN.md，
审批证据在review/MANUAL_TEST_DIRECT_CLAUDE_REVIEW.md。旧方案的“只审方案”描述属于上轮授权，
已被随后“实施开发”和本次“代码审核”覆盖。v10行为要求不变，不重新扩展设计。

## 当前范围与文件

仅Antigravity人工测试/额度/项目操作；尽量遵循本fork拦截前4232efc流程。
不修复Gemini CLI专属内容，检查共享默认legacy分支不回归。无MGMT开发、schema或capability变化。

必须读取完整v10方案及以下当前文件作为代码审核对象，而非用历史patch替代：
- src/panel/antigravity_manual.py、src/panel/creds.py
- src/storage/antigravity_quota.py、src/manual_google.py、src/google_oauth_api.py
- src/api/antigravity.py、front/common.js
- test_antigravity_manual.py、test_antigravity_quota_boundaries.py
- docs/ANTIGRAVITY_MANUAL_TESTS.md、docs/ANTIGRAVITY_MODEL_CATALOG.md、docs/MAINTENANCE_SCOPE.md
- scripts/measure_antigravity_quota.py、scripts/validate_antigravity_model_catalog.py（本次仅说明/帮助变更）
- review/MANUAL_TEST_DIRECT_DELIVERY.md（实际验证范围及限制）
- src/management/active_operations.py（默认调用和legacy分支）
- src/storage/sqlite_manager.py、src/storage/mysql_manager.py、src/storage/psql_manager.py、src/storage/mongodb_manager.py、src/storage/_stats_common.py（逐一核对条件更新/CAS和统计实现）
相关依赖如四后端、管理适配器、错误分类和统计代码按需只读核查，不扩大业务改造。
.codex/review-code-diff.patch为此前任务遗留，不是本次差异，不能据它判断当前代码。

## 核查和处置

1. 认证面板人工操作确实直接发请求，不被冷却/异常组/禁用拦截；普通API仍保留保护。
2. 使用真实Google状态，区分本地校验和回写，固定英文错误/退役通知，不泄露原文或原生模型名。
   必须核查src/google_oauth_api.py、src/manual_google.py和src/panel/antigravity_manual.py及其调用链的日志出口：不得记录原始Google错误正文、原生模型名、Token、邮箱等敏感内容。
3. 测试/正额度恢复对应组，零/未知/滚动reset规则正确，禁用不因成功改变。
4. Token、Project、统计、冷却和错误写入保护凭证身份及并发变化；损坏策略仍能请求；一次性结算。
5. 四存储事务/CAS、后台/Management默认调用及前端单项/批量保持约定；重点查现有测试未覆盖的分支。

已有验证：完整pytest 1595通过/1跳过；最后Token阶段修正经41项人工测试，前端阶段展示经Node用例。
这不是代码审核通过证据，也不等于真实Google或远程数据库在线验证。范围内发现核实后修复，
执行相应模拟/隔离回归，再在本组三轮总额度内复审；无问题以实际Claude findings=[]为准。
不调用真实Google、不读取真实凭证或生产数据库、不提交/推送/部署。原方案和审核历史保留。

## 2026-09-30 本次复审授权与重点

用户重新明确启用Claude审核：复审Antigravity人工直连的4项修复。
本次仅复审现有实现及修复，不重新设计已批准v10方案；上文已有验证数字为历史记录。
必须读取review/MANUAL_TEST_DIRECT_CODE_REVIEW.md中的上轮4项发现和修复说明，
逐项核对当前代码与test_antigravity_manual.py中的对应回归：批量额度失败文件名、
并发Token刷新保留元数据与token别名（身份替换仍拒绝）、批量项目失败详情与回写提示、
MySQL/MongoDB不支持周期统计时不再误报冲突。检查相关回归，不扩大Gemini CLI范围。
最新已有验证为48项人工测试、完整1602通过/1跳过；不等于真实上游或远程数据库验证。
只读审核源码和文档，不读取凭证或生产数据库，不运行命令，不联网探测Google。
方案阶段只核对本次复审范围和依据；代码阶段必须实际读取当前实现，
不要用历史patch或旧报告的未复审状态替代代码结论。具体可复现缺陷才列为finding，
无缺陷返回findings=[]。本组三轮总上限保持不变。
