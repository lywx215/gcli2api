# gcli2api-manager 端 Codex 实施指南

状态：**Draft for Review**

方案修订：`manager-architecture-1.2`（2026-08-11）

用途：本文件是manager仓库实施和第三方Review的技术基线。

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
- manager Web端与桌面端是定位、任务、数据库和发布流程均独立的产品；本阶段不得引入
  桌面端数据模型、同步任务、页面或依赖。
- 开始跨仓库工作项时优先读取打开的`codex-ready`自动交接Issue；范围外内容只记录。
- 不得为了发现handoff建立定时Codex任务；只在当前实际任务中读取匹配工作项的Issue。

## 2. 技术基线

### 2.1 后端与数据库

- 后端：FastAPI、SQLAlchemy Async、Alembic、httpx；
- manager生产数据库：腾讯云TDSQL-C MySQL 8，独立逻辑库名固定为`gcli2api_manager`；
- 数据库连接分别通过`MANAGER_DB_HOST`、`MANAGER_DB_PORT`、`MANAGER_DB_NAME`、
  `MANAGER_DB_USER`、`MANAGER_DB_PASSWORD`和可选`MANAGER_DB_SSL_CA`注入，禁止把真实值
  写入仓库、日志、Fixture或交接文件；
- 只建立一个专用数据库账号，建议名为`u_gcli2api_manager`，供应用运行时、Alembic迁移
  和人工排障共用；该账号只拥有`gcli2api_manager.*`上的业务DML和迁移所需DDL权限，
  不得拥有全局权限、`GRANT OPTION`或桌面端数据库权限；
- 本地开发和CI：使用与生产主版本一致的MySQL，不以SQLite测试替代MySQL兼容验证；
- 实时任务：SSE；
- 密码哈希：Argon2id；
- 节点密钥：使用环境主密钥加密；
- 部署：Zeabur无状态manager服务连接腾讯云TDSQL-C；数据库不依赖manager容器Volume；
- 生产连接必须启用TLS，并把数据库网络访问限制到实际需要的来源；禁止为了省事长期向
  全网开放数据库端口。

所有数据库结构变更必须使用Alembic迁移，提交升级、降级或等价恢复步骤，并在空库及
上一正式版本数据库上验证。领域层通过Repository访问数据库，不允许路由或UI查询代码
直接依赖MySQL表结构。

由于本系统基本由一人使用，首版只提供一个Web管理员账号，不实现自助注册、RBAC、角色、
团队、租户或多用户管理。管理员用户名、Argon2id密码哈希和会话密钥分别通过
`MANAGER_ADMIN_USERNAME`、`MANAGER_ADMIN_PASSWORD_HASH`和`MANAGER_SESSION_SECRET`
注入；节点密钥加密主密钥使用`MANAGER_MASTER_KEY`。登录必须使用安全Cookie会话、CSRF
防护和登录限流。若以后确有多人协作需求，必须另立架构修订和迁移方案。

### 2.2 Web前端

- React、Vite、TypeScript；
- Ant Design和`@ant-design/pro-components`；
- TanStack Query管理服务端状态，React Router管理路由；
- Zod校验前端边界数据；
- 根据manager OpenAPI生成类型化API Client；
- ECharts仅用于确有价值的负载趋势或热力图，不作为页面装饰；
- Vitest负责单元测试，Playwright负责关键管理流程端到端测试；
- 包管理器统一使用pnpm。

只使用Ant Design及ProComponents的组件能力，自建轻量应用骨架；禁止直接复制完整
Ant Design Pro示例工程，避免引入Umi、演示页面、AI助手、国际化和无关业务模块。

### 2.3 产品隔离

- manager Web端与桌面端不共享任务、业务流程、数据库或数据库账号；
- manager不得连接、迁移或同步桌面端本地数据库；
- 桌面端不得直接连接manager MySQL；
- manager不共享桌面端的`servers`表，不建立持续单向或双向同步；节点信息由manager独立
  维护，首次可人工录入或执行经过审核的一次性导入；
- 两个产品不要求共享页面、路由或前端组件；
- 品牌标识或颜色如需复用，必须由后续独立设计决策确认。

### 2.4 manager数据边界

manager MySQL允许保存节点注册信息及加密后的管理凭证、探测与能力信息、凭证脱敏
元数据及负载快照、管理任务和审计记录，以及单个管理员账号和系统设置。

manager MySQL禁止保存完整凭证JSON、access token、refresh token、client secret、节点
明文密码或桌面端业务数据。gcli2api节点仍持有凭证真实数据和自己的本地SQLite状态。

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

- 建立FastAPI、MySQL、Alembic和React轻量应用骨架；
- 建立独立`gcli2api_manager`数据库、单一受限数据库账号、MySQL迁移、连接健康检查和
  备份恢复说明；
- 实现单管理员登录、会话、CSRF和登录限流，不建立注册和RBAC模型；
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

## 5. UI和交互要求

### 5.1 风格和主题基线

