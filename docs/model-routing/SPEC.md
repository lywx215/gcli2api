# 模型路由实施规格

本文是本任务的功能依据。代码事实必须从统一 master 提取；历史方案中已经被 master 改变的旧链不能继续作为基线。

## 范围与授权

只覆盖 CLI/Antigravity 的现有 Gemini、OpenAI、Anthropic 协议。Vertex、manager、Management schema/capability、手动凭证探测、导入、生产凭证和数据库迁移均排除。CLI 实施前须通过有限恢复维护门禁；不恢复已取消 MGMT 工作。

名称保护只保证协议身份、目录及客户端错误不增加披露额外内部名称。用户使用原名请求可回显该完整请求名。正文、工具数据、签名、图片、来源 URL 不做字符串替换；管理员可查看目标配置。

## 最新 master 必须保留的基线

- AG 三协议现在均使用入口 alias 归一化；撤销旧方案“AG Anthropic 没有入口 alias”的断言。
- AG mapper 存在真实 native 分支，但其之前还有特殊重定向。native 成员资格不是稳定目标准入证明。
- CLI 与 AG 已有新静态家族、合法 level 校验、预算/档位优先级、采样字段删除和输出限额处理。按实际家族提取，不能全局套用“budget 永远优先”或旧 helper 规则。
- 空消息清理、末尾 model 消息删除的顺序属于兼容基线。
- AG 目录为动态返回 IDs 与静态公开名单的交集，按既有静态顺序输出；不能恢复展示全部上游 IDs 或旧追加别名。
- SSE 已有 normalize_sse_events、events=True、严格 UTF-8、HTTP 200 错误和退役检测。六处理器已有 protected route_class 与安全首包/开流处理，不允许另建旁路安全栈。
- collector 已支持 protected 参数及关闭链，但仍有首候选/parts 重建限制；本次增量完善。
- model_retirement 的每 attempt/每候选识别、16 MiB 独立限额和固定 404 保留。新 SSE 事件上限 32 MiB 不改变该独立限制。
- quota admission、Completion、terminal/usage 最终化、GenerationBudget、单次逻辑统计、取消与 close_credential_prefetch 保留。
- 默认安全错误固定英文和规定字段保留；仅本地可信 Retry-After 保留，不恢复上游原头透传。其他诊断增强只允许不破坏默认的 opt-in 扩展。

## 路由行为

完整 requested_model 每请求只捕获一次；配置、策略、功能快照不可变。先处理现有前缀，再精确匹配公开名；CLI 可继续实际循环后缀派生，AG 只做完整名称匹配及已有前缀。AG 基础名不会派生 P-search/P-high；未单独配置时执行完整 master legacy 链。显式 P-search 本身是不透明整名，不自动联网。

命中单跳目标，禁止二次 alias/关键词/档位/image 改派；但保留目标固有参数 profile、工具 schema、思考和图片规范化。未命中、空表保持 master 的目标、参数、接受和错误行为。业务筛选、调度和限流使用 dispatch_model，客户端身份使用 requested_model；逻辑请求/attempt 计数边界不得改变。

配置只接受 channel=geminicli|antigravity、public_name、upstream_name、enabled。公开名同渠道精确、区分大小写且唯一；跨渠道同名、多别名同目标允许。名称不能为空或含空白、控制字符、URL、路径、通配符、既有功能前缀。CLI 公开名禁止实际本地功能后缀结尾；AG 整名可含这些尾部字符。

CLI 会被剥离的目标后缀报 AMBIGUOUS_TARGET_NAME。两渠道目标均证明在实际三个协议、全部有效参数/功能类下旧链稳定到声明目标；不稳定报 UNSTABLE_TARGET_DISPATCH，不能证明报 AMBIGUOUS_COMPATIBILITY。启用与停用目标都做准入。

原名保护比较空表 L 和拟配置 R 的 dispatch、参数符号表达式及接受/错误；保护启用目标、能到达目标的旧 alias 和确定静态入口。链、环、截获及不真正恒等的同名映射拒绝。停用条目不参与正在执行的接管/隐藏。CLI 任意重复/乱序后缀使用完整可达闭包，不用有界样本放行。

## 设置和存储

新增 /model-routing，桌面/移动入口，只有 CLI/AG tab。复用面板认证，不在 URL 中传认证。公开名、目标、启用、编辑/删除、新增、重新加载、保存齐备；保护无关闭开关。

