# gcli2api Management API 契约

状态：**Draft for Review**

契约版本：`management-schema 1.2`

基础路径：`/management/v1`

本文使用“必须”“禁止”表示规范性要求。

## 1. 通用约定

### 认证

```http
Authorization: Bearer <NODE_MANAGEMENT_TOKEN>
```

管理Token必须与普通API密码、面板密码分离。Legacy适配器可继续使用旧面板密码。

未配置或配置为空的`NODE_MANAGEMENT_TOKEN`必须使整个`/management/v1/*`路由默认关闭，
返回HTTP 503和`MANAGEMENT_API_DISABLED`。禁止接受空Token，也禁止隐式回退到普通API
密码或面板密码。Token错误返回HTTP 401；该响应不得泄漏节点是否存在某个凭证。

### 时间格式

所有API传输层时间字段必须使用UTC ISO 8601格式`YYYY-MM-DDTHH:mm:ssZ`。未设置或节点
无法获得的时间使用`null`。实现层从SQLite Unix timestamp读取时必须在schema边界转换，
禁止同时返回数字时间戳和字符串时间戳。

### 通用响应元数据

所有成功响应必须包含：

```json
{
  "schema_version": "1.2",
  "server_version": "1.3.0",
  "revision": "0123456789abcdef",
  "generated_at": "2026-08-10T12:00:00Z"
}
```

### 通用错误

```json
{
  "error": {
    "code": "CAPABILITY_NOT_SUPPORTED",
    "message": "Current node does not support this action",
    "retryable": false,
    "details": {}
  }
}
```

规范错误码至少包含：

- `MANAGEMENT_API_DISABLED`
- `AUTHENTICATION_FAILED`
- `CAPABILITY_NOT_SUPPORTED`
- `CREDENTIAL_NOT_FOUND`
- `INVALID_ACTION`
- `INVALID_MODE`
- `CONFLICT`
- `RATE_LIMITED`
- `UPSTREAM_UNAVAILABLE`
- `INTERNAL_ERROR`

HTTP状态映射：

| 错误码 | HTTP状态 | 默认retryable |
|---|---:|---|
| `MANAGEMENT_API_DISABLED` | 503 | false |
| `AUTHENTICATION_FAILED` | 401 | false |
| `CAPABILITY_NOT_SUPPORTED` | 501 | false |
| `CREDENTIAL_NOT_FOUND` | 404 | false |
| `INVALID_ACTION`、`INVALID_MODE` | 400 | false |
| `CONFLICT` | 409 | true |
| `RATE_LIMITED` | 429 | true |
| `UPSTREAM_UNAVAILABLE` | 502 | true |
| `INTERNAL_ERROR` | 500 | false |

单项批量结果复用相同错误对象和错误码，但不得把单项失败提升为整个批次的HTTP失败；
批次请求本身无法解析、未认证或管理API关闭时除外。

### 安全字段

任何Management API响应都禁止包含：

- `access_token`
- `refresh_token`
- `client_secret`
- `token`
- 完整credential JSON
- 面板/API/管理密码

## 2. Capability命名

能力清单：

```text
node.summary
credential.list
credential.enable
credential.disable
credential.permanent_disable
credential.delete
credential.remark
credential.preview.enable
credential.preview.disable
credential.credit.enable
credential.credit.disable
credential.quota
credential.errors
credential.test
credential.risk_check
credential.batch_action
credential.cooldown.sync
stats.daily
stats.model
stats.rpm
ui.credential_console.embed
```

Preview启用和关闭必须是两个独立能力。当前只有配置Preview能力的版本不得声明
`credential.preview.disable`。

## 3. `GET /capabilities`

返回节点身份、版本和能力：

```json
{
  "schema_version": "1.2",
  "server_version": "1.3.0",
  "revision": "0123456789abcdef",
  "generated_at": "2026-08-10T12:00:00Z",
  "storage_backend": "sqlite",
  "capabilities": [
    "node.summary",
    "credential.list",
    "credential.enable",
    "credential.disable",
    "credential.preview.enable",
    "credential.quota"
  ]
}
```

该接口是manager选择Modern适配器的唯一必要入口。

## 4. `GET /summary`

返回节点级摘要，不返回凭证明细：

```json
{
  "schema_version": "1.2",
  "server_version": "1.3.0",
  "revision": "0123456789abcdef",
  "generated_at": "2026-08-10T12:00:00Z",
  "uptime_seconds": 86400,
  "modes": {
    "geminicli": {
      "total": 89,
      "enabled": 80,
      "disabled": 1,
      "permanent_disabled": 8,
      "cooling_down": 12
    },
    "antigravity": {
      "total": 0,
      "enabled": 0,
      "disabled": 0,
      "permanent_disabled": 0,
      "cooling_down": 0
    }
  }
}
```

