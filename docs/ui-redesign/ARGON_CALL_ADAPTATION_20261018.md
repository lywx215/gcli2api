# Argon 调用适配与权限隔离（2026-10-18）

## 交付范围

基线为 `new-ui / 11cbaa6`。本轮仅实施 Antigravity Argon 调用适配；保留既有周额度展示、客户端 `1.4.0` 和面板版本 `new-ui-20261018-1023`。不重新生成版本，不提交、推送或部署。工作树中其他并行 UI 工作保持原样。

## 模型与请求语义

- `gemini-4-argon` 固定解析为 `gemini-4-argon-low`，Low 无权限时返回不可用，不改投其他档位。
- `gemini-4-argon-high / medium / low` 完整原生 ID 保留；OpenAI、Claude、Gemini 三协议及流式、非流式和既有功能前缀使用同一映射。配置不能跨档位劫持这些名称。
- `gemini-4-argon-disabled` 在协议入口和共享 API 本地拒绝，HTTP 404，不查号、不发送生成。
- 档位由 ID 决定，移除冲突的 `thinkingBudget / thinkingLevel`；`includeThoughts` 保持现有返回思考内容设置。
- Argon 保留有效客户端输出 token 上限，并限制在 1–64000；缺失或非法值沿用 64000 默认。其他模型保持原上限规则。
- 显式路由的符号参数规则、受保护名称和源码指纹同步更新。公开列表仅发布目录证据确认的原生 Argon 档位及既有功能变体；配置本身不是权限证据。裸名和自定义 Argon 别名可以调用，但不公开。

## 权限与持久化

使用官方 `fetchAvailableModels` 中精确原生档位的存在和启用状态判断权限。`disabled:true`、`enabled:false`、畸形条目和 disabled 占位项不能授予权限；是否出现额度桶不参与权限推断。

现有 `model_access_state` JSON 新增可选顶层 `argon: {families, routes}`。Opus 的 `MODELS / ROUTES / FAMILIES`、schema_version=2 和兼容投影不变；缺失或损坏的 Argon 扩展为 unknown，不破坏 Opus。没有新表、列、迁移或批量回填。

候选选择复用目录查询、30 秒选择预算、10 秒查询阶段、120 秒租约、12 小时证据有效期及失败退避。未知或过期权限不能发送生成；查询失败不制造授权。最终 `quota_admit` 对所有 Argon 用途再次核对精确档位、凭证身份和并发版本；替换凭证、撤权和准入竞争都不能复用旧证据。面板手动测试同样在发送前检查所选账号，未知或过期证据在现有面板预算内查询；旧测试入口也无法绕过最终门禁。disabled 在两个面板入口读取凭证前拒绝，普通 Opus 的人工恢复语义保留。

生成正文输出前收到 404 时，仅暂停当前凭证的 Argon 家族，在原重试预算内换号；不禁用账号、不影响 Opus。正文输出后不重放。没有合格凭证使用现有安全错误格式返回 HTTP 503。生成成功不能替代官方目录证据授予或续期权限。

面板现有 `panel_capabilities` 在存储就绪且具备最终门禁时声明 `antigravity.model_access.argon`。Management 协议、schema/capability 和 manager 行为不变，无对端动作（no_counterpart_action）。

## 冷却与周窗口

三档共用本地 `argon-shared`，覆盖选取、准入、429 结算、清除和人工恢复；与 `gemini-shared`、`claude-gpt-shared` 独立，不复制其他组的额度比例。该本地保护域不表示所有套餐的上游配额都物理独立。

仅在 Argon 目录重置时间命中既有 168h 异常判定时，使用现有 `retrieveUserQuotaSummary` 做一次可选交叉确认：必须同时匹配精确桶 `gemini-argon-wtu-weekly`、`window=weekly` 和同一重置时间，才标注已验证周窗口。摘要受原预算及最多 2 秒子时限约束，并留出结算时间；失败保留原保护和已成功目录证据。普通模型、相似桶、其他窗口及不匹配时间不能获此豁免。

## 验证记录

