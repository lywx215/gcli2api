# dev6（基于 dev5）自定义修改与上游同步保护清单

> **用途**：本文档是 `lywx215/gcli2api` 的自定义行为契约和以后同步
> `su-kaka/gcli2api` 时的人工保护清单。它不是普通的变更日志。
>
> **最高优先级规则**：dev6/dev5 已有行为、接口和数据兼容性优先。发现文本冲突或语义冲突时，
> 必须先报告，不得自行选择 `ours`/`theirs`、不得整文件覆盖、不得在未确认的情况下改写代码。

## 1. 审计基线

审计日期：2026-07-31（Asia/Shanghai）。已执行 `git fetch --all --prune`，并通过远端
HEAD 确认上游默认分支仍为 `master`。

| 项目 | 值 |
| --- | --- |
| Fork 远端 | `origin = https://github.com/lywx215/gcli2api.git` |
| 上游远端 | `upstream = https://github.com/su-kaka/gcli2api.git` |
| 当前开发基线 | `origin/dev6@7e7675be19714efa2af135117b6fbbc805c1994b` |
| 当前同步结果 | merge `d35471a5c48ad3993805bf538be345b60bf2c1ac`；其后仅追加同步文档收尾提交 |
| dev6 的提交基座 | `origin/dev5`，`5a85e5892a679445e77125d1567f6699d845fa76` |
| 上游比较基线 | `upstream/master`，`4f5e3432e1d5fc5ba41cf56c99981ba89d1987f7` |
| 共同祖先 | `78f391acee42cc2b2b39bf55577c8eed80aab7e3` |
| 同步前提交分叉 | 上游独有 13 个提交；dev6 独有 131 个提交 |
| 同步前直接树差异 | 74 个文件，约 `+21680/-1566` |
| 同步前三方分类 | 65 个仅 dev6 修改；8 个双方修改；1 个仅上游新增 |
| 同步后提交分叉 | 上游独有 0 个提交；当前同步分支独有 133 个提交（含 1 个文档收尾提交） |
| 同步后直接树差异 | 74 个文件；`upstream/master` 已成为同步分支祖先 |
| dev6 初始实施对 dev5 增量 | 31 个文件，约 `+3564/-485` |
| 本次文本冲突 | 4 个文件：`.gitignore`、`src/utils.py`、`version.txt`、`web.py`；均按批准方案人工解决 |

基线只描述审计时的事实。以后同步前必须重新获取远端并更新 SHA、数量和冲突清单，
不能假定本节永久有效。`master` 是历史发布分支，不再作为自定义修改审计基线。

### 1.1 dev6 不可变标识

| 内容 | 标识 |
| --- | --- |
| dev6 初始实施提交 | `3c73782efee69076e3dd440f1e07ab2f4902971a` |
| dev6 Git tree | `739e611b66bb700464df5d7b6eba2ac3005de2fd` |
| `origin/dev5..origin/dev6` binary patch SHA-256 | `6cb210aea066ccc10c4e53bdef9997afea3438f6adbc6bb8a6bfa7a1bf0d7a01` |

当前文档正在补充 dev6 审计说明，因此提交后的最终 dev6 SHA/tree 可能变化；完成提交时应追加新 SHA，
不要覆盖本表的初始实施锚点。

### 1.2 复核命令

以下命令都是同步前的只读检查；输出应随每次同步记录到新的冲突报告中。

```bash
git fetch origin upstream
git status --short --branch
git rev-parse origin/dev6 origin/dev5 upstream/master
git diff --stat origin/dev5..origin/dev6
git diff --name-status origin/dev5..origin/dev6
git merge-base origin/dev6 upstream/master
git rev-list --left-right --count upstream/master...origin/dev6
git diff --stat upstream/master..origin/dev6
git diff --name-status upstream/master..origin/dev6
git merge-tree "$(git merge-base origin/dev6 upstream/master)" origin/dev6 upstream/master
```

文件三分类可用以下方式复核：

```bash
base="$(git merge-base origin/dev6 upstream/master)"
comm -12 <(git diff --name-only "$base"..origin/dev6 | sort) <(git diff --name-only "$base"..upstream/master | sort)
comm -23 <(git diff --name-only "$base"..origin/dev6 | sort) <(git diff --name-only "$base"..upstream/master | sort)
comm -13 <(git diff --name-only "$base"..origin/dev6 | sort) <(git diff --name-only "$base"..upstream/master | sort)
```

## 2. 保护与判定规则

1. **本地契约优先**：本文登记的行为、接口、状态字段、默认值和前端入口不能在同步中静默消失。
2. **冲突必须上报**：包括 Git 文本冲突，也包括 Git 自动合并但会改变行为的语义冲突。
3. **禁止整文件取舍**：不得使用 `git checkout --ours/--theirs`、`git restore --ours/--theirs`、
   `git merge -X ours/-X theirs` 或类似方式跳过逐项判断。
4. **上游改进仍需吸收**：本地优先不等于拒绝上游。应在保留本地契约的前提下人工移植上游修复，
   但具体方案必须先获确认。
5. **数据兼容高于实现形式**：允许重构文件和函数，但不得丢失已有数据库列、配置键、API 字段或迁移能力。
6. **自动合并不等于安全**：第 10 节列出的双方修改文件，即使没有冲突标记，也必须人工逐项复核。
7. **未知来源按受保护处理**：只要行为已经存在于 dev6/dev5，除非明确确认可废弃，否则不得因提交来源不明而删除。

## 3. 受保护功能总览

