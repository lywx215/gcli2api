# Antigravity Flash：最终实际 Claude 复审与真实测试记录

> 历史快照：本记录截至2026-10-09T07:01:21.104436+00:00（UTC），记录首次Low测试及其后工具复审。“唯一一次”“未执行”等描述限定该阶段。之后另行获用户授权的High五例测试见 [High五例摘要](ANTIGRAVITY_FLASH_HIGH_REPLAY_2026-10-09.md)，不将后续调用计入已结束的初始8次测试预算。

2026-10-09。基线 `d1007/6245cbb`，分支 `codex/antigravity-flash-transport`。更改仍未提交、推送或部署。

**当前方案和16个交付文件已通过实际 Claude Opus 5.5 复审，当前内容签名与批准快照一致。真实生成验证尚未通过：一份凭证的 Native 请求返回上游 HTTP 429，其余模式按规则未执行。**

审核使用原共享 `C:/Users/lywx2/.codex/review/hook.py` 和实际 Claude CLI，模型 `claude-opus-5-5`。用户已明确取消本任务三轮上限；仅导入进程覆盖本任务轮次限制，共享脚本未修改。审核范围不包含真实凭证内容。

## 实际审核历史

最初功能实现的两轮 clean 审核为历史记录，见 `review/ANTIGRAVITY_FLASH_TRANSPORT_REVIEW_2026-10-09.md`；其中旧签名不代表之后修改的文档和新增脚本。此次真实测试阶段使用独立会话 `flash-transport-live-20261009-unlimited`。

| 轮次 | 阶段 | UTC完成时间 | 结果 |
| --- | --- | --- | --- |
| 1 | plan | 2026-10-09T06:16:11.871896+00:00 | 2项意见 |
| 2 | plan | 2026-10-09T06:25:59.920990+00:00 | findings=[] |
| 3 | code | 2026-10-09T06:28:57.026932+00:00 | findings=[] |
| 4 | code | 2026-10-09T06:37:42.542761+00:00 | 1项意见 |
| 5 | code | 2026-10-09T06:43:55.991365+00:00 | 2项意见 |
| 6 | code | 2026-10-09T06:48:59.141996+00:00 | 3项意见 |
| 7 | plan | 2026-10-09T06:51:37.985152+00:00 | 1项意见 |
| 8 | plan | 2026-10-09T06:53:16.924129+00:00 | 3项意见 |
| 9 | plan | 2026-10-09T06:57:07.920519+00:00 | findings=[] |
| 10 | code | 2026-10-09T07:01:21.104436+00:00 | findings=[] |

第3轮代码批准后执行了唯一一次真实测试。第4—8轮为测试脚本及说明复审，核实修复后，第9轮批准当前方案、第10轮批准当前代码。不会把第3轮快照或Codex独立复核冒称为最终代码审核。

## 意见核实与修复

- 最终输出预算：核对现有normalizer后发现实际会覆盖为64000，最初“发送32”的前提不成立。手动脚本仅在最终HTTP helper深拷贝后压为512，并验证发送值；MAX_TOKENS空正文明确为未定结果。生产normalizer未改。
- 累计预算：父执行器预占/结算跨运行计数，真实执行必须显式传剩余预算；未知计数全额扣预占，不按进程重置8。
- 诊断分支：Native普通失败后仅允许一次collect对照，不再继续真实流式或其他协议。真实429已提前停止，并未触发该缺陷。
- 测试记录：原脱敏结果已证明512护栏实际生效；补明护栏和发送上限，Claude“可能发送64000”的推断未获证据支持。
- 前置检查：token剩余有效期严格超过735秒；刷新后expiry未知或不足立即停。有效token执行需预算7，需要刷新需8；不足在任何HTTP前退出。
- 时间线：澄清唯一测试授权已执行且429停止，刷新最多一次按任务累计；后续审阅不是新增实测授权。剩余真实验收未完成，不通过扩大预算或重启脚本规避约束。

## 真实测试结果

只读使用用户指定 `D:/0502/at` 中一份凭证，真实router/converter/API/HTTP路径执行，凭证、本地状态及统计采用内存隔离。

| 项目 | 实际结果 |
| --- | --- |
| OAuth | 源短期token到期，仅刷新一次；HTTP200，约0.922秒 |
| Gemini Native | `gemini-3.8-flash-low`；全局流转非流开启，独立native仍选择`generateContent`；HTTP429，约1.125秒 |
| 输出护栏 | `output_budget_guard_applied=true`，实际`maxOutputTokens=512` |
| 正文/usage | 无成功正文或usage，不标生成通过 |
| collect、真实流、OpenAI、Anthropic | 因429停止，未执行 |
| 请求次数 | OAuth1 + native1 = 2；任务总限额8，未重置 |
| 源凭证 | 所用原文件hash未变，未导入或写回 |

