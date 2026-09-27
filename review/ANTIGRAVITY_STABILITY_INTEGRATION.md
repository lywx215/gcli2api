# Antigravity stability → dev0927 融合记录

日期：2026-09-27。工作区：`C:/Users/lywx2/.codex/worktrees/14f9/gcli2api`。

## 当前状态（2026-09-27 更新）

- 实际合并提交：`20cb5455834c56a4a6e989b08f29d202b294f2cc`，分支 `dev0927`。
- 第一父提交（主线/目标）：`6a452a10c8d0b0742923d26d5360d11094300199`。
- 第二父提交（来源 `codex/antigravity-stability`）：`7bb1824f96538d329d8234140a5f4095bc138434`。
- 已提交并推送。此次文档修订前通过 `git ls-remote origin refs/heads/dev0927` 核实，
  远程分支指向同一合并提交；该结论对应本次核实时点。
- Claude 代码审核已执行，结论为“发现问题，未通过”，详见
  [审核记录](ANTIGRAVITY_STABILITY_CLAUDE_REVIEW.md)及
  [修复建议](ANTIGRAVITY_STABILITY_REPAIR_ADVICE.md)。用户决定两项测试证据缺口暂不修改，
  本次只修正文档范围与融合记录；文档修正尚未经过 Claude 复审，不标记审核通过。
- 以下“合并未提交 / 保留 MERGE_HEAD / 本轮不启动 Claude 审核 / 新增并暂存”等表述
  均属于合并提交前的历史交接快照，不代表当前状态。历史验证数字保留，本次纯文档修订
  未重新运行测试，也未提交、推送、部署或执行回滚。

## 合并身份与交付边界（合并前历史快照）

- 目标分支：`dev0927`。
- 目标父提交（HEAD）：`6a452a10c8d0b0742923d26d5360d11094300199`。
- 来源分支：`codex/antigravity-stability`。
- 来源父提交（MERGE_HEAD）：`7bb1824f96538d329d8234140a5f4095bc138434`。
- 共同祖先：`ac54880`。
- 合并方式：`git merge --no-ff --no-commit codex/antigravity-stability`；解决冲突后暂存，
  保留 MERGE_HEAD，未创建合并提交。最终提交、推送由调度窗口处理。
- 本轮不启动 Claude 审核；任何旧审核记录均不覆盖当前融合快照。

没有提交、推送、部署、生产模型调用、真实凭证修改、生产 SQLite/Volume 修改，
没有更新 `panel-version.txt`，没有修改现有审核配置或冻结诊断契约。

## 来源功能完整性

来源 5 个提交的功能均保留：

1. `c056ac8`：凭证存储返回 false 或抛出异常不再误报成功；文件和 refresh-token 导入
   返回安全错误码，批量 token 预览脱敏；落库后附加信息失败作为 warning。
2. `f1e94e7`：连接、写入、完整响应头、FIRST、IDLE 和非流 TOTAL 阶段预算；
   凭证选择、重试、退避、转换及抗截断续接共享请求预算。
3. `3ad9b55`：SQLite BEGIN IMMEDIATE 与 PostgreSQL 事务/行锁下原子冷却结算；
   同轮分项去重，共享冷却延长不重复结算，旧组级键保守兼容。
4. `3e38e1e`：请求实际字节、文件数量、ZIP 实际目录条目、单项及累计解压字节限制；
   有界临时文件、进程内请求/写入门控、整批校验后顺序存储与取消清理。
5. `7bb1824`：超限上传先返回 413，再有界丢弃在途数据并关闭 HTTP/1 连接；
   HTTP/2 不发送 Connection 头。保留真实本地 Hypercorn 回归。

## 七处冲突的取舍

| 文件 | 融合决定 |
| --- | --- |
| docs/MAINTENANCE_SCOPE.md | 保留 dev0927 的 Gemini CLI 停止维护及本轮有限例外，合入来源 Antigravity 完成进度。 |
| src/httpx_client.py | 同时保留 events 模式及 response_header_timeout；完整 SSE 规范化、退役检查与诊断观察链不被旁路；其他调用默认路径不变。 |
| src/api/antigravity.py | 将预算包裹现有实现；保留 events/protected 参数、私有类型错误、HTTP-200 错误/退役识别、空流重试及最终 502、正文后不重放、凭证预取清理和诊断观察。 |
| src/router/antigravity/openai.py | 保留 protected=True/protocol=openai；仅假流额外启用 non_stream=True 总预算。 |
| src/router/antigravity/anthropic.py | 保留受保护协议名 claude，不用 legacy anthropic 名替换；仅假流启用总预算。 |
| src/router/antigravity/gemini.py | 保留 protected=True/protocol=gemini；仅假流启用总预算。 |
| src/router/stream_passthrough.py | Antigravity 分支统一持有预算、上游关闭和一次计数；显式区分受保护和 legacy 错误出口，不使用来源的裸空流 204 覆盖受保护空流 502。 |

