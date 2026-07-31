# Gemini CLI Standard / Enterprise Tier 识别 Review 指南

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| Review 分支 | `dev4` |
| Review 基线 | 当前 `dev4` 分支 `HEAD` 与工作区修改的差异 |
| 变更主题 | Gemini CLI 的 Code Assist Standard / Enterprise Tier 识别 |
| 生成日期 | 2026-07-17 |
| 主要影响范围 | Gemini CLI OAuth、Refresh Token 导入、JSON/ZIP 上传、凭证检验、存储、筛选与 Badge |
| 非目标范围 | Antigravity Tier 识别逻辑与界面 |

> 本文档基于当前尚未提交的工作区代码生成。Review 时应将本文档与 `git diff` 一并使用。

## 2. Review 目标

本次修改希望解决以下问题：

1. Gemini CLI 原有 Tier 只有 `free / pro / ultra`，无法区分 Gemini Code Assist Standard 与 Enterprise。
2. `standard-tier` 不能可靠区分 Standard 和 Enterprise，因此 Enterprise 需要优先依据 Google 返回的名称识别。
3. Tier 探测只应发生在明确的凭证操作中，不能在列表刷新或后台请求路径中隐式访问 Google API。
4. 临时网络失败不能覆盖已有凭证的上次有效 Tier；正常返回但无法识别的 Tier 则必须保存为 `unknown`，并保留原始字段。
5. Antigravity 的现有请求体、Tier 映射、筛选项和 Badge 行为必须保持不变。

## 3. 标准化数据模型

核心实现位于 `src/subscription_tiers.py`。

### 3.1 标准 Tier 值

| 标准值 | 界面标签 | 适用范围 |
| --- | --- | --- |
| `free` | Free | Gemini CLI、Antigravity |
| `pro` | Pro | Gemini CLI、Antigravity，兼容历史数据 |
| `ultra` | Ultra | Gemini CLI、Antigravity，兼容历史数据 |
| `code_assist_standard` | Code Assist Standard | 仅 Gemini CLI |
| `code_assist_enterprise` | Code Assist Enterprise | 仅 Gemini CLI |
| `unknown` | Unknown | 仅 Gemini CLI |

### 3.2 `GeminiCliSubscriptionInfo`

统一的内部结果包含：

| 字段 | 类型/取值 | 说明 |
| --- | --- | --- |
| `project_id` | `str \| None` | Google 返回或调用方已知的 Project ID |
| `tier` | 六种标准值之一 | 标准化后的 Tier |
| `raw_tier_id` | `str \| None` | Google 返回的原始 Tier ID |
| `raw_tier_name` | `str \| None` | Google 返回的原始 Tier 名称 |
| `detected_at` | `int \| None` | Unix 秒 |
| `status` | `detected / unrecognized / unavailable` | 探测状态 |

状态语义：

- `detected`：Google 正常返回，且 Tier 已识别。
- `unrecognized`：Google 正常返回，但 Tier 不在已知映射中；写入 `unknown` 并保存原始值。
- `unavailable`：网络错误、HTTP 错误或响应不可解析；不得覆盖已有 Tier。

## 4. Tier 映射规则

Reviewer 应重点核对 `normalize_geminicli_subscription()` 的优先级：

1. 优先选择非空的 `paidTier`。
2. `paidTier` 不可用时回退到 `currentTier`。
3. 名称包含 `Gemini Code Assist Enterprise` 时映射为 Enterprise，即使 ID 是 `standard-tier`。
4. 名称包含 Standard，或 ID 为 `standard-tier` 时映射为 Standard。
5. 历史消费者 Tier ID 继续映射为 Free / Pro / Ultra：

| 原始 ID | 标准 Tier |
| --- | --- |
| `free-tier` | `free` |
| `g1-pro-tier` | `pro` |
| `helium-tier` | `pro` |
| `g1-ultra-tier` | `ultra` |
| `ws-ai-ultra-business-tier` | `ultra` |

6. 缺失、畸形或未知 Tier 映射为 `unknown`，状态为 `unrecognized`。
7. `cloudaicompanionProject` 同时兼容字符串和 `{ "id": "..." }` 对象形式。

## 5. Google API 请求 Review

