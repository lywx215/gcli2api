# Antigravity 人工直连测试：参照原 fork 流程恢复

日期：2026-09-29。版本：v10，补充旧凭证代次初始化，待 Claude 复审。
本轮只审核和修订方案，不实施业务代码、不调用真实 Google、不修改凭证和冷却、不提交推送。
之前两组六轮结果保留为历史；其中 Gemini CLI 专属意见因本次明确排除而不再是实施待办，
不能标记为已修复或通过。本组最多三轮实际 Claude 审核。

## 1. 范围与原流程参照

用户最新要求：“继续 Claude 审核，尽量参照原来fork的方案，另外可以忽略Gemini Cli的内容。”
本方案只修改 Antigravity 人工路径及其必要共享基础设施；Gemini CLI 完全保留当前行为，
不改它的 SMART、risk-check、health_state_version、Token/Project 保存、record_*、额度解析
或专属前端展示，不新增该模式的功能验收。共享函数仍须保证该模式兼容，不能因默认参数变化误入新路径。

本地可核对的参考：upstream/master 缓存为 87f56c8（2026-09-14），其中面板测试直接发送
hi/maxOutputTokens=1；本 fork 在新增拦截前的 4232efc 保留直接请求，并已有显式模型的严格
标记测试、正额度解冷、零额度补冷。以4232efc作为最近可复现行为参照，在当前f9d48c0修复。
这里没有宣称该上游缓存是远程最新版，也不整体回滚f9d48c0或引入另一套调度架构。

优先复用旧请求构造、模型映射、Token刷新、批量队列、额度查询及既有事务工具；只增加区分
人工调用、保护结果和安全回写所需的分支/辅助方法。与旧实现有意不同的地方限定为：
- 人工成功不自动启用已禁用/永久禁用的凭证；所有人工测试仍可使用这些凭证直连。
- 成功恢复用户指定的对应额度组，其他组不变；系统自动保护继续保留。
- 429/503不能冒充测试成功；实际Google状态和本地验证/回写结果分别展示。
- 固定英文错误、原生模型名称脱敏及身份/并发保护继续保留，不能复活旧原文泄露或无条件写入。
- 缺失额度不凭猜测当零；这是响应后写入规则，不是新的人工请求门禁。

人工结果自动回写；刷新冷却只查额度，不新增生成探测。正常模型API、自动筛选/探测、管理接口
保留现有策略。已取消MGMT和其他稳定性待办不恢复。

## 2. 入口和执行

新增来源参数仅存在于服务端内部，默认 origin="legacy"。人工语义的必要条件是
mode == "antigravity" 且 origin == "manual"，面板认证后的相应入口显式传入；普通模型API
不接受客户端传来的绕过开关。Gemini CLI 即使经过共享面板包装也继续旧分支。

| 入口 | Antigravity 人工行为 |
| --- | --- |
| /test、/batch-test、模型卡片测试、凭证消息测试 | 指定凭证直接生成，不经quota_admit |
| /quota、/batch-refresh-cooldown | 直接fetchAvailableModels，按返回额度同步冷却 |
| 单项/批量verify-project | 直接执行旧项目检验，安全回存，禁用标志保持 |
| 解除组异常拦截 | 保持现有“解除异常、保留计时冷却”语义，不伪称Google测试 |
| 既有手动启用/禁用及附带清CD | 保持现有管理动作语义，不新增Google测试/准入；测试成功不能隐式调用它们 |

/risk-check 是 Gemini CLI 专属，不拆路由、不改旧函数名和签名，也不为 Antigravity 新增该入口。
本轮不新增全量冷却清空按钮。人工查询/测试前不按冷却、异常组、禁用、永久禁用筛选/跳过，
不自动换凭证、不新增退避重试、不追加后台检查。批量仍用原队列逐项发送并逐项报告。
必要的OAuth刷新及认证、文件存在、凭证可读取检查保留；真实准备错误不得伪装Google拒绝。

