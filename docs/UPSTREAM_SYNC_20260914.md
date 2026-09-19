# 上游同步分析 20260914（dev9 ← upstream/master，只读预演，未执行合并）

## 0. 本文状态与范围

- **分析范围**：仅 `dev9` 与 `upstream/master`。不涉及其他本地分支。
- **执行状态**：仅完成同步前只读预演。**未编辑任何冲突文件、未暂存、未提交、未执行 merge。**
- **基本原则**：dev9 已有行为、接口和数据兼容性优先；上游改进在不破坏本地契约的前提下人工移植。
- 等待第 7 节决策后再进入实际合并。

### 0.1 判定依据

dev9 上没有「受保护功能清单」类文档，因此本次的保护判定直接依据 dev9 自身的 `AGENTS.md`：

> - 本仓库拥有凭证真实数据、SQLite 状态和管理动作的最终语义。
> - `/management/v1` 内只允许向后兼容的增量修改。
> - **现有 `/creds/*`、模型 API 和控制面板不得因改造而失效。**
> - 不得修改现有凭证数据、SQLite 表，除非任务明确要求并提供迁移方案。
> - 范围外发现只记录，不得顺带实施。

以及 dev9 代码中实际存在的行为（第 3 节逐条实测确认）。

> **建议**：本次同步完成后，把第 3 节的受影响契约表沉淀成 dev9 上的常驻清单，供以后同步复用。目前每次同步都要从代码重新推导保护范围，成本高且易漏。

---

## 1. 基线事实

执行 `git fetch --all --prune` 后记录（2026-09-14）。

| 项目 | 值 |
| --- | --- |
| Fork 远端 | `origin = https://github.com/lywx215/gcli2api.git` |
| 上游远端 | `upstream = https://github.com/su-kaka/gcli2api.git` |
| 同步目标分支 | `dev9 @ dcc966e`（与 `origin/dev9` 一致，工作区 clean） |
| 上游 HEAD | `upstream/master @ cdbaf37`（2026-09-09） |
| 上游 fetch 前缓存值 | `f425d11`（2026-08-14） |
| merge-base | `78f391a` |

### 1.1 分叉规模

| 项目 | 数量 |
| --- | --- |
| 上游独有提交 | **69** |
| 其中 `chore: update version.txt [skip ci]` 噪声 | 27 |
| 其中 merge 提交 | 11 |
| **上游实质性提交** | **31** |
| dev9 独有提交 | 169 |

### 1.2 文件三分类（基于 merge-base `78f391a`）

| 分类 | 数量 |
| --- | --- |
| 上游改动文件 | 30 |
| dev9 改动文件 | 121 |
| **双方都改（高危）** | **17** |
| 仅上游改动 | 13 |

---

## 2. 预演结果总览

`git merge-tree --write-tree origin/dev9 upstream/master` → 合并树 `c97007e`。

| 结果 | 明细 |
| --- | --- |
| **文本冲突 6 个** | `.gitignore`、`src/api/utils.py`、`src/converter/gemini_fix.py`、`src/utils.py`、`version.txt`、`web.py` |
| **自动合并但双方都改 11 个** | `.env.example`、`Dockerfile`、`README.md`、`front/control_panel.html`、`front/control_panel_mobile.html`、`requirements.txt`、`src/api/antigravity.py`、`src/api/geminicli.py`、`src/converter/openai2gemini.py`、`src/router/antigravity/gemini.py`、`src/router/antigravity/openai.py` |
| **合并后静默消失 5 个文件** | `src/api/vertex.py`、`src/router/vertex/{__init__,gemini,model_list,openai}.py` |
| **上游带入 3 个新文件** | `src/converter/antigravity_fix.py`、`tests/test_gemini_fix.py`、`tests/test_openai2gemini_tool_calls.py` |

> **关键提醒**：**自动合并不等于安全**。上述 11 个「双方都改但无冲突标记」的文件，以及 5 个静默删除，才是本次同步风险最高的部分——Git 不会提示，需逐项人工复核。

