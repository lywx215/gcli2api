# ERR-03：完整 SSE 事件、内部错误类型与重试边界

最终状态：done。ERR-05 集中回归 1143 passed、1 skipped；2026-09-27 最终第 3 轮 Claude 代码复审 findings=[]。下文为本阶段与上一组审核的历史记录，最新类型传递、预取清理及抗截断第二轮证据见 ERR-05 与最终审核实录。

2026-09-27 补充：本组 Claude 代码 findings 的超时/空响应/本地 Retry-After 已修复；protected collector 显式启用事件模式，纯 DONE 不提前提交，EOF/usage 尾帧与 Gemini CLI 迭代器关闭补齐。新增 `tests/test_model_api_transport_errors.py` 16 项，本轮合并回归 1059 passed/1 skipped；此前下列 12/89 为历史分批证据。当前代码仍待修复后 Claude 复审，详见 ERR-05。

## 修改文件

- `src/httpx_client.py`
- `src/api/geminicli.py`
- `src/api/antigravity.py`
- `src/router/stream_passthrough.py`
- `src/router/geminicli/{openai,anthropic,gemini}.py`
- `src/router/antigravity/{openai,anthropic,gemini}.py`
- `tests/test_sse_events.py`
- `src/converter/anti_truncation.py`
- `src/converter/anthropic2gemini.py`

ERR-02 独占文件未修改；Vertex 默认按行和空流 204 的调用未改变。

## 接口与行为

- `normalize_sse_events(chunks)`：显式事件模式的异步规范化器。支持 CRLF、`data:` 无空格、多条 data 合并、UTF-8 跨块、注释/控制字段、EOF flush 和 `[DONE]`；向下游只交出 `data: ` + 单行 JSON/`[DONE]` + 空行。
- 完整 data 必须是 JSON object；数组、字符串、非法 JSON、`event:error`、非空 `error` 和错误 code 类型/范围不合法时交出 `ModelApiErrorException`。有效整数 400–599 保留状态，其他错误固定为 502；不携带上游正文、头或异常文字。
- `stream_post_async(..., events=False)` 保持既有按行/native 默认行为；显式 `events=True` 才启用完整事件模式，避免影响未接入调用者。
- `build_streaming_response_or_error(..., protected=False, protocol=None)` 保持默认空流 204；`protected=True` 且提供协议时，空流返回固定 502 renderer，供 ERR-04 六路由显式启用。
- `stream_post_async(..., events=True)` 在规范化事件后为每个 upstream attempt 新建 `RetirementStream`；退役通知和缓冲超限转为内部类型化终止，队列事件不会交给 converter。
- 两后端 `stream_request(..., events=False)` 默认兼容旧调用，六个受保护生成路由显式传 `events=True`；Gemini CLI 与 Antigravity 在类型化流错误或正文后异常时不继续完整重试。

## 测试

命令：

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/run_diagnostic_tests.py -c pyproject.toml --asyncio-mode=auto tests/test_sse_events.py tests/test_model_api_errors.py
```

结果：2026-09-27，SSE 单模块最新 **12 passed**；与 ERR-01 回归合计最新 **89 passed, 1 warning**。未请求真实 Google/生产服务。

覆盖 UTF-8 跨块、CRLF、无空格 data、多行 data、控制字段、心跳、EOF flush、DONE、非法 JSON/非对象、空 error、bool/越界 code、event:error 以及 ERR-01 固定 renderer/流适配器回归。

## ERR-04 接线约束

- 两后端受保护流必须显式传 `events=True`，不能对完整事件和旧按行片段启发式混用。
- 规范化成功事件再进入 converter/collector/DIAG；类型化错误直接进入 ERR-01 的 pre-commit/post-commit 边界，不能作为成功字节交给转换器。
- 六路由已启用 `protected=True, protocol=...`；Vertex 未启用该参数，保留 204。
- 首包预取、真正空流有限重试、HTTP200 error、已输出正文后的重放保护、统计完成器和 Claude finishReason/`aclose` 的路由级证据已接线，集中证据由 ERR-05 汇总；本阶段不把单元测试结果单独当作完整集成通过。
