# Antigravity stability：Claude 修复建议

日期：2026-09-27。用户请求：“让Claude给出修复建议。”

## 来源与状态

- 实际调用模型：`claude-opus-5-5`，通过共享 `C:/Users/lywx2/.codex/review/hook.py` 调用。
- 本次咨询会话：`01a0d68a-cea6-77b0-8813-913a1cd57632`，使用 Hook 的 `plan` 阶段获取只读建议。
- 审阅代码快照：`20cb5455834c56a4a6e989b08f29d202b294f2cc`。
- 背景问题见 `review/ANTIGRAVITY_STABILITY_CLAUDE_REVIEW.md`。Claude 本次返回 4 项建议，没有单列新增问题。
- 本报告仅整理建议；未实施测试或业务修复，未运行反证或回归，未提交、推送、部署或回滚。
- 原代码审核仍为“发现问题，未通过”。本次建议不构成修复完成或代码审核通过。

## 建议摘要（Codex 整理）

| 项目 | Claude 判断 | 最小修复方向 | 验收重点 |
| --- | --- | --- | --- |
| 共享 TOTAL 预算 | 测试证据不足，未证实业务缺陷 | 保留直接非流测试并更名；新增真实 fake-stream → non_stream_request → stream_request → collector 调用链测试，只替换底层上游 | 三协议、单一预算对象、持续进展仍触发 TOTAL、固定 504、流关闭和一次统计 |
| 续接错误输出 | 测试证据不足，未复现业务缺陷 | 三协议分别检查原始输出和出口保护后的完整 SSE 序列 | 仅一个终止错误，不夹带 Response 对象、旧超时正文或旧错误码 |
| 维护范围 | 文档表述冲突 | 将“仅用于 Antigravity”限定到稳定性第 1–4 项 | 保留 Gemini CLI 已有五类有限例外，不扩大维护范围 |
| 融合记录 | 状态过时，回滚边界缺失 | 补当前合并 SHA、两个父提交、审核未通过状态；标明历史快照和回滚含义 | 历史验证数字不改写；说明 `git revert -m 1 20cb545`，不执行回滚 |

Claude 建议先补测试与文档，暂不重构运行时代码。下列伪代码、断言和时间参数是建议，尚未实施验证；后续实现需结合实际 fixture 和三协议输出核对。反证建议应在隔离环境执行，不把故意引入的缺陷保留到交付代码。

## Claude 返回的完整建议

以下逐项保留实际结构化返回的内容，仅将字面量换行符转换为 Markdown 换行；其中的“执行”“替换”等均为建议步骤，并未执行。

### 1. tests/test_antigravity_stability_integration.py

【第1项｜成立：测试证据不足，不是已证实的业务缺陷】涉及位置：tests/test_antigravity_stability_integration.py:172-182、186-195；src/router/stream_passthrough.py:170,199,237；src/api/antigravity.py:408-410,780-786,1072-1080；src/antigravity_limits.py:107-109,112-127。代码核对：假流会依次调用 _antigravity_response（创建 GenerationBudget(non_stream=True)，用 budget.run 读取第一项）→ 路由 fake_stream_generator → non_stream_request，后者在 1072-1073 行用 inherited = current_budget.get() 复用同一个预算 → _non_stream_request → stream_request（408-410 行继承预算并设置 streaming=True）→ collect_streaming_response。按实现来看，TOTAL 预算是共享的；即使内层 non_stream_request 超时后返回旧的 timeout_response()，外层 budget.run 也会在 125-126 行的 expired 后置检查中改为抛出 GenerationTimeout，最终得到固定的 504。问题在于现有 172 行测试没有继承预算，直接调用 non_stream_request，(True, True) 只能说明新建的预算带有 non_stream 标记；186 行测试用的是合成 source，完全没有经过 collector。
最小修改步骤（只改测试，不重构业务代码）：
1) 把 172 行测试改名为 test_direct_non_stream_request_creates_total_budget_and_forwards_protected，断言不变，不再声称验证了“共享”。
2) 新增按三种协议参数化的 test_fake_stream_collector_reuses_passthrough_total_budget(policy, monkeypatch, protocol)：
   - 使用稳定的时间配置：monkeypatch.setattr(limits.GenerationLimits, 'load', classmethod(lambda cls: limits.GenerationLimits(first=5, idle=5, total=.1, headers=.02)))，FIRST/IDLE 与 TOTAL 相差约 50 倍，不依赖贴近阈值的 sleep。
   - 记录预算实例：class Recording(limits.GenerationBudget): def __init__(self, *a, **k): super().__init__(*a, **k); created.append(self)，再 monkeypatch.setattr(limits, 'GenerationBudget', Recording)。passthrough、stream_request 和 non_stream_request 都在函数内从 src.antigravity_limits 导入该类，所以只要任何一层新建预算，这里都能看到。
   - monkeypatch.setattr(antigravity, 'get_antigravity_stream2nostream', AsyncMock(return_value=True))，走真实的 collector 分支。
   - 只替换最底层的 _stream_request：async def upstream(body, native=False, headers=None, events=False): assert events is True; seen.append(limits.current_budget.get()); try: while True: yield BODY; await asyncio.sleep(.005) finally: closed.set()。持续产出有效进展，用来证明 IDLE 一直在续期，超时只能来自 TOTAL。
   - 用透传方式包一层真实的 collector 作为 spy，不做 mock：real = antigravity.collect_streaming_response; async def spy(stream, **kw): entered.append((kw, limits.current_budget.get())); return await real(stream, **kw)。
   - 源生成器照抄路由写法：async def fake(): r = await antigravity.non_stream_request({'model': MODEL}, record_logical=False, protected=True); if r.status_code != 200: yield r; return; yield r.body。然后执行 t0 = time.monotonic(); result = await response(fake(), protocol, non_stream=True); elapsed = time.monotonic() - t0。
