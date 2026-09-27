# Antigravity + Gemini CLI 模型 API 固定错误方案

状态：实施方案 v3，2026-09-27 更新英文错误契约与任务安排。v2 架构经 Claude Opus 5.5 第二轮复审通过，无剩余 P1/P2；该结论不代表 v3 新增文案/映射已复审，更不代表实现已完成。历史审核报告见同目录 MODEL_API_FIXED_ERRORS_CLAUDE_REVIEW_R2.md（第一轮为 MODEL_API_FIXED_ERRORS_CLAUDE_REVIEW.md）。v3 增量复审及最终代码复审列入实施门禁，任务见 MODEL_API_FIXED_ERRORS_TASKS.md。
基线：dev0926 / 0b3a07e，2026-09-27。

## 1. 已确认需求和范围

- 用户明确要求 Gemini CLI 也做同样的错误输出保护。本次是对既有停止维护约束的有限例外，仅恢复这项修复，不恢复其他 Gemini CLI 或 MGMT 待办。
- 只保护模型 API：两种后端各自的 OpenAI、Claude、Gemini 生成/流式/计数接口，共六个模型路由器。
- 错误必须由本地固定英文文案构造，不能包含任何模型名称、Google 原始错误、动态异常文字或请求输入回显。英文字符串逐字以第3.3节为准，不能运行时翻译或拼接动态字段。
- 成功内容、成功响应中的 model/modelVersion、模型列表和现有公开别名保持现状。管理员面板、凭证错误记录、额度和日志保留原始诊断能力。
- Vertex、管理接口、面板、冻结诊断契约不改变行为。没有数据库迁移、生产调用、部署或 Git 提交/推送步骤。
- 用户进一步明确：HTTP200 的已知模型退役通知也必须替换，不能原文输出以免泄露模型名；按第7节在输出前识别，普通生成内容保持现状。

## 2. 检查证据

| 位置 | 当前问题 |
| --- | --- |
| src/api/geminicli.py:51-58 | 无可用凭证的本地 503 提示直接写出模型名和订阅类型 |
| src/api/geminicli.py:429-472,676-680,818-829 | 部分 404 和其他 HTTP 错误保留原始体/响应头并返回 |
| src/api/geminicli.py:525-536 | 已经输出流内容后仍可因异常重试，路由外层无法阻止内部重放 |
| src/router/geminicli/gemini.py:114-129,363-416 | 非流式错误、首包错误、流中错误/非法数据原样返回；按行输出缺少 SSE 分隔符 |
| src/router/geminicli/openai.py:179-189,207-221 | HTTP 200 错误被送入成功转换；假流式异常用包含 model 的普通内容块返回 |
| src/router/geminicli/anthropic.py:218,299-320 | 动态异常文字和首包透传；错误再次经过成功转换器可能丢失 |
| src/router/antigravity/{openai,anthropic,gemini}.py | 同类首包透传、动态异常、HTTP 200 error 和流中错误问题 |
| src/converter/openai2gemini.py:1610-1627 | 非 2xx 直接提取原始 message，无 message 则 stringify 整个响应 |
| src/converter/anthropic2gemini.py:820-837,1260-1321 | 同类原始 message；finishReason 立即结束；异常事件含 str(e) |
| src/converter/anti_truncation.py:246-259,291-318,366-380 | 原始错误作为 message 输出、错误后续写、正文后异常吞掉重试 |
| src/management/router.py:189-199,230-235 | 已有应用级校验处理器，不能用新的全局 handler 覆盖 |

本轮临时隔离测试：36 个 Gemini CLI 路由组合（三协议×四模式×HTTP400/HTTP200 error/异常）加 1 个无凭证错误检查通过，另1项API内部测试确认正文后异常导致2次请求和2份重复正文，共38项复现检查通过。是复现现有行为的测试，不是安全验收；路由矩阵mock位于模型API层，重放测试mock位于HTTP调用层，均未请求真实Google。12 个 HTTP400 组合均保留原始错误文字；10 个还保留模拟上游头。HTTP200 error 的 Gemini 路径仍泄露，其余协议出现空成功响应。之前 Antigravity 的本地回环测试结论继续有效。

## 3. 架构与错误分类

### 3.1 六个路由器统一启用，其他入口保持原状

