# 节点控制面板全新界面开发评估

本轮评估选用 **React + TypeScript + Vite + Tailwind CSS + shadcn/ui**，先建设与旧面板并行的新版入口，优先迁移 Antigravity 凭证工作流。CLIProxyAPI 可作为独立前端工程和交互组织参考；本项目继续使用自己的节点 API、认证和业务语义。

评估日期：2026-10-13。开发基线为 `d1012`，提交 `ebda92be2a4a5562963360bdbab2d33379e63077`；改善分支为 `codex/ui-redesign`。用户现已明确授权按本评估并行实施新版 UI 与最小兼容后端修正；本文记录目标与验收条件，实施进度以各窗口的实际代码和验证记录为准，不提前标记完成。用户明确要求所有页面不得集中在一个文件中；源码和构建产物都必须保持模块化。

## 当前代码与改善空间

当前前端规模和入口已从上述基线确认：

| 文件 | 规模与职责 |
| --- | --- |
| `front/control_panel.html` | 3025 行，桌面结构、内联 CSS 和事件绑定 |
| `front/control_panel_mobile.html` | 2602 行，移动端独立模板 |
| `front/common.js` | 5748 行，认证、DOM、请求、状态和业务展示 |
| `front/model_routing.html`、`.js`、`.css` | 75、426、86 行，独立模型路由编辑页 |

`src/panel/root.py:47` 按 User-Agent 选择主模板；`:19` 提供独立 `/model-routing`。两套主面板各维护 OAuth、Antigravity 认证、上传、双渠道凭证、配置和日志，并链接模型路由。双份 DOM/CSS 加上大量内联处理器，提高了每次改动的同步成本。

`common.js:214` 的凭证管理器把 API、状态与 DOM ID 前缀绑定，`:1458` 用长模板字符串生成凭证卡片。适合先建立类型与接口适配层，再拆组件。模型路由虽已分离视图，仍加载完整 `common.js` 复用登录，可成为抽取轻量认证模块的起点。

当前 AG 页已有宽屏布局、筛选分组、长字段截断、搜索、跨页选择和邮箱补全。请求取消、会话代次、能力撤回及旧响应隔离也已实现，不能将这些再次列为待修缺陷。下一步应改善操作层级、详情呈现和双模板维护方式。移动模板仍禁止缩放；新版应允许缩放并使用一套响应式结构。视觉是否更易用仍需样机验收。

## 参考工程与技术选择

CLI Proxy API Management Center 是独立管理 UI，当前面向 v8 后端，发布为单 HTML。可借鉴其页面组织、概览、配置分组及保存前差异预览，但不移植多供应商管理 API、插件管理或配置语义。[项目说明](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/README.md)

参考项目使用 React、TypeScript、Vite、Zustand、axios，自建 UI 组件并使用 SCSS，并非 shadcn/ui：Button 自行组合样式和加载态，Select 自行管理状态并导入 SCSS 模块。本项目借鉴交互组织，以 shadcn/ui 重新实现组件。[依赖声明](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/package.json)、[Button 源码](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/components/ui/Button.tsx)、[Select 源码](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/components/ui/Select.tsx)

参考源码已把布局和配置功能分开：可学习侧栏分组、配置区段、未保存离开保护与固定保存条；本项目据此组织页面。[布局源码](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/components/layout/MainLayout.tsx)、[配置页源码](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/features/config/ConfigPage.tsx)