- 采用紧凑运维控制台，同时提供亮色、暗色和跟随系统三种外观选择；
- 外观选择由用户主动切换并持久化；首版可保存在浏览器本地，不按时间强制切换；
- 亮色配色和页面层次参考[Cockpit Tools](https://github.com/jlcodes99/cockpit-tools)截图：
  浅蓝灰背景、白色内容面、蓝色主操作、
  蓝青辅助色、绿色额度进度和轻量阴影；
- 暗色主题保持相同语义色映射和信息层次，不简单反转颜色；
- 蓝色作为主要操作色，蓝青色仅用于品牌辅助或选中强调；
- 绿色、橙色和红色仅用于成功或额度充足、警告和危险状态；
- 禁止大面积渐变、巨型统计卡片、过量彩色标签和无业务价值动画；
- 全局以13px至14px文字、6px至8px圆角和16px至20px页面间距为基线；
- 表格使用紧凑尺寸，目标行高44px至48px，固定右侧操作列；
- 亮暗两套Ant Design语义Token集中管理，禁止页面散落硬编码颜色或覆盖组件内部CSS。

建议起始色板：

| 语义 | 亮色 | 暗色 |
|---|---|---|
| 页面背景 | `#F1F5FB` | `#0F172A` |
| 侧栏背景 | `#EEF3FA` | `#111827` |
| 内容表面 | `#FFFFFF` | `#182231` |
| 主操作 | `#1677FF` | `#60A5FA` |
| 辅助强调 | `#0E9FBA` | `#22D3EE` |
| 成功/额度 | `#22C55E` | `#4ADE80` |
| 主文字 | `#172033` | `#EAF0F7` |
| 次文字 | `#667085` | `#9AA8BA` |
| 边框 | `#DCE4EE` | `#2E3A4A` |

该色板是根据参考截图抽象的项目Design Token起点，不表示复制Cockpit Tools源码、品牌
资源或业务布局。实现前仍需进行对比度和关键状态辨识测试。

推荐布局：

```text
左侧导航：总览 / 节点 / 凭证 / 任务 / 审计日志 / 设置
顶部区域：面包屑 / 全局搜索 / 刷新状态 / 当前用户
主要内容：少量关键指标 + 节点状态 + 高密度数据表格
右侧抽屉：凭证详情、设置和快捷操作
```

### 5.2 操作效率

- 两次点击内从节点列表进入单节点凭证管理；
- 支持GeminiCLI和Antigravity切换；
- 展示总数、正常、禁用、永久禁用和冷却摘要；
- 支持状态、错误、冷却、Preview、Tier、备注和邮箱筛选；
- 筛选条件优先保持单行，查询状态必须进入URL，刷新页面后可以恢复；
- 常用安全操作直接显示，次要操作进入“更多”；
- 批量操作只在选择凭证后出现，并显示选中数量；
- 查看额度、消息测试、Preview设置和操作记录优先使用右侧抽屉；
- 永久禁用和删除单独置于危险操作区，必须二次确认；
- 显示模型冷却剩余时间、数据更新时间和快照是否陈旧；
- 耗时任务显示进度、逐项结果和安全重试入口；
- 未知字段显示`—`，不得显示为0；
- 节点离线时展示最后快照并禁用写操作；
- 不支持的capability必须禁用或隐藏操作，并向用户说明原因。

### 5.3 前端代码约束

- `ProTable`负责节点、凭证、任务和审计等主要列表；
- 前端只能调用生成的manager API Client，不得直接调用gcli2api节点；
- 页面组件不得判断具体gcli2api版本，只能消费规范化字段和capability；
- API请求、缓存键、错误映射和失效策略集中管理；
- 页面按功能域拆分，禁止创建包含全部管理逻辑的单一超大组件；
- 首版只提供中文界面，不预置无实际需求的国际化框架。

## 6. 必测场景

- 20个混合版本节点同时接入；
- 单节点超时、401、404和501；
- Legacy字段缺失和未知字段；
- 写操作成功后立即重新读取真实状态；
- 批量任务部分成功、重试和幂等；
- Preview只有启用能力时不展示关闭；
- 额度任务不会泄漏Token；
- 节点离线不影响其他节点页面；
- MySQL、日志和浏览器响应不含完整凭证；
- MySQL迁移可在空库和上一版本数据库执行；
- 应用运行时和Alembic使用同一个受限数据库账号，`SHOW GRANTS`确认其无全局、跨库和
  `GRANT OPTION`权限；
- 仅单一管理员可以登录，系统不存在注册、角色、团队、租户或多用户管理入口；
- 前端在1280px管理页面和窄窗口下不遮挡关键操作；
- 表格筛选、分页、批量选择和URL状态恢复正确；
- 永久禁用和删除必须经过危险操作确认；
- 亮色、暗色、跟随系统和用户偏好持久化均正确；
- 工程中不存在桌面端任务或桌面端数据库同步代码；
- 未实现任何new-api读取或写入。

## 7. Codex交付格式

每个任务必须报告：

- 支持或变更的节点版本；
- 使用的适配器和Fixture；
- Management schema兼容结果；
- 数据库迁移；
- 前端技术栈或Design Token变化；
- 测试矩阵结果；
- 安全影响；
- UI能力变化；
- 灰度和回滚步骤。

如果gcli2api仍有后续动作，Codex必须同时生成
`coordination/handoffs/MGMT-*-M-*.json`，保持`execution_policy`为`queue_only`且自动运行
次数为0，由Actions自动投递；不得把人工复制交接块作为交付步骤。
