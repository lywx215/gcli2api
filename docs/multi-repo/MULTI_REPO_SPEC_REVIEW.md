# 双仓库协作方案深度审计报告（第二版）

> **审计日期**: 2026-08-10  
> **审计对象**: `docs/multi-repo/` 全部规范文档  
> **审计方法**: 逐条与 gcli2api 源代码交叉验证  
> **审计基线**: commit `296cbf0` (2026-07-17)  
> **前次 Review**: `MULTI_REPO_SPEC_REVIEW.md`（已合并其所有发现）

---

## 审计结论：有条件通过

方案架构设计严谨，职责分离和安全脱敏意识优秀。但经过代码级深度交叉验证，发现 **3 个 P0 级阻断**、**7 个 P1 级阻断** 和 **6 个 P2/P3 级建议**。所有 P0 和 P1 问题必须在文档修订后方可进入实施。

---

## 一、P0 阻断问题（可造成安全漏洞或全局不可用）

### 🔴 P0-1：`/docs` 静态挂载导致规范文档公开暴露

**位置**: `COORDINATION_SPEC.md` 安全边界 + `web.py` L211-212

`web.py` 将 `docs/` 目录作为静态文件挂载：

```python
if os.path.isdir("docs"):
    app.mount("/docs", StaticFiles(directory="docs"), name="docs")
```

这意味着 `MANAGEMENT_API_CONTRACT.md`、`COORDINATION_SPEC.md` 等包含完整架构细节、认证方案和 capability 清单的文件，**可通过 `http://<node>:<port>/docs/multi-repo/MANAGEMENT_API_CONTRACT.md` 无需认证直接访问**。

> **要求**：规范必须明确要求：实施时 Management API 规范文件不得放在 `docs/` 目录下，或将 `/docs` 静态挂载限制为仅提供公开文档。建议在 `GCLI2API_CODEX_GUIDE.md` 增加安全约束条目。

---

### 🔴 P0-2：当前无 SemVer 版本号，契约中的 `server_version` 无法填充

**位置**: `MANAGEMENT_API_CONTRACT.md` 第 1 节 + `version.txt`

契约要求所有响应包含：

```json
{ "server_version": "1.3.0", "revision": "0123456789abcdef" }
```

但实际 `version.txt` 的内容为：

```text
full_hash=296cbf0d5652bfcf8b26bcbc6af7476bb22854f3
short_hash=296cbf0
message=fix: preserve raw Gemini quota model names
date=2026-07-17 18:20:13 +0800
```

**当前系统没有任何 SemVer 版本号**。`/version/info` 端点返回的 `version` 字段实际上是 `short_hash`（如 `296cbf0`），不是语义化版本。

> **要求**：
> 1. 在 `COORDINATION_SPEC.md` 第 3 节中增加前置步骤：gcli2api 必须先建立 SemVer 版本号机制（如 git tag），在发布物中包含 `x.y.z` 格式版本。
> 2. 明确 `server_version` 在未引入 SemVer 之前如何填充（如使用 `"0.0.0-dev"` + revision）。
> 3. 在 `GCLI2API_CODEX_GUIDE.md` G1 阶段增加版本号基础设施任务。

---

### 🔴 P0-3：`NODE_MANAGEMENT_TOKEN` 未配置时安全默认行为未定义

**位置**: `MANAGEMENT_API_CONTRACT.md` 第 1 节 + `src/utils.py` L322-341

契约规定管理 API 使用 `NODE_MANAGEMENT_TOKEN` 认证，但 **未定义节点在未配置该环境变量时的行为**。

当前面板认证 `verify_panel_token` 使用明文密码对比：

```python
async def verify_panel_token(credentials):
    password = await get_panel_password()
    if credentials.credentials != password:
        raise HTTPException(status_code=401, detail="密码错误")
```

若管理 API 复用此机制或在 Token 未配置时隐式降级到面板密码，将违反安全分离原则。

> **要求**：明确规范——"若 `NODE_MANAGEMENT_TOKEN` 未配置，节点必须返回 HTTP 501（Not Implemented）并在 `/management/v1/capabilities` 返回空能力列表，**禁止隐式回退到面板密码**"。

---

## 二、P1 阻断问题（错误写操作、重大兼容问题或无法回滚）

### 🟠 P1-1：MySQL `STATE_FIELDS` 严重落后于其他三个后端

**位置**: `MANAGEMENT_API_CONTRACT.md` 第 5 节 + 各存储后端 `STATE_FIELDS`

