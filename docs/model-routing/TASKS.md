# 模型路由执行任务

各任务仅在所列依赖通过且用户实际启动对应窗口后实施。mock 可支持早期开发，不可替代最终依赖联调。状态以安全交付回执和总控验收为准，不以“代码写完”或 branch 存在为准。

## 总控准备任务 MR00

窗口 I。输入为最新 origin/master、master AGENTS.md/MAINTENANCE_SCOPE、本任务包。其他任务均依赖 MR00。

实施：

1. 核验 origin/master，并锁定共同 BASE_SHA。当前参考 170d989f545218920bc84794472a0f234490694f；不从当前 dirty dev0916 开发，不带入其他分支历史。
2. 确认所有者有限恢复 CLI 路由开发的授权；不恢复其它 CLI 项目或已取消 MGMT。缺授权只做只读准备，不能修改 CLI 代码。
3. 为总控及 R/P/S 分配独立 worktree、分支和统一模型设置。现有原始工作区不切换/清理。若本轮只要求制定任务，不执行本步骤。
4. 只向 worktree 复制本任务包/概念图片等明确非敏感材料；不复制 creds、数据库、.env、.codex/private、日志、下载凭证或整个 checkout。
5. 完整读取 master 的六处理器、实际 converters/aliases/静态模型模块、受保护错误/SSE/退休链。制作“master实际行为与历史计划差异”清单。
6. 在隔离环境运行已有基线测试；保存精确命令、错误/skip 和已有失败。固定 empty-table legacy 对照，不用旧 dev0916 golden。
7. 定义 types.py/空包 __init__ 和合同测试，不实现各 worker 的业务算法。冻结 routing-execution-1、BASE_SHA、字段和 default。
8. 固定错误/Retry-After 沿用 master；本轮不改变默认 fixed renderer、不直传上游重试头。若另行要求详细诊断，先增量更新合同，不能由 S 自行改变。
9. 设置所有权和任务状态；只有所有门禁通过才给 R/P/S 可执行说明。

独占文件：src/model_routing/__init__.py、types.py；docs/model-routing 的公共规范/manifest；test_model_routing_contracts.py；门禁基线测试/fixture。

验收：各窗口 source HEAD/材料摘要一致；master 改变的 alias、native 分支、参数优先级、目录/退役和默认安全错误均有对照。依赖 imports 不自动碰真实存储；禁止 credentials/listing 调用计数明确为 0。

交付：MR00.json，包含 master 查询时间/SHA、授权门禁、合同版本/摘要、基线结果、worktree分配、允许开工的任务。只有“通过”可解除依赖。已有基线失败先解释，不能删除/修改旧断言隐藏它。

## 六协议基线和解析任务 MR01

窗口 R。依赖 MR00。独占新模块 projection.py、policy.py、routing.py；test_model_routing_projection.py、test_model_routing_resolver.py。

实施：

- 从 master 实际路径建立六协议 L，包括入口 aliases、真实 converter、normalize、静态家族、前缀和内容清理次序。AG Anthropic 现在有 aliases，不能复制旧无-alias断言。
- 提取名称参数/请求参数类：存在/null/类型、预算/level各分支及家族优先级、includeThoughts、工具/图片、实际 feature开关。输出原值符号表达式，不用固定预算样本代表所有输入。
- policy_digest 覆盖两个静态模型模块、aliases、实际选择/参数规则、证明版本。不得包含动态 listing、真实请求或凭证。
- 实现 pure project/resolve；CLI 精确匹配再实际循环后缀；AG 精确整名/既有前缀，未命中完整 master legacy。
- 单跳分派和完整请求名保留；target profile 参数动作明确，正常输入与非法输入的接受/错误均保持。
- 不修改现有 normalizer/handler，不读取 storage/config/网络。用显式 FeatureSnapshot 注入运行时开关。

验收：空表/未命中与 master 逐协议差分；协议输入、名称与 body优先级、默认/非法类型、内容清理、工具/图片覆盖。AG P-search 未独立配置不匹配 P、不自动 googleSearch。状态递归不可变，多请求不串名。

