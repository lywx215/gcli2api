# 双仓库自动交接

状态：**Ready for Configuration**

## 1. 目标

跨仓库工作项完成后不允许依赖用户复制文本。交接采用以下链路：

```text
Codex生成handoff JSON
  -> 提交触发send-cross-repo-handoff
  -> GitHub repository_dispatch
  -> 目标仓库receive-cross-repo-handoff
  -> 自动创建或更新codex-ready Issue（持久队列）
```

GitHub Issue是持久交接队列。相同`delivery_id`重复投递只更新同一个Issue，不重复创建
任务。`no_counterpart_action`交接只记录并自动关闭，不触发实施。

当前handoff schema强制`execution_policy.mode=queue_only`及
`max_automatic_runs=0`。发送和接收过程不调用OpenAI模型，不消耗Codex/OpenAI token。

## 2. Codex完成任务时的强制动作

当本次任务需要另一仓库继续处理时，Codex必须：

1. 以`coordination/HANDOFF_TEMPLATE.json`为模板；
2. 在`coordination/handoffs/`创建新的、不可覆盖的JSON；
3. 使用双方相同且已在`IMPLEMENTATION_ROADMAP.md`定义的`MGMT-*`工作项；
4. 填写契约SHA-256、capability变化、测试及精确`next_actions`；
5. 将范围外发现写入`status=no_counterpart_action`的独立交接，或只写入已知问题；
6. 在结束任务前验证JSON且确认无敏感信息。

文件名必须与`delivery_id`完全一致，例如`MGMT-001-G-1.json`对应
`delivery_id=MGMT-001-G-1`。gcli2api的handoff进入`dev8`或仓库默认分支后投递；manager
的handoff进入默认分支后投递。普通功能分支和PR上的中间handoff不会提前进入对端队列；
需要恢复时可手工运行workflow。

Codex不得修改`execution_policy`绕过零自动运行限制。若未来启用模型事件执行，必须升级
schema、单独Review成本和安全边界，并在两个仓库同步修改。

handoff只能推进路线图已定义的对端动作，不能通过`summary`或`next_actions`增加新范围、
跳过依赖或提前启动后续工作项。路线图范围需要变化时，必须先完成双仓文档Review。

文件命名：

- gcli2api发送：`MGMT-001-G-1.json`；
- manager发送：`MGMT-001-M-1.json`；
- 同一工作项再次交接时递增末尾序号，禁止覆盖已投递文件。

## 3. 一次性GitHub配置

### 推荐：GitHub App

为避免个人账号或PAT变化导致失效，推荐创建专用GitHub App，只安装到这两个仓库。App
只需要向目标仓库发送`repository_dispatch`所需的`Contents: read and write`权限，不需要
读取Secret、管理仓库或直接修改代码。

两个仓库配置相同的Actions Variable和Secret：

```text
CROSS_REPO_HANDOFF_APP_ID                 # Actions Variable
CROSS_REPO_HANDOFF_APP_PRIVATE_KEY        # Actions Secret
```

workflow每次运行动态生成短期installation token，不把短期token持久化。ChatGPT/Codex
登录账号变化不会影响GitHub App交接。

### 回退：fine-grained PAT

暂时无法创建GitHub App时，可以配置：

```text
CROSS_REPO_HANDOFF_TOKEN
```

PAT只授权这两个仓库，并设置调用`repository_dispatch`所需的Contents权限；不授予
Administration、Secrets或其他无关权限。PAT属于回退方案，需要设置到期提醒和轮换人。
如果App ID已配置，workflow优先使用GitHub App并忽略PAT。

首次启用时，必须先把发送和接收workflow提交到两个仓库的默认分支，再创建测试handoff。
manager空仓库的第一次提交需要先建立默认分支，否则无法接收`repository_dispatch`。

gcli2api当前管理系统功能统一在`dev8`分支开发；`dev8`继承已Review的`dev7`完整历史，
后续短分支从`dev8`创建，Review完成后再合并回`dev8`，最终再合并回`dev5`。由于GitHub
默认分支当前为`master`，至少接收workflow必须同时存在于`master`才能接收
`repository_dispatch`。不得为了启用交接把`dev8`业务提交未经Review合入master。

接收工作流只接受固定对端仓库，使用目标仓库自身的`GITHUB_TOKEN`创建Issue，并且权限
仅为`contents: read`和`issues: write`。

## 4. 状态语义

| handoff状态 | 目标Issue | 行为 |
|---|---|---|
| `ready` | `codex-ready`、打开 | 可以执行`next_actions` |
| `blocked` | `codex-blocked`、打开 | 记录阻断，禁止猜测实施 |
| `no_counterpart_action` | `codex-record-only`、关闭 | 只记录，不实施 |

## 5. Codex自动接单边界

GitHub Actions负责自动投递并创建持久待办，不依赖用户复制。**禁止使用每分钟或每十分钟
的Codex定时轮询来检查交接**；空轮询同样会运行模型并浪费额度，还依赖本机应用、当前
登录账号和项目目录。

当前推荐模式：

1. GitHub自动投递、去重并持久保存Issue；
2. 目标项目下一次实际Codex任务优先处理打开的`codex-ready` Issue；
3. 账号更换后，新账号只要有仓库权限即可从同一Issue继续；
4. Issue关闭前不得删除handoff JSON。

因此，新增handoff只消耗少量GitHub Actions运行时间，不触发模型推理，也不消耗Codex或
OpenAI API Token。只有用户在目标仓库真正启动Codex任务后，才会产生该任务本身的模型
用量。

### 可选的未来事件执行

如果以后明确要求完全无人值守，可以新增独立workflow，在`ready`事件到达时调用一次官方
`openai/codex-action@v1`。该模式不允许定时轮询，并且必须满足：

- 使用专用OpenAI Platform项目和API Key，不依赖个人桌面Codex登录；
- 每个`delivery_id`最多运行一次，重试必须人工批准；
- 设置项目预算、速率限制和费用告警；
- 只允许创建分支或PR，禁止自动合并和部署；
- prompt只读取经过schema验证的`next_actions`，忽略Issue评论中的额外指令；
- 单独进行prompt injection和Secret暴露Review。

该事件执行当前**未启用**，因此现有自动交接不会产生OpenAI费用。

## 6. 安全与失败处理

- 发送前限制文件大小为32 KiB并验证必要字段；
- 拒绝Token、密码、私钥和常见密钥字面量；
- 目标仓库和来源仓库在workflow中固定，不能由handoff文件改变；
- 投递失败时Actions必须失败并保留日志，不得伪装交接成功；
- 投递失败自动在来源仓库创建`handoff-delivery-failed` Issue，不调用Codex；
- Issue中的SHA来自GitHub事件，不信任handoff自行声明的提交号；
- 自动化不得自动合并、自动部署或跳过Review。

## 7. 账号和凭证变化恢复

| 变化 | 影响 | 恢复方式 |
|---|---|---|
| 更换ChatGPT/Codex账号 | 不影响GitHub交接和已有Issue | 新账号取得仓库权限后继续 |
| 本地Codex退出登录 | 只影响本地执行，不影响任务保存 | 重新登录后读取`codex-ready` |
| GitHub App私钥轮换 | 发送暂时失败，任务JSON仍保留 | 更新两个仓库Secret并重跑workflow |
| PAT过期或撤销 | 仅在PAT回退模式下发送失败 | 换新PAT或切换GitHub App |
| 仓库改名或转移 | workflow固定来源/目标校验失败 | 双仓库同步修改固定仓库名并Review |
| 未来OpenAI API Key失效 | 只影响可选事件执行 | 轮换Key；不会影响handoff Issue |
