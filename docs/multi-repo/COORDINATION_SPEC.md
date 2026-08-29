# gcli2api 与 gcli2api-manager 协作与交付规范

状态：**Draft for Review**

规范版本：`coordination-1.3`

## 1. 目标和边界

两个仓库独立构建、发布和部署，通过稳定HTTP管理协议协同：

```text
gcli2api-manager（Zeabur）
      ├── 腾讯云TDSQL-C MySQL 8（manager独立逻辑库）
      │
      └── HTTPS Management API / Legacy Panel API
                 ▼
          gcli2api节点（每台保留独立SQLite和凭证）
```

桌面端App是定位、任务、数据库和发布流程均独立的产品，不在本协作方案内，也不是
manager的客户端或数据源。未来若需协同，必须另立方案，不得在本阶段预埋桌面端同步。

本方案当前覆盖节点、凭证、负载、任务、审计和版本兼容。new-api只保留未来所需的
只读容量接口，不在本阶段读取或修改new-api。

明确禁止：

- Git Submodule或把一个仓库源码复制进另一个仓库运行；
- manager直接连接节点SQLite、Volume或文件系统；
- manager连接、迁移或同步桌面端本地数据库；
- 桌面端直接连接manager MySQL；
- 在中央数据库保存完整凭证；
- 节点间迁移、复制或自动重分配凭证；
- 用`latest`作为生产节点的唯一版本依据；
- 根据版本字符串猜测能力而不做能力探测。

## 2. 仓库职责

### gcli2api

- 持有凭证真实数据和最终状态；
- 实现启用、禁用、永久禁用、删除、Preview、额度和检测；
- 发布Management API、OpenAPI契约和capability；
- 保持Legacy Panel API兼容；
- 保证操作幂等、输入校验、脱敏和明确错误码；
- 发布固定SemVer及revision标识的Docker镜像。

### gcli2api-manager

- 注册和探测多个节点；
- 使用腾讯云TDSQL-C MySQL 8中的独立逻辑库`gcli2api_manager`保存manager自身元数据，
  通过Alembic管理迁移；
- 只使用一个专用数据库账号供运行时、迁移和人工排障共用，权限仅限manager数据库；
- 只提供一个Web管理员，不实现注册、RBAC、角色、团队、租户或多用户管理；
- 加密保存节点管理凭证；
- 通过适配器兼容Modern和Legacy节点；
- 聚合凭证元数据和负载指标；
- 提供单节点及全局管理界面；
- 编排批量任务、失败重试和审计；
- 不持有凭证内容，不改变节点业务语义。

manager应用服务保持无状态，生产持久化不得依赖应用容器本地文件或Volume。MySQL只保存
manager允许的数据，不能改变gcli2api节点对凭证真实状态和管理动作语义的最终所有权。
manager不共享桌面端数据库、数据库账号或`servers`表，也不建立持续单向或双向同步；
节点信息由manager独立维护，首次可人工录入或执行经过审核的一次性导入。

manager Web前端采用React、Vite、TypeScript、Ant Design和ProComponents的轻量应用
骨架，使用紧凑运维控制台风格，提供亮色、暗色和跟随系统三种外观选择并保存用户偏好。
颜色与层次可参考Cockpit Tools，但不得直接复制完整Ant Design Pro示例工程、Cockpit
Tools业务模块、品牌资源或未明确授权的源码，也不得引入桌面端业务模块。

## 3. 版本模型

三个版本号相互独立：

| 对象 | 示例 | 用途 |
|---|---|---|
| gcli2api应用 | `v1.3.0` | 节点发布版本 |
| manager应用 | `v0.5.0` | 管理系统发布版本 |
| Management schema | `1.1` | HTTP协议兼容判断 |

规则：

- 应用使用SemVer；revision保留完整Git SHA。
- `management/v1`只允许增加可选字段和capability。
- 删除字段、改变类型、修改既有动作语义必须新增`management/v2`。
- 生产Zeabur服务固定到明确镜像标签，升级由灰度流程推进。

## 4. 节点兼容等级

| 等级 | 识别方式 | 行为 |
|---|---|---|
| Modern V1 | `/management/v1/capabilities`成功 | 完整管理 |
| Legacy Current | 现有`/creds/*`和统计接口可用 | 适配后管理 |
| Legacy Minimal | 仅部分安全接口可用 | 有限或只读管理 |
| Unknown | 无法可靠识别 | 只显示故障，不执行写操作 |

manager先按接口探测，再按响应结构选择适配器。`/version/info`仅用于展示、审计和
Fixture匹配，不是能力判断的唯一依据。

每个节点能力独立保存。UI必须根据能力决定是否展示操作，不得为缺失能力构造请求。

## 5. 跨仓库工作项流程

跨仓库工作项使用统一编号，例如`MGMT-012`。

