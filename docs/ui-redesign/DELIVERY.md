# 新 UI 本地交付（含模型路由）

最新风格交付：用户已确认暖灰浅色样板，首套风格现已完成登录及六页适配，运行源码 `1977f9b`，本地未部署。338项完整前端测试、最终类型/生产构建/六页产物及浏览器实际结果、来源和限制见 [首套暖灰风格记录](WARM_GRAY_STYLE.md)。后端、旧接口和panel-version保持不变。下文保留风格实施前的功能基线记录，其“风格后置”和当时未验证范围不代替本轮新证据。

功能基线（风格实施前）：**页面确认后正式接入完成，本地交付通过（未部署）**。2026-10-13，用户在主聊天明确“页面确认ok，请继续”。模型路由已接入既有 GET/PUT，现为六个独立生产页面；本轮实现、前端回归、相关旧接口、生产构建和合成浏览器已完成。此前五页验证保留原时点。颜色、字体及最终风格后置，Docker、真实外部与完整浏览器/a11y矩阵仍未验证，不称生产发布就绪。

2026-10-13，用户已授权并行开发及 OAuth 兼容修正。首轮实现在 `codex/ui-redesign`，基线为 `d1012` / `ebda92be2a4a5562963360bdbab2d33379e63077`；页面确认后的本轮实现在独立 `codex/ui-confirmed-integration`。六页产品与冻结构建源码为 `c2c7ed6457c2a152e2eb23cd2d3f35788c216ca9`；其后只作交付文档更新。原始 checkout 和原 UI 预览草稿保留；本次没有发布、推送、生成面板版本号或执行 Claude 审核。

## 独立 Review 结论与收敛

此前独立 Review 的“方案质量有条件通过、本地候选交付有条件通过、生产发布就绪不通过”为当时的审阅结论。现已获得主聊天用户对当前页面材料的明确确认；该确认不代表外部客户签字、默认入口替换或生产发布批准。已提交五页实现与后续模型路由接入分别记录，不能用旧五页结果证明新增第六页已通过。颜色、字体与最终风格继续后置。

Review 所引用的 `419873f` 为历史时点；当时核查的五页产品源码已推进至 `e27698edd1de992cfb6269d1d367961ce42baf60`。发现状态按实际提交纠正，不回退已完成修正，也不把旧失败原文改写成当时通过。

| 发现 | 当前事实与处置 | 门禁结论 |
| --- | --- | --- |
| F03 未提交测试草稿 | `test_ui_hosting.py` 的 web 导入隔离与 `MODEL_MATRIX_VALIDATION.md` 已在 `d6905a0fa620be03dd3d79d5028e364a69e6e4de` 提交，核查时两文件均无未提交差异；同一提交含共享矩阵 fixture 修正，无产品模型 runtime 改动 | 指定草稿阻断已解除，不重复制造测试提交；文档收敛另作本地提交，候选记录须与提交对应 |
| F04 设置离站保护 | `1e87074`、`e27698e` 已加入 dirty/未确认写入的离站保护及取消后焦点处理；beforeunload 原生弹窗受浏览器策略控制，不能承诺任何环境都弹窗 | 不再作为“缺少实现”的当前阻断；保留默认入口替换前的完整交互/跨浏览器验收 |
| F05 邮箱任务引导 | 导入页明确提供“旧 AG 面板：手动获取邮箱与高级工具”，目标 `/#antigravity-manage`，页内测试有目标地址断言；旧高级功能继续由旧面板承接 | 文案/入口缺口已处置；不宣称新页已原生实现手动补全或全部高级功能 |
| F06 字段错误关联 | settings ConfigField 及专用 token 控件已有 aria-describedby、aria-invalid 与对应帮助/错误 ID；修正在上述设置提交中 | 不再描述为完全缺失；完整键盘、缩放、屏幕阅读器矩阵仍未验完 |
| F01 镜像与 Node 22 | engines 已校准，本机 Node 24.19.0 检查不能代替 Node 22 容器实跑；真实 Docker 镜像不可构建，仍未验证 | 未来发布另行启动的必要门禁，不阻断已授权本地文档收敛 |
| F02 旧模型矩阵 | 原始两版本各 253 失败/29 通过的记录仅为基线 fixture 缺陷隔离证据，不是通过证据；正式修正后独立重跑 282 通过、共享组合 407 通过，二者必须与原始记录分开 | 不能再断言当前仍有同组 253 失败；也不能据局部矩阵称全仓通过。未来发布须确定并完成候选版本所需完整兼容回归，发现产品问题另按维护范围处理 |