| ID | 功能域 | 必须保留的契约 | 主要代码 | 主要提交锚点 |
| --- | --- | --- | --- | --- |
| CRED-01 | 凭证备注与筛选 | 备注最长 64 字符；空值清除；状态接口和桌面/移动端都能展示、筛选 | `src/panel/creds.py`、四种存储、`front/common.js` | `0ff7ee3`、`7e70f3a`、`497c55f` |
| CRED-02 | 永久禁用 | 与普通禁用分离；支持单个、批量和筛选；不得自动重新启用 | `src/panel/creds.py`、四种存储、两个面板 | `c255cb0`、`a3dca88` |
| CRED-03 | 循环统计 | 按 Pro/Flash/Other 维护当前循环和上一循环；进入模型冷却时只结算对应家族 | 四种存储、`front/common.js` | `c255cb0`、`fd30807` |
| CRED-04 | 额度与模型测试 | GeminiCLI/Antigravity 额度展示、重置倒计时、单模型测试、单凭证和批量消息测试 | `src/panel/creds.py`、`front/common.js` | `9b43a7b`、`193af67`、`c9e1476` |
| CRED-05 | 冷却双向同步 | 有额度且仍冷却时精确解冷；额度为零且未冷却时补冷；按原始模型名匹配 | `src/panel/creds.py`、存储管理器 | `3efd201`、`fdcb6b4`、`af83d11` |
| CRED-06 | Refresh Token 导入 | 支持单个和批量、去重、并发上限 5、自动项目和等级检测、两种 mode | `src/panel/creds.py`、`src/models.py`、前端 | `b445edb`、`3c9d6b0`、`d8a57c0` |
| ROUTE-01 | 普通/非稳定期路由 | `normal` 随机轮巡；`unstable` 基于 Preview 成功率加权；Redis 返回也必须打散 | `config.py`、存储管理器、`src/usage_stats.py` | `51aa800`、`8575a36` |
| ROUTE-02 | Preview 稳定性 | 配置、缓存、状态更新和筛选不得在保存/同步后被意外重置 | 存储管理器、凭证面板 | `f500ffa`/`6e5dd65` |
| S429-01 | 风控精确分类 | 风控、额度归零、模型容量不足互斥；风控结论只由额度核验流程确认 | `src/smart_429.py`、`src/api/geminicli.py` | `0e43b07` |
| S429-02 | 凭证健康状态机 | 支持检查中、健康、风控隔离、人工复核及分阶段后台复检；并发核验 singleflight | `src/smart_429.py`、四种存储 | `0e43b07` |
| S429-03 | 容量保护 | 凭证级指数冷却、池级熔断、half-open 单探针、Retry-After/503 语义 | `src/smart_429.py`、API 层 | `0e43b07` |
| S429-04 | 安全开关 | 默认关闭；仅 `WORKERS=1` 且后端能力检查通过时运行；运行时可停止并清理任务 | `config.py`、`web.py`、`src/panel/config_routes.py` | `0e43b07` |
| TIER-01 | 等级标准化 | 保留 `free/pro/ultra/code_assist_standard/code_assist_enterprise/unknown` 六类语义 | `src/subscription_tiers.py` | `62fea53`、`5a85e58` |
| TIER-02 | 原始等级证据 | 保存原始 tier ID、名称和检测时间；无法识别时保持 `unknown`，不得默认改写为 Pro | OAuth、上传、四种存储 | `62fea53`、`296cbf0` |
| TIER-03 | 付费等级回退 | GeminiCLI 未识别时允许调用 Antigravity `loadCodeAssist` 补充判断，但不伪造主检测结果 | `src/google_oauth_api.py`、`src/auth.py` | `5a85e58` |
| MODEL-01 | Gemini 3.5 Flash | 公开别名、thinking 变体、响应模型名还原和只选择支持等级的凭证 | 模型、路由、API、存储 | `8a6cf4f`、`3e1d709`、`6fa3375` |
| MODEL-02 | Antigravity 等级模型 | 保留原生 tier 后缀模型 ID；原生等级模型不得被本地 thinkingConfig 重写 | `src/converter/gemini_fix.py` | `898b6dd`、`8631221`、`9c00a16` |
| API-01 | 多格式错误响应 | API 层生成 Gemini 错误，路由分别转换成 OpenAI/Gemini/Anthropic 格式并保留 HTTP 状态 | `src/api/utils.py`、路由 | `00b30be` |
| API-02 | 重试耗尽语义 | 无可用凭证/容量临时不足必须返回可触发下游重试的 503，不得退化为伪成功或固定 429 | 两个 API 客户端、`docs/http_status_codes.md` | `36052d8`、`703f424`、`0e43b07` |
| API-03 | 流式类型一致性 | `stream_post_async` 输出 bytes，路由包装不得混合 str/bytes | `src/httpx_client.py`、各流式路由 | `a891cf7` |
| API-04 | 连接与任务生命周期 | 复用持久 HTTP 连接池；fire-and-forget 任务必须消费异常并在退出时关闭资源 | `src/httpx_client.py`、`src/api/utils.py`、`web.py` | `f99df8d` |
| API-05 | 流式 TTFT 保护 | 分阶段超时、首事件后禁止重放、OAuth single-flight、单层预读；诊断默认关闭 | 流式传输、凭证管理和三种 GeminiCLI 路由 | `dev6` |
| API-06 | 流式错误边界 | 提交 HTTP 前返回协议原生 502/503/504；提交后只发对应流协议的终止错误，不得换凭证或重放 | 三种 GeminiCLI 路由、converter、anti-truncation | `dev6` |
| AUTH-01 | OAuth 刷新合并 | 同一 `(mode, filename)` 只允许一个刷新任务；1–10 分钟余量后台刷新，≤1 分钟阻塞刷新；临时错误不封禁 | `src/credential_manager.py`、`src/google_oauth_api.py` | `dev6` |
| CORE-01 | 单例安全发布 | CredentialManager/StorageAdapter 必须先完成候选初始化，再在锁内发布；不得暴露部分初始化对象 | `src/credential_manager.py`、`src/storage_adapter.py` | `dev6` |
| CONV-01 | 图像配置优先级 | 客户端原生 `generationConfig.imageConfig` 优先，其次自定义层，最后默认层 | 模型与 Gemini 转换/API | `a82e54a` |
| CONV-02 | 工具与多轮内容 | 保留工具 schema 兼容、Claude 参数转换、thought signature 和多轮内容防嵌套扩散 | converter 目录 | `579da69`、`8e1be8d` 及后续修复 |
| STORE-01 | MySQL 后端 | 双凭证表、配置表、等级/健康字段、Redis 可选缓存和 `server_name` 隔离 | `src/storage/mysql_manager.py` | `5249bea`、`b66ccff` |
| STORE-02 | 多后端字段一致性 | SQLite/MySQL/PostgreSQL/MongoDB 对受保护状态字段提供等价读写和迁移 | `src/storage/*_manager.py` | 多个 storage 提交 |
| STORE-03 | 严格模式 | 配置远程后端但初始化失败时，`STORAGE_STRICT=1` 必须 fail-fast，不得静默写入 SQLite | `src/storage_adapter.py` | `13c330b`、`7587dfb`、`a7aebec` |
| STORE-04 | 在线存储切换 | 面板可预览并在 SQLite/MySQL 间迁移凭证、状态和配置；迁移错误逐项报告 | `src/panel/config_routes.py` | `5249bea`、`872e32b` |
| STAT-01 | 每日与模型统计 | 北京时间日统计、成功/失败/成功率、模型家族和当前 RPM | 四种存储、面板 | `6401714`、`9307514` |
| STAT-02 | Redis 凭证统计 | 按服务器、mode、凭证、模型记录调用结果及 Preview 成功率 | `src/usage_stats.py` | `6d8f2f3`、`3137e6f` |
| STAT-03 | SQLite 缓冲 | 热路径先写内存，后台定时刷库；分钟统计保留 1440 分钟并定期清理 | SQLite 管理器、`web.py` | `8057073` |
| UI-01 | 双端管理界面 | 桌面端和移动端都应覆盖主要凭证、统计、导入、筛选和配置能力 | 两个 HTML、`front/common.js` | `d8a57c0`、`688a8c4` |
| UI-02 | 系统状态 | 显示本服务器 Redis 池、key 数量、内存和 SMART 429 状态 | 面板与 `/config/system-status` | `5249bea`、`3137e6f` |
| OPS-01 | 版本元数据 | 发布构建优先使用注入的版本/修订/日期；源码运行回退到 `version.txt`；静态资源带摘要缓存键 | `src/versioning.py`、`src/panel/version.py` | `6fa3375` 相关提交 |
| OPS-02 | 部署与 CI | Redis Compose、健康检查、MySQL 依赖、分支 SHA 镜像标签和构建元数据 | Docker/CI/requirements | `b80c23d`、`5249bea` |
| OPS-03 | dev6 关闭顺序 | 先停业务后台任务，再关闭凭证/存储，最后关闭共享 HTTP 池；旧代理池要等活动流排空 | `web.py`、`src/httpx_client.py`、`src/storage_adapter.py` | `dev6` |

### 3.1 自定义配置与运行环境