- 新建 src/router/model_api_errors.py，提供不可变内部错误描述、固定文案、协议 renderer、受保护 APIRoute 和流错误适配器。
- 在六个生成/计数路由器使用协议明确的 APIRoute 子类；不注册应用级 exception handler，不改公共认证函数，不给 model_list 路由器启用该类。
- get_route_handler 捕获路由返回前的 RequestValidationError、HTTPException、Exception。请求校验固定 422，不返回 errors/input/ctx/动态 loc。
- route handler也检查直接返回的非2xx Response：没有本地renderer私有标记就按状态/私有origin重新渲染，不能仅捕获异常。两个Claude count_tokens直接返回400 JSONResponse以及未来遗漏的return response都必须经过此兜底。私有标记不能来自上游JSON/头；计数接口既有非法JSON/非对象的400保持400。
- 已开始 StreamingResponse 的异常必须由生成器适配器捕获；只捕获 Exception，取消、GeneratorExit 原样传播，finally 只关闭资源，不 yield。
- 框架未匹配路由的 404/405 使用已有固定错误，属于路由类之外的边界；测试确认无输入回显，不增加全站重写。

### 3.2 内部原始信息与对外错误严格分开

- 内部错误描述仅含 origin（client/upstream/local）、kind（http/timeout/bad_format/local）、status、可选本地整数 retry_after。外部 renderer 不接收任意 message 或 model 参数。
- API 层继续先用原始错误做已有重试、冷却、禁用分类和记录。对本地生成的 Response 附私有类型信息（或等价类型包装），不通过响应头传递，不解析 str(e) 关键词猜类型。
- Antigravity 和 Gemini CLI 在捕获具体 TimeoutException、解析失败时保存类型，最终出口据此使用 504/502。保留有既存最终 HTTP 错误时优先返回最后错误的既有选择，不重写正常重试策略。
- Gemini CLI 某些重试分支本来把上游错误转成 503：维持该最终 503，固定文案统一为本地 503 提示，不强行恢复最初上游码。
- 空流单独定义：Gemini CLI各轮均为HTTP200但无有效数据事件时，保留现有尝试次数，最终附bad_format信号，对受保护出口返回502，替代原兜底503。若最终结果是既有HTTP错误/冷却/熔断，则按该错误优先，不因较早一次空流改码。Antigravity空流/收集无数据也以bad_format识别。
- 复审确认的测试差异：纯空白/注释以往被Gemini CLI误记为已成功收到数据、只尝试一次；规范化后按真正空流执行既有重试预算。保留的是预算配置，不要求保留该错误的单次行为。
- 共享收集器的类型信息为内部增量；仅受保护路由使用新策略，面板获得的原始错误正文不被替换。

### 3.3 固定英文文案和状态（v3 唯一文案表）

