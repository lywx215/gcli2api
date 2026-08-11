# gcli2api 双仓库协作文档包

状态：**Draft for Review**

更新时间：2026-08-11

当前方案修订：`manager-architecture-1.2`。manager在腾讯云TDSQL-C MySQL 8中使用
独立逻辑库、单一受限数据库账号、单一Web管理员和React紧凑Web控制台，支持用户选择
亮色、暗色或跟随系统；桌面端保持独立，不共享数据库、账号或`servers`表，也不属于
本阶段范围。

适用仓库：`gcli2api`、`gcli2api-manager`

## 文档目的

本目录定义两个Git仓库如何独立开发、通过稳定HTTP协议协同，并兼容当前部署在
Zeabur上的多个gcli2api版本。文档同时服务于：

- 在两个仓库中执行任务的Codex；
- 项目维护者和发布负责人；
- 对架构、协议、安全及兼容性进行独立Review的第三方。

## 阅读顺序

1. [协作与交付规范](./COORDINATION_SPEC.md)
2. [Management API契约](./MANAGEMENT_API_CONTRACT.md)
3. [gcli2api端Codex实施指南](./GCLI2API_CODEX_GUIDE.md)
4. [manager端Codex实施指南](./MANAGER_CODEX_GUIDE.md)
5. [第三方Review指南](./REVIEW_GUIDE.md)
6. [双仓库自动交接](./AUTOMATED_HANDOFF.md)
7. [第三方Review原文](./MULTI_REPO_SPEC_REVIEW.md)
8. [Review意见处理记录](./REVIEW_RESOLUTION.md)

## 如何放入两个仓库

### gcli2api仓库

当前仓库根目录的`AGENTS.md`已经引用本套规范。涉及管理协议的Codex任务必须遵守它。

### gcli2api-manager仓库

manager仓库已经建立。两个仓库各自保留协作文档和`AGENTS.md`，后续使用相同工作项及
自动handoff同步变更，不再依赖用户手工复制。Management API契约和协调规范在两个仓库
中的内容必须一致，并由各自PR完成Review。

## 文档权威性

- `MANAGEMENT_API_CONTRACT.md`是HTTP协议的规范性来源。
- `COORDINATION_SPEC.md`是跨仓库流程和兼容策略的规范性来源。
- 两份Codex指南是仓库执行约束，不得覆盖前两份规范。
- Review通过前，所有文件均视为Draft，不应用于生产自动写操作。
- 跨仓库任务交接必须使用自动handoff，不得要求用户手工复制交付块。

## 变更规则

任何影响下列内容的修改都需要两个仓库共同Review：

- API路径、字段或错误语义；
- capability名称；
- 管理动作的副作用；
- 认证方式；
- Legacy版本支持范围；
- 敏感数据边界；
- 灰度和回滚策略。
