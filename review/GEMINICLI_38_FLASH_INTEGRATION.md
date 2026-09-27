# Gemini CLI 3.8 Flash → dev0927 整合记录

日期：2026-09-27。用户要求提交当前文档修正，并将本地 `gemini-3.8-flash` 变更一并推送。

## 交付内容

- 文档修正与 Claude 历史记录提交：`5ed0fa6`。
- 模型来源分支：`codex/geminicli-38-flash`，独立提交 `30f4f6c`，基于 `20cb545`。
- 来源 13 个文件全部纳入 `dev0927` 的合并；合并无冲突，业务代码及新模型测试与来源提交一致。
- 包含模型列表、low/medium/high 思考档、搜索、三协议、假流式、抗截断、凭证筛选与统计接线。
  实现及能力边界详见 [模型说明](../docs/GEMINICLI_38_FLASH.md)。
- 文档同时保留固定英文错误保护范围和另行授权的 3.8 Flash 适配例外，未恢复其他 Gemini CLI
  或已取消 MGMT 待办。
- 本记录随合并提交保存。实际合并 SHA 和远程推送状态以 Git 为准，不在提交前预填成功状态。

## 整合验证

在 `C:/Users/lywx2/.codex/worktrees/14f9/gcli2api` 的合并工作区执行：

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:PYTHONPATH='C:/Users/lywx2/AppData/Local/Temp/gcli-diag02-validation-deps'
$regressionFiles = @(rg --files -g 'test_*.py' -g '!tests/**')
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/run_diagnostic_tests.py -c pyproject.toml --asyncio-mode=auto -q tests @regressionFiles --tb=short
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/verify_diagnostic_contract.py
```

- 全量结果：**1414 passed, 1 skipped, 6 warnings**，70.60 秒，退出码 0。
- 包含新模型的 176 项用例；跳过项为 Windows POSIX fork 测试，警告为现有弃用提示。
- 冻结诊断契约：73 文件通过，worktree == index；manifest SHA-256：
  `ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4`。
- 使用隔离运行器、临时测试数据与模拟上游；未调用生产模型、部署或修改真实凭证、数据库、Volume。
- `tests/test_antigravity_stability_integration.py`、`panel-version.txt` 和冻结契约相对
  `20cb545` 均无变更。数据库 schema、Management schema/capability 不变，manager 无需动作
  （`no_counterpart_action`）。

## 审核限制

Antigravity 的两项测试证据缺口按用户要求暂缓；两项文档问题已修正，尚未经过 Claude 复审。
原审核保持“发现问题，未通过”。本次模型变更没有启动新的 Claude 审核，全量测试通过不能
替代审核通过。未验证真实上游账户权限或线上模型可用性。
