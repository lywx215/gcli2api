# SMART 429 保护方案审计报告

> **审计日期**: 2026-07-17
> **审计对象**: [SMART_429_PROTECTION_REVIEW.md](file:///g:/code/gemini30/gcli2api/review/SMART_429_PROTECTION_REVIEW.md)
> **审计方法**: 方案文档逐条与源代码交叉验证

---

## 审计结论：有条件通过

方案整体架构严谨、风险意识充分，总开关设计和分级保护的思路正确。但存在 **4 个阻塞问题** 和 **8 个非阻塞建议**，需要在进入实施前解决。

---

## 一、阻塞问题（必须修复后才能进入实施）

### 🔴 P0-1：`RESOURCE_EXHAUSTED` 在 `CAPACITY_EXHAUSTED_REASONS` 中，风控匹配条件存在歧义

**方案第 6.1 节**声称风控精确匹配条件为：

```text
HTTP 429 + error.status = RESOURCE_EXHAUSTED + 精确 message
```

但**实际代码** `src/api/utils.py` L512-514 中 `CAPACITY_EXHAUSTED_REASONS` 集合包含 `"RESOURCE_EXHAUSTED"` 本身：

```python
CAPACITY_EXHAUSTED_REASONS = {
    "MODEL_CAPACITY_EXHAUSTED",
    "RESOURCE_EXHAUSTED",   # ← 问题：笼统的 reason
    "NO_CAPACITY_AVAILABLE",
}
```

这意味着如果一个风控 429 的 `details` 中 `reason = "RESOURCE_EXHAUSTED"`（不是 `MODEL_CAPACITY_EXHAUSTED`），现有代码会把它当成"容量不足、不设冷却"处理（`utils.py` L601-603）。

而方案第 2.3 节指出风控 429 **没有 `details` 字段**。如果 Google 未来变更风控 429 格式加入了 `reason=RESOURCE_EXHAUSTED` 的 details，方案中的精确匹配逻辑与 `parse_quota_reset_timestamp` 中的容量判断就会冲突。

> **要求**：方案必须明确规定 `verify_geminicli_risk_control` 和 `parse_quota_reset_timestamp` 的判断优先级和互斥关系。建议风控检测独立于现有 `parse_quota_reset_timestamp`，不复用任何容量判断路径。

---

### 🔴 P0-2：MySQL 与 SQLite 字段严重不一致，迁移方案未覆盖

**方案第 13 节**要求"SQLite、MySQL、PostgreSQL、MongoDB 字段语义一致"，但实际代码中 **MySQL 缺少大量 SQLite 已有字段**：

| 字段 | SQLite | MySQL |
|------|--------|-------|
| `permanent_disabled` | ✅ | ❌ |
| `cycle_stats` | ✅ | ❌ |
| `last_cycle_stats` | ✅ | ❌ |
| `success_count` | ✅ | ❌ |
| `failure_count` | ✅ | ❌ |
| `remark` | ✅ | ❌ |
| `enable_credit` (antigravity) | ✅ | ❌ (MySQL antigravity 表无此列) |

**MySQL `STATE_FIELDS`**（`src/storage/mysql_manager.py` L28-40）只有 10 个字段，SQLite 有 18 个。

> **要求**：在新增 `health_status`、`quarantine_reason` 等 7 个字段之前，必须先解决现有字段不一致问题。否则新增字段的迁移脚本在不同后端上行为不可预测。方案第 13 节应增加"现有字段对齐"作为前置步骤。

---

### 🔴 P0-3：预热竞态窗口比方案描述更大

**方案第 2.2 节**正确指出"请求重试时先创建下一凭证预取任务，再记录当前凭证冷却"。但实际代码问题比描述的更严重：

`src/api/geminicli.py` L274-287：

```python
# 1. 先预热（异步创建 task，立即执行 get_valid_credential）
next_cred_task = asyncio.create_task(
    credential_manager.get_valid_credential(mode="geminicli", model_name=model_name)
)

# 2. 再记录错误（写冷却/写状态）
await record_api_call_error(...)
```

由于 `asyncio.create_task` 会**立即调度** task，而 `get_valid_credential` 内部的数据库查询可以在 `record_api_call_error` 写入之前完成，预热 task 几乎必然在冷却写入前就完成了凭证选择。这不是"可能"的竞态，而是**高概率**的竞态。

更严重的是，`get_valid_credential` **没有 `excluded_credentials` 参数**（已确认所有 4 个存储后端均无），因此预热 task **没有任何机制**排除当前失败凭证。

> **要求**：方案第 11 节提出的 `excluded_credentials` 参数必须作为第一批实施，先于风控检测逻辑。同时方案应明确标注：当前竞态不只是"可能重新选中"，而是"由于执行顺序保证会在冷却写入前完成选择"。

---

### 🔴 P0-4：Redis 不是独立存储后端，方案多处假设不成立

**方案第 5.4 节**和**第 9.3 节**大量依赖 Redis 进行多实例协调（发布配置变更、SET NX 租约、半开探针去重）。但实际代码中 **Redis 不是独立存储后端**，它只是 MySQL 的可选缓存层：

- `src/storage/mysql_manager.py` L54-56：`self._redis = None`
- Redis 仅在 MySQL 模式下可用，SQLite/PostgreSQL/MongoDB 均无 Redis 支持
- 当前 Redis **没有 pub/sub 机制**——所有 Redis 操作都是缓存读写

方案以下假设不成立：

| 方案描述 | 实际情况 |
|---------|---------|
| "有 Redis 时发布配置变更消息" | Redis 无 pub/sub，且仅 MySQL 可用 |
| "Redis 使用 SET NX + TTL 租约" | Redis 当前只做凭证池缓存，无租约机制 |
| "Redis 场景传播 < 1 秒" | 无传播机制 |
| "Redis 和非 Redis 部署均能正确传播" | PostgreSQL/MongoDB/SQLite 无 Redis |

> **要求**：方案必须重新设计多实例协调方案，分为以下场景：
> 1. **MySQL + Redis**：可以扩展 Redis 加入 pub/sub，但需从头构建
> 2. **MySQL 无 Redis**：只能靠数据库轮询
> 3. **SQLite**：本质上只能单实例，应明确声明不支持多实例协调
> 4. **PostgreSQL/MongoDB**：数据库轮询，需明确轮询表/集合设计

---

## 二、非阻塞建议（建议实施前改进）

### 🟡 S1：前端默认值与后端不一致（方案第 2.2 节已指出但未给出解决方案）

方案正确指出了配置不一致：
- 后端默认 `max_retries = 5`（`config.py` L168-177）
- `.env.example` 默认 `5`
- README 描述 `3`
- 前端缺省回填 `20 次、0.1 秒`

但方案只描述了问题，**没有明确要求本次实施统一这些默认值**。建议在方案第 11 节增加：在启用保护前，必须先统一所有默认值为 `max_retries=3, interval=1.0`。

---

### 🟡 S2：`_switch_credential_for_retry` 存在双重 sleep

`src/api/geminicli.py` L126-141：

```python
async def _switch_credential_for_retry(...):
    if next_cred_task is not None:
        cred_result = await next_cred_task
        if cred_result and apply_cred_result(cred_result):
            await asyncio.sleep(retry_interval)  # ← sleep 1
            return True, next_cred_task

    await asyncio.sleep(retry_interval)  # ← sleep 2（fallback 路径）
    ...
```

方案第 11 节提到"移除当前重复 sleep"，但**没有说明具体移除哪一个**。建议明确：预热成功时不 sleep（因为预热 task 已经有自然等待时间），只在 fallback 同步刷新前 sleep。

---

### 🟡 S3：Antigravity 的 `_is_retryable_status` 不包含 500

`src/api/antigravity.py` L255-257 只重试 `429, 503`，不包含 `500`。而 GeminiCLI 包含 `429, 500, 503`。方案第 11 节说"GeminiCLI 与 Antigravity 共用容量保护"，但未提及这个差异是否需要统一。

建议方案明确声明此差异是否为预期行为。

---

### 🟡 S4：额度查询失败不更新凭证状态（方案已指出但未设计解决路径）

方案第 2.2 节指出"额度查询失败目前统一由面板接口转换为 HTTP 400，没有更新凭证健康状态"。

实际代码确认：`src/panel/creds.py` L1477-1486 在额度查询失败时直接返回 `400`，不调用 `record_failure` 或任何状态更新。

方案第 7 节定义了触发条件，第 8 节定义了状态机，但**没有明确说明额度查询失败时的状态写入时机在哪个代码路径**。建议在第 15.2 节增加：额度接口失败时必须调用 `apply_health_check_result`。

---

### 🟡 S5：消息测试中 429 = "凭证有效"的逻辑在方案中未被纳入改造范围

`src/panel/creds.py` L2018-2083 中，消息测试将 **任何** 429 都视为 `success=True`：

```python
if status_code == 200 or status_code == 429:
    return JSONResponse(status_code=status_code, content={"success": True, ...})
```

方案第 16 节提到前端提示要调整（不能继续显示"限流中但凭证有效"），但**没有将消息测试接口的后端逻辑纳入改造范围**。如果保护开关开启，消息测试返回 429 时应该触发与业务请求相同的分类逻辑。

建议在第 15 节增加 `POST /creds/test/{filename}` 的改造说明。

---

### 🟡 S6：`batch_refresh_cooldown` 批量额度检查没有全局限速

`src/panel/creds.py` L1552 的 `batch-refresh-cooldown` 接口可以一次性对多个凭证发起额度查询。方案第 7 节要求"新凭证上传后不自动查询额度，避免批量上传立即形成大量 Google 请求"，但**没有对现有的批量额度刷新接口施加限速**。

在保护开关开启时，此接口也应受第 9.3 节的全局并发限制（默认 2 并发，每秒最多 1 个）。

---

### 🟡 S7：池级熔断的统计窗口设计可能过于敏感

方案第 10.1 节定义池级熔断条件：

> 最近 10 秒至少 5 个样本，容量 429 比例达到 60%

在凭证池较小（如 5-10 个凭证）的场景下，10 秒内 5 个样本中 3 个是容量 429（60%）就会触发全池熔断。考虑到 `MODEL_CAPACITY_EXHAUSTED` 通常 2-3 秒恢复，这可能导致不必要的全池停摆。

建议：
- 将最小样本数提高到 10
- 或将比例阈值提高到 80%
- 或增加"连续 N 秒都满足条件才熔断"的持续性要求

---

### 🟡 S8：方案未定义 `health_policy_version` 的初始化和递增规则

方案第 13 节新增 `health_policy_version` 字段，第 5.3 节要求"异步任务需要携带策略版本号；配置版本变化后，旧任务结果全部作废"，但**没有定义**：

1. 版本号初始值是多少？（方案写 `0`，但 `0` 通常表示"未初始化"，可能与关闭状态混淆）
2. 什么操作会递增版本号？（开关切换？配置保存？手动复检？）
3. 版本号是全局的还是每个凭证独立的？
4. 多实例场景下版本号如何同步？

建议在第 5.3 节补充版本号的完整生命周期定义。

---

## 三、方案亮点（确认正确的设计决策）

| 设计决策 | 评价 |
|---------|------|
| 总开关默认关闭，关闭时完全兼容旧逻辑 | ✅ 正确。确认代码中没有其他"保护"逻辑会在开关关闭时生效 |
| 风控判断只以额度接口为准，不推断 | ✅ 正确。避免了误判风险 |
| 不在启动时扫描全部凭证 | ✅ 正确。避免启动雪崩 |
| 状态不确定时不判定风控 | ✅ 正确。宁可漏判也不误判 |
| 24h → 3d → 7d → 人工的复检阶梯 | ✅ 合理。平衡了恢复检测与请求负担 |
| 关闭开关不删除历史数据 | ✅ 正确。保留了审计能力 |
| 客户端响应不泄露凭证信息 | ✅ 正确。安全性考量充分 |
| 发布顺序：字段 → 展示 → 逻辑 → 开关 | ✅ 正确。渐进式部署降低风险 |

---

## 四、代码事实验证摘要

以下是方案中描述与实际代码的交叉验证：

| 方案描述 | 代码验证结果 |
|---------|------------|
| "后端默认最大重试次数为 5" | ✅ `config.py` L168-177 `default=5` |
| "前端缺省回填为 20 次、0.1 秒" | ⚠️ 未在本次审计中验证前端 JS，但与后端默认 5 次/1 秒严重不一致 |
| "凭证选择为随机方式" | ✅ `src/storage/sqlite_manager.py` L511 `ORDER BY RANDOM()` |
| "没有已失败凭证的排除参数" | ✅ `get_next_available_credential` 全部 4 个后端均无 `excluded` 参数 |
| "429 不是永久失效" | ✅ `_is_permanent_refresh_failure` 对 429 返回 `False` |
| "MODEL_CAPACITY_EXHAUSTED 没有额度重置时间时不设冷却" | ✅ `src/api/utils.py` L601-603 返回 `None` |
| "消息测试将任何 429 都视为凭证有效" | ✅ `src/panel/creds.py` L2018 `status_code == 200 or status_code == 429` |
| "额度查询失败统一转为 HTTP 400" | ✅ `src/panel/creds.py` L1478-1486 |
| "先创建预取任务再记录冷却" | ✅ `src/api/geminicli.py` L274-287 |
| "多实例缺少统一容量熔断" | ✅ 代码中无任何 circuit breaker 实现 |
| "Redis 用于 MySQL 缓存" | ✅ 只在 MySQL 后端中初始化 |

---

## 五、建议的修订优先级

```text
实施前必须解决（阻塞）:
  P0-1: 风控匹配与容量判断路径互斥定义
  P0-2: 四种存储后端字段对齐（前置步骤）
  P0-3: excluded_credentials 优先实施 + 竞态描述修正
  P0-4: 多实例协调方案按存储后端分场景重新设计

建议实施前改进（非阻塞）:
  S1: 统一默认重试配置
  S2: 明确双重 sleep 的移除方案
  S3: 声明 Antigravity 500 重试差异的设计意图
  S4: 额度查询失败的状态写入路径
  S5: 消息测试接口的 429 分类改造
  S6: 批量额度刷新接口的限速
  S7: 池级熔断阈值调优
  S8: health_policy_version 生命周期定义
```
