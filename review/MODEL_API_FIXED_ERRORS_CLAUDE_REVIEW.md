1. 结论：**有条件通过**

上一轮对 Antigravity 的意见已经基本并入：首包判定、正文输出后不重放、Claude 保持 finishReason 结束、固定渲染器、不读到 EOF 都已处理。新增的 Gemini CLI 部分，方向和范围都对。还剩 1 个 P1 和 4 个 P2 需要在定稿时写清楚，没有需要推翻方案的问题。

---

2. 必须修订项

**P1-1 退役通知前缀缓冲会把正常的思考输出误判为 502**
- 位置：方案第 120–122 行；实际转换点在 `src/converter/anthropic2gemini.py:1101-1161`，OpenAI 和 Gemini 转换器同理。
- 触发场景：方案规定"在第一次展示文本之前"开启状态机，并暂存该候选的相关事件。上限按"原始事件 JSON 累计 4096 字节"计算，超限且仍可能匹配时返回固定 502。
  - 开了思考的模型（例如 includeThoughts 的 2.5 Pro / 3 系列，Antigravity 的思考模型），通常先输出几 KB 的 thought 事件，然后才出第一段正文。这时正文为空，按"尚可能匹配"处理，会被暂存并超出上限。
  - 另外，第一段正文如果带 thoughtSignature、usageMetadata 或 grounding 元数据，原始 JSON 也可能超过 4 KB，而此时正文可能只有 "Gem"。
- 后果：常见的正常思考响应被固定 502 替换。这正是用户要求"不能误伤"的情况。方案只把"工具/图片"列为非文本正文，没有说明 thought 和纯元数据事件怎么处理。
- 最小修订：
  - 不含展示文本的事件（只有 thought、只有 usage 或元数据）直接按原顺序放行，不计入上限，扫描器保持开启。之后才确认的通知按"已开始输出"处理：输出协议错误帧并终止。
  - 上限改为只按"展示正文字符数"计算。按方案自己的规则（开头空白 ≤64、名称 ≤128，加上固定短语），正文最多约 230 字符就一定能判定，上限本来就有保证。
  - 原始事件字节另设一个宽松的上限，只对"含未判定正文"的事件生效，超限才 fail-closed 返回 502。

**P2-1 完整事件模式需要规定统一的输出格式**
- 位置：方案第 86–88 行。下游依赖的格式：
  - `src/converter/anthropic2gemini.py:1031` 和 `src/converter/openai2gemini.py:1799-1805` 要求 `"data: "` 带空格；
  - `src/converter/anti_truncation.py:274` 同样要求带空格；
  - `src/router/geminicli/gemini.py:168,410` 在 real_model 等于 public_model 时原样透传；
  - `src/diagnostics/semantic.py:208-210` 用单行 `data:` 解析，属于冻结的 DIAG 契约；
  - `src/api/utils.py:424-428` 的收集器。
- 触发场景：方案支持"data: 后无空格"和"多条 data: 合并"，但没说事件交给下游时是什么形状。
- 后果：
  - 如果直接交出原始事件，Claude 和 OpenAI 转换器会静默跳过无空格帧，Claude 会得到一个空的成功消息。
  - 多行 data 在 Gemini 原生路由里原样透传给客户端，会成为非法 SSE 帧。
  - DIAG 会把这类事件记为 parse 失败。
- 最小修订：在 `httpx_client` 新增选项的契约里写明：
  - 每个数据事件只交出 `b"data: " + <单行 JSON 或 [DONE]> + b"\n\n"`；多行 data 合并后重新序列化为单行。
  - 不交出 event/id/retry/注释帧。
  - `event:error` 在解析层转成类型化错误对象，不作为字节交出。

**P2-2 路由直接返回的非 2xx 响应绕过了只捕获异常的边界**
- 位置：`src/router/geminicli/anthropic.py:363-381` 和 `src/router/antigravity/anthropic.py:365-383`，两个 count_tokens 都直接返回带 `f"JSON 解析失败: {str(e)}"` 的 JSONResponse。
- 触发场景：方案第 38–39 行只让 APIRoute 捕获异常，证据表也没有列出这些直接返回。
- 后果：动态异常文字和非统一文案会原样输出，与方案第 10 行的要求冲突。以后路由里新漏掉的 `return response` 也会绕过边界。
- 最小修订（二选一）：
  - 在受保护的 APIRoute 里加一道兜底：返回值不是 2xx 且没有经过 renderer 私有标记时，按状态码重新用固定文案渲染；
  - 或者把这两个 count_tokens 明确列入修改清单。
  - 推荐前者。