最终一次组合回归覆盖 39 个相关后端测试文件：**2406 passed，6 项既有警告，47.07 秒**。其中 5 个新增 Argon 文件共 **345 项**，分别为模型映射 241、权限 31、冷却 29、共享 API 23、面板手工入口 21。覆盖三协议/前缀/流与非流、精确档位、16 token 上限、禁用/未知/过期/目录超时、租约与身份替换、最终准入竞争、404 换号及正文后不重放、Opus 旧投影、模型目录和显式配置、冷却/手工恢复、旧 API 错误、Management 契约和版本。

前端选定额度文件分两次运行：QuotaCard **16 passed**；AgQuotaEvidence 与 LegacyModelQuota **45 passed**，合计 **61 项**。本轮没有改动 Argon 额度 UI，没有重新生成面板号或重建、重启预览。源码差异检查通过；路由源码指纹与当前实现匹配。

新增合成测试可单独复跑：

```powershell
python -m pytest -q test_antigravity_argon_mapping.py test_antigravity_argon_access.py test_antigravity_argon_quota.py test_antigravity_argon_api.py test_antigravity_argon_manual.py
```

### 私有隔离实测

真实账号仅复制至用户私有目录中的隔离 SQLite，原库以只读方式读取。混池包含一个目录有权限账号和一个仅有 disabled 占位的对照账号。原应用选择器、最终 quota_admit 与实际 HTTP 发送均被观察验证；没有用替代选择逻辑绕开应用。

| 请求 | 实际选择 | HTTP / 结束 / 正文 | 耗时 | 发出上限 |
| --- | --- | --- | --- | --- |
| gemini-4-argon-high | 有权限账号 | 200 / STOP / 有 | 2.891 秒 | 16 token |
| gemini-4-argon-medium | 有权限账号 | 200 / STOP / 有 | 16.421 秒 | 16 token |
| gemini-4-argon-low | 有权限账号 | 200 / STOP / 有 | 10.813 秒 | 16 token |

恰好 **3 次真实生成，无重试**；每次固定短提示并受 45 秒上限约束。传输拦截器在发送前核对精确模型、16 token、实际选择及准入账号、当前令牌归属、固定提示和 UA 1.4.0，并阻止错误账号、第四次发送和未开启的生成。三个请求保留独立原生 ID；官方响应均报告实现版本 `gemini-4-argon-trial`，不据此合并档位或推断其他权限。

仅对照账号的池发起裸名请求，解析为 Low 后本地 **503、官方生成请求 0 次**；混池裸名通过拦截的合成 SSE 确认发送 Low，不额外消耗真实生成。隔离准备包含 3 次官方目录读取和 1 次必要 OAuth 刷新，刷新只写隔离副本；另做的目录/摘要结构核对均为只读额度请求。

原 Antigravity 全部凭证名称及内容集合摘要在测试前后相同。`65476` 预览记录原字节、禁生成设置和面板版本文件原字节均保持。只含状态、计数和短标签的验证记录保留为本地任务产物，私有副本和一次性生成计数标记保留，未加入 Git。合成测试及仓库 fixture 只包含虚构身份；真实令牌、项目、正文和凭证 JSON 不进入源码、日志或提交。

已有凭证页 14 项失败及 1 个未处理 AbortError 不属于本轮修复；没有将其标为通过，也不宣称完整前后端套件通过。

## 回滚

1. 先在调用端或反向代理阻止所有 Argon 名称、功能变体和指向 Argon 的自定义路由，并停止承担 Argon 请求的进程。
2. 仅恢复本轮涉及的模型目录、转换器、model_routing、三个协议入口、共享 API、权限 JSON 处理、冷却策略及面板 capability 代码。保留此前额度展示、UA 1.4.0、面板版本和其他并行改动，避免直接清空工作树。
3. 重启对应服务并验证普通 Gemini、Claude、Opus 和旧接口。无数据库迁移或回填需要撤销；旧读写保持可读，缺失新命名空间按未知处理。
4. 回滚后的旧代码缺少 Argon 精确映射和权限隔离，不能继续承担 Argon 调用。保持入口阻止，直到恢复本修复或验证过的替代实现。

原预览端口 `65476` 的模型生成限制保持，不通过预览端口执行本轮真实生成。
