# dev5 自定义修改与上游同步保护清单

> **用途**：本文档是 `lywx215/gcli2api` 的自定义行为契约和以后同步
> `su-kaka/gcli2api` 时的人工保护清单。它不是普通的变更日志。
>
> **最高优先级规则**：dev5 已有行为、接口和数据兼容性优先。发现文本冲突或语义冲突时，
> 必须先报告，不得自行选择 `ours`/`theirs`、不得整文件覆盖、不得在未确认的情况下改写代码。

## 1. 审计基线

审计日期：2026-07-30（Asia/Shanghai）。远端 SHA 已通过 `git ls-remote` 核对。

| 项目 | 值 |
| --- | --- |
| Fork 远端 | `origin = https://github.com/lywx215/gcli2api.git` |
| 上游远端 | `upstream = https://github.com/su-kaka/gcli2api.git` |
| 受保护主基线 | `origin/dev5`，`5a85e5892a679445e77125d1567f6699d845fa76` |
| 上游比较基线 | `upstream/master`，`4f5e3432e1d5fc5ba41cf56c99981ba89d1987f7` |
| 共同祖先 | `78f391acee42cc2b2b39bf55577c8eed80aab7e3` |
| 提交分叉 | 上游独有 13 个提交；dev5 独有 127 个提交 |
| 直接树差异 | 60 个文件，约 `+12877/-1011` |
| 三方分类 | 51 个仅 dev5 修改；8 个双方修改；1 个仅上游新增 |
| 当前文本冲突 | 4 个文件：`.gitignore`、`src/utils.py`、`version.txt`、`web.py` |

基线只描述审计时的事实。以后同步前必须重新获取远端并更新 SHA、数量和冲突清单，
不能假定本节永久有效。`master` 是历史发布分支，不再作为自定义修改审计基线。

### 1.1 复核命令

以下命令都是同步前的只读检查；输出应随每次同步记录到新的冲突报告中。

```bash
git fetch origin upstream
git status --short --branch
git rev-parse origin/dev5 upstream/master
git merge-base origin/dev5 upstream/master
git rev-list --left-right --count upstream/master...origin/dev5
git diff --stat upstream/master..origin/dev5
git diff --name-status upstream/master..origin/dev5
git merge-tree "$(git merge-base origin/dev5 upstream/master)" origin/dev5 upstream/master
```

文件三分类可用以下方式复核：