| 字段 | SQLite | PostgreSQL | MongoDB | MySQL |
|------|--------|-----------|---------|-------|
| `permanent_disabled` | ✅ | ✅ | ❌ | ❌ |
| `cycle_stats` | ✅ | ✅ | ❌ | ❌ |
| `last_cycle_stats` | ✅ | ✅ | ❌ | ❌ |
| `success_count` | ✅ | ✅ | ✅ | ❌ |
| `failure_count` | ✅ | ✅ | ✅ | ❌ |
| `remark` | ✅ | ✅ | ✅ | ❌ |
| `health_status` | ✅ | ✅ | ✅ | ❌ |
| `quarantine_reason` | ✅ | ✅ | ✅ | ❌ |
| `probe_stage` | ✅ | ✅ | ✅ | ❌ |
| `next_probe_at` | ✅ | ✅ | ✅ | ❌ |
| `health_policy_version` | ✅ | ✅ | ❌ (`health_state_version`) | ❌ |

契约的 `/summary` 端点返回 `permanent_disabled` 计数，`/credentials` 返回 `health_status`、`success_count`、`failure_count`、`cycle_stats` 等字段。**MySQL 后端无法提供这些字段**。

MongoDB 使用 `health_state_version` 而 SQLite/PostgreSQL 使用 `health_policy_version`，字段名不一致。

> **要求**：
> 1. `GCLI2API_CODEX_GUIDE.md` G2 阶段必须增加"存储后端字段对齐"前置步骤。
> 2. 契约第 5 节补充：字段缺失时返回 `null`，不得返回 `0`。
> 3. 修正 MongoDB `health_state_version` 与其他后端名称统一。

---

### 🟠 P1-2：`GET /credentials` 缺少分页响应 Wrapper 定义

**位置**: `MANAGEMENT_API_CONTRACT.md` 第 5 节

定义了 `cursor`、`offset`、`limit` 查询参数，但示例只有单个凭证 Item 对象。**未定义列表响应的外层结构**。

> **要求**：补充完整响应结构：
> ```json
> {
>   "schema_version": "1.0", "server_version": "...", "revision": "...", "generated_at": "...",
>   "credentials": [ ... ],
>   "total": 89,
>   "has_more": true,
>   "next_cursor": "..."
> }
> ```

---

### 🟠 P1-3：缺少批量动作 API 端点

**位置**: `MANAGEMENT_API_CONTRACT.md` 第 2 节 & 第 7 节

声明了 `credential.batch_action` capability，但未定义 `POST /credentials/batch-actions` 路由、Request Body（`items` 数组）及逐项结果 Response schema。

> **要求**：补充 `POST /management/v1/credentials/batch-actions` 完整规范。

---

### 🟠 P1-4：错误码缺少 HTTP Status Code 映射

**位置**: `MANAGEMENT_API_CONTRACT.md` 第 1 节

列出了 `CAPABILITY_NOT_SUPPORTED`、`AUTHENTICATION_FAILED` 等错误码，但未声明对应的 HTTP Status Code。

> **要求**：补充映射表：
> | 错误码 | HTTP Status |
> |--------|------------|
> | `AUTHENTICATION_FAILED` | 401 |
> | `CAPABILITY_NOT_SUPPORTED` | 501 |
> | `CREDENTIAL_NOT_FOUND` | 404 |
> | `INVALID_ACTION` / `INVALID_MODE` | 400 |
> | `CONFLICT` | 409 |
> | `RATE_LIMITED` | 429 |
> | `UPSTREAM_UNAVAILABLE` | 502 |
> | `INTERNAL_ERROR` | 500 |

---

### 🟠 P1-5：时间戳序列化格式未显式标准化

**位置**: `MANAGEMENT_API_CONTRACT.md` 全文

数据库中 `last_success` 为 Unix timestamp float，`model_cooldowns` 为 `{model: float}`。契约示例写 ISO 8601 字符串。**未显式规定统一标准**。

> **要求**：在第 1 节"通用约定"中增加：所有时间戳字段在 API 传输层统一为 **UTC ISO 8601 字符串**（`YYYY-MM-DDTHH:mm:ssZ`），`null` 表示未知或未设置。

---

### 🟠 P1-6：`GET /stats` 端点要求的数据基础设施不存在

**位置**: `MANAGEMENT_API_CONTRACT.md` 第 6 节 + `src/storage/_stats_common.py`

