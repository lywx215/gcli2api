# DIAG-01 交付记录：待审核

## 定位与基线

- 项目：gcli2api。
- 隔离 worktree：`C:/Users/lywx2/.codex/worktrees/e63f/gcli2api`。
- 分支：`codex/diag-01-antigravity-cleanup`。
- 基线：`cb706830a33d9275abac2cca78eadf2c28504a7f`。
- 启动核验：Git 根目录等于上述 worktree，HEAD 完整匹配锁定基线，工作区干净；从该 HEAD 创建指定分支。未复用 dev0916 或其他旧工作区。
- 最终提交完整 HEAD 由任务最终交付消息给出，可在此分支用 `git rev-parse HEAD` 核验。
- 只读任务来源：`G:/code/gemini30/CLIProxyAPI/coordination/diagnostics/20260924/DIAG-01.zh-CN.md`，已完整读取；本分支 `AGENTS.md` 已读取。
- 不涉及共享追踪契约或管理契约修改，契约来源 SHA 不适用；Management schema/capability 不变，manager 无配套动作（`no_counterpart_action`）。

## 文件与行为

1. `src/converter/antigravity_fix.py`：只修改 `normalize_antigravity_request` 内的消息清理。
   - 先合并/转换 text 并执行 `rstrip`，再判断 part 是否有效，防止纯空白字符串、合并后为空的列表留下空消息。有效正文的前导空白保留；空值本身不转换成伪正文。
   - 将原 no-prefill 循环移到空 part/content 清理之后，避免空 user 删除后重新暴露末尾 model。
   - no-prefill 仍使用映射后模型名及原有五个关键词：`opus`、`sonnet`、`gemini-3.6-flash`、`gemini-3.7-flash`、`gemini-3.8-flash`；继续删除连续末尾 model，不补用户消息或 continue。
   - text 列表、异常类型、无效 part、空 content 及 no-prefill WARNING 使用索引、类型、长度或数量摘要，不插入正文、工具参数、自定义键名或客户端 role/model 字符串。
2. `test_antigravity_message_cleanup.py`：新增 69 个参数化测试实例，全部使用合成输入。
3. `docs/diagnostics/DIAG-01-delivery.md`：本交付记录及可审核样例。

模型映射、Claude 既有思考块/工具 ID 处理、工具 schema、图片专用路径和错误策略均保留。全部消息清空时返回 `contents: []`；现有代码没有专门的本地空消息错误，仍由下游处理，路由沿用既有错误返回路径。测试在 API 边界模拟 400 INVALID_ARGUMENT，验证原生 Gemini 非流式和普通流式均返回相同错误，无补造内容。

## 验证命令与结果

以下命令在本 worktree 的 PowerShell 中执行。普通回归关闭日志，存储兜底与 pytest 临时文件均限制在本 worktree 的 `.pytest_cache` 下；远程存储配置仅在测试进程环境清空。

```powershell
$env:ENABLE_LOG='0'
$env:CREDENTIALS_DIR=Join-Path $PWD '.pytest_cache/diag-01-storage'
$env:MYSQL_URI=''
$env:POSTGRESQL_URI=''
$env:MONGODB_URI=''
$env:REDIS_URL=''
```

首次相关回归：

```powershell
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' -m pytest test_antigravity_message_cleanup.py test_antigravity_request_compat.py test_antigravity_model_catalog.py --basetemp=.pytest_cache/diag-01-related-1 -q
```

退出 1：84 passed、1 error、5 warnings。错误来自日志测试 `tmp_path` 建立目录时父目录 `.pytest_cache` 尚不存在，未进入该测试主体；没有功能断言失败。

建立临时父目录后重跑：

```powershell
New-Item -ItemType Directory -Force .pytest_cache | Out-Null
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' -m pytest test_antigravity_message_cleanup.py test_antigravity_request_compat.py test_antigravity_model_catalog.py --basetemp=.pytest_cache/diag-01-related-2 -q
```

