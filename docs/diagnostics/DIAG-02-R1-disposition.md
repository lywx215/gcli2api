# DIAG-02 R1 处置：待协调检查及精确 HEAD 复审

本文件保留 R1 历史处置；R2 指出的归因和结算缺口及最新修订见 [R2 处置](DIAG-02-R2-disposition.md)。

审查对象：`4d17a2b0260d594ace2d0fdd9df86e6d62c9add7`。只读审查来源：
`G:/code/gemini30/CLIProxyAPI/coordination/diagnostics/20260924/reviews/DIAG-02-R1/review.md`。
报告摘要写 7 项，正文实际列 P2-1 至 P2-8；以下按全部 8 项处置。修订 HEAD 由最终交付消息提供。

## P2 逐项处置

| 发现 | 处置与证据 |
| --- | --- |
| P2-1 | 已修复。Gemini 抗截断接入只传 `data`，字典检查及解包装在受保护的 `conversion_output` 内。真实路由生成器用 list/string 帧分别在 DEBUG 开/关运行，输出字节相同。测试仅替换抗截断处理器的帧来源以隔离该路由缺陷，不声称处理器支持任意输入。 |
| P2-2 | 已修复。已缓存响应的 JSON 观察、stream chunk 和 finish 都采用 best-effort；深嵌套、非对象及解析失败不会进入业务重试。清理失败不覆盖已经传播的读错误/取消；没有先前异常的真实清理取消仍传播。新增原始异常对象身份、字节透传和诊断失败注入测试。 |
| P2-3 | 已修复。call 在真实 EOF 更新所属 attempt 的 `http_eof`，所有已观察 call 都 EOF 才为 true，避免 redirect 的 EOF 掩盖最终响应提前关闭；有 HTTP 观察时不把业务迭代器结束充当 HTTP EOF。HTTP 429/503 为 upstream/dispatch；HTTP 200 中的应用错误帧为 upstream/unknown；真正解析失败为 parse；语义已结束但消费者在 DONE 停止为 local/read、eofSeen=false。完整读尽流及非流成功均有服务测试，且另测 HTTP 已 EOF、业务迭代器尚未耗尽的情况。 |
| P2-4 | 已修复。collector 只保存内部 summary；Gemini 未包裹分支补交付观察；OpenAI/Claude 由实际 converter 发事件。每个成功 server 精确断言 1 条、正确 outputProtocol 与 stream/nonstream/collected。三协议假流式在实际输出块处观察，标 pseudo_stream/clientStreaming=true，缺失 usage 保持未知。 |
| P2-5 | 已修复投影，未改业务公式。OpenAI nested completion_tokens_details.reasoning_tokens 读出 reasoning，completion_tokens 保持 candidate 数值；converted OpenAI/Claude 的 reasoningIncludedInOutput 为 false。真实流/非流测试覆盖 87 candidate 与 2、13 reasoning。另保留尾帧 usage 未实际交付时为 null 的断言。 |
| P2-6 | 按协调要求收窄结论，保留序号。冻结 README 66–69 的唯一 attemptNo 要求适用于没有 attemptId 的回退身份；现实现每次 retry owner 循环有独立随机 attemptId。真实两轮抗截断、各含一次 HTTP 503 重试，调用序号为 [1,2,1,2]，4 个不同 attemptId、同 server/retryScope，各 call 与 attempt 对应。DIAG-06 应按 resource/serverSpanId/retryScope/attemptId 去重，不按 attemptNo 汇总。测试发现成功轮次依赖 GC 关闭，已在处理器每轮 finally 关闭 body_iterator，并让预取包装传递关闭；未改续写或重试决策。 |
| P2-7 | 已修复。复用原 writer，每个公共文件上限 16 MiB，越限停止该路径写入；open/write/flush 失败触发进程内按路径熔断，后续不重复打开，每次拒绝计入 sinkDroppedTotal。测试验证精确字节上限、只读错误只 open 一次。没有自动删除任何文件。跨 boot 的保留/归档/清理由部署运维负责，单文件上限不是目录总配额；同一 boot 达上限后不会自动恢复。 |
| P2-8 | 已修复。全部依赖入口 pyproject.toml、requirements.txt、requirements-termux.txt 固定 httpx[socks]==0.28.1；Docker 使用 requirements，安装/启动脚本使用 uv sync。导入时核对版本、两个私有方法的参数名/种类/默认值与 async 形态；不匹配回退原 AsyncClient，并移除 http_outbound capability。回退不注入诊断头，也不声称有最终头剥离能力。测试覆盖签名变化和独立进程版本失配。 |

## P3 与覆盖边界