| 环境变量 | 持久化配置键 / 用途 | 默认或启用条件 | 同步保护要求 |
| --- | --- | --- | --- |
| `SMART_429_PROTECTION_ENABLED` | `smart_429_protection_enabled` | `false` | 环境变量锁定优先；非法值必须 fail-closed |
| `SMART_429_MAX_ATTEMPTS` | `smart_429_max_attempts` | `3`，范围 1–5 | 包含首次请求；前后端范围保持一致 |
| `SMART_429_RETRY_BASE_INTERVAL` | `smart_429_retry_base_interval` | `0.5` 秒，范围 0.1–5 | 保存后刷新热路径缓存并重配服务 |
| `DEBUG_MODE` | `debug_mode` | `false` | 只控制额外诊断日志，不应改变业务响应 |
| `ROUTING_MODE` | `routing_mode` | `normal`；另有 `unstable` | 保留随机与 Preview 成功率加权两种模式 |
| `REDIS_URL` | Redis 凭证池、冷却和调用统计连接 | 未设置时相关缓存/统计能力停用；Compose 默认 `redis://localhost:6379/0` | key 必须带 server_name；不能误用旧 `REDIS_URI` 语义 |
| `MYSQL_URI` | MySQL 连接 | 与 `GCLI_SERVER_NAME` 同时存在时选择 MySQL | 示例缺项见第 11 节；不得把 URI 或密码写进日志/文档 |
| `GCLI_SERVER_NAME` | MySQL/Redis 数据隔离命名空间 | MySQL 模式必需；其他场景回退 `default` | 不同实例不得共享错误的命名空间 |
| `STORAGE_STRICT` | 远程存储初始化失败策略 | 默认视为 `1` | 为 `1` 时 fail-fast；只有显式 `0/false/no/off` 才允许回退 |
| `STORAGE_ENGINE` | 仅在 `.env.example` 中声明的引擎选择项 | 文档默认 `sqlite` | 当前 adapter 未读取，属于已知不一致，不得假定已生效 |
| `STREAM_DIAGNOSTICS_ENABLED` | `stream_diagnostics_enabled`；TTFT 结构化日志与 `Server-Timing` | `false` | 环境变量锁定优先；单 Worker 可从控制面板热更新，多 Worker 保存后需重启 |
| `GEMINICLI_STREAM_HEADER_HEDGE_ENABLED` | `geminicli_stream_header_hedge_enabled`；GeminiCLI 真流响应头对冲 | `false` | 环境变量锁定优先；单 Worker 热更新，多 Worker 保存后需重启 |
| `GEMINICLI_STREAM_HEADER_HEDGE_DELAY` | 首请求无响应头后启动备用请求的延迟 | `15` 秒，正数 | 仅无响应头时触发；已收到响应头不得对冲 |
| `GEMINICLI_STREAM_HEADER_HEDGE_MAX_INFLIGHT` | 单 Worker 同时存在的备用请求上限 | `20`，范围 1–100 | 非阻塞获取；达到上限时回退原串行策略 |
| `GEMINICLI_STREAM_HEADER_HEDGE_SAMPLE_RATE` | 满足条件的对冲采样率 | `0.05`，范围 0–1 | 控制面板显示 0–100%；环境变量锁定，单 Worker 热更新 |
| `GEMINICLI_STREAM_HEADER_HEDGE_DAILY_BUDGET` | 每个备用凭证、每个模型族的北京时间每日预算 | `10`，范围 0–1000 | `0` 禁止备用请求；环境变量锁定，单 Worker 热更新 |
| `UPSTREAM_HTTP2_ENABLED` | 上游 HTTP/2 连接复用 | `false` | 仅环境变量控制；修改后重启；HTTPX 可自动回退 HTTP/1.1 |
| `STREAM_LATENCY_GUARD_ENABLED` | 首事件、首内容、idle 超时及安全切换 | `true` | 关闭后仍保留基础连接/OAuth 上限和首事件后禁止重试 |
| `STREAM_PERF_LOG_SAMPLE_RATE` | 正常成功流的性能摘要采样率 | `0.01`，范围 0–1 | 慢请求、失败和重试不受采样率限制；不得记录请求体、token 或代理凭证 |
| `CREDENTIAL_ACQUIRE_TIMEOUT` | 获取可用凭证的总时限 | `10` 秒，正数 | 超时必须转为有阶段信息的 504；没有合格凭证则保持 503，不能无限等待 |
| `OAUTH_REFRESH_TIMEOUT` | 阻塞式 OAuth 刷新上限 | `20` 秒，正数 | 超时属于临时失败，不得据此永久禁用凭证 |
| `UPSTREAM_POOL_TIMEOUT` | 从共享 HTTP 池获取连接的上限 | `5` 秒，正数 | 与 connect/read 阶段分开记录 |
| `UPSTREAM_CONNECT_TIMEOUT` | 上游 TCP/TLS 连接上限 | `10` 秒，正数 | 仅首个有效事件前允许按预算切换凭证 |
| `UPSTREAM_WRITE_TIMEOUT` | 向上游写请求的上限 | `30` 秒，正数 | 不得恢复旧的 900 秒通用等待 |
| `UPSTREAM_RESPONSE_HEADER_TIMEOUT` | 等待上游响应头上限 | `20` 秒，正数 | 到期返回 504；不得收到 200 响应头就提前向客户端提交成功 |
| `UPSTREAM_FIRST_EVENT_TIMEOUT` | 收到首个有效上游事件上限 | `45` 秒，正数 | 首事件前才可重试；首事件后禁止重放 |
| `STREAM_FIRST_CONTENT_TIMEOUT` | 从请求开始到首个下游内容的总预算 | `75` 秒，正数 | 跨凭证尝试共享预算，不得每次重试重置计时 |
| `UPSTREAM_STREAM_IDLE_TIMEOUT` | 已开始流的相邻事件空闲上限 | `90` 秒，正数 | HTTP 已提交时只能发送协议原生终止错误并关闭 |
| `STREAM_TRANSPORT_MAX_ATTEMPTS` | 流式传输最大尝试次数 | `2`，范围 1–5 | 每次必须使用不同凭证；不包含内容开始后的重试 |

配置读取顺序是：命中的环境变量先锁定对应键，存储后端配置只补充未锁定键；
`config.init_config()`/`reload_config()` 再把 debug、TTFT diagnostics、routing 和 SMART 429 值刷新到同步热路径缓存。
除诊断、容量快速失败和响应头对冲三个布尔开关外，dev6 的 TTFT 数值参数当前主要由环境变量构造请求级配置快照；
同步时不得擅自把它们改成数据库配置或改变默认值、单位和范围。

## 4. 智能 429 保护契约

### 4.1 配置

| 环境变量 / 配置键 | 默认值 | 有效范围 | 保护要求 |
| --- | --- | --- | --- |
| `SMART_429_PROTECTION_ENABLED` / `smart_429_protection_enabled` | `false` | 布尔 | 非法值 fail-closed；未完成验证时保持关闭 |
| `SMART_429_MAX_ATTEMPTS` / `smart_429_max_attempts` | `3` | 1–5，包含首次请求 | 保存接口和运行时读取必须使用同一范围 |
| `SMART_429_RETRY_BASE_INTERVAL` / `smart_429_retry_base_interval` | `0.5` 秒 | 0.1–5 秒 | 实际退避带抖动，不得与旧重试路径重复 sleep |

环境变量命中的键由 `get_env_locked_keys()` 标记为只读；数据库配置只能补充未锁定键。
`config.init_config()` 和 `config.reload_config()` 会刷新同步缓存，API 热路径不应改回异步逐次查询。

### 4.2 运行门槛与状态

- 仅支持单进程、单副本设计；`WORKERS != 1` 时服务继续运行，但保护保持停止并报告
  `multi_instance_unsupported`。
- 后端必须实现 `check_smart_429_capability()` 并支持健康字段读写，否则设置运行时阻塞原因。
- 人工立即复检只针对 GeminiCLI；开关关闭返回 409，凭证不存在返回 404。
- 配额核验进行 token 刷新，并通过 singleflight 合并同一凭证的并发检查。
- 状态版本 `health_state_version` 防止过期检查结果覆盖人工操作或较新的状态。
- 后台探测只处理 `checking`/`risk_quarantined`，以 60 秒调度循环检查 `next_probe_at`。
- 容量事件和风控隔离是不同状态：容量不足使用短期冷却/熔断；风控使用健康状态和定时复检。

### 4.3 健康字段

以下字段是 GeminiCLI 凭证的兼容契约，四种后端均不得丢失：

| 字段 | 作用 / 默认值 |
| --- | --- |
| `health_status` | 健康状态，默认 `healthy` |
| `quarantine_reason` | 隔离或人工复核原因，可空 |
| `probe_stage` | 后台复检阶段，默认 `0` |
| `next_probe_at` | 下次复检时间，可空 |
| `last_health_check_at` | 最近完成核验的时间，可空 |
| `health_check_started_at` | 当前核验开始时间，用于并发判断，可空 |
| `health_state_version` | 状态版本，默认 `0`，防止旧结果覆盖新状态 |

`review/SMART_429_PROTECTION_REVIEW.md` 是最终设计基线；
`review/SMART_429_PROTECTION_AUDIT.md` 保存早期问题和处理依据。两者都不能被上游同步删除。

## 5. 订阅等级与模型路由契约

### 5.1 标准等级

| 标准值 | 含义 | Gemini 3.5 Flash 资格 |
| --- | --- | --- |
| `free` | 免费等级 | 不允许 |
| `pro` | Antigravity Pro/兼容旧值 | 不作为 GeminiCLI 3.5 的明确资格 |
| `ultra` | Antigravity Ultra | 不作为 GeminiCLI 3.5 的明确资格 |
| `code_assist_standard` | Gemini Code Assist Standard | 允许 |
| `code_assist_enterprise` | Gemini Code Assist Enterprise | 允许 |
| `unknown` | 无法获取或无法识别 | 不允许，且不得静默变为 Pro |

必须同时保存：`tier`、`tier_raw_id`、`tier_raw_name`、`tier_detected_at`。
API 返回的原始模型 ID 也必须保留，额度面板不得把不同 Google 模型粗暴合并后再用于测试或解冷。

### 5.2 识别入口

- OAuth 完成后检测并保存项目与等级。
- Refresh Token 单个/批量导入复用同一检测语义。
- JSON/ZIP 上传后检测；检测暂时不可用时不得覆盖已有等级证据。
- GeminiCLI 主检测无法识别时，允许 Antigravity 付费等级回退；回退无法识别时主等级仍为 `unknown`。
- `review/GEMINI_CLI_TIER_REVIEW.md` 保存映射、存储矩阵、API 兼容和人工复核要点。

## 6. 凭证、冷却和统计数据契约

### 6.1 通用凭证状态