缺失或不支持的数据返回`null`，禁止用0伪装未知。

## 5. `GET /credentials`

查询参数：

- `mode=geminicli|antigravity`
- `cursor`或`offset`
- `limit`，最大1000
- `status`
- `error_code`
- `cooldown`
- `preview`
- `tier`
- `remark`

列表响应必须使用分页外壳；即使节点没有数据也返回空`credentials`数组：

```json
{
  "schema_version": "1.2",
  "server_version": "1.3.0",
  "revision": "0123456789abcdef",
  "generated_at": "2026-08-10T12:00:00Z",
  "credentials": [],
  "page": {
    "total": 0,
    "limit": 100,
    "has_more": false,
    "next_cursor": null
  }
}
```

使用`offset`时`next_cursor`仍可为`null`；使用`cursor`时不得同时传`offset`。`total`无法
低成本准确计算时允许为`null`，但`has_more`必须准确。

`credentials`中的标准凭证摘要：

```json
{
  "id": "geminicli:credential-001.json",
  "mode": "geminicli",
  "filename": "credential-001.json",
  "user_email": "user001@example.invalid",
  "status": "enabled",
  "health_status": "healthy",
  "error_codes": [429],
  "last_success": "2026-08-10T11:59:00Z",
  "model_cooldowns": {
    "gemini-3-pro-preview": "2026-08-10T22:00:00Z"
  },
  "tier": "enterprise",
  "preview": true,
  "enable_credit": null,
  "success_count": 8769,
  "failure_count": 101,
  "cycle_stats": {},
  "last_cycle_stats": {},
  "remark": ""
}
```

状态枚举：`enabled`、`disabled`、`permanent_disabled`。未知健康、Tier或计数使用`null`。

## 6. `GET /stats`

支持：

- `mode`
- `window=5m|15m|1h|24h|7d`
- `group_by=node|mode|model`

返回成功、失败、总量、RPM及模型族统计。旧节点无法提供窗口数据时由manager根据累计
快照推算，服务端不得捏造数据。

## 7. `POST /credentials/{mode}/{filename}/actions`

请求：

```json
{
  "action": "disable",
  "parameters": {},
  "idempotency_key": "4f195f1e-1dd4-4f37-bf48-58fcfd860234"
}
```

动作枚举：

- `enable`
- `disable`
- `permanent_disable`
- `delete`
- `set_remark`
- `enable_preview`
- `disable_preview`
- `enable_credit`
- `disable_credit`
- `quota`
- `errors`
- `test`
- `risk_check`
- `sync_cooldown`

`parameters`按动作定义：

| 动作 | parameters |
|---|---|
| `set_remark` | `{"remark": "string"}`，最大500字符 |
| `test`、`risk_check` | 可选`{"model_name": "string"}` |
| `quota` | 可选`{"refresh": true}`，默认`false` |
| `enable_preview` | 可选且仅允许契约声明的Preview配置字段 |
| 其余动作 | 必须为空对象`{}` |

模式边界：`enable_preview`、`disable_preview`和`risk_check`只适用于`geminicli`；
`enable_credit`和`disable_credit`只适用于`antigravity`；额度、错误、测试和冷却同步仅在
对应mode确实有实现时才可执行。capability必须真实，mode不支持时返回501
`CAPABILITY_NOT_SUPPORTED`，manager也必须在发送前禁用该操作。

未知参数必须返回400 `INVALID_ACTION`，不得静默忽略。额度、测试和风险动作是否接受
`model_name`由对应capability和OpenAPI schema进一步限制。

节点只能接受capability声明支持的动作。相同幂等键必须返回相同最终结果，不得重复执行
具有外部副作用的操作。

成功响应：

```json
{
  "schema_version": "1.2",
  "server_version": "1.3.0",
  "revision": "0123456789abcdef",
  "generated_at": "2026-08-10T12:00:00Z",
  "action": "disable",
  "status": "succeeded",
  "no_change": false,
  "credential": {
    "mode": "geminicli",
    "filename": "credential-001.json",
    "status": "disabled"
  },
  "result": null,
  "error": null,
  "side_effects": []
}
```

额度、Preview、风险和测试必须通过`side_effects`说明可能发生的Token刷新、冷却同步或
Google API调用。

主动操作成功时必须返回经过白名单裁剪的`result`；普通状态操作返回`null`。新增字段仍按
schema 1.x加法兼容处理：

