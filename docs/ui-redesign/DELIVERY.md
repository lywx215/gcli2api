# 新 UI 首轮并行开发交付

2026-10-13，用户已授权并行开发及 OAuth 兼容修正。实现保存在独立 `codex/ui-redesign` 分支，基线为 `d1012` / `ebda92be2a4a5562963360bdbab2d33379e63077`。原始 checkout 的用户改动保留；本次没有发布、推送、生成面板版本号或执行 Claude 审核。

## 实现范围

React + TypeScript + Vite + Tailwind CSS + shadcn/ui，五个独立功能目录及 lazy 入口：概览、Antigravity 凭证、导入、设置、日志。`App` 只装配认证、导航和加载边界；产物按页拆分，不使用单文件打包。中性外观只是占位，颜色、字体、圆角、阴影保留集中主题变量，最终风格后置。

凭证页保留服务端分页/筛选、跨页选择和每页 1000 物化全部匹配、下载/复制 100 上限、能力撤回、手动副作用操作及部分/未知结果；详情不读完整凭证 JSON。设置按 dirty patch 保存，秘密不回填，环境锁定禁编辑，未知保存保留草稿并主动读回；存储迁移和模型路由仍链接旧入口。邮箱分页与日志重连保留有限生命周期和旧响应隔离。

后端仅做已批准的兼容修正：permanent_disabled 摘要、三个 panel capability、批量 False 不报成功、不支持 credit 零写入零清冷却；OAuth 随机 state、HMAC owner、mode/TTL/完成互斥与提交准入/清理、安全日志；配置 False/异常停止后续保存并报告可能部分写入。没有存储 schema/数据库迁移或 Management schema/capability 变更。手动邮箱获取、批量模型测试和风险工具沿用旧 AG 面板；新版凭证/导入页提供明确入口，不宣称所有旧功能已完全迁移。

新版入口 `/ui/`，动态注入同源服务 base 与既有 embed/CSP；只公开 assets 子目录，缺产物返回 503 不阻断旧服务。Node 只在构建阶段，Python 运行时承载 UI；旧 `/`、`/front/*`、`/model-routing` 保留。首版正式范围为根部署，不承诺旧服务全站代理前缀兼容。

## 并行实现提交

下表是各独立开发分支的来源 SHA，集成 cherry-pick 后 SHA 不同，源码交付以集成分支为准。

| 范围 | 来源提交 |
| --- | --- |
| 前端基础与公共合同 | `86027ac852608ee26954d8d859fbe393559419e7`、`88cfdd6abbcb610b2ad423b401a42108222109a4`、`1d249899f8849b0511bfb140eee1210e9fe12673` |
| 凭证后端 | `4e8f9e401ca464c714f7a32273cca209dd1814b9` |
| OAuth 与配置后端 | `ca5bf0d2fb137429f30b34f238aec530763a805a` |
| UI 静态托管与构建 | `57f050b236ff9f583b5af36c44ef57a80685041f` |
| 概览/导入/设置/日志 | `a97569b582526fcf254be94063e58c82e5af8de1`、`50128ecae6bf036f509f553d5a8738d7456a4850` |
| Antigravity 凭证页面 | `7a6a70d3425a95dbd2c140ae5a5d5acd93dcf4ef`、`106448fb918a8a2d48935af1852e974fe3a90caa`、`e1db18cbc96e0bb529a7749e4e5dbc1ba563ea21` |

设计聊天交付五张静态结构 PNG、独立 HTML、主题变量和规范。新增完整方案聊天单独维护 [完整开发方案](DEVELOPMENT_PLAN.md)，主聊天继续集成；[前端合同](FRONTEND_CONTRACT.md) 和 [并行边界](PARALLEL_DEVELOPMENT.md) 定义共享接口与文件所有权。

## 当前验证证据

