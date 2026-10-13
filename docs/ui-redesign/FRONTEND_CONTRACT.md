# 新版节点 UI 前端合同

状态：2026-10-13，用户已授权并行实施；本文定义协作接口，不代表功能已经完成或门禁通过。与 [开发评估](../UI_REDESIGN_ASSESSMENT.md)、[并行边界](PARALLEL_DEVELOPMENT.md) 配套。只迁移 Antigravity 和必要共享功能，不恢复已取消 MGMT 工作或 Gemini CLI 专属开发。

## 1. 工程与文件所有权

技术栈为 React、TypeScript、Vite、Tailwind CSS、shadcn/ui（`@shadcn` registry、Radix 组件变体、default 风格、neutral 基础色）、TanStack Table、React Hook Form 与 Zod。foundation 负责确认相互兼容的具体版本并生成唯一 `package-lock.json`；基础依赖必须包含 `@tanstack/react-table`、`react-hook-form`、`zod`、`@hookform/resolvers`、`react-router-dom`，以及 Vitest、React Testing Library 等验证依赖；其他窗口不得各自安装、升级依赖或重建锁文件。最终视觉主题后置，不将 neutral 当作最终配色承诺。

```text
frontend/
  package.json、package-lock.json、tsconfig*.json、vite.config.ts、components.json、index.html
  src/
    main.tsx                 # foundation：挂载 App
    app/App.tsx              # foundation：AuthProvider、Router、布局和 lazy 路由
    components/ui/           # foundation：shadcn 基础组件
    components/layout/       # foundation：导航、页头、通用布局
    api/client.ts            # foundation：唯一 HTTP/URL 传输入口
    auth/                    # foundation：Provider 与 useAuth
    domain/shared.ts         # foundation：真正跨功能共享的类型
    styles/                  # foundation：Tailwind 与语义变量
    pages/overview/          # overview owner
    pages/credentials/       # credentials owner
    pages/import/            # import owner
    pages/settings/          # settings owner
    pages/logs/              # logs owner
    pages/model-routing/     # workflows owner：页面确认后新增第六页
```

每页入口固定为 `pages/<name>/index.tsx`（内部可拆 `<Name>Page.tsx`，但 index 必须默认导出），默认导出 `function OverviewPage()`、`CredentialsPage()`、`ImportPage()`、`SettingsPage()`、`LogsPage()`、`ModelRoutingPage()`，不要求外部传入 props。feature-specific API、hooks、类型、组件、合成 fixture 与测试均放在各自页面目录中，不写到全局 hooks/domain 争用公共文件。跨页依赖必须经 foundation 合并，页面不得直接 import 另一页面内部文件。

foundation 拥有上述工程配置及共享目录，包括 `src/main.tsx`；页面 owner 只改自己的目录。组件需求先发给 foundation，禁止页面 owner 直接改 registry 配置或共享组件。所有页面独立源码模块，App 只做装配，以 `React.lazy(() => import(...))` 建立动态导入边界；不能把业务页面搬进 App，也不能使用单文件 HTML 插件。

## 2. 导航、服务根与构建

新版入口规范化为 `/ui/`，`/ui` 重定向到保留部署前缀的 `/ui/`，应用内部采用 hash 路由：`#/overview`、`#/credentials`、`#/import`、`#/settings`、`#/logs`、`#/model-routing`。未知路由回概览。模型路由首期链接旧 `/model-routing`，页面确认后本轮追加新版内页；旧独立编辑器仍保留。Gemini CLI 专属功能继续使用旧入口。旧 `/`、旧 hash、`/front/*`、独立模型路由及 legacy manage ready 消息不变，新版 AG 不发送冒充旧 manage 的 ready 消息。

Vite 构建产物目录统一为仓库根 `ui-dist/`（`frontend` 配置的 outDir 为 `../ui-dist`），asset base 为相对 `./`；后端服务 base 与 asset base 分开。后端 HTML 注入服务 base（含部署前缀、以 `/` 结尾）及既有 embed policy，foundation 读取并校验同源 URL。开发环境通过 Vite 同源代理访问隔离后端；不能依靠页面相对路径 `./creds/*`。反向代理前缀由部署注入，不从当前 hash 或生产地址猜测。

HTML 使用 no-store 并保留动态 embed meta 和 CSP `frame-ancestors`；带内容哈希的 JS/CSS 独立输出并缓存，页面 lazy chunk 必须实际生成。`index.html` 只是壳，不要求每页独立 HTML。回滚使用上一版完整镜像，HTML 与静态资产作为同一版本交付，不承诺跨镜像保留旧 hash assets；已打开页面的旧 chunk 加载失败时显示安全刷新入口，不能无限刷新。没有构建产物时不能让旧入口或整个服务启动失败。

## 3. 唯一传输接口

`frontend/src/api/client.ts` 导出下列接口（类型也从该模块导出）：

