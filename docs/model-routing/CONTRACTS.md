# 并行开发模块合同

合同版本 `routing-execution-1` 已由 MR00 冻结；后续由总控 I 单独修改，不能由工作窗口自行调整类型/参数。共享类型的确切字段和默认值以 src/model_routing/types.py 为准。实现不得在导入时读取配置、凭证或网络。

本次用户明确授权自动执行、监控、审查和多个窗口并行开发；旧提示词的逐窗口人工启动限制仅作为历史记录，不约束本次已启动运行。用户后续指定子窗口 GPT-6.1 SOL / Ultra，覆盖旧 Astra 设置。最终验证后按用户新要求进行实际 Claude 审核，不在开发阶段调用。

冻结字段具体化：RequestProjection.fields/tools/image_context；FeatureSnapshot.compatibility_mode/return_thoughts/antigravity_stream2nostream/values/antigravity_flash_non_stream_mode；RoutingPolicySnapshot.chains/static_rules/parameter_classes/proof_version；TargetProfile.target/parameter_actions/proofs/capabilities；RoutingConfigSnapshot.exists/raw_table/digest/channels。所有容器通过 freeze/thaw 实现递归不可变和独立复制。缺键 exists=false；读取失败 RoutingConfigReadError，不伪装为空表。

2026-10-09 增量：`FeatureSnapshot.antigravity_flash_non_stream_mode` 默认 `inherit`，追加在 `values` 之后，保留既有位置参数语义。仅 Antigravity 请求及目录快照读取该配置，其他渠道保持默认值。非流式传输按最终目标模型选择；真实流式不消费此选项。配置热更新只影响后续快照，不修改进行中的请求。此增量不改变路由表、管理协议或功能证明的模型目录指纹。

I 增量接线合同：两 normalizer 和两请求 converter 增加可选 keyword-only route_context=None；merge_system_messages 增加 keyword-only compatibility_mode=None（该 shared 文件由 I 负责）。有上下文只消费固定 feature_snapshot；默认/Vertex 保留原配置读取和行为。显式目标在 normalizer/API 处验证最终目标，不以覆写模型修补错误家族参数；未映射路径仍以实际 master 链的接受/错误/目标为准。R 必须审查这些 opt-in 增量后冻结候选源码证明摘要，不可自动信任当前文件哈希。

## 基本类型和既有类型复用

Channel 为 geminicli/antigravity；协议复用 master 的 ModelApiProtocol（GEMINI、OPENAI、CLAUDE；CLAUDE 对应 Anthropic），不得新建同名错误/协议体系。

下列对象使用 frozen dataclass 和递归不可变映射/元组；仅 frozen 外壳包可变 dict 不算满足：

| 类型 | 必需字段 |
| --- | --- |
| RouteRow | channel, public_name, upstream_name, enabled, row_index（原始整表 0-based） |
| ParsedRouteTable | valid_rows、issues、global_error；保留全表行号及错误归属，不能丢弃非法行后视为合法空表 |
| RequestProjection | protocol、实际消费字段的存在性/JSON 类型/符号值、工具/图片上下文；不含消息正文或凭证 |
| FeatureSnapshot | master 已消费功能开关；显式传入，不读取全局配置 |
| RoutingPolicySnapshot | version, digest、六协议真实链/静态规则、参数类/选择谓词、证明版本；不含动态目录 |
| TargetProfile | 稳定目标及其固有参数动作/符号表达式、各协议证明、静态功能能力 |
| ValidationIssue | channel, row, field, reason, related_rows, message；全局错误 row=null |
| CompiledChannel | channel, config_digest, policy_digest, rows, profiles, public_ids |
| CompileResult | compiled 或 null、issues、scope（channel/global）；不得用空表代表失败 |
| ResolutionOutcome | requested_model, dispatch_model, public_base, features, explicit_target, target_profile, accepted, error；无网络/存储副作用 |
| ModelRouteContext | channel, protocol, requested_model, request_projection, feature_snapshot, resolution, config_digest, policy_digest |
| RoutingConfigSnapshot | 缺键/存在区分、原始表、digest、各渠道编译结果；存储读失败抛独立安全异常 |