契约定义了 `GET /stats` 需支持 `window=5m|15m|1h|24h|7d` 和 `group_by=node|mode|model`。但当前代码中：

- 只有 `_stats_common.py`（3KB 辅助模块）和 `minute_model_stats` 表（`web.py` 中定期清理，仅保留 24h）。
- **没有任何暴露的 `/stats` API 端点**。
- 没有 RPM 计算、没有滑动窗口聚合、没有模型族统计 API。

> **要求**：
> 1. `GCLI2API_CODEX_GUIDE.md` G2 阶段需增加 stats 接口的实现说明。
> 2. 明确哪些 stats 能力是 G2 阶段必须的（`stats.daily`），哪些可以延迟（`stats.rpm`）。
> 3. 对于旧节点，明确 manager 如何降级处理（只用 summary 计数推算）。

---

### 🟠 P1-7：Preview `disable_preview` 动作当前技术上不可实现

**位置**: `MANAGEMENT_API_CONTRACT.md` 第 7 节 + `src/panel/creds.py` L1810-1930

契约 action 枚举包含 `disable_preview`，capability 列表也分为 `credential.preview.enable` 和 `credential.preview.disable`。

但当前 `configure-preview` 端点只调用 Google Cloud API 设置 `release_channel=EXPERIMENTAL`。**没有任何代码路径可以撤销此设置**。`GCLI2API_CODEX_GUIDE.md` 也承认"Preview当前只有启用/配置语义，不得伪造关闭能力"。

然而契约第 7 节将 `disable_preview` 列入 action 枚举会让 manager 实施者误以为这是可以调用的动作。

> **要求**：
> 1. 将 `disable_preview` 从 action 枚举中移入"保留未来扩展"区域，并标注"当前无节点声明此 capability"。
> 2. 或在 action 枚举旁增加注释：节点只有在 `/capabilities` 返回 `credential.preview.disable` 时才能接受此动作。

---

## 三、P2/P3 非阻断建议

### 🟡 P2-1：缺少 Antigravity Credit 能力声明

**位置**: `MANAGEMENT_API_CONTRACT.md` 第 2 节

第 7 节动作枚举包含 `enable_credit` 和 `disable_credit`，但第 2 节 capability 列表遗漏了 `credential.credit.enable` 和 `credential.credit.disable`。

---

### 🟡 P2-2：动作参数 (`parameters`) Schema 未定义

**位置**: `MANAGEMENT_API_CONTRACT.md` 第 7 节

`set_remark` 需要 `remark` 字符串参数（当前限制 64 字符），`test` 可能需要 `model_name`。当前 `parameters: {}` 无法传递这些。

---

### 🟡 P2-3：契约未覆盖凭证上传能力

**位置**: `MANAGEMENT_API_CONTRACT.md` 整体

当前 `/creds/upload` 是关键的凭证管理端点，但 Management API 契约完全未提及上传。应明确声明：**首版 Management API 不支持凭证上传**（由管理员通过节点面板直接操作），并作为非目标记录。

---

### 🟡 P2-4：幂等键存储机制未定义

**位置**: `MANAGEMENT_API_CONTRACT.md` 第 8 节

要求 `idempotency_key` 保证幂等，但未定义：
- 键存储位置（内存 / 数据库？）
- TTL 多长（1 小时？24 小时？）
- 重启后是否保留

建议在契约中增加最低要求：幂等键至少存活 1 小时，重启后可丢失（允许内存存储）。

---

### 🟡 P2-5：CORS 全开放，管理 API 需额外防护

**位置**: `web.py` L165-171

```python
app.add_middleware(CORSMiddleware, allow_origins=["*"], ...)
```

当前 CORS 对所有域名完全开放。管理 API 端点在此配置下可被任意网页的 JavaScript 调用（只需知道 Token）。

建议在 `GCLI2API_CODEX_GUIDE.md` 中增加：Management API 路由组应考虑收紧 CORS 策略或依赖 Token 保密性。

---

### 🟡 P2-6：MySQL 多实例隔离（`GCLI_SERVER_NAME`）需在实施指南中强调

**位置**: `GCLI2API_CODEX_GUIDE.md` 第 3 节

MySQL 使用 `server_name` 列隔离多节点数据（`src/storage/mysql_manager.py` L48）。Management API 实现时必须通过 `storage_adapter` 读取，确保只操作当前节点的 `server_name` 范围内数据，不得越界。

---

## 四、代码事实验证摘要