---

## 3. 本次受影响的 dev9 契约（从 dev9 代码实测确认）

| ID | dev9 现有行为 | 代码位置 | 受哪条冲突威胁 |
| --- | --- | --- | --- |
| V-01 | Vertex AI 渠道：Gemini 原生 / OpenAI 兼容 / 模型列表三条路由，`wreq` 做 TLS 指纹伪装 | `src/api/vertex.py`、`src/router/vertex/*`、`web.py`、`requirements.txt` | 5.1 |
| M-01 | 抗截断模型前缀为 `流式抗截断/`；GeminiCLI UA 为 `GeminiCLI/0.35.2/{model} (win32; x64; cloud-shell)` | `src/utils.py` | 5.2 |
| M-02 | `gemini-3.5-flash-preview` 基础模型、`GEMINICLI_MODEL_ALIASES` / `ANTIGRAVITY_MODEL_ALIASES` 别名映射、3.5-flash 的 minimal/low/medium/high 思考档 | `src/utils.py` | 5.2 |
| S-01 | 容量挤爆类 reason（`MODEL_CAPACITY_EXHAUSTED` / `NO_CAPACITY_AVAILABLE`）**不锁冷却**；已删除一刀切 4 小时兜底 | `src/api/utils.py` `CAPACITY_EXHAUSTED_REASONS` | 5.3 |
| C-01 | 工具 schema 清洗、thoughtSignature 处理、Claude 空 schema 兼容、图像配置优先级集中在 `gemini_fix.py`；原生 tier 后缀模型不得被本地 `thinkingConfig` 重写 | `src/converter/gemini_fix.py` | 5.4 |
| A-01 | Antigravity 会话状态机：`AntigravitySessionState`、`_session_key`、`_get_session_state`、`_generate_request_id(conversation_id, trajectory_id, step)` | `src/api/antigravity.py` | 5.8 |
| W-01 | lifespan 内 SMART 429 初始化、keepalive、`_cleanup_minute_stats_loop` | `web.py` | 5.5 |
| U-01 | 桌面端与移动端控制面板功能（dev9 相对 merge-base `+410/-17`） | `front/control_panel.html`、`front/control_panel_mobile.html` | 5.9 |

---

## 4. 上游实质性变更盘点（31 个提交）

| 主题 | 代表提交 | 评估 |
| --- | --- | --- |
| OpenAI↔Gemini 工具调用修复 | `f0f6d3c` 合并相邻同角色 contents、`a9cbe0e` 流式 `finish_reason=tool_calls`、`0ef0d40` 并行工具调用 index、`be87379` 非法 arguments 保留 functionCall | **建议吸收**，纯 bug 修复，附带 2 个新测试 |
| Antigravity 429 配额解析 | 新增 `parse_antigravity_quota_reset_timestamp` | **建议吸收**，但需处理与 S-01 的冲突，见 5.3 |
| jemalloc 内存碎片治理 | `4b4aeee` + Dockerfile `LD_PRELOAD`/`MALLOC_CONF` | **部分吸收**，见 5.7 |
| 关机流程 bug 修复 | `web.py` 改用单例关闭凭证管理器 | **建议吸收**，修掉 dev9 一个真实 bug，见 5.5 |
| `gemini_fix.py` 拆分出 `antigravity_fix.py` | `-803/+64` 行重构 | **高风险**，见 5.4 |
| Antigravity 会话状态机移除 | `src/api/antigravity.py` `-155/+84` | **高风险**，见 5.8 |
| 删除 Vertex 渠道 | `69638c8 删除多余代码` | **建议拒绝**，见 5.1 |
| 抗截断前缀改名 `流式抗截断/` → `抗截断/` | `src/utils.py`、`.env.example`、面板 | **需决策**，见 5.2 |
| GeminiCLI User-Agent 改写 | `src/utils.py` | **建议本次不采纳**，见 5.2 |
| 新版抗截断 | `2b88946` 加入后被 `9d6e0ac` Revert | 净变化为零，无需处理 |