未来发布另行启动的必要门禁包括：F01 的真实镜像构建与 Node 22 容器验证；F02 所涉兼容回归范围完整性及候选版本结果；经单独明确授权的真实 OAuth/模型等外部联调；跨浏览器、键盘、缩放与 a11y 矩阵。当前均不据本地合成结果推定完成。这里列出门禁不授权立即外部调用、部署或全仓修复，不恢复 Gemini CLI 专属维护、cancelled MGMT、管理协议改造或对 manager 的 handoff。Management schema 1.4、panel-version.txt 保持不变。


## 当前实现范围

React + TypeScript + Vite + Tailwind CSS + shadcn/ui，六个独立功能目录及 lazy 入口：概览、Antigravity 凭证、导入、设置、日志、模型路由。`App` 只装配认证、导航和加载边界；产物按页拆分，不使用单文件打包。中性外观只是占位，颜色、字体、圆角、阴影保留集中主题变量，最终风格后置。

凭证页保留服务端分页/筛选、跨页选择和每页 1000 物化全部匹配、下载/复制 100 上限、能力撤回、手动副作用操作及部分/未知结果；详情不读完整凭证 JSON。设置按 dirty patch 保存，秘密不回填，环境锁定禁编辑，未知保存保留草稿并主动读回；存储迁移继续使用旧入口；模型路由通过新版第六页复用既有 GET/PUT，旧独立编辑器保留。邮箱分页与日志重连保留有限生命周期和旧响应隔离。

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

## 上一轮正式开发进展（五页）

上一轮从 `419873f` 启动，开发阶段测试已获用户授权。当时五页产品源码时点为 `e27698e`；其后仅更新文档。以下结果重新执行，历史预览与已撤回 fixture 实验不作为本轮通过结论。

| 收尾项 | 实际状态 |
| --- | --- |
| 共享测试隔离 | 已集成 `d6905a0`；模型矩阵原 282 项正式通过，共享路由组合 407 项通过，逐例确认状态恢复 |
| 旧接口组合 | 主窗口合并运行模型/共享路由、凭证、OAuth/config、Management/OpenAPI、旧面板与 UI 托管，740 passed；6 条既有弃用提示，完整 XML 在 `formal-closeout/python-integration.xml` |
| Node 版本声明 | 来源 `0723e8d` → 集成 `84de8fc`；根 engines 收紧，依赖版本/integrity 不变，本机 24.19.0 满足 133 条锁约束，npm ci/typecheck/build/check:build 通过 |
| 设置页 | 来源 `f732755` + `15c23d2` → 集成 `1e87074` + `e27698e`；离站保护、字段错误关联/定位、秘密清理、未确认提交提醒及取消后的有效焦点已完成；局部 35 项通过 |
| 凭证抽屉 | 来源 `85011df` → 集成 `87134ba`；抽屉内结构化动作反馈可见、可宣布，删除后禁用后续动作，刷新后按当前可见行或标题恢复焦点；局部 116 项通过 |
| 最终前端与浏览器 | 主集成 `e27698e`：259 项/24 文件、typecheck/build/check:build 通过；10 hashed JS + 1 CSS、五页独立 chunk、显式 fixture env 生产数据为 0；五页闭环与凭证/设置专项 Chromium 1440/390、真实产物内存 ASGI 通过 |
| Docker | 当前环境不可构建，实际镜像及容器运行未验证，不尝试启动引擎或安装绕行 |

正式结果与脚本位于同一本机附件目录的 `formal-closeout/`：`summary.json`、`python-integration.xml`、`UI_SMOKE.json`、`UI_HOSTING_SMOKE.json`、`credential-browser.json`、`settings-browser.json`。Python 740 项在 `84de8fc` 时点运行；后续候选的相关 Python 实现和这两份测试隔离文件未变化，未为仅前端修改重复该组。模型 fixture 清理的独立证据仍在 `model-matrix/formal/`。

实际浏览器限制：beforeunload 只核验阻止状态，原生弹窗是否出现由浏览器决定；合成删除不移除列表行，因此行消失后的标题焦点由单元测试覆盖；partial/unknown 写入按页内单元测试覆盖，没有伪造真实浏览器成功证据。没有全仓库或真实外部上游/数据库验收，不宣称完整跨浏览器、缩放和屏幕阅读器矩阵通过。

## 首轮预览验证证据