| 动作 | `result.kind` | 允许字段 |
|---|---|---|
| `enable_preview`、`disable_preview` | `preview` | `enabled` |
| `enable_credit`、`disable_credit` | `credit` | `enabled` |
| `quota` | `quota` | `captured_at`、`models[]`；每项只含`model_name`、`remaining_percent`、`resets_at` |
| `errors` | `errors` | `entries[]`；每项只含`code`、`message`、`last_seen` |
| `test` | `test` | `outcome`、`model_name`、`latency_ms` |
| `risk_check` | `risk` | `level`、`codes[]` |
| `sync_cooldown` | `cooldown_sync` | `model_cooldowns`（模型名到UTC时间或`null`） |

manager从10分钟额度缓存返回结果时可加`cached=true`；节点不得自行把过期结果标记为缓存
命中。所有未知、敏感或嵌套上游字段必须丢弃，不得返回Token、项目凭据、完整Google响应、
请求/响应正文或完整凭证JSON。`remaining_percent`范围为0至100；未知数值和时间使用`null`。

`side_effects`每项只允许`kind`、`description`和`occurred`。主动操作必须按实际情况使用
`token_refreshed`、`google_api_called`、`cooldown_updated`、`credential_state_updated`或
`quota_cache_hit`等稳定kind；不得把上游正文塞入`description`。

## 8. `POST /credentials/batch-actions`

该端点仅在节点声明`credential.batch_action`时可用。单批最多100项；manager仍应按节点
限流，外部副作用动作默认不得与普通状态动作混为同一批次。

请求：

```json
{
  "idempotency_key": "batch-93ebec8c-24db-438d-b080-6a9ef2f70894",
  "items": [
    {
      "mode": "geminicli",
      "filename": "credential-001.json",
      "action": "disable",
      "parameters": {},
      "idempotency_key": "item-e7004d27-6fb1-42d6-a73c-19ac32d04b80"
    }
  ]
}
```

批次键保证同一批次重试不重复调度；每个item键保证单项副作用不重复执行。响应必须逐项
返回结果，允许部分成功：

```json
{
  "schema_version": "1.2",
  "server_version": "1.3.0",
  "revision": "0123456789abcdef",
  "generated_at": "2026-08-10T12:00:00Z",
  "status": "partially_succeeded",
  "results": [
    {
      "mode": "geminicli",
      "filename": "credential-001.json",
      "action": "disable",
      "status": "succeeded",
      "no_change": false,
      "credential_status": "disabled",
      "result": null,
      "error": null,
      "side_effects": []
    }
  ]
}
```

批次`status`枚举为`succeeded`、`partially_succeeded`、`failed`。结果顺序必须与请求顺序
一致；单项错误使用第1节错误对象。manager不得因部分失败自动重放已成功项。

## 9. 并发与冲突

- 删除、永久禁用和外部副作用动作必须支持幂等键。
- 凭证不存在返回404和`CREDENTIAL_NOT_FOUND`。
- 状态已达到目标时返回成功并标记`no_change=true`。
- 同一凭证的冲突写操作必须串行化或返回409 `CONFLICT`。
- manager遇到超时后必须先读取当前状态，再决定是否重试。

## 10. `ui.credential_console.embed`

该capability表示节点控制面板同时满足以下嵌入协议：

- 控制面板根路径接受白名单fragment；`/#manage`必须在未登录、已登录和刷新后定位到GCLI
  凭证管理tab，未知fragment必须回到安全默认tab；
- 节点配置了一个或多个规范化HTTPS manager Origin；配置不得接受`*`、HTTP、路径、查询、
  fragment或用户信息；未配置允许Origin时不得声明该capability；
- 控制面板响应必须通过HTTP响应头发送精确的CSP `frame-ancestors`允许列表；不得仅通过
  HTML `meta`声明，也不得同时发送会阻断已允许manager的`X-Frame-Options`；
- 当页面在允许Origin的父页面中完成加载并激活`manage` tab后，必须只向该Origin发送：

```json
{
  "type": "gcli2api.console.ready",
  "version": 1,
  "tab": "manage"
}
```

- 消息不得包含登录状态、Token、密码、凭证、配置、节点内部路径或业务数据；父页面必须
  同时校验`event.origin`、`event.source`、`version`和`tab`；
- 该能力不提供SSO、委托会话、面板密码交换、manager反向代理、HTML重写或节点API跨域
  调用。节点仍独立认证，manager仅负责用户可见导航和失败回退。

缺失该capability时manager不得尝试通过版本字符串、响应外观或当前未设置安全头推断可
嵌入；只能使用新标签打开已注册节点的HTTPS控制面板。停用节点禁止打开，离线节点只允许
管理员显式尝试新标签。

## 11. Schema演进

- 新增可选字段：schema minor递增，例如`1.0`到`1.1`。
- 新增capability：schema minor递增。
- 新增可选动作参数：schema minor递增。
- 删除、重命名、改变类型或副作用：新增`/management/v2`。
- manager必须忽略未知字段，节点必须拒绝未知动作。
