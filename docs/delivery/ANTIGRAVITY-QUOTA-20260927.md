# Antigravity 优化交付记录（2026-09-27）

基线：`dev0927`，`4232efcd8046d0c78c0f60602b078607345886ff`。实现位于当前 worktree，未提交或推送 Git，未部署。范围为额度保护、被动诊断、响应完整性及必要共享基础设施。

## 实现与验收对应

| 要求 | 实现位置 | 验证依据 |
| --- | --- | --- |
| 两组独立共享冷却、历史键聚合、组内最长、周期不重复结算 | `src/storage/_stats_common.py`、`src/antigravity_quota.py` | shared_cooldowns、cycle_settlement、quota_policy 测试 |
| 168 小时持久拦截、首次观察不滑动、解除与新业务 429 重拦 | `src/storage/antigravity_quota.py` | 临时 SQLite 重启及三种远端驱动替身测试 |
| 权威最终准入、预取后阻断、坏候选与存储失败 | 同上、`src/credential_manager.py`、`src/api/antigravity.py` | quota_policy、quota_backends、completion_policy 测试 |
| UUID 代次、revision、旧查询/请求/刷新/禁用隔离 | `src/storage/antigravity_quota.py`、`src/credential_manager.py` | 删除重建、旧请求晚到、并发组更新测试 |
| 三同步入口统一、缺失/非法值保留未知 | `src/panel/creds.py`、`src/management/active_operations.py` | quota_boundaries 三入口参数化测试、fallback/cooldown 回归 |
| 面板单组解除认证、测试准入、组期限显示 | `src/panel/creds.py`、`front/common.js` | ASGI 401/成功解除且保留期限；受阻测试禁止上游调用；前端静态及语法检查 |
| 被动 429 诊断、脱敏、合法时间白名单、SMART 兼容 | `src/diagnostics/antigravity.py`、`src/smart_429.py`、API 客户端 | 非法/混合/缺失证据测试、原 SMART 回归、真实本地 HTTP 诊断契约测试 |
| 原始多候选 SSE 与 JSON 完整性 | `src/antigravity_completion.py`、`src/api/utils.py` | 工具/媒体/block/MAX_TOKENS/思考-only/空流/半截 JSON/终态后错误测试 |
| 最终验证后唯一结算、取消不成功、保留 usage | API 客户端及配额存储 | 并发重复结算、客户端断连、三协议/各模式、OpenAI reasoning 用量、逻辑请求统计测试 |
| 迁移与兼容 | 四后端、`scripts/migrate_antigravity_quota_sqlite.py`、`docs/migrations/*` | SQLite 旧表检查/应用/重复执行/凭证原文保持；管理 API/OpenAPI/Legacy 回归 |

## 回归记录

使用 Python 3.12.10 和隔离测试虚拟环境，通过 `scripts/run_diagnostic_tests.py` 清空远端数据库、Redis、代理配置，并使用临时凭证和日志目录。没有真实模型调用。HTTP 测试只访问本机回环假上游。

审核前完整回归：**1507 passed，1 skipped，6 warnings，148.42 秒**（2026-09-27）。唯一跳过项为 Windows 不支持的 POSIX fork；spawn、进程重启及多进程本地 HTTP 用例已运行。警告为现有 Pydantic/Starlette 弃用提示。

本机完整输出：`C:/Users/lywx2/AppData/Local/Temp/antigravity-delivery-regression.txt`。

补充检查：`python -m compileall -q src scripts/migrate_antigravity_quota_sqlite.py`、`node --check front/common.js`、`git diff --check` 通过。

初轮回归发现并修复：停止在首块记成功后，旧测试需要完整终态及真实准入接口；暂存正文和终态同帧会延迟输出，已拆分为即时正文和待验证终态；尾部 usage 会在 OpenAI 终态转换中丢失，已将最终 usage 传递到终态帧。既有用例只按这些明确行为变化调整，没有删除保护性断言。

## 尚未执行的发布验证

- PostgreSQL、MySQL、MongoDB 使用驱动替身测试了实际公共事务/CAS代码，未连接真实数据库；真实远端迁移、版本组合和故障恢复演练未执行，不标记通过。
- 面板完成 JS 语法、静态断言及认证/动作接口测试；未使用用户线上面板做人工浏览器验收。
- 本轮没有真实额度查询、模型可用性测试、生产迁移、生产部署或凭证修改。
- 已有三轮 Claude 结论属于输入方案，本次后续已另获用户授权并执行代码审核；当前逐轮状态见 `review/ANTIGRAVITY_QUOTA_CODE_REVIEW.md`。

## 兼容与操作

管理 schema 保持 1.4，新增 capability `antigravity.quota.protection`。已有管理动作及结果白名单不改变；中央管理对端状态为 `no_counterpart_action`，不恢复已停止的 MGMT 工作。Gemini CLI 分支保留旧语义，控制面板版本号未修改。

历史 Gemini 具体冷却键现在会影响同凭证全部 Gemini；部分正额度快照不能提前清整组。不完整 HTTP 200 现在返回格式错误。单模型显式清除计时冷却影响所属整组，解除异常状态则不清计时冷却。

上线前先备份，在隔离副本执行迁移与启动演练。回滚前暂停相关凭证调度/模型入口，保留新增字段与拦截记录；不能直接让不识别新状态的旧版本继续处理这些凭证。

完整诊断、接口示例及迁移说明：[`ANTIGRAVITY_QUOTA_PROTECTION.md`](../ANTIGRAVITY_QUOTA_PROTECTION.md)。

## 后续授权代码审核

实际 `claude-opus-5-5` 在用户两次授权下完成两组、共六轮代码审核，分别返回 8、4、2、2、1、0 项发现。确认的问题已修复；第 3 轮关于“仅思考 + 失败终态应保留”的建议，按用户明确决定不采纳，继续返回 BAD_FORMAT，并作为后续审核的明确需求。

第二组补齐项目校验和邮箱查询控制入口的凭证内容版本保护，相关套餐/邮箱/启用状态与凭证共享条件事务；额度字段损坏时控制调用继续工作，但损坏原文不变、模型准入仍被拦截。

最终完整回归：**1554 passed、1 skipped、6 warnings，151.41 秒**；针对 Claude 发现的复现回归累计 47 项。Python 编译、前端 JS 语法、diff 空白检查通过。完整输出：`C:/Users/lywx2/AppData/Local/Temp/antigravity-claude-round5-full-rerun.txt`。此前一次完整运行提前退出且没有失败堆栈；对应 4 项 HTTP 用例单独复跑通过，未改代码的全量重跑通过，首次退出原因未确认，日志已保留。

**Claude 代码审核通过**：累计第 6 轮返回 `findings=[]`，快照 `a06c29d37b76169be2baab04b78894a9ace6b4e8a9c9fe0b91d357d160e2f049`。审核后核验快照一致，仅补记审核及交付结果，未修改实现代码。逐项证据见 [`ANTIGRAVITY_QUOTA_CODE_REVIEW.md`](../../review/ANTIGRAVITY_QUOTA_CODE_REVIEW.md)。代码审核通过不代表已执行生产发布验证。