`IMPLEMENTATION_ROADMAP.md`是`MGMT-*`目标、依赖、范围、排除项、门禁和验收的权威
来源。GitHub Issue只跟踪状态和证据，PR只交付已定义范围，handoff只投递已审核的对端
动作。仅创建分支、Issue标题或handoff不得替代完整工作项定义。

开始编码前必须满足路线图中的Definition of Ready：工作项已定义、依赖已完成、输入和
测试条件已具备、目标仓库与分支基线明确、回滚方式可执行。任何一项不满足时只能标记
`planned`或`blocked`，不得边实现边决定总体方案。

标准顺序：

1. **协议提案**：先提交路径、schema、capability、副作用和错误码。
2. **manager容忍性实现**：能解析新字段；节点无该能力时正常降级。
3. **gcli2api实现**：实现服务端能力并保持Legacy回归。
4. **候选镜像**：发布`vX.Y.Z-rc.N`或PR SHA镜像。
5. **兼容矩阵测试**：manager对Legacy、当前稳定版和候选版运行真实HTTP测试。
6. **manager先发布**：上线同时支持旧版和新版的manager。
7. **节点灰度**：2台、观察24小时、5台、再推广剩余节点。

两个PR必须互相链接并列出：

- schema版本变化；
- capability变化；
- Legacy影响；
- 新副作用；
- 安全影响；
- 测试镜像和兼容矩阵结果。

### 自动交接

禁止依赖用户把交付说明人工复制到另一个Codex任务。跨仓库工作项完成后，Codex必须在
`coordination/handoffs/`生成符合`handoff.schema.json`的新JSON。提交后由GitHub Actions
通过`repository_dispatch`发送到对端，并在目标仓库创建或更新带状态标签的Issue。

- `ready`创建或保持打开的`codex-ready` Issue；
- `blocked`创建或保持打开的`codex-blocked` Issue；
- `no_counterpart_action`仅创建审计记录并自动关闭；
- 相同`delivery_id`必须幂等更新，不能创建重复任务；
- 范围外发现只记录，不得写进可执行`next_actions`；
- 自动交接不得携带Token、密码、真实凭证或完整响应。
- handoff的`execution_policy`必须固定为`queue_only`且`max_automatic_runs`为`0`；Actions
  只负责校验、投递和创建Issue，不得调用Codex或其他模型。
- 禁止为交接建立分钟级、定时或常驻Codex轮询；Codex只在用户启动实际任务时读取
  `codex-ready` Issue，因此无交接任务时不消耗模型Token。
- 跨仓库认证优先使用组织或仓库安装的GitHub App短期令牌；个人PAT仅作为可轮换的
  兼容回退，不得写入仓库。
- 投递失败必须在来源仓库创建或更新`handoff-delivery-failed` Issue，并链接失败的
  Actions运行；失败记录本身不得触发模型调用。

未来如需事件触发Codex执行，必须通过单独的schema版本和安全Review启用，不得静默修改
现有handoff语义。至少要求：独立OpenAI Platform项目和API key、每个`delivery_id`最多
执行一次、重试需人工批准、只提交分支或PR、禁止自动合并和部署，并设置预算与告警。

具体格式、安全配置和失败恢复遵守`AUTOMATED_HANDOFF.md`。

## 6. Git和发布策略

当前分支基线：

- gcli2api当前管理系统功能统一在`dev8`开发；`dev8`以MGMT-008完成后的
  `origin/dev7@96736b1ea7e222c1a6a5f8e83ab95e0d4e1e3462`为固定创建基线。功能只进入
  `dev8`或其短分支；未经单独Review和明确授权不得自动合并回旧集成分支或`master`。
- gcli2api-manager以`main`作为开发基线。
- 两仓库使用短生命周期`codex/*`、`feat/*`、`fix/*`和必要的`release/*`分支，禁止长期
  分叉的协议开发分支。

gcli2api的GitHub默认分支当前仍为`master`。`repository_dispatch`接收workflow必须存在于
默认分支，因此自动交接首次启用时，应将纯控制面文件（接收workflow、schema和协作约束）
同步到`master`；不得为了启用交接把`dev8`中的业务提交提前合入`master`。

gcli2api发布物必须包含：

- SemVer Docker镜像；
- revision标签；
- 已审核OpenAPI契约；
- capability清单；
- 兼容性和副作用说明。

manager发布物必须包含：

- 支持矩阵；
- 新增或移除的适配器；
- 已验证的gcli2api标签或revision；
- 数据库迁移和回滚说明；
- MySQL备份恢复验证和连接配置变更；
- 前端Design Token或关键交互规范变化；
- 对未知节点的降级行为。

## 7. CI协同

### gcli2api CI必须执行

- 原有pytest；
- Management API契约测试；
- 从FastAPI自动导出OpenAPI，并与仓库内已审核schema基线做破坏性变更校验；
- 校验OpenAPI中的路径、错误响应和schema与`MANAGEMENT_API_CONTRACT.md`一致；
- Legacy `/creds/*`回归；
- 敏感字段泄漏检查；
- amd64/arm64镜像构建。