双渠道草稿切换保留，保存提交完整表。保存失败保留；站内离页/重新加载确认丢弃，dirty 时 beforeunload，成功/丢弃后清除；不额外持久化目标草稿。响应示例跟随 tab：CLI public-alpha-high-search；AG public-alpha 和“仅匹配完整名称；-search 不会自动联网。”

GET/PUT /config/model-routing 使用现有面板认证。PUT 整表原子校验/保存单键 model_routing，失败不部分生效；缺键为空表。GET 提供两渠道状态，语义失效但可分区时管理员仍可修复。专用能力只在本地接口声明 model.routing.aliases/model.identity.public。

通用 /config/get 排除该键；通用 /config/save 携带该键整表拒绝，其他配置正常保存。不新增路由环境变量或配置文件入口。四后端单键新鲜读取不改变原缓存默认行为、schema 或凭证。

编译缓存按 channel/config_digest/policy_digest。可归属渠道的行错误只使该渠道生成/目录安全 503，不删行、不回落。读失败、坏 JSON、非对象/缺渠道/未知渠道等不可分区故障两渠道 503。管理员专用接口支持整表修复。既有 Hi 不增加路由读取或上游调用，身份只在双渠道局部覆盖；Vertex helper 默认不变。

## 目录与联网

仅目录 GET 获取 AG 动态数据，整个调用含凭证获取设置 30 秒总期限，取消正常传播。失败/空时只降级到配置产生的静态公开项；空配置严格保留 master 既有结果，不恢复被公开名单隐藏的内部 ID。

先校验、移除启用目标及实际变体/被接管空间、添加公开项、稳定去重。CLI 处理其实际派生；AG 只处理完整名/已有前缀，不误删独立后缀名。未映射项保持 master 投影与原名重定向；不能要求 listed ID 与 dispatch 恒等。公开描述重新生成，不继承隐藏目标。

动态 listing、能力字段、凭证漂移不进入 policy、编译、target admission 或生成前合法性。未知透明目标可以配置，不承诺可用。

googleSearch 来自原有协议支持的请求 tools，路由不增删工具。Gemini 原生 grounding 全量保留；兼容协议不凭空新增原生扩展。模拟数据证明保真，不证明真实联网。

## 响应与流式

Gemini 根部/既有 response 包装的身份、OpenAI 顶层 model 与每 chunk、Anthropic model/message_start.message.model，统一完整 requested_model。不递归改写用户数据。身份适配须保留 master 私有错误标记，不能把既有已渲染错误再渲染一遍或重复统计。

增量完善现有 SSE，而非重建安全底座。完整事件支持 UTF-8 分片、多事件、多行 data、CRLF、注释/心跳与结束。事件/未完成缓冲 32 MiB；保留独立 generation/retirement 限额。坏帧、超限、截断安全失败；已开流输出合法错误并结束。

聚合按稳定候选 index；缺省仅在可唯一确认身份时归一化，歧义安全失败。完整 parts/签名/工具/图片保持顺序；grounding 候选级最后非空完整快照，不合并来源表/重编号。消费 metadata-only 尾帧，保留 0/false，不伪造 usage。原生 Gemini 假流心跳后只输出一次完整成功数据。

业务数据进入下游或聚合器后故障不得重放；仅心跳阶段沿用已有 retry。抗截断正常续传保持，签名 part 不修改正文；跨轮引用作用域/片段位置无法证明不得宣称通过。

## 升级与验收

只读预检使用候选同源 compiler，只读当前后端配置键，不用会 initialize 的普通 adapter、不 DDL/修表/改 WAL/修凭证/全量载入/后端回落。允许必要的只读 DB 网络，禁止 OAuth/Google/listing/模型业务调用。

在线切版门禁为：预检摘要绑定；冻结所有路由 PUT；排空已受理写入并确认提交完成；权威 fresh 重读/必要重预检；保持冻结启用新策略；确认所有可写实例均用新策略且旧写入口摘除；再解冻。任何条件不满足禁止切版。仅交付预检工具/runbook，不建设自动升级协调器、管理动作或生产发布。

通过须有底座、真实依赖集成、六协议全路径、无泄漏、目录/原名等价、四后端、UI、Vertex/Legacy/Management/手动探测/导入回归。缺失基础设施或无法证明的组合标记 blocked/unverified，不能以 skip/mock/改旧 fixture 计为通过。真实模型调用、生产服务和上线另需明确授权。

清空路由撤销映射但身份保护保留；完整回滚使用前一实现版本，不迁移/恢复凭证或 schema。