ModelApiError、异常、parse_model_response、退休判断、renderer、protected 路由/流式包装继续复用 master，不新建第二套错误类型。成功身份适配不得删除 Response 私有错误属性。

## R 输出的纯接口

```python
project_request(channel, protocol, requested_model, raw_request, feature_snapshot) -> RequestProjection
build_policy_snapshot() -> RoutingPolicySnapshot
parse_route_table(raw_value) -> ParsedRouteTable
compile_channel(channel, parsed_table, policy_snapshot) -> CompileResult
validate_table(parsed_table, policy_snapshot) -> tuple[ValidationIssue, ...]
resolve(channel, protocol, requested_model, request_projection,
        compiled_channel, policy_snapshot, feature_snapshot) -> ResolutionOutcome
project_catalog(channel, protocol, source_catalog,
                compiled_channel, policy_snapshot, feature_snapshot) -> list[dict]
```

parse_route_table 区分结构错误与可归属的字段错误；能识别 channel 但其他字段非法的行产生该渠道 issues，不伪装为全局失败。compile_channel 必须消费该渠道全部 issues，global_error 则影响两渠道，不能只编译 valid_rows 而忽略被拒绝的行。可归属目标语义校验由 compile_channel 处理，保留全表行号。validate_table 用于完整 PUT，聚合两渠道及全局错误但不读写存储。

resolve 未命中执行同一个 master legacy 基线；命中单跳，不在 pure 函数内调用异步 normalizer/config/credential manager。normalize 的实际接线由 I 完成，对照 R 的参数 profile；转换不得从任意公开名猜测目标家族。

project_catalog 不 fetch、不 refresh、不输出“能力已验证”。源目录保持 master 的既有过滤输入；空表同输入 deep-equal。投影不能自行实现第三套名称解析。

## P 输出的异步存储和配置接口

```python
await read_routing_config_fresh() -> RoutingConfigSnapshot
await load_channel_routes(channel, policy_snapshot) -> CompileResult
await save_routing_config(parsed_table, policy_snapshot) -> RoutingConfigSnapshot
```

缺键与读失败必须可区分。save 完整校验后单键原子写入，成功后返回新鲜快照；compile 失败绝不部分保存。runtime 读取可以复用现有已初始化 adapter；预检不能冷启动该 adapter。

后端新增 get_config_fresh(key, default) 只绕过该键缓存，默认 get_config/get_all_config 行为保持。不能把方法伪实现为旧缓存调用或全表刷新。

read/load 不刷新凭证、不 listing。不可分区结构/读失败影响双渠道；可分区行错误只影响当前 channel。缓存键含 channel/config/policy；功能证明覆盖支持取值，每请求传实际 FeatureSnapshot。

## 专用 HTTP 合同

GET/成功 PUT 返回 200：

```json
{
  "routes": [],
  "supported_channels": ["geminicli", "antigravity"],
  "capabilities": ["model.routing.aliases", "model.identity.public"],
  "policy_digest": "safe-digest",
  "validation": {
    "geminicli": {"valid": true, "issues": []},
    "antigravity": {"valid": true, "issues": []}
  }
}
```

PUT 请求只有 routes 表；字段/类型错误、非法渠道、重复名、冲突、歧义/不稳定目标均整表 400，不部分保存。reason 枚举：

DUPLICATE_PUBLIC_NAME、PUBLIC_ID_COLLISION、PROTECTED_ENTRY_CAPTURE、UNSUPPORTED_CHANNEL、INVALID_STRUCTURE、INVALID_FIELD_TYPE、UNKNOWN_FIELD、INVALID_NAME、RESERVED_SUFFIX、INVALID_IDENTITY_ROUTE、AMBIGUOUS_COMPATIBILITY、AMBIGUOUS_TARGET_NAME、UNSTABLE_TARGET_DISPATCH。

顶层只允许 routes，行只允许四个配置字段；拒绝未知字段。结构错误、错误字段类型和未知字段分别使用上述稳定 reason；enabled 必须为 JSON 布尔值，不接受字符串或 0/1。当前保存的新配置都严格校验，历史已保存非法记录按既定渠道/global范围安全失败。

