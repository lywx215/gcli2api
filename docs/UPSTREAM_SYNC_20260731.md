# upstream/master 同步报告（2026-07-31）

## 1. 基线与范围

| 项目 | 值 |
| --- | --- |
| 本地基线 | `origin/dev6@7e7675be19714efa2af135117b6fbbc805c1994b` |
| 上游基线 | `upstream/master@4f5e3432e1d5fc5ba41cf56c99981ba89d1987f7` |
| 共同祖先 | `78f391acee42cc2b2b39bf55577c8eed80aab7e3` |
| 分叉计数 | 上游独有 13 个提交；dev6 独有 131 个提交 |
| 直接树差异 | 74 个文件，约 `+21680/-1566` |
| 三方分类 | 65 个仅 dev6 修改；8 个双方修改；1 个仅上游新增 |
| 同步分支 | `codex/sync-upstream-20260731` |

上游默认分支已通过远端 HEAD 确认为 `master`。`upstream/dev` 和
`upstream/master-backup` 的提交时间早于 `master`，本次不纳入同步。

同步前 dev6 全量回归结果：`182 passed, 7 warnings`。

## 2. 上游待同步内容

共同祖先之后的 13 个提交最终形成 9 个文件、约 `+134/-32` 的上游侧净变化：

- Antigravity Claude 工具 schema 修复及 `tests/test_gemini_fix.py`。
- Docker jemalloc、周期 GC/`malloc_trim` 和凭证管理器关闭修复。
- Antigravity/GeminiCLI 非流式请求移除显式 300 秒 timeout。
- `.gitignore`、`src/utils.py` 和 `version.txt` 更新。

## 3. 冲突与批准决策

### 3.1 文本冲突

| 文件 | dev6 行为 | 上游变化 | 已批准处理 |
| --- | --- | --- | --- |
| `.gitignore` | 保留本地工具、部署、测试和参考项目目录 | 新增 `streamchat/` | 合并双方规则；保留 `tests/`，追加 `streamchat/` |
| `src/utils.py` | Gemini 3.5 Flash/Preview 模型、别名和等级路由 | 删除 `gemini-3.5-flash` | 保留 dev6 全部 Gemini 3.5 模型 |
| `version.txt` | 当前 fork 源码元数据 | 更新到上游 `18033ab` | 使用上游元数据，作为已同步上游基线 |
| `web.py` | 分钟统计、SMART 429、hedge、存储和 HTTP 池生命周期 | 内存回收任务及凭证关闭修复 | 人工组合；HTTP 池继续最后关闭 |

### 3.2 自动合并但必须人工复核

| 文件 | 风险 | 已批准处理 |
| --- | --- | --- |
| `Dockerfile` | 上游 `LD_PRELOAD` 写死 x86_64，但 fork CI 同时构建 amd64/arm64 | 吸收 jemalloc，使用跨架构 `LD_PRELOAD=libjemalloc.so.2`，保留构建元数据 |
| `src/api/antigravity.py` | 自动采用上游后会把 300 秒改成共享客户端默认 30 秒 | 保留显式 `timeout=300.0` |
| `src/api/geminicli.py` | 同上，并可能影响 TTFT/凭证切换契约 | 保留显式 `timeout=300.0` |
| `src/converter/gemini_fix.py` | 上游 Claude schema 与 dev6 当前字段相反 | Antigravity Claude 改用 `parameters`；保留其余 dev6 转换行为 |

仅上游新增的 `tests/test_gemini_fix.py` 必须引入并扩充 GeminiCLI 和
`custom.input_schema` 场景，不得因 `tests/` 被忽略而遗漏。

## 4. 保护边界

- 禁止整文件使用 `ours`/`theirs`。
- 不新增或删除公共 URL、配置键、数据库字段和迁移。
- 15 个自定义管理接口必须保留。
- TTFT 分阶段超时、首事件后禁止重放、容量快速失败、HTTP/2、响应头对冲、
  每日对冲预算、503/`Retry-After` 和四种存储行为不得静默变化。
- 如实际 merge 出现本报告之外的冲突，停止处理并重新报告。

## 5. 验收记录

同步完成后填写：

| 检查 | 结果 |
| --- | --- |
| 实际文本冲突 | 与预演一致，仅 `.gitignore`、`src/utils.py`、`version.txt`、`web.py`；已按第 3 节解决 |
| 上游测试及扩展测试 | `tests/test_gemini_fix.py` 共 3 项，通过 |
| dev6 全量 pytest | `185 passed, 7 warnings` |
| compileall / JavaScript 语法 / diff-check | 通过 |
| amd64/arm64 Docker 验证 | 本机 OrbStack daemon 未运行；保留为现有 buildx CI 的推送前门槛 |
| 启停与资源关闭烟测 | 通过；确认 SMART/task→credential→hedge→storage→HTTP 顺序，内存任务已取消 |
| 最终同步提交 | `d35471a5c48ad3993805bf538be345b60bf2c1ac`；父提交依次为 `7e7675b`、`4f5e343` |

`git merge-base --is-ancestor upstream/master d35471a` 已通过。merge commit 处的分叉计数为
上游独有 0 个提交、同步分支独有 132 个提交；追加本报告的文档收尾提交后为 0/133。
本次未推送，也未修改 `dev6`。