Gemini CLI 新增独立入口：

- 文件：`src/google_oauth_api.py`
- 函数：`fetch_geminicli_subscription_info()`
- 端点：`/v1internal:loadCodeAssist`

请求体应符合以下结构：

```json
{
  "metadata": {
    "ideType": "IDE_UNSPECIFIED",
    "platform": "PLATFORM_UNSPECIFIED",
    "pluginType": "GEMINI",
    "duetProject": "known-project-id"
  },
  "cloudaicompanionProject": "known-project-id"
}
```

核对点：

- 未知 Project ID 时不应发送 `duetProject` 和 `cloudaicompanionProject`。
- 已知 Project ID 时两个字段应同时发送。
- Tier 探测函数自身不得调用 `onboardUser`。
- 原有 Antigravity `_try_load_code_assist()` 请求体仍为：

```json
{
  "metadata": {
    "ideType": "ANTIGRAVITY"
  }
}
```

- 新增日志不得记录 access token 或完整响应。
- Tier ID/名称写入日志前应清理空白并限制长度。

## 6. 业务流程变化

### 6.1 OAuth

涉及 `src/auth.py` 与 `src/panel/auth.py`。

```text
OAuth 换取凭证
  -> 沿用原有 Project ID 解析/选择/回退
  -> 沿用原有 API enable 行为
  -> 调用 Gemini CLI loadCodeAssist 探测 Tier
  -> 保存标准 Tier、原始字段与识别时间
  -> OAuth 响应增加原始字段和识别状态
```

Review 要点：

- 探测必须发生在 Project ID 解析完成后。
- 新凭证探测失败时默认 `unknown`，不能默认 `pro`。
- 极端情况下同一秒生成同名文件并覆盖旧凭证时，`unavailable` 不得覆盖旧 Tier。
- Antigravity OAuth 不应新增 Gemini CLI 原始 Tier 字段。

### 6.2 Refresh Token 单个/批量导入

核心函数：`src/panel/creds.py::_add_credential_by_refresh_token()`。

单个和批量接口复用同一实现，因此应具备相同语义：

- 先换取 access token。
- 再完成 Project ID 解析。
- Gemini CLI 最后执行一次 Tier 探测。
- 新凭证探测失败时保存 `unknown`。
- 使用同名文件覆盖已有凭证且探测失败时，保留旧 Tier、原始值和识别时间。
- 响应增加：
  - `tier_raw_id`
  - `tier_raw_name`
  - `tier_detected_at`
  - `tier_detection_status`

### 6.3 JSON/ZIP 文件上传

核心函数：`src/panel/creds.py::upload_credentials_common()`。

- Gemini CLI 文件入库后立即调用 `loadCodeAssist` 探测 Tier，Antigravity 上传保持不变。
- 上传凭证的 access token 过期时优先使用 refresh token 刷新；刷新失败仍尝试现有 token。
- 批量上传的 Tier 探测并发限制为 5。
- `unavailable` 不影响上传成功，也不覆盖同名旧凭证的 Tier；新凭证保留 `unknown`。
- 上传响应返回标准 Tier、原始字段、识别时间与 `tier_detection_status`。
- 已有 `Unknown` 数据不自动请求 Google API，需通过单个/批量检验逐步刷新。

### 6.4 单个/批量检验

核心函数：`src/panel/creds.py::verify_credential_project_common()`。

```text
读取旧状态
  -> 刷新 token
  -> 优先使用凭证中的 Project ID
  -> 缺失时从项目列表选择
  -> 沿用 API enable 行为
  -> 探测 Tier
  -> 根据 detected / unrecognized / unavailable 更新状态
```

失败策略核对：

| 场景 | 预期 Tier 行为 |
| --- | --- |
| 正常且已识别 | 更新标准 Tier、原始字段、时间 |
| 正常但未知 | 更新为 `unknown`，保存原始字段、时间 |
| 网络/HTTP/解析失败 | 保留旧 Tier、原始字段、时间 |

前端批量检验是并行调用单个检验接口，因此语义应自动保持一致。

## 7. API 兼容性

### 7.1 `GET /creds/status`

Gemini CLI 的 `tier_filter` 接受：

```text
free
pro
ultra
code_assist_standard
code_assist_enterprise
unknown
```

