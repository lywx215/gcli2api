# 模型 API 固定英文错误：实施任务

更新：2026-09-27。规范来源：[完整方案 v3](MODEL_API_FIXED_ERRORS_PLAN.md)。当前执行顺序为“先完成开发，再集中验证和 review”；本清单状态仍以各任务报告的实际证据为准。

模型约束：本任务后续 Codex 开发、验证和任务协调必须显式使用 `gpt-6-astra`；不得使用默认模型或自行降级。实际 Claude CLI 审核仍是独立审核环节，不以 GPT 模型替代。

## 工作区与执行授权

- 唯一开发目录：`C:/Users/lywx2/.codex/worktrees/14f9/gcli2api`，分支 `dev0926`，起始提交 `0b3a07e003ead2ba7a9f7827426c09f8ff996813`。
- Saved project 指向 `G:/code/gemini30/gcli2api`，其当前分支不是本次分支。新 Codex 窗口即使默认打开该项目，每条命令、文件编辑和检查都必须显式使用上述14f9绝对目录；不得在主目录改代码、切换分支或重置工作区。
- 用户明确授权：多个任务窗口；先执行无依赖任务，其余顺序推进。本轮设置两个开发窗口：窗口A负责 ERR-01，并作为后续顺序集成负责人；窗口B负责 ERR-02。A完成ERR-01后启动ERR-03，等待B完成且验收ERR-02后启动ERR-04；按用户最新指示，ERR-03/04 的剩余开发先全部完成，最后统一进入 ERR-05 验证和 review。任务阶段不等同于新建窗口；无需为尚未满足依赖的阶段提前启动写代码任务。
- 两个窗口共享14f9工作区，不做并行Git操作，不覆盖彼此文件。发现其他未提交变更先确认归属并保留。共享文件仅由A在依赖完成后修改；B完成报告后停止写入。
- 本轮用户授权仅恢复 Gemini CLI 的错误输出保护；不恢复其他停止维护功能或MGMT工作。无需manager动作、capability或schema变化。
- 不自动提交、推送、部署、调用生产Google、修改凭证/数据库/Volume或panel-version.txt。所有测试使用mock/临时隔离状态，设置 `PYTHONDONTWRITEBYTECODE=1`，不改冻结 `contracts/diagnostics/v1`。

## 依赖与分工

```text
ERR-01 固定英文错误契约 ──→ ERR-03 SSE与API内部类型 ──┐
                                                    ├─→ ERR-04 六路由集成 ──→ ERR-05 验收与Claude审核
ERR-02 退役通知识别器 ────────────────────────────────┘
```

| Task | 初始状态 | 执行窗口 | 前置门禁 | 独占写入范围 |
| --- | --- | --- | --- | --- |
| ERR-01 | done (开发及ERR-05集中验收通过) | A | 无 | `src/router/model_api_errors.py`、`tests/test_model_api_errors.py`、本任务报告、v3增量审核报告 |
| ERR-02 | done (B报告；ERR-05集中验收通过) | B | 无 | `src/router/model_retirement.py`、`tests/test_model_retirement.py`、本任务报告 |
| ERR-03 | done (开发及ERR-05集中验收通过) | A | ERR-01 done且公共接口冻结 | HTTP客户端、两后端API、必要收集/预取helper及本阶段测试 |
| ERR-04 | done (开发及ERR-05集中验收通过) | A | ERR-02、ERR-03 done | 六路由、OpenAI/Claude转换器、抗截断、统计、维护范围文档及集成测试 |
| ERR-05 | done (1143 passed/1 skipped；本组第3轮Claude代码复审findings=[]) | A | ERR-04 done | 回归测试、交付记录、最终Claude审核及范围内修复 |

状态含义：ready可开始；in_progress开发中；done须附证据；queued依赖未通过；blocked必须列出具体外部阻塞，不能将失败测试记为通过。窗口A维护本表与汇总状态；窗口B仅更新自己的报告。

## ERR-01：固定英文契约和受保护路由基础设施

目标：建立不接受任意外部message/model的固定错误出口，不在此阶段挂载到生产路由。

