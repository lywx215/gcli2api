# Antigravity 额度保护与响应完整性

实现基线：`dev0927` / `4232efcd8046d0c78c0f60602b078607345886ff`。
本次仅实现 Antigravity 和必要共享基础设施；未部署、未迁移生产数据库、未使用真实凭证发起额度或模型调用。Gemini CLI 与已终止的中央管理项目不恢复开发。

## 依据及解释边界

用户提供的本次独立日志包含 139 次原因不明确的 429、9 次明确额度耗尽、2 次容量 503、5 次缺终态（其中 2 次仅思考）。它与较早日志不关联；历史泛化 429 不能通过本次代码改动追溯成确定原因。

既有两次官方额度查询返回 `remainingFraction=1`，查询相隔 51 秒，reset 也后移 51 秒，均为查询时间加 168 小时。100% 是上游值；此前查询没有进行模型生成，也没有证明真实可用额度。动态 168 小时触发拦截是用户要求的本地保护策略，并非声称官方返回零额度。本轮没有重复这些查询。

用户提供的方案已经完成三轮 Claude 方案审核。后续用户已另行授权代码审核，逐轮发现与状态记录见 `review/ANTIGRAVITY_QUOTA_CODE_REVIEW.md`；测试结果不代替审核结论。

## 冷却及状态

作用域为 Antigravity × 单个凭证 × 冷却组，先去功能前缀并解析兼容别名，再归组：

| 组 | 范围 |
| --- | --- |
| `claude-gpt-shared` | `claude-*`、`gpt-oss-*`，包括 Opus 5.5 Low/Medium/High、Sonnet 4.6、GPT-OSS 120B Medium，Opus 4.6 Thinking 及其历史冷却键 |
| `gemini-shared` | 全部 `gemini-*`，包括 high/medium/low/tiered、Pro Agent、旧版、Lite、图像模型 |
| 其他 | 未知模型各自独立 |

两组分别计时。Claude/GPT 剩余 41 小时、Gemini 剩余 66 小时不会合并成 66 小时。保留旧具体模型键，读取时取同组最长有效期限；写入不缩短同组期限。显式清除一个模型计时冷却会清除其整组，统计仍按原模型粒度，周期不重复结算。

Opus 4.6 已恢复真实 `claude-opus-4-6-thinking` 及兼容别名；4.6 与 5.5 权限家族独立，
额度仍归 Claude / GPT-OSS 共享组。历史退役描述已由
[按版本家族权限规则](ANTIGRAVITY_MODEL_ACCESS.md) 替代，不创造 4.6 的 Low/Medium/High 档位。

`quota_group_states` 和数值 `model_cooldowns` 分开持久化：

- 无异常记录：仍检查计时冷却。
- `blocked_unknown`：该组禁止生成，恢复时间未知；计时冷却到期也不能自动放行。
- `manual_override`：管理员解除异常拦截；仍需满足计时冷却和普通启用状态。

额度快照原始 reset 接近服务端 Date＋168 小时（±60 秒）时首次拦截。缺少 Date 时只在本地请求往返不超过 30 秒且发送/接收区间支持判断时识别；坏 Date 或证据不足不猜测。后续观察保留 firstSeen，不写入不断滑动的七天截止。模型生成错误里真实的七天 quota reset 不走此识别路径。

管理员解除后，相同额度快照不会重新拦截；解除后新准入的真实业务 HTTP 429 才重新拦截，包括无法解析和容量类 429。该原因记录为 `override_failed_429`，不等同于确定额度耗尽。503、面板测试 429 和测试成功都不能触发这一恢复规则。明确 quota 错误仍能写计时冷却。

## 面板操作

打开 Antigravity 凭证额度详情，两组卡片分别显示异常状态和计时期限。原始 100% 保持原样；动态 168 小时显示“额度不可用，恢复时间未知”。分组期限由后端公共归组函数计算，面板不另做别名推断。未知模型已有的独立拦截也可显示和解除。

单组解除沿用现有面板认证：

```http
POST /creds/action?mode=antigravity
Content-Type: application/json

{"filename":"example.json","action":"release_quota_group","group":"gemini-shared"}
```

按钮明确说明“保留计时冷却”。解除动作不调用额度接口或发送恢复测试。普通启用、Credit 切换、成功回写和 100% 显示均不会清除异常状态；既有 Credit 动作对普通计时冷却的行为保留。