```bash
base="$(git merge-base origin/dev5 upstream/master)"
comm -12 <(git diff --name-only "$base"..origin/dev5 | sort) <(git diff --name-only "$base"..upstream/master | sort)
comm -23 <(git diff --name-only "$base"..origin/dev5 | sort) <(git diff --name-only "$base"..upstream/master | sort)
comm -13 <(git diff --name-only "$base"..origin/dev5 | sort) <(git diff --name-only "$base"..upstream/master | sort)
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
7. **未知来源按受保护处理**：只要行为已经存在于 dev5，除非明确确认可废弃，否则不得因提交来源不明而删除。

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
| `STREAM_LATENCY_GUARD_ENABLED` | 首事件、首内容、idle 超时及安全切换 | `true` | 关闭后仍保留基础连接/OAuth 上限和首事件后禁止重试 |

配置读取顺序是：命中的环境变量先锁定对应键，存储后端配置只补充未锁定键；
`config.init_config()`/`reload_config()` 再把 debug、TTFT diagnostics、routing 和 SMART 429 值刷新到同步热路径缓存。

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

这些不是全新路径，但 dev5 扩展了其契约，同样必须保护：

- `GET /config/get`：新增 SMART 429、debug、routing 等配置，并返回 `env_locked`。
- `POST /config/save`：验证 SMART 429 数值范围，保存后刷新同步缓存并重配服务。
- `GET /creds/status`：新增永久禁用、冷却、Preview、等级、备注和健康状态筛选/字段。
- `GET /creds/quota/{filename}`：增加 GeminiCLI 额度、原始模型 ID、显示名、测试模型和健康分类。
- `POST /creds/action`、`POST /creds/batch-action`：支持永久禁用及相关状态保持。
- OAuth、上传和凭证检验响应：携带标准化等级及原始等级证据。
- `/version/info`：使用构建元数据或 `version.txt`，并可检查上游版本。

## 8. 前端保护清单

### 8.1 桌面端 `front/control_panel.html`

- GeminiCLI 和 Antigravity 今日统计卡片：总数、成功、失败、RPM、成功率、模型明细。
- Refresh Token 批量输入、mode、可选 client ID/secret、文件名前缀和逐项结果。
- 永久禁用、批量消息测试、额度检测/双向冷却、状态/等级/Preview/冷却/备注筛选。
- 凭证备注 badge、当前/上一循环统计、模型冷却倒计时、额度详情和单模型测试。
- 存储引擎状态、server_name 选择、迁移预览与切换。
- SMART 429、debug、routing 配置及风险说明。
- 系统状态页中的 Redis 和 SMART 429 状态。

### 8.2 移动端 `front/control_panel_mobile.html`

移动端必须保持与桌面端的核心能力对等，不得在同步时只更新桌面端：

- 两种 mode 的统计卡片和模型表格。
- Refresh Token 导入及高级选项。
- 永久禁用、批量测试、额度/冷却同步和全部筛选项。
- SMART 429、debug、routing 配置。
- 系统状态页。

### 8.3 共用逻辑 `front/common.js`

- `CredentialManager` 的分页、筛选、全局统计及 API endpoint 映射。
- 凭证卡片状态、等级/健康/冷却/备注/循环统计渲染。
- 额度、模型测试、批量测试、冷却同步、Refresh Token 导入和统计刷新。
- `loadSystemStatus()`、`loadStorageEngine()`、`switchStorageEngine()`。
- 配置加载/保存时 SMART 429、debug、routing 的默认值必须与后端一致。
- 冷却和统计定时器只能有一个有效实例；`test_frontend_static.py` 防止重复 ID 和计时器声明丢失。

## 9. 部署、版本和测试资产

### 9.1 部署与版本

- `docker-compose.yml` 默认连接本机 Redis，包含 Redis service、持久卷、健康检查和应用依赖关系。
- `requirements.txt` 的 `aiomysql>=0.2.0` 是 MySQL 后端硬依赖。
- CI 的 SHA 镜像标签带分支前缀，避免非默认分支产生无效或冲突标签。
- dev5 Dockerfile 注入 `GCLI2API_BUILD_DATE`、`GCLI2API_VERSION`、`GCLI2API_REVISION`。
- `src/versioning.py` 决定展示版本和静态资源缓存键；不能退回只读 `version.txt` 的实现。
- `scripts/migrate_sqlite_to_mysql.py` 支持 dry-run、server_name、建表、凭证/配置迁移和校验。

### 9.2 受保护测试

| 文件 | 覆盖重点 |
| --- | --- |
| `test_frontend_static.py` | 统计刷新 timer 声明、桌面/移动页面重复 ID |
| `test_gemini35_tier_routing.py` | 无合格凭证 503、MySQL/MongoDB Redis tier 池、别名与原始额度模型 |
| `test_geminicli_subscription_api.py` | Code Assist 请求、失败回退、Antigravity 付费等级回退与请求体兼容 |
| `test_smart_429.py` | 429 互斥分类、精确风控、multi-worker fail-closed、健康迁移、singleflight、状态版本 |
| `test_streaming_latency.py` | TTFT 分阶段超时、终止错误、连接复用、OAuth/初始化 single-flight、凭证排除和禁止内容后重试 |
| `test_sqlite_tier_storage.py` | 原始 tier 字段迁移、Gemini 3.5 等级路由 |
| `test_subscription_tiers.py` | tier 映射优先级、unknown、项目 ID 形式、模型资格 |
| `test_upload_tier_detection.py` | 上传后等级持久化、检测失败保持旧状态、响应字段 |
| `test_versioning.py` | version.txt 回退、发布元数据优先、分支构建与资源缓存键 |

同步后不得只跑测试文件是否可导入；至少应执行上述 8 个文件，并按冲突范围补跑上游测试。

## 10. 当前上游同步冲突与语义热点

### 10.1 已确认的文本冲突（必须停止）

| 文件 | 本地内容 | 上游内容 | 处理要求 |
| --- | --- | --- | --- |
| `.gitignore` | 保留 `zeaburcli/`、`sshcli/`、`deploy/`、`tests/`、`参考项目/` 等本地忽略项 | 上游保留/调整 `aicode/`、`streamchat/` | 不得二选一；先确认 `tests/` 策略，并合并双方仍需要的规则 |
| `src/utils.py` | dev5 的 GeminiCLI 用户代理、模型/等级相关适配 | 上游后续用户代理/工具兼容更新 | 按函数逐项比较；不得整文件覆盖 |
| `version.txt` | dev5 构建/分支版本元数据 | 上游最新提交元数据 | 这是元数据冲突，但仍需报告；最终值由同步结果和发布策略决定 |
| `web.py` | SMART 429 生命周期、分钟统计清理、HTTP 池和服务关闭 | 上游 GC/`malloc_trim` 内存回收和凭证管理器关闭修复 | 最终必须同时保留本地任务和上游内存/关闭修复，方案需先确认 |

### 10.2 双方修改但可能自动合并的文件

| 文件 | 语义风险与必查项 |
| --- | --- |
| `Dockerfile` | dev5 构建元数据与上游 jemalloc 安装/`LD_PRELOAD`/`MALLOC_CONF` 必须共存；不能因自动合并遗漏任一侧 |
| `src/api/antigravity.py` | 上游移除显式 timeout；dev5 保留凭证切换、统一错误和 SMART 429 相关重试语义 |
| `src/api/geminicli.py` | 上游移除 timeout；dev5 有订阅等级、风险分类、容量保护、503 和原始模型处理 |
| `src/converter/gemini_fix.py` | 上游最新 Claude 工具 schema 修复与 dev5 thinking、tier 模型、图像和多轮工具修复可能重叠 |
| `.gitignore` | 见文本冲突 |
| `src/utils.py` | 见文本冲突 |
| `version.txt` | 见文本冲突 |
| `web.py` | 见文本冲突 |

### 10.3 上游待引入内容

共同祖先之后的上游功能重点包括：

- Claude/Antigravity 工具 schema 修复及其后续回退/调整。
- jemalloc 和运行时内存回收。
- 请求 timeout 移除。
- `src/utils.py` 的后续更新。
- 对应的版本元数据提交。

`tests/test_gemini_fix.py` 是当前三方分类中唯一“仅上游新增”的文件。直接树差异显示它在 dev5
一侧缺失，不代表 dev5 有意删除；同步时应作为上游测试引入并与 dev5 的顶层测试共同运行。

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
| 生命周期关闭路径 | `web.py` 初始化使用 `credential_manager` 单例，但关闭仍受 `global_credential_manager` 是否赋值影响；同时将与上游关闭修复冲突 | 必须作为 `web.py` 冲突的一部分报告，不在文档任务中修复 |
| jemalloc 当前缺失 | dev5 Dockerfile 有构建元数据，但相对当前上游缺少 jemalloc 配置 | 这是待同步上游能力，不应误记为本地要求删除 jemalloc |

## 12. 文件覆盖矩阵（60/60）

本节用于机械核对，防止功能说明完整但漏掉文件。路径按共同祖先三方分类。

### 12.1 仅 dev5 修改（51）

| 分组 | 文件 | 对应保护项 |
| --- | --- | --- |
| 配置/文档/部署（12） | `.agent/workflows/debug-log.md`、`.env.example`、`.github/workflows/docker-publish.yml`、`README.md`、`config.py`、`docker-compose.yml`、`docs/http_status_codes.md`、`requirements.txt`、`review/GEMINI_CLI_TIER_REVIEW.md`、`review/SMART_429_PROTECTION_AUDIT.md`、`review/SMART_429_PROTECTION_REVIEW.md`、`scripts/migrate_sqlite_to_mysql.py` | S429、TIER、OPS、STORE |
| 前端（3） | `front/common.js`、`front/control_panel.html`、`front/control_panel_mobile.html` | UI-01、UI-02、CRED、STAT |
| API/认证/转换/面板/路由（22） | `src/api/utils.py`、`src/auth.py`、`src/converter/anthropic2gemini.py`、`src/converter/openai2gemini.py`、`src/credential_manager.py`、`src/google_oauth_api.py`、`src/httpx_client.py`、`src/models.py`、`src/panel/auth.py`、`src/panel/config_routes.py`、`src/panel/creds.py`、`src/panel/root.py`、`src/panel/version.py`、`src/router/antigravity/gemini.py`、`src/router/antigravity/openai.py`、`src/router/geminicli/anthropic.py`、`src/router/geminicli/gemini.py`、`src/router/geminicli/openai.py`、`src/smart_429.py`、`src/subscription_tiers.py`、`src/usage_stats.py`、`src/versioning.py` | CRED、ROUTE、S429、TIER、MODEL、API、CONV、OPS |
| 存储（6） | `src/storage/_stats_common.py`、`src/storage/mongodb_manager.py`、`src/storage/mysql_manager.py`、`src/storage/psql_manager.py`、`src/storage/sqlite_manager.py`、`src/storage_adapter.py` | STORE、STAT、S429、TIER |
| 测试（8） | `test_frontend_static.py`、`test_gemini35_tier_routing.py`、`test_geminicli_subscription_api.py`、`test_smart_429.py`、`test_sqlite_tier_storage.py`、`test_subscription_tiers.py`、`test_upload_tier_detection.py`、`test_versioning.py` | 第 9.2 节 |

### 12.2 双方修改（8）

`.gitignore`、`Dockerfile`、`src/api/antigravity.py`、`src/api/geminicli.py`、
`src/converter/gemini_fix.py`、`src/utils.py`、`version.txt`、`web.py`。

这 8 个文件全部需要强制人工复核；其中 4 个当前产生文本冲突，详见第 10 节。

### 12.3 仅上游新增（1）

`tests/test_gemini_fix.py`。它属于待同步测试资产，不是 dev5 的自定义删除项。

## 13. 标准同步流程

### 13.1 同步前

1. 确认 `git status --short` 为空；如有用户改动，先停止，不得清理或覆盖。
2. 执行 `git fetch origin upstream`，记录 `origin/dev5`、`upstream/master` 和 merge-base。
3. 从 `origin/dev5` 创建独立分支，例如 `sync/upstream-YYYYMMDD`；禁止直接在 dev5 或 master 操作。
4. 重新生成三类文件清单、提交清单和 `git merge-tree` 预演结果。
5. 将预演结果与本文功能 ID、接口表、字段表和 60 文件矩阵比较。

### 13.2 冲突报告格式

每个冲突至少包含：

```text
文件/符号：
冲突类型：文本 / 自动合并语义 / 数据契约 / API 契约
dev5 当前行为：
上游变化：
如果采用上游的影响：
如果只保留 dev5 的影响：
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
4. 执行 dev5 的 8 个测试文件、上游新增测试及冲突涉及的其他测试。
5. 检查桌面和移动面板，不能只验证一端。
6. 对存储变化至少验证 SQLite；远程后端无法实测时必须明确标记未验证。
7. 成功同步后更新本文的 SHA、差异数量、冲突状态和文件矩阵。