共享函数 test_credential_common、verify_credential_project_common 等只在上述两个条件满足
时走新分支。特别明确 `_fetch_quota_for_credential(filename, mode, *, origin="legacy")`：
- legacy 保留 quota_snapshot、_quota_snapshot解码后公共结构、原Token保存/回退和其他模式分支。
  Management quota/sync_cooldown 当前不传origin，保持原调用和副作用，不改管理适配器。
- Antigravity人工批量刷新显式manual，使用下述manual_snapshot、人工Token回退和查询；
  人工同步由调用方显式走新方法，不把默认sync_model_cooldowns_from_quota改成人工语义。
- /quota仅Antigravity分支使用人工查询/同步；所有其他模式保持当前实现及响应。

## 3. Google结果与界面

保留原请求：指定model使用原固定标记、256输出token和现有模型映射；未指定model仍使用
原默认gemini-2.5-flash、hi、maxOutputTokens=1。不会为解冷额外调用其他模型。

新增 upstream_status（收到的实际Google HTTP状态，未收到为null）、response_source、
verified_reply、state_update；保留现有响应字段。收到响应即先保存状态，再解析和回写。
人工测试/额度查询的HTTP状态保留真实上游状态；Google200时本地校验/回写失败仍显示200，
success和分项结果标明失败/未应用，不能把它改成Google424/502/503。批量外层保留批量契约，
每项单独记录上游状态；OAuth/项目查询/生成区分阶段，多阶段项目检验不得捏造一个模型状态。

- 严格模型测试须HTTP200、无错误信封/已知退役、完整回复且标记符合原要求才解冷。
- 旧连通测试须HTTP200、可解析JSON对象、无嵌入错误/已知退役；1token产生无可见文本或
  MAX_TOKENS可视为连通成功，verified_reply=null，不声称严格生成通过。空正文/坏JSON不成功。
- 429/503等失败保持实际状态，不把429当凭证有效或成功；失败不解冷。
- 回写失败不能抹去Google结果，也不重发Google请求。

仅Antigravity人工分支的响应、首次日志、持久error_messages、异常/detail、批量逐项错误
必须使用既有safe_error/固定英文分类，不输出Google原始错误正文、异常str(e)、原生模型名
或秘密。底层fetch_quota_info新增兼容默认的人工元数据选项，在JSON解析前保存HTTP状态；
其人工Token/项目辅助调用的错误出口一并核对，避免在底层已经记录原文。固定英文文案示例：
"Invalid request.", "Authentication failed.", "Permission denied.", "Rate limit exceeded.",
"Service temporarily unavailable.", "Invalid upstream response.", "State update failed."。
复用现有合适分类，不承诺暴露Google原始code/message；HTTP200退役使用固定错误，不回显通知。

前端仅Antigravity新结果采用新展示，其他模式保留当前展示；错误不得把reply_preview当原文出口。
项目检验实际更新成功后说明Project/错误码的真实副作用与禁用不变，移除人工分支“已解除禁用”
“403应该恢复”等不实提示；失败/冲突分项显示。更新单项、批量、按钮title与日志。

## 4. 人工回写与最小并发保护

复用现有generation/content version、_quota_atomic和数据库字段，不新增schema、统计表或
通用健康管理系统。新增小型人工快照/结算/额度同步辅助方法，不伪造自动admission。

### 安全取得凭证和保存Token/项目

manual_snapshot从同一次权威行读取凭证身份、内容版本以及原始quota_group_states/
model_cooldowns指纹；返回可解析标记，额度策略坏JSON不得阻止读取有效凭证并请求Google。
首次读取旧记录缺少quota_credential_generation时，先复用quota_ensure_generation（既有
validate=False，不解析策略）条件初始化，再重新读取同一权威行的凭证内容、身份和原始指纹；
身份与将发送的凭证必须来自同一最终读取，不能将初始化前的旧内容与新代次拼接。初始化期间
记录删除/重建则丢弃初始读取，以最终存在的完整记录开始请求，缺失记录报告真实本地准备失败。
manual_current_credential回退也处理缺代次，但初始化后必须匹配请求持有的expected generation；
不接受新生成的不同代次冒充原凭证。初始化失败但已读取有效凭证时仍可人工发送，标记身份
不可可靠取得、禁止自动回写；不会把本地额度身份缺陷冒充Google拒绝，也不无围栏保存Token。
可安全解析时提取目标组revision、冷却映射、lastSeen；额度查询未知返回哪些组时先保存全量
原始快照，回来后按目标组比较。不能仅靠revision，因为部分冷却写入不递增revision。