```ts
export type Query = Record<string, string | number | boolean | null | undefined>
export type RequestOptions = {
  method?: string
  query?: Query
  body?: unknown | FormData
  signal?: AbortSignal
}
export class ApiError extends Error {
  status: number
  payload: unknown
}
export function getServiceBase(): string
export function createServiceUrl(path: string, query?: Query): URL
export function requestJson<T>(path: string, options?: RequestOptions): Promise<T>
export function requestBlob(path: string, options?: RequestOptions): Promise<{blob: Blob; response: Response}>
```

`getServiceBase()` 返回已校验、同源、带尾斜杠的绝对服务根 URL；`createServiceUrl()` 返回独立 URL 对象。path 使用服务根相对路径，如 `creds/status`，拒绝绝对 URL、`//`、向上路径和以 `/` 绕过部署前缀的路径。query 的 null/undefined 省略，其余按字符串编码。mode 的值统一为 `antigravity`，位置按端点现有声明：列表/动作等 query-mode 接口使用 `query: {mode: 'antigravity', ...}`；OAuth start/callback/callback-url、refresh-token 单项/批量导入使用 JSON body 的 `mode`。不能让 UI 的短名 AG 成为服务端值，也不能用 query 代替 请求模型声明的 mode；登录、配置等共享接口不额外添加无意义 mode。

`requestBlob` 同时返回 blob 和原始 Response，供页面读取下载文件名、成功/失败计数等响应头；不要丢弃这些端点结果。method 默认 GET；JSON body 自动序列化并设置 Content-Type，FormData 不手工设置 multipart boundary。client 自动附 Bearer；页面不自行拼认证 header。所有非 2xx 抛 ApiError，包含原始解析后的 payload、status 与安全 message；不能把完整 payload、URL query 或秘密写入日志/Toast。非 JSON 错误正文也须安全归一化。网络失败与 AbortError 保留可区分性，不伪装成 HTTP 状态。

HTTP 200 只代表传输成功：各页面端点适配器检查 `success`、单项结果、错误嵌套与部分成功；共享 client 不猜全局业务结构，不把空值伪装成成功。POST/PUT/DELETE、OAuth 换码、导入及凭证动作不自动重放。

日志 WS 使用 `createServiceUrl('logs/stream', {token})` 后将协议映射为 ws/wss；query token 是现有后端协议，禁止把 URL 记录到控制台或报错文本。不暗改该协议为未经后端支持的 header。连接仅在日志页面登录时建立，离页/登出关闭。

## 4. 认证与旧响应隔离

`auth` 提供 AuthProvider 和 `useAuth()`：

```ts
{ token: string | null, authenticated: boolean, sessionEpoch: number,
  login(password: string): Promise<void>, logout(): void }
```

`auth` 另导出 `registerSessionCleanup(cleanup: () => void): () => void`，注册同步会话清理并返回注销函数；client 用它取消旧代传输，页面可清理内存读缓存、秘密输入、轮询和 WS，非敏感草稿仍由页面持有。AuthProvider 包裹 Router，内部完成 client 的 token getter 与失效回调接线，不能让 API 模块循环 import React 页面。`login` 复用 `auth/login` 的 `{password}` 请求及 token 响应；token 目前就是面板密码，不宣称独立短时会话或服务端登出。`authenticated` 仅表示本地存在可用 token，最终授权由服务端每次 HTTP 校验决定。

持久化只沿用 `gcli2api_auth_token`，localStorage 不可用时回退内存；不持久化其他秘密、配置全文、凭证 JSON 或 OAuth 回调。login 成功、logout 和认证失效必须推进 sessionEpoch。HTTP 401/403 必须区分节点面板认证失败与上游拒绝：AG quota 会把上游状态直接用作 HTTP 状态，具有明确 `response_source`/`upstream_status` 业务来源的错误保留为 ApiError 交页面展示，不注销会话；只有确认属于 panel Bearer 认证失败才触发中央失效回调，不凭状态码一刀切。同一代并发失败幂等处理，旧代请求的 401/403 不得注销刚建立的新会话。登录请求失败只展示登录错误。

读请求捕获 sessionEpoch 与页面请求序号，并在响应后核对，两者失配即丢弃；AbortController 是取消优化，不能代替代次校验。登出销毁受保护读数据、选择状态、轮询与 WS。设置的非敏感内页草稿按既有生命周期保留；模型路由草稿只留当前会话内存，两渠道切换保留，登出、认证失效或 token 代次变化清理旧读数据和草稿。秘密输入与 OAuth 敏感中间状态清理；重新登录不得自动重试写入，也不得跨会话展示先前路由草稿。跨窗口 storage 事件引起 token 变化同样推进代次并清理旧读状态。

## 5. 页面行为合同