**P2-3 逻辑统计的"只计一次"需要改成硬性规则，而不是"必要时"**
- 位置：
  - `src/api/geminicli.py:851-865` 默认 `record_logical=True`；
  - 三个 Gemini CLI 非流式路由（`openai.py:124`、`anthropic.py:128`、`gemini.py:112`）和 Antigravity 同类路由都走这个默认值；
  - `src/router/stream_passthrough.py:46-56` 预取时抛出的非 StopAsyncIteration 异常不计数；
  - `src/logical_request_stats.py:100-106` 用两个子串判定通知。
- 触发场景和后果：
  - 非流式上游返回 200，但后续转换器抛异常，或新分类器判定为错误（例如只有首句、没有 "please switch to" 的退役通知）：API 层已经记了成功，路由再记失败就会重复计数，不记则统计错误。
  - 流式预取阶段抛异常：路由类返回固定 500，但完全没有计数。
- 最小修订：
  - 六个路由的非流式生成路径一律传 `record_logical=False`，由受保护路由根据最终渲染结果记一次。
  - 流式只由 `tracked_iterator` 记录；预取异常由路由类补记一次。
  - 用请求级标记防止路由和路由类重复记录。
  - 受保护路由的成功/失败以新分类器为准，不再用 `_payload_has_unavailable_notice` 判定。

**P2-4 "完全空流返回 502"与现有共享代码冲突**
- 位置：
  - `src/router/stream_passthrough.py:48-51` 返回 204，Vertex 也使用这段代码（`vertex/gemini.py:82`、`vertex/openai.py:130`）；
  - 各路由的 `except StopAsyncIteration: return` 同样导向 204；
  - `src/api/geminicli.py:488-543`：Gemini CLI 收到空的 200 流时，既不成功也不 need_retry，会进入下一轮立即重试，最后返回 503。
- 后果：
  - 如果直接改共享函数，会改变 Vertex 的行为，违反方案第 12 行。
  - 方案第 68、89 行"空流 502"的测试预期与 Gemini CLI 实际的 503 路径互相矛盾。
- 最小修订：
  - 给 `build_streaming_response_or_error` 加一个仅受保护路由启用的参数，空流时返回类型化 502。
  - 明确 Gemini CLI 空流的最终状态码：按第 48 行"维持 503"，或改为 502，二选一写进方案。
  - 不改变 Gemini CLI 现有的重试次数。

---

3. 方案已充分处理的关键点
- Gemini CLI 特有的泄露点都已列出：无凭证 503 带模型名、404 和非重试错误原样返回（含上游头和 3xx 的 Location）、正文输出后异常整轮重放（`geminicli.py:525-530`）、假流式把 `str(e)` 和 model 写进内容块、按行输出缺少 SSE 分隔符。
- 原始错误只用于内部分类、冷却和记录；对外 renderer 不接收 message 或 model；不解析 `str(e)`；上游 Retry-After 不转发；本地整数 Retry-After 保留。
- 首包判定跳过空行和注释；已开始输出后，三种协议各自的结束方式都已定义，Claude 输出 error 后不再有成功收尾。
- HTTP200 error 的判定规则与现有收集器一致：`{}` 和空字符串算错误，code 必须是 400–599 的 int，bool 不接受。
- 抗截断遇到错误立即结束、正文输出后不吞异常也不重试；Claude 保持 finishReason 立即结束并 aclose，不启用新续写，也不回到读至 EOF。
- 不注册应用级 exception handler，不影响管理接口的校验处理器；model_list、Vertex 和面板不变。

---

4. 额外必要测试（仅列方案中缺失的）
- 思考模型流：先有大于 4 KB 的 thought 事件，再出现 "Gemini is …" 正文，应正常返回 200，不能是 502。第一段正文带大 thoughtSignature 时同样不能被判为错误。
- 抗截断第二轮的首个事件是退役通知时，不能原文输出（前缀识别应按每次上游请求分别进行，而不是按客户端流只识别一次）。
- 上游使用 `data:` 无空格和多行 data 时，经过 Claude/OpenAI 转换器、抗截断、Gemini 原生透传、收集器和 DIAG `observe_stream`，结果应与单行帧一致，客户端收到的都是合法 SSE。
- 两个 count_tokens 在收到非法 JSON 或非对象 body 时，返回固定 400，不含动态文字。
- 统计：非流式上游成功但转换器异常、预取异常、只有首句的通知，都只记一次失败；正常回答里引用通知的两个短语，记为成功。
- Vertex 空流仍然返回 204。

---
我只读取了源码和方案文件，没有运行任何测试或命令。

审核模型：Claude Opus 5.5（claude-opus-5-5）