---

## 5. 冲突报告

每条按「冲突类型 / dev9 现状 / 上游变化 / 采用上游的影响 / 只保留 dev9 的影响 / 候选方案 / 待决问题 / 回归测试」展开。

### 5.1 Vertex 渠道会被静默删除（最高优先级）

- **文件/符号**：`src/api/vertex.py`、`src/router/vertex/*`（共 5 个文件）、`web.py` 的 3 处 `include_router` 与对应 import、`requirements.txt` 的 `wreq`
- **冲突类型**：**API 契约 + 自动合并语义**（无冲突标记，Git 会直接应用上游删除）
- **dev9 现状**：对外提供 Vertex AI 三条路由；`src/api/vertex.py` 1030 行，依赖 `wreq` 做 TLS 指纹伪装（`89cbb51 随机指纹提高pvp胜率`）。`wreq` 在 dev9 中**仅被 vertex.py 使用**
- **上游变化**：`69638c8 删除多余代码` 整体删除 Vertex 实现，`web.py` 移除注册，`requirements.txt` 移除 `wreq`
- **采用上游的影响**：Vertex 三条对外路由整体下线。因 vertex.py 内有 `try: import wreq / except: wreq = None` 兜底，即使误留文件而依赖被删，也只会降级返回 `503 wreq not installed, vertex channel unavailable`——**静默失效，不报错、不崩溃**，极难在测试中发现。直接违反 `AGENTS.md`「现有模型 API 不得失效」
- **只保留 dev9 的影响**：无功能损失；代价是 `web.py` 与 `requirements.txt` 需人工排除上游这两处删除，且以后每次同步都要重复排除
- **候选方案**：
  - **A（推荐）**：保留全部 5 个 Vertex 文件、`web.py` 的 3 处注册、`requirements.txt` 的 `wreq`；吸收上游 `web.py` 的其余改动
  - B：若确认 Vertex 已不再使用，跟随上游删除，但须留下明确决策记录
- **待决问题**：Vertex 渠道当前是否仍在生产使用？
- **回归测试**：`GET /v1/models` 确认 Vertex 模型在列；Vertex 流式与非流式各一次真实调用

---

### 5.2 抗截断前缀改名 + GeminiCLI User-Agent 改写

- **文件/符号**：`src/utils.py` 的 `is_anti_truncation_model` / `get_available_models` / `get_geminicli_user_agent` / `_GEMINICLI_*` 常量；`.env.example`；两个面板 HTML
- **冲突类型**：**文本冲突 + API 契约**（威胁 M-01、M-02）
- **dev9 现状**：
  - 抗截断前缀 `流式抗截断/`，`get_available_models` 只生成该前缀
  - UA：`GeminiCLI/0.35.2/{model} (win32; x64; cloud-shell)`
  - M-02 扩展：`gemini-3.5-flash-preview`、`normalize_geminicli_model_alias`、`normalize_antigravity_model_alias`、3.5-flash 四档思考等级
- **上游变化**：
  1. 前缀改名 `流式抗截断/` → `抗截断/`。`get_available_models` 只生成新前缀，`is_anti_truncation_model` **只匹配新前缀**（`get_base_model_from_feature_model` 仍兼容两者）。面板文案同步改为「流式和非流式请求均有效」——说明不只是改名，还扩展了生效范围
  2. UA 改为 `Mozilla/5.0 (compatible; Google-Gemini-CLI/1.0; +https://github.com/google-gemini/gemini-cli)`，删除 `_GEMINICLI_VERSION` / `_GEMINICLI_PLATFORM` / `_GEMINICLI_ARCH` / `_GEMINICLI_SURFACE` 四个常量
  3. `ANTIGRAVITY_CLI_VERSION` `1.0.1` → `1.1.24`
