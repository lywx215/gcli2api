# gcli2api 端 Codex 实施指南

状态：**Draft for Review**

## 1. Codex任务目标

在不破坏现有面板、API、SQLite和Zeabur Volume的前提下，为独立manager提供稳定、
脱敏、可探测的Management API。

## 2. 开始任务前

Codex必须：

1. 阅读仓库根目录`AGENTS.md`；
2. 阅读协作规范、完整实施路线图和Management API契约；
3. 检查相关现有`/creds/*`实现及存储后端；
4. 检查工作树，保留用户现有修改；
5. 明确本任务对应的`MGMT-*`工作项和manager侧任务。
6. 如GitHub访问可用，检查打开的`codex-ready`自动交接Issue。

当前管理系统功能统一在`dev8`开发。`dev8`从MGMT-008完成后的
`origin/dev7@96736b1ea7e222c1a6a5f8e83ab95e0d4e1e3462`创建。`master`只承载经Review的
发布内容和自动交接所需控制面文件；未经单独Review和明确授权不得把`dev8`业务提交合入
旧集成分支或`master`。

不得为了发现handoff建立定时Codex任务。只有当前实际任务需要时才读取Issue，并只处理
匹配工作项编号的`next_actions`。

`IMPLEMENTATION_ROADMAP.md`已经预先定义MGMT-001至MGMT-010。gcli2api只在对应工作项
明确进入本仓库阶段时实施，不得因为manager开始同编号任务就提前声明未完成capability。

## 3. 实现原则

- 新路由放在独立management模块，不在manager中复刻业务规则。
- 复用`credential_manager`和`storage_adapter`，不得绕过它们直接操作SQLite。
- Management API只负责规范化输出和动作编排。
- `/creds/*`继续保持原行为，Legacy manager仍可能依赖这些接口。
- 所有字段由真实数据产生；无法得到时返回`null`。
- capability必须与真实实现一致，不能提前声明未完成能力。
- Preview当前只有启用/配置语义，不得伪造关闭能力。
- 额度调用可能刷新Token和同步冷却，响应必须披露副作用。
- 本阶段运行时数据源限定为节点本地SQLite；不得为Management API引入MySQL或中央数据库
  依赖，也不得跨节点访问数据。
- `NODE_MANAGEMENT_TOKEN`存在时始终优先且页面只读；环境变量不存在时允许使用控制面板
  通过storage/config抽象保存的启用状态和Token摘要。两种来源都不得回退到面板密码，
  没有有效Token时整个Management API必须默认关闭。

## 4. 推荐实施阶段

### G1：契约和骨架（MGMT-004）

- 添加management router、schema和认证依赖；
- 实现`/capabilities`；
- 保留`NODE_MANAGEMENT_TOKEN`兼容来源并实现页面持久化来源、环境优先和安全状态接口；
- 为缺少Token返回503、错误Token返回401和能力响应编写测试。

### G2：只读接口（MGMT-004）

- 实现`/summary`、`/credentials`、`/stats`；
- 统一GeminiCLI和Antigravity字段；
- 将SQLite中的Unix timestamp统一转换为UTC ISO 8601字符串；
- 实现带`credentials`和`page`的分页响应外壳；
- 确认响应中无敏感字段；
- 对本地SQLite运行回归，不增加外部数据库依赖。

### G3：写动作（MGMT-005）

- 实现启用、禁用、永久禁用、备注及信用额度动作；
- 实现逐项结果明确的批量动作端点；
- 实现幂等键和同凭证写串行化；
- 删除动作增加明确的审计字段和无变化语义。

### G4：外部副作用动作（MGMT-006）

- 实现Preview、额度、测试、风险和冷却同步；
- 限制并发；
- 返回结构化副作用；
- 模拟Google失败、超时、429和Token刷新。

### G5：发布（MGMT-009至MGMT-010）

- 先完成全局Management中间件移除、真实存储分页及大凭证量性能门禁；
- 在桌面和移动设置页实现Management API启停、至少256位Token单次生成、复制、轮换、
  撤销、指纹和创建时间；
- 更新OpenAPI、版本说明和支持矩阵；
- 在CI中从FastAPI自动导出OpenAPI并与提交的schema基线比较；
- 发布RC镜像；
- 触发manager兼容矩阵；
- 通过后发布SemVer正式镜像。

## 5. 必测场景

- 两种mode的凭证列表和筛选；
- 启用、禁用、永久禁用和重复执行；
- 不存在凭证和非法文件名；
- Preview支持与不支持；
- 额度成功、额度为0、Google失败和Token刷新；
- 不同存储后端字段缺失；
- 响应敏感字段扫描；
- Legacy路由未回归；
- 并发冲突和幂等重试。
- 批量任务部分成功、逐项错误和安全重试。

## 6. Codex交付格式

完成任务时必须报告：

- 修改的Management schema版本；
- 新增或变更的capability；
- Legacy兼容结果；
- 运行的测试和结果；
- 使用的候选镜像标签；
- manager侧需要完成的对应任务；
- 已知限制和回滚方式。

如果manager仍有后续动作，Codex必须同时生成`coordination/handoffs/MGMT-*-G-*.json`，
保持`execution_policy`为`queue_only`且自动运行次数为0，由Actions自动投递；不得把
“请用户复制到manager任务”作为交付步骤。