| 字段 | 保护要求 |
| --- | --- |
| `disabled` | 普通禁用状态 |
| `permanent_disabled` | 永久禁用，与普通禁用分开统计和筛选 |
| `remark` | 最多 64 字符，空字符串表示无备注 |
| `preview` / `enable_credit` | 两种 mode 的可用渠道标记，不能互相混用 |
| `tier` 及原始等级字段 | 见第 5 节；Antigravity 与 GeminiCLI 的默认语义不同 |
| `model_cooldowns` | `{原始模型名: 到期 Unix 时间}`；解冷必须精确匹配模型 |
| `cycle_stats` | 当前循环按 Pro/Flash/Other 累计 |
| `last_cycle_stats` | 最近完成冷却家族的结算快照 |
| `success_count` / `failure_count` | 凭证累计结果 |
| `error_codes` / `error_messages` | 错误追踪与自动封禁依据 |

### 6.2 统计表

- `daily_stats`：按日期和 mode 存储成功、失败总数。
- `daily_model_stats`：按日期、mode、模型家族存储成功、失败数。
- `minute_model_stats`：按分钟、mode、模型家族记录请求数，用于 RPM；后台保留 1440 分钟。
- SQLite 使用内存缓冲批量刷写；读取前需要确保缓冲语义不会导致明显漏计。
- Redis 凭证统计 key 必须包含 `GCLI_SERVER_NAME`，避免多服务器面板互相污染。

## 7. 自定义管理接口

以下路径均挂在现有 Panel router 下。除特别注明外都依赖面板 token。

| 方法与路径 | 主要输入 | 主要输出/行为 | 前端调用与状态依赖 |
| --- | --- | --- | --- |
| `GET /config/debug-storage` | 无 | 环境变量是否存在、适配器状态、MySQL servers 查询诊断 | 当前无认证；诊断用，见第 11 节风险 |
| `GET /config/system-status` | 面板 token | 当前服务器 Redis 状态、池大小、key 数、内存、SMART 429 状态 | `loadSystemStatus()`；依赖 Redis 和 SMART 429 服务 |
| `GET /config/storage-engine` | 面板 token | 当前引擎、MySQL 可用/配置状态、server_name、servers 列表 | `loadStorageEngine()`；读取当前 adapter 和 MySQL `servers` 表 |
| `POST /config/storage-engine/preview` | JSON 对象（当前实现未使用其字段） | 当前后端的 GeminiCLI/Antigravity 凭证数与配置数 | 切换确认前调用；只统计、不迁移 |
| `POST /config/storage-engine/switch` | `target_engine: sqlite\|mysql`、`migrate_data`、MySQL 时的 `server_name` | 切换内存中的 backend，可迁移凭证、状态和配置并返回逐项结果 | `switchStorageEngine()`；只支持 SQLite↔MySQL |
| `POST /creds/remark/{filename}` | query `mode`；body `{remark}` | 更新备注，最长 64 字符 | `updateCredRemark()`；写凭证状态 |
| `POST /creds/risk-check/{filename}` | 文件名 | 同步刷新 token 并立即执行 GeminiCLI 风控复检 | 风控复检按钮；写健康状态；开关关闭返回 409 |
| `POST /creds/batch-refresh-cooldown` | query `mode`；body `{filenames: [...]}` | 拉取实时额度并精确双向同步模型冷却 | 批量额度按钮；并发 5；写 `model_cooldowns` |
| `POST /creds/test/{filename}` | query `mode`、可选 `model` | 测试一个凭证/模型并返回分类结果 | 凭证及额度卡片测试；可能更新错误、冷却或健康状态 |
| `POST /creds/batch-test` | query `mode`；body `{filenames: [...]}` | 并发 5 批量测试；失败仍走 auto-ban/SMART 429 分类 | 批量消息测试按钮 |
| `POST /creds/upload-by-refresh-token` | `RefreshTokenAddRequest` | OAuth 换 token、探测项目/等级并入库 | 单个接口仍受保护，当前公共前端主要调用批量接口 |
| `POST /creds/upload-by-refresh-token-batch` | tokens、可选 client ID/secret、mode、文件名前缀 | 去空、去重、并发 5 导入，逐项返回结果 | `addCredentialByRefreshToken()` |
| `GET /creds/stats-today` | 可选 query `mode` | 北京时间今日成功、失败、总数、成功率 | 统计兼容接口；读后端日统计 |
| `GET /creds/stats-recent` | `days` 默认 7、最大 90；可选 `mode` | 最近 N 天统计列表 | 当前前端未作为主要卡片入口，但属于受保护 API |
| `GET /creds/stats-today-by-model` | 可选 query `mode` | 今日模型家族统计及 RPM | `refreshTodayStats()`；桌面/移动统计卡片 |

### 7.1 既有接口上的扩展

这些不是全新路径，但 dev6/dev5 扩展了其契约，同样必须保护：

- `GET /config/get`：新增 SMART 429、debug、routing 和 `stream_diagnostics_enabled`，并返回 `env_locked`。
- `POST /config/save`：验证 SMART 429 数值范围和 TTFT 诊断布尔值，保存后刷新同步缓存并重配服务；
  单 Worker 热更新诊断开关，多 Worker 仅持久化并返回 `restart_required`，响应还要区分 `reloaded`。
- `GET /creds/status`：新增永久禁用、冷却、Preview、等级、备注和健康状态筛选/字段。
- `GET /creds/quota/{filename}`：增加 GeminiCLI 额度、原始模型 ID、显示名、测试模型和健康分类。
- `POST /creds/action`、`POST /creds/batch-action`：支持永久禁用及相关状态保持。
- OAuth、上传和凭证检验响应：携带标准化等级及原始等级证据。
- `/version/info`：使用构建元数据或 `version.txt`，并可检查上游版本。
- 所有 GeminiCLI 流式 OpenAI/Gemini/Anthropic 入口：响应始终带 `X-Request-ID`；启用诊断时可带
  `Server-Timing`。这些路径没有新增 URL，但错误码、重试边界和流内终止格式已成为 dev6 公共契约。

## 8. 前端保护清单

### 8.1 桌面端 `front/control_panel.html`

- GeminiCLI 和 Antigravity 今日统计卡片：总数、成功、失败、RPM、成功率、模型明细。
- Refresh Token 批量输入、mode、可选 client ID/secret、文件名前缀和逐项结果。
- 永久禁用、批量消息测试、额度检测/双向冷却、状态/等级/Preview/冷却/备注筛选。
- 凭证备注 badge、当前/上一循环统计、模型冷却倒计时、额度详情和单模型测试。
- 存储引擎状态、server_name 选择、迁移预览与切换。
- SMART 429、debug、routing、独立“流式 TTFT 诊断”开关及环境变量锁定提示。
- 系统状态页中的 Redis 和 SMART 429 状态。

### 8.2 移动端 `front/control_panel_mobile.html`

移动端必须保持与桌面端的核心能力对等，不得在同步时只更新桌面端：

- 两种 mode 的统计卡片和模型表格。
- Refresh Token 导入及高级选项。
- 永久禁用、批量测试、额度/冷却同步和全部筛选项。
- SMART 429、debug、routing、独立“流式 TTFT 诊断”开关及环境变量锁定提示。
- 系统状态页。

### 8.3 共用逻辑 `front/common.js`

- `CredentialManager` 的分页、筛选、全局统计及 API endpoint 映射。
- 凭证卡片状态、等级/健康/冷却/备注/循环统计渲染。
- 额度、模型测试、批量测试、冷却同步、Refresh Token 导入和统计刷新。
- `loadSystemStatus()`、`loadStorageEngine()`、`switchStorageEngine()`。
- 配置加载/保存时 SMART 429、debug、routing、TTFT diagnostics 的默认值必须与后端一致。
- `setConfigCheckbox()` 必须让环境变量锁定的复选框只读；多 Worker 保存 TTFT 诊断设置后要提示重启。
- 冷却和统计定时器只能有一个有效实例；`test_frontend_static.py` 防止重复 ID 和计时器声明丢失。

## 9. 部署、版本和测试资产

### 9.1 部署与版本

- `docker-compose.yml` 默认连接本机 Redis，包含 Redis service、持久卷、健康检查和应用依赖关系。
- `requirements.txt` 的 `aiomysql>=0.2.0` 是 MySQL 后端硬依赖。
- CI 的 SHA 镜像标签带分支前缀，避免非默认分支产生无效或冲突标签。
- dev5 Dockerfile 注入 `GCLI2API_BUILD_DATE`、`GCLI2API_VERSION`、`GCLI2API_REVISION`。
- `src/versioning.py` 决定展示版本和静态资源缓存键；不能退回只读 `version.txt` 的实现。
- `scripts/migrate_sqlite_to_mysql.py` 支持 dry-run、server_name、建表、凭证/配置迁移和校验。