| 页面 | 必须保留的语义 |
| --- | --- |
| overview | 只使用现有统计口径；未知为 unknown/null，不用 0 代替缺失；轮询可取消并隔离旧会话响应 |
| credentials | 服务端分页/筛选、panel_capabilities 探测与撤回、501 降级、稳定文件标识；保留当前页、跨页已选 ID 和已有全匹配选择：后者按每批 1000 分页读取并物化 filename 集合，写操作仍提交显式 filename；不宣称快照原子性，筛选变化清除选择；下载/复制最多 100 项，超过时禁用并说明；桌面表格/移动卡片共用状态 |
| import | 合成预览与真实 API 路径显式分离；上传/refresh token/OAuth 保留逐项结果，部分成功不变成全成功；邮箱任务的取消、失效、轮询停止与旧响应隔离；换码结果不自动重试 |
| settings | GET 基线+dirty patch，不回写整个 config；环境锁定禁编辑；秘密只提交明确的新输入，未改省略，空串不视作“保持原值”；200 semantic、False/异常、保存未知分别处理；保留草稿并重新读取观察现状，不宣称 CAS/事务 |
| logs | 纯文本流、初始尾部、受限 buffer、连接状态及有限退避；断线不宣称无损补发；401/403/登出停止，清空和下载显式触发 |

能力不存在、类型错误或撤回即禁用相关控件并移除不受支持的请求参数；版本号、样式和 200 外观均不能代替能力探测。capability 的具体来源以现有端点为准，不把 Management capability 当作 panel capability。

写操作结果至少区分成功、明确拒绝、部分成功与结果未知。超时/断线/5xx 可能已经写入，保留草稿或逐项结果、提示重新读取，禁止盲目重放。GET 只能展示当前观察值，不能补造提交版本、原子性或与他人写入无冲突的保证。

### 模型路由第六页（用户页面确认后的增量）

`ModelRoutingPage` 复用 `requestJson` 的同源 `GET/PUT config/model-routing` 和现有 panel Bearer；不使用模型 Key、Management Token、通用 config/get/save，也不改变后端分派、数据库 schema 或 Management 能力。

GET/PUT 成功返回 `routes` 原表、`supported_channels`、`capabilities`、`policy_digest`、按渠道的 `validation: {valid, issues}`。PUT 只发 `{routes}` 完整双渠道表，包含每行原始 `channel/public_name/upstream_name/enabled`，不携带响应元数据；未知行字段/历史坏类型不得被悄悄过滤或转换。默认 Antigravity，跨渠道同名可存在，编号和 `row/related_rows` 以完整数组为准，服务端 0 基索引在界面加 1。

缺键为 200 空表；可分区的历史字段/语义错误为 200 原始坏表与 validation；不可分区损坏为 503，不能自动当空表。400 明确校验拒绝且未写，字段/相关行均关联可见错误并可聚焦。PUT 503 可能已写入但读回失败；5xx/网络或无效成功响应均结果待核对，保留草稿、不自动重放，GET 展示观察值后由用户明确采用。`policy_digest` 不是 CAS 或版本号，多提交者保持原协议的最后写入语义。能力不支持或响应不可识别不得伪造可编辑/成功。503 全表替换修复须明确确认，不能自动建立或保存空表。

共享 `app/routes` 提供 `registerRouteGuard((attempt: {from: RouteId; to: RouteId; href: string; retry(): void}) => boolean): () => void`。返回 false 时保持渲染页面并恢复地址；确认重试仅本次一次，旧尝试/卸载/会话变化失效。页面处理 dirty、busy 与未确认提交，`#main-content` 不算离页；整页导航与用户登出同样明确确认，取消后焦点回到当前有效可见控件。Header 退出按钮提供 `data-panel-action="logout"`，页面不得依赖按钮显示文字匹配或阻止强制认证失效。

DEV transport 沿用 `app/fixtures.ts`，仅双条件开关下动态导入页内 `fixtures.ts` 的 `fixtureModelRoutingRequest(url, init)`，404 不会穿透到真实后端。生产第六页必须形成独立 lazy chunk；即使显式设置 `VITE_UI_FIXTURES=true`，生产产物仍没有合成数据或 fixture 模块。六页本轮结果绑定新候选 SHA，历史五页结果保留原时点。

## 6. 合成预览、主题与验证

fixture 开关严格为 `import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true'`。开关关闭时走真实适配器；接口失败不得静默 fallback fixture。只使用合成 example.invalid 邮箱、虚构凭证标识、计数与状态，不读取真实数据库、凭证、日志、生产配置。结构预览可在后端修正未完成时先交付，但不能因此标记真实 OAuth/保存链路通过。

组件使用 background、foreground、card、muted、border、primary、destructive 等语义 CSS variables；状态色与业务含义分开，必要时定义 success/warning/info token。页面不硬编码品牌色、阴影或固定 Claude 配色。先验收布局、密度、键盘焦点、响应式、loading/empty/error/partial/unknown，再统一主题。图表颜色同样从 tokens 获取。

各 owner 提交可复查源码和相关验证说明；foundation 统一运行类型检查与生产构建并检查 lazy chunks。业务测试使用隔离后端/合成 fixtures，不调用真实模型、OAuth 或生产管理动作。没有实际运行的测试、浏览器或部署检查必须标记未验证。