- **采用上游的影响**：
  - **前缀**：已配置 `流式抗截断/xxx` 的下游客户端，模型仍能调用（basename 解析兼容），但 `is_anti_truncation_model` 返回 `False` → **抗截断静默失效**，无报错无提示
  - **UA**：直接改变 Google 侧客户端识别特征。dev9 有 SMART 429 风控检测（`src/smart_429.py`），UA 变化可能改变风控触发率与检测基线，**影响不可预估且难以回滚验证**
- **只保留 dev9 的影响**：与上游模型名体系长期分叉，该文件以后每次同步都冲突
- **候选方案**：
  - 前缀 **A（推荐）**：**双前缀并存**——`is_anti_truncation_model` 同时匹配 `抗截断/` 与 `流式抗截断/`；`get_available_models` 只生成新前缀；旧前缀保留为不公开的兼容别名。既吸收上游又不破坏存量客户端
  - 前缀 B：完全跟随上游，并在面板与 README 公告破坏性变更
  - UA **A（推荐）**：**本次不采纳 UA 改动**，保留 dev9 现值；单独立项，在灰度环境对比风控触发率后再决定
  - UA B：跟随上游，须同步复核 SMART 429 基线并重跑风控测试
  - `ANTIGRAVITY_CLI_VERSION`：建议接受 `1.1.24`（跟随上游客户端版本，与 UA 风险性质不同）
  - **M-02 的别名表、`gemini-3.5-flash-preview`、3.5-flash 思考档全部保留**
- **待决问题**：(1) 抗截断前缀走「双前缀并存」还是「完全跟随」？(2) UA 是否在本次同步中改动？
- **回归测试**：`test_gemini35_tier_routing.py`；`GET /v1/models` 对比同步前后差异；`流式抗截断/` 与 `抗截断/` 各发一次流式与非流式请求验证抗截断真的生效；`test_smart_429.py`

---

### 5.3 `parse_quota_reset_timestamp` 冷却语义正面冲突

- **文件/符号**：`src/api/utils.py` 的 `parse_quota_reset_timestamp`、`parse_and_log_cooldown`、`RESOURCE_EXHAUSTED_COOLDOWN_HOURS`、`CAPACITY_EXHAUSTED_REASONS`
- **冲突类型**：**文本冲突 + 数据契约**（威胁 S-01）
- **dev9 现状**：已**删除** `RESOURCE_EXHAUSTED_COOLDOWN_HOURS = 4` 的一刀切兜底，改为 `CAPACITY_EXHAUSTED_REASONS = {MODEL_CAPACITY_EXHAUSTED, NO_CAPACITY_AVAILABLE}` 判定：容量挤爆类 reason **不锁冷却**，只有 `QUOTA_EXHAUSTED` 才设冷却。`parse_and_log_cooldown` 内联按 mode 分派
- **上游变化**：
  1. **保留** `RESOURCE_EXHAUSTED_COOLDOWN_HOURS = 4` 兜底冷却
  2. 新增消息正则解析 `Your quota will reset after (…)`，支持 `6s` / `6h 30m 15s` 组合格式
  3. 新增独立函数 `parse_antigravity_quota_reset_timestamp`，按 `quotaResetTimeStamp` → `quotaResetDelay` → `retryDelay` 三级优先级解析
  4. `parse_and_log_cooldown` 改为调用新函数分派
- **采用上游的影响**：**直接违反 S-01**——恢复后的 4 小时兜底会把「模型容量挤爆」误判为「配额耗尽」并把凭证锁死 4 小时。这是本次同步中**最容易被自动合并掩盖的语义倒退**
- **只保留 dev9 的影响**：错过上游两项真实改进——消息正则解析（覆盖 `RATE_LIMIT_EXCEEDED` 这类 details 里没有重置时间的响应）和 Antigravity 三级配额解析（dev9 的冷却双向同步正需要精确重置时间）
- **候选方案（推荐 A）**：
  - 保留 dev9 的 `CAPACITY_EXHAUSTED_REASONS` 判定作为**最外层门禁**，位置在所有解析之前——容量类 reason 一律不设冷却
  - 门禁通过后，吸收上游的消息正则解析
  - 完整吸收 `parse_antigravity_quota_reset_timestamp`（只在 antigravity 分支生效，不影响 geminicli 的 S-01 语义）
  - **不恢复** `RESOURCE_EXHAUSTED_COOLDOWN_HOURS`
