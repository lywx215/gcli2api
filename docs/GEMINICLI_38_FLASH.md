# Gemini CLI：Gemini 3.8 Flash

日期：2026-09-27。工作分支：`codex/geminicli-38-flash`；
基于 `dev0927` 的 `20cb5455834c56a4a6e989b08f29d202b294f2cc`。
本次是所有者明确授权的单模型适配例外，不恢复其他 Gemini CLI 或 MGMT 待办。

## 能力与模型列表

模型能力标识：`geminicli.model.gemini-3.8-flash`（本说明中的能力声明，
不是新增 Management API capability）。

`/v1/models` 和 `/v1beta/models` 同时公开以下组合：

- 基础 ID：`gemini-3.8-flash`。
- 思考档：`-low`、`-medium`、`-high`。
- 搜索：`-search`，可与每个思考档组合。
- 前缀：无前缀、`假流式/`、`抗截断/`，共 24 个公开 ID。
- `流式抗截断/` 仍可作为未公开的兼容前缀使用。

Gemini、OpenAI、Claude 三种生成协议共用相同 upstream ID，
后缀转为 thinkingLevel / Google Search，不把新模型映射到旧 Flash 或 Antigravity
的 `-medium` 原生 ID。不凭空新增 `gemini-3.8-flash-preview`。

官方资料核对：

- [Gemini CLI 模型定义](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/models.ts)
  将 latest Flash 定义为 `gemini-3.8-flash`，同时存在上游账户/发布开关。
- [3.8 模型说明](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash/)
  指明支持 low/medium/high，不支持 minimal。
- [GenerateContent 迁移说明](https://ai.google.dev/gemini-api/docs/generate-content/latest-model)
  列出 thinkingLevel、采样参数及预填充限制。

因此不公布 minimal 档；显式 minimal/nothinking 或无有效等级的 thinkingBudget 请求
返回 400，不默默降级为默认思考档。有效模型后缀优先于请求内的思考配置，
显式 includeThoughts 保持优先。基础模型不强制设置思考等级，采用上游默认。

## 接线检查

- 列表、别名与变体：`src/geminicli_models.py` 声明专有能力，
  `src/utils.py` 生成列表，旧模型列表和别名不变。
- 参数：仅对 Gemini CLI 3.8 去除 temperature/topP/topK/candidateCount，
  保留有效 thinkingLevel，避免共用逻辑重新注入 topK。
- 预填充：空内容清理后移除末尾 model 预填充；三种协议的抗截断续传改用
  历史 model 内容加 user 续写指令，不以 model 预填充结束。
- 续传边界：仅新模型显式开启中间 finishReason 延迟；STOP/MAX_TOKENS 在尚可续传、
  未完成且非工具调用的情况下不提前终止协议转换器。安全、工具、最终轮边界保持；
  旧模型及 Antigravity 默认行为不变。
- 凭证：按用户“参照 3.5”的要求，沿用本项目 Code Assist Standard/Enterprise 本地
  allow-list；这不是新模型上游账户权限的保证。标准/企业账户仍可能受 Google 发布开关限制。
  SQLite/PostgreSQL/MySQL/MongoDB 共用规则；新模型不是 preview，不额外要求 preview=True。
  无可用凭证时为 503，内部错误说明不再误写成 3.5。
- 统计：legacy 与逻辑请求均归为独立 `3.8-flash`，不落入 other；
  前端已有对应标签，无需重复添加。额度展示保留上游原 ID，不改历史数据。
- 边界：Vertex 模型列表、Antigravity 模型目录/别名/冷却分组、旧模型的请求默认值
  不扩展；不更新 User-Agent 版本、面板版本或审核配置。

## 验证与交付

新增 `test_geminicli_38_flash.py`：176 项通过。涵盖模型列表、全部公开组合、
兼容前缀、正常/流式/假流式/抗截断三协议矩阵、实际两轮续传、无重放、
错误配置、前端标签、四后端凭证约束和临时 SQLite 冷却。

首次针对性回归发现 Claude 续传提前完成，已通过仅新模型 opt-in 的 finish 延迟修正，
补测默认关闭、安全/工具边界及 STOP/MAX_TOKENS；未顺带修改其他模型的历史续传行为。

全量隔离回归：1414 passed, 1 skipped, 6 warnings，88.31 秒，退出码 0。
跳过项为 Windows 不支持的 POSIX fork；警告为现有 Pydantic/Starlette 弃用提示。
`git diff --check` 通过。
冻结诊断契约：73 个文件通过，manifest SHA256
`ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4`。

在隔离工作区运行：

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:PYTHONPATH='C:/Users/lywx2/AppData/Local/Temp/gcli-diag02-validation-deps'
$regressionFiles = @(rg --files -g 'test_*.py' -g '!tests/**')
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/run_diagnostic_tests.py -c pyproject.toml --asyncio-mode=auto -q tests @regressionFiles --tb=short
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/verify_diagnostic_contract.py
git diff --check
```

不调用真实模型或生产接口，不读写真实凭证、数据库或 Volume。
SQLite 使用临时库；其他数据库/Redis 使用模拟。未做上游账号权限与线上可用性验证。
本轮没有启动 Claude 审核，没有提交、推送、合并进审核中的 dev0927 或部署。
数据库 schema 和 Management API schema/capability 均不变；
manager 无需动作（`no_counterpart_action`）。回滚仅撤回本次代码，不迁移或重算历史数据。
