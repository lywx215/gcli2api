# d1004-1 改善交付

基线：`867d38e40619cd0da4cc0351def253c70f1b5cda`。
实现分支：`codex/d1004-1-improvements`。用户已授权全部确认问题与筛选变化清空选择。
方案经四轮实际 Claude 只读复审，最终 `findings=[]`；该结果不等于代码批准。

## 变更

- 真实额度投影/原始状态统一解释，HTTP 与网络失败按块回退缓存。
- 四后端显式导入原子换代与清除旧权限，OAuth/刷新令牌初始状态仅插入。
- 目录快照身份匹配、旧任务 CAS 与刷新失败 900 秒退避。
- 501 可识别能力响应，200/501 统一筛选失效，跨页选择与认证任务隔离。
- 版本行为测试、AST dump 兼容测试及历史模型退役文档校正。

## 接口与兼容

新增私有导入接口，通用保存、迁移和普通刷新语义保留。
501 保留状态码及 detail，增量 error_code/capability；不增加 backend_type 顶层字段。
Management schema 1.4、capability、动作枚举及 panel-version.txt 保持不变。
manager 动作：`no_counterpart_action`。未恢复 Gemini CLI 专属维护或取消的 MGMT 工作。

覆盖保留存储 tier；导入响应 subscription_tier 仅本次探测结果。
旧状态损坏原文保留；部分 schema 只读探测，不新增 DDL 或迁移。

## 验证状态

源码实施完成，最终单次全量 pytest：2799 passed、0 failed、1 skipped、6 warnings，102.49 秒。
独立 Node 三文件：43 passed、0 failed（13 + 16 + 14）。唯一 Python 跳过为 Windows 无 POSIX fork；
6 条既有警告为 Pydantic Config/Starlette httpx 弃用。定向结果不与全量数量相加。
完整证据：[pytest.txt](pytest.txt)、[node.txt](node.txt)。首轮 7 项旧替身接口失败及修正证据
保留于 [pytest-first.txt](pytest-first.txt) 和 [runtime-retest.txt](runtime-retest.txt)。
未放宽业务身份门禁，目录原模型断言保留；替身补充真实选择器元数据及 insert-only 初态参数。
实际 Claude 第一轮代码审核确认一项缺陷：group-only 501 携带默认 family 参数时
错误锁住仍可用的家族筛选；已修复并新增默认参数/具体能力/双高级筛选回归。
通过本机共享 Hook 的 ask_claude 调用实际 Claude Opus 5.5，第二轮代码复审返回 findings=[]，
error=null，审核期间文件未变化，239.167 秒。未手写或更新 Hook 会话的正式 approved_plan/approved_code 状态。
真实结果及冻结快照见 [claude-code-round-1.txt](claude-code-round-1.txt)、
[claude-code-round-2.txt](claude-code-round-2.txt)；最终被审源码/测试摘要见
[reviewed-source-sha256.txt](reviewed-source-sha256.txt)。复审后仅更新交付记录和 .gitignore 的 fixture 跟踪例外，
不修改被审源码或测试。
Python 3.12 可用；py launcher、uv installed list 和 Codex runtime 均未找到 Python 3.13，
不能宣称跨解释器摘要验证通过。模拟 modern dump API 与真实 Python 3.13 证据区分。

完整 pytest 沿用 scripts/run_diagnostic_tests.py -q --tb=short -p pytest_asyncio.plugin，
未删除或排除任何测试；清空映射的业务配置环境，使用临时凭证/SQLite/日志目录。
临时 sitecustomize 拦截 Python 的非回环 TCP connect/connect_ex 和 DNS，并由 PYTHONPATH 传递至 Python 子进程；
此证据不代表对非 Python 程序或所有网络协议的隔离验证。
所有数据库写入限定临时测试目录；不读取真实凭证、正式数据库或 .env，不调用真实模型。
SQLite 为真实临时数据库，PostgreSQL/MySQL/MongoDB 为驱动替身，不代表远程集成已验证。
Node VM 不代替真实浏览器验收。未推送或部署。

## 提交与合并授权

2026-10-05 用户追加授权：将已审核的改善提交并合并至 d1004-1。
按现有祖先关系使用快进合并，保留面板版本；具体提交与合并结果以 Git 记录为准。

## 回滚

仅回滚本批代码，不删除状态字段、不恢复旧权限、不改生产数据。
普通刷新及迁移路径保持原行为；回滚后缺少新导入隔离不代表保护等价。
