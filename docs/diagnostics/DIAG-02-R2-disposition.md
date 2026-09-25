# DIAG-02 R2 处置：待精确 HEAD 复审

审查对象：`2e15a902cbe0e61b5f046d22bd95a1939e8519bd`。协调窗口报告 Claude 实际模型为 `claude-opus-5-5`，结论 request_changes，0 P1 / 2 P2。
完整报告只读来源：`G:/code/gemini30/CLIProxyAPI/coordination/diagnostics/20260924/reviews/DIAG-02-R2/review.md`。
本轮未调用模型审核；最终本地修订 SHA 以交付消息为准，R1/R2 的 request_changes 均不作为通过。

## 先复现再修复

在审查 HEAD 的生产代码上先新增 `test_diagnostics_r2.py`，运行隔离命令：

```powershell
$py = 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe'
$env:PYTHONPATH = Join-Path $env:TEMP 'gcli-diag02-validation-deps'
& $py scripts/run_diagnostic_tests.py test_diagnostics_r2.py -q --tb=short
```

结果为 **14 failed / 27 passed**：P2-A 5 个归因组合失败，P2-B 8 个强引用保留生成器用例缺少 attempt 终局，另有 1 个真实服务测试复现 P3 假流式错误标签。应用修复后原 41 项全部通过；随后增加 holder 释放/门控、Claude 占位 usage 和非 2xx 提前返回等测试。

## P2-A：DONE 不构成语义成功证据

仅当原语义结果为 success、缺 HTTP EOF 是唯一不足时，才降为 incomplete/local/read。没有 finishReason 的 incomplete 在无 DONE 且无 EOF 时为 unknown/read；带 DONE 的 incomplete、已观察到的 blocked/empty 保持 upstream/unknown。HTTP 429/503 仍为 upstream/dispatch，HTTP 200 错误帧为 upstream/unknown，真实解析失败为 upstream/parse。

`src/diagnostics/semantic.py:270–288` 中的决定分支现在是：

```python
elif not eof and semantic_result == 'success': origin, stage = 'local', 'read'
elif not eof and semantic_result == 'incomplete' and not self.done_frame: origin, stage = 'unknown', 'read'
```

32 个单元组合显式设置 HTTP EOF 观察标志，覆盖 success/empty/blocked/incomplete/parse/HTTP429/HTTP503/200错误帧 × 有无 DONE × 有无 EOF，并同时断言 resultClass、failureOrigin、failureStage、eofSeen、errorClass。真实 collector 服务测试补充 SAFETY 场景，并对 empty/blocked/incomplete 的归因作明确断言，不再跳过 incomplete。

## P2-B：在 server 封存之前保守结算

生产修改仅限三个诊断模块：`semantic.py`、`runtime.py`、`asgi.py`。没有增加业务路由接点，也没有修改 R1 的资源关闭、重试或转换公式。

- `Server.open_attempts` 是每个请求的未完成观察集合。只有开始时满足 DEBUG 门控的 attempt 登记；正常结束或观察失败都在 finally 移除。它不保存已完成历史，也不创建业务 retry、span、任务或新队列。
- `Attempt.finish` 在 server 的 RLock 内一次性结算并移除 holder，重复 finish 为 no-op；即使观察抛异常也会移除，并由既有 best-effort 记录损失。
- ASGI 终局顺序为 `finish_conversions(server)` → `finish_attempts(server, delivery == 'cancelled')` → `diag.server`。holder 只结算现有数值观察，不执行 aclose、不消费额外帧、不等待业务清理。
- 未观测到 EOF 就保持 false；缺 EOF 的语义成功只能是 incomplete。只有实际收到 disconnect 才标 client 来源；单独任务取消为 unknown。服务器其他业务异常不冒充上游 transport error。
- 已结算的 attempt 不因迟到的关闭/EOF 被重写；独立 call span 可以晚于 server 终局写出自己的 EOF/closed_early 记录。分析端不能因此跨 span 比较 logSeq 大小。

确定性测试持有 `observe_stream` 生成器的强引用，不允许 GC 结算。覆盖正常结束、任务取消、已观察断开、原始业务异常，并分别在 server 封存后主动关闭或继续读到 EOF：每个 attempt 恰好结算一次，转换和 attempt 的 server-span logSeq 都在 diag.server 前；迟到动作只增加一条 call 终局，原始异常对象及业务字节保持不变。另验证 50 次顺序 attempt 不积累历史、观察失败可释放 holder、DEBUG 中途关闭后无补采。

真实服务测试覆盖 **3 协议 × 流/非流 × 普通/抗截断 × collector/原生非流配置**，每个 server 都核对准确 attempt/call 数、ID 对应和封存顺序。此 fixture 没有业务 `[done]`：Gemini/OpenAI 抗截断流式实际跑 3 轮；Claude 既有转换器在首个 finishReason 停止，只观察到 1 轮。非流式前缀不启动抗截断。测试按这些既有行为断言，不臆造后续 attempt。

源码核对：`src/api/antigravity.py:484,495,601–604` 为既有内层 retry owner、observe_stream 接入及关闭；`805,809` 为非流 observe_post。普通 OpenAI 在 `src/router/antigravity/openai.py:359` 的 DONE 分支返回；Claude 在 `src/converter/anthropic2gemini.py:1260` 的 finishReason 分支退出。即使外围关闭任务晚到，本轮 holder 也不依赖其时序。

## P3 按证据处置

| 建议 | 本轮处置 |
| --- | --- |
| 假流式错误标签 | **已证实并修复诊断门控**。非 2xx 两个 converter 确实早返回且不发事件，新增测试确认；但原生非流上游 HTTP 200 的 `error` 对象会进入两个 converter 尾部，真实服务复现了 nonstream 错标。`converted` 对 error summary 不发转换事件，保留基础及 attempt 错误证据；业务响应不变，不猜测已交付协议 usage。 |
| Claude message_start 的 0 | **保留并说明**。`anthropic2gemini.py:988,1010,1075–1090` 的实际交付占位 output_tokens=0 可以记录为 source=converted。测试停止于真实 message_start，确认 deliveredOutputTotal=0/converted，而缺失的 upstream candidate 仍为 null/unknown。0 不是模型实际产出 token 数的证明。 |
| HTTP503/errorClass | 保留 other，不推测 capacity。归因矩阵覆盖。 |
| attemptNo | 维持 R1 结论；DIAG-06 按 attemptId 身份计数，不按 attemptNo 聚合。 |
| flush 丢失计数 | 现有失败计数可能少于缓冲中实际丢失记录数，仅作已知损失下界；不在此轮扩展 writer 或冻结事件。 |
| 16 MiB 硬停止 | 本批不部署，保留明确限制；生产启用前必须处理容量/保留策略。近上限只能提示疑似截断，不能断言确定丢失。详见交接说明。 |
| httpx / POSIX | 未来部署审批须核对现网实际解析版本；若不是 0.28.1，精确锁定的升级/降级影响必须明确。Windows 未执行 POSIX fork 及 Linux fork/writer 竞争路径，部署前另行实测；不把条件测试存在视为实跑通过。 |

## 交付证据

最终隔离专项/全量回归、冻结字节校验和真实样例结果见 [交付台账](DIAG-02-delivery.md)。生产改动没有越出三个诊断模块；harness/test/docs 仅用于复现和证据。冻结契约、capability、panel-version 保持不变。

DIAG-06/07 的日志容量与证据缺口要求见 [交接说明](DIAG-06-07-handoff.md)。本轮没有推送、合并、部署或自动启动后续工作；等待协调窗口和 Opus 5.5 对新 HEAD 复审。