### 9.2 受保护测试（dev6 共 11 个顶层文件）

| 文件 | 覆盖重点 |
| --- | --- |
| `test_frontend_static.py` | 统计刷新 timer、桌面/移动页面重复 ID、TTFT 诊断控件及 common.js 加载/保存/锁定逻辑 |
| `test_gemini35_tier_routing.py` | 无合格凭证 503、MySQL/MongoDB Redis tier 池、别名与原始额度模型 |
| `test_geminicli_subscription_api.py` | Code Assist 请求、失败回退、Antigravity 付费等级回退与请求体兼容 |
| `test_hedge_stats.py` | 对冲预算原子预留、结果统计、跨日期/凭证/模型族隔离 |
| `test_smart_429.py` | 429 互斥分类、精确风控、multi-worker fail-closed、健康迁移、singleflight、状态版本 |
| `test_stream_diagnostics_config.py` | 持久化热更新、环境变量优先/锁定、请求快照、面板校验及单/多 Worker 保存语义 |
| `test_streaming_latency.py` | TTFT 分阶段超时、终止错误、连接复用、OAuth/初始化 single-flight、凭证排除和禁止内容后重试 |
| `test_sqlite_tier_storage.py` | 原始 tier 字段迁移、Gemini 3.5 等级路由 |
| `test_subscription_tiers.py` | tier 映射优先级、unknown、项目 ID 形式、模型资格 |
| `test_upload_tier_detection.py` | 上传后等级持久化、检测失败保持旧状态、响应字段 |
| `test_versioning.py` | version.txt 回退、发布元数据优先、分支构建与资源缓存键 |

同步后不得只跑测试文件是否可导入；至少应执行上述 11 个文件，并按冲突范围补跑上游测试。
上游 `tests/test_gemini_fix.py` 是第 12 个受保护测试文件。

## 10. 2026-07-31 上游同步冲突与语义热点

### 10.1 已确认并解决的文本冲突

| 文件 | 本地内容 | 上游内容 | 已批准并执行的处理 |
| --- | --- | --- | --- |
| `.gitignore` | 保留 `zeaburcli/`、`sshcli/`、`deploy/`、`tests/`、`参考项目/` 等本地忽略项 | 新增 `streamchat/` | 合并双方全部规则 |
| `src/utils.py` | Gemini 3.5 Flash/Preview 模型、别名和等级路由 | 删除 `gemini-3.5-flash` | 完整保留 dev6 模型与路由 |
| `version.txt` | fork 源码元数据 | 更新到上游 `18033ab` | 采用上游元数据作为已同步基线；镜像继续使用注入的 fork SHA |
| `web.py` | SMART 429、分钟统计、hedge、存储和 HTTP 池生命周期 | GC/`malloc_trim` 和凭证关闭修复 | 同时保留双方任务；直接关闭 credential singleton；HTTP 池最后关闭 |

### 10.2 双方修改但可能自动合并的文件

| 文件 | 语义风险与必查项 |
| --- | --- |
| `Dockerfile` | 已吸收 jemalloc/MALLOC_CONF，保留构建元数据；`LD_PRELOAD=libjemalloc.so.2` 避免写死 x86_64 路径 |
| `src/api/antigravity.py` | 拒绝自动删除非流式 `timeout=300.0`，避免落到共享客户端 30 秒默认值 |
| `src/api/geminicli.py` | 同样保留 300 秒；TTFT、容量快速失败、对冲和 503 语义不变 |
| `src/converter/gemini_fix.py` | Claude 工具统一输出 `parameters`；保留 dev6 thinking、tier、图像和多轮工具修复 |
| `.gitignore` | 见文本冲突 |
| `src/utils.py` | 见文本冲突 |
| `version.txt` | 见文本冲突 |
| `web.py` | 见文本冲突；上游回收任务不得在仍有活动流时提前关闭 dev6 共享池或代理池 generation |

### 10.3 本次已引入的上游内容

共同祖先之后的上游功能重点包括：

- Claude/Antigravity 工具 schema 修复及其后续回退/调整。
- jemalloc 和运行时内存回收。
- 非流式 timeout 移除提案（本次因会把 dev6 的 300 秒静默缩短为 30 秒而明确拒绝）。
- `src/utils.py` 的后续更新。
- 对应的版本元数据提交。

`tests/test_gemini_fix.py` 是同步前唯一“仅上游新增”的文件，现已引入并扩充为 3 个用例。

上游“移除请求 timeout”与 dev6 的 TTFT 分阶段上限属于高风险语义冲突：可以吸收上游修复的动机，
但不得直接删除 `pool/connect/write/header/first-event/first-content/idle` 各阶段预算，也不得恢复无界等待。

## 11. 已知实现风险（只记录，不在本次修复）

| 风险 | 当前事实 | 同步/后续处理要求 |
| --- | --- | --- |
| `STORAGE_ENGINE` 说明与实现不一致 | `.env.example` 宣称显式选择；`src/storage_adapter.py` 实际不读取该变量，而是按 `MYSQL_URI+GCLI_SERVER_NAME`、PostgreSQL URI、MongoDB URI 决定后端 | 不得依据示例擅自重写选择逻辑；需单独设计并获确认 |
| MySQL 示例缺项 | 代码依赖 `MYSQL_URI`、`GCLI_SERVER_NAME`，但 `.env.example` 没有实际赋值模板 | 后续文档/配置修复单独处理 |
| 在线存储切换不持久 | `/config/storage-engine/switch` 更换当前 adapter，并可能临时设置进程内 `GCLI_SERVER_NAME`；重启后仍按环境 URI 重新选择 | 面板“切换成功”不等于部署配置永久改变 |
| 无认证调试接口 | `/config/debug-storage` 明确无需 token，会暴露后端类型、server_name、服务器列表片段和异常 traceback | 部署时评估暴露面；修改认证需另行批准 |
| SMART 429 部署限制 | 只支持 `WORKERS=1` 的单副本；外部多副本无法共享内存熔断状态 | 多实例前不得开启 |
| SMART 429 人工验收状态未知 | 自动化测试存在，但 review 文档还要求小号池人工验证后才启用 | 默认保持关闭 |
| `tests/` 被忽略 | `.gitignore` 忽略 `tests/`，而上游新增测试位于该目录 | 同步时明确保留并跟踪上游测试，不得因 ignore 误删 |
| 生命周期关闭路径 | 本次已改为直接关闭 `credential_manager` singleton，并通过启停烟测确认 credential→hedge→storage→HTTP 顺序 | 后续修改 `web.py` 必须继续保证 HTTP 池最后关闭 |
| jemalloc 多架构验证 | 已采用跨架构动态库名；本机 Docker daemon 未运行，无法完成实际 amd64/arm64 build | 推送前由现有 buildx CI 验证两种架构，不得改回 x86_64 硬编码路径 |
| dev6 提交锚点 | 初始 TTFT 实施已提交并推送为 `3c73782efee69076e3dd440f1e07ab2f4902971a` | 后续同步必须从 `origin/dev6` 创建独立分支，不得直接修改 dev6/dev5 |
| dev6 测试证据来源 | 同步前 `182 passed, 7 warnings`；本次解决后 `185 passed, 7 warnings` | 后续提交/同步仍需重新运行并保存当次结果，不得直接复用历史结论 |

## 12. 同步前文件覆盖矩阵（74/74）

本节用于机械核对，防止功能说明完整但漏掉文件。路径按共同祖先三方分类。

### 12.1 仅 dev6 修改（65）