参考 [Google GenerateContent API errors](https://ai.google.dev/gemini-api/docs/generate-content/api-errors) 和 [OpenAI Error codes](https://developers.openai.com/api/docs/guides/error-codes)，查阅日期2026-09-27。采用官方状态码的常见语义，以下英文是本服务自己定义的固定提示，不复制供应商返回的 message/details/code。Google 的生成接口采用整数 HTTP code 和大写 status；OpenAI 的 code 还可能是业务字符串，本服务保留原方案的整数 code 兼容约定。

| 本地文案 ID（不新增对外字段） | 对外状态/来源 | 固定英文 message，逐字匹配 |
| --- | --- | --- |
| INVALID_REQUEST | 400、422 | Invalid request. Check the request parameters and try again. |
| AUTHENTICATION_FAILED | 仅本地客户端认证 401 | Authentication failed. Provide a valid API key. |
| ACCESS_DENIED | 仅本地客户端授权 403 | Access denied. You do not have permission to perform this request. |
| SERVICE_ACCESS_ERROR | 上游或来源不明的 401、403 | The service could not process the request. Please contact the service administrator. |
| PAYMENT_REQUIRED | 402 | The request cannot be completed due to a payment requirement. Please contact the service administrator. |
| RESOURCE_UNAVAILABLE | 404（含已知退役通知） | The requested resource is unavailable. |
| REQUEST_TIMEOUT | 408、504、可识别超时 | The request timed out. Please try again later. |
| REQUEST_TOO_LARGE | 413 | The request is too large. Reduce its size and try again. |
| REQUEST_LIMIT_REACHED | 429 | The request limit has been reached. Please contact the service administrator if the issue persists. |
| INVALID_SERVICE_RESPONSE | 502、响应格式错误 | The service received an invalid response. Please try again later. |
| SERVICE_UNAVAILABLE | 503（含凭证池无可用项/冷却/熔断） | The service is temporarily unavailable. Please try again later. |
| REQUEST_REJECTED | 其他未单列的 4xx | The request could not be processed. Check the request and try again. |
| INTERNAL_ERROR | 500、其他未单列的 5xx、本地未分类异常 | An internal error occurred while processing the request. Please try again later. |

- 优先级：先应用已知内部 timeout/bad_format 类型及现有最终 HTTP 选择规则，再按表中专用状态和可信 origin 分类，最后使用 4xx/5xx 兜底。只有本地明确标记的客户端认证/授权失败可提示客户端 API key/权限；默认来源不明时使用中性文案。异常字符串、上游 error.status/type 和自定义头不能证明 origin。
- 429 同时可能代表频率或额度上限，固定提示不承诺等待即可恢复，也不把所有429描述为请求太频繁；402 不建议盲目重试。仅文案/映射变化，不新增额度分类或改变既有重试策略。上游401/403不提示用户更换自己的key，404不出现具体资源或模型名称。
- 402、413 和未知4xx兜底为 v3 增量；不新增计费、请求大小限制或业务功能，仅在既有错误出现时选择恰当的固定说明。取消异常继续传播，不为了499构造新响应；若实际收到上游HTTP499 Response，则适用未知4xx固定兜底。

- 已有最终 HTTP 4xx/5xx 保留状态码（包括上游 401/403，以避免改变调用方重试契约，但使用来源不同的中性文案）。
- HTTP 200 顶层或 response 包装中的 error，只要存在且非 null（包括空对象/空字符串），均为错误；error.code 必须 type(value) is int 且在 400–599，其他值统一 502，bool 不接受。
- 传输 3xx 或不符合模型响应契约的非错误状态不透传 Location，返回 502。本地未分类异常 500，识别出的超时 504，非法 JSON/非对象负载及完全空的上游流 502。
- 已有合法安全阻断、usage-only 等对象不因没有文本而改成错误。

### 3.4 协议结构与响应头

- OpenAI：{"error":{"message":固定文案,"type":本地类型,"code":对外HTTP整数}}。
- Claude：{"type":"error","error":{"type":本地类型,"message":固定文案}}。
- Gemini：{"error":{"code":对外HTTP整数,"message":固定文案,"status":本地枚举}}。
- OpenAI 类型：400/413/422及其他未单列4xx使用 invalid_request_error；可信本地401 authentication_error；可信本地403 permission_error；404 not_found_error；429 rate_limit_error；503 service_unavailable_error；408/504 timeout_error；402、上游/来源不明401/403、其他5xx使用 server_error。
- Claude 类型：400/413/422及其他未单列4xx使用 invalid_request_error；可信本地401 authentication_error；可信本地403 permission_error；404 not_found_error；429 rate_limit_error；503 overloaded_error；402、上游/来源不明401/403、408/504及其他5xx使用 api_error。
- Gemini status：400/413/422及其他未单列4xx使用 INVALID_ARGUMENT；401 UNAUTHENTICATED；403 PERMISSION_DENIED；404 NOT_FOUND；408/504 DEADLINE_EXCEEDED；402/429 RESOURCE_EXHAUSTED；503 UNAVAILABLE；其余 INTERNAL。枚举仅本地映射，不复制 Google 字符串。
- 上述 type/status 全部是本地常量映射。其中 OpenAI 风格的整数 code、timeout_error、authentication_error 等沿用本项目兼容方案，不宣称是官方所有接口的逐字格式；SDK异常类也不等于HTTP正文error.type。专用状态优先于兜底，不能把408/429错误落入普通4xx。模板ID只用于内部测试/维护，不出现在新增JSON字段中。
- 不输出 details、metadata、model、param、原始响应副本或异常堆栈；错误不能伪装成 choices[].delta.content 或 content[] 中的普通文字。
- 错误响应从零生成头部：框架生成 Content-Type/Content-Length；允许本地固定 WWW-Authenticate、本地整数 Retry-After、由本服务生成的诊断标识和外层 CORS。原始 Google 响应头、Location、content-encoding、旧长度一律不复制。
- 上游 Retry-After 默认不转发。私有 origin/类型不能来自上游自定义头部，也不落到响应 JSON。

### 3.5 固定输出示例与兼容边界

同一已知退役通知在提交响应头之前按目标协议返回 HTTP404：

```json
{"error":{"message":"The requested resource is unavailable.","type":"not_found_error","code":404}}
```

```json
{"type":"error","error":{"type":"not_found_error","message":"The requested resource is unavailable."}}
```

```json
{"error":{"code":404,"message":"The requested resource is unavailable.","status":"NOT_FOUND"}}
```

以上依次为 OpenAI、Claude、Gemini。开始流输出后，使用相同固定错误对象作为第4节的协议错误事件，HTTP状态保留已提交值。错误对象的文案、类型和枚举不得附加模型标识、供应商URL、账号、区域、请求参数、英文原始报错或建议切换到的模型。正常成功内容与成功响应的现有字段仍遵循第1节范围，不把本任务扩大为所有正常文本的模型名过滤。

## 4. 非流式、假流式与 SSE

- 非流式及假流式先做状态/错误对象/格式检查，再进入成功转换；识别错误时直接按目标协议渲染。假流式不再把异常写入 model/choices 内容块。
- 在两后端的受保护流调用启用事件化 SSE 解析。httpx_client 的现有按行接口保留默认，新增显式选项交付完整事件；Vertex 和未启用的调用者不变。不把无换行的单行片段和完整事件用启发式混猜。
- SSE 解析按空行组帧，支持 CRLF、UTF-8 字符跨传输块、data: 后可无空格、多条 data: 合并、EOF flush。注释、空行和 event/id/retry 控制字段不当 JSON 错误，不把其原文用于错误输出；没有数据的心跳允许忽略。认识 [DONE]，不把它当 JSON。
- 交给现有转换器/收集器/诊断的成功事件统一为b"data: "+单行重新序列化JSON+b"\n\n"；结束标记同样规范为b"data: [DONE]\n\n"。不向下游交出原始多行data、无空格data或控制字段。event:error先转为内部类型化错误，绝不作为成功字节串交出。DIAG观察在规范化之后接收等价JSON语义，冻结contracts不改；运行时代码若需适配属于必要共享修改。
- 完整 data 事件必须是合法 JSON 对象，error 优先于 candidates；event:error 也按错误处理。非法 JSON、数组、字符串、损坏 response 包装不透传，统一 502。修改现有“非法数组/字符串原样透传”的测试预期，并注明这是有意的错误路径兼容改变。
- “首包”是第一个有效数据事件，预取时跳过空行/注释，不因它们提交200。该事件为错误时，在提交响应头前返回协议 JSON 和错误 HTTP 状态。完全空流为502。以实际是否已开始发送为最终边界，不能承诺开始后改 HTTP 状态。
- build_streaming_response_or_error新增受保护策略参数，默认保留原204行为；仅六个受保护路由将StopAsyncIteration转换为固定502，Vertex仍返回204。各路由内的空生成器分支同样交由这个策略处理。纯[DONE]/注释为空；合法usage-only/安全阻断对象不算空。
- 已开始输出后收到错误：保留 HTTP 状态，OpenAI 发一个完整 SSE error 事件再发 [DONE]；Gemini 发一个完整 error JSON SSE 事件后关闭（错误路径不额外发 [DONE]）；Claude 发 event:error 后关闭，不能再产生 message_delta/message_stop 的成功收尾。
- Claude 转换器新增显式启用的“类型化错误”分支，不能仅截断输入导致 EOF 被当成功。两后端启用，其余默认不变。
- 保留 Claude 现有 finishReason 立即结束行为，不为了捕获终止点之后的事件等待 DONE/EOF；结束后显式 aclose 上游。未读取的尾部不向客户端泄露，也不借此激活额外抗截断续写。
- 不新增通用流读取超时策略；仅对已经捕获的超时做正确分类，避免把本次修复扩大成连接超时重构。

## 5. 重试和抗截断的必要保护

- API 内部原始错误分类/重试继续在脱敏前完成。Gemini CLI 补充“已输出有效内容”状态：忽略空行/注释/心跳，输出有效数据后发生异常不得完整重放，交出类型化终端错误给路由；输出前仍按原有预算重试。
- 两后端抗截断显式启用同一受保护策略：遇到明确 error 或错误 Response 立即结束，不把它当可续写的截断；已输出内容后异常不吞掉、不重试。输出前错误仍服从底层已有重试，不再由处理器叠加错误重试。
- 正常的截断续写行为保持原状，Claude 现有正常终止/attempt 数也保持原状。
- 转换器和处理器内部产生的错误同样走固定 renderer；外层最终错误适配器覆盖本地转换异常，不能只检查上游。
- 取消/关闭时释放生成器、HTTP 流、预取凭证任务；已输出后无重放的测试必须覆盖 API 内部和抗截断两层。

## 6. 诊断与验收测试

- 拦截上游错误时先保留现有原始错误语义观察，再生成固定输出；每次转换只记录一次，不能把错误记成成功。服务已经处理并发送固定错误时，diag.server 可以是 finished，业务 resultClass 必须是 error；传输层未处理异常仍是 error。记录此区别。
- 保留后台凭证错误和冷却分类。六个生成路由的非流式/假流式底层调用一律record_logical=False；请求级完成器携带recorded标记，负责最终结果只记一次。非流式由最终渲染/转换结果完成统计，流式由tracked_iterator完成，首包错误/空流/预取异常在提交JSON前完成；路由类和helper只调用同一个幂等完成器，不能各自直接再记一次。
- 请求通过鉴权、校验并进入生成处理时才激活上述统计；健康检查、模型列表、count_tokens和鉴权/校验拒绝不新增生成计数。取消沿用现有不记完成请求的语义。成功/失败以受保护分类器和实际转换结果为准，不用现有两个子串的退役通知统计heuristic重新判断；普通引用通知应记成功。底层凭证尝试统计与客户端逻辑统计仍是两套独立指标。
- 扩展本地 harness 支持两后端：2后端×3协议×4模式；Antigravity 额外覆盖流转非流开/关，Gemini CLI 本来无该开关，不虚构配置。
- 注入全状态表、首事件/正文后 error、两层 response、error 为 {} 或空字符串、非法 code（bool/字符串/越界）、3xx、HTTP200、格式/超时/转换异常、无凭证/冷却/熔断、抗截断后续轮失败。
- sentinel 与模型名放进 body、details、异常、Pydantic input/loc 和上游头，断言受保护错误正文/头部无这些值；本地 Retry-After 保留，不能泄露上游头。
- 真正的 SSE 解析器验证合法心跳/多行/无空格/EOF、UTF-8 分片和错误帧结束方式，客户端取消不 yield，错误只出现一次、无错误后成功收尾。
- 规范化事件同时通过两后端的转换器、抗截断、原生Gemini路由、Antigravity收集器和DIAG；空流502的有限重试数、Vertex空流204、两个Claude计数接口直接返回400的固定正文分别回归。
- 非流式转换异常、预取异常、HTTP200错误、首句退役通知均只记一次失败；正常正文引用两段提示仍记一次成功。
- 成功文本、公开模型名、modelVersion、工具、多模态、思考、用量保持；Claude 终止后不等待无 EOF 上游、不增加 attempt；错误测试与正常正文中含单词 error/模型名的反例同时存在。
- 管理接口 INVALID_ACTION、面板错误详情、模型列表、Vertex、凭证分类和诊断回归不受影响。冻结契约文件不改；测试使用 PYTHONDONTWRITEBYTECODE=1。
- 本轮不运行生产 Google 请求。实施后运行相关测试及仓库要求的回归；测试必须证明“不泄露”，不能只证明“不抛异常”。
- 固定英文契约逐字参数化测试全部状态/来源/协议，覆盖402、413、未知4xx/5xx、来源不明401/403，以及相同英文语义在三协议中的一致性。禁止仅断言英文字符或“不含Google”；应断言完整白名单结构及精确message，给原始错误注入任意供应商/模型名sentinel并检查正文、头和完整SSE字节。

## 7. 已知退役通知：已获用户确认，必须覆盖

- 不复用现有统计函数的两个子串全响应扫描作为安全拦截器，避免误伤引用、工具参数和普通讨论。
- 将仓库已有样本的明确通知前缀视为404：候选正文从“Gemini <名称> is no longer available.”开始，之后的切换建议全部丢弃。检测忽略大小写和开头空白，名称允许 ASCII 字母、数字、空格及 . _ / + - ( )，长度1–128字符；不把两个短语散落于任意位置的文本当错误。以首句确认通知，不等待建议全文/EOF，避免无限等待和额外续写。该已知前缀本身即定义为错误，无论后面还有何建议文字。
- 非流式在转换前，遍历候选的非thought文本 parts 拼接后识别。只扫描展示正文，不扫描思考、工具参数、图片或其他元数据。普通答案中间引用通知、引号/代码围栏中的例句、一般模型讨论均保留。
- 流式在每一次上游请求的每个候选第一次展示文本之前启用前缀状态机，包含抗截断第二轮/后续轮，不按客户端流只识别一次。跨事件/UTF-8分片识别；尚可能匹配时暂存含该候选未判定展示正文的事件，不能先泄露名称再发送错误。确认退役即清空缓冲、固定404并终止整个响应；确认不匹配则按原顺序释放，此候选本轮不再扫描后文。
- 在没有待定展示正文时，thought-only、usage-only、纯metadata事件立即正常放行，不计入正文字符上限，也不关闭扫描器；已有待定展示事件时，后续事件随队列暂存以保持输出顺序，但不额外计入展示字符数。已放行思考/metadata后再识别退役走已提交响应的协议错误事件。混合事件若含未判定展示正文，则暂存整个混合事件，不能先把正文部分送入转换器。暂存期间内部诊断照常，客户端不得提前得到这些正文。
- 工具/图片等非文本正文先于展示文本出现时，该候选视为普通成功内容，不套用独立退役规则；thought不是此处的非文本正文。不因仅有思考输出提前关闭扫描器。
- 有限前缀只按展示字符计数：开头空白最多64，名称1–128，加固定模板后最大前缀不超过256字符。先尝试排除模板，不匹配即释放，不能先按大事件大小判错；仍可能匹配时，最多暂存256展示字符。因未判定展示正文而形成的原始事件队列另设16MiB总缓冲上限，超限固定502并丢弃，禁止释放疑似通知。一般thoughtSignature/grounding/usage的几KB不触发错误，首次展示正文前直接放行的thought-only及排除前缀后的正常多模态大事件不适用此上限。EOF/finishReason 时已确认通知返回404；仅未完成前缀且未形成退役首句则按正常内容释放，保留普通短答案。
- 测试覆盖两后端、三协议、真流/假流/非流式/抗截断、每个字符边界分片、多parts、完整通知、附加切换建议、前导空白、超限，以及普通引用反例。明确不承诺识别任意语言的未知自然语言错误，但本仓库已知模板及其分片不能漏出原文。
- 专门验证先输出超过4KB思考、首个正文事件带大于4KB signature/grounding，以及抗截断第二轮退役；正常思考/普通正文不变，后续通知不泄露。

## 8. 交付顺序

1. 保留 v2 的两轮 Claude 审核证据。v3 英文契约增量由 ERR-01 在冻结公共接口前交 Claude 复审；出现阻断项先修订，不能把旧结论自动套用到新表。
2. 用户现已明确授权分拆多个 Codex 任务窗口并启动开发。按 MODEL_API_FIXED_ERRORS_TASKS.md 的依赖执行：ERR-01/ERR-02可并行；其余逐阶段过门禁后启动，不让多个窗口同时修改共享集成文件。
3. 实施时在维护范围文档记录用户授权的有限 Gemini CLI 例外，不删除原有停止维护说明。无需管理协议 capability/schema 或 manager 配套变更。
4. 交付说明列出状态/协议错误格式、原先吞掉错误转为失败、首包返回变化、本地 Retry-After 和诊断结果；不修改 panel-version.txt，不改自动审核配置，不自动部署或推送。
5. ERR-05 在实现完成后进行完整回归和 Claude 代码审核。方案复审、单模块测试、集成完成、最终安全验收分别记录；前一阶段通过不能代替后一阶段通过。