400 error.code=MODEL_ROUTING_VALIDATION_FAILED，message 固定安全提示，issues 用 ValidationIssue。对无法解析/分区的已保存值，GET 503 不回显坏数据；可分区语义失效 GET 200 返回诊断供修复。PUT 修复不要求旧值语义编译通过，仍须认证及存储可写。

所有认证/错误外形复用面板现有约定，不在 URL 传 token。这里的管理可读目标内容仅专用已认证接口暴露；通用 config/get 排除整键，config/save 携带该键整请求拒绝。

## S 输出的接口与已有能力

优先保留现有 events=True、protected=True、normalize_sse_events、ModelApiError、Completion 与 protected collector。不要先实现旁路模块再移除 master 安全栈。

新增仅成功身份适配 helper：

```python
rewrite_success_identity(payload, *, protocol, requested_model) -> dict
await adapt_public_response(response, *, route_context) -> Response
```

仅改明确协议身份位置；不递归替换 model。adapt 保留 body iterator 关闭链、错误附着、正确 content-length/媒体类型及既有单次统计；HTTP200 error 在成功改写前仍由既有保护分类。SSE 转换/身份只执行一次。

collector 延续 collect_streaming_response 的 protected 默认和外形；AG 的 protected=true 路径增量多候选保真，默认/其他调用不新增 Vertex 行为。假流/抗截断增量以显式双渠道 opt-in 提供，默认兼容调用保持。

必要的新路由上下文在两 API 函数中以可选 keyword-only route_context=None 接入；旧调用签名/default/超时预算/settlement/关闭保持。I 给六处理器传入上下文，其他手动/导入调用不传。

默认固定错误与 local-only Retry-After 是 master 回归合同。若必须增强诊断，MR00 先明确 opt-in 参数、字段及默认行为，增量放现有中央 renderer，不能新建第二套安全 renderer；未冻结则本轮保留 master 默认。这不阻止身份/路由/保真主体实现。

## I 负责的数据流

认证/既有启动 → 捕获完整名 → 既有 Hi 分支（原处理器存在时） → P fresh 配置 → R policy/project/resolve → I 按 master 转换与显式目标 profile 规范化 → 业务目标/筛选 → S 现有 API/events/错误/退役/collector/fake/anti → 原协议转换 → S 成功身份 → 既有 protected 最终出口。

已渲染错误不得再作为成功事件或重新渲染，原始分类先用于内部调度；生成正文不含 str(exception)。每 retry/续传保留首次目标和快照。业务数据 yield 后不得整次重放。logical request 只计一次，attempt/usage/settlement 不重复。

## 预检工具与交付回执

P 提供 `python -m src.model_routing.preflight`：无网络凭证/URI命令行参数，只读已配置实际 backend 的 model_routing 键及作用域。stdout 安全 JSON；exit 0 为通过，2 为结构/语义/证明失败，3 为 backend/读取/只读保证失败。输出 backend_identity_digest/config_digest/policy_digest、各渠道状态、安全 issues；不输出目标、连接串或凭证。

工具不得 import web、调用 initialize、schema/WAL/索引/凭证修复或全量载入，不 fallback。允许严格只读 DB 连接；禁止 OAuth/模型/listing。SQLite 无法只读读取最新 WAL 提交时失败，不以 immutable 忽略已提交状态。

回执位于 docs/model-routing/deliveries/MRxx.json，最少含 task_id、window、base_sha、contract_version、status、changed_files、actual_test_commands、results、mock_dependencies、unverified、known_issues、next_gate。测试失败/skip 如实保留。不得放真实凭证、上游原始错误/模型身份、管理密码。该回执只排队，不自动触发其他任务。

## 版本与整合门禁

MR00 对 SPEC/CONTRACTS/manifest 记录一致摘要并确认 baseline_sha。其余窗口交付相同合同版本；升级由 I 发出修订说明并重跑依赖测试。

没有提交权限时，I 使用每个 worker 独占文件的 git diff/新文件清单进行可审查合并，不复制完整目录/数据库/venv；每次整合独立检查 diff 与测试。若采用提交/cherry-pick，必须获得当前任务的明确提交授权、保留 hook，禁止推送/合并发布分支。