开发内容：

1. 只读核对六路由/认证/管理校验现状；实现不可变内部错误描述、可信origin、本地状态映射、精确英文模板、三协议JSON/SSE渲染以及私有标记。
2. 实现可显式启用的APIRoute基础：捕获校验/HTTP/普通异常，检查直接返回非2xx Response，支持集成阶段注入的幂等最终计数回调。不得在公共模块导入时更改全局handler或启用统计。
3. 固定响应头白名单，来源不明401/403用中性文案；取消/GeneratorExit不转换；StreamingResponse开始之后的处理通过显式适配器，不能声称APIRoute捕获全部流错误。
4. 将v3相对v2的英文模板、402/413/兜底映射和任务边界交由已配置Claude CLI只读审核；保存真实结果至 `review/MODEL_API_FIXED_ERRORS_CLAUDE_REVIEW_V3.md`。不使用其他模型冒充Claude，不伪造完成。若Claude不可用，完成可做的实现/测试，记录阻塞，公共接口冻结门禁保持未通过。
5. 报告列出公共类/函数签名、起源信息如何附加、固定头/错误事件终止方式、统计回调接口，供ERR-03/04使用。允许按现有代码选取最小接口，不让ERR-02依赖本模块。

验收：全英文表逐字相等、三协议结构、所有状态和未知状态优先级、HTTP200 error code的类型/范围、私有标记不信任上游、异常及校验sentinel不回显；直接Response兜底保持count_tokens既有400；管理/Vertex等默认调用无变化。Claude增量审核无未解决P1/P2后才宣布冻结。

交付：`review/tasks/ERR-01.md`，包含修改文件、API签名、测试命令/结果、Claude报告位置和未解决项。

## ERR-02：已知退役通知的有限缓冲识别器

目标：输出前识别方案第7节的已知通知，阻止原文及其中模型名泄露，保留普通成功内容。

开发内容：

1. 独立纯模块，提供非流式检查和每次上游attempt新建的流状态机；输入为已解析的Google候选对象/事件，处理顶层及response包装。逐candidate管理首段展示文本，不访问凭证、网络、路由或统计。
2. 对外接口仅返回内部决定（放行/暂存/退役/缓冲超限）、应放行的原事件和必要的固定状态码404/502；不在错误决定中携带匹配到的原句/模型名，不自行生成协议JSON。输出顺序、EOF/finishReason处理在报告中明确。
3. 完整遵循名称字符与长度、最多64前导空白/256展示字符、16MiB待定事件队列、thought/usage/工具/图片规则。匹配排除优先于缓冲大小检查；退役确认清空队列；EOF不完整前缀正常释放。
4. 只修改本任务独占文件，不修改路由、API、转换器、完整方案或ERR-01模块。若发现方案矛盾，在报告和窗口消息中明确，不擅自扩大范围。

验收：完整通知与切换建议、每字符分片、多parts/多candidate、大小写/空白/边界、合法结束、未知普通内容/引用/代码围栏、超过4KB的thought/metadata、混合事件、先工具/图片、已暂存事件之后的metadata顺序、16MiB边界与清理、第二次attempt重置。测试应在feed阶段确认尚未分类的通知没有先被释放，不能只检查最终拼接结果。

交付：`review/tasks/ERR-02.md`，明确函数/类型签名、数据大小计量方式、边界测试证据；完成后停止修改，供A只读验收再集成。

## ERR-03：完整SSE事件、内部错误类型与重试边界

前置：ERR-01测试及Claude增量审核通过，报告中的接口已确认。

开发内容：显式启用事件模式的HTTP客户端；规范化SSE；两后端内部HTTP/超时/非法响应类型；不泄露raw response/header的上层出口；首事件/空流处理选项；Gemini CLI输出有效数据后的重放保护。内部分类、冷却、禁用和管理员诊断先于对外固定渲染。尚未接入的路由保持默认行为，后续统一在ERR-04启用。