| 检查 | 实际结果/范围 |
| --- | --- |
| 前端类型与行为 | `npm run typecheck` 与完整 Vitest/RTL：215 passed，21 文件；只用合成响应，不访问真实后端 |
| 生产构建 | `npm run build` 通过，8 个 hashed JS、1 个 CSS；五页独立 dynamic entry，完整 manifest/资源引用检查通过 |
| DEV fixture 隔离 | 通过：构建显式设置 `VITE_UI_FIXTURES=true`，公共 transport 与页面合成数据标识均为 0，manifest 不含 fixture 模块；反例产物曾被加强后的门禁明确拒绝，改动态导入后通过 |
| Python 集成 A | 凭证能力、OAuth、配置、安全、Management/OpenAPI、embed、旧静态面板、Flash/timeout：261 passed |
| Python 集成 B | UI 托管、embed、旧静态面板、Management/OpenAPI、选中工具、搜索及页大小：114 passed；与 A 重叠 42 项，不能相加为不同测试数量 |
| 额外模型 API 矩阵 | 原始干净 ebda92b 与 fe99b43 各 282 项均为 253 failed / 29 passed；全部 nodeid、结果、阶段和规范化失败内容指纹逐项一致，0 差异。本次 UI 改造未引入这组失败；此处保留当时的原始失败状态；正式 fixture 修正及重新执行结果见上方。完整证据见 [矩阵归因记录](MODEL_MATRIX_VALIDATION.md) |
| 旧面板 JavaScript | state、cooldown、quota layout、Flash：68 passed |
| 真实产物托管 | 内存 ASGI 验证真实 index/五页 JS 的 meta/CSP/no-store/MIME/immutable、私有文件与缺资源 404、307 query 通过；不启动真实应用 lifespan |
| 合成浏览器 | 独立 Chromium：五页导航、导入部分成功、settings 草稿与合成保存、详情/storage 登出/重新登录、移动导航登出清理通过；1440/390 无横向溢出，零真实 API/外部请求和 pageerror |
| Docker 构建上下文 | 部署分支用 Moby 原生匹配器验证保留源码/凭证业务页并排除运行数据；17 保留和 14 排除路径通过 |

根浏览器和真实产物托管报告在本聊天本机附件目录 `C:/Users/lywx2/.codex/visualizations/2026/10/13/01a132fa-9639-7c50-a301-b42ba28f74ee`：`UI_SMOKE.json`、`UI_HOSTING_SMOKE.json`，以及 `ui-smoke.py`、`ui-hosting-smoke.py` 与 `runtime-*.png`。静态设计在独立设计聊天输出目录。这些绝对路径是本机交付位置，不是可移植构建依赖。

移动布局折叠已完成，390px 首屏第一张凭证卡可见，展开/折叠保留筛选草稿的实际浏览器检查通过。生产 fixture 动态导入修正已完成，215 项完整前端测试、加强后的生产构建检查与最终 Chromium/ASGI 复验均通过。未执行的门禁不得标通过。

## 页面确认材料与正式收尾事项

当前确认材料为 `customer-confirmation-current/index.html`、14 张合成截图及《客户页面确认表》，可转发包为 `gcli2api-ui-confirmation-20261013.zip`。材料包含 `7a1d384` 的五页候选及本地未提交模型路由合成预览；后者不计入原有 259 项前端、740 项 Python 验证结果。用户已在主聊天明确“页面确认ok，请继续”，本轮继续模型路由真实接口接入及相关本地验证。确认原包与 manifest 已保存到 `confirmed-delivery/approved-preview/`，确认来源记录在 `confirmed-delivery/page-confirmation.json`。历史 `customer-review/` 及旧 11 张截图包保留为历史资料。客户材料使用合成数据，最终颜色字体风格另行确认。

早期停止详细测试前已完成 333 项旧接口/托管组合回归。组合中发现并修正了测试的 `web` 导入缓存干扰；`test_ui_hosting.py` 隔离修正已纳入本轮 `d6905a0`，不改变产品行为。工程根 Node engines 已在本轮收紧到 `^22.22.2 || ^24.15.0 || >=26.0.0`；当前 Node 24 本机验证不能等同 Node 22 镜像已验证。

## 页面确认后的并行执行

新的根集成工作区为 `C:/Users/lywx2/.codex/worktrees/ui-confirmed-integration/gcli2api`，分支 `codex/ui-confirmed-integration`，从已提交 `7a1d3841a5a50717b8312480a58b76afc2263716` 开始。原 `ui-redesign` 工作树的七份未提交预览文件保持原样，并在 `confirmed-delivery/preview-reference/` 保存内容和 SHA256；不以草稿状态替代可定位的正式提交。

- workflows：独立 `pages/model-routing/`，复用 `/config/model-routing` 的 GET/PUT 整表合同，处理两渠道草稿、服务端问题行、未知提交读回、损坏配置显式恢复与会话清理。
- foundation：第六页 lazy 路由、导航与设置入口、通用离页 guard、DEV fixture 接线和六页构建校验。
- root/build：按来源提交集成，执行相关前端/旧路由回归与合成浏览器、生产构建和产物检查；最终结果绑定新的候选 SHA。

