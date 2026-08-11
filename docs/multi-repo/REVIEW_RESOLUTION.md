# 第三方 Review 意见处理记录

状态：**Resolved，等待独立复审**

处理日期：2026-08-10

输入：[第三方 Review 原文](./MULTI_REPO_SPEC_REVIEW.md)

本记录只表示文档层面的P0/P1问题已处理，不表示代码已经实现，也不授权生产写操作。

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
| P2-3 MySQL实例隔离 | 不适用当前范围 | 当前需求明确仅使用节点本地SQLite；指南明确禁止因此引入MySQL或中央数据库依赖 |
| P2-4 适配器探测 | 已解决并收紧 | 两端manager指南增加决策流程；401/403禁止降级，Legacy需显式允许 |
| P3-1 OpenAPI导出 | 已采纳 | 协作规范CI及gcli2api发布阶段要求自动导出和破坏性变更校验 |

## 复审重点

第三方复审应重点确认：

1. 批量端点的单项错误不会导致成功项被自动重放；
2. Token未配置时不存在空认证、面板密码回退或数据暴露；
3. manager不会在401/403后尝试Legacy写接口；
4. 两仓库的权威契约和协调规范SHA-256一致；
5. 本阶段没有引入MySQL和new-api实现范围。

## 当前结论

文档可进入独立复审。只有复审确认无未解决P0/P1、代码实现完成、兼容矩阵及安全测试
通过后，状态才能从`Draft for Review`升级为`Approved for RC`。
