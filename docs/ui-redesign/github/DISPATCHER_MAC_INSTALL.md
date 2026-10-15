# Mac 安装与接入共享 Antigravity 派发器

2026-10-15。本文是操作文档，当前没有执行安装、CLI、模型调用、授权事件或派发。交接文件、项目配置、角色安装都不构成开发或审核授权。

## 交接内容与前提

交接包包含：

- `dispatcher/hook.py`：已审计的同一共享派发器源码，Python >=3.10 可用；不需要另写 Mac runner。
- `dispatcher/USAGE.windows-reference.md`：共享流程背景参考，其中 Windows 执行路径不能直接照搬。
- `dispatcher/codex-developer.md`：同一受限开发角色源码。
- `MAC_MODULES.md`、`MAC_TASK_PACKAGES.json`、必要源码与公开契约。
- 协调者提供的文件清单/哈希，用于核对完整传输。

只安装以上源码与文档。不复制 Windows 的授权/请求状态、锁、历史请求、临时 workspace、CLI 用户存储、认证、原始工具日志或私人数据库。含本机路径/授权引用的大型运行历史 BASELINE/CHECKLIST 不属于移植依赖；公开契约及实际源码已足够。

Mac 接收者先核对包清单。代码快照可能含未提交工作，不能仅检出一个旧分支代替当前文件。若允许的四个新组件/测试路径已存在，先协调，不覆盖。

## 1. 准备 Python 与官方 CLI

在 Mac 本机选择 Python >=3.10，并记录真实绝对解释器路径；GUI 宿主不一定读取 zsh 配置。下列命令仅供接收者安装时执行：

```zsh
python3 --version
python3 -c 'import sys; print(sys.executable)'
```

没有满足版本的 Python 时，按本机已批准的安装方式准备；不要把依赖安装夹入模型开发请求。

