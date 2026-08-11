# gcli2api-manager 端 Codex 实施指南

状态：**Draft for Review**

用途：manager仓库创建后，将本文件约束整理为该仓库根目录`AGENTS.md`。

## 1. Codex仓库约束

- manager只能通过HTTPS API访问gcli2api，不得读取节点SQLite、Volume或源码。
- manager不得保存、展示或记录完整凭证、Token和节点明文密码。
- 所有节点操作必须经过适配器，不得在UI或业务服务中直接拼接Legacy端点。
- 能力判断优先使用`/management/v1/capabilities`；Legacy按安全探测降级。
- 未知版本默认只读；没有capability的按钮必须禁用。
- 缺失字段必须保留未知语义，禁止填0制造假数据。
- 凭证不上传、不迁移、不复制，重复邮箱只提示。
- new-api本期不接入；只保留节点健康和容量的只读导出接口。
- 外部额度、测试和风险检查只能由管理员主动触发，并限制并发。
- 所有写操作必须有幂等键、逐项结果和审计记录。
- 开始跨仓库工作项时优先读取打开的`codex-ready`自动交接Issue；范围外内容只记录。
- 不得为了发现handoff建立定时Codex任务；只在当前实际任务中读取匹配工作项的Issue。

## 2. 推荐技术栈

- 后端：FastAPI、SQLAlchemy Async、SQLite、Alembic、httpx；
- 前端：Vue 3、Element Plus、ECharts；
- 实时任务：SSE；
- 密码哈希：Argon2id；
- 节点密钥：使用环境主密钥加密；
- 部署：单实例Zeabur服务，`/app/data`挂载Volume。

## 3. 适配器接口

所有节点访问实现统一接口：

```text
probe
capabilities
get_summary
list_credentials
get_stats
execute_action
get_quota
get_errors
test_credential
```

适配器：

- `ModernV1Adapter`
- `LegacyCurrentAdapter`
- `LegacyMinimalAdapter`
- `UnknownAdapter`

选择适配器后保存探测证据、版本、schema和能力。探测失败不得自动尝试危险写操作。

探测流程必须遵守以下顺序：

```text
GET /management/v1/capabilities（使用独立管理Token）
├─ 2xx且schema可识别 -> ModernV1Adapter
├─ 401/403 -> 标记认证失败；禁止降级，等待管理员修正Token
├─ 503 MANAGEMENT_API_DISABLED -> 标记管理API关闭；仅在管理员显式允许Legacy且
│  已单独配置Legacy凭证时继续安全只读探测
├─ 404/405/501且管理员允许Legacy -> 只调用已知无副作用的Legacy GET接口探测
├─ 超时/网络失败 -> 标记离线；禁止通过其他写接口猜测版本
└─ 响应结构未知 -> UnknownAdapter，只读
```

401/403通常说明Modern接口存在但凭证错误，绝不能把它当成旧版本自动回退。适配器决定
必须记录HTTP状态、响应结构指纹和探测时间，但不得记录Authorization头或响应中的敏感值。

## 4. 推荐实施阶段

### M1：节点注册和Legacy盘点

- 实现节点、密钥、能力和探测数据模型；
- 接入2个Legacy测试节点；
- 收集并脱敏20台节点Fixture；
- 建立现网版本支持矩阵。

### M2：Legacy只读聚合

- 实现摘要、凭证列表和统计规范化；
- 实现健康状态机和陈旧数据标记；
- 完成总览、节点和凭证页面。

### M3：凭证写操作

- 实现启停、永久禁用、删除和备注；
- 实现二次确认、幂等、任务和审计；
- 单节点页面禁止误操作其他节点。

### M4：额度和检测

- 实现Preview、额度、错误、测试、风险和冷却同步；
- 按能力展示；
- 单节点外部调用并发不超过3；
- 额度摘要缓存10分钟。

### M5：Modern V1和兼容矩阵

- 接入已审核OpenAPI；
- 实现Modern适配器；
- 对Legacy、稳定版和RC镜像运行Docker矩阵；
- 未识别节点保持只读。

### M6：负载分析

- 计算RPM、可用凭证、冷却率、失败率和单凭证请求密度；
- 展示节点×模型族热力图；
- 只生成流量调整建议，不执行new-api操作。

## 5. UI要求

- 两次点击内从节点列表进入单节点凭证管理；
- 支持GeminiCLI和Antigravity切换；
- 提供总数、正常、禁用、永久禁用和冷却摘要；
- 提供状态、错误、冷却、Preview、Tier、备注和邮箱筛选；
- 显示模型冷却剩余时间；
- 耗时任务显示进度和逐项结果；
- 未知字段显示`—`；
- 节点离线时展示最后快照并禁用写操作。

## 6. 必测场景

- 20个混合版本节点同时接入；
- 单节点超时、401、404和501；
- Legacy字段缺失和未知字段；
- 写操作成功后立即重新读取真实状态；
- 批量任务部分成功、重试和幂等；
- Preview只有启用能力时不展示关闭；
- 额度任务不会泄漏Token；
- 节点离线不影响其他节点页面；
- SQLite和日志不含完整凭证；
- 未实现任何new-api读取或写入。

## 7. Codex交付格式

每个任务必须报告：

- 支持或变更的节点版本；
- 使用的适配器和Fixture；
- Management schema兼容结果；
- 数据库迁移；
- 测试矩阵结果；
- 安全影响；
- UI能力变化；
- 灰度和回滚步骤。

如果gcli2api仍有后续动作，Codex必须同时生成
`coordination/handoffs/MGMT-*-M-*.json`，保持`execution_policy`为`queue_only`且自动运行
次数为0，由Actions自动投递；不得把人工复制交接块作为交付步骤。