- **待决问题**：`RESOURCE_EXHAUSTED` 在既无 details 又无消息时间、且 reason 不属容量类时，是否需要兜底冷却？若需要，时长取多少？
- **回归测试**：`test_error_classification.py`、`test_error_classification_backends.py`、`test_quota_fallback_cooldown.py`、`test_smart_429.py`、`test_antigravity_cooldown_regression.py`、`test_cooldown_stats.py`

---

### 5.4 `gemini_fix.py` 被上游拆分为两个模块

- **文件/符号**：`src/converter/gemini_fix.py`（上游 `-803/+64`，dev9 `+150/-129`）、新文件 `src/converter/antigravity_fix.py`
- **冲突类型**：**文本冲突 + 结构性重构**（威胁 C-01）
- **dev9 现状**：工具 schema 清洗（`_clean_parameters_json_schema`、`_append_schema_hint`、`_resolve_schema_ref`）、thoughtSignature 处理、Claude 空 schema 兼容、图像配置优先级全部集中在 `gemini_fix.py`（1067 行）。dev9 在此文件上有「原生 tier 后缀模型不得被本地 `thinkingConfig` 重写」的改动
- **上游变化**：把 antigravity 相关逻辑整体迁出到新文件 `antigravity_fix.py`（含 `_normalize_antigravity_request`、`_ensure_empty_tool_schema_for_claude`、`prepare_image_generation_request`、`_ensure_tool_call_ids` 等），`gemini_fix.py` 只留 geminicli 路径
- **采用上游的影响**：**自动合并会在 803 行删除与 150 行本地新增之间产生不可预测的结果**——dev9 的 thinkingConfig 保护可能被连带删除。因为代码已迁往新文件，删除不产生语法错误，属**静默丢失**
- **只保留 dev9 的影响**：错过上游 `1b0e033 Fix Antigravity Claude tool schema` 与 `28b597b Revert "Update gemini_fix.py"` 的修复；模块结构与上游永久分叉，以后每次 converter 同步成本递增
- **候选方案（推荐 A）**：
  - **禁止整文件取舍**。先把 dev9 在 `gemini_fix.py` 上的 `+150/-129` 拆成逐项清单（图像配置优先级 / 工具与多轮内容 / 原生 tier 模型保护）
  - 接受上游的模块拆分，把 dev9 每一项逐条移植到拆分后的正确位置（antigravity 相关的进 `antigravity_fix.py`，geminicli 相关的留 `gemini_fix.py`）
  - 移植后逐项 diff 复核，确认 thinkingConfig 保护仍在 antigravity 路径上生效
- **待决问题**：是否接受上游的模块拆分结构？若拒绝，dev9 需自行承担后续所有 converter 同步的重写成本
- **回归测试**：上游新增的 `tests/test_gemini_fix.py`、`tests/test_openai2gemini_tool_calls.py`；`test_upload_tier_detection.py`；Antigravity 原生 tier 模型（`gemini-3.1-pro-high` 等）实调验证 thinkingConfig 未被重写

---

### 5.5 `web.py` 冲突（含一个上游修复的 dev9 真实 bug）

- **文件/符号**：`web.py` 的 lifespan、关机顺序、`global_credential_manager`、Vertex 路由注册、新增 `_memory_trim_loop`
- **冲突类型**：**文本冲突 + 自动合并语义**（威胁 W-01）
- **dev9 现状**：lifespan 含 SMART 429 初始化、keepalive、`_cleanup_minute_stats_loop`；关机顺序为 `http_client.close()` → keepalive → SMART 429 → `shutdown_all_tasks` → `if global_credential_manager: await global_credential_manager.close()`
- **上游变化**：
  1. 新增 `_memory_trim_loop`：每 60 秒 `gc.collect()` + `libc.malloc_trim(0)`
  2. **修复 dev9 的真实 bug**：`global_credential_manager` 在 dev9 的正常路径上**从未被赋值**（只在异常分支赋 `None`），因此 `if global_credential_manager:` 恒为假，**关机时凭证管理器实际从未关闭**。上游改为直接 `await credential_manager.close()`
  3. 删除 Vertex 路由注册（见 5.1）
