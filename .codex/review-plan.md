# 本次任务审核计划：模型 API 固定英文错误

## 范围

审核本工作区当前文件（包括未跟踪和被忽略的测试），以 `review/MODEL_API_FIXED_ERRORS_PLAN.md` v3 第 3–7 节为完整行为契约，以 `review/MODEL_API_FIXED_ERRORS_TASKS.md` 为任务验收要求。覆盖 ERR-01 至 ERR-05 的实际代码、测试与交付记录。重点是六个 Gemini CLI/Antigravity 生成路由在 OpenAI、Claude、Gemini 三协议和非流式、假流式、普通流式、抗截断流式模式中的固定英文错误出口、HTTP-200 error/退役识别、SSE 事件规范化、正文后错误不重放、资源关闭和逻辑统计恰好一次。

代码审核交付文件由 `.codex/review.json` 的 `src/**/*.py`、`tests/**/*.py`、`review/**/*.md`、`*.md` 枚举，不依赖 Git diff。共享 Hook 在方案阶段传空 deliverable patterns，在代码阶段才传这些模式；这不表示测试被排除。必须检查 `tests/test_model_api_errors.py`、`tests/test_model_api_error_matrix.py`、`tests/test_model_retirement.py`、`tests/test_sse_events.py` 以及 `docs/MAINTENANCE_SCOPE.md` 和交付记录。成功文本、思考、工具、多模态、公开 model/modelVersion、Vertex 默认行为、面板和取消释放均在审核范围。

## 约束

- Claude 审查阶段只读，不修改文件、不提交、不推送、不部署、不调用生产服务、不读取真实凭证；审查返回后由 Codex 单独保存原始结构化结果到 `review/MODEL_API_FIXED_ERRORS_CLAUDE_CODE_REVIEW.md`，并更新 ERR-05 报告与状态。
- 保持现有管理协议、Legacy、Vertex 默认行为和 `contracts/diagnostics/v1` 冻结内容不变。
- 由于仓库既有 `.gitignore` 忽略整个 `tests/` 目录，本次新增 `tests/test_model_api_errors.py`、`tests/test_model_api_error_matrix.py`、`tests/test_model_retirement.py`、`tests/test_sse_events.py` 明确作为本工作区本地验证交付；不提交、不推送，交付记录说明其本地保留状态。
- 核对 `docs/MAINTENANCE_SCOPE.md` 是否保留 Gemini CLI 停止维护原文并记录本工作项的有限用户授权例外；实现不得超出错误输出保护、退役识别、重放边界和统计接线范围。
- 客户端错误正文和头部不得泄露上游原始 message、模型名、响应或凭证信息；内部管理员诊断保留既有原始错误能力，遵循 v3 第 1、3.2、6 节。
- `src/router/model_retirement.py` 与 `tests/test_model_retirement.py` 属于 ERR-02 独占交付，只按现有接口和报告验收，不改动。

## 验证证据

- 全量隔离 runner：161 passed。
- 本地 FastAPI/mock 2×3×4 矩阵：39 passed。
- 管理、诊断向量、Legacy、Antigravity 与逻辑统计回归：390 passed。
- 面板、凭证工具、订阅 API、模型分层与订阅 tier 回归：78 passed。
- 诊断 runtime/service/revision/R2（使用临时进程级 `jsonschema` 依赖）：117 passed, 1 skipped, 5 warnings；其中包含取消释放、伪流式错误不走非流式转换、Reason/usage/media 检查。Vertex 源码路径未修改，冻结管理/面板契约回归通过。
- `tests/` 中的工具调用/多候选/固定模型字段/多模态相关回归已纳入 161 passed；本地矩阵另覆盖取消关闭和错误后不重放。
- 目标 Python 文件 `py_compile`、`git diff --check` 通过；冻结诊断契约目录无 diff。
- 诊断 runtime/service/revision/R2 已使用仓库既有临时隔离依赖目录 `C:/Users/lywx2/AppData/Local/Temp/gcli-diag02-validation-deps` 补齐 `jsonschema` 重跑：117 passed, 1 skipped, 5 warnings；未安装或修改环境依赖。
- 冻结契约基线复核：`HEAD` 与工作区均为 73 个文件；`contracts/diagnostics/v1/SHA256SUMS` 的 SHA-256 为 `ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4`；`git status --porcelain -- contracts/diagnostics/v1` 条目数为 0。
- 本次继续审核前执行 `python scripts/verify_diagnostic_contract.py`：73 个文件逐项 SHA-256 均匹配冻结 manifest，工作区字节与 Git index 一致；递归实际文件清单与 HEAD 清单比较无差异。
- 诊断复跑命令：进程设置 `PYTHONDONTWRITEBYTECODE=1`、`PYTHONPATH=C:/Users/lywx2/AppData/Local/Temp/gcli-diag02-validation-deps` 后，执行 `G:/code/gemini30/gcli2api/.venv/Scripts/python.exe scripts/run_diagnostic_tests.py -c pyproject.toml --asyncio-mode=auto -q test_diagnostics_service.py test_diagnostics_runtime.py test_diagnostics_revision.py test_diagnostics_r2.py`；上一轮最终结果 117 passed、1 skipped。以上是已有证据，不证明尚未覆盖的 v3 用例均通过；审核发现缺口需补验证。
- `review/MODEL_API_FIXED_ERRORS_DELIVERY.md` 已列出变更、兼容影响、完整测试证据、剩余风险、ERR-01–05 状态、无 schema/capability 变化和无需 manager 动作。

## 交付判断

2026-09-27 本组第 1 轮方案审核的唯一 finding 已落实：`.codex/review.json` 现在显式列出 `docs/MAINTENANCE_SCOPE.md`。维护范围文件也将参加代码快照摘要与审核枚举。

Claude 报告当前文件可确认的具体缺陷，包括测试覆盖与 v3 契约不符之处。审查结束后 Codex 核实、修复并运行相关测试，在本组最多三轮范围内复审。仅在代码复审通过且必要验证全部满足时标记 ERR-05 done，否则保留未完成状态与具体剩余项。Codex 在审查结束后保存审核结果并更新 `review/MODEL_API_FIXED_ERRORS_DELIVERY.md`，核对变更、兼容影响、测试、风险、各任务状态、schema/capability 和 manager 动作说明是否完整准确。

审核启动后确认：本计划对应当前 `dev0926` 工作区的集中验证结果，不复用主目录或此前 ERR-01 v3 的代码快照。
