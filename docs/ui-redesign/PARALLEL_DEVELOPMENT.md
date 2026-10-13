# 新版节点 UI 并行开发边界

状态：2026-10-13，用户已明确启动本地多窗口并行开发。本文件分配职责与集成门禁，不把未完成工作标记为通过。共同基线为 `d1012` / `ebda92be2a4a5562963360bdbab2d33379e63077`，根改善分支 `codex/ui-redesign`。所有窗口先读 [评估](../UI_REDESIGN_ASSESSMENT.md) 和 [前端合同](FRONTEND_CONTRACT.md)。

## 授权与协作原则

2026-10-13 正式收尾更新：用户确认方案并明确要求继续操作、并发加速。本轮以主分支已提交 `419873f` 为起点，开发阶段可执行相关测试；配色风格后置，旧入口保留，不部署。当前增量任务及临时文件所有权如下，优先于下方首轮历史分配：

| 本轮负责人 | 文件范围 | 具体收尾 |
| --- | --- | --- |
| workflowsPages | `frontend/src/pages/settings/**` | 未保存修改离站保护、字段错误关联与定位，保留内页草稿/秘密清理语义 |
| credentialsPage | `frontend/src/pages/credentials/**` | 抽屉内动作状态可见且可宣布；列表刷新/删除后恢复到有效焦点 |
| deploy | `frontend/package.json`、`frontend/package-lock.json`、`docs/UI_STATIC_DEPLOYMENT.md`、`docs/ui-redesign/DOCKER_VALIDATION.md` | 根 Node engines 与锁依赖交集一致；只改元数据，不升级依赖；Docker 不可构建且门禁未验证 |
| modelMatrix | `tests/test_model_api_error_matrix.py`、`docs/ui-redesign/MODEL_MATRIX_VALIDATION.md` | 每例内存路由配置初始化与还原；不改模型运行时或弱化原断言 |
| legacyCompatibility | `test_ui_hosting.py` | 纳入已有独立导入隔离草稿及相关旧接口回归 |
| plan | `docs/ui-redesign/DEVELOPMENT_PLAN.md` | 同步正式收尾状态与真实门禁，不预写未完成结果 |
| root | 集成分支、`DELIVERY.md`、合同/所有权、最终集成证据 | 按来源提交集成，解决共享依赖与跨窗口冲突 |

浏览器与独立代码审阅只读；发现超出表格的真实问题先由根协调 owner。原始 G 盘 checkout 和任何已有草稿保留。当前 Docker 环境限制不阻止其他已授权开发，也不能据此宣称发布就绪。

仅实施 Antigravity 新 UI 与必要共享基础设施、已明确的最小兼容后端修正。旧入口继续可用；不恢复 Gemini CLI 专属维护或已取消的 MGMT-009/010/012，不改模型 API 或 Management schema/capability。manager 无配套动作，不生成要求对端继续的 handoff。本任务允许各独立分支作本地实现提交以供集成，保留提交钩子且不生成新面板版本号。本文不授权生产调用、真实 OAuth/模型调用、数据库/凭证/Volume 修改、部署、推送或 Claude 审核。

按用户要求采用六个开发窗口和一个设计窗口；分工按文件所有权执行，根窗口负责集成、冲突处理和验收结论。窗口可在指定独立 worktree 工作；合同采用仓库相对路径，交付时给出自己 worktree 的绝对路径与 diff/验证结果，不能假定其他窗口修改已经合入自己的 checkout。共享文件需求发给 owner，不自行扩大改动范围。其他窗口不覆盖 foundation 的 lockfile、路由、client、auth 或共享组件。

## 独占任务表