- **采用上游的影响**：得到关机 bug 修复与内存回收；但 Vertex 注册被删；且引入新的事件循环阻塞风险（见 5.7）
- **只保留 dev9 的影响**：关机 bug 持续存在。连带后果是 `SQLiteManager.close()` 中的 `_flush_stats_to_db()` 最终刷写从未执行，**进程退出时内存统计缓冲直接丢失**
- **候选方案（推荐 A）**：
  - 接受上游对 `global_credential_manager` 的修复（同时修掉统计丢失）
  - 保留 dev9 的 SMART 429、keepalive、`_cleanup_minute_stats_loop`
  - 保留 Vertex 路由注册（依 5.1 决策）
  - `_memory_trim_loop` 见 5.7 单独决策
  - **附带清理**：dev9 的 `web.py:122` 调用 `await http_client.close()`，但 `HttpxClientManager` 中**不存在 `close` 方法**，该调用每次关机抛 `AttributeError` 并被 except 吞掉。本次可顺手移除，或补齐实现（与 `review/PERFORMANCE_RISK_AUDIT.md` P1-1 同源）
- **待决问题**：`global_credential_manager` 这个全局变量是否还有存在意义？建议直接删除，统一用单例
- **回归测试**：启动 + 优雅关闭全流程，确认日志出现「凭证管理器已关闭」；关机后检查 `daily_stats` / `daily_model_stats` 是否收到最终刷写

---

### 5.6 `.gitignore` 与 `version.txt`

- **冲突类型**：文本冲突（琐碎）
- **`.gitignore`**：上游新增 `streamchat/`、`tests/`；dev9 有 `!docs/openapi/*.json`、`!coordination/handoffs/*.json`、`zeaburcli/`、`sshcli/`、`deploy/`、`tests/`、`参考项目/`
  - **方案**：取并集，新增 `streamchat/`，保留 dev9 全部条目
  - **注意**：dev9 与上游都 ignore 了 `tests/`，但上游同时**新增两个 `tests/` 下的跟踪文件**。已跟踪文件不受 `.gitignore` 影响，合并后它们仍被跟踪；只是以后新增 `tests/` 文件需 `git add -f`。建议改为精确忽略而非整目录
- **`version.txt`**：上游 `6cd0575`（2026-09-09），dev9 `296cbf0`（2026-07-17）
  - **方案**：由 `.github/workflows/update-version.yml` 在合并后自行生成；人工解决时取上游值。注意历史上有过 `7b7543c chore: sync version.txt from upstream to suppress false update notification`，说明该文件影响面板更新提示，需确认取值策略

---

### 5.7 jemalloc 与 `malloc_trim` 重复，且引入新的事件循环阻塞