人工test、/quota、_fetch_quota_for_credential的人工分支及verify-project使用该路径，
不调用会_decode的quota_snapshot。Token刷新用既有quota_refresh_credential的generation/
expected_version条件保存；失败回退新增不_decode的manual_current_credential，只在同代
凭证仍有有效Token时复用最新内容版本；身份变更或无有效Token报告本地准备失败。
项目内容/状态保存用同样身份条件事务，更新字段另校验自身快照，禁用标志不变。
不使用旧Token/Project覆盖替换、删除重建的新凭证；取得的Google项目结果仍与保存结果分开。

### 模型测试结算

请求持有一次性结算对象，在第一次await前认领结算；人工不调用quota_record_result，也不调用
旧record_success/record_failure或无条件set_cred_disabled回退。_quota_atomic(validate=False)
内分层更新，SQL锁/事务和Mongo CAS覆盖四后端，不用进程锁代替：
1. generation/content version匹配才计success/failure/call_count、last_success；从当前值累加。
   原额度策略损坏或变化不阻断这些请求计数。错误字段和按原配置自动禁用分别比较自身快照，
   不能因不相关额度变化跳过；本地校验/回写失败不触发自动禁用，不新增永久禁用。
2. 冷却/异常组更新须目标策略可解析且目标快照仍匹配；cycle_stats及关闭周期还要安全解析
   自身字段及比较周期状态。损坏/冲突仅跳过相应字段，不清空未知状态，不抹去第一层计数。
3. 身份冲突两层均不写；state_update分项记录applied/skipped/failed及固定原因。

只有计数层提交后，才一次调用原stats buffer及PostgreSQL daily_stats等既有出口；严格模型
测试的record_logical_request也只有一个终结调用，沿用旧口径。后续统计失败单独记录，不
重放Google，不声称内存与DB之间可跨系统原子提交。Redis在DB提交后失效，失败单独报告；
自动准入仍读权威状态。损坏策略不自动修复。

成功测试按第3节分别判定，清除实际被测模型所属组的计时冷却/异常拦截，其他组不变。
仅已有blocked_unknown/manual_override的组转manual_override并递增revision；普通正常组
只清冷，不新建override，避免后来普通429改变正常组保护行为。保留观察元数据。
明确额度耗尽按真实分类/有效恢复信息补冷；容量不足、未知429或网络失败不凭猜测补长期冷却。
成功不修改disabled/permanent_disabled。真实配置内401/403等失败可按原配置有条件禁用。

### 额度查询解冷：沿用旧流程，不加生成测试

| 本次Google额度 | 状态同步 |
| --- | --- |
| 组内至少一个合法正值，无明确零，已返回条目均非未知 | 清对应组冷却并恢复异常组 |
| 任一明确零 | 零优先，不解该组；保留有效冷却，无有效冷却才补 |
| 已返回条目缺失/非法/未知（无零） | 不把缺失当零，保留该组状态，显示信息不完整 |
| 组无返回条目或查询失败 | 保留原状态 |

允许同组其他模型完全未返回时按已返回正值恢复组，这是用户已选组级恢复，不宣称所有模型
已验证。合法值须[0,1]有限数值且非bool；缺失/null/非法为unknown。此为明确的客户端策略，
不宣称已证明Antigravity协议缺失语义。旧默认0不作为Google实际零值证据；也不增加真实调用
来猜测。缺失已返回条目与完全未返回模型分别验收。

人工同步不调用自动quota_sync(required_models=None)或observe_week来否决正值恢复。
正值+滚动168h仍恢复；已存在异常状态转manual_override，若原无状态但本次确有rolling168h
观测，可建立带该观察元数据的manual_override，避免后台同快照重拦；普通正常组不新建状态。
该例外沿用现有后续业务429可重拦策略，不扩散到正常组。零值+滚动168h仍是零；有效冷却
不反复延长，无有效冷却时按Google有效未来reset补冷，无有效reset使用原配置兜底。
策略变化按组报告冲突，不静默跳过或追加查询；失败不清异常。解除异常按钮仍保留计时冷却。