Gemini CLI 条目新增返回字段：

```json
{
  "tier": "code_assist_enterprise",
  "tier_raw_id": "standard-tier",
  "tier_raw_name": "Gemini Code Assist Enterprise",
  "tier_detected_at": 1784260800
}
```

Antigravity 仍只接受 `free / pro / ultra`，且状态列表不增加 Gemini CLI 原始 Tier 字段。

### 7.2 新增与检验响应

新增字段均为向后兼容字段，旧客户端可以忽略：

```json
{
  "subscription_tier": "code_assist_standard",
  "tier_raw_id": "standard-tier",
  "tier_raw_name": "Gemini Code Assist Standard",
  "tier_detected_at": 1784260800,
  "tier_detection_status": "detected"
}
```

## 8. 存储迁移 Review

Gemini CLI 状态新增：

- `tier_raw_id`
- `tier_raw_name`
- `tier_detected_at`

### 8.1 后端矩阵

| 后端 | Gemini CLI Tier 默认值 | 原始字段 | 额外迁移要点 |
| --- | --- | --- | --- |
| SQLite | `unknown` | 支持 | 旧表自动加列；不改写已有 Tier |
| PostgreSQL | `unknown` | 支持 | 旧表自动加列；新增时显式写默认 Tier |
| MySQL | `unknown` | 支持 | `tier` 扩为 `VARCHAR(32)` |
| MongoDB | `unknown` | 支持 | 新文档显式保存原始字段默认值 |

Antigravity 的默认 Tier 保持 `pro`。

### 8.2 SQLite 特别说明

Review/测试期间发现 SQLite 不能通过 `ALTER TABLE` 添加带 `unixepoch()` 非常量默认值的列。兼容迁移定义已改为：

```text
created_at REAL DEFAULT 0
updated_at REAL DEFAULT 0
```

这只用于旧表加列；新建表仍使用 `unixepoch()`。后续状态更新会正常写入 `updated_at`。

### 8.3 Redis Tier 集合

MongoDB 后端使用 Redis 时：

- Antigravity 集合只维护 `free / pro / ultra`。
- Gemini CLI 集合维护全部六种 Tier。
- Tier 变化时先从该模式全部 Tier 集合移除，再加入新集合，避免残留在旧 Tier 桶。
- 非 Free 候选池包含 Standard 与 Enterprise，但不包含 Unknown。

## 9. 前端 Review

涉及：

- `front/common.js`
- `front/control_panel.html`
- `front/control_panel_mobile.html`

Gemini CLI 桌面端与移动端新增筛选项：

1. Code Assist Standard
2. Code Assist Enterprise
3. Free
4. Pro
5. Ultra
6. Unknown

Badge 配色：

| Tier | 颜色用途 |
| --- | --- |
| Standard | 蓝色 |
| Enterprise | 紫色 |
| Free | 灰蓝色 |
| Pro | 绿色 |
| Ultra | 橙色 |
| Unknown | 灰色 |

Tooltip 展示：

- 标准化标签
- 原始 Tier ID
- 原始 Tier 名称
- 本地格式化后的识别时间

安全核对：原始 ID、名称和 Tooltip 整体必须经过 HTML 属性转义。

Antigravity 仍使用旧的全大写标签、颜色和 Tooltip，不使用 Gemini CLI 的新展示分支。

## 10. 文件级 Review 顺序

建议按以下顺序审查：

1. `src/subscription_tiers.py`
   - 数据结构、映射优先级、Unknown 语义。
2. `src/google_oauth_api.py`
   - 请求元数据、无 onboarding、错误与日志策略。
3. `src/auth.py`
   - 三条 Gemini CLI OAuth 完成路径是否全部接入。
4. `src/panel/auth.py`
   - OAuth HTTP 响应字段是否只对 Gemini CLI 增加。
5. `src/panel/creds.py`
   - 状态接口、JSON/ZIP 上传、单个/批量检验、Refresh Token 单个/批量导入。
6. `src/storage/sqlite_manager.py`
7. `src/storage/psql_manager.py`
8. `src/storage/mysql_manager.py`
9. `src/storage/mongodb_manager.py`
   - 四种后端的字段、默认值、投影、更新、筛选是否一致。
