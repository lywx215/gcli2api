# new-ui 提交检查记录 — 2026-10-16

用户明确要求提交并推送远程。本次提交以 ec3da9f 为父版本，纳入该工作树当前源码、回归测试及对应说明；本地 .codex 状态、历史派发 brief/过程记录及构建产物不纳入。

## 变动

- Antigravity 旧 Flash 精确迁移至 3.8，退役指定 Pro 模型，在凭证/上游请求之前本地拒绝；更新纯路由策略及源码指纹。
- Token 刷新统一保留原始上传字段和轮转 refresh_token，避免运行时 Credit 字段污染，保持 generation/version 条件写入。
- 人工测试安全返回实际上游模型版本，旧/新面板显示该字段。
- 凭证列表增加上下双分页，移除移动端重复的查看额度入口。

这些包含模型请求线路变化，不能按“仅 UI 管理展示”解释。此前对 ec3da9f 已提交内容的盘点不包含本次未提交覆盖层。

## 本次实际验证

- 后端 18 个选定文件：1680 passed，5 条现有 Pydantic 弃用 warning，62.04 秒。
- npm run build（含 tsc --noEmit）：通过。
- npm run check:build：通过，18 JS、2 CSS、六页独立构建及 manifest/fixture 检查。
- 前端 ResultView.test.tsx 和 CredentialsPage.test.tsx：49 项中 35 passed / 14 failed，另有 1 个未处理 AbortError。ResultView 文件通过，CredentialsPage 文件失败。
- 前端失败包括双分页导致的每页数量控件多匹配，以及移动端工具面板、选择提示、批量流程、渠道筛选、能力限制和请求归属断言。未完成逐项归因，不能全部认定为测试过期或产品回归。
- git diff --cached --check：通过（另有 LF/CRLF 提示）。

后端命令：

```powershell
$env:ENABLE_LOG='0'
$env:PYTHONDONTWRITEBYTECODE='1'
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' -m pytest test_antigravity_model_migration.py test_antigravity_model_catalog.py test_model_routing_compiler.py test_model_routing_preflight.py test_antigravity_refresh_writeback_paths.py test_antigravity_refresh_preservation.py test_antigravity_email_enrichment.py test_antigravity_review_regressions.py test_antigravity_runtime_import_regressions.py test_antigravity_manual.py test_panel_quota_summary.py test_antigravity_cooldown_regression.py test_antigravity_quota_measurement.py test_antigravity_timeouts.py test_logical_request_stats.py tests/test_antigravity_stability_integration.py tests/test_gemini_fix.py tests/test_model_api_error_matrix.py -q --tb=short -p no:cacheprovider
```

前端命令：`npm test -- src/pages/credentials/ResultView.test.tsx src/pages/credentials/CredentialsPage.test.tsx`。

本次是源码提交，不表示测试全部通过或生产验收通过。没有部署、重启服务、数据迁移、真实模型或生产 API 调用；面板版本号保持不变。其余文档中的“未提交/未推送”描述是各自历史检查时点。