| 分组 | 文件 | 对应保护项 |
| --- | --- | --- |
| 配置/文档/部署（16） | `.agent/workflows/debug-log.md`、`.env.example`、`.github/workflows/docker-publish.yml`、`README.md`、`config.py`、`docker-compose.yml`、`docs/CUSTOM_MODIFICATIONS.md`、`docs/STREAMING_TTFT_LATENCY_REVIEW.md`、`docs/http_status_codes.md`、`log.py`、`pyproject.toml`、`requirements.txt`、`review/GEMINI_CLI_TIER_REVIEW.md`、`review/SMART_429_PROTECTION_AUDIT.md`、`review/SMART_429_PROTECTION_REVIEW.md`、`scripts/migrate_sqlite_to_mysql.py` | S429、TIER、OPS、STORE、API-05/API-06 |
| 前端（3） | `front/common.js`、`front/control_panel.html`、`front/control_panel_mobile.html` | UI-01、UI-02、CRED、STAT |
| API/认证/转换/面板/路由（29） | `src/api/utils.py`、`src/api/vertex.py`、`src/auth.py`、`src/converter/anthropic2gemini.py`、`src/converter/anti_truncation.py`、`src/converter/openai2gemini.py`、`src/credential_manager.py`、`src/google_oauth_api.py`、`src/hedge_stats.py`、`src/httpx_client.py`、`src/log_safety.py`、`src/models.py`、`src/panel/auth.py`、`src/panel/config_routes.py`、`src/panel/creds.py`、`src/panel/root.py`、`src/panel/version.py`、`src/router/antigravity/anthropic.py`、`src/router/antigravity/gemini.py`、`src/router/antigravity/openai.py`、`src/router/geminicli/anthropic.py`、`src/router/geminicli/gemini.py`、`src/router/geminicli/openai.py`、`src/router/stream_passthrough.py`、`src/smart_429.py`、`src/streaming_latency.py`、`src/subscription_tiers.py`、`src/usage_stats.py`、`src/versioning.py` | CRED、ROUTE、S429、TIER、MODEL、API、AUTH、CORE、CONV、OPS |
| 存储（6） | `src/storage/_stats_common.py`、`src/storage/mongodb_manager.py`、`src/storage/mysql_manager.py`、`src/storage/psql_manager.py`、`src/storage/sqlite_manager.py`、`src/storage_adapter.py` | STORE、STAT、S429、TIER |
| 测试（11） | `test_frontend_static.py`、`test_gemini35_tier_routing.py`、`test_geminicli_subscription_api.py`、`test_hedge_stats.py`、`test_smart_429.py`、`test_sqlite_tier_storage.py`、`test_stream_diagnostics_config.py`、`test_streaming_latency.py`、`test_subscription_tiers.py`、`test_upload_tier_detection.py`、`test_versioning.py` | 第 9.2 节 |

### 12.2 双方修改（8）

`.gitignore`、`Dockerfile`、`src/api/antigravity.py`、`src/api/geminicli.py`、
`src/converter/gemini_fix.py`、`src/utils.py`、`version.txt`、`web.py`。

这 8 个文件已全部人工复核；其中 4 个产生文本冲突，解决结果见第 10 节和同步报告。

### 12.3 仅上游新增（1）

`tests/test_gemini_fix.py`。本次已引入并纳入全量 pytest。

### 12.4 dev6 初始实施相对 dev5 的增量文件（30/30，不含本文档）

这一矩阵是对 12.1–12.3 的 dev6/上游全量矩阵所做的增量解释。`M` 表示相对 `origin/dev5` 修改，
`A` 表示由 dev6 新增；初始实施提交已将 4 个新增项目文件全部纳入版本控制。

| 分组 | 状态与文件 | 对应保护项 |
| --- | --- | --- |
| 配置与双端 UI（5） | `M .env.example`、`M config.py`、`M front/common.js`、`M front/control_panel.html`、`M front/control_panel_mobile.html` | API-05、UI-01、TTFT 配置 |
| 流式 API、认证与转换（14） | `M src/api/antigravity.py`、`M src/api/geminicli.py`、`M src/api/utils.py`、`M src/converter/anthropic2gemini.py`、`M src/converter/anti_truncation.py`、`M src/credential_manager.py`、`M src/google_oauth_api.py`、`M src/httpx_client.py`、`M src/panel/config_routes.py`、`M src/router/geminicli/anthropic.py`、`M src/router/geminicli/gemini.py`、`M src/router/geminicli/openai.py`、`M src/router/stream_passthrough.py`、`A src/streaming_latency.py` | API-05、API-06、AUTH-01、CORE-01 |
| 存储与生命周期（6） | `M src/storage/mongodb_manager.py`、`M src/storage/mysql_manager.py`、`M src/storage/psql_manager.py`、`M src/storage/sqlite_manager.py`、`M src/storage_adapter.py`、`M web.py` | 凭证排除、CORE-01、OPS-03 |
| 顶层测试（4） | `M test_frontend_static.py`、`M test_gemini35_tier_routing.py`、`A test_stream_diagnostics_config.py`、`A test_streaming_latency.py` | 第 9.2 节 |
| 设计/验收资料（1） | `A docs/STREAMING_TTFT_LATENCY_REVIEW.md` | dev6 设计依据与既有测试记录 |

30 个文件中没有新增公开 URL；公共变化集中在既有配置接口、所有 GeminiCLI 流式响应、错误状态、
响应头和内部存储选择能力。4 个新增项目文件现已全部由 Git 跟踪。

### 12.5 2026-07-31 上游同步净变化（9）

| 状态 | 文件 | 结果 |
| --- | --- | --- |
| 修改（7） | `.gitignore`、`Dockerfile`、`src/api/antigravity.py`、`src/api/geminicli.py`、`src/converter/gemini_fix.py`、`version.txt`、`web.py` | 冲突与语义处理见第 10 节 |
| 新增（2） | `docs/UPSTREAM_SYNC_20260731.md`、`tests/test_gemini_fix.py` | 同步报告及 3 个 Claude schema 回归测试 |

`src/utils.py` 虽产生文本冲突，但最终完整保留 dev6 内容，因此相对同步前 HEAD 没有净变化。

## 13. 标准同步流程

### 13.1 同步前

1. 确认 `git status --short` 为空；如有用户改动，先停止，不得清理、stash、提交或覆盖。
2. 执行 `git fetch origin upstream`，记录 `origin/dev6`、`origin/dev5`、`upstream/master` 和 merge-base。
3. 从 `origin/dev6` 创建独立分支，例如 `codex/sync-upstream-YYYYMMDD`；禁止直接在 dev6、dev5 或 master 操作。
4. 重新生成三类文件清单、提交清单和 `git merge-tree` 预演结果。
5. 将预演结果与本文功能 ID、接口表、字段表、最新文件矩阵及 dev6 的自定义增量比较。

### 13.2 冲突报告格式

每个冲突至少包含：

```text
文件/符号：
冲突类型：文本 / 自动合并语义 / 数据契约 / API 契约
dev6/dev5 当前行为：
上游变化：
如果采用上游的影响：
如果只保留 dev6/dev5 的影响：
候选合并方案：
需要用户决定的问题：
建议回归测试：
```

报告完成后等待明确指令。不要编辑冲突文件，不要暂存，不要提交；是否保留冲突现场或执行
`git merge --abort` 也由用户决定。

### 13.3 获准处理后

1. 按功能 ID 而非整文件解决冲突。
2. 先保护数据列、配置键和 API 响应，再处理内部重构。
3. 同时检查 8 个双方修改文件的自动合并结果。
4. 执行 dev6 的 11 个顶层测试文件、上游新增测试及冲突涉及的其他测试。
5. 检查桌面和移动面板，不能只验证一端。
6. 对存储变化至少验证 SQLite；远程后端无法实测时必须明确标记未验证。
7. 成功同步后更新本文的 SHA、差异数量、冲突状态和文件矩阵。

## 14. 同步验收清单

- [ ] dev6/dev5 受保护功能 ID 均能在新代码中定位。
- [ ] 15 个自定义管理接口仍存在，方法、认证、参数和响应语义未静默变化。
- [ ] 既有扩展接口仍返回等级、健康、备注、冷却和统计字段。
- [ ] SMART 429 默认关闭、单 worker 限制、能力检查和 503 语义仍有效。
- [ ] 六种订阅等级和三个原始等级字段仍完整。
- [ ] 七个健康状态字段在 SQLite/MySQL/PostgreSQL/MongoDB 中等价可读写。
- [ ] 永久禁用、循环统计、精确冷却和备注不会在迁移后丢失。
- [ ] 桌面端与移动端的统计、导入、筛选和 SMART 429 设置均可用。
- [ ] TTFT 诊断默认关闭；开启后 `X-Request-ID`、采样日志和可选 `Server-Timing` 符合第 16 节。
- [ ] 首个有效事件后不切换凭证、不重放；提交响应后的错误使用对应流协议终止。
- [ ] dev6 的 11 个顶层测试文件全部通过。
- [ ] 上游新增 `tests/test_gemini_fix.py` 已保留并通过。
- [ ] `Dockerfile` 同时包含版本元数据和已批准的上游内存优化。
- [ ] `web.py` 同时保留本地生命周期任务和已批准的上游关闭/内存处理。
- [ ] `git diff --check` 通过，无未解释的文件变化。
- [ ] 冲突报告和最终决策已归档，本文基线已更新。

