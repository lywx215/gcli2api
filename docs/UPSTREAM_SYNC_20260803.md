# upstream/master 同步报告（2026-08-03）

## 1. 基线与范围

| 项目 | 值 |
| --- | --- |
| fork 基线 | `origin/dev6@8b7597e4e809958e14af910230c8dc0dbbc4d7d1` |
| 上游基线 | `upstream/master@3d0887ff5d9fada57842607e87abb12a8e7b4f67` |
| 共同祖先 | `4f5e3432e1d5fc5ba41cf56c99981ba89d1987f7` |
| 分叉计数 | 上游独有 9 个提交；dev6 独有 139 个提交 |
| 上游净变化 | 5 个文件，约 `+69/-155` |
| 同步分支 | `codex/sync-upstream-20260803` |
| merge commit | `b9760479a8e530d9441bd97c6936b4f1918af2b6` |

同步前重新 fetch 后，SHA、提交数量和文件范围与批准计划一致。合并提交的两个父提交依次为
`8b7597e` 和 `3d0887f`。

## 2. 上游变化与处理结论

| 文件 | 上游变化 | 自定义优先处理 |
| --- | --- | --- |
| `.gitignore` | 增加 `tests/` | fork 已有该规则；保留部署、工具和参考项目规则，不产生净变化 |
| `src/api/antigravity.py` | 安全头、深拷贝、强制 `VALIDATED`、删除会话状态、关闭连接 | 吸收安全头、深拷贝和 `Accept`；保留会话、已有 mode、共享连接及全部 fork 重试/错误契约 |
| `src/api/utils.py` | Antigravity 的 `RESOURCE_EXHAUSTED` 统一跳过冷却 | 保留 fork 精确分类；明确额度耗尽仍可持久冷却，不产生净变化 |
| `src/utils.py` | Antigravity CLI 1.1.9、Gemini 3.5 模型列表变化 | 吸收 CLI 1.1.9；保留正式版、Preview、别名和 tier 路由 |
| `version.txt` | 更新已同步上游版本 | 采用上游文件，记录功能提交 `10b4918` |

实际文本冲突仅为 `.gitignore`、`src/api/utils.py`、`src/utils.py`，与预演一致。
`src/api/antigravity.py` 虽自动合并，但会删除 fork 会话状态并加入 `Connection: close`，因此按功能块
人工复核和恢复；未使用整文件 `ours` 或 `theirs`。

## 3. 保留的 fork 契约

- SMART 429、容量保护、凭证排除、单次 sleep 和显式非流式 300 秒超时保持不变。
- TTFT 分阶段超时、首事件后禁止重放、HTTP/2、响应头对冲和每日预算保持不变。
- 统一公开错误、内部模型名隔离、日志脱敏和三种协议错误语义保持不变。
- Redis/内存 Antigravity 会话、conversation/trajectory/step 和 request ID 格式保持不变。
- Gemini 3.5 正式版、Preview、别名、订阅等级和四种存储行为保持不变。
- 未新增公开 URL、配置键、数据库字段或迁移。

## 4. 新增回归测试

`test_antigravity_model_test.py` 新增以下覆盖：

- 安全请求头白名单及核心认证头不可覆盖。
- 不发送 `Connection: close`，保留连接复用能力。
- 请求深拷贝不修改原始嵌套对象。
- 已有 function-calling mode 保留，缺失时补 `VALIDATED`。
- 同一会话保持 session/trajectory 并递增 step。
- Antigravity CLI 1.1.9 与 Gemini 3.5 正式版、Preview、别名同时存在。

既有测试继续验证通用容量压力不持久冷却、明确额度耗尽仍持久冷却。

## 5. 验收结果

| 检查 | 结果 |
| --- | --- |
| 相关测试 | `39 passed, 7 warnings` |
| 全量 pytest | `201 passed, 7 warnings` |
| Python compileall | 通过 |
| `node --check front/common.js` | 通过 |
| `git diff --check` | 通过 |
| 冲突范围 | 与预演一致，无新增文件或冲突 |
| 数据库迁移 | 无 |
| 真实额度请求 | 未执行，避免消耗生产账号次数 |
| 远端推送 | 未执行 |

同步分支完成文档提交后，应再次确认 `upstream/master` 为 HEAD 的祖先、工作区干净且相对
`origin/dev6` 仅包含本报告解释的变化，再将本地 `dev6` 快进到同步结果。远端推送仍需单独授权。