交付：MR01.json 和纯 API/测试。必须列明仍不能证明的分支，不能静默估计。

## 准入与整表证明任务 MR02

窗口 R。依赖 MR01。独占 compiler.py；test_model_routing_compiler.py、test_model_routing_policy_upgrade.py。

实施：

- parse 区分全局结构错误与可归属渠道字段错误，保留原始全表 row_index。
- 实现 CLI歧义后缀目标拒绝、两渠道完整目标稳定证明，native 清单不是豁免许可证。
- 对实际三协议、参数/功能类比较 dispatch与参数符号表达式；未知分支/证明不完整拒绝。
- CLI完整后缀可达闭包含重复、反序、跨token子串及 aliases；AG只证明有限整名/前缀命中集，不虚构派生语法。
- 保护目标原名、旧aliases和静态入口；验证自名真恒等、多别名、A→B/B→C、环、派生截获与协议错误行为。
- 整表validate聚合两渠道errors；compile_channel只编译当前渠道，不因另一渠道语义错误失败。不执行存储或listing。

验收：所有 reason定位/related_rows；启用/停用准入差异；未知透明目标允许；动态目录/凭证影响计数0；同一规则/配置跨后端输入编译结果一致。模拟本地策略升级导致单渠道失效，对另一渠道不扩散。

交付：MR02.json，目标 profile/编译类型实际实现和证明覆盖说明。bounded fuzz可作补充，不能作为无限CLI语法唯一证据。

## 目录纯投影任务 MR03

窗口 R。依赖 MR02。独占 catalog.py；test_model_routing_catalog.py。不修改 model_list.py。

实施：

- 只消费已编译表、policy和 master 已过滤的来源目录，不请求上游。
- 按隐藏/接管清理、加入公开项、稳定去重的顺序投影；CLI实际派生与AG整名/前缀分离。
- 不误删独立AG后缀项；恒等项一次、多别名同目标保留。
- 公开name/baseModelId/displayName/description按公开信息重建，不继承目标描述。
- empty-table 同来源输出与 master deep-equal，包括新的静态公开名单交集/顺序；不以 listed_id==dispatch 验未映射项。
- 未知透明目标仅显示基础/确定前缀，不靠动态能力扩展search/thinking。

验收：六协议实际resolver与公开项profile一致；legacy项保留旧分派；失败/空目录配合空表保持master结果；动态变化不改变policy/compile摘要。失效渠道不通过投影伪装成功。

交付：MR03.json、pure函数及目录golden；目录HTTP接线交 I。

## 存储和配置接口任务 MR04

窗口 P。依赖 MR00，可用typed mock开工；最终验收依赖 MR02。独占 store.py、settings_routes.py、src/storage_adapter.py、四个 storage manager、src/panel/config_routes.py、src/panel/__init__.py；test_model_routing_storage.py、test_model_routing_config_api.py。

实施：

- 四后端增加get_config_fresh，保持旧 get_config/get_all_config 默认缓存语义，按原作用域查询单键，不读全表/凭证。
- 实现缺键/读取失败区分、raw结构解析、channel独立编译/缓存、单键整表原子save；不DDL/改schema。
- 注册专用GET/PUT，复用面板认证及固定HTTP合同，不在URL传认证。
- 原始table能分区但语义非法时GET返回安全issues供修复；坏JSON/不可归属行则安全503。PUT修复不因旧语义错误被锁死。
- dedicated-only键从通用GET排除；通用SAVE带键整请求拒绝，其他payload正常且保留路由键。
- 新增capabilities只在本地专用接口，Management不变。专用read/compile/PUT无Google/refresh/listing。

验收：认证失败不返回目标；400行定位、全表不部分保存；并发最后成功写入、multi-process fresh、缓存hash正确；单渠道语义失效另一渠道正常；global损坏双渠道安全失败。四后端真实隔离DB测试与mock明确区分，无服务时标记unverified而非通过。

交付：MR04.json 和真实compiler联调结果；不得只交mock接口。不改 credentials store/import/manual 或业务统计方法。