参考项目 MainRoutes 静态导入页面并采用单文件构建。[参考路由源码](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/router/MainRoutes.tsx)、[构建配置](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/vite.config.ts)。本项目通过 React.lazy 与动态 import 加载页面，多 chunk 是额外硬约束。[React lazy 文档](https://react.dev/reference/react/lazy)

| 方案 | 适用性与代价 | 本轮判断 |
| --- | --- | --- |
| shadcn/ui | 组件源码可控、便于统一视觉；表格、表单及状态需要自行整合，组件更新需维护本地改动 | 已选定 |
| Ant Design | 表格和表单集成度高，较少组装工作，但不采用其整套视觉与组件体系 | 仅保留比较，不与 shadcn 混用 |
| 直接 fork 参考 UI | 可复用外壳，但要替换 API、认证和业务模型，并维护上游差异 | 不采用 |

表格采用 shadcn Table + TanStack Table；表单建议 React Hook Form + Zod，以 useForm、Controller、Field 和 zodResolver 接线。前者提供表格组合基础，后者管理表单状态与本地校验，服务端校验仍为最终依据。foundation 窗口负责锁定兼容版本与唯一锁文件，采用 @shadcn registry 的 Radix/default/neutral 基础配置；最终视觉主题后置，以语义 CSS variables 解耦，不直接照搬参考项目依赖或锁定最终配色。[数据表指南](https://ui.shadcn.com/docs/components/radix/data-table)、[表单指南](https://ui.shadcn.com/docs/forms/react-hook-form)

## 模块化与构建约束

新版源码必须按页面、通用组件、API、hooks、领域模型和样式拆分。下列为职责概览；实施文件所有权、页面入口与共享函数签名以 [前端合同](ui-redesign/FRONTEND_CONTRACT.md) 为准：

```text
frontend/src/
  app/          启动壳、路由、会话边界
  pages/        overview、credentials、import、logs、settings
  components/   foundation 所有：ui 基础组件、layout 布局
  api/          foundation 所有：client.ts 统一 HTTP 与 URL
  # 页面专属 hooks、类型、API、组件在各自 pages/<name>/ 内
  domain/       foundation 所有：shared.ts 跨页公共类型
  styles/       Tailwind 入口、设计变量
```

Vite 必须输出带内容哈希的独立 JS/CSS，通过动态 import 生成页面 chunk；`index.html` 仅为启动壳。禁止使用 `vite-plugin-singlefile`、把所有页面合并进一个源码文件或全部内联进 HTML，也不保留单 HTML 分发选项。允许一个轻量 HTML 入口，不要求每页独立 HTML；页面代码仍独立按需加载。验收同时检查目录职责、构建清单与浏览器网络请求，防止源码虽拆分但产物仍全量内联。

由 FastAPI 同源提供新增 `/ui/`，`/ui` 规范化重定向到保留部署前缀的尾斜杠入口，运行时不需要 Node 服务；旧 `/` 与 `/model-routing` 继续作为入口。HTML 响应沿用 `src/panel/root.py` 的 embed policy 注入和 CSP，不能直接静态返回缺少注入的 index。Vite 使用相对 asset base `./`，API 服务 base 独立注入以支持同源部署前缀。回滚使用上一版完整镜像，不承诺跨镜像保留旧 hash assets；已打开页面的旧 chunk 失效时提供安全刷新提示，不无限 reload。

当前 `Dockerfile` 只有 Python 阶段并使用 `COPY . .`，没有 `.dockerignore`；`.gitignore` 忽略全部 `*.json` 和 `dist/`，未排除 `node_modules`。实施时增加前端构建阶段、把产物复制进运行镜像，并同时在 Git 和 Docker 构建上下文中排除依赖目录。精准放行非敏感的 `tsconfig.app.json`、`tsconfig.node.json` 与 shadcn 标准配置 `components.json`，不能放开凭证 JSON。部署窗口独占 Docker、静态挂载与忽略规则；构建产物固定到仓库根 `ui-dist/`，foundation 的 Vite outDir 使用 `../ui-dist`。[配置文件说明](https://ui.shadcn.com/docs/components-json)

## 按任务组织页面

提炼参考界面的侧栏分组、概览卡片、配置分区/保存差异预览与日志连接状态，并统一加载、空状态、失败和部分成功反馈。日志页将流连接、筛选和滚动拆为 hooks，这一职责划分可用于本项目的连接生命周期管理。[参考日志页](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/features/logs/LogsPage.tsx)

组件映射如下，名称对应 [shadcn 组件目录](https://ui.shadcn.com/docs/components)：

| 页面 | 任务与组件 |
| --- | --- |
| 导航与概览 | Sidebar、Card、Skeleton；展示既有今日调用、模型家族统计和额度状态，不增统计口径 |
| AG 凭证 | Table + TanStack、Input、Select；Sheet 展示额度、权限、错误及周期详情，AlertDialog 确认破坏性操作 |
| 添加凭证 | Field、Input、Dialog、Progress；承接 OAuth/回调/JSON/ZIP/refresh token，展示逐项结果与邮箱补全 |
| 模型路由 | 首期链接现有独立编辑器；后续统一外壳，保留全表校验、草稿和失败保存语义 |
| 日志 | Badge、Select、Scroll Area；展示连接/重连/断开状态、等级筛选、下载与清空 |
| 设置 | Card、Field、Input、Select；分组编辑，保存前展示脱敏差异，保留环境锁定与存储切换预览 |

TanStack Table 不会自动实现本项目的后端分页和跨页选择。使用稳定凭证标识、筛选版本和受控选择状态，保留“选择当前页”“已跨页选中 N 项”以及现有全匹配选择；全匹配选择按每批 1000 分页读取并物化 filename 集合，不宣称原子快照，写操作仍提交显式文件标识。筛选变化撤销旧选择，下载/复制最多 100 项，超过时禁用并说明；不把当前页排序伪装成全局排序。移动端用 Card 与桌面表格共享领域模型、选择状态和请求层，不再复制整套模板。组件负责呈现，hooks/domain 保留业务边界。

loading 使用 Skeleton；空列表区分无凭证和无匹配结果；部分成功同时报告成功、失败与待处理数量，不能只给绿色提示。GCLI 继续通过旧入口访问，不扩展其专属功能。

## 接口适配与兼容约束

| 适配模块 | 复用接口 |
| --- | --- |
| 会话与版本 | `/auth/login`、`/version/info` |
| 查询与选择 | `/creds/status?mode=antigravity` |
| 凭证操作 | `/creds/action`、`batch-action`、remark、download-selected、copy-emails |
| 导入与补全 | upload、upload-by-refresh-token-batch、email-enrichment |
| 检测与详情 | quota、errors、test、batch-test、verify-project、batch-refresh-cooldown |
| 统计 | `/creds/stats-today-by-model` 等既有统计接口 |
| 配置与路由 | `/config/get`、save、management-token、storage-engine 系列、model-routing |
| 日志 | `/logs/stream`、download、clear |

以上缩写路径均位于对应模块前缀下，不是新增接口。`src/panel/creds.py:1231` 的列表支持后端筛选与分页；`:1287` 提供邮箱任务进度；`:3442` 起提供统计。前端必须保留 `panel_capabilities`、501 降级、能力撤回、部分成功、失效任务和过期响应处理。人工检测仍区分上游 HTTP、回复校验和状态写回，不能压缩为一个成功图标。

统一 API client 显式接收服务基路径，不能把旧 `./creds/*` 原样放入 `/ui/`，否则会误请求 `/ui/creds/*`。同时验证根部署、反向代理前缀、尾斜杠及 WebSocket 地址；不使用硬编码生产地址，也不照搬参考工程的管理 API 路径。

认证沿用节点 panel token，HTTP 通过 Bearer 传递，凭证详情按需请求，不把秘密放进 UI 路由或应用日志。日志 WebSocket 当前使用 query token（`src/panel/logs.py:97`、`front/common.js:4325`），迁移沿用其认证协议；若改为不在连接 URL 中携带 token，需另行定义认证调整范围。保留受限浏览器存储回退与登出清理。旧入口的 hash、嵌入 CSP、允许来源和 ready 消息契约保持兼容；ready 通知仍只用于旧 manage 登录后的既有场景，新版 AG 页面不冒充该通知。新版独立 hash 路由不得抢占旧入口。HTML 应继续避免陈旧缓存，静态资源通过哈希更新。

## 迁移阶段与验收

用户已启动并行实施；以下是交付与合并门禁顺序，不表示任何阶段已经完成。可以并行开发独立模块，但真实 OAuth 与配置写入接线须等待对应最小后端修正通过；合成结构预览不受此门禁阻塞。详细窗口边界见 [并行开发计划](ui-redesign/PARALLEL_DEVELOPMENT.md)。

| 阶段 | 交付与验收 | 回滚方式 |
| --- | --- | --- |
| 1 工程与只读样机 | 锁定依赖与组件规范，建立同源 `/ui`、认证适配和合成 fixture；检查页面懒加载、独立 JS/CSS、镜像产物、代理前缀及 CSP | 恢复上一版完整镜像，旧入口照常服务 |
| 2 AG 核心工作流 | 迁移筛选、搜索、分页、跨页选择和详情；复现旧响应隔离、能力撤回、501 降级、取消选择语义 | 将该页面入口指回旧 AG hash；需要版本回退时恢复完整镜像 |
| 3 导入与管理动作 | 迁移上传、邮箱进度、单项/批量动作、检测；以合成数据验证部分失败、取消、会话过期及选中范围 | 按功能恢复旧入口；UI 回滚不撤销用户已成功执行的数据操作 |
| 4 统计日志与设置 | 复用现有口径，验证轮询/连接生命周期、环境锁定、表单校验、脱敏保存 diff 和敏感操作确认；模型路由先接已有页面 | 各模块独立返回旧页，保留兼容 API |
| 5 默认入口评估 | 新旧功能清单对照、完整回归、可访问性与移动验收通过后，再决定是否切换默认入口 | 保留旧 URL，按上一版完整镜像回滚入口与 assets |

不在评估或 UI 自动化中自行调用真实模型、OAuth 或生产管理动作。验证使用合成凭证、拦截请求与隔离存储；线上验收如确有需要，应另行明确范围。

## 现有测试与新增门禁

当前已有 `test_frontend_static.py` 的模板接线检查；`test_panel_state.cjs` 的真实 JS 状态测试覆盖竞态、登出、能力降级、搜索、跨页选择及邮箱任务。重构应迁移行为断言，避免仅通过保留源码字符串满足测试。

`test_panel_visual.py:77` 已覆盖 1920、1440、1024、移动 390、桌面模板 390 与 125% 缩放，检查溢出、字段截断、筛选分组和进度。`test_model_routing_panel.py` 已有隔离 API、Node 交互矩阵和可选浏览器检查。这些是已有测试资产，本轮未运行它们，不视为验收通过。

新版需补登录到导入/筛选/操作/登出的浏览器闭环、配置和日志流程、键盘焦点与缩放、Firefox/WebKit，以及同一 fixture 下的新旧 API 行为对照。组件还需覆盖受控表单、错误提示关联、弹层焦点恢复、表格/移动卡片选择一致性和 chunk 加载失败。每阶段完成类型检查、构建、相关单元与契约测试，并运行共享基础设施及 Legacy 回归；只有实际完成的门禁才记录通过。

## 工作量与维护范围

以下保留最初单人估算作为量级参考，不是当前多窗口排期；其前提为一名熟悉 React 与本仓库的前端开发者、设计方向稳定、后端接口无需扩展：工程分包、设计变量与基础组件约 3–5 人日；凭证表格、移动卡片和详情约 5–8 人日；导入、异步任务与管理操作约 4–6 人日；统计日志、配置表单约 4–6 人日；跨浏览器、兼容与构建回归约 4–7 人日，总计约 20–32 人日。这一范围计入 shadcn 组件整合、TanStack 业务接线和表单组装，不沿用成套组件库的估算。组件源码更新、安全修复与本地样式差异需持续维护；额外设计轮次或协议变化另计，以上不是交付承诺。

范围遵循 `AGENTS.md` 与 `docs/MAINTENANCE_SCOPE.md`，仅限 Antigravity 和必要共享节点面板。不恢复 Gemini CLI 专属维护或已取消 MGMT 工作，不增加 Management schema/capability，不修改真实凭证、数据库或 Volume；manager 无配套动作，记为 `no_counterpart_action`，无需生成跨仓 handoff。

本轮已获本地并行开发授权，最小后端兼容修正纳入范围；此授权不包括生产调用、真实数据迁移、部署、提交或推送。`panel-version.txt` 保持不变。文档修订本身不证明构建或回归通过；各窗口必须报告实际检查及未验证项，根窗口汇总后决定集成。

## 后端兼容深审与最小改造决策

下表记录基线的实际协议，不把 Management API、参考 UI 技术或拟实现能力当成本项目面板既有行为。使用现有 `/auth/*`、`/config/*`、`/creds/*`，不新建“新版 UI 专用 API”，不改模型 API 和 Management schema。

| 边界 | 实际来源与语义 | 本轮处理 |
| --- | --- | --- |
| 面板认证 | `src/panel/auth.py` login 返回的 token 是面板密码；`src/utils.py` 校验 Bearer；不是有 TTL 的独立会话 | 前端适配：沿用现有 key，内存 sessionEpoch、请求序号、已确认 panel 401/403 失效及登出清理（上游 quota 401/403 不注销）；不宣称服务端会话注销 |
| AG 列表能力 | `src/panel/creds.py` status 的 `panel_capabilities` 含 search、auto_email、cooldown.group_filter、model_access.family_filter；auto_email、group_filter 与 family_filter 按存储支持动态提供 | 前端适配：从当次响应探测、撤回、501 降级；不按版本推断，不借用 `/management/v1/capabilities` |
| 配置能力 | `src/panel/config_routes.py` GET 的 capabilities 为 `antigravity.flash.non_stream_transport`、`antigravity.native.timeout`；另有 env_locked 与 security 状态 | 前端适配：锁定字段只读；API 与 panel token 状态分开；unsupported 控件禁用 |
| 路由能力 | `src/model_routing/settings_routes.py` 的配置响应给出 supported_channels、capabilities、policy_digest 与 validation | 首期链接旧 `/model-routing`；policy_digest 是策略摘要，不能视作配置修订号或 CAS token |
| 配置输入 | 普通 save 逐键校验/写入，环境锁字段跳过；GET 会给出现有密码及其他存储配置；管理 token 仅通过专用接口存储 hash | 前端只建立白名单表单和 dirty patch，不回写 GET 全文、不将掩码发给后端、不把空串当未修改；脱敏 diff 不等于网络无秘密 |
| 配置保存真实性 | save 当前未检查 storage_adapter.set_config 的 False；逐键写入，无多键事务和 CAS | **最小后端必改**：显式 False 与异常均不得返回保存成功；部分写入后失败保持可观察，不承诺回滚/事务；前端保留草稿、重新 GET 对照 |
| OAuth state 与回调 | `src/auth.py` 将 user_session（面板密码）拼入 state；callback-url 未核对当前面板会话；全局 flow 选择需 mode 隔离 | **接入真实 OAuth 前必改**：opaque state、服务端 owner 映射、state/owner/mode/TTL 校验和一次完成互斥，外部 shape 保持 |
| 明文日志 | `src/auth.py` 记录授权 URL、会话、code/token 片段及 callback URL；配置保存记录密码 | **最小后端必改**：删除/安全归一化这些日志与异常回显，不靠前端隐藏或单靠通用日志正则补救 |
| 日志 WS | `/logs/stream?token=...` 为既有认证协议；连接时认证、初始尾部+文件轮询，无 cursor/resume 保证 | 前端适配：按页面生命周期关闭、受限 buffer 与有限重连；更换 WS 认证机制及持续服务端重认证属于另行安全改造 |
| 嵌入与入口 | root 动态 embed metadata+CSP；旧 `/#manage` 的 ready 契约固定 | 新 `/ui` 复用策略注入但不伪装 legacy manage；保留旧 URL，以完整镜像回滚 |

以上 capability 简写的完整 panel 名称为 `antigravity.credentials.search`、`antigravity.credentials.auto_email`、`antigravity.cooldown.group_filter`、`antigravity.model_access.family_filter`。未知/畸形能力视为不支持。真实列表字段与分页状态由后端返回；现有全匹配选择通过每批 1000 分页读取物化 filename 集合，允许期间数据变化，不保证原子快照。实际写操作只提交该显式集合，下载/复制最多 100 项，超过时禁用并说明。

### OAuth 的确定实现方案

继续使用现有进程内 `auth_flows[state]`。state 使用 `secrets.token_urlsafe(32)` 独立随机值，不包含面板 token、项目或 mode。Google AuthFlow 包装器当前接收调用方提供的 state，不能假定它替应用完成随机生成。使用进程启动时随机 HMAC key 对已校验 panel token 派生 session_key，flow 只存派生 owner，不保存或记录原始 user_session。保留现有 flow、project_id、auto_project_detection、mode、callback_port/url、server/thread、code、completed、created_at，并补充完成互斥/消费状态。

`/auth/start`、`/auth/callback`、`/auth/callback-url`、状态查询的外部请求/响应 shape 保持；内部统一校验 owner、mode 和有效期。callback-url 必须按解析出的 state 精确查 flow，再校验当前认证派生 owner、请求 mode、TTL 与记录的回调地址；不能仅凭“知道 state”跨会话完成。没有 state 入参的旧 callback 路径只允许当前 owner+mode 的唯一活动 flow；新 start 替换该 owner+mode 的旧 flow，防止并发旧流程被错误选中。共享密码对应相同 owner，不把这一方案描述为浏览器隔离或多用户身份系统。

本地 provider callback 没有面板 Bearer，仅接收绑定到本回调服务器/端口且未过期的 state，记录 code；凭证兑换和保存仍需已认证完成路径核对 owner+mode。线程 handler 与 async 完成函数共用校验规则，短时同步保护全局字典，并以每 flow 异步锁防止重复兑换。旧 sync complete、async complete、callback-url、status、内存淘汰/超时及服务器关闭路径都必须迁移，不能只修改创建 URL 的一行。需要项目选择/手动项目输入时保留必要的续接上下文；已兑换状态复用内部结果继续，不重复使用 code。完成、失效、替换和淘汰清理敏感状态及回调服务器；保留现有进程重启会丢失流程的限制，不虚构跨 worker 共享。

所有 state、code、token、授权/回调 URL、原始异常正文不得写日志或错误消息。保留既有 OAuth 响应 shape 的兼容性；新版只取安全回执，不将返回 credentials 全文放入全局 store、调试输出或持久化。OAuth 传输/兑换结果未知时由用户重新开始，不自动重放。

### 配置失败与前端能解决的边界

`storage_adapter.set_config` 传递后端布尔结果，基线 save 忽略明确 False；最小修正检查 False 并返回固定、安全的失败响应，异常同样失败，不能因日志或 `saved_config` 回显就宣布成功。成功响应 shape 保持；不为此次 UI 引入事务、revision、CAS 或新的 endpoint。部分写入后的缓存刷新做尽力处理，不能把刷新失败伪装成持久化回滚。

前端保存前保留基线与草稿，仅提交实际 dirty 且未锁定的字段。服务端 400/422 显示字段或表单错误；401/403 清理认证但保留非秘密草稿；5xx、网络断开或读回失败显示“保存结果未知”。重新 GET 只报告观察到的当前值与草稿差异，不能证明哪次写入生效或排除其他管理员并发写入。禁止自动再次 POST；有新密码导致旧 token 失效时提示重新登录。

完整配置响应安全投影、独立短时 session、WS 无 query-token 协议、跨 worker OAuth 存储和跨管理员 CAS 都是独立可选安全/一致性工程，不能作为本轮所有页面上线的隐含前置要求。本轮必须修复的泄露路径与保存虚假成功仍按上文执行。纯合成结构预览始终无需真实认证、配置保存或 OAuth 调用。


本轮还包含 [并行边界中的凭证后端修正](ui-redesign/PARALLEL_DEVELOPMENT.md)：新增三个 panel capability（permanent_disabled、remark、credit_mode）并按后端真实能力声明，修正 permanent_disabled 投影与批量 False 计为成功的问题；这些是已授权待实施行为，不能当作基线已支持。SQLite/PostgreSQL 支持三者，MongoDB 仅后两者，MySQL/未知后端均不声明。保持既有不支持 501 和 batch 200 aggregate+逐项 errors，不改 Management schema 或底层存储结构。

端点适配应注意 mode 位置：列表和动作等使用 query；OAuth 与 refresh-token 导入的请求模型使用 body.mode。另需区分 panel Bearer 401/403 与 AG quota 透传的上游 401/403，后者保留业务错误和面板会话，不能被共享 client 一刀切注销。
