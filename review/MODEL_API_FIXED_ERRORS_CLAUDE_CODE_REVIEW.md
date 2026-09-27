# 模型 API 固定英文错误：Claude 代码审核实录

最终结论：2026-09-27 本组第 3 轮真实 Claude 代码复审通过，findings=[]。完整隔离回归 1143 passed、1 skipped、6 warnings；ERR-05 完成。以下前两组记录按历史保留，以本文末尾最终复审为准。

日期：2026-09-27。仅对应 `C:/Users/lywx2/.codex/worktrees/14f9/gcli2api` / `dev0926`。

## 上一组实际调用与结论（历史）

用户本次明确发送“继续 Claude 审核”后，使用已配置的共享 Hook 与实际 Claude CLI（`claude-opus-5-5`），没有另建审核脚本。

1. 第 1 次：方案审核，指出 review.json 缺少维护范围文档。已增加显式路径。
2. 第 2 次：方案审核通过，findings 为空。
3. 第 3 次：代码审核返回下列 9 项 findings；不是通过结论。

共享状态：plan=2、code=1、total=3，awaiting_confirmation=code。已达到本组上限；未重置轮次，未进行第 4 次调用。修复后的工作区尚未由 Claude 复审，ERR-05 保持 in_progress。

方案批准摘要：`e1445f84b5114840e0d89d4f0f4d1fdccef18abeb99a0ff2810d2157396922c2`。

代码审核快照摘要：`b3af258217c5c3f847cf5578bb519bf5437cd24a1ceb006ac97d964282fe0921`。该摘要对应修复前快照，不是当前文件摘要。

流程恢复记录：首轮修正 review.json 后，未变动方案的 Stop 被同摘要保护跳过（未调用模型）；补写本轮 finding 的方案处理记录，并在保留计数/历史/批准信息的前提下恢复 active，随后完成第 2、3 次真实调用。没有把跳过计入模型调用或伪造审核结论。

## 原始结构化返回

以下保留本组三条 Hook history 的结构化内容（时间由 PowerShell 转换为本地 +08:00 表示），finding 文本未改写：