## 设置页任务 MR05

窗口 P。依赖 MR04；布局/交互可先mock。独占 front/model_routing.html/js/css、src/panel/root.py、front/control_panel.html、control_panel_mobile.html、common.js；test_model_routing_panel.py。

实施：

- 独立/model-routing，复用登录、版本化静态资源/CSP/现有面板惯例；不新增密码或错误旁路。
- CLI/AG两个tab，表格增删改/启用；不得出现Vertex/模型探测/保护关闭开关。
- 两渠道草稿保留、整表保存、行错误/相关行、首错误聚焦/各tab错误数、修正后清除陈旧提示。
- channel绑定右侧示例和提示；AG整名不展示自动派生搜索。
- 离页/重载确认、dirty beforeunload、失败保留、成功解除；不额外持久化目标草稿。
- 仅加入口/专用脚本，保留master新增手动测试/导入/额度面板行为和所有原字段。panel-version.txt不自动变更。

验收：未登录/登录、桌面和窄屏、403/400/503、tab切换/保存失败/取消离页/刷新。至少静态测试+真实浏览器对mock本地服务的交互验证；读取相关browser技能。截图只使用占位名/假密码，不启动连接正式库的web服务。

交付：MR05.json、UI行为测试与安全截图。概念图不是功能通过证据。

## 只读预检与升级任务 MR06

窗口 P。依赖 MR02、MR04。独占 readonly.py、preflight.py；test_model_routing_preflight.py；docs/model-routing/UPGRADE.md。

实施：

- 独立module CLI、exit0/2/3、安全JSON报告；只读取已配置实际后端model_routing键和作用域。
- 不import web/get_storage_adapter.initialize，不DDL/WAL/索引/修凭证/全量缓存，不fallback；配置读取失败和缺键分开。
- SQLite只读URI且验证最新提交；远程后端只读权限/会话/查询，允许DB网络，不允许OAuth/listing/model网络。
- 绑定backend身份、config_digest、candidate policy_digest。任何无法证明/后端不符均失败，不打印URI/目标/凭证。
- 编写升级runbook，包含全实例/全入口freeze、排空在途PUT、fresh重验、切换、全部可写实例确认新policy后解冻。冻结丢失/无法排空/旧写入口残留直接禁止切版。
- 不实现自动热升级协调器、新Management动作或生产部署；没有外部部署门禁保证时不能宣称在线切版安全。

验收：无写SQL/init/真实Google调用，缺表/权限/读失败不fallback；master旧表候选失效拒绝；hash变化强制重检；在途提交时序与旧实例写入模拟；反向/双渠道/global故障分类，原记录不变。

交付：MR06.json、安全预检结果fixture、runbook。生产freeze/切版不得由本任务自动执行。

## SSE与运输增量任务 MR07

窗口 S。依赖 MR00。独占 src/httpx_client.py、src/api/geminicli.py、src/api/antigravity.py；必要新增stream_runtime.py；test_model_routing_transport.py。model_retirement.py仅必要且经I确认才由S修改。

实施：

- 复用master events=True/normalize_sse_events/typed错误/退休链，补完整事件边界和32MiB缓冲，保留HTTP200错误识别及取消/关闭。
- 保留每attempt退休识别器和独立16MiB限制，不把名字路由绕到其后。
- raw错误先用于既有冷却/retry，再进入中央安全错误类型；不要改变额度admission、GenerationBudget/Completion/terminal usage/settlement/prefetch。
- 可选route_contextkeyword不破坏旧调用；所有attempt/续传固定dispatch/快照。
- 业务数据已进入下游/聚合后异常不重放；仅心跳允许原retry。
- 不编辑api/utils.py或six handlers。若共享retry helper需要调整，只向其owner提出需求。

验收：既有tests/test_sse_events/retirement/transport_errors及AG replay/timeouts/completion/cycle测试；任意字节分片、CRLF、多事件/行、中文、截断/超限、退休notice/usage尾项、cancel/aclose、单次逻辑计数；不开任何真实外网模型调用。

