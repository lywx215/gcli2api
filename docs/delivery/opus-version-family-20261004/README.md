# Opus 版本家族权限与 4.6 恢复：交付记录

基线：`d1004-1 / 87a33ec`。本轮代码已实现，完整验收仍有下述平台与浏览器缺口。
初次交付为本地代码；用户随后明确授权提交并推送至 `d1004-1`。
面板版本号保持不变，未修改生产数据或执行真实生成；推送后的部署状态须另行验收。

## 当前行为

- 5.5、4.6 分别管理权限、暂停与恢复；请求保持指定版本和真实模型 ID，不自动升级、降级或换档。
- 5.5 保留 Low / Medium / High 请求及额度卡片，权限区域每个版本只显示一份状态。
  4.6 恢复 `claude-opus-4-6-thinking`，兼容裸名、点号及既有功能前缀。
- 目录支持与实际模型 ID 证据同时参与选择及最终原子准入。无合格凭证使用已有本地 503；
  三协议普通、流式、假流式和抗截断均有头前错误回归。
- 上游生成 404 或精确 Claude 停用通知暂停该凭证的对应版本，换用同版本、同 ID 的其他凭证。
  覆盖 HTTP 200 正文、400/500 错误封装、纯 UTF-8 错误体及逐字符 SSE；普通引用不暂停，
  已输出内容不完整重放，停用文本不作为最终回答或成功统计。
- 12 小时有效支持、24 小时暂停、12 小时复查及失败后 15 分钟重试保持。
  High 成功续期不阻止 Low / Medium 已过期的实际 ID 证据按需查询。
- 旧凭证目录结果不能写给替换或删除后重建的凭证；失败目录查询不增加权限证据修订号，
  不会屏蔽并发真实 404。新有效目录或人工成功仍能阻止旧 404 覆盖恢复结果。

## 接口、存储与回滚

复用既有 `model_access_state` JSON，增加 v2 的 `families/routes`，保留旧 `models` 投影。
旧记录只读归一化，完整一致证据保留原期限；不完整、冲突及投影失配证据待确认。
不新增数据库列、批量迁移或改写令牌、额度、历史统计。

`/creds/status` 新增可选 `model_access_family`，默认 `claude-opus-5-5`，另支持
`claude-opus-4-6`。`model_access_tier` 接受旧值，按版本权限判断；旧响应保留。
新增安全 `model_access_families` 与 `model_access_summary.family_counts`，在分页前筛选。
面板 capability 为 `antigravity.model_access.family_filter`，缺少能力时前端禁用版本筛选；
不支持后端的显式权限筛选返回 501，不能从旧档位数据推导可用状态。

Management schema 仍为 1.4，既有能力和动作枚举不变，manager 无需动作：
`no_counterpart_action`。桌面跨页选择沿用一次捕获的版本参数；移动端保持本页选择范围。

回滚只撤回本次代码，保留新增 JSON 数据及原始数据。旧版本会恢复全局 4.6 拒绝行为，
不具有本次双版本保护；再次升级需重新确认受旧投影写入影响的证据。

## 验证证据与未完成项

最终完整隔离运行：**2727 passed、16 failed、8 warnings，44.96 秒**。
[完整原始记录](regression.txt) 包含全部失败堆栈，未隐藏或跳过这些失败。

命令：

```sh
PYTHONPATH=/private/tmp/gcli-opus55-test-deps .venv/bin/python scripts/run_diagnostic_tests.py -q --tb=short
```

失败全部来自 `test_model_routing_preflight.py` 的既有 Windows 文件固定契约。
`src/model_routing/readonly.py` 在非 Windows 平台主动拒绝 SQLite 预检，macOS 因此返回
`BACKEND_READ_FAILED`；该源文件和上述测试文件的 SHA-256 均与 `87a33ec` 一致。
本轮未修改这项安全门禁、放宽平台限制或把失败改为通过；Windows 实机预检验收未完成。

本轮权限、期限、CAS、替换、租约、真实 ID、停用与版本保持、面板分页及路由差分均通过；
Management/OpenAPI 与既有 Legacy 回归也通过。SQLite 使用真实临时数据库，
PostgreSQL/MySQL/MongoDB 使用实际存储路径的驱动替身；不代表连接真实远程数据库验收。

`node --check front/common.js`、`node --check front/model_routing.js`、Python 编译检查及
`git diff --check` 通过。前端测试运行实际 common.js 渲染、请求处理与跨页选择函数，
并检查桌面和移动模板中的版本筛选入口；权限不出现三档重复、额度仍发送精确 ID。
浏览器工具返回无可用浏览器，真实浏览器截图和点击验收未完成，没有复用历史截图充当证据。

面板版本文件与基线完全一致。本轮未调用真实 Google 生成、查询生产凭证或执行部署。
详细当前兼容说明见 [权限文档](../../ANTIGRAVITY_MODEL_ACCESS.md)。