受保护流超时使用现有固定英文 renderer：提交前 504；提交后 OpenAI 整数 code=504
且只跟随一个 [DONE]，Claude event:error，Gemini 错误事件不添加 [DONE]。
legacy helper 输出保留兼容；它不替代受保护模型路由的错误边界。

统计保留 dev0927 的显式错误信封判断，不以正文中的退役词句判定失败。
所有重试/续传属于一次逻辑请求；模型别名仍在路由处规范化；
取消传播、上游关闭和“客户端断开不计最终结果”保持不变。
有效生成进展与成功统计是不同判断：纯元数据不会续期 FIRST/IDLE；
真正流式持续输出可以超过 TOTAL，假流/收集器不能绕过 TOTAL。
既有收到的 HTTP 错误优先于其后的单次传输异常；共享预算真正耗尽为 504。

## 验证（合并前历史证据）

全部命令以本工作区为显式 workdir；通过现有隔离运行器创建临时凭证目录、
屏蔽远端数据库/代理配置，仅使用合成测试数据及本地模拟上游。

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:PYTHONPATH='C:/Users/lywx2/AppData/Local/Temp/gcli-diag02-validation-deps'
$regressionFiles = @(rg --files -g 'test_*.py' -g '!tests/**')
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/run_diagnostic_tests.py -c pyproject.toml --asyncio-mode=auto -q tests @regressionFiles --tb=short
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/verify_diagnostic_contract.py
git diff --cached --check
git diff --check
git ls-files -u
```

- 首轮针对性测试：`test_antigravity_timeouts.py` + `tests/test_model_api_transport_errors.py`，
  76 passed。
- 首轮全量回归（尚未加入本次新测试）：1211 passed, 1 skipped, 6 warnings。
- 新增并暂存 `tests/test_antigravity_stability_integration.py`，27 个融合用例：
  三协议提交前/后固定超时、空流 502、元数据不续期、假流 TOTAL、私有类型错误、
  正文非退役误判、一次计数、断开清理、续传共享预算和 events/protected 参数传递。
  开发时曾发现短计时续传测试受调度影响，已改为首轮即时输出、后续等待超时并检查
  同一个预算对象，避免用两次紧贴阈值的 sleep 推断预算共享。
- 最终全量回归：1238 passed, 1 skipped, 6 warnings，80.88 秒；退出码 0。
- 冻结契约验证：PASS，73 files，worktree == index；
  manifest SHA256 `ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4`。
- Git 差异空白检查通过；无剩余 unmerged index entries。

## 兼容、限制与回滚

数据库 schema 版本不变，无迁移、无历史统计重算。Management API schema/capability
未改变；本轮是 Antigravity 内部稳定性修复，不新增管理协议能力。
manager 无需动作（`no_counterpart_action`），不创建对端任务、不恢复已取消 MGMT 工作项。

Windows 上 POSIX fork 测试跳过；spawn/restart 的本地 HTTP 测试仍执行。
6 条警告来自现有 Starlette/Pydantic 弃用提示。PostgreSQL 只验证事务/行锁调用模拟，
未连接真实 PostgreSQL；未做生产模型或部署验证。新增环境变量及限制详见
`docs/ANTIGRAVITY_STABILITY.md`。

回滚建议（仅记录，未执行）：在 `dev0927` 上使用 `git revert -m 1 20cb545`。
`-m 1` 表示以第一父提交 `6a452a1`（目标主线）为基准，生成一个新的反向提交，撤销
该合并相对主线引入的全部改动，包括来源五个稳定性提交带来的变更及七处冲突解决的
相应差异；第一父提交中已有的固定错误保护保留。此方式不改写历史，也不需要强推。

执行前需确认工作区状态，并检查合并后的提交是否依赖这些改动；如有冲突，需要逐项处理。
第二父提交 `7bb1824` 仍保留在已合并历史中，重新合并同一来源提交不会自动恢复被撤销的
改动。若以后需要恢复原融合，通常需先撤销该回滚提交，再核对后续变更与兼容性。
本次没有 schema 迁移；回滚不涉及数据库、运行数据或历史统计，不得通过覆盖运行数据或
重算旧统计回滚。
