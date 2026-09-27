# 本次任务审核计划：Antigravity stability 融合到 dev0927

## 当前请求：只获取四项 findings 的修复建议

2026-09-27，用户明确要求“让Claude给出修复建议”。本轮在当前调度会话单独记录建议咨询，
保留下面此前融合审核的范围与证据作为背景，不重复申请当前代码通过，也不实施修复。
请以 `review/ANTIGRAVITY_STABILITY_CLAUDE_REVIEW.md` 的四项未解决问题为输入，结合所指向的
当前测试、预算/collector实现、维护范围和融合记录，只读给出中文最小修复方案。

每项应包含确认结论、文件/位置、修改步骤、关键测试断言或建议替换的文档文字及验收条件。
必须区分测试证据缺口与已复现运行时缺陷；第一项应说明真实 fake-stream/collector 边界如何
证明共用同一 TOTAL 预算，第二项应覆盖完整输出的协议类型、唯一错误与旧原文不泄露。
文档建议需要更新实际合并/审核状态与 `git revert -m 1 20cb545` 的主线父提交含义；仅提出
回滚建议，不执行任何回滚。时间边界测试采用稳定设计，不依赖接近阈值的两段 sleep。

结果写入本轮新建议报告，原审核 findings 和原始历史不改写；最多按共享流程允许的轮次调用。
本轮不编辑业务代码、测试、现有融合记录或维护文档，不运行全量回归，不提交、推送、部署。
下面的审核结论仍为历史证据，任何建议返回均不构成修复完成或代码审核通过。

## 审核快照与范围

- 本轮是独立的 Claude 审核，不复用旧的模型 API 固定错误审核结论或提示词。
- 唯一工作区：`C:/Users/lywx2/.codex/worktrees/14f9/gcli2api`。
- 当前实际快照为合并提交 `20cb5455834c56a4a6e989b08f29d202b294f2cc`，父提交为目标
  `6a452a10c8d0b0742923d26d5360d11094300199` 和来源
  `7bb1824f96538d329d8234140a5f4095bc138434`；不重做合并。
- 审核范围是该融合提交相对两个父提交的全部实现、测试与
  `review/ANTIGRAVITY_STABILITY_INTEGRATION.md`，并核对 `AGENTS.md`、
  `docs/ANTIGRAVITY_STABILITY.md`、`docs/MAINTENANCE_SCOPE.md`、`.codex/review.json` 与本计划。
- 仅允许更新本计划、Claude 审核状态和本轮结果记录；不修改业务代码、测试、冻结契约、
  审核配置、panel-version，不提交、推送、部署，不调用生产模型，不读取真实凭证、数据库或 Volume。

## 必核验行为

1. 来源五个稳定性提交的功能在融合后仍可达：上传结果真实性与安全错误、共享阶段/重试预算、
   原子冷却结算、导入请求/ZIP/JSON/累计大小与并发限制、拒绝连接有界清理。
2. dev0927 原有行为未被冲突解决破坏：固定英文错误、整数 504、三协议正确 SSE 终止、私有类型错误、
   HTTP 200 错误与退役识别、空流 502、正文后不重放、一次逻辑统计、模型别名规范化、取消与资源清理。
3. 时间预算语义正确：真流 FIRST/IDLE 仅由有效进展续期；非流、假流、收集器受 TOTAL 限制；
   抗截断多次续接共享同一个单调总预算，不因重试或续接重置；提交前/后错误边界和阶段超时一致。
4. 检查融合边界是否保留 `events`/`protected`/协议参数、上游关闭、凭证预取取消、客户端断开统计规则，
   并确认新增 27 项融合测试确实验证关键断言，而不是仅验证调用形状。
5. 检查兼容与安全边界：其他 provider 默认行为、Legacy 路径、冻结诊断契约、schema/capability、
   错误脱敏、HTTP/1 与 HTTP/2 连接行为，以及文档中的测试证据是否与实际快照一致。
6. 对照 `AGENTS.md` 与 `docs/MAINTENANCE_SCOPE.md` 检查冲突解决、融合代码和 27 项新增测试：
   保留原停止维护决定，并核对 2026-09-27 的有限例外只覆盖共同模型 API 的五类：错误脱敏、
   HTTP-200 错误/退役识别、流式错误边界、正文后不重放和一次性统计接线。具体审查
   `git diff 6a452a10c8d0b0742923d26d5360d11094300199..20cb5455834c56a4a6e989b08f29d202b294f2cc`
   与 `git diff 7bb1824f96538d329d8234140a5f4095bc138434..20cb5455834c56a4a6e989b08f29d202b294f2cc`
   中的 `src/api/geminicli.py`、`src/router/geminicli/**` 及相关测试，按 hunk 归因到目标父提交已有的
   授权改动、来源父提交的 Antigravity 改动或合并冲突解决；目标/来源父提交已有的变更属于保留，
   只有合并提交本身新增的冲突解决需要判断，且必须落在上述五类例外内。任何扩大例外、Gemini CLI
   专属新功能、模型适配、性能优化或发布验证均须报告为范围外问题。还要确认合并后的
   `docs/MAINTENANCE_SCOPE.md` 没有扩大例外文字。