```json
[
  {
    "time": "2026-09-27T11:44:46.806703+08:00",
    "stage": "plan",
    "digest": "b2895501e83d110bc2ea2b02fc707696df577e2e0e539a371f0d11ce74066e2d",
    "findings": [
      {
        "file": ".codex/review.json",
        "issue": "Line 8: the deliverable pattern `*.md` only matches Markdown files in the repository root, so it does not match `docs/MAINTENANCE_SCOPE.md`. That file is modified in the working tree, and `.codex/review-plan.md` lines 7 and 14 say the reviewer must check it for the preserved Gemini CLI stop-maintenance text and the limited authorization exception. As configured, the code-stage review will not list that file as a deliverable. Fix: add `docs/**/*.md`, or the explicit path `docs/MAINTENANCE_SCOPE.md`, to the deliverable patterns."
      }
    ],
    "error": null
  },
  {
    "time": "2026-09-27T11:45:52.014841+08:00",
    "stage": "plan",
    "digest": "e1445f84b5114840e0d89d4f0f4d1fdccef18abeb99a0ff2810d2157396922c2",
    "findings": [],
    "error": null
  },
  {
    "time": "2026-09-27T11:48:26.660915+08:00",
    "stage": "code",
    "digest": "b3af258217c5c3f847cf5578bb519bf5437cd24a1ceb006ac97d964282fe0921",
    "findings": [
      {
        "file": "src/router/model_api_errors.py",
        "issue": "Lines 609-610: ProtectedModelApiRoute skips all protection for any path ending in count_tokens/countTokens. Plan v3 §3.1 says the two Claude count_tokens handlers that return 400 JSONResponse directly must go through the non-2xx fallback, with the status staying 400. Because of the bypass, raw dynamic text reaches clients: src/router/geminicli/anthropic.py:385 and src/router/antigravity/anthropic.py:387 return `JSON 解析失败: {str(e)}`, and src/router/geminicli/gemini.py:477 and src/router/antigravity/gemini.py:454 raise HTTPException(detail=f\"Invalid JSON: {str(e)}\"), which goes to the default app handler. Keep count_tokens out of the logical statistics, but still re-render its errors with the fixed text. tests/test_model_api_error_matrix.py:297 only checks a 200 path, so nothing tests this."
      },
      {
        "file": "src/router/geminicli/anthropic.py",
        "issue": "Lines 244-247 (same code in src/router/antigravity/anthropic.py:247-248): in the Claude fake-stream generator, an HTTP-200 error or retirement notice yields `render_error_event(...)` and then `data: [DONE]`. Plan §4 says a Claude error sends event:error and then closes, with no success tail or [DONE]. Also, this error is detected before anything has been yielded, so it becomes the first stream item and build_streaming_response_or_error commits HTTP 200. Plan §4 requires the error to be rendered as protocol JSON with its error status (for example 404 for retirement) before headers are sent."
      },
      {
        "file": "src/router/geminicli/openai.py",
        "issue": "Lines 240-242 (same in src/router/geminicli/gemini.py:283-285, src/router/antigravity/openai.py:241-242, src/router/antigravity/gemini.py:257-258): fake-stream HTTP-200 error and retirement detection happens before any chunk has been yielded, but the code catches ModelApiErrorException and yields an SSE error event. That event becomes the prefetched first item, so the client gets HTTP 200 with an error event instead of the JSON error with status 404/4xx/5xx that §4 requires. Re-raise the exception instead so build_streaming_response_or_error or the route class can render it before the response is committed. Tests only cover HTTP-200 errors on the non-stream path (tests/test_model_api_error_matrix.py:159-185), so the fake-stream path is not tested."
      },
      {
        "file": "src/api/antigravity.py",
        "issue": "Plan §3.2/§3.3 requires the backends to classify caught timeout exceptions as TIMEOUT (504). Nothing produces ErrorKind.TIMEOUT: a grep finds no Timeout handling or attach_model_api_error call anywhere in src/api or src/router. Antigravity stream exceptions end with build_error_response(..., 500) (line 704) or the last error. Gemini CLI (src/api/geminicli.py:573,580) ends with 503. So an upstream timeout reaches clients as 500 INTERNAL_ERROR or 503, not 504 REQUEST_TIMEOUT. No test covers a real timeout exception."
      },
      {
        "file": "src/api/geminicli.py",
        "issue": "Lines 93-97, 118-122 and 129-133: local capacity-breaker and cooldown 503 responses carry a locally computed Retry-After, but they are returned as plain Responses without attach_model_api_error. ProtectedModelApiRoute then re-renders them as origin=UPSTREAM with no retry_after (model_api_errors.py:639-646), so render_error drops Retry-After. Plan §3.4/§6 requires the local integer Retry-After to be kept. The same applies to src/api/antigravity.py:93. attach_model_api_error is defined but never called."
      },
      {
        "file": "src/api/antigravity.py",
        "issue": "Line 868: an empty HTTP-200 non-stream body, including the collector path, still returns build_error_response(\"服务返回空回复\", 500), which renders as 500 INTERNAL_ERROR. Line 654 does the same for the non-events stream path. Plan §3.2 says an empty Antigravity stream or a collection with no data must be treated as bad_format and returned as 502 INVALID_SERVICE_RESPONSE."
      },
      {
        "file": "src/router/geminicli/gemini.py",
        "issue": "Lines 147-166 (same in src/router/antigravity/gemini.py:149-168): the non-stream native Gemini path returns the raw upstream `response` object whenever the 200 JSON has no `response` key. A JSON array or string (`\"response\" in list/str` is False) is therefore passed through verbatim. Antigravity also forwards all upstream headers (src/api/antigravity.py:876-879). Invalid JSON raises a generic exception and becomes 500. Plan §3.3/§4 requires non-object or invalid JSON payloads to become a fixed 502 and never be passed through. The OpenAI and Claude non-stream paths also map JSON parse failure to HTTPException(500) (src/router/geminicli/openai.py:172-174, src/router/geminicli/anthropic.py:176-178) instead of 502."
      },
      {
        "file": "src/router/stream_passthrough.py",
        "issue": "Lines 96-97: tracked_iterator still decides failure with stream_item_is_error/stream_item_has_body from src/logical_request_stats.py:75,96. Those functions use the two-substring retirement heuristic (_payload_has_unavailable_notice). Plan §6 forbids this heuristic and says an ordinary answer that quotes the notice must be counted as a success. Such a stream is currently recorded as failed. stream_item_is_error also reads only the last data line, so the combined OpenAI error+[DONE] event is not recognized as an error."
      },
      {
        "file": "src/router/model_api_errors.py",
        "issue": "Lines 232-236: every StarletteHTTPException, including 401/403 from the local authenticate_bearer/authenticate_gemini_flexible dependencies, is classified as origin=UPSTREAM. A real client authentication failure therefore gets SERVICE_ACCESS_ERROR ('contact the service administrator'), server_error/api_error types and no WWW-Authenticate. Plan §3.3/§3.4 reserves AUTHENTICATION_FAILED/ACCESS_DENIED plus authentication_error/permission_error for local client auth. No router wraps the auth dependency to raise the typed CLIENT error, so the CLIENT branches are never used on real routes."
      }
    ],
    "error": null
  }
]
```

## Codex 修复处置（不是 Claude 复审结论）

| Finding | 处置 | 回归证据 |
| --- | --- | --- |
| 1 计数接口绕过脱敏 | 删除路径旁路，统计仍仅显式激活 | 两后端 Claude/Gemini 非法计数输入 400、固定文案、零生成统计 |
| 2 Claude 假流式错误尾帧 | 提交前重抛类型化异常，不产生 SSE/[DONE] | 假流式 HTTP-200 error 与退役均返回对应错误 JSON |
| 3 其他假流式首错误 | 六路由统一提交前错误边界 | 2×3×2 预提交格式/嵌套/error 矩阵 |
| 4 超时分类 | 终局捕获 httpx 超时，附私有 TIMEOUT；正常重试预算与 Antigravity 已有最后 HTTP 错误优先级保留 | 两后端真实 ReadTimeout 注入，非流/流各两次尝试，保护出口 504 |
| 5 本地 Retry-After | 本地计算值附 LOCAL 私有元数据；上游头不被信任 | 三模式/三协议/两后端的本地保留与上游丢弃矩阵、真实 breaker 函数 |
| 6 空响应/collector | 空 nonstream 附 BAD_FORMAT；受保护 collector 显式 events=True/protected=True，保留类型 | 空响应、纯 DONE 预算耗尽、collector 空/坏 JSON/超时/类型化错误 |
| 7 非法 JSON/非对象 | 转换前集中解析及包装校验；Native Gemini 成功也重建响应 | 数组、字符串、坏 JSON、非法 response 包装 502，无上游头泄漏 |
| 8 流统计启发式误判 | 受保护流不使用退役短语启发式，检查全部 data 行 | 普通引用成功、error+[DONE] 合并帧失败且只计一次 |
| 9 本地鉴权来源 | 六路由局部包装原鉴权依赖，仅其 401/403 标 CLIENT | 真实缺失/错误 key 路径、固定认证/权限文案、WWW-Authenticate、零统计 |

补充发现并修复：顶层 error 优先于 response、两层包装错误、error:null 放行、EOF 退役缓冲释放、纯 DONE 不提前提交 200、完成识别后的 usage 尾帧保留、Gemini CLI 迭代器关闭。ERR-02 独占实现/测试/报告未编辑。

诊断兼容修复：保留 Native Gemini 的 converted 记录；类型化模型错误按语义错误而非传输读错误记账；仅改运行时代码与回归测试，未改冻结 contracts/diagnostics/v1。

本地鉴权包装是 opt-in；测试需要覆盖依赖时使用路由导出的包装函数或 protect_authentication(original)，不再将原 utils 别名用作六路由的 override key。原 utils 函数、模型列表/管理/Vertex 等未接入路由不变。

测试执行过程和最终结果见 `review/tasks/ERR-05.md` 与 `review/MODEL_API_FIXED_ERRORS_DELIVERY.md`。再次 Claude 复审需用户发送“继续 Claude 审核”。

## 2026-09-27 再次继续：第 1 轮代码审核

本轮直接复审当前代码，没有变更已批准计划或重复方案审核。真实 Hook 返回如下，当前组 code=1/total=1；本次 2 项 findings 均已确认。

```json
{
  "time": "2026-09-27T05:14:40.946649+00:00",
  "stage": "code",
  "digest": "862e688b9f48ead1ced53ef413c848b5d20685daa7c1f2d81f72d2c57a722204",
  "findings": [
    {
      "file": "src/router/geminicli/openai.py",
      "issue": "Line 123 (the same pattern is at src/router/geminicli/anthropic.py:127 and src/router/geminicli/gemini.py:121): non-streaming requests now set request.state.model_api_model to public_model, and the route-level completer records that name. Before this change, non_stream_request recorded body['model'], which is real_model (src/api/geminicli.py:913-915). The streaming paths in these same routers still pass model_name=real_model to build_streaming_response_or_error (openai.py:400-405, anthropic.py:360-365, gemini.py:457-462). For any Code Assist alias where normalize_geminicli_model_alias changes the name, logical request statistics are therefore now split across two model keys depending on streaming mode, and the non-streaming key differs from its previous value. That is an unintended change to logical statistics, which the plan's §6 requires to stay one consistent count per request. Fix: record real_model for non-streaming as well, or public_model for both paths, and add a test that uses an alias."
    },
    {
      "file": "src/router/antigravity/gemini.py",
      "issue": "Line 121 sets model_api_model = get_base_model_from_feature_model(model), which is the name before the alias is applied. The streaming routes in the same file (lines 434-439), antigravity/openai.py:122 and antigravity/anthropic.py:127 all use real_model, which is normalize_antigravity_model_alias(...). The previous key recorded by non_stream_request was body['model'], also real_model (src/api/antigravity.py:1035-1037). As a result, Antigravity Gemini-native non-streaming statistics for aliased models are recorded under a different key than the streaming path and the other two Antigravity protocols. Fix: use real_model here too."
    }
  ],
  "error": null
}
```

处置：Gemini CLI 三协议与 Antigravity Gemini-native 的非流式统计键改为 real_model，与既有底层/流式统计保持一致；不改变公开响应模型字段。新增 48 项别名矩阵（两后端×三协议×四模式×成功/失败），每条断言只有一个归一化模型计数。别名矩阵所在测试文件与 logical_request_stats/gemini35_tier_routing/antigravity_model_catalog 联合运行：306 passed、5 warnings。完整回归已通过 1107 passed、1 skipped、6 warnings（65.17s）；修复后代码尚待本组下一轮复审。

## 2026-09-27 再次继续：第 2 轮代码审核

真实 Hook 返回如下。本组 code=2/total=2，仍有 1 次可用复审；没有将第一轮修复测试通过冒称代码通过。

```json
{
  "time": "2026-09-27T05:21:07.683914+00:00",
  "stage": "code",
  "digest": "e02f01cfbb9211aed8673711cd80aad57416a3ca53a3a39a7fede43eb49ceddc",
  "findings": [
    {
      "file": "src/converter/anti_truncation.py",
      "issue": "Lines 253-260: when a later anti-truncation round's `stream_request` yields an error `Response`, the code rebuilds the error with `error_from_http_status(line.status_code)`. That drops the private typed error attached by `attach_exception_error` / `local_retry_response`. For example, if Gemini CLI times out on every retry in round 2, the API layer returns a 503 wire response carrying a TIMEOUT error. This code reclassifies it as 503 SERVICE_UNAVAILABLE instead of 504 REQUEST_TIMEOUT. For Antigravity (`src/api/antigravity.py:709`, 500 wire response) it becomes INTERNAL_ERROR, and a typed BAD_FORMAT is lost the same way. This breaks the v3 §3.2 rule that final outputs use 504/502 from the saved internal type. Fix: use `get_attached_model_api_error(line) or error_from_http_status(...)`. Apply the same fix to the mid-stream Response→exception conversions in `src/converter/anthropic2gemini.py:1026-1029`, `src/router/antigravity/{openai.py:361-364,gemini.py:390-393,anthropic.py:340-343}` and `src/router/geminicli/{openai.py:360-363,gemini.py:415-418}`."
    },
    {
      "file": "src/api/geminicli.py",
      "issue": "Line 67 (`_build_no_available_credential_response`, used by `_build_smart_pool_response` at lines 72 and 102): when no credential is available it still returns HTTP 500, which protected routes render as INTERNAL_ERROR (\"An internal error occurred…\"). The same happens in `src/api/antigravity.py` at lines 430, 675-682, 774 and 987-995. The v3 §3.3 table requires 503 SERVICE_UNAVAILABLE for an empty credential pool, cooldown or circuit breaker. Only the tier-restricted Gemini CLI branch gets 503 today. Fix: attach a LOCAL 503 typed error to these responses, or return 503."
    },
    {
      "file": "src/api/geminicli.py",
      "issue": "Lines 424-430, 470-476 and 772-778 (and `src/api/antigravity.py:561-567`, 936-942): the prefetched `next_cred_task` created with `asyncio.create_task` is never cancelled. This happens when the generator is closed or cancelled (client disconnect during `_switch_credential_for_retry` sleeps or the upstream read), and on terminal paths that return right after creating it (e.g. `should_retry` False while `attempt < max_retries`, or a `ModelApiErrorException` re-raised at line 568). Plan v3 §5 requires releasing prefetched credential tasks on cancel/close. Fix: add a `finally` that cancels any pending `next_cred_task`, and add a test for it."
    },
    {
      "file": "tests/test_model_api_error_matrix.py",
      "issue": "Lines 237-273 (`test_postcommit_error_is_terminal_without_replay_or_success_tail`): the test replaces `api.stream_request`, so it never exercises the Gemini CLI API-internal no-replay fix (`src/api/geminicli.py:572-576`, the `geminicli.py:525-536` issue in plan §2). Only Antigravity has an API-level replay test (`test_antigravity_stream_replay.py`). No test covers the anti-truncation layer either: later-round error or exception after output, a round-2 retirement notice, or a round-2 typed timeout. Plan §5 requires no-replay tests for both the API-internal and anti-truncation layers, and §6/§7 require anti-truncation later-round failure and round-2 retirement cases. Add a Gemini CLI `stream_post_async`-level test (data event then exception → exactly 1 upstream call) and anti-truncation round-2 tests for both backends."
    }
  ],
  "error": null
}
```

逐项处置：

1. 新增 error_from_response，所有六路由、Claude 转换器及抗截断 Response→exception 边界优先读取私有错误类型；超时/坏格式不因 legacy wire 状态丢失。
2. 空凭证池的原响应附 LOCAL 503 元数据，未接入保护的旧调用 wire 保持不变。Antigravity 切换失败分支只产生一条响应，移除原重复/不可达返回。
3. 两后端流式/非流式重试范围增加 finally，结束时取消并等待未消费的 next_cred_task；使用 gather(return_exceptions=True) 消费子任务异常，同时保留父请求取消传播。
4. 新增两后端 stream_post_async 层正文后异常只调用一次；真实 API 接抗截断处理器的第二轮 timeout/bad_format/HTTP error/retirement 均终止且不发第三轮；补六路由正文后私有错误类型矩阵，以及预取任务 return/close/cancel 阻塞测试。

定向回归：tests/test_model_api_transport_errors.py 与 tests/test_model_api_error_matrix.py 合计 312 passed、5 warnings。完整回归 1143 passed、1 skipped、6 warnings（65.43s），修复后等待第 3 轮代码审核。仅清理空白行行尾空格，不改变语义。

## 2026-09-27 再次继续：第 3 轮代码审核通过

原始 Hook history：

```json
{
  "time": "2026-09-27T05:31:41.467239+00:00",
  "stage": "code",
  "digest": "8d8ff44609431d5c690c06a3db0a63b074a1264d6566618adf67fbff9b5f3911",
  "findings": [],
  "error": null
}
```

实际 Stop 返回：

```json
{"decision":"block","reason":"Claude approved the code review. Report the delivered files, verification results, and review outcome to the user."}
```

本组实际进行了 3 次代码审核、0 次方案审核。第 1 轮 2 项、第 2 轮 4 项问题均已修复，第 3 轮 findings=[]，error=null。共享 Hook 自动记录 approved_code 并将 active=false、total=0（通过后的内建重置）；code=3 与历史仍保留。未手动设置批准或篡改轮次。

批准的交付快照摘要：`8d8ff44609431d5c690c06a3db0a63b074a1264d6566618adf67fbff9b5f3911`。

源码/测试独立摘要（共享 signature，src/**/*.py、tests/**/*.py、test_*.py 共 117 文件）：`028431889e9a8f26433a67c5b1e101098f7e6c5dd8c72ace22ff5f9116c3340f`，第三轮前后完全一致。

完整隔离回归：1143 passed、1 skipped、6 warnings（65.43s）；空白清理后定向复跑 312 passed（5.43s）。73 个冻结契约文件哈希一致，git diff --check 通过。未跟踪/被忽略测试已由共享 glob 纳入审查，不依赖 Git diff。

审核结束后仅保存本节原始结果并更新任务/交付状态，没有再修改源码或测试。故全交付摘要因本次审计记录新增而变化，不将新增报告字节冒称已被 Claude 阅读；实际批准的代码/测试快照与当前一致。ERR-05 标记 done。不提交、推送、部署或调用生产服务。
