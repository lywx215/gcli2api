# 模型 API 固定错误 v3：Claude 增量审查记录

审查模型：Claude Opus 5.5（`claude-opus-5-5`）

审查方式：本机 `C:/Users/lywx2/.local/bin/claude.exe`，`--effort high`、只读工具 `Read,Glob,Grep`、`--permission-mode plan`、无会话持久化，真实 `stream-json` 输出中确认了 `type=result` 和 `modelUsage`。未调用生产服务、凭证或网络；Claude 未修改文件、未运行测试。

审查范围：

- `review/MODEL_API_FIXED_ERRORS_PLAN.md`
- `review/MODEL_API_FIXED_ERRORS_TASKS.md`
- `src/router/model_api_errors.py`
- `tests/test_model_api_errors.py`

## 三轮真实结果

第一轮：实现方向正确，但发现 8 个 P2，集中在 402/408 映射、HTTPException 来源、SSE 终止帧、类型化错误载体、统计激活/异常隔离、资源释放、内部日志和测试证据。

第二轮：前述代码问题已修复；仍发现统计完成器未强制检查请求激活，以及测试矩阵和资源/路由证据不足。

第三轮（最终自动审查轮次）：

> 实现本身没有发现 P1/P2，前两轮提出的代码问题都已修复。但测试证据还有 1 项 P2：OpenAI 映射参数化分支没有断言，完整映射矩阵和 HTTP200 `error.code` 证据不足，因此本轮不能写“无未解决 P1/P2”。

第三轮的 `modelUsage`：`claude-opus-5-5`，inputTokens 4，outputTokens 25460，thinkingTokens 20227，costUSD 0.8109526；provider `firstParty`。

## 第三轮指出的问题及处理

Claude 指出的唯一剩余 P2 是测试证据缺口，不是 `src/router/model_api_errors.py` 的实现缺陷。随后在不改变公共实现接口的前提下补充了：

- OpenAI 402/408/未知 4xx 的实际断言；
- Claude 的 CLIENT/UPSTREAM 401/403、404、413、422、429、500、502、503、504 映射；
- bool、字符串、`None`、200、399、600 的 HTTP 状态降级测试；
- 三协议终止帧检查；
- body 校验 sentinel、显式统计激活、recorder 异常隔离、响应流释放和 background 执行。

补充后本地隔离测试为 **77 passed, 1 warning**。由于任务约束规定本阶段 Claude 自动审查最多 3 轮，且第三轮已报告该 P2 后，本轮未伪造“修复后的 Claude 复审通过”。需要用户明确发送“继续 Claude 审核”后，才能进行下一组 Claude 门禁审查；在此之前不宣布 ERR-01 已获 Claude 冻结，也不启动 ERR-03。

## Claude 复审确认的接口注意事项

- `ModelApiError` 是不可变内部值，只含 `origin/kind/status/retry_after`；renderer 不接收任意 message、model、raw body 或上游 headers。
- `ErrorOrigin.CLIENT` 只用于本地已验证的客户端认证/授权失败；`UPSTREAM` 也承载来源不明；`LOCAL` 用于本地处理错误。普通 FastAPI/Starlette `HTTPException` 默认按 `UPSTREAM` 中性渲染。
- `ModelApiErrorException` 用于类型化的内部终止错误；`attach_model_api_error` 只为受保护路由的非 2xx Response 提供进程私有附着信息。
- OpenAI 流错误帧包含 `[DONE]`，Claude 使用 `event: error`，Gemini 只输出固定 `data` 错误帧；取消和 `GeneratorExit` 不转换。
- `activate_logical_request_recording` 后才可调用 `record_logical_request_once`；该完成器请求级幂等，recorder 异常只写内部日志，不改变响应或流。
- `ProtectedModelApiRoute` 仅捕获返回前异常；已开始的流必须显式使用 `protect_streaming_response`。ERR-03/ERR-04 仍需负责首包、空流、HTTP200 error、重试和转换器边界。

本报告不能替代 ERR-04/ERR-05 的六路由集成、安全矩阵、管理/Vertex/Legacy/DIAG 回归或最终代码复审。
