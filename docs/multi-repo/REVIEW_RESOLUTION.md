# 第三方 Review 意见处理记录

状态：**Resolved；架构方案1.2等待独立复审**

处理日期：2026-08-10

输入：[第三方 Review 原文](./MULTI_REPO_SPEC_REVIEW.md)

本记录只表示文档层面的P0/P1问题已处理，不表示代码已经实现，也不授权生产写操作。

## 后续架构决策（2026-08-11）

用户在第一轮Review完成后确认以下新决策：

- gcli2api节点继续保留自己的本地SQLite和凭证真实数据；
- 独立的gcli2api-manager生产数据库使用腾讯云TDSQL-C MySQL 8；
- manager Web前端改用React、Vite、TypeScript、Ant Design和ProComponents；
- 界面采用紧凑运维控制台，用户可选择亮色、暗色或跟随系统；
- 配色与页面层次参考Cockpit Tools截图，不复制其源码、品牌资源或业务模块；
- 桌面端App定位和任务不同，与manager的数据库、页面及发布完全独立；
- manager使用独立逻辑库`gcli2api_manager`，不共享桌面端数据库、账号或`servers`表，
  也不建立持续同步；
- manager只建立一个受限MySQL账号，供运行时、Alembic迁移和人工排障共用；
- 首版只提供一个Web管理员账号，不实现注册、RBAC、角色、团队、租户或多用户管理。
- 使用`implementation-roadmap-1.0`一次性定义MGMT-001至MGMT-010，GitHub Issue只跟踪
  状态和证据，不再临时决定下一任务范围；
- new-api在MGMT-010完成后使用独立`NAPI-*`路线规划，桌面端继续使用独立产品路线。

这些内容不改变第一轮Review对gcli2api节点存储后端的事实判断，但取代了旧版manager
指南中的“manager使用SQLite和Vue 3”技术基线。单账号和单管理员是架构1.2的简化决策，
需纳入下一次独立复审。

## 处理结果

| Review ID | 结果 | 文档落点 |
|---|---|---|
| P1-1 批量动作API | 已解决 | 契约第8节定义请求上限、双层幂等键、逐项结果和部分成功语义 |
| P1-2 列表分页外壳 | 已解决 | 契约第5节定义`credentials`及`page`，并说明cursor/offset约束 |
| P1-3 时间格式 | 已解决 | 契约第1节统一为UTC ISO 8601，未知值使用`null` |
| P1-4 Token缺失行为 | 已解决 | 契约第1节规定默认关闭并返回503，禁止空Token及密码回退 |
| P1-5 HTTP状态映射 | 已解决 | 契约第1节增加错误码、HTTP状态及默认retryable表 |
| P2-1 Credit capability | 已解决 | 增加`credential.credit.enable`和`credential.credit.disable` |
| P2-2 动作参数 | 已解决 | 契约第7节增加逐动作`parameters`规则和未知参数错误语义 |
| P2-3 gcli2api MySQL实例隔离 | 对节点当前范围仍不适用 | 节点仍使用本地SQLite；manager自身MySQL是独立数据库，不读取或替代节点存储 |
| P2-4 适配器探测 | 已解决并收紧 | 两端manager指南增加决策流程；401/403禁止降级，Legacy需显式允许 |
| P3-1 OpenAPI导出 | 已采纳 | 协作规范CI及gcli2api发布阶段要求自动导出和破坏性变更校验 |

## 复审重点

第三方复审应重点确认：

1. 批量端点的单项错误不会导致成功项被自动重放；
2. Token未配置时不存在空认证、面板密码回退或数据暴露；
3. manager不会在401/403后尝试Legacy写接口；
4. 两仓库的权威契约和协调规范SHA-256一致；
5. manager MySQL与节点SQLite及桌面端数据库是否严格隔离，且迁移、备份和恢复方案完整；
6. 单一数据库账号是否仅拥有manager库权限，同时满足运行时和迁移需要；
7. 单一Web管理员、会话安全和登录限流是否完整，且未引入无需求的RBAC；
8. React紧凑界面的亮暗主题、能力门控、操作效率和危险操作隔离是否符合要求；
9. 桌面端和new-api是否仍保持在本阶段之外。
10. MGMT-001至MGMT-010的依赖、门禁、范围、验收和跨仓顺序是否完整且可追溯。

## 当前结论

文档可进入独立复审。只有复审确认无未解决P0/P1、代码实现完成、兼容矩阵及安全测试
通过后，状态才能从`Draft for Review`升级为`Approved for RC`。