- 原始请求头改用 `.raw`，latin1 无损往返，保留大小写、多值、非 ASCII bytes；测试同时覆盖 peer/nonpeer。
- 诊断计时统一 `perf_counter()`；空字符串资源配置视为未设置。
- 收到 `http.disconnect` 才确认 client_cancel/client；单独 CancelledError 的来源为 unknown，仍原样传播取消。
- 观察失败按 span 的一次性标志在锁内记损失；Server 构造异常直通；终局写入失败仍重置 ContextVar。
- `http_outbound` 仅指共享 manager 下、属于活动 server 的请求；自建客户端与游离后台调用未覆盖。capability 不表示整个进程所有网络请求都可见。
- 验证共享 helper 的部分消费关闭、完整读取，以及抗截断每轮及时关闭；未增加 finalizer 或预读。POSIX fork 测试现真正开启 writer，检查父/子文件分离和父缓冲不在子进程刷出；Windows 上条件跳过，未宣称执行。
- 绝对路径是用户要求的本机 worktree/复现台账，保留。校验脚本改为显式异常，`python -O` 不会跳过检查。
- 假流式正常交付块已覆盖；异常提前返回的所有 converter 分支不声称完整。每帧的诊断 import 移到模块顶部。

## 供复审的源码证据

以下行号对应本轮修订文件；摘录省略不相关代码，可与本提交原文件逐项核对。

### 共享 HTTP helper：src/httpx_client.py:73、89

```python
async with http_client.get_client(timeout=timeout, **kwargs) as client:
    return await client.post(url, data=data, json=json, headers=headers)

async with http_client.get_streaming_client(**kwargs) as client:
    async with client.stream("POST", url, json=body, headers=headers) as r:
        if r.status_code != 200:
            yield Response(await r.aread(), r.status_code, dict(r.headers))
            return
        if native:
            async for chunk in r.aiter_bytes():
                yield chunk
        else:
            async for line in r.aiter_lines():
                yield line.encode('utf-8') if isinstance(line, str) else line
```

无合成 DONE；response 由 context manager 关闭，外层生成器提前停止时须显式传递 aclose。

### 抗截断：src/converter/anti_truncation.py:216、230、381

```python
while self.current_attempt < self.max_attempts:
    self.current_attempt += 1
    current_payload = self._build_current_payload()
    response = None
    try:
        response = await self.original_request_func(current_payload)
        # 原有逐帧处理、DONE 检查和续写分支保持不变。
    finally:
        if isinstance(response, StreamingResponse):
            close = getattr(response.body_iterator, 'aclose', None)
            if close is not None:
                try:
                    await close()
                except Exception:
                    pass
```

Gemini 包装在 `src/router/antigravity/gemini.py:253` 附近：首轮重用预取的 first_attempt_stream，后续重新调用 `stream_request`。内层 `src/api/antigravity.py:481` 循环每轮从 1 建 attempt。新增关闭只结算已存在的资源，不读额外帧。

### 假流式实际交付

`src/router/antigravity/gemini.py:162,209`、`openai.py:155,200`、`anthropic.py:160,205` 都先 await `non_stream_request`，再使用现有 `build_*_fake_stream_chunks`。以 OpenAI 为例：

```python
chunks = build_openai_fake_stream_chunks(content, reasoning_content, finish_reason, real_model, images)
conversion_input(gemini_response, 'openai_chat', mode='pseudo_stream')
for idx, chunk in enumerate(chunks):
    chunk_json = json.dumps(chunk)
    conversion_output(chunk, 'openai_chat')
    # 原有日志后，yield data: chunk_json。
```

不调用正常非流转换器来假设已交付 usage。`conversion_output` 观察实际块；未提供 token 数值的协议输出保持 null。

### token 公式：src/converter/openai2gemini.py:58–96

```python
completion_tokens = int(usage_metadata.get("candidatesTokenCount", 0) or 0)
usage = {
    "prompt_tokens": prompt_tokens,
    "completion_tokens": completion_tokens,
    "total_tokens": max(raw_total_tokens - cached_tokens, prompt_tokens + completion_tokens),
}
reasoning_tokens = int(usage_metadata.get("thoughtsTokenCount", 0) or 0)
if reasoning_tokens > 0:
    usage["completion_tokens_details"] = {"reasoning_tokens": reasoning_tokens}
```

Claude `src/converter/anthropic2gemini.py:214,1067` 同样只用 candidatesTokenCount 作为 output_tokens。OpenAI 流式 `openai2gemini.py:1961` 附近只在当前 choices 有 finish_reason 时附 usage；独立尾帧会被既有业务公式省略，诊断不能补造 deliveredUsage。

### 原有日志与依赖策略

`log.py:87–129`：旧文本文件 `_clear_log_file` 使用 `open(..., "w")` 在启动清空，`_open_log_file` 在 PermissionError/OSError 时设置 `_file_writing_disabled=True`；没有按大小轮转。公共文件现另有 `log.py:45` 的 16 MiB 上限及 `_write_diagnostic_line` 熔断，不改变旧文本策略。

审查 HEAD 的依赖为 pyproject.toml/requirements.txt 的 `httpx[socks]>=0.28.1`、requirements-termux.txt 的无界 `httpx[socks]`；本轮三处均锁到 `==0.28.1`。没有 uv.lock，也没有另一个直接 httpx 安装入口。私有 seam 检查和原客户端降级见 `src/diagnostics/http.py:138`。

## 验证与交付

最终命令、通过数和真实合成样例见 [交付台账](DIAG-02-delivery.md)。冻结契约保持 73 文件原字节，schema/capability 名称未扩展，无 manager/其他仓库配套动作。本轮没有 push、merge、部署、生产调用或额外模型审核；仍待协调窗口对新 HEAD 复审。
