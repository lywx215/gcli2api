# Argon 周额度与版本升级交付（2026-10-18）
后续 Argon 调用映射和凭证权限隔离见 [调用适配与回滚说明](ARGON_CALL_ADAPTATION_20261018.md)。本文保留此前额度展示与版本升级的验收范围。

## 实现结果

工作基线为 new-ui / 11cbaa6；本轮变更保留在工作树，未暂存、提交、推送或部署。

- Antigravity 共享客户端标识由 1.1.24 升级为 1.4.0，平台仍为 windows/amd64。额度、模型目录及其他复用该常量的上游请求统一升级标识；没有修改模型路由、重试或生成参数。
- 现有额度 DTO 与动态分组解析已经保留 Argon 分组、比例和重置时间，不新增接口、数据库字段或 capability。
- 共享额度卡片仅在 Antigravity 模式下按精确 bucket ID `gemini-argon-wtu-weekly` 识别该分组，保留 `Gemini 4 Argon Weekly Limit` 官方名称，仅展示实际返回的桶，不补造 5 小时额度。普通分组、相似 ID 和 Gemini CLI 保留原行为。
- 没有返回该额度的账号不显示 Argon 分组；缺失不被解释为权限结论，也不会显示虚构的 0% 或 100%。
- 使用现有脚本显式生成面板版本 `new-ui-20261018-1023`，北京时间 2026-10-18 10:23:21；没有修改 version.txt 或 Git 历史。

## 面板版本显示修复

运行验收发现旧版本加载器完全忽略 panel-version.txt，导致生成后仍显示 HEAD 提交时间标签。本轮修正为：仅本地 Git 分支、分支匹配、保存日期不早于 HEAD、显示标签与字段自洽时使用该面板显示版本。显式部署来源、发布标签、其他分支、过期和损坏文件均不受此标签覆盖。

仅 display_version 使用面板标签，version/full_hash/commit_date/date/message 仍描述实际源码。最终 /version/info 和概览页面都显示 new-ui-20261018-1023，同时真实提交仍为 11cbaa6、提交时间仍为 2026-10-16T22:38:08+08:00。规则见 [面板版本说明](../PANEL_VERSION.md)。

## 实际验证

| 范围 | 本轮结果 |
| --- | --- |
| test_panel_quota_summary.py | 68 passed：有/无 Argon、零值/未知值、名称和时间保留、UA 1.4.0 等 |
| test_antigravity_request_compat.py | 2 passed：请求兼容及请求头保护 |
| test_versioning.py | 最终 32 passed，包含新增的 12 项本地标签及来源优先级回归 |
| test_panel_version_generator.py | 3 passed |
| QuotaCard.test.tsx | 16 passed：仅周额度、精确标识、渠道边界、普通组不变、账号替换清除 |
| AgQuotaEvidence.test.tsx + LegacyModelQuota.test.tsx | 45 passed |
| npm run build | 通过，包含 tsc --noEmit |
| npm run check:build | 通过：六页独立构建、18 JS/2 CSS、完整 manifest、无开发 fixture 注入 |
| git diff --check | 通过；存在仓库既有 LF/CRLF 提示 |

后端上述四文件最终覆盖 105 项不同测试，分两轮完成；不把重复执行的旧版本测试另行累加。前端选定三文件合计 61 项通过。

前次 CredentialsPage.test.tsx 的 14 项失败及 1 个未处理 AbortError 保持为历史未解决事项；本轮未重跑该文件、未扩大修复范围，也不宣称完整前端或后端套件全部通过。

## 本地运行验收

- 重启前已创建私有 SQLite 一致性备份，完整性检查通过；未在仓库内创建凭证库、备份或认证文件。
- 使用原有 65476 端口启动器、数据、登录配置及外联白名单，模型生成保持禁止。
- 两个用户指定对照账号分别通过页面执行一次真实额度查询；共 2 次官方额度摘要请求，均 HTTP 200，无模型生成、OAuth 刷新或其他业务请求。
- 有 Argon 的账号显示第三个独立分组，名称准确，只有一条实际周额度；对照账号只显示原有两个分组，切换后无上一账号的 Argon 残留。
- 桌面 1440×1000、手机 390×844 检查通过；手机官方名称完整显示，重置倒计时可见。测试结束恢复浏览器原尺寸。
- 重启及额度查询前后，两个渠道的凭证名称/内容集合摘要一致。真实账号数据未进入测试 fixture、源码、交付文档或提交。
- 版本显示修复通过后再重启一次，仅验证本地版本与页面，未重复额度查询；最终服务 ready，版本接口和概览页面一致。预览停留在凭证页面。

截图和只含布尔/计数的运行记录作为本地任务产物保留，不加入 Git；没有保存完整上游响应或令牌到交付文件。

## fork 核对及兼容边界

完整核对报告见 [fork 更新审计](FORK_UPDATE_REVIEW_20261018.md)。上游基线 87f56c8 至 d7e97ec 共 47 个提交、17 个变动文件；本次没有合并上游提交。工具 schema 清洗为后续有条件候选，其他模型请求改造另案评估；排除删除 Preview、固定端点、原始内容日志与自动更新。

没有数据库迁移、Management schema/capability 变更或 manager 配套动作（no_counterpart_action）。回滚恢复本轮源码和 panel-version.txt，重建 UI 并重启；无需修改数据库。