| 契约/规范描述 | 代码验证结果 |
|-------------|------------|
| `verify_panel_token` 使用面板密码 | ✅ `src/utils.py` L338: `credentials.credentials != password` 明文对比 |
| `/version/info` 返回版本信息 | ✅ 存在但返回 `short_hash` 而非 SemVer |
| 4 种存储后端均有凭证表 | ✅ SQLite/MySQL/PostgreSQL/MongoDB 均有 |
| MySQL 缺少 `permanent_disabled` 等字段 | ✅ MySQL `STATE_FIELDS` 只有 10 项 |
| 无 `/stats` 暴露端点 | ✅ 无任何 stats 路由 |
| Preview 只有启用无关闭 | ✅ `configure-preview` 只调 Google API 设置 EXPERIMENTAL |
| `/docs` 挂载为静态文件 | ✅ `web.py` L211-212 |
| 面板密码与 API 密码分离 | ✅ `get_panel_password()` vs `get_api_password()` |
| smart_429 健康状态已在代码中实现 | ✅ SQLite/PostgreSQL/MongoDB 的 `STATE_FIELDS` 包含 `health_status` 等字段 |
| Redis 仅为 MySQL 缓存层 | ✅ 仅在 `mysql_manager.py` 中初始化 |

---

## 五、与前次 Review 的差异

| 前次发现 | 本次状态 |
|---------|---------|
| P1-1: 批量动作端点缺失 | 保留，升级描述精度 → P1-3 |
| P1-2: 分页 Wrapper 缺失 | 保留 → P1-2 |
| P1-3: 时间戳格式未标准化 | 保留 → P1-5 |
| P1-4: TOKEN 未配置行为 | 升级为 P0-3（安全问题） |
| P1-5: HTTP Status Code 映射缺失 | 保留 → P1-4 |
| P2-1: Credit 能力声明遗漏 | 保留 → P2-1 |
| P2-2: Parameters Schema | 保留 → P2-2 |
| P2-3: MySQL GCLI_SERVER_NAME | 保留 → P2-6 |
| P2-4: 探测 fallback 流程 | 降级为实施细节，不在规范层面阻断 |
| P3-1: OpenAPI 自动导出 | 降级为实施细节 |
| **新增** P0-1: `/docs` 静态暴露 | 🆕 代码验证发现 |
| **新增** P0-2: 无 SemVer 版本号 | 🆕 代码验证发现 |
| **新增** P1-1: MySQL STATE_FIELDS 落后 | 🆕 四后端字段详细对比 |
| **新增** P1-6: stats 基础设施不存在 | 🆕 代码验证发现 |
| **新增** P1-7: disable_preview 不可实现 | 🆕 代码验证发现 |
| **新增** P2-3: 上传能力未覆盖 | 🆕 |
| **新增** P2-4: 幂等键存储未定义 | 🆕 |
| **新增** P2-5: CORS 全开放 | 🆕 代码验证发现 |

---

## 六、建议修订优先级

```text
实施前必须解决（P0 阻断）：
  P0-1: /docs 静态挂载安全风险 → 规范增加部署安全约束
  P0-2: SemVer 版本号基础设施 → 协调规范增加前置步骤
  P0-3: NODE_MANAGEMENT_TOKEN 未配置默认行为 → 契约补充安全默认

实施前必须解决（P1 阻断）：
  P1-1: MySQL STATE_FIELDS 对齐 → 实施指南增加前置步骤
  P1-2: GET /credentials 分页 Wrapper → 契约补充
  P1-3: POST /credentials/batch-actions → 契约补充
  P1-4: 错误码 HTTP Status 映射 → 契约补充
  P1-5: 时间戳序列化标准 → 契约通用约定补充
  P1-6: GET /stats 基础设施 → 实施指南说明阶段和降级策略
  P1-7: disable_preview 枚举澄清 → 契约标注或移入保留区

建议实施前改进（P2/P3）：
  P2-1: Credit capability 声明
  P2-2: 动作参数 Schema
  P2-3: 上传能力非目标声明
  P2-4: 幂等键存储最低要求
  P2-5: CORS 策略
  P2-6: MySQL 多实例隔离说明
```

---

## 七、结论

本次 Review 基于代码级交叉验证，相比前次文档层面 Review 新增了 8 项发现（含 2 个 P0）。所有 P0 和 P1 问题解决后，方案可更新为 **Approved** 状态。

建议将本文件直接交给实施者，按第六节优先级逐项修订规范文档，修订完成后再启动 G1 阶段的代码实施。