10. `front/common.js`
11. `front/control_panel.html`
12. `front/control_panel_mobile.html`
   - Gemini CLI 新筛选和 Badge；Antigravity 无变化。
13. 四个新增测试文件。

## 11. 自动化验证结果

当前实现已执行：

```text
pytest                                      21 passed
python -m compileall -q src ...             passed
node --check front/common.js                passed
git diff --check                            passed
```

新增测试文件：

- `test_subscription_tiers.py`
- `test_geminicli_subscription_api.py`
- `test_sqlite_tier_storage.py`
- `test_upload_tier_detection.py`

覆盖内容：

- Enterprise 名称覆盖 `standard-tier` ID。
- Standard 名称和 ID。
- `paidTier` 优先级与 `currentTier` 回退。
- 历史 Free / Pro / Ultra ID。
- 未知、缺失、畸形字段。
- Gemini CLI 请求元数据与 Project ID 字段。
- HTTP 失败返回 `unavailable`。
- Antigravity 请求体不变。
- SQLite 旧表自动迁移且不改写已有 Pro。
- 新字段写入、读取、筛选往返。

## 12. 人工验证清单

以下项目需要 Reviewer 在可运行环境中人工确认：

- [ ] 桌面端 Gemini CLI 筛选框包含六种 Tier。
- [ ] 移动端 Gemini CLI 筛选框包含六种 Tier。
- [ ] Standard / Enterprise / Unknown Badge 标签和颜色正确。
- [ ] Tooltip 正确显示原始 ID、名称和识别时间。
- [ ] 包含引号、尖括号等字符的原始名称不会破坏 HTML。
- [ ] Antigravity 下拉框仍只有 Free / Pro / Ultra。
- [ ] Antigravity Badge 外观与修改前一致。
- [ ] 使用真实 Standard 订阅执行 OAuth 后显示 Standard。
- [ ] 使用真实 Enterprise 订阅且返回 `standard-tier` 时显示 Enterprise。
- [ ] 临时阻断 Google API 后检验已有凭证，旧 Tier 不被覆盖。
- [ ] 模拟未知 Tier，确认显示 Unknown 且 Tooltip 保留原始信息。
- [ ] Refresh Token 单个与批量导入返回新增字段。
- [ ] JSON/ZIP 上传新凭证后返回识别状态，并在成功时立即显示实际 Tier。

## 13. 高风险检查点

Reviewer 应优先确认：

1. **Enterprise 名称优先级**：必须在 `standard-tier` ID 判断之前执行。
2. **临时失败的数据保护**：`unavailable` 与 `unrecognized` 不能混为一类。
3. **旧数据兼容**：已有 Free / Pro / Ultra 数据不能被迁移脚本批量改写。
4. **模式隔离**：Gemini CLI 新 Tier 不得进入 Antigravity 的筛选白名单或 Redis Tier 集合。
5. **请求副作用**：列表刷新不得调用 Google；Tier 探测不得触发 onboarding。
6. **MySQL 字段长度**：`code_assist_enterprise` 必须能完整保存。
7. **输出安全**：原始 Tier 名称只能作为转义后的 Tooltip 内容输出。

## 14. 已知假设与后续扩展

- Google 当前没有稳定公开的 Enterprise 专用 Tier ID，因此 Enterprise 依据名称识别。
- 原始 ID/名称已落库，Google 将来提供稳定 ID 后可以只扩展映射，不需要再次修改存储结构。
- 不根据配额、邮箱域名、IAM 角色或 Project ID 推断订阅。
- 不增加后台定时探测，也不在每次列表刷新时调用 Google API。
- 未在本文档生成过程中连接真实 Google Standard/Enterprise 账号，真实订阅回包仍需人工验收。

## 15. Review 结论模板

Reviewer 可复制以下模板填写结论：

```text
Review 结果：通过 / 有条件通过 / 不通过

阻塞问题：
1.

非阻塞建议：
1.

已确认：
- [ ] Tier 映射正确
- [ ] 失败策略正确
- [ ] 四种存储一致
- [ ] Antigravity 无回归
- [ ] 桌面端和移动端显示正确
- [ ] 自动化测试通过
```