验收：UTF-8跨块/CRLF/多data/无空格/EOF/error event/注释/DONE；非对象/非法JSON/error优先级；真正空流与合法usage-only；原预算不叠加，正文后异常不再请求第二次；取消关闭资源；Vertex默认按行和空流204保持。运行时DIAG若需适配，只改运行时代码，不改冻结契约。

交付：`review/tasks/ERR-03.md`，列出与ERR-04接线相关的显式参数和内部事件协议。

## ERR-04：六路由、转换器、抗截断和统计集成

前置：ERR-02、ERR-03均通过，B窗口已停止写入。A使用wait_threads核实完成并阅读报告，不以文件存在当作通过。

开发内容：两后端×三协议生成/计数接口挂载受保护路由；非流式/假流式转换前检查；每attempt启用退役检测；真正流的首包与提交后错误分界；转换器异常固定化；抗截断错误终止及正文后不重放；请求级统计恰好一次，非流式/假流式底层record_logical=False；维护范围文档记录有限例外。

验收：计划第4至7节完整集成行为。Claude正常finishReason立即结束且aclose上游，不等待无EOF源、不新增attempt。错误后不能成功收尾；首错误尚未提交则非200，已提交则合法协议错误帧。计数接口不增加生成统计。原始诊断仍内部保留，客户端输出固定英文。

交付：`review/tasks/ERR-04.md`，列出各协议/模式结果、已接线路由和统计/关闭证据。

## ERR-05：安全验收、回归、Claude代码复审

前置：ERR-04完成。单模块通过不能替代本阶段。

1. 建立2后端×3协议×4模式的隔离矩阵，Antigravity另外覆盖流转非流开关；覆盖完整英文表、HTTP200 error、retirement、任意sentinel/原始模型名在正文和头部的不泄露断言。
2. 按完整方案验证错误只出现一次、无成功尾帧/重放、模型统计准确、取消释放；普通成功文本、思考、工具、多模态、公开model字段、Vertex、面板、管理契约、Legacy和DIAG回归。
3. 运行仓库适用的单元/管理协议/Legacy/诊断回归，冻结目录文件列表及hash必须与基线一致。只使用隔离runner/mock，不调用生产服务。
4. 将最终diff、测试证据和方案交给实际Claude CLI只读代码审核，保存 `review/MODEL_API_FIXED_ERRORS_CLAUDE_CODE_REVIEW.md`；修复范围内P1/P2后复验。审核不可用或测试失败则明确未通过，禁止报“完成修复”。
5. 汇总 `review/MODEL_API_FIXED_ERRORS_DELIVERY.md`：变更、兼容影响、测试、剩余风险、各task状态。没有schema/capability变化、无需manager动作。不自动提交/推送/部署。

## 测试运行与报告约束

从14f9目录运行；示例（按阶段选择相关测试，完整集成后再扩展）：

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/run_diagnostic_tests.py -c pyproject.toml --asyncio-mode=auto tests/test_model_api_errors.py
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/run_diagnostic_tests.py -c pyproject.toml --asyncio-mode=auto tests/test_model_retirement.py
```

如需补充诊断依赖，先检查既有临时依赖目录 `C:/Users/lywx2/AppData/Local/Temp/gcli-diag02-validation-deps`，仅进程级PYTHONPATH，不修改生产环境或全局环境。每份报告记录真实命令、通过/失败数量和日期；脱敏，不包含任何真实凭证。之前38项审计复现只证明旧问题存在，不能计入本轮修复验收。

## 窗口登记

创建后由调度窗口填入真实thread ID。A可读取和等待B，仅在本任务范围内向B发送澄清/修复请求；不联系其他现有聊天或外部人员。后续阶段在A按门禁顺序执行，不依靠定时自动化，不激活取消的历史任务。

- 窗口A：`01a0e09d-b0e2-71d3-91b3-10144df26d48`（local），标题“ERR-01–05｜英文错误契约与顺序集成”，负责ERR-01及ERR-03→ERR-04→ERR-05顺序推进。
- 窗口B：`01a0e09d-0bc6-78e3-92e5-c72eed907d1d`（local），标题“ERR-02｜退役通知识别器”，仅负责ERR-02。
