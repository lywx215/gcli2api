# 当前 Claude 复审方案：Antigravity Flash 独立请求方式

以 d1007/6245cbb 为基线，分支 codex/antigravity-flash-transport。依据 .codex/flash-transport-requirements.md；用户要求实际Claude审核且无三轮上限。本批只继续修复测试工具、合成验证、复审和交付记录，不提交、推送或部署。

## 功能实现及既有验证

1. config.py 增加 antigravity_flash_non_stream_mode 三态：inherit跟随全局，native使用generateContent，stream_collect聚合streamGenerateContent。非空ENV优先并锁定；空值视未设置。非法历史/ENV值回退inherit，保存严格枚举；GET在存储合并后返回规范化值。
2. /config/get声明 antigravity.flash.non_stream_transport。桌面/手机下拉框初始禁用，确认能力才允许发送字段；能力撤销、加载失败、退出或ENV锁定禁用并省略，使用会话及加载版本防止旧响应恢复能力。
3. API中央非流分支按最终dispatch模型选择现有RPC。支持文本Flash/Lite及现有preview/thinking/agent/档位，排除图片、tab_*及非Flash；双向别名按实际目标判断。假流复用非流，真实流及抗截断保持原实时路径。沿用准入/重试/超时/错误/统计，不在native失败后额外改用流式重发。
4. FeatureSnapshot在values之后追加默认inherit的新字段，保留旧位置参数；Antigravity捕获一次，重试使用同一快照，热更新只影响后续请求。
5. 仅Antigravity及必要共享代码，不恢复CLI或MGMT专属开发。不改管理协议/schema/panel-version、受保护路由AST、既有凭证或数据库；manager无需动作。

已完成合成/模拟测试：81个Python模块2620 passed、1 skipped（Windows不适用的POSIX SIGTERM）；新旧JS89 passed；11个保护AST与基线一致。覆盖配置/ENV/能力/快照、最终模型及别名、三协议非流/假流/真流/抗截断、重试/超时/工具调用/usage/计数。既有9个超时测试只补合成内存路由与配置初始化，保持504及单次计数断言。这些证据不能证明真实Google生成可用性。

## 已执行的真实测试与当前限制

用户唯一真实测试授权是使用 D:/0502/at 目录，先Claude审核和修复后实测。初始真实测试计划第二轮通过，代码和脚本第三轮通过；之后执行一次真实调用。只读选择一份凭证，执行时所有源短期token已过期，原Credentials.refresh()在内存刷新一次HTTP200，Gemini native HTTP429，累计HTTP2次。模型gemini-3.8-flash-low，全局流转非流开启但实际使用generateContent；最终输出上限512。源文件hash不变，无导入或持久化，无账号/凭证/原始响应输出。

429触发既定停止规则，未执行collect、真流、OpenAI或Anthropic，不宣称native生成成功或余下协议通过。刷新所得token只在已退出的进程内存中，原文件仍是过期token。当前余预算6，原约束为本任务总计8、至多一次OAuth刷新；刷新额度已用完，没有新用户测试请求、预算调整或第二次刷新授权。

因此当前工具修复后的真实复测不执行，也无法在当前预算及刷新约束下完成完整矩阵。不会轮询其他凭证/模型、探测429是否解除或将复审视为重置调用权限。生成及剩余协议验收明确未完成；后续真实复测属于另行明确启动的任务。本批可以完成本地工具修复及实际Claude复审，无需向用户索取更大预算。

## 测试脚本保留行为

scripts/verify_antigravity_flash_live.py默认只做本地预检，真实执行必须显式--execute与--max-http-requests（1..8）。调用者跨运行持久化安全预算，启动前预占剩余值并传入，依最终network_summary结算，无可靠计数全额扣预占；不保存凭证。

实际router、converter、API及HTTP仍运行，仅凭证provider、配置/路由状态、统计使用内存，禁用日志和持久化写入；不触碰既有服务/DB，不启用Credit，不做onboarding/API enable。每例最多一次网络尝试，原helper刷新最多一次。HTTPS仅允许原Google生成host/path及必要oauth2.googleapis.com/token，不跟重定向，不使用环境代理。401/403/429/503或重定向立即停止；native其他错误仅一次独立collect诊断，native未通过则不进入真流或其余协议。

成功路径为7次生成：Gemini native、collect、真流，然后OpenAI、Anthropic各native/collect。每例90秒，OAuth45秒。结果独立报告协议状态、真实transport、正文是否存在、安全usage及finish枚举。HTTP200但MAX_TOKENS/空正文为inconclusive_output_budget并停止；不能标为transport失效或通过。任何未执行项明确跳过。

原production normalizer强制64000。本脚本只在已选择API传输后的原HTTP helper wrapper深拷贝最终JSON，仅将request.generationConfig.maxOutputTokens压512，发送前guard验证；其他字段/URL/model不改。报告output_budget_guard_applied和effective_max_output_tokens。此护栏不证明产品客户上限或默认64000上游可用性，不修改受保护normalizer。

## 当前待实施的两项前置检查

集中常量：PLANNED_GENERATIONS=7，CASE_TIMEOUT_SECONDS=90，OAUTH_TIMEOUT_SECONDS=45，TOKEN_MARGIN_SECONDS=60。存储token剩余有效期严格大于735秒（7*90+45+60）才可直接使用，否则标记需要单次内存刷新。刷新后原helper的expires_at也须超过该保守门槛；未知或不足则停止，不再刷新或换凭证。

执行前按所选凭证计算required_http_requests=7+int(refresh_required)。若显式预算不足完整矩阵，在任何OAuth或生成前报告insufficient_complete_run_budget、required/available请求数，network_summary=0、completed=false。默认预检仍零网络，并报告所需预算。完整矩阵门禁是本地工具的保守选择，不冒称用户要求，亦不意味着本任务将再执行真实调用。

用合成凭证和模拟HTTP验证：有效token预算6及需刷新预算7均零请求；完整预算7/8下保持原矩阵；近到期token改走刷新，刷新token过短仅一次OAuth后停；native普通失败仅两次诊断；429立即停；非法/缺预算在读取凭证前拒绝。不读真实目录，不重新实测。

## 审核与交付

继续使用 C:/Users/lywx2/.codex/review/hook.py 与实际 claude-opus-5-5，共享脚本不改，仅本任务进程解除轮次限制。当前方案批准后实施两项脚本修复，做适当模拟回归并更新说明，再提交稳定快照代码审核。最终检查当前需求/方案/16交付文件签名与批准状态一致。

新报告区分第三轮批准后实际429试验、后续未再实测的脚本修复、先前离线回归和最终实际Claude结论。原始安全记录位于.cache/flash-live-claude-review；当前测试脚本修订不改变已执行429路径的证据。报告明确尚未证明native生成可用，旧审核快照仅作为历史，不套用到新文档或脚本。