退出 0：85 passed、5 warnings。

完整回归：

```powershell
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' -m pytest --basetemp=.pytest_cache/diag-01-full-1 -q
```

退出 0：432 passed、6 warnings。包含现有管理 API/OpenAPI、Legacy、存储、转换、Antigravity 流式与模型测试；运行既有测试不代表恢复 GeminiCLI 或管理系统开发。

环境：Python 3.12.14、pytest 9.1.1。现有警告为 5 处 Pydantic class-based config 弃用及 1 处 Starlette TestClient/httpx 弃用；未扩大范围处理。

`git diff --check`：退出 0，无空白错误。

日志专项在上述回归内使用独立 Python 子进程：`ENABLE_LOG=1`、`LOG_LEVEL=warning`、`LOG_FILE=<tmp_path>/cleanup.log`、`cwd=<tmp_path>`。正文通过 stdin 传入；配置读取 mock，未访问真实数据库。检查实际日志文件及 stdout/stderr 均不含合成敏感标记，且包含预期结构摘要。

## 脱敏样例与覆盖

所有测试输入均为人工合成，不来自用户历史或真实模型调用。可执行样例位于 `test_antigravity_message_cleanup.py`。实际隔离日志位于本 worktree 的 `.pytest_cache/diag-01-full-1/test_cleanup_warning_output_co0/cleanup.log`（不提交临时文件）。稳定的日志样例如下，索引从 0 开始：

```text
[WARNING] [ANTIGRAVITY_FIX] text 字段是列表，自动合并: content_index=0, part_index=0, type=list, length=2
[WARNING] [ANTIGRAVITY_FIX] text 字段类型异常，转为字符串: content_index=0, part_index=1, type=dict
[WARNING] [ANTIGRAVITY_FIX] 移除空的或无效的 part: content_index=0, part_index=2, field_count=1
[WARNING] [ANTIGRAVITY_FIX] 跳过没有有效 parts 的 content: content_index=1, part_count=1
[WARNING] [ANTIGRAVITY] 不支持预填充，移除了 1 条末尾 model 消息
```

例如 `gemini-3.7-flash` 的合成输入 `[user("question"), model("answer"), user(" \t\n")]` 清理后为 `[user("question")]`；同样输入在 `gemini-2.5-flash` 下保留前两条有效消息。

覆盖普通多轮、末尾空 user、连续空消息、ASCII/Unicode 空白、字符串列表/字典 text 转换、混合有效 part、图片 part、工具调用/响应及两种命名、Claude 工具 ID 配对、全空列表、不受 no-prefill 限制的模型、原生 Gemini 路由错误传播和 WARNING 脱敏。五个 no-prefill 关键词均有实例，Claude haiku 映射后不进入该策略也有实例。

## 限制与风险

- 全部清空的错误验证采用模拟上游 400，未证明生产后端返回的具体文案或状态；保留原有下游处理责任，未新建本地校验错误。
- 本次新增路由验证限于原生 Gemini 普通非流式/流式；未新增 OpenAI、Anthropic、假流式或抗截断入口的端到端测试。完整已有回归通过。
- 保留已有非 text 字段有效性与签名策略；没有重新定义签名/其他元数据单独存在的 part，也没有扩大成对所有畸形结构的校验。
- no-prefill 仍会丢弃末尾 model（包括末尾工具调用），属于原有处理政策；此次仅修正应用顺序。
- 日志改造限于此清理路径相关 WARNING，不代表全仓库日志审计或追踪模块实现。

未执行生产模型调用、部署、推送、合并、凭证/真实数据库/Volume 修改、追踪模块开发、GeminiCLI/管理面板开发、其他项目写入、其他开发任务派发或 Claude 审核。提交钩子按任务要求选择 `n`，`panel-version.txt` 保持不变。当前状态仅为“待审核”，由协调窗口针对准确提交执行独立检查及 Claude 审核后决定放行。
