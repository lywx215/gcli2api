# fork 源近期更新审计（2026-10-18）

## 结论与比较依据

本次不直接合并 fork 源提交。Argon 周额度显示和客户端版本标识升级采用本分支的针对性实现；工具 schema 清洗列为后续有条件候选，其余请求处理变更另行评估或排除。

- 上游：[su-kaka/gcli2api](https://github.com/su-kaka/gcli2api)。
- 本地比较对象：`new-ui` 的 [`11cbaa6864d01a09afc268345fb242e42bb6ea57`](https://github.com/lywx215/gcli2api/commit/11cbaa6864d01a09afc268345fb242e42bb6ea57)。
- 共同历史基线：[`87f56c8cb088f25c58d947d54424cc889ae7c9aa`](https://github.com/su-kaka/gcli2api/commit/87f56c8cb088f25c58d947d54424cc889ae7c9aa)，2026-09-14。
- 已核实的上游最新提交：[`d7e97ec1bbba25e8864539bb89adbd6ae226fd83`](https://github.com/su-kaka/gcli2api/commit/d7e97ec1bbba25e8864539bb89adbd6ae226fd83)，2026-10-16。
- [上游相对共同基线的完整增量](https://github.com/su-kaka/gcli2api/compare/87f56c8cb088f25c58d947d54424cc889ae7c9aa...d7e97ec1bbba25e8864539bb89adbd6ae226fd83)：47 个提交、17 个变动文件。该数量包含自动版本提交与合并提交，不等于 47 项独立功能。

审计重点为最近 30 天，同时以共同历史基线检查遗漏。下表日期采用上游提交时间的 UTC 日期。上游提交未进入本分支历史，不直接等同于本分支缺少该功能；以下结论同时比较最终行为。

## 功能覆盖与候选

| 分类 | 上游提交与日期 | 本分支现状 | 处置结论 |
| --- | --- | --- | --- |
| 已覆盖，针对性补齐 | [`b6cf613c730bdccbe7709a7d5954c0b401994cd5`](https://github.com/su-kaka/gcli2api/commit/b6cf613c730bdccbe7709a7d5954c0b401994cd5)，2026-10-15：分组周额度、5 小时额度及客户端标识 | 已有 `retrieveUserQuotaSummary` 摘要、分组和窗口显示。上游把包含 Gemini 的分组统一简称 Gemini，无法直接保证 Argon 专属名称不被合并显示。上游最终客户端标识为 1.3.1。 | 本次独立保留 Argon 分组及额度名称，并采用已确认的官方 CLI 1.4.0 标识；不整体合并该提交。 |
| 后续有条件候选 | [`7521489aba3b48716b2b0eef331432d1c10bfefe`](https://github.com/su-kaka/gcli2api/commit/7521489aba3b48716b2b0eef331432d1c10bfefe)，2026-09-28；经 [`6d9bf5bc8c628543748fe2c8b55e1eeb7f62c857`](https://github.com/su-kaka/gcli2api/commit/6d9bf5bc8c628543748fe2c8b55e1eeb7f62c857) 于 2026-10-09 合入：工具 schema enum 清洗 | 两种 schema 清洗路径尚无完全对应的 boolean enum 移除和数值 enum 字符串化处理。实现位于共享 OpenAI 到 Gemini 转换器，同时影响 Antigravity 与 Gemini CLI。 | 先验证 Antigravity 确有需要，分别确认 Gemini schema 与 `parametersJsonSchema` 的枚举语义；保留数字与 boolean 约束的兼容性回归。不得把全部 enum 无条件字符串化后直接合入，也不借此恢复 Gemini CLI 专属开发。 |
| 部分覆盖，另案评估 | [`c597643c1aba49a53493d75734d86bab54f9aae1`](https://github.com/su-kaka/gcli2api/commit/c597643c1aba49a53493d75734d86bab54f9aae1)，2026-10-16：Gemini 4、Claude 5.5 路由思考配置与禁预填充 | 本分支已经实现 Opus 5.5 路由和旧模型退役。Gemini 4 的思考配置剔除、所有模型统一禁预填充尚不等同于现有策略。 | 属于模型请求处理行为，单独验证模型档位、思考设置和历史消息兼容性；不纳入此次额度显示。 |
| 收益部分已覆盖，不直接移植 | [`44a9b2626539fffdc2ffe9749c9bbcd9fa702c7a`](https://github.com/su-kaka/gcli2api/commit/44a9b2626539fffdc2ffe9749c9bbcd9fa702c7a)，2026-10-08：抗截断中的普通文本实时透传、避免兜底重发和补齐结束原因 | 上游该处理器采用合成工具架构；本分支采用 `[done]` 标记续传，已有普通文本实时透传、部分输出后防重放和统一错误保护。 | 架构不兼容，不能直接 cherry-pick。若后续确有结束信号缺陷，针对本分支复现后修复，并覆盖流中断、续传、工具调用和结束信号仅发送一次。 |
| 排除 | [`ffd8828e03030fea06d8f0e1d0570278737625d9`](https://github.com/su-kaka/gcli2api/commit/ffd8828e03030fea06d8f0e1d0570278737625d9)，2026-10-15：删除 Gemini CLI Preview 路径与相关存储字段 | 本分支要求保留现有 Gemini CLI 接口、配置和数据；该渠道的维护停止不构成删除授权。 | 不合并。已取消的统一管理后续工作同样不恢复。 |

上游一键自动更新曾由 [`76d1900d14cea962dd71f6d4d011d23efbc4de9f`](https://github.com/su-kaka/gcli2api/commit/76d1900d14cea962dd71f6d4d011d23efbc4de9f) 于 2026-09-29 引入，并在 [`dcc3de15274c3c4ca05caef0c2cafbaa37dcf60f`](https://github.com/su-kaka/gcli2api/commit/dcc3de15274c3c4ca05caef0c2cafbaa37dcf60f) 于 2026-10-11 删除接口、脚本和入口。无需引入这组已撤回的历史功能。

## 整体合并的兼容与敏感信息风险

- 周额度提交 `b6cf613` 同时把模型请求、模型列表和额度查询的端点固定为 `https://daily-cloudcode-pa.googleapis.com`，绕过原有配置。该行为超出额度显示需求，不随显示改造引入。
- 转换器提交 [`413b8b9e61c89702a3e217126b9887ba07f1214e`](https://github.com/su-kaka/gcli2api/commit/413b8b9e61c89702a3e217126b9887ba07f1214e)，2026-10-10，包含将 `return_thoughts` 固定为 `True`、直接打印原始 text 列表或 part 的变更。整体移植会破坏现有配置快照行为，并可能使请求内容进入日志。
- 周额度提交 `b6cf613` 包含项目标识、原始额度响应与错误正文日志。若后续抽取必要行为，应继续使用安全字段白名单及脱敏日志，不输出完整响应、账号标识、凭证或原始请求内容。
- 工具 schema 清洗候选本身不要求新增账号数据或日志；风险主要在共享转换行为及枚举类型语义。后续必须保留现有响应脱敏、逻辑请求预算和部分输出后不重放的保护。

## 验证与交付边界

本记录依据提交历史、上游补丁与本分支代码进行静态审计。未执行上游合并、部署或模型生成验证；候选不得标记为已验证通过。此次没有数据库迁移、Management schema 或 capability 变更，manager 侧为 `no_counterpart_action`。

后续若采纳候选，应只抽取明确需要的行为，补充相应转换器或流式回归，并保持现有 Gemini CLI 与管理接口兼容；不得直接整体覆盖已包含本分支保护逻辑的文件。