官方 macOS 安装入口将 CLI 安装到 `~/.local/bin/agy`。官方给出的单行形式是 `curl -fsSL https://antigravity.google/cli/install.sh | bash`；建议先下载、检查，再执行。[官方安装说明](https://www.antigravity.google/docs/cli/install/)

```zsh
# 在接收者批准安装后执行；这里不会自动运行。
curl -fsSL https://antigravity.google/cli/install.sh -o ./antigravity-install.sh
less ./antigravity-install.sh
# 确认脚本内容及安装选项后，单独执行：
bash ./antigravity-install.sh
```

无需 sudo。官方支持控制 PATH/旧别名处理的安装选项，修改 shell 配置前应按当前说明选择。不要自动更新或替换已有有效安装。

显式配置派发器使用的官方可执行文件路径：

```zsh
export ANTIGRAVITY_CLI_PATH="$HOME/.local/bin/agy"
test -f "$ANTIGRAVITY_CLI_PATH"
test -x "$ANTIGRAVITY_CLI_PATH"
"$ANTIGRAVITY_CLI_PATH" --version
```

这是 Mac 绝对路径，不能使用 Windows 可执行文件，也不能只写字面量 `~/...` 给宿主环境。派发器读取 `ANTIGRAVITY_CLI_PATH`，否则尝试 PATH 中的 `agy`；安装时就核准该变量，避免选错二进制。

终端 export 只影响当前终端及其子进程。**还要用宿主实际支持的环境配置方式，让调用 hook 的进程收到同一个绝对变量值。** 不假定 GUI 自动继承 `~/.zshrc`。

## 2. 本机认证

在 Mac 当前用户下交互启动官方 `agy`，完成本机登录。官方 CLI 使用 Apple Keychain；已有有效本机会话可能静默登录，否则按官方浏览器流程操作。不要从 Windows 复制任何认证文件、Keychain 导出、Token 或管理密码。[官方认证说明](https://www.antigravity.google/docs/cli/install/)

版本、模型列表和角色列表只证明安装/发现，不证明一个模型请求已经认证成功。若后续确需真实无工具健康检查，它也是模型调用，须纳入新的明确人类授权；本文没有执行或隐含授权该调用。不要因孤立后台日志字样就认定登录失败，也不要自动换认证方式或导出凭据。

## 3. 只复制派发器与角色源码

在本机选定一个用户级安装目录，示例为 `~/.codex/review`。角色使用已审计的全局位置 `~/.gemini/config/agents/codex-developer.md`。共享 hook 始终通过绝对 Python 路径调用，不要求 hook 文件有执行位。

下面是 **copy-only 手工示例**，不是自动安装器。将占位符换成实际目录。若本机已有不同内容，命令停止，先检查差异；不得覆盖其它任务的有效共享配置：

```zsh
(
  set -eu
  MAC_HANDOFF='/absolute/path/to/unpacked-handoff'
  MAC_REVIEW_DIR="$HOME/.codex/review"
  MAC_AGENT_DIR="$HOME/.gemini/config/agents"
  mkdir -p "$MAC_REVIEW_DIR" "$MAC_AGENT_DIR"

  copy_source_only() {
    if [ -e "$2" ]; then
      cmp -s "$1" "$2" || {
        printf 'Existing file differs; inspect before replacing: %s\n' "$2" >&2
        return 1
      }
    else
      cp "$1" "$2"
      chmod 644 "$2"
    fi
  }

  copy_source_only "$MAC_HANDOFF/dispatcher/hook.py" "$MAC_REVIEW_DIR/hook.py"
  copy_source_only "$MAC_HANDOFF/dispatcher/USAGE.windows-reference.md" "$MAC_REVIEW_DIR/USAGE.md"
  copy_source_only "$MAC_HANDOFF/dispatcher/codex-developer.md" "$MAC_AGENT_DIR/codex-developer.md"
)
```

`cp` 的源均是包内明确文件，不复制任何 state 目录。安装后对照清单使用 `shasum -a 256` 核对源码；不要执行 hook 来“试试”一个编造事件。

检查本机角色发现：

```zsh
"$ANTIGRAVITY_CLI_PATH" agents
```

必须实际发现 `codex-developer`，并与交接角色内容一致：受限文件工具、禁止 shell/外部服务/子委托，只在临时工作区写允许文件。角色声明不是安全边界，仍由共享派发器检查真实工具事件、文件变化及冻结输入。

官方代理说明列出全局目录；相关文档同时支持 flat `<name>.md` 与 folder `<name>/agent.md` 布局。保留已审计 flat 布局，**以当前本机实际发现为准**。若未发现，停止派发，核对本机官方支持的布局；如需调整，只放同一角色源码，避免同名双份，不修改 hook 的权限/角色参数。[Agents 说明](https://www.antigravity.google/docs/cli/commands/agents)、[Custom subagents](https://antigravity.google/docs/cli/subagents?authuser=5)

本次仅安装开发角色，不借此配置或调用 reviewer。

## 4. 将宿主事件接入同一 hook

此步骤必须按 **当前宿主实际支持的注册方式** 完成。本文不提供猜测的 Codex hooks 配置 JSON/schema，也不把 Antigravity 自己的 hooks 配置当成 Codex 宿主配置。

需要的逻辑接入只有两项：

| 宿主事件 | 调用 | 输入 |
| --- | --- | --- |
| UserPromptSubmit | 同一个绝对 Python 路径 + 同一个绝对 hook.py 路径 | stdin 为宿主真实事件 JSON |
| Stop | 同上 | stdin 为宿主真实事件 JSON |

普通事件入口不带 `--dispatch`。本次源码读取的字段如下；这是字段解释，**不是可执行或可伪造的事件样例**：

| 字段 | 来源/含义 |
| --- | --- |
| `hook_event_name` | 宿主真实事件名：UserPromptSubmit 或 Stop |
| `cwd` | 当前实际项目/工作树根路径，由宿主提供 |
| `session_id` | 当前 Mac Codex 会话的真实非空 ID；不能猜造或沿用 Windows 值 |
| `prompt` | UserPromptSubmit 的实际人类消息原文，不得拼接授权前缀 |
| `turn_id` | 宿主确实提供时保留；不要编造 |

没有完成真实事件接入前，不可派发。若现场宿主没有可配置 hooks，允许由 **Codex 基于实际人类消息和实际本机会话** 将相应事件交给同一个 hook 入口；这属于真实事件桥接，不是手工构造授权捷径。不能取得可信会话/消息上下文时停止，不派发。桥接还必须把之后的普通新用户消息送入同一入口，以正常撤销旧授权，不能只转发授权消息而漏掉撤销。

项目已有 `.codex/review.json` 可复用，或按共享源码的默认规则处理；本文件不新增该配置。配置存在、Stop、普通“继续”或模块任务单都不会自动授权审核/开发。仅开发授权时，Stop 不会自行开启 reviewer。

## 5. 在新的 Mac 会话重新明确授权

正确触发前缀为 `授权反重力开发：`、`请反重力开发：` 或 `/antigravity-develop `。必须由人类在目标 Mac 项目/会话中实际发送，不能复制旧 hook 反馈或授权状态。

**下面只是供人类审核后发送的完整新文本示例，不是此交接正在发出的授权：**

> 授权反重力开发：在当前 Mac 项目和当前会话，只实现 MAC_TASK_PACKAGES.json 中 LegacyModelQuota 与 AgQuotaEvidence 两个独立模块，各限其列明的两个新增源码/测试文件。保留冻结接口、公开契约及真实 owner/validation/票据规则；不得修改 index、CredentialDetail、App、API、Core 或共享组件。前端只能由官方 agy 经共享 hook 临时副本交付，Codex 负责核对和命令验收。默认先单路，确认交付与验收稳定后最多两路；同账号与 Windows 合计不超过八路。仅对共享派发器判定可重试的暂时性/限流失败，在每个全新逻辑请求内最多重试两次、总计三次；不重放终态失败或已消费请求，不恢复临时输出。所有测试仅用合成数据，不调用真实业务接口、OAuth 或模型生成，不读写私库/真实凭证，不部署、不提交推送、不启用审核模型。不要为了检查登录额外发模型健康请求；确需时另行说明并取得授权。

人类发出实际授权后，hook 会为本地项目/会话创建新的开发授权并反馈当前标识。只有此新反馈能填写实际请求；不从文档复制任何标识。普通新用户提示会关闭旧授权；后续工作需要当前有效的新明确授权，不以普通“继续”恢复已关闭授权。

## 6. 冻结请求、从单路到两路

按 MAC_TASK_PACKAGES.json 核对当前文件哈希、四个新路径仍不存在，以及全部必要上下文。把模块转换成普通请求：`task`、`allowed_files`、`context_files`、`acceptance` 和 hook 当前反馈的 `authorization_id`。文件路径为项目相对的单个文件，不是 glob/目录。两个模块都是普通完整 source+tests 请求，**不要加 tasks 或空 task_results**。

只有上节真实新授权明确覆盖重试时，才可在新的请求中加入：

```json
{
  "retry_policy": {
    "max_attempts": 3,
    "initial_delay_seconds": 20,
    "max_delay_seconds": 120
  }
}
```

不设置时默认一次。此 JSON 只是重试字段说明，不是可派发完整请求。

以下 zsh 示例均是占位说明；解释器路径、项目、当前会话及请求必须由协调者核准。不是让接收者直接执行未冻结任务：

```zsh
MAC_PYTHON='/absolute/path/to/python3'
MAC_HOOK="$HOME/.codex/review/hook.py"
MAC_PROJECT='/absolute/path/to/current-project'
MAC_SESSION='<actual-current-Mac-session-from-host>'
export ANTIGRAVITY_CLI_PATH="$HOME/.local/bin/agy"

# 初始仅一份已授权、已冻结、尚未消费的新请求：
"$MAC_PYTHON" "$MAC_HOOK" --dispatch \
  --cwd "$MAC_PROJECT" --session "$MAC_SESSION" \
  --request '.codex/<fresh-module-request>.json'

# 恢复至两路时，必须是另外两份真正独立且未消费的新请求：
# 两模块若其中一份已在上一步消费，不得再次放入此批。
"$MAC_PYTHON" "$MAC_HOOK" --dispatch \
  --cwd "$MAC_PROJECT" --session "$MAC_SESSION" \
  --request '.codex/<fresh-independent-A>.json' \
  --request '.codex/<fresh-independent-B>.json'
```

使用同一次命令重复 `--request` 让共享派发器原子校验/预留整个批次；不要改为两个后台命令绕过项目/会话锁。它检查写写、写上下文、路径别名及原始哈希；只读共享允许。前后依赖分批，不省略依赖以制造并行。

共享源码使用官方单轮 print + stream-json，保留实际工具事件验证。不要改成 resume/continue、跳过权限、另写 runner 或抢救临时输出。官方支持这些 headless 选项，但实际调用参数以审计过的共享源码为准。[官方 Headless 说明](https://www.antigravity.google/docs/cli/headless/)

## 7. 并发、429 与失败处理

- 从一条请求开始；只有实际稳定交付、协调者验收通过且新授权允许时才恢复最多两路。当前这两个模块若先后完成，无需为了“凑两路”额外创建任务。
- 共享工具技术容量是每批最多8路，**不是账号配额承诺**。本次运行规则要求同账号 Mac+Windows 合计不超过8；两台机器的本地锁/冷却不会自动互通，必须由两端协调者合计活动数。Mac 新授权更窄的最多2路仍适用。
- 429/RESOURCE_EXHAUSTED 时降低并发并协调两端暂停新的派发。已授权内部重试按共享冷却等待；不得另起进程、换请求名或放大槽位绕过。若要终止运行按正常取消流程，不能事后重开已消费请求。
- 只有仍运行的全新逻辑请求、当前人类授权覆盖、输入未变时，才允许 max_attempts=3。可重试暂时性/限流错误由现有 hook 分类；认证/权限/配置错误、取消、当地 print/process超时、范围外改动、哈希改变和不完整输出不作为自动重试理由。
- 部分批次成功应保留真实成功交付；失败准确记录。零退出码或空 SUCCESS 不能代替非空合规交付和后续测试。不得把原始 stdout/工具参数/认证材料放进交接文档。

## 8. 文件模式限制与验收

现有 Mac 优先包只有四个新的 TSX 源码/测试文件，普通 `0644` 模式适用。当前文件交付流程没有通用可执行位保留保证；**不得用它派发要求执行位的脚本、二进制、删除或权限变更任务**。安装 hook 本身是本地 copy-only 操作，以 Python 解释器调用，与模型文件交付分开。

作者普通最终 JSON 只需 `summary`、`changed_files`、`verification_notes`，说明命令未运行。协调者检查只改允许路径、接口/哈希/安全语义，再在 frontend 目录运行 MAC_MODULES.md 列出的 typecheck 与真实组件/适配器测试。前端编辑不能由 Codex 顺手修补；需回到当前明确授权和合法请求范围。

组件交付不是父接线完成；回传实际四文件、哈希、导出接口和命令记录。Windows 再核验后做聚合接线。基础页面支持不因此声称 full64/P3 完成，也不需要等待所有可选 leaf。

停止或卸载接入时，仅用宿主受支持方式取消相应事件注册；不要通过删除/篡改状态“重置”消费或重试计数。保留需要的审计记录，不携带到另一台机器制造授权。

---

本文依据当前共享 hook/USAGE/开发角色的只读检查与官方公开说明编写；未安装、未注册宿主事件、未运行任何 CLI 或模型，未创建授权或派发请求。包内副本最终须以协调者提供的实际清单/哈希为准。