所有子聊天按用户最新指定采用 `gpt-6.1-sol` / `ultra`。模型路由 UI 只复用已有双渠道合同，不改模型分派、模型适配或 Management schema/capability，不恢复 Gemini CLI 专属维护与 cancelled MGMT；旧 `/model-routing` 编辑器继续保留。本轮实际完成：共享来源 `312ce95` / `6843ece` → 根 `bb882a8` / `c2c7ed6`；模型路由来源 `b55f178` → 根 `989f047`；设置回归目标调整为根 `d8a2ccf`。后端、模型 API、schema、panel-version 及 Docker 配置相对 `7a1d384` 零差异。

| 本轮检查 | 实际结果及范围 |
| --- | --- |
| 完整前端 | `c2c7ed6`：338 passed，30 文件，typecheck 通过。首轮 337/338 的唯一失败来自新测试重复使用已读取的 Response；修正 mock 后全通过，首轮 JSON 保留 |
| 相关旧接口 | 静态托管、旧模型路由编辑器和专用配置 API 共 62 passed；6 条既有弃用提示。运行时点 `1704873`，相关 Python/旧资源至 `c2c7ed6` 无变化；不与历史 740 项相加 |
| 冻结生产构建 | Git archive `c2c7ed6`，Windows Node 24.19.0/npm 11.17.0：typecheck/build/check:build 通过，13 hashed JS + 1 CSS、六页独立 chunk；显式 `VITE_UI_FIXTURES=true` 的生产产物仍 0 合成标识 |
| 实际产物托管 | 内存 ASGI：meta/CSP/no-store、14 个资源的 MIME/immutable、私有文件与缺资源 404、query 307；旧 `/`、`/model-routing`、`/front/common.js` 与旧路由 JS 均 200。不启动真实应用 lifespan |
| 生产 Chromium | 1440/390 各 8 个关键检查首轮通过：按需加载、完整表保存、400 全局行号/ARIA/焦点、提交后 503 人工核对、离页取消/确认和移动焦点、登出/迟到 GET 隔离、损坏配置双确认修复。无溢出或页面错误 |
| 请求隔离 | 28 次 loopback 假 API（8 PUT）；外部尝试/发送与真实生产请求均 0。导航到概览的另 8 次同源凭证 GET 被拦截，未抵达真实服务。浏览器旧路径只用假标记；真实旧静态路径由上方 ASGI/相关回归覆盖 |

当前六页证据统一位于本聊天附件 `confirmed-delivery/`：`summary.json`、`frontend-tests.json`、`legacy-routing.xml`、`model-routing-hosting.json`、`model-routing-browser.json` 和两张 `model-routing-production-1440.png` / `-390.png`。历史 `formal-closeout/` 的五页结果保持原样。

生产包为 `confirmed-delivery/six-page-c2c7ed6457c2/gcli2api-ui-dist-c2c7ed6457c2.zip`（212287 字节），SHA256 `553c9c41a5e2f10a3f7dc2315f9dfcad66b3dbbad80da0b6374ecf26f5ce3488`；manifest SHA256 `d5e7fcdbdecc8009862c84a09f0d0f8449c559674ac2c33bbf59303f295da001`。同目录有来源 tar、逐文件哈希和 BUILD_EVIDENCE/BUILD_RECORD，静态包须由匹配的 Python 版本托管，不是可直接双击的客户离线预览册。

## 未验证与后续边界

- 用户确认当前环境无法进行 Docker 构建，实际完整镜像构建未验证；Node 22 容器版本只由 engines/lockfile 与 Dockerfile 接线检查，本地实际验证为 Node 24.19.0。静态事实、候选草稿与后续命令见 [Docker 记录](DOCKER_VALIDATION.md)。
- 没有生产或真实 Google OAuth/模型/API/远程数据库联调；SQLite 使用临时库，远程存储使用驱动替身。不据此承诺真实远程行为全部通过。
- 共享面板密码仍是面板 token，owner 不是独立用户身份；OAuth map 只在单进程内。配置保存没有事务、CAS 或写回强一致保证。
- 静态结构图不能作为真实交互验证。浏览器证据来自合成路径；真实 WS 重连/OAuth 换码由隔离行为测试验证，没有生产证据。
- 风格/配色后置；默认 `/` 切换、生产验收、实际发布、额外迁移或新认证协议均不由此文自动启动。Management/manager 无配套动作，`no_counterpart_action`。

## 复查与回滚

在 `frontend/` 运行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`、`npm run check:build`；Python/Node 命令和源码安装说明见 [UI 托管说明](../UI_STATIC_DEPLOYMENT.md)。使用唯一 lockfile，不混合不同版本 HTML/assets。

回滚使用上一版完整镜像，Python、HTML 与 assets 一起恢复，或继续使用旧控制面板。已打开页面的失效 lazy chunk 提供显式刷新与未保存提醒，不无限 reload、不自动重放写动作。UI 回滚不会撤销已经成功的数据动作。