### manager CI必须执行

- MySQL空库迁移、上一版本升级及回滚或等价恢复验证；
- 使用运行时与Alembic共用的数据库账号执行`SHOW GRANTS`，确认仅有
  `gcli2api_manager.*`权限且没有全局权限、`GRANT OPTION`或桌面端数据库权限；
- 单管理员登录、Argon2id密码哈希、安全Cookie会话、CSRF和登录限流测试，并确认不存在
  注册、RBAC、角色、团队、租户或多用户管理入口；
- 各适配器单元测试；
- 所有现网版本的脱敏Fixture测试；
- 至少四类Docker矩阵：最老现网版、代表Legacy版、最新稳定版、候选版；
- 401、404、501、超时、部分字段和未知字段测试；
- 批量任务幂等、重试和部分失败测试；
- 前端能力门控、紧凑表格关键交互和敏感信息测试；
- 验证亮色、暗色、跟随系统和用户偏好持久化均正常，且不包含桌面端任务或数据库同步代码。

### 自动交接CI必须执行

- handoff JSON schema和文件名校验；
- 来源仓库、目标仓库及工作项编号校验；
- 敏感字段和常见密钥字面量扫描；
- 重复`delivery_id`幂等测试；
- `no_counterpart_action`只记录不实施的行为测试。
- `execution_policy`固定值测试，证明交接工作流不会调用模型；
- GitHub App令牌、PAT回退和投递失败Issue的恢复测试。

gcli2api发布候选镜像后，通过`repository_dispatch`触发manager兼容测试。只有兼容
测试通过的版本才能加入manager的“验证支持矩阵”。

## 8. Fixture与测试数据

每个现网版本收集脱敏响应，存放在manager仓库：

```text
tests/fixtures/gcli/<version-or-revision>/
├── version.json
├── credential-status.json
├── stats.json
├── quota-success.json
└── errors.json
```

Fixture不得包含真实邮箱、文件名、project ID、Token或管理密码。邮箱和文件名使用固定
伪数据，时间戳使用可重复的测试值。

## 9. 兼容支持政策

- 完整支持所有`management/v1`节点；
- 验证支持当前20台现网节点的明确标签或revision；
- 常规维护最近3个正式gcli2api版本；
- 未在矩阵内的旧版默认只读，确认写操作响应后才能升级支持等级；
- 废弃能力至少跨两个manager次版本并完成全部节点盘点后才能删除。

## 10. 安全边界

- 新版节点使用与普通API密码、面板密码分离的Management Token。`NODE_MANAGEMENT_TOKEN`
  保留为优先级最高的部署环境来源；环境变量不存在时可使用节点控制面板生成并通过现有
  storage/config抽象持久化的摘要状态，明文只允许在生成或轮换成功的单次响应中出现；
- manager中的节点Token必须加密保存；
- manager生产数据库只使用一个专用MySQL账号供运行时、Alembic和人工排障共用；该账号
  只能访问`gcli2api_manager.*`，不得拥有全局权限、`GRANT OPTION`或桌面端数据库权限；
- manager只提供一个Web管理员，使用Argon2id密码哈希、安全Cookie会话、CSRF和登录
  限流；首版不引入注册和RBAC；
- 数据库备份与应用密钥分离；
- Zeabur到腾讯云数据库的生产连接默认必须启用TLS并限制网络来源，不得长期向全网开放
  端口；若已选腾讯云Serverless实例的控制面明确不支持SSL，可在MGMT-008记录供应商限制
  和剩余风险后显式使用`MANAGER_DB_TLS_MODE=disabled`，但必须把数据库入口限制到固定的
  Zeabur出口来源。该例外不得自动扩展到其他数据库或取消最小权限、强密码与备份门禁；
- 禁止把Authorization头、Token和完整凭证写入日志；
- 管理接口只返回元数据；
- 对节点请求禁止跨域名携带认证重定向；
- 删除和永久禁用必须二次确认并审计；
- 主动额度、风险和测试不得作为高频自动轮询任务。

## 11. 完成定义

跨仓库功能只有同时满足下列条件才算完成：

- 契约、实现和文档一致；
- manager在无新能力的旧节点上正常降级；
- gcli2api Legacy接口测试通过；
- Docker兼容矩阵通过；
- 安全Review无未解决P0/P1；
- `SHOW GRANTS`和单管理员认证验收通过；
- 灰度、监控和回滚步骤明确；
- 两个仓库的变更说明互相引用。
- 两仓库中的`COORDINATION_SPEC.md`和`MANAGEMENT_API_CONTRACT.md` SHA-256一致。
- 两仓库中的`IMPLEMENTATION_ROADMAP.md` SHA-256一致，当前工作项未偏离其范围和门禁。
- 对端仍有动作时已生成并成功投递自动handoff；禁止把人工复制作为完成步骤。