单凭证额度页、批量刷新、节点 `sync_cooldown` 均走同一归组事务。缺失 quotaInfo/remainingFraction、非法值为未知；只有显式合法零值是零额度。耗尽证据优先于部分正值。由于直接模型路由的全集无法可靠确定，现有同步入口不凭部分正值提前解除整组计时冷却，等待到期或显式管理操作。内部同步方法只有在调用方提供可信全集且覆盖有效具体冷却键时才允许提前解除。

## 凭证列表的共享组筛选

Antigravity 桌面和移动面板以“额度组状态”筛选 Gemini、Claude / GPT-OSS。未来计时冷却和 `blocked_unknown` 均算额度受限；`manual_override` 不解除仍有效的计时冷却。损坏额度状态与最终准入一致，整凭证受限并显示异常，不写入或修复原始数据。历史 Opus 4.6 冷却仍影响 Claude / GPT-OSS 组；其他未知模型保留独立组。

`GET /creds/status?mode=antigravity` 沿用面板认证及现有分页参数，新增筛选值：

| `cooldown_filter` | 含义 |
| --- | --- |
| `all` | 全部 |
| `any_restricted` | 任一组额度受限，包含独立组 |
| `gemini_restricted` / `gemini_unrestricted` | Gemini 组额度受限 / 未受限 |
| `claude_gpt_restricted` / `claude_gpt_unrestricted` | Claude / GPT-OSS 组额度受限 / 未受限 |
| `all_unrestricted` | 全部组额度未受限，包含独立组 |

“额度未受限”不代表凭证已启用、Opus 具有权限或容量退避结束。可与权限、启用状态、Tier、错误码、备注一起筛选；所有条件在分页前执行。旧 `in_cooldown`、`no_cooldown`、`pro_no_cooldown`、`flash_no_cooldown` 保留原有定时冷却行为，Antigravity 页面不再发送；旧 Pro、Flash 都检查 Gemini 共享冷却，不能把 Flash 改为 Claude 的别名。新值用于 Gemini CLI 或非法值返回 400。

列表成功读取共享组状态时，响应增加面板 capability `panel_capabilities: ["antigravity.cooldown.group_filter"]`，与 Management capability 分开。单条摘要增加：

```json
{
  "quota_groups": {
    "gemini-shared": {"cooldownUntil": 0, "blockedUnknown": false, "restricted": false},
    "claude-gpt-shared": {"cooldownUntil": 0, "blockedUnknown": true, "restricted": true}
  },
  "quota_state_invalid": false
}
```

同组期限取最长有效值，过期或无期限为 0；未知恢复时间不伪造未来期限。新增全局 `stats.quota_restricted`、`quota_unrestricted`、`quota_blocked_unknown`、`quota_state_invalid` 仅统计启用且非永久禁用凭证，后两项与受限数重叠，不能相加作为凭证总数。MySQL 沿用现有 `disabled` 表示，不新增永久禁用列；MongoDB 存在永久禁用字段时排除新统计。原有定时冷却计数与 Pro/Flash 历史调用统计不改写。

可选 `stats.quota_next_expiry` 是下一次可能影响统计或筛选的共享组到期时间，没有已知到期项时为 0。即使筛选结果为空，也能在到期后合并刷新缓存列表；失败重试间隔至少 15 秒，隐藏面板暂停自动查询。此刷新只读已保存状态，不查 Google、不刷新 Token、不发送生成、不解除异常拦截。

后端没有该能力时，旧列表仍可读取，新筛选返回 501；页面禁用新筛选，组统计显示“暂不可用”，不把缺少字段当作未受限。SQLite 的有界/旧查询、PostgreSQL、MySQL、MongoDB 均直接批量读取现有策略字段，不进行逐凭证额度查询或生成代次写入。额度详情没有模型卡片时仍展示保护；人工解除后刷新缓存列表，计时限制继续生效。

本次列表修复无迁移，Management schema 1.4、动作枚举和 manager 所需动作不变，`no_counterpart_action`。撤销本次修复回到已有额度保护版本时，原始限制和数据保留。验证记录见 [2026-10-04 交付](delivery/antigravity-cooldown-filter-20261004/README.md)。

## 权威准入与并发

候选筛选采用只读查询，发送实际请求前再次短事务准入，预取不代表准入。最终准入拒绝旧候选时排除并重新选择，候选耗尽才返回不可用。额度/目录查询属于控制面，可使用仍启用但被组拦截的凭证；目录查询不更新异常状态。面板模型测试必须准入，受阻时返回 503 且不发送生成请求。

