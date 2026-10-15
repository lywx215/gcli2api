# 共享 dispatcher 的 macOS 兼容性核对

结论：现有 hook 的核心执行路径可以在 macOS 上运行，**无需为了启动而修改源码**，前提是使用 Python 3.10 以上、有效的 Mac 官方 CLI、正确安装角色并重新配置本机 hook。这里只做了 Windows 主机上的源码审计和纯 mock 验证，尚未证明 Mac 原机调用成功。

## 已核对的兼容路径

- `hook.py:155–222` 已有 POSIX `fcntl.flock` 分支：长工作流锁非阻塞，短状态事务锁阻塞，退出时解锁关闭；不会在 Mac 导入 Windows 的 msvcrt。
- `282–292` 先用 `ANTIGRAVITY_CLI_PATH`，再找 Windows 默认位置，最后用 PATH 找 agy。设置有效的 **绝对 Mac 可执行路径** 即可避开 Windows 候选。
- `442–452` 用参数数组启动子进程，没有 shell=True、cmd.exe 或 PowerShell；工作目录、UTF-8、超时均显式指定。
- pathlib、临时目录和同目录原子替换均有 POSIX 实现。不要复制 Windows worktree 的 .git 指针；Mac 应建立独立 checkout，再按交接基线应用校验。
- 源码只依赖 Python 标准库。`1196` 使用 Path.write_text 的 newline 参数，因此需要 Python >=3.10；选择 3.12 可与此前环境一致。
- 实际开发角色位于 `~/.gemini/config/agents/codex-developer.md`，不是 review/roles。hook 仅传 `--agent codex-developer`，角色发现由官方 CLI 负责。角色自身没有 Windows 路径。

## 必须做的安装变更

1. 把共享 hook 放到 Mac 用户级位置，以**绝对 Python 路径 + 绝对 hook 路径**注册 UserPromptSubmit、Stop。原 USAGE 的 Windows 路径和 PowerShell 语法不能直接使用。hook 没有 shebang，应用 Python 显式执行。实际宿主注册语法由主任务对照官方文档确认，本审计没有读取用户 settings。
2. 安装 Mac 官方 agy 和公共开发角色；核对该版本的角色目录与命令选项。角色文件不等于文件系统沙箱，保留 dispatcher 的真实工具事件、范围、hash 和交付校验。
3. 在 Mac 用户自己的受支持登录流程完成登录。不要复制 Windows 凭证、会话、授权、请求消费记录或数据库。当前普通交接任务不授权模型探测或开发派发。
4. 确保项目、Codex home、临时目录、CLI 自己的用户目录按正常用户权限可写；不需要 sudo，也不能用权限绕过替代宿主批准流程。

零源码补丁的环境设置方式如下；示例仅配置环境，不调用模型：

```sh
export ANTIGRAVITY_CLI_PATH="/absolute/path/to/official/agy"
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
```

CLI 路径须替换为安装后验证的真实绝对路径。CODEX_HOME 使用 Mac 宿主自己的绝对可写目录，保持宿主与 dispatcher 一致；已有目录不清空、不覆盖。GUI 启动的宿主不一定继承 .zshrc，所以要在实际 hook 启动环境中传入变量。PATH 可作为替代，TMPDIR 一般保留系统默认。Claude 路径与安装不是反重力开发的前置条件。

## 精确补丁边界

**当前 TS/TSX 开发范围没有必需的启动源码补丁。** 以下区分真实行为与可选完善：

- 如果后续允许修改已存在的 Unix 可执行脚本，`1186–1197` 的临时文件替换会丢失原执行位：需记录原 stat.S_IMODE，在 replace 前恢复 mode，并使回滚保留 mode。环境变量无法让新 inode 自动继承旧权限。无补丁办法是暂不派发可执行文件，或由验收步骤按已知原 mode 明确恢复；不能对所有文件 blanket chmod +x。
- 可选：`233–246、282–288` 的 .exe/WinGet 搜索仅在 Windows 分支执行；显式路径做 expanduser/resolve 与 POSIX X_OK 检查。现有有效绝对覆盖值已可绕过，故不是当前阻断。
- `295–313、690–694` 及 USAGE 的失败提示仍写 “Windows user/Credential Manager”。需要更新 Mac 安装说明，不能把这些描述当作 Mac 的真实认证机制；提示文本本身不阻止执行。
- `137–141、1091` 对路径 casefold，在区分大小写卷上会保守合并仅大小写不同的路径。当前项目避免这种命名即可；本次不扩大为路径规则重构。

## 验证与交接限制

已执行内存 compile；抽取原函数，用 fake POSIX 环境验证绝对 CLI 覆盖、PATH 回退、两类 flock 获取/释放，以及 argv/UTF-8 子进程参数。全部通过，外部进程启动数为 0；没有生成任何 workflow 状态、授权或请求文件。真实 macOS 文件锁、CLI 安装、登录与角色发现仍须在目标机器核对。

交接包只选入公共源码、角色和说明，不打包 state、授权值、会话、请求 JSON（包括合成请求/授权状态）、凭证、数据库或日志。原 USAGE 可作为公共参考文档；其中示例并非可携带授权，不能抽出生成预置请求。后续派发必须在 Mac 新会话获得新的明确授权。

逐文件 SHA256、精确行号和验证范围见同目录 DISPATCHER_MAC_AUDIT.json。本审计未改共享 hook、角色或前端，未执行 CLI/model/网络调用。

## 2026-10-15：容量更新至16路

历史审计及其源码哈希保留在 JSON 的 `audited_sources`；本次发布源码的新哈希见 `capacity_update_20261015`。hook 只修改容量常量及两处容量提示，不改变操作系统、授权、锁或交付逻辑。Windows 上21项离线合成测试通过，覆盖16个并发任务、第17个请求在 CLI 调用前拒绝，以及旧授权、撤权、冲突和有限重试；没有真实 CLI 或模型调用。

双机预算为全局16、单机8；较小的已有授权和当前两个 Mac 模块保持原限制。Mac 需比对并安装更新后的同一用户级源码。本次仍未进行 Mac 原机执行验证，也没有创建或迁移任何授权状态。