## 15. 文档维护约定

- 新增自定义功能时先分配新的稳定 ID，并补充行为、接口/字段、文件、提交和测试。
- 删除或改变受保护功能必须有明确决策记录；不要直接从表中抹除历史。
- 文件移动时更新代码位置，但保留功能 ID，便于跨版本追踪。
- 每次成功同步在本节追加一条记录：日期、旧/新双方 SHA、冲突摘要、批准人/决策和测试结果。
- 审计发现但未修复的问题保留在“已知实现风险”，修复完成后注明对应提交，不要无痕删除。

### 同步记录

| 日期 | dev6/dev5 基线 | 上游基线 | 结果 |
| --- | --- | --- | --- |
| 2026-07-30 | `5a85e58` | `4f5e343` | 建立首份保护清单；只读预演发现 4 个文本冲突、8 个双方修改文件；未执行同步 |
| 2026-07-30 | `origin/dev6@3c73782`，基于 `5a85e58` | 未同步上游 | 登记 30 个项目文件的 dev6 增量、API-05/API-06/AUTH-01/CORE-01/OPS-03；全量测试 `112 passed, 7 warnings` |
| 2026-07-31 | `origin/dev6@7e7675b` | `upstream/master@4f5e343` | merge `d35471a`；人工解决 4 个文本冲突并复核 8 个双方修改文件；`185 passed, 7 warnings`；未推送 |

## 16. dev6 最新修改明细（相对 `origin/dev5`）

### 16.1 版本性质与范围

- dev6 已推送到 `origin/dev6`；初始 TTFT 实施提交为
  `3c73782efee69076e3dd440f1e07ab2f4902971a`，提交基座为 dev5 的 `5a85e58`。
- 初始实施提交共涉及 31 个文件、约 `+3564/-485`；其中除本文档外的业务、测试和设计资料
  共 30 个文件，新增项目文件均已纳入 Git。
- 本次变更没有增加新的公开 URL，主要改变 GeminiCLI 流式请求的时间边界、重试资格、错误输出、
  请求诊断、连接池生命周期，以及现有 `/config/get`、`/config/save` 的字段和保存语义。
- 完整文件列表见第 12.4 节；`docs/STREAMING_TTFT_LATENCY_REVIEW.md` 是设计和历史验收资料，
  `src/streaming_latency.py` 是运行时契约实现，两者都不得在提交或同步时遗漏。

### 16.2 流式请求状态机与总预算

`StreamRequestTrace` 为每个请求生成 request ID，并按以下阶段记录时间和失败位置：

| 阶段 | 含义 | 必须保留的边界 |
| --- | --- | --- |
| `preparing` | 解析请求、创建追踪并快照诊断开关 | 同一在途请求不受控制面板随后切换诊断开关影响 |
| `selecting_credential` | 获取未被本次请求排除的凭证 | 默认最多等 10 秒；等待超时为 504，没有合格凭证为 503 |
| `refreshing_token` | 获取/刷新 OAuth token | 阻塞刷新默认最多 20 秒；临时错误不永久封禁 |
| `waiting_headers` | 建连、写请求并等待响应头 | pool/connect/write/header 分别计时；不得把收到 200 响应头当成首事件 |
| `waiting_first_event` | 等第一个有效上游流事件 | 默认 45 秒；此阶段失败才可能切换凭证 |
| `upstream_started` | 已观察到首个有效上游事件 | 从此不可切换凭证或重放请求，即使尚未产生用户可见文本 |
| `content_emitted` | 已向客户端发送首个有效内容 | 继续受 90 秒 idle 上限保护；错误只能在当前协议内终止 |
| `finished` / `failed` | 正常结束或带阶段失败 | 输出一次汇总，释放活动流和代理 generation 引用 |

首个下游内容的默认总预算是 75 秒，跨凭证尝试共享，不能在重试时重新起算。传输最多尝试 2 次，
且必须排除已经失败的凭证；此排除能力在 SMART 429 关闭时也要生效，并由 SQLite、MySQL、
PostgreSQL、MongoDB/Redis 选择路径一致支持。

### 16.3 错误与重试契约

- `StreamFailure` 必须携带 HTTP 状态、stage、`retryable`、协议错误体/响应头和 request ID；
  `StreamRequestTrace` 另行记录可选 upstream request ID。converter 与 anti-truncation 必须原样向外传播，
  不能转成普通内容导致隐式重放。
- HTTP 尚未提交时：连接类失败返回 502；阶段/总预算超时返回 504；无可用凭证、全体容量冷却或
  429 尝试耗尽返回 503。响应体要符合调用方选择的 OpenAI、Gemini 或 Anthropic 格式。
- HTTP 已提交后：OpenAI/Gemini 流发送 SSE error 并以 `[DONE]` 收尾；Anthropic 发送
  `event: error` 后关闭。此时不得改 HTTP 状态、切换凭证或从头重放。
- dev6 移除了 GeminiCLI 三种路由和 anti-truncation 内层的重复预读，只允许最终响应边界完成一次
  首事件预读。重试等待也只在凭证切换路径发生一次，`handle_error_with_retry` 不再额外 sleep。
- 首事件前的重试只处理允许切换的传输/容量失败；首事件之后无论是 idle timeout、协议错误还是
  网络中断，都只能终止当前流。

### 16.4 诊断与隐私边界

- `STREAM_DIAGNOSTICS_ENABLED` 默认 `false`，与 `DEBUG_MODE` 独立。关闭时超时和阶段保护仍生效，
  但不输出性能摘要和 `Server-Timing`。
- `X-Request-ID` 始终返回。启用诊断后可返回 `Server-Timing`，并输出 `STREAM_PERF_SUMMARY`：
  慢请求、失败、重试必须记录；普通成功按默认 1% 采样。
- 日志只记录阶段耗时、状态、模型、上游 request ID 和凭证文件名的 SHA-256 摘要；不得记录
  access/refresh token、prompt、响应正文、完整凭证文件名、代理 URL 中的用户名或密码。
- 请求开始时快照诊断设置，所以热切换只影响新请求。环境变量命中时控制面板只读；单 Worker
  保存后热更新，多 Worker 只持久化并明确返回/提示需要重启。

### 16.5 HTTP 连接池与代理轮换

- `src/httpx_client.py` 从“每次创建 client 的工厂”改为真实共享 HTTPX 池：
  `max_connections=100`、`max_keepalive_connections=20`、keepalive 30 秒，并显式
  `trust_env=False`，直连模式不得意外读取宿主机 `HTTP_PROXY`/`HTTPS_PROXY`。
- 通用 POST 默认超时从 900 秒收紧为 30 秒；流式路径使用第 3.1 节各阶段的独立上限，不能把两者
  混成单一 read timeout。
- 代理配置变化时按配置指纹创建新 generation；旧 generation 在活动流归零后再关闭，不能因面板
  改代理而中断已有长流。应用关闭时共享 HTTP 池必须最后关闭。
- `open_stream_post()`/`UpstreamStream` 负责显式打开和释放响应流，并对等待响应头设置边界。
  生产路径中的 `_MOCK_STREAM_429` 已移除，不得在同步时恢复测试后门。

### 16.6 OAuth、凭证和单例并发

- token 刷新按 `(mode, filename)` singleflight：200 个并发请求也只能共享一个实际刷新任务；
  等待者使用 `asyncio.shield`，单个请求取消不能取消全局刷新。
- token 剩余 1–10 分钟时启动后台刷新但允许当前 token 继续服务；剩余不超过 1 分钟时阻塞等待。
  `invalid_grant` 等永久错误仍可禁用凭证，超时/网络等临时失败不得永久禁用。
- CredentialManager 和 StorageAdapter 使用锁保护的“候选对象完整初始化后再发布”流程，避免并发
  首次访问拿到半初始化单例。关闭 StorageAdapter 同样在锁内完成状态切换。
- 无 SMART 429 时也要尊重当前请求的 `excluded_credentials`，防止同一坏凭证在两次尝试中被重复选中。

### 16.7 前端与配置变更

- 桌面和移动控制面板均新增“流式 TTFT 诊断”复选框、说明和环境变量锁定提示；只能两端一起保留。
- `front/common.js` 的通用 checkbox 装载逻辑会禁用 `env_locked` 字段；保存结果根据
  `reloaded`/`restart_required` 给出单 Worker 热更新或多 Worker 重启提示。
- `/config/get` 返回 `stream_diagnostics_enabled`；`/config/save` 只接受布尔值，环境变量锁定时忽略
  数据库覆盖。其余 TTFT 数值参数当前保持环境变量配置，默认值见第 3.1 节。