SQLite 使用 `BEGIN IMMEDIATE`，PostgreSQL/MySQL 使用行锁，MongoDB 使用包含代次及状态字段的文档 CAS，准入不比较使用量计数；MySQL 查询保留 server_name 隔离。事务提交是准入边界，之后的新拦截不强杀已准入调用。管理员解除改变 revision，使旧请求不能重拦新状态。凭证代次为 UUID：每次显式导入（包括同名、相同内容及仅 access token 改变）都换代并清空权限证据和租约；普通 Token 刷新保留代次，删除重建换代。旧请求、旧查询、旧刷新和旧自动禁用不能覆盖新代次。Token 刷新、最终准入和自动禁用还比较内部凭证内容版本：旧刷新不能回写，旧预取凭证不能准入，旧请求的刷新失败或业务 403 不能禁用新内容。版本只在内部传递，不返回面板或写入凭证 JSON。并发刷新 CAS 输家可重新读取同代次已更新且未过期的 Token，不将正常竞争当凭证失效。

Antigravity 最终准入绕过 Redis，以权威存储为准；策略变更失效相关冷却缓存。单候选损坏跳过；控制面读取标记 quota_state_invalid，上传不因既有损坏策略被误报失败。普通解除遇到损坏状态返回 409，保留全部限制；需先禁用并修复持久状态，不能借普通解除静默丢弃未知冷却。存储整体不可读则结束本地请求，不发送上游。无可用凭证的受保护模型 API 保持固定 503，旧内部调用保持 500 与 LOCAL 503 元数据。

尝试票据由一次请求持有，结算在首次 await 前声明一次性所有权，避免结束/错误路径或并发关闭重复记账；票据不会作为跨进程重放接口。逻辑请求仍使用原独立统计出口，重试和续写不增加用户请求数。

项目校验和邮箱查询的控制面刷新也受内容版本保护。项目校验把凭证、套餐和既有启用/清错误动作合并为同一条件事务；同名内容变化时返回 409，不回写旧结果。邮箱缓存写入重新核对查询所用版本，不能把旧账户邮箱写到新内容上。控制面查询不因额度组拦截而发送模型生成请求。

上述两个控制入口的身份快照和条件写入不解析额度策略，额度字段损坏时仍可刷新与查询；损坏原文保持不变，面板继续标记异常，模型选择和准入仍拒绝损坏凭证。

## 响应完整性

共用校验器位于原始标准化 SSE/完整 JSON 与收集器、协议转换器之间，跟踪原始 candidate index。普通文本、完整工具调用、媒体等有效内容须配合法终态；prompt block 与候选 SAFETY/RECITATION 等合法过滤终态保留阻断语义；明确工具失败、语言限制、无图像等非成功终态允许空候选，STOP/MAX_TOKENS 保留原意且空成功仍拒绝。仅思考输出不因非成功终态而放行。EOF、DONE、usage 单独不能证明完整。

缺终态、仅思考、仅 usage、空响应、半截 JSON、无效工具调用返回 BAD_FORMAT；受保护协议在未提交响应时返回固定英文 502，流已开始则发送一次协议错误并结束。不完整输出不换凭证重放、不触发抗截断续写。合法终态的显式抗截断功能保留。上游显式错误、超时和取消保持其原有分类。

正文立即转发，成功终态暂存到正常结束验证后再下发，防止 STOP 后错误变成成功。终态帧携带最终 usage，避免尾部 usage 在协议转换中丢失。假流式先验证 JSON。客户端取消或未说明原因的生成器关闭不会视为成功。Antigravity 成功回写不自动清除组冷却；Gemini CLI 的成功语义保留。

## 后续 429 如何诊断

使用现有日志开关 `ENABLE_LOG=1`、`LOG_LEVEL=debug`。新增白名单记录位于普通应用日志，前缀 `[ANTIGRAVITY DIAG]`；既有 `.diag.*.jsonl` 公共 `ai-proxy-diagnostics/1` 契约保持不变。

用 `requestId` 关联逻辑请求，用 `attemptId`/`attemptNo` 分开重试；再按 instanceId/bootId、启动期匿名 credentialRef、requestedModel/executionModel、cooldownGroup、concurrentAtDispatch 分析。记录实际上游 httpStatus、白名单 reasons、有效 reset/RetryInfo/Retry-After、耗时、准入 revision、重试决定/等待与是否切凭证。已有异常观察带 quotaObservedAt，没有快照则未知，不为日志自动查询额度。