交付：MR07.json，现有安全栈保留清单和新增边界测试。

## 聚合与假流保真任务 MR08

窗口 S。依赖 MR07，内部顺序执行。独占 src/api/utils.py 的collector相关块、fake_stream.py、anti_truncation.py；test_antigravity_stream_collection.py、test_model_routing_collection.py、test_model_routing_fake_stream.py、test_model_routing_anti_truncation.py。

实施：

- protected collector沿用现有错误/Completion/诊断/关闭合同，按稳定candidate index累积；歧义不按位置猜，安全502/合法流错误。
- 保留候选完整非content字段和parts字典顺序；签名/工具/图片不重建丢字段。
- 候选级最后非空完整grounding快照；不拼来源表/重编号，继续metadata-only尾项，0/false保留，usage不伪造。
- 双渠道原生Gemini假流心跳后一次完整数据；不能正文重建+全量输出重复。兼容协议范围不扩张。
- 抗截断正常续传保留；签名文本不清理。跨轮引用作用域和段位置无法证明作为unverified发布门禁。
- api/utils其他429/prefetch/统计/冷却helpers不顺手重构，Vertex默认调用不改。

验收：显式/缺省/混合/重复/非法index、乱序/数量变化、签名only/text+signature、工具/图片、早晚grounding、finish后usage、response/plain、protected真假默认。适配外deep-equality排除身份且正文只一次；已输出后异常不重放。

交付：MR08.json 和fixture，不能只证明JSON字段存在而忽略引用对应性。

## 成功身份与安全出口任务 MR09

窗口 S。依赖 MR07，MR08后完成整套联调。独占 public_response.py、src/router/model_api_errors.py、stream_passthrough.py；test_model_routing_identity.py、test_model_routing_safe_errors.py。

实施：

- 复用现有ModelApiError/renderer/route_class，只新增成功身份适配或必要opt-in，不构建第二套错误。
- Gemini根/response身份、OpenAI顶层及chunk、Anthropic/message_start改完整requested；不递归改工具或正文model。
- 保留Response私有错误附着、protected包装、iterator关闭、logical统计；首包/流中错误不能再次翻译或变成功。
- 固定默认错误与local-only Retry-After沿用master；无合同授权不改变固定英文/字段、不直传上游header/自由文本。
- 顶层/包装HTTP200错误、非JSON/异常/退休notice不泄露内部目标，坏帧安全结束。
- 不修改six handlers和shared converters；其接线交I。

验收：tests/model_api_errors/transport_errors/error_matrix默认不变；身份在empty/custom/identity/内部version重定向场景一致；body/tools/grounding/usage/signature深度保真；signed/index tail事件；手动probe使用同parse_model_response回归；并发不串名，无重渲染/计数。

交付：MR09.json，身份字段白名单和默认安全合同保持证据。

## 六处理器和目录接线任务 MR10

窗口 I。依赖 MR02、MR03、MR04、MR07、MR08、MR09真实交付。可先写mock测试，不提前验收。

独占：CLI/AG各openai.py、gemini.py、anthropic.py、model_list.py；gemini_fix.py、antigravity_fix.py；必要的src/utils.py/两种协议converter仅I修改；test_model_routing_integration.py、test_model_routing_hi.py、test_model_routing_vertex_boundary.py。

实施：

- 逐文件整合R/P/S独占diff，验证合同摘要、没有source越界/生产数据；不自动ours/theirs。禁止修改Vertex文件、手动/导入入口。
- 一次捕获完整requested；既有Hi按原顺序先短路/只局部身份覆盖；真正生成再P读取、R投影/resolve。
- 空表/未命中实际master旧链不变；命中显式目标不二次改派，同时保留固有目标参数/工具/图片规范化。跨协议转换不从公开名猜家族。
- 保留protected route_class、events=True、退役404、诊断/settlement/一次逻辑记录。typed错误不可再当成功。
- 所有已有非流/SSE/假流/抗截断/AG stream2nostream路径最终身份覆盖。
- model_list接入R投影和P配置；AG完整fetch30秒含凭证获取/空/失败降级，仅目录GET允许调用；cancel传播。
- 用dispatch做内部选择/限流/统计，requested做外部身份；同请求续传/流不中途变表。

