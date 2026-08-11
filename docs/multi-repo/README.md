# gcli2api 双仓库协作文档包

状态：**Draft for Review**

更新时间：2026-08-10

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

新仓库创建后：

1. 将本目录完整复制到manager仓库的`docs/multi-repo/`；
2. 将`templates/manager/AGENTS.md`复制为manager仓库根目录`AGENTS.md`；
3. 在manager CI中固定一份已审核的Management API契约副本；
4. 后续契约更新必须由两个仓库各自PR同步完成。

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