区分：明确 quota 才持久额度冷却；明确 capacity 用容量退避；泛化 429 保留 indeterminate 并有界重试。即使 SMART 关闭，泛化 429 也不会触发永久禁用或七天冷却，异常拦截和 override 恢复策略仍有效。容量 503 不再被描述为“429 没有额度信息”。日志不保存认证头、原始上游正文或凭证文件名；错误摘要只持久化白名单结构。模型/凭证/并发集中只可作为相关性线索。

## 迁移与回滚

新增字段仅在 Antigravity 凭证表/文档：`quota_group_states`（空对象语义）和 `quota_credential_generation`。不往 Token JSON 塞入策略字段。正常服务启动会执行兼容的字段检查；部署新版前应先在隔离数据库恢复副本演练。

| 后端 | 迁移资料及演练方式 |
| --- | --- |
| SQLite | `scripts/migrate_antigravity_quota_sqlite.py <明确路径>` 默认只检查；加 `--apply` 才新增缺失字段并初始化旧行 UUID；可重复执行，不隐式创建数据库 |
| PostgreSQL | `docs/migrations/antigravity-quota-postgresql.sql`，事务内 ADD IF NOT EXISTS；旧行 UUID 首次权威读取时初始化 |
| MySQL | `docs/migrations/antigravity-quota-mysql.sql`，先检查实际列，仅执行缺失项；DDL 会提交，服务启动具备重复检查；NULL 状态按空对象读取 |
| MongoDB | 可选文档字段，首次权威操作以 CAS 初始化 UUID；无需批量改写凭证文档 |

先备份并在隔离环境验证启动、冷却、解除、重启和回退，再另行执行授权的生产迁移/部署。不要让旧版本和新版本混合承接受保护凭证流量。

**回滚必须先暂停相关模型入口或凭证调度，再切回旧版本；保留新增状态。旧版本不识别异常拦截，不能直接继续承接这些流量。** 恢复到支持新状态的版本后核对两组状态，再恢复调度。

## 2026-10-05：额度证据与面板回退

单凭证 `/creds/quota` 的 `quota_groups` 是稀疏计时投影，不等同于列表的完整
`quota_summary` 投影。面板同时解释 `quota_group_states`；未知恢复时间与有效倒计时
可以同时存在。缺少证据显示未知，损坏或冲突显示受限，手动覆盖不清除有效计时。

仅当前成功查询中有效的未知阻断证据可启用普通解封。缓存、失败、损坏及矛盾响应不能
授权解封。家族权限和额度按块采用当前有效数据；当前额度字段全部缺失时才整体回退
已保存缓存，部分字段缺失不会混合旧状态。HTTP 错误和网络错误保留本次错误并显示缓存。

能力不足仍返回 HTTP 501 和原 `detail` 字符串，增量字段为
`error_code: capability_unavailable` 与具体 `capability`。页面将本次请求用到的高级
筛选一起降级，并在当前认证会话锁定；一次列表加载最多额外请求一次。
成功响应撤回能力也同步重置控件、取消跨页全选、清空选择并回第一页；
普通 200 撤回不是永久锁定，后续 200 不能解除已记录的 501 锁定。
旧定时冷却 API 参数保持兼容，Management capability 不变。

本次实现和验证以 [改善交付记录](delivery/d1004-1-improvements-20261005/README.md) 为准，
历史测试数量及审核结论不代表本次实现已通过。

## 兼容与验证

`/management/v1` 仍为 schema 1.4；新增能力标识 `antigravity.quota.protection`，仅支持所需后端方法时公布。原有主动操作结果白名单、HTTP 状态码及字段不变，面板额度响应的状态/分组字段为增量。中央管理侧无需动作：`no_counterpart_action`。未新增 MGMT 工作项、未修改 panel-version。

行为变化：历史 Gemini 具体键按全 Gemini 组取最长有效期限；部分正额度不能提前清整组；不完整 HTTP 200 变成响应格式错误；共享组成员的单模型清除影响整组。

回归使用 `python scripts/run_diagnostic_tests.py -q --tb=short`，由该 runner 隔离凭证目录/数据库并清空远端数据库和代理配置。SQLite 使用真实临时数据库；PostgreSQL/MySQL/MongoDB 使用驱动替身验证锁、CAS、代次与并发，**未连接真实远端数据库，真实后端迁移演练仍是发布前门禁**。本地 HTTP 测试使用回环假上游，覆盖三协议、流/非流、抗截断、重启、取消、工具、媒体及 usage。测试结果见 `docs/delivery/ANTIGRAVITY-QUOTA-20260927.md`。