| 窗口 | 独占修改范围 | 交付与边界 |
| --- | --- | --- |
| foundation | `frontend/{package.json,package-lock.json,tsconfig*,vite.config.ts,components.json,index.html}`；`frontend/src/main.tsx`、`src/app/`、`src/components/ui/`、`src/components/layout/`、`src/api/client.ts`、`src/auth/`、`src/domain/shared.ts`、`src/styles/` | 兼容版本及 lockfile、shadcn Radix/default/neutral、登录与会话、服务 base、布局、lazy 路由、语义变量、共享控件和测试配置。预装 TanStack Table、RHF/Zod/resolvers、router、Vitest/RTL；不写业务页面 |
| credentialsPage | `frontend/src/pages/credentials/` 及目录内测试/fixtures | 后端分页/筛选、跨页显式选择及按 1000 分页物化 filename 的全匹配选择、桌面表格/移动卡片、详情与凭证动作；能力探测/撤回/501 降级、部分失败和旧响应隔离。默认从 `index.tsx` 导出 `CredentialsPage` |
| workflowsPages | `frontend/src/pages/{overview,import,settings,logs}/` 及各自测试/fixtures | 四页默认从各自 index 导出 OverviewPage/ImportPage/SettingsPage/LogsPage；端点适配、上传/OAuth/邮箱任务、dirty 设置、统计、WS 生命周期。模型路由链接既有入口；不改 credentials 页面或共享 client |
| backendCreds | `src/panel/creds.py`、需要时新增 `src/panel/credential_capabilities.py`、凭证 API 对应新增/调整测试 | 仅下文列出的 capability 与结果真实性修正；不改底层通用存储 schema、迁移或其他后端业务 |
| backendAuthConfig | `src/auth.py`、`src/panel/auth.py`、`src/panel/config_routes.py` 及对应测试 | opaque OAuth、owner/mode/TTL/回调绑定及一次完成、移除秘密日志/回显、config 明确 False 不报成功。外部 endpoint/shape 保持，不引入 session API、CAS 或配置事务 |
| deploy | `Dockerfile`、`.dockerignore`、`.gitignore`、`src/panel/root.py`、必要静态挂载接线及对应测试 | Node 构建阶段到 Python 镜像、`ui-dist/`、`/ui` 与 `/ui/`、动态 service base/embed/CSP、hashed assets、无构建产物时旧服务仍可启动、回滚说明；不改 auth/config/creds 或前端工程配置 |
| design | 独立合成设计预览及评审材料；不修改上述生产源码目录 | 验收布局、信息密度、导航、移动与键盘状态、loading/empty/error/partial/unknown；仅 synthetic fixtures，无生产/真实凭证；主题后置，不替其他窗口锁定品牌颜色 |

文档 owner 只维护本目录合同/并行文档和 `docs/UI_REDESIGN_ASSESSMENT.md`；根窗口统一决定合同变更。测试公共配置归 foundation，Python 通用 fixture 若需要变更由根协调，页面 owner 不各建平行构建系统。

## 后端凭证窗口的精确范围

现有列表 `panel_capabilities` 继续保留 search、auto_email、cooldown group 和 model access family 的既有来源及条件，不改 Management capability。本轮新增三个 **面板** capability，必须与实际后端能力同步实现后才能声明：

| 存储后端 | `antigravity.credentials.permanent_disabled` | `antigravity.credentials.remark` | `antigravity.credentials.credit_mode` |
| --- | --- | --- | --- |
| SQLite | 支持 | 支持 | 支持 |
| PostgreSQL | 支持 | 支持 | 支持 |
| MongoDB | 不支持 | 支持 | 支持 |
| MySQL | 不支持 | 不支持 | 不支持 |
| 未知后端 | 不支持 | 不支持 | 不支持 |

修正 AG 列表的 permanent_disabled 投影。单动作、备注以及显式请求不支持的筛选，用既有 501 `detail` / `error_code` / `capability` 形状返回，不静默忽略或伪装成功。批量动作仍保持 HTTP 200 aggregate，失败逐项写入 errors；只有后端布尔真成功才增加 enable/disable/permanent_disable 的成功计数。不支持 credit 的后端不得通过该动作清除冷却。前端按新能力禁用相应入口，同时兼容旧服务缺少能力字段的情形，不推断未知后端支持。