必要断言：len(created) == 1；b = created[0]；b.non_stream is True and b.streaming is True and b.expired is True；b.progress is not None（出现过有效进展，排除 FIRST 超时）；seen 非空且 all(x is b for x in seen)；entered == [({'protected': True}, b)]；result.status_code == 504；result.body == render_error(error(ErrorKind.TIMEOUT), protocol).body；'Antigravity 请求超时'.encode() not in result.body；closed.is_set()；policy[1].assert_awaited_once_with(MODEL, 'antigravity', False)；elapsed < 2.0（远小于 FIRST/IDLE 的 5 秒，不设接近 .1 的下界）。
3) 186 行测试保留，把用途限定为“透传层 TOTAL 上限”，不再作为 collector 证据。
验收条件：新测试在三种协议下都通过；做一次临时反证（不提交），把 non_stream_request:1073 改成总是新建预算，新测试必须因 len(created)==2 或 `is` 断言失败，证明测试的是共享预算，而不是调用形状。

### 2. tests/test_antigravity_stability_integration.py

【第2项｜成立：测试证据不足，未复现业务缺陷】涉及位置：tests/test_antigravity_stability_integration.py:151-169；src/api/antigravity.py:424-427（没有输出过正文时会 yield 旧的 timeout_response()，里面是中文“Antigravity 请求超时”）；src/router/stream_passthrough.py:237,247-249；src/antigravity_limits.py:125-126。代码核对：第二次续接超时后，stream_request 会先 yield 旧的 Response，外层 budget.run 在 expired 后置检查中把它丢弃并改为抛出 GenerationTimeout，tracked() 最后只输出一次固定事件。这是由实现顺序保证的，但现有测试只检查 chunks[-1] 和预算数量，所以旧 Response 或旧正文即使夹在中间也发现不了。
最小修改步骤：把该测试改成按 PROTOCOLS 参数化（response(continuation(), protocol)），并抽出 METADATA 常量代替 158 行的字面量。收集时分两层：raw = 直接收集 result.body_iterator；再单独构建一次响应，经过 protect_streaming_response(result, protocol) 后收集为 guarded（与路由一样的出口）。
必要断言（raw 与 guarded 都要满足）：
- all(isinstance(c, bytes) for c in chunks)，同时 not any(isinstance(c, Response) for c in chunks)；
- 精确序列 chunks == [METADATA, render_error_event(error(ErrorKind.TIMEOUT), protocol)]，一次就覆盖“非末尾块都是协议正文”和“只有一个终止事件”；
- 解析所有 'data:' 行（跳过 [DONE]），其中带 error 键的 JSON 恰好 1 个；claude 协议 body.count(b'event: error') == 1；body.count(b'[DONE]') == (protocol == 'openai')；
- 旧原文不泄露：'Antigravity 请求超时'.encode() not in body 且 b'upstream_timeout' not in body；
- 保留 len(budgets) == 2、budgets[0] is budgets[1]，并补充 budgets[0].expired is True；policy[1] 只调用一次且参数为 False。
时间设计保持现状：第一次续接立即输出，第二次 sleep(5)，远超 FIRST=.04，不要改成两段贴近阈值的 sleep。
验收条件：三种协议下 raw 与 guarded 都满足上面的精确序列；临时删除 antigravity_limits.py:125-126 的后置检查（反证，不提交）后，测试必须失败，因为 raw 中会出现 Response 对象或旧文本。