## 5. 兼容、实施和验收

主要修改范围：src/panel/creds.py的Antigravity分支、src/api/antigravity.py人工额度元数据、
src/storage/antigravity_quota.py必要人工辅助方法和front/common.js对应展示；必要Token/
项目辅助函数只作人工来源兼容分支。默认legacy和Gemini CLI分支不改。
实施顺序：固定入口/结果契约 → 直连与身份读取 → 条件结算与额度恢复 → 前端/文档/测试。
不更改Management schema/capability、不要求manager配套，不恢复MGMT工作。

两个现有诊断脚本通过已认证面板/ quota访问，明确沿用人工语义：
scripts/measure_antigravity_quota.py的stable_quota_baseline/delayed_quota_snapshots会更新
正在运行服务的冷却/override；scripts/validate_antigravity_model_catalog.py的副作用落在
其隔离临时服务。更新脚本说明/命令帮助及docs/ANTIGRAVITY_MODEL_CATALOG.md，说明源SQLite
只读不代表目标服务状态只读；测量不能证明原限制下的自动准入。保留models/quota_group_states
字段和冻结脚本契约。本轮不运行真实脚本，不新增自动任务。

使用模拟Google、合成凭证和隔离数据库完成以下待实施验收（目前未运行）：
1. 冷却/异常组/禁用/永久禁用及组合下，人工单项/批量/项目/额度仍实际发送；自动API仍受限。
2. 200/401/403/429/503、空/坏JSON、200错误/退役、超时；真实状态与本地校验/回写分开。
3. 严格标记与1token连通标准分别符合旧请求；人工成功恢复对应组、其他组/禁用状态不变。
4. 正值、零、未知、正+零、正+未知、部分未返回、滚动reset、已有有效计时冷却矩阵。
5. 损坏策略不阻挡发送和身份通过的计数/配置内禁用；身份冲突不写；统计出口最多一次。
6. Token并发刷新、凭证替换/删除重建、并发429/组状态变化、重复结算/取消，旧结果不覆盖新状态。
7. SQLite/PostgreSQL/MySQL/MongoDB事务/CAS一致，缓存失效失败不冒充回滚或Google失败。
8. 错误原文/原生模型名/秘密不在人工响应、日志、持久错误中；批量和辅助调用出口同样覆盖。
9. Management test/quota/sync_cooldown旧状态码/副作用和_quota_snapshot结构不变；risk_check
   不改。共享函数默认legacy；Gemini CLI不误入manual，只验证共享边界不回归，不新增专属修复。
10. 两脚本用模拟HTTP验证字段及人工查询副作用，不实际调用生产脚本；旧冻结契约保持。

11. 无generation的旧记录：人工test、quota、Token刷新、项目检验先正常初始化，发送成功后
    计数/解冷/内容回写均可应用；同时测试损坏策略仍可初始化、并发初始化不改已有代次、
    初始化期间删除重建不拼接旧内容、回退不接受错误代次；初始化写入故障独立报告。

此前暂缓的两项稳定性测试缺口仍暂缓。回滚仅撤回本次人工分支和展示，不清额度数据；已发生
人工状态更新不能靠代码回滚还原。本轮只审方案，审核通过也不自动开发或进入代码审核。

## Claude本组审核要求

只按本方案最新Antigravity范围只读核对具体遗漏，尽量复用4232efc旧人工流程和当前事务工具，
不为Gemini CLI、SMART、健康状态版本、preview、Gemini专属统计提出实施要求；历史findings
不再扩大范围。检查真实Google结果、人工不受策略准入拦截、最小安全回写和默认管理兼容。
不要运行命令、真实模型或读取凭证/数据库；不要把本地安全回写冲突误当人工请求拦截。
有具体缺陷返回可行动的最小修正，没有则findings=[]。
