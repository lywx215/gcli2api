# ERR-05：安全验收、回归、Claude 代码复审

状态：done。2026-09-27 本组第 3 轮真实 Claude 代码复审返回 findings=[]、error=null；前两轮 6 项问题均已修复。完整回归 1143 passed、1 skipped、6 warnings（65.43s），审核前后 117 个源码/测试文件摘要一致。

## 最新验证

唯一工作区：`C:/Users/lywx2/.codex/worktrees/14f9/gcli2api`，分支 `dev0926`。先完成修复开发，再集中验证。

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:PYTHONPATH='C:/Users/lywx2/AppData/Local/Temp/gcli-diag02-validation-deps'
$regressionFiles = @(rg --files -g 'test_*.py' -g '!tests/**')
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/run_diagnostic_tests.py -c pyproject.toml --asyncio-mode=auto -q tests @regressionFiles --tb=short
```

最终结果：**1143 passed, 1 skipped, 6 warnings，65.43s**。收集 1144 项，包含 tests/ 全部本地测试及根目录 37 个 test_*.py 文件；不存在将分批重复测试数相加的情况。

覆盖管理协议/OpenAPI、Legacy、Antigravity、Gemini CLI 接线、面板/前端、订阅/模型分层、错误分类/冷却、SQLite 临时隔离测试、逻辑统计、诊断向量与 runtime/service/revision/R2。新增针对审核 findings 的首错误、真实鉴权、ReadTimeout、Retry-After、非法 JSON/包装、collector、纯 DONE、EOF、usage 尾帧、引用误判等用例。

1 个 skip 为既有平台 fork 相关测试；6 个 warning 为既有 Pydantic Config 和 Starlette/httpx TestClient 弃用。没有生产或真实上游测试。

其他检查：

- `python scripts/verify_diagnostic_contract.py`：PASS，73 个契约文件；工作区 == Git index；manifest SHA-256 `ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4`。
- 本轮开始时实际递归文件清单与 HEAD 比较一致，完成时冻结目录 Git 状态为空。
- `git diff --check` 通过，仅有 LF/CRLF 提示。
- `panel-version.txt` Git 状态为空。
- 新测试位于仓库原有被忽略的 tests/ 目录，本地保留，不暂存/提交；共享审核配置枚举 tests/**/*.py，并补入根目录 test_*.py，使本轮诊断回归修改也纳入下一次审核。

## 失败到修复的实录

- 第一批现有测试遇到局部鉴权包装后旧 override key 不匹配；测试改为覆盖 opt-in 包装依赖，189 项通过。真实鉴权行为另加独立用例，没有通过禁用生产认证掩盖失败。
- 补充矩阵及传输测试后，383 项相关测试通过。
- 首次扩大根目录回归：12 failed、689 passed、1 skipped。定位为 Native Gemini 重建响应后提前 return 跳过 converted，以及类型化 SSE 模型错误误记 transport read。
- 修复两处接线后，诊断子集还有 1 failed、116 passed、1 skipped：已完成退役识别器返回 PASS/空 events，集成层遗漏后续 usage 尾帧。修正集成适配器并补测；未编辑 ERR-02 独占文件。
- 上一组最后执行合并命令：1059 passed、1 skipped，覆盖此前全部失败；本组新增别名/传递/清理/抗截断验证后为 1143 passed、1 skipped。

## Claude 门禁

真实 Hook 返回、时间、审核摘要、原始 finding 和逐项处置见 `review/MODEL_API_FIXED_ERRORS_CLAUDE_CODE_REVIEW.md`。上一组 9 项及本组前两轮 6 项 findings 为历史；最终第 3 轮代码复审通过，不以本地回归代替审核。批准快照摘要 `8d8ff44609431d5c690c06a3db0a63b074a1264d6566618adf67fbff9b5f3911`；源码/测试摘要 `028431889e9a8f26433a67c5b1e101098f7e6c5dd8c72ace22ff5f9116c3340f` 前后一致。审核后只更新完成记录，不再修改代码。

旧报告中的 161/39/390/78/117 为此前批次的历史证据，当前结论以上述合并回归为准。未手动改写 Hook 审核历史或伪造批准；最终批准由实际 Claude 返回后共享 Hook 自动记录。

没有提交、推送、部署、调用生产模型；没有修改真实凭证、SQLite/Volume 或 panel-version.txt。无 schema/capability 变化，无 manager 对端动作。


## 本组第二轮修复补充

Response→异常边界统一保留私有 TIMEOUT/BAD_FORMAT；空凭证池附 LOCAL 503；流/非流重试 finally 取消并等待未消费的凭证预取任务，父取消继续传播。直接 API 数据后异常不重放、抗截断第二轮 HTTP/超时/格式/退役停止、预取任务 return/close/cancel 和六路由私有类型均补测试。定向 312 passed；完整结果以上述 1143 为准。静态检查后仅清理空白行行尾空格，无语义变更。