### 3. docs/MAINTENANCE_SCOPE.md

【第3项｜成立：文档表述冲突】涉及位置：docs/MAINTENANCE_SCOPE.md:41-42 与 :14-19。dev0927 已包含 d5e3c1b“sanitize model API errors across Antigravity and Gemini CLI”，14-19 行也授权了 Gemini CLI 的五类共同错误输出保护，所以 41 行“本轮运行时修复仅用于 Antigravity”与事实不符。最小修改：只替换 41-42 行这一条，不改 14-19 行，也不扩大例外。建议替换文字：
“- Antigravity 稳定性第 1–4 项（上传结果真实性、阶段/总预算、原子冷却结算、导入资源限制）的运行时修复只作用于 Antigravity。Gemini CLI 只适用上方“本轮有限例外”列明的五类共同模型 API 错误输出保护，不因本次融合扩大。两者都不改变 Management schema、capability 和 `panel-version.txt`，manager 无需配套动作（`no_counterpart_action`）。”
验收条件：全文不再出现“运行时修复仅用于 Antigravity”这种无限定的说法；14-19 行的五类例外内容逐字不变；只做纯文档修改，不需要跑回归，git diff 只涉及这一条列表项。

### 4. review/ANTIGRAVITY_STABILITY_INTEGRATION.md

【第4项｜成立：记录状态过时，缺少回滚边界】涉及位置：review/ANTIGRAVITY_STABILITY_INTEGRATION.md:5-6、15-17、19、79（“新增并暂存”）、100-101。当前 HEAD 20cb545 已经是合并提交，Claude 代码审核结论是“发现问题，未通过”（review/ANTIGRAVITY_STABILITY_CLAUDE_REVIEW.md:45-47）。最小修改：保留原有正文作为历史快照，不改写其中的数字；在标题下插入“当前状态”一节，并替换 100-101 行。建议插入文字：
“## 当前状态（2026-09-27 更新）
- 实际合并提交：`20cb5455834c56a4a6e989b08f29d202b294f2cc`（dev0927）。第一父提交（主线/目标）：`6a452a10c8d0b0742923d26d5360d11094300199`；第二父提交（来源 codex/antigravity-stability）：`7bb1824f96538d329d8234140a5f4095bc138434`。
- 下文“合并未提交 / 保留 MERGE_HEAD / 本轮不启动 Claude 审核 / 新增并暂存”均为合并提交前的交接快照，仅作历史记录。
- Claude 审核已执行（记录见 review/ANTIGRAVITY_STABILITY_CLAUDE_REVIEW.md），当前结论为“发现问题，未通过”，4 项 findings 尚未修复，不能标记为 GO。
- 远程推送状态以 `git branch -r --contains 20cb545` 的实际结果为准，本记录不自行声明。”
把 100-101 行替换为：
“回滚建议（仅建议，未执行）：在 dev0927 上执行 `git revert -m 1 20cb545`。`-m 1` 表示以第一父提交 6a452a1（dev0927 主线）为基准，生成一个新提交，撤销该合并相对主线引入的全部改动，包括来源 5 个稳定性提交（c056ac8、f1e94e7、3ad9b55、3e38e1e、7bb1824）以及 7 处冲突解决；dev0927 原有的固定错误保护保留。不改写历史，也不需要强推。注意：7bb1824 在历史上仍被视为已合并，以后重新合并同一来源分支不会自动带回这些改动，需要先 revert 这次 revert 提交；如果 20cb545 之后已有依赖它的提交，回滚可能冲突，需要逐项处理。本次没有 schema 迁移，回滚不涉及数据库、运行数据或历史统计，不得靠覆盖数据或重算统计来回滚。”
验收条件：文中能同时看到历史快照标注、合并 SHA 与父提交顺序、未通过的 Claude 结论，以及上述 -m 1 含义；原有验证数字（1238 passed 等）保持不变；不执行任何 git revert。
## 调用记录

- Hook 记录时间：09/27/2026 15:55:12
- 本轮摘要：70bad50cd7f8f9b5bcd2eafc2a920fd2184bda51c3ebdd45dcbdbda17718b3f4
- 返回：4 项 findings；调用错误：无。
- 状态文件：C:/Users/lywx2/.codex/review/state/d47c95e0abe13a8b/01a0d68a-cea6-77b0-8813-913a1cd57632.json