验收：六协议×全部实际路径；空表golden/原名profile、生成与目录一致、grounding/签名索引；长流保存、多进程fresh、单渠道故障隔离；Vertex冻结fixture和现有management/manual/import无回归。Mock移除后真实依赖联调通过。

交付：MR10.json，各处理器路径矩阵和源码diff范围。任何无法证明默认行为的接线阻断MR11。

## 联合验收和交付任务 MR11

窗口 I。依赖 MR05、MR06、MR10。独占test_model_routing_acceptance.py及docs/model-routing/ACCEPTANCE.md；不扩大业务修复。

实施：

1. 检查imports/合同和每项base_sha，按R→P→S→I顺序整合。
2. 跑各新测试、master安全SSE/退休、collector/转换器/目录、AGadmission/usage/replay/timeouts/settlement、手动/import、logical、Management/Legacy/Vertex和全量隔离pytest。
3. 分别记录SQLite实测、其他后端实测/缺基础设施，不将mock包装为四后端通过。
4. 实际浏览器检查mock本地设置页的桌面/移动交互，阅读相应技能；报告截图/限制。
5. 敏感字段/额外模型身份泄露扫描、默认错误/Retry-After和响应deep-equality、源码所有权/排除项检查。
6. 记录schema不变、仅本地capability、manager无动作、取消MGMT不恢复、回滚和各unverified门禁。不开跨仓repo_dispatch。
7. 没有P0/P1、所有关键门禁通过才“可提交交付”；未测试组合/后端列清，不宣称上线或真实联网成功。

交付：MR11.json、ACCEPTANCE.md的实际命令/统计/证据。完成不自动commit/push/合并master/发布/生成panel版本号。

## 可选真实调用任务 MR12

未授权、非主流水线依赖。只能在用户另行明确指定凭证、渠道、模型、调用预算、临时存储和服务生命周期后安排独立任务。不复用聊天历史过期凭证，不把凭证放任何任务/fixture/日志。

覆盖语义“测试成功”、googleSearch有/无工具对照、非流/SSE、有效正文及queries/chunks/supports、来源可访问/事实核验。200或模型自称搜索不算通过。实际额度/许可失败照实报告。不部署或改生产库。

## 测试运行安全

- 命令始终在本窗口worktree执行，使用已确认的Python3.12+环境。不能把原始工作区当前测试结果当master结果。
- 导入前设置CREDENTIALS_DIR为本窗口临时目录、清空真实远程DB变量/URL；后端集成测试仅接独立测试库。禁止读取原始creds/credentials.db/.env。
- patch完整真实Google/OAuth/listing/credential刷新路径，测试若意外外连立即失败，不用真实token完成测试。
- 不直接启动web.py的默认lifespan；它会初始化凭证、保活和后台任务。UI/HTTP测试使用依赖注入的mock app，或在隔离目录中构造明确禁用副作用的lifespan。
- 既有测试遇到无法隔离的主动动作不直接运行；说明条件后构造安全测试，不以skip冒充通过。
- 各任务按指定文件执行 `python -m pytest -q <owned-tests>`，交付必须把占位替换成实际文件清单、Python版本、工作目录和输出结果。
- pytest/compile不能修改源fixture自动更新；不跑真实凭证示例或handler内手动test脚本。

## 总控合入次序和失败处理

任务依赖不等于自动运行授权。每份worktree独立保留修改，优先保留用户现有修改。正式提交前仅显式文件暂存，按hook征询panel版本，未经明确确认不改变panel-version.txt。

接口不符：退回owner修复，不能由集成窗口顺带重写对方模块。基线master前进：本批继续固定BASE_SHA，升级基线开新门禁，不各自pull。测试失败：记录失败类别/精确命令/范围，不盲改legacy期望。证明/来源/签名未验证：阻断相关能力的发布通过。真实DB/网络授权缺失：不调用，保持可交付的离线结果。