- **文件/符号**：`Dockerfile` 的 `LD_PRELOAD` / `MALLOC_CONF`；`web.py` 的 `_memory_trim_loop`
- **冲突类型**：自动合并语义（`Dockerfile` 双方都改，会自动合并）
- **上游变化**：Dockerfile 安装 `libjemalloc2` 并 `LD_PRELOAD`，设 `MALLOC_CONF="background_thread:true,dirty_decay_ms:5000,muzzy_decay_ms:5000"`；同时 `web.py` 每 60 秒 `gc.collect()` + `libc.malloc_trim(0)`
- **风险 1（功能重复）**：jemalloc 经 `LD_PRELOAD` 接管后，`ctypes.CDLL("libc.so.6").malloc_trim` **对 jemalloc 的 arena 无效**。Docker 部署下 `_memory_trim_loop` 里的 `malloc_trim` 是空操作，只剩 `gc.collect()` 在跑。只有非 Docker 的源码部署（glibc）才真正受益
- **风险 2（新增阻塞源）**：`gc.collect()` 是**同步全代回收**，跑在事件循环线程上。堆内对象较多时单次可达数十至上百毫秒，期间所有请求一并卡住。这与 `review/PERFORMANCE_RISK_AUDIT.md` P1-2 描述的阻塞模式同源，属**本次同步新引入的性能风险**
- **候选方案**：
  - **A（推荐）**：接受 Dockerfile 的 jemalloc（收益明确、零事件循环开销）；`_memory_trim_loop` **改造后再接受**——`gc.collect()` 与 `malloc_trim` 都挪进 `asyncio.to_thread`，或仅在检测到未启用 jemalloc 时才启动该循环
  - B：只接受 jemalloc，完全不引入 `_memory_trim_loop`（最简单）
  - C：原样接受（不推荐，等于用一个阻塞源换一个内存问题）
- **待决问题**：生产是否一律 Docker 部署？若是，方案 B 即可
- **回归测试**：容器内压测观察 RSS 曲线；同时采样请求 P99 延迟，确认 60 秒周期上无规律性尖刺

---

### 5.8 Antigravity 会话状态机被上游移除

- **文件/符号**：`src/api/antigravity.py`（上游 `-155/+84`，dev9 `+133/-70`）
- **冲突类型**：**自动合并语义**（无冲突标记，风险最高的一类；威胁 A-01）
- **dev9 现状**：含会话状态机——`AntigravitySessionState` dataclass、`_session_key`、`_get_session_state`、`_make_new_state`、`_prune_session_states`、`_get_redis`；`_generate_request_id(conversation_id, trajectory_id, step)` 按会话生成请求 ID
- **上游变化**：整体删除会话状态机与 `_get_redis`；`_generate_request_id()` 改为无参；新增 `_should_forward_antigravity_header` / `_sanitize_antigravity_headers` 请求头白名单；`build_antigravity_headers` 签名改变
- **采用上游的影响**：Antigravity 会话连续性（conversation / trajectory / step）消失。若上游侧不再校验这些字段则无害；若仍校验，表现为**间歇性对话上下文丢失**——这类问题在测试中极难复现
- **只保留 dev9 的影响**：错过 `276a932 Harden antigravity headers and cooldown logic` 的请求头加固
- **候选方案（推荐 A）**：**吸收请求头加固，保留会话状态机**。两者职责正交——`_sanitize_antigravity_headers` 管出站头白名单，会话状态机管请求 ID 生成，可以共存。`build_antigravity_headers` 签名变化需人工适配调用点
- **待决问题**：Antigravity 会话状态机当前是否确有实际作用？若已是死代码，跟随上游删除可简化后续同步
- **回归测试**：`test_geminicli_subscription_api.py`；Antigravity 连续 5 轮以上多轮对话验证上下文不丢失；对比同步前后的出站请求头

---

### 5.9 其余自动合并文件复核清单

以下文件双方都改但无冲突标记，仍须逐项复核：

| 文件 | 上游改动 | dev9 改动 | 复核要点 |
| --- | --- | --- | --- |
| `src/api/geminicli.py` | `+1/-2` | `+402/-111` | 上游改动极小，风险低，但需确认落点未踩到 dev9 的重试/凭证切换逻辑 |
| `src/converter/openai2gemini.py` | `+103/-4` | `+40/-9` | 工具调用 index、`finish_reason`、相邻同角色 contents 合并；确认与 dev9 改动不重叠 |
| `src/router/antigravity/gemini.py` | `+8/-8` | `+3/-2` | 确认流式 bytes/str 类型一致性未被破坏 |
| `src/router/antigravity/openai.py` | `+2/-2` | `+2/-1` | 同上 |
| `front/control_panel.html` | `+5/-4` | `+410/-17` | 上游仅改抗截断文案 + 一处格式；须确认 dev9 面板功能未被触碰 |
| `front/control_panel_mobile.html` | — | — | 同上，**双端都要验**，不能只看桌面端 |
| `.env.example` | 抗截断文案 | — | 随 5.2 前缀决策同步 |
| `README.md` | 文案 | — | 随 5.2 决策同步 |
| `requirements.txt` | 移除 `wreq` | 新增 `aiomysql` | **随 5.1 决策**：保留 Vertex 则必须保留 `wreq` |
| `Dockerfile` | jemalloc | 版本元数据 | 见 5.7 |