| 检查 | 实际结果/范围 |
| --- | --- |
| 前端类型与行为 | `npm run typecheck` 与完整 Vitest/RTL：215 passed，21 文件；只用合成响应，不访问真实后端 |
| 生产构建 | `npm run build` 通过，8 个 hashed JS、1 个 CSS；五页独立 dynamic entry，完整 manifest/资源引用检查通过 |
| DEV fixture 隔离 | 通过：构建显式设置 `VITE_UI_FIXTURES=true`，公共 transport 与页面合成数据标识均为 0，manifest 不含 fixture 模块；反例产物曾被加强后的门禁明确拒绝，改动态导入后通过 |
| Python 集成 A | 凭证能力、OAuth、配置、安全、Management/OpenAPI、embed、旧静态面板、Flash/timeout：261 passed |
| Python 集成 B | UI 托管、embed、旧静态面板、Management/OpenAPI、选中工具、搜索及页大小：114 passed；与 A 重叠 42 项，不能相加为不同测试数量 |
| 额外模型 API 矩阵 | 282 项中 253 failed / 29 passed，门禁未通过。AG/OpenAI/nonstream 抽样在干净 ebda92b Git archive 同现 503；仅补内存 routing adapter 后通过，证明该例旧 fixture 漏初始化。其余失败未整体归因，不据此恢复范围外开发 |
| 旧面板 JavaScript | state、cooldown、quota layout、Flash：68 passed |
| 真实产物托管 | 内存 ASGI 验证真实 index/五页 JS 的 meta/CSP/no-store/MIME/immutable、私有文件与缺资源 404、307 query 通过；不启动真实应用 lifespan |
| 合成浏览器 | 独立 Chromium：五页导航、导入部分成功、settings 草稿与合成保存、详情/storage 登出/重新登录、移动导航登出清理通过；1440/390 无横向溢出，零真实 API/外部请求和 pageerror |
| Docker 构建上下文 | 部署分支用 Moby 原生匹配器验证保留源码/凭证业务页并排除运行数据；17 保留和 14 排除路径通过 |

根浏览器和真实产物托管报告在本聊天本机附件目录 `C:/Users/lywx2/.codex/visualizations/2026/10/13/01a132fa-9639-7c50-a301-b42ba28f74ee`：`UI_SMOKE.json`、`UI_HOSTING_SMOKE.json`，以及 `ui-smoke.py`、`ui-hosting-smoke.py` 与 `runtime-*.png`。静态设计在独立设计聊天输出目录。这些绝对路径是本机交付位置，不是可移植构建依赖。

移动布局折叠已完成，390px 首屏第一张凭证卡可见，展开/折叠保留筛选草稿的实际浏览器检查通过。生产 fixture 动态导入修正已完成，215 项完整前端测试、加强后的生产构建检查与最终 Chromium/ASGI 复验均通过。未执行的门禁不得标通过。

## 未验证与后续边界

- Docker daemon 未运行，实际完整镜像构建未验证；Node 22 容器版本只由 engines/lockfile 与 Dockerfile 接线检查，本地实际验证为 Node 24.19.0。
- 没有生产或真实 Google OAuth/模型/API/远程数据库联调；SQLite 使用临时库，远程存储使用驱动替身。不据此承诺真实远程行为全部通过。
- 共享面板密码仍是面板 token，owner 不是独立用户身份；OAuth map 只在单进程内。配置保存没有事务、CAS 或写回强一致保证。
- 静态结构图不能作为真实交互验证。浏览器证据来自合成路径；真实 WS 重连/OAuth 换码由隔离行为测试验证，没有生产证据。
- 风格/配色后置；默认 `/` 切换、生产验收、实际发布、额外迁移或新认证协议均不由此文自动启动。Management/manager 无配套动作，`no_counterpart_action`。

## 复查与回滚

在 `frontend/` 运行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`、`npm run check:build`；Python/Node 命令和源码安装说明见 [UI 托管说明](../UI_STATIC_DEPLOYMENT.md)。使用唯一 lockfile，不混合不同版本 HTML/assets。

回滚使用上一版完整镜像，Python、HTML 与 assets 一起恢复，或继续使用旧控制面板。已打开页面的失效 lazy chunk 提供显式刷新与未保存提醒，不无限 reload、不自动重放写动作。UI 回滚不会撤销已经成功的数据动作。