### 16.8 明确未采用的行为

dev6 v1 明确没有实现以下行为，同步时不能以“优化”为名私自加入，因为它们会改变客户端可观察语义：

- 不发送伪 heartbeat 来掩盖上游首事件延迟。
- 不在只收到上游 200 响应头时提前向下游提交 200。
- 不做无延迟、无并发上限或超过两次上游调用的通用 hedged request；唯一例外是第 16.11 节
  明确定义且默认关闭的 GeminiCLI 真流响应头对冲。
- 不在首个有效上游事件之后切换凭证或重放。
- 不让 `DEBUG_MODE` 隐式开启 TTFT 诊断，不让代理直连模式继承宿主环境代理。

如需采用其中任何一项，必须独立设计、评估计费/重复工具调用/隐私风险并取得用户明确批准。

### 16.9 TTFT 诊断 schema v2 与容量快速失败

- `STREAM_PERF_SUMMARY` 增加 `schema_version=2`、状态/传输/容量重试计数、
  `last_failure`、最多 8 条 `attempt_details` 及事件数/字节数/取消阶段；旧字段继续保留。
- 诊断开启时尽力拆分连接池等待估算、TCP、TLS、写入和响应头等待；诊断关闭时不注册传输 trace。
- 下游合法的 `X-Client-Request-ID` 或入站 `X-Request-ID` 作为 `client_request_id`，
  不替代服务端始终返回的 `X-Request-ID`。
- 新增默认关闭的 `GEMINICLI_CAPACITY_FAST_FAIL_ENABLED` /
  `geminicli_capacity_fast_fail_enabled`。开启后模型容量不足单请求最多调用上游两次，
  之后由进程内模型保护器快速返回带 `Retry-After` 的 503。
- 容量保护器初始冷却 5 秒，half-open 失败后按 10/20/30 秒重新打开；模型容量事件不得污染
  凭证额度、风险、OAuth 或永久禁用状态。
- 桌面和移动控制面板共同提供开关。环境变量锁定优先；单 Worker 热更新，多 Worker 需重启，
  且保护器状态不跨 Worker 同步。
- 所有凭证运行日志使用 SHA-256 前 12 位 `diagnostic_id`；凭证状态接口提供同一字段用于映射，
  日志禁止记录完整文件名、邮箱、Token、Prompt、代理认证信息和完整上游错误正文。

### 16.10 测试与验收证据

- 新增 `test_streaming_latency.py`，覆盖阶段超时、协议终止错误、共享池复用与关闭、代理 generation、
  `trust_env=False`、并发 OAuth、单例竞态、单次 sleep、凭证排除、首事件前重试及首事件后禁重试。
- 新增 `test_stream_diagnostics_config.py`，覆盖默认值、持久化热更新、环境变量优先/锁定、请求快照、
  面板校验，以及单/多 Worker 保存行为。
- `test_frontend_static.py` 增加双端控件和 common.js load/save/lock 静态检查；
  `test_gemini35_tier_routing.py` 更新为断言 credential 阶段的 typed 503 failure。
- `docs/STREAMING_TTFT_LATENCY_REVIEW.md` 记录实现完成时的测试结果；推送前已在项目 `.venv`
  中重新执行全量 pytest，增强后的结果为 `135 passed, 7 warnings`，compileall 和 diff-check 也已通过。
  以后每次同步仍须重新验证，不能直接复用本次结果。

### 16.11 HTTP/2 与 GeminiCLI 真流响应头对冲

- `UPSTREAM_HTTP2_ENABLED` 默认关闭且只读环境变量。共享 HTTPX client 创建时显式传入
  `http2`，transport generation 指纹同时包含代理配置和 HTTP/2 状态；旧 generation
  继续等待活动流释放后关闭。依赖显式声明为 `httpx[http2,socks]`，协商失败时仍允许
  HTTPX 使用 HTTP/1.1。
- `GEMINICLI_STREAM_HEADER_HEDGE_ENABLED` /
  `geminicli_stream_header_hedge_enabled` 是独立且默认关闭的布尔开关。首请求 15 秒内没有
  响应头、命中采样、存在不同备用凭证并取得单 Worker 信号量时才启动第二请求。
- 首请求已经收到响应头时不启动对冲。对冲启动后以首个非空有效上游事件为胜者，先取消并关闭
  败方，再向下游交付胜者首事件；败方标记为 `superseded`，不得处罚凭证或写入 SMART/容量状态。
- 对冲启动后首内容前上游调用总数最多为 2，不再追加第三次串行尝试。明确的 400 立即终止另一
  请求；401/403 只处理对应凭证；单侧容量失败继续等待另一侧，双容量失败返回带
  `Retry-After` 的 503，并只更新一次模型容量状态。
- 每个尝试使用独立 attempt 句柄记录阶段、耗时、凭证诊断 ID 和实际 `http_version`。
  schema v2 的 `retries.hedge`、`retries.reasons` 和顶层 `hedge` 记录采样、启动、延迟、胜者、
  败方结果及跳过原因；诊断开启时 `Server-Timing` 增加已确定的 `hedge` 时间点。

### 16.12 对冲成本统计与每日预算

- 新增独立 `daily_hedge_stats` 存储，SQLite、MySQL、PostgreSQL 和 MongoDB
  均在启动时自动创建表或集合。预算桶以北京时间日期、备用凭证和规范化模型族为键，
  多 Worker 通过存储原子更新共享预算。
- 每个真正获准启动的备用上游请求立即计入 `extra_upstream_requests` 和
  `outcome_pending`，取消请求不退回，属于保守的“预计额度消耗”，不等同于 Google
  最终计费记录。
- 默认每个凭证、每个模型族每日 10 次。预算检查最多等待 500ms；预算耗尽、
  存储超时或异常只会跳过对冲并继续主请求，分别记录
  `daily_budget_exhausted` 或 `budget_check_failed`。
- 对冲完成后异步记录 `primary_wins`、`backup_wins`、`confirmed_rescues`、
  `both_failed` 或 `client_cancelled`；统计写入失败不改变响应和凭证状态。
- `GET /creds/hedge-stats?days=7` 返回最近 1–90 天的日期、模型族和凭证诊断 ID
  汇总。控制面板展示今日预计消耗、剩余额度、胜负、挽救和每次备用获胜成本，
  不返回完整凭证文件名。
- 采样率改为持久化热配置，初始建议 5%。首版由管理员根据备用获胜率手动调整，
  不实现自动反馈控制。
- 控制面板桌面版和移动版均提供“GeminiCLI 流式响应头对冲”、采样率、每日预算和
  “今日对冲成本”。环境变量存在时对应控件只读；单 Worker 保存后热更新，多 Worker
  保存后提示重启。延迟和并发上限仍只通过环境变量配置，对冲信号量按 Worker 独立，
  预算通过主存储跨 Worker 原子共享，不使用 Redis 协调。
- 加入对冲成本预算后全量回归为 `182 passed, 7 warnings`，并通过 `compileall`、
  JavaScript 语法检查和 `git diff --check`。

## 17. 2026-07-31 上游同步新增保护决策

- Antigravity Claude 工具必须将输入的 `parametersJsonSchema`、`parameters_json_schema`、
  `parameters` 或 `custom.input_schema` 归一化为 `functionDeclarations.parameters`，
  避免内部转换丢失 `custom.input_schema`。
- GeminiCLI Claude 工具继续接受相同的输入变体，并输出唯一的 `parameters` 字段；
  不得同时发送多个 schema 字段。
- Antigravity 和 GeminiCLI 非流式主请求继续显式使用 `timeout=300.0`。上游若再次移除，
  必须结合共享客户端默认值重新评估，不能自动接受。
- Docker 必须同时保留构建元数据、`libjemalloc2`、`MALLOC_CONF`，且不得将
  `LD_PRELOAD` 写死为 x86_64 路径；现有 CI 的 amd64/arm64 构建均为验收门槛。
- `web.py` 必须启动并在退出时取消内存回收任务；关闭顺序至少满足：
  SMART 429/后台任务 → credential manager → hedge stats → storage adapter → HTTP pool。
- `version.txt` 在本次同步中记录上游 `18033ab`，表示已吸收的上游版本；发布镜像的实际
  fork 版本仍由 `GCLI2API_VERSION`、`GCLI2API_REVISION`、`GCLI2API_BUILD_DATE` 提供。
- 本次完整决策、冲突证据、测试和未完成的 Docker CI 验证记录在
  `docs/UPSTREAM_SYNC_20260731.md`。
