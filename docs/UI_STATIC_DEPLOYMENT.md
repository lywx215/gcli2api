# 新 UI 构建与同源托管

新版入口是 `/ui/`，`/ui` 使用 307 保留 query 跳转；页面内部使用 hash 路由。
旧 `/`、`/#manage`、`/front/*` 和 `/model-routing` 保持原入口。此变更只增加 UI
静态托管，不修改模型 API、Management schema 1.4、capability、认证或存储结构；
manager 无需配套动作（`no_counterpart_action`），不恢复取消的 MGMT 工作。

## 源码安装

在包含完整 `frontend/` 源码与唯一 `package-lock.json` 的同一版本 checkout 中构建。
使用符合 `frontend/package.json` engines 的 Node（Docker 构建阶段采用 Node 22；
本地 Node 22 至少 22.22.2，Node 24 至少 24.15.0，或 Node 26 及以上版本）和 npm。不要重新生成锁文件。
从仓库根执行：

```sh
npm --prefix frontend ci
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run check:build
```

`build` 输出仓库根 `ui-dist/`，Vite `base: './'`、`outDir: '../ui-dist'`。
`check:build` 验证独立哈希 JS/CSS、动态 chunk、相对资源地址、两个 HTML 注入点及
DEV fixture 未混入生产 JS。生产构建不访问模型 API 或真实凭证，不以 API 失败回退 fixture。
不要使用历史安装/更新脚本中的 reset、清理凭证或覆盖本地配置步骤来构建 UI。

构建结束后，在同一版本源码的 Python 环境中安装 `requirements.txt`，再按现有配置
启动 `python web.py`。这是真实服务启动命令，仅用于实际安装；隔离检查不执行它。
Node 仅在构建期间需要，Python 运行时不会执行 npm。若使用可信构建环境生成的、
与该源码版本匹配的完整 `ui-dist/`，将其放在仓库根后即可仅用 Python 运行，无需安装 Node。
不要只复制 index 或跨版本混搭 assets。

显式构建必须在进程导入/启动前完成。缺少产物不会阻止应用导入或旧入口工作；新版入口
返回 no-store 的 503 页面及旧根链接。缺少 assets、index、合法 UTF-8 或注入点同样返回 503。
进程启动后才生成构建目录时，需要重启；不提供运行时自动 npm 或目录延迟挂载保证。

## 镜像

Dockerfile 的 `ui-build` 阶段依次复制 manifest/lock、`npm ci`、复制前端源码，再运行
`typecheck`、`build` 和 `check:build`。最终阶段基于 Python，复制同一构建的 `ui-dist/`，
没有 Node 常驻进程，也无需额外静态服务。应用与 assets 作为一个镜像交付。
在完整集成 checkout、Docker daemon 可用时，可用以下本地命令验证镜像：

```sh
docker build -t gcli2api:ui-local .
```

`.dockerignore` 排除 Git/本地代理状态、node_modules、虚拟环境、本地产物、环境文件、
仓库根的 creds/credentials/data 运行目录、数据库及常见私钥文件。
业务源码中的同名目录（例如 `frontend/src/pages/credentials`）必须保留。JSON 默认不进入上下文，仅精确放行前端工程 JSON 与
已知非敏感协议目录；源码、锁文件和 Python requirements 保留。自定义路径的真实数据
也必须位于构建上下文之外；不要把真实配置用作 build argument。当前 Actions 触发器保持原样，
上述本地命令是集成检查步骤，不表示 CI 已恢复或发布成功。

构建上下文过滤可独立检查，不需要 Docker daemon。可选的 Go 检查工具直接使用 Docker
的 Moby patternmatcher（固定版本与 go.sum），不是另写一套匹配语义；Go 只用于这项开发验证，
不进入镜像或源码运行依赖。首次执行需下载该 Go 模块，从仓库根运行：

```sh
cd scripts/check_ui_build_context
go run . ../../.dockerignore
```

检查覆盖凭证业务页、源码 data 目录、manifest/lock/构建脚本保留，以及根运行数据、任意
凭证 JSON、环境文件、依赖、Git 和本地产物排除。检查路径全为合成，不读取凭证文件内容。

## 响应与路径边界

Python 每次读取 `ui-dist/index.html`，对两个占位符进行 `html.escape(..., quote=True)`
替换：`gcli-embed-policy` 来自既有 `get_embed_policy()`；`gcli-service-base` 为尾部带 `/`
的服务根路径。HTML 为 `Cache-Control: no-store`，CSP 只沿用 `frame-ancestors`。
`index.html`、`.vite/manifest.json` 和 dist 根的其他文件不会静态公开。

只挂载 `/ui/assets`；资源不存在返回 404，目录不启用 HTML fallback。JS/CSS 使用明确 MIME
及 `nosniff`；带内容 hash 的资源使用一年 immutable，未带 hash 的资源使用 no-cache。
这是可信构建产物命名约定，不通过文件名证明其内容哈希正确性。

v1 正式支持根部署。`service_base` 只读取可信 ASGI `scope.root_path`，规范化首尾斜杠并
编码路径；307 的 Location 也使用它且保留 query，不读取 `X-Forwarded-Prefix`。
隔离测试验证标准 ASGI root_path 下前缀生成与 assets；没有新增服务 root_path 环境变量，
也不承诺旧面板、OAuth 或全站代理前缀兼容。需要正式子路径部署时应另行验证整个服务。

## 验收与回滚

以下检查使用临时构建目录、内存 ASGI 和合成配置，不启动真实 lifespan：

```sh
python -m pytest test_ui_hosting.py test_panel_embed.py test_model_routing_panel.py test_frontend_static.py -q
python -m pytest test_management_api.py test_management_openapi.py -q
node --test test_panel_state.cjs
```

托管检查覆盖缺产物导入与旧根/模型路由、策略动态注入、HTML 转义、可信前缀、307 query、
静态目录隔离、遍历 404、MIME、GET/HEAD/条件缓存。最终集成还须运行前端检查、浏览器
页面闭环、响应式和 chunk 失败提示检查；本文件的命令清单不代表这些门禁已通过。

回滚恢复上一版完整镜像，使 Python、HTML 与 assets 一起恢复；也可临时继续使用旧根入口。
不承诺跨镜像保留旧 hash chunks。已打开的旧页在升级后请求旧 chunk 可能 404；foundation
负责显示可控刷新提示，先提醒未保存工作，避免无限 reload 和自动重放写操作。
UI/镜像回滚不会撤销已成功的数据操作。此实现不进行数据迁移、生产访问或部署。
