# ERR-01：固定英文错误契约和受保护路由基础设施

最终状态：done。ERR-05 集中回归 1143 passed、1 skipped，2026-09-27 最终第 3 轮 Claude 代码复审 findings=[]。以下保留 ERR-01 单阶段历史证据，其当时的复审上限不代表当前仍未通过；最终实录见 `review/MODEL_API_FIXED_ERRORS_CLAUDE_CODE_REVIEW.md`。

基线：`dev0926`，`0b3a07e003ead2ba7a9f7827426c09f8ff996813`。

## 修改文件

- `src/router/model_api_errors.py`
- `tests/test_model_api_errors.py`
- `review/MODEL_API_FIXED_ERRORS_CLAUDE_REVIEW_V3.md`

未挂载生产路由，未修改管理、Vertex、凭证、SQLite、诊断契约或版本文件。

## 已实现接口

- `ErrorOrigin`、`ErrorKind`、`ModelApiProtocol`、`ErrorMessageId`。
- 不可变 `ModelApiError`。
- `make_model_api_error(...)`、`error_from_http_status(...)`、`error_from_exception(...)`、`fixed_error_message(...)`。
- `render_error(...)` 三协议 JSON；`render_error_event(...)` 三协议 SSE 终止帧。
- `ModelApiErrorException`、`attach_model_api_error(...)`、`get_attached_model_api_error(...)`。
- `ProtectedModelApiRoute`、`make_protected_model_api_route_class(...)`。
- `protect_streaming_response(...)`。
- `activate_logical_request_recording(...)`、`record_logical_request_once(...)`。

错误值不含任意外部 message/model/body/header。来源不明的 401/403 使用中性文案；只有 `CLIENT` 来源使用本地认证/权限文案。直接返回的非 2xx Response 会在受保护路由内重新渲染，丢弃 Location 和上游头；替换前会关闭迭代器并执行 background。模块导入没有全局 exception handler 或统计副作用。

## 测试证据

命令：

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/run_diagnostic_tests.py -c pyproject.toml --asyncio-mode=auto tests/test_model_api_errors.py
```

结果：2026-09-27，**77 passed, 1 warning**；与 ERR-03 最新回归合计 **89 passed, 1 warning**。未调用真实 Google/生产服务；warning 为 FastAPI TestClient 的 httpx 兼容性弃用提示。

覆盖：固定英文表、三协议 JSON/SSE、402/408/413/422/429/500/502/503/504 和未知 4xx、CLIENT/UPSTREAM/LOCAL 来源、HTTP 状态非法值、body sentinel、直接 400/3xx Response、私有类型化异常/附着、取消/GeneratorExit、流关闭、统计激活/幂等/异常隔离、background 和导入无副作用边界。

## Claude 门禁和未完成项

真实 Claude 三轮报告已保存于 `review/MODEL_API_FIXED_ERRORS_CLAUDE_REVIEW_V3.md`。第三轮对实现无 P1/P2，但在测试补丁前发现一个测试 P2；测试补丁之后未再次调用 Claude，因为已达到本阶段自动审查上限。当前状态为“本地证据修复完成，修复后 Claude 复审未执行”；该边界不阻止用户已授权的后续开发，但不把它伪称为新的 Claude 通过结论。

无 schema/capability 变化，无 manager 对端动作，无部署/提交/推送。
