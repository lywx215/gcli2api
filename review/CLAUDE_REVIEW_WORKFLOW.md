# gcli2api 本地 Claude Review 流程

## 启动入口

在当前 gcli2api 仓库或其 worktree 的 Codex 任务窗口发送：

```text
请 Claude 审核：本次任务说明、需要审核的方案或实现文件
```

也支持 `启用 Claude 审核：本次任务说明` 或 `/claude-review 本次任务说明`。
普通“继续”不会启动审核。询问如何审核、配置审核环境或讨论 Claude 不会启动审核。

主目录为 `G:\code\gemini30\gcli2api`；使用 worktree 时，以该 worktree 根目录作为项目目录。
共享 Hook 从任务工作目录向上查找 `.codex/review.json`，不会自动读取其他 worktree 的配置。
因此命令、方案及文件检查都应指向本次任务的实际工作区，不应因为项目默认目录不同而切换到主目录。

## 共用组件

| 项目 | 位置或值 |
| --- | --- |
| 项目文件范围配置 | 当前项目目录下的 `.codex/review.json` |
| 本次方案文件 | 当前项目目录下的 `.codex/review-plan.md`，启动后由 Codex 创建或更新 |
| 用户级 Hook 注册 | `C:\Users\lywx2\.codex\hooks.json` |
| 共享执行脚本 | `C:\Users\lywx2\.codex\review\hook.py` |
| Claude CLI | `C:\Users\lywx2\.local\bin\claude.exe` |
| Codex 开发与验证模型 | GPT-6 Astra（`gpt-6-astra`），创建或继续任务时显式指定 |
| 审核模型 | `claude-opus-5-5`，由实际 Claude CLI 执行 |

这是其他已接入项目使用的同一套流程。本项目不复制 Hook 注册或执行脚本。
这些用户级路径是本机配置引用；提交项目配置不会在其他机器上自动安装 CLI 或注册 Hook。
`review/` 中已有的专题审核文件是历史记录，不是新任务的默认审核提示词。

`.codex/review.json` 同时保留通用代码、前端、脚本、文档、协议和部署文件范围，以及本项目
`review/**/*.md`、根目录测试与维护范围文件的既有覆盖。配置枚举当前文件，不只查看 Git diff；
符合范围的未跟踪或被忽略测试也会被纳入。`.gitignore` 仅为该审核配置增加 JSON 例外，
其他 JSON/凭证文件的忽略规则保持原状。

## 执行顺序

1. 用户明确启动审核后，Codex 为本次任务创建或更新方案文件。旧方案未经更新不会直接进入审核。
2. Stop Hook 调用 Claude 审核方案，返回具体问题；Codex 核实后修正。
3. 方案通过后，Codex 实现并进行相关验证，再由 Claude 审核本次实现。
4. 方案与代码审核合计最多自动执行3轮。仍有问题时，汇报剩余问题并等待用户确认。
5. 用户发送 `继续 Claude 审核` 后，最多再执行3轮。审核调用失败时如实报告结果，允许其他工作继续。

审核可针对未提交的本地文件进行，无需 Git 提交或推送。普通的新用户消息会关闭旧任务的审核；
继续审核应使用明确的 `继续 Claude 审核`。各任务的状态按项目路径和 Codex 会话ID分别保存。

审核期间保持被审文件稳定；修复后重新验证并在允许的轮次内复审。报告区分历史 findings、
Codex 修复情况、本地测试结果和实际 Claude 结论，不把旧快照批准或本地测试通过当成新代码审核通过。

## 无法启动时

- 确认任务工作目录属于本次仓库或 worktree，且该项目的 `.codex/review.json` 存在。
- 确认使用了上述明确启动语句；不要另建审核流程。
- 在 Codex CLI 中可通过 `/hooks` 检查用户级 Hook 是否加载并已受信任。Hook 需要信任时，按界面提示操作。
- 如审核命令未加载，汇报实际状态，不得声称 Claude 已完成审核。
- 如提示 CLI 版本不足，核对使用的绝对路径；本流程使用 `.local\bin` 的 CLI，避免调用旧 WinGet 版本。

项目配置与这份说明没有启动任何实际 Claude 审核，也不单独授权提交、推送或发布。