## 14. 同步验收清单

- [ ] dev5 受保护功能 ID 均能在新代码中定位。
- [ ] 15 个自定义管理接口仍存在，方法、认证、参数和响应语义未静默变化。
- [ ] 既有扩展接口仍返回等级、健康、备注、冷却和统计字段。
- [ ] SMART 429 默认关闭、单 worker 限制、能力检查和 503 语义仍有效。
- [ ] 六种订阅等级和三个原始等级字段仍完整。
- [ ] 七个健康状态字段在 SQLite/MySQL/PostgreSQL/MongoDB 中等价可读写。
- [ ] 永久禁用、循环统计、精确冷却和备注不会在迁移后丢失。
- [ ] 桌面端与移动端的统计、导入、筛选和 SMART 429 设置均可用。
- [ ] dev5 的 8 个测试文件全部通过。
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

| 日期 | dev5/后继基线 | 上游基线 | 结果 |
| --- | --- | --- | --- |
| 2026-07-30 | `5a85e58` | `4f5e343` | 建立首份保护清单；只读预演发现 4 个文本冲突、8 个双方修改文件；未执行同步 |
| 2026-07-30 | `dev6` 基于 `5a85e58` | 未同步上游 | 新增 API-05 流式 TTFT 保护及控制面板独立诊断开关；直连模式不读取宿主代理环境；全量测试 112 项通过 |