不统一跨后端统计、不新增存储字段/迁移、不扩大 GCLI 专属工作，不借此修复范围外的存储实现。测试覆盖能力支持/不支持、能力撤回、501、False、部分成功、permanent_disabled 投影与 credit 不清冷却的反例；全部使用隔离/合成状态。

## OAuth 与配置窗口的验收界限

详细方案见评估末尾。OAuth state 独立随机，token 仅由服务器 HMAC 派生 owner；同 owner+mode 一个活动 flow，callback-url 精确核对 state+owner+mode+TTL+回调绑定，本地 provider handler 校验本 flow/端口，完成过程互斥。共用同步/异步选择与清理规则，保留项目选择续接流程；不记录 state/code/token/授权和回调 URL，不在错误中回显敏感异常。共享面板密码不是独立用户身份；进程内 map 不是分布式会话。

配置 save 仅补明确 False/异常失败与安全结果，不新增原子性或乐观锁承诺。多字段部分写入仍可能发生，前端保存未知时保留草稿并 re-GET 观察，禁止盲目重试。现有 config/get 的敏感响应 shape 不在此次全面改造：新 UI 白名单投影、秘密输入不回填、不保存/展示完整 payload、差异脱敏。通用安全投影、独立短时 session、WS 新认证协议与 CAS 属于另行工程。

## 依赖顺序与集成

1. 合同先落盘，foundation 固定函数签名与页面入口；页面窗口可依据合同并行使用合成适配器。代码不够用时明确报缺失，不各自复制共享 client。
2. foundation 与 deploy 协调 `outDir: ../ui-dist`、相对 asset base `./`、注入 service base 名称和 HTML 注入点；共享 base 必须支持同源部署前缀，不硬编码生产 origin；`/ui` 规范化为保留前缀的 `/ui/`，确保相对资产地址正确。
3. backendCreds 与 credentialsPage 对齐三个新 panel capability 及 501/partial 结果；backendAuthConfig 与 workflowsPages 对齐 OAuth 和 config 失败语义。端点不变不等于可以跳过失败接线。
4. 设计窗口先交静态结构预览；DEV fixture 双条件以合同为准，生产构建不得因网络失败回退合成数据。主题修改集中交 foundation 的语义变量，避免页面逐个硬编码。
5. 根窗口集成后执行类型检查、构建、多 chunk/哈希资产检查、相关 Python/API 与前端行为测试、旧面板/模型路由回归、合成浏览器闭环及响应式检查。各窗口局部测试不能替代最终集成门禁。

## 验收、回滚与交付证据

构建必须产生轻量 index 和独立带 hash 的 JS/CSS、页面 lazy chunks；不能使用 vite-plugin-singlefile，不能所有页面集中一个文件。运行镜像包含 ui-dist；缺少新版产物只影响新版入口，不阻断旧服务。HTML no-store，回滚使用上一版完整镜像，HTML 与 assets 一起恢复，不承诺跨镜像保留旧 hash assets；旧 chunk 失效给安全刷新提示，不无限 reload；旧 `/`、`/#manage`、`/front/*`、`/model-routing` 与 embed ready 契约保持。新 AG 不发送 legacy ready。

最低行为证据包括：过期响应隔离、面板认证失效且不重放写入（上游 quota 401/403 不误注销）、权限/能力撤回、跨页与全匹配选择最终物化为显式 filename（非原子快照）、下载/复制超过 100 禁用、部分成功、取消任务、保存结果未知及 re-GET、OAuth state 不含秘密且跨 mode/owner 不可误用、False 不冒充成功、WS 离页释放、配置环境锁和秘密掩码不回写。不得用仅匹配源码字符串的检查代替关键行为验证。

每窗口交付说明给出：文件范围、实际变化、运行的命令与结果、未验证项、契约偏差和风险。只记录实际通过的门禁。根集成后仍可按模块退回旧入口；前端回滚不撤销已经成功的数据动作。默认 `/` 切换、发布、生产验收与数据迁移均需要单独明确范围，本次不自动进行。