7. 扫描新增融合测试、fixture、日志样例和融合记录，确认只使用合成凭证值；同时检查导入失败/结果路径
   不回显 access token、refresh token、client secret 或完整凭证 JSON。

## 验证证据

- 交接记录声称全量回归 `1238 passed, 1 skipped, 6 warnings`，冻结诊断契约 73 文件通过；
  Claude 需独立检查实现和测试，不把这些历史本地结果当作审核结论。
- 在代码审核前于合并提交 `20cb5455834c56a4a6e989b08f29d202b294f2cc` 上重新运行仓库约定的全量
  单元、管理协议契约、Legacy/Antigravity 回归和 `scripts/verify_diagnostic_contract.py`，使用隔离
  临时依赖、合成测试数据和本地模拟上游；记录精确命令、提交 SHA、通过/跳过/警告/失败计数。若无法运行，
  代码结论必须标为证据不完整，不得以交接历史数字替代。
- 本轮实际执行：`PYTHONDONTWRITEBYTECODE=1`、`PYTHONPATH=C:/Users/lywx2/AppData/Local/Temp/gcli-diag02-validation-deps`，
  先执行 `$regressionFiles = @(rg --files -g 'test_*.py' -g '!tests/**')`，其实际根目录文件清单为：
  `test_antigravity_cooldown_regression.py`, `test_antigravity_cycle_settlement.py`,
  `test_antigravity_import_limits.py`, `test_antigravity_import.py`, `test_antigravity_message_cleanup.py`,
  `test_antigravity_model_catalog.py`, `test_antigravity_quota_measurement.py`, `test_antigravity_request_compat.py`,
  `test_antigravity_shared_cooldowns.py`, `test_antigravity_stream_collection.py`, `test_antigravity_stream_replay.py`,
  `test_antigravity_timeouts.py`, `test_cooldown_stats.py`, `test_credential_page_size.py`, `test_diagnostics_r2.py`,
  `test_diagnostics_revision.py`, `test_diagnostics_runtime.py`, `test_diagnostics_service.py`,
  `test_diagnostics_vectors.py`, `test_error_classification_backends.py`, `test_error_classification.py`,
  `test_frontend_static.py`, `test_gemini35_tier_routing.py`, `test_geminicli_subscription_api.py`,
  `test_logical_request_stats.py`, `test_management_active_operations.py`, `test_management_api.py`,
  `test_management_openapi.py`, `test_management_service.py`, `test_panel_embed.py`,
  `test_panel_version_generator.py`, `test_quota_fallback_cooldown.py`, `test_security_config.py`,
  `test_selected_credential_tools.py`, `test_smart_429.py`, `test_sqlite_summary_bounded.py`,
  `test_sqlite_tier_storage.py`, `test_subscription_node_management.py`, `test_subscription_tiers.py`,
  `test_upload_tier_detection.py`, `test_versioning.py` (共 41 个)。使用
  `G:/code/gemini30/gcli2api/.venv/Scripts/python.exe scripts/run_diagnostic_tests.py -c pyproject.toml
  --asyncio-mode=auto -q tests $regressionFiles --tb=short`，随后执行
  `scripts/verify_diagnostic_contract.py`；在 `20cb5455834c56a4a6e989b08f29d202b294f2cc` 上得到
  `1238 passed, 1 skipped, 6 warnings`，契约校验 `PASS: 73 contract files; worktree == index`，
  manifest SHA-256 为 `ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4`。
- 如发现缺陷，报告精确的项目相对路径、行号（可得时）、触发条件、影响和最小修复建议；不直接修复。
- 本轮方案与代码审核总共最多自动 3 轮；若 Hook 达到上限，保留未解决 findings 并等待用户明确继续。

## 交付判断

代码审核结论必须明确为通过、带缺陷，或因 Claude/证据失败而未完成；记录实际 Claude 模型、轮次、
审核快照、未解决问题和结果路径。交付记录还必须明确 schema 版本、capability、兼容影响、manager
动作判断及回滚边界；本项若无对端动作，核对 `no_counterpart_action` 记录，若有动作则要求
`coordination/handoffs/` 中符合约束且 `execution_policy=queue_only` 的交接 JSON。任何旧 review 文件、
旧工作区或历史批准不得替代本轮结果。

本方案已在本轮审核激活后由会话 `01a0e09d-b0e2-71d3-91b3-10144df26d48` 更新；该会话只对应本次融合审核。