---

## 6. 建议执行顺序

1. 完成第 7 节决策
2. 从 `dev9` 创建 `codex/sync-upstream-20260914`，**禁止直接在 dev9 或 master 上操作**
3. 先处理契约类冲突：**5.1 Vertex → 5.3 冷却语义 → 5.5 关机 bug**
4. 再处理结构性冲突：**5.4 converter 拆分 → 5.8 Antigravity 会话状态机**
5. 最后处理策略类：**5.2 前缀/UA → 5.6 琐碎 → 5.7 jemalloc**
6. 逐项复核 5.9 的 10 个自动合并文件
7. 测试：dev9 的 **22 个顶层测试文件** + 上游新增 2 个测试 + 双端面板人工验证；存储变更至少验证 SQLite，远程后端无法实测时明确标记「未验证」
8. 按 `AGENTS.md` 要求补充变更记录，说明 schema 版本、capability 与兼容影响
9. 把第 3 节的受影响契约表沉淀成 dev9 常驻清单，供以后同步复用

---

## 7. 待决事项汇总

| 编号 | 问题 | 关联 | 倾向 |
| --- | --- | --- | --- |
| Q1 | Vertex 渠道是否仍在生产使用 | 5.1 | 保留 |
| Q2 | 抗截断前缀：双前缀并存 / 完全跟随上游 | 5.2 | 双前缀并存 |
| Q3 | GeminiCLI User-Agent 是否在本次同步中改动 | 5.2 | 本次不动 |
| Q4 | `RESOURCE_EXHAUSTED` 无时间信息时是否需要兜底冷却、时长多少 | 5.3 | 不恢复兜底 |
| Q5 | 是否接受上游 `gemini_fix.py` / `antigravity_fix.py` 模块拆分 | 5.4 | 接受并逐项移植 |
| Q6 | `global_credential_manager` 全局变量是否删除 | 5.5 | 删除，统一用单例 |
| Q7 | 生产是否一律 Docker 部署（决定 `_memory_trim_loop` 取舍） | 5.7 | 待确认 |
| Q8 | Antigravity 会话状态机是否仍有实际作用 | 5.8 | 保留 |

---

## 附录：复现命令

```bash
git fetch --all --prune

# 基线
git rev-parse origin/dev9 upstream/master
git merge-base origin/dev9 upstream/master

# 分叉规模
git rev-list --left-right --count upstream/master...origin/dev9
git log --oneline --no-merges upstream/master ^origin/dev9

# 文件三分类
B=$(git merge-base origin/dev9 upstream/master)
git diff --name-only $B upstream/master | sort > /tmp/up.txt
git diff --name-only $B origin/dev9    | sort > /tmp/loc.txt
comm -12 /tmp/up.txt /tmp/loc.txt   # 双方都改（高危）
comm -23 /tmp/up.txt /tmp/loc.txt   # 仅上游改

# 合并预演（只读，不改工作区）
git merge-tree --write-tree --name-only origin/dev9 upstream/master

# 静默增删扫描
T=$(git merge-tree --write-tree origin/dev9 upstream/master)
git ls-tree -r --name-only origin/dev9 | sort > /tmp/d9f.txt
git ls-tree -r --name-only $T          | sort > /tmp/mgf.txt
comm -23 /tmp/d9f.txt /tmp/mgf.txt   # 会消失的文件
comm -13 /tmp/d9f.txt /tmp/mgf.txt   # 会新增的文件
```