这次只证明OAuth刷新成功及真实transport选择生效，不能证明Native成功生成，也不能推断其他账号或接口均不可用。未自动切换流式、重发或轮询其他凭证/模型。

本次实际运行采用第3轮批准代码签名 `1902ee62746c55b63b07053c5296e94dbd50d30a4e7c953703c94901e78345bc`。之后修订脚本的预算、诊断和token前置检查仅做模拟验证，未重新实测；原429分支证据未变。刷新所得token仅在已退出进程内存，当前任务唯一刷新已用完，剩余6次不足完整矩阵，余下真实验收仍未完成。

## 离线验证

- 功能实现相关81个Python模块：2620 passed、1 Windows平台skip；JavaScript89 passed。除新测试脚本及更新的说明外，原审核表14个文件字节SHA全部一致，保留该测试证据。
- 最终脚本合成MockTransport检查通过：有效token预算6→0请求；需刷新预算7→0；完整预算7→7生成；刷新完整预算8→1OAuth+7生成。
- 有效期边界通过：存储180/734/735秒需刷新，736/3600秒直接使用；刷新后735秒或缺expiry仅一次OAuth后停止。
- 错误回归通过：Native429→1请求；刷新+429→2；Native400+collect成功→2；空MAX_TOKENS→1且未定；缺显式预算或非法参数在凭证读取前拒绝。
- 最终payload比较确认仅输出限额被测试护栏改为512；模拟测试未读取真实目录或调用真实上游。
- 独立只读复核通过；panel-version.txt和受保护antigravity_models.py相对HEAD未改。数据库schema、管理协议及既有数据未改，manager无需动作。

## 当前批准快照

方案签名：`9cc82d2a05d23e0a949240539f7d7b17028faa0a0a0df137eb5ea00145e5b49b`

代码签名：`0923b6f0caaa1a0c0503bd5e87616a2245e6877bd0741b8d06b41ad4d02f3190`

| 交付文件 | SHA-256 |
| --- | --- |
| `.env.example` | `3462620ae418f78c89dfc960d5703d65cb85ab4653a27c803b026192382eaa42` |
| `config.py` | `f957ac3763764c0d82074ffaf5a5f6aa1fcdeeac034d4b74bbba11b92ec5b952` |
| `docs/ANTIGRAVITY_FLASH_TRANSPORT.md` | `4fb312236d74e571f19e0e37c483161a41f3b176e59e70420bf836fc6d33edfb` |
| `docs/model-routing/CONTRACTS.md` | `bc55d3b52b58cafe5086cf5d33df71ffc11de6d000109d20197ae80e9d11b287` |
| `front/common.js` | `1010b530bdf6cf03cc05e828fdb71c9406db7056e11fe551515dc26267ce1069` |
| `front/control_panel.html` | `df1e95c97c486549ae552f0ff1343e3beb2011063d4c2ece03a94ea2f39197ab` |
| `front/control_panel_mobile.html` | `60c258f52d4e80c2e6426658dab5a08b7171055c8cf200a30f78873d618b9dbc` |
| `scripts/verify_antigravity_flash_live.py` | `641fa2f31ce519de0cb75f9c05d6421dee3095e340a3b71759b4223c2d4641cc` |
| `src/api/antigravity.py` | `1beacb8e6a4e8c8f6fef8488052d56d3fe4b31ae5e723670f56dd8ef3416e206` |
| `src/model_routing/__init__.py` | `b87bc1840b55398dbd0694bb039fefc7072b99b60ce6e25f4b93cd9a9ed0afc2` |
| `src/model_routing/types.py` | `ff60435c359a70c510f6e59f8359833fa9b3fd7353bdee220b4950064b00c6ab` |
| `src/panel/config_routes.py` | `6395379c8129894a324f399f7f0a220245a60f9b8efe0f5ae6c6a268d4d91605` |
| `test_antigravity_flash_config.py` | `aae1b85968b729bab238e21b3653e9fa3313bc8fa005d0a3f85006a4739a8410` |
| `test_antigravity_flash_transport.py` | `d09a5cffc202d212dd2f13e5b0f09717199b2d3871d68e52bf2743d86de8428d` |
| `test_antigravity_flash_ui.cjs` | `930c09b52609b588139a06906c1540fa1a9bf3a7e07e55cb48431ec47eda0fa7` |
| `test_antigravity_timeouts.py` | `f58278c249e195b1bb3c83529c035724f2d89cc1379b76776d02e9289f2ff0a9` |

安全原始记录：`.cache/flash-live-claude-review/round-1.json`至`round-10.json`、`live-results.json`、`http-budget.json`和`final-snapshot.json`。记录不含token、账号或完整模型请求/响应。
