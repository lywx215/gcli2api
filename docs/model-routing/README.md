# 模型路由并行开发任务包

本任务包供四个独立 Codex 窗口执行 CLI 和 Antigravity 的模型名称路由、设置页与响应保真工作。先完成总控门禁，再并行开发底座，最后由总控接线和验收。任务包不是已完成实现，也不是 Claude 批准证据。

## 已核实的代码基线

2026-10-01 06:47 UTC，git ls-remote 核实 origin/master 为 `170d989f545218920bc84794472a0f234490694f`；本地 master 与 origin/master 一致。提交标题为“feat: separate Antigravity manual probes from automatic admission”。

当前原始工作区仍为 dev0916，存在用户的未提交文档修改。本轮只增加本任务包，不切换、重置、提交或覆盖该工作区。所有开发窗口必须使用从同一 master SHA 创建的独立 worktree，不能共享可写 checkout。

执行前 MR00 再核实 master；若已前进，在任何工作窗口开始写代码前统一更新基线并重新核验合同。工作开始后禁止各窗口独自 pull 或换基线。不得夹带 dev8/dev0916 的业务历史，也不得机械 cherry-pick 旧修复。

## 任务依据与优先级

依次采用：所有者最新指令、所选 master 的 AGENTS.md 与维护范围、[本次规格](SPEC.md)、[模块合同](CONTRACTS.md)、[详细任务](TASKS.md)。

原始 `.codex/review-plan.md` 和 review 图片是历史设计参考，不是 master 代码事实来源。master 已改变入口 aliases、模型规范化、目录投影和错误保护。遇到冲突先按 MR00 核验，不照搬旧分支断言。

最新 master 暂停 CLI 常规维护。执行 CLI 新路由前，必须有所有者“仅为本模型路由任务恢复必要 CLI 开发”的明确授权；总控启动提示词提供该有限授权措辞。当前任务包不证明该执行门禁已经满足。MGMT 已取消任务始终不恢复。

开发与验证窗口按 master 仓库约束使用 GPT-6 Astra。Claude 不调用，不启用共享 review Hook，不以其他模型冒充 Claude。

## 四个窗口及独占职责

| 窗口 | 分支建议 | 工作 |
| --- | --- | --- |
| 总控 I | codex/model-routing-integration | MR00、MR10、MR11；合同、六处理器接线、目录入口和联合验收 |
| 路由 R | codex/model-routing-core | MR01、MR02、MR03；纯基线、编译证明、resolver 和目录投影 |
| 配置 P | codex/model-routing-settings | MR04、MR05、MR06；存储、专用接口、设置页、只读预检 |
| 响应 S | codex/model-routing-stream | MR07、MR08、MR09；现有 SSE/错误栈增量完善、聚合、成功身份保护 |

MR00 验收后 R/P/S 可同时开工；P 的真实接口联调、S 的真实 handler 接线均有后续依赖。I 可先写 mock 集成测试，但不能提前宣称实际联调通过。每个窗口可使用只读子代理核查，写入仍受唯一文件所有权约束。

## 文件和接口冲突控制

- 所有新共享类型、合同版本与包 __init__ 由 I 管理。
- 六个生成处理器、两个目录入口和两份 normalizer 仅由 I 修改。
- src/api/utils.py、httpx_client.py、两个 API 模块和中央安全错误 helper 均由 S 独占；S 内部子任务顺序执行。
- panel、四个存储后端和前端文件仅由 P 修改。
- R 不修改现有 handler、normalizer、网络、存储或错误 renderer。
- 跨归属问题只提交安全问题说明/补丁建议，不直接修改对方文件。合同变更必须由 I 升级版本并同步受影响窗口。
- 交付证据放在 `docs/model-routing/deliveries/MRxx.json`。这是本地任务交付，不是跨仓库 handoff，不触发 Actions、定时器、模型或其他窗口。
- 默认不自动 commit、push、创建 PR、合并或部署。总控可在授权的实施范围内审查指定文件 diff 并应用到集成 worktree；提交/发布另遵循用户要求和仓库 hook。不得使用 git add . 或绕过 hook。
- 当前 master 保持固定错误默认合同；不直接恢复上游 Retry-After 透传。详细诊断扩展必须保留默认模板与字段，只能通过单独已冻结的 opt-in 合同，不得修改旧 fixture 冒充兼容。

## 开工和整合顺序

1. 用户明确启动总控，按 [总控提示词](prompts/controller.md) 完成 MR00。
2. MR00 产生通过回执、共同 BASE_SHA 和 CONTRACT_VERSION，并交付最小类型模块。若未经批准提交，总控按指定文件 diff 把门禁产物复制到三份独立 worktree，逐文件验证摘要；不得复制整个原始工作区。
3. 用户分别启动 [路由窗口](prompts/routing.md)、[配置窗口](prompts/settings.md)、[响应窗口](prompts/stream.md)。
4. 各窗口仅修改独占文件，针对缺失依赖使用明确标注的 mock；MRxx 最终通过必须替换为真实依赖。
5. I 先整合 R，再整合 P、S；任何生产源文件冲突视为所有权违规，不自动选择 ours/theirs。
6. I 负责 MR10/MR11。真实凭证、外网模型调用和实际上线不属于本任务包自动验收。

配置和各底座独立回归通过，不等于六协议联调完成；模拟 grounding 保真也不等于真实联网成功。

## 配套文件

- [当前规格](SPEC.md)：最新 master 下的功能与排除项。
- [模块合同](CONTRACTS.md)：类型、函数、接口、数据流和安全边界。
- [详细任务](TASKS.md)：逐项输入、实施、验收、交付和阻断条件。
- [机器任务清单](manifest.json)：所有权、依赖、状态和统一基线。
- [启动提示词](prompts/controller.md)：总控入口；其他三个窗口提示词位于同目录。

当前未创建开发窗口或 worktree，未运行业务测试，未接触真实凭证/数据库，未调用 Claude。
