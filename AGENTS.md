# gcli2api Codex 协作约束

本仓库是多仓库方案中的“节点服务端”。中央管理系统位于独立的
`gcli2api-manager` 仓库。开始涉及统一管理、凭证管理协议或版本兼容的任务前，
必须依次阅读：

1. `docs/multi-repo/COORDINATION_SPEC.md`
2. `docs/multi-repo/IMPLEMENTATION_ROADMAP.md`
3. `docs/multi-repo/MANAGEMENT_API_CONTRACT.md`
4. `docs/multi-repo/GCLI2API_CODEX_GUIDE.md`
5. `docs/multi-repo/AUTOMATED_HANDOFF.md`

## 必须遵守

- 本仓库拥有凭证真实数据、SQLite状态和管理动作的最终语义。
- 当前管理系统功能统一在`dev8`开发；`dev8`继承已Review的`dev7`完整历史，后续短分支
  必须以最新`dev8`为创建基线。完成Review后再将`dev8`合并回`dev5`，不得基于`master`
  开发业务功能。
- 两个仓库只能通过HTTP契约协作；不得让manager导入本仓库源码或读取本仓库数据库。
- `/management/v1` 内只允许向后兼容的增量修改；破坏性变更必须新建主版本路径。
- 现有 `/creds/*`、模型API和控制面板不得因管理协议改造而失效。
- 管理接口不得返回access token、refresh token、client secret或完整凭证JSON。
- 新功能必须声明capability，并为支持与不支持场景补充测试。
- 任何`MGMT-*`实现必须已在`IMPLEMENTATION_ROADMAP.md`中定义目标、依赖、范围、排除项、
  验收和回滚；仅有分支或Issue标题不得开始编码，也不得跳过未完成门禁。
- GitHub Issue只跟踪路线图工作项的状态和证据，不得通过Issue评论静默改变路线图范围。
- 不得修改现有凭证数据、SQLite表或Zeabur Volume，除非任务明确要求并提供迁移方案。
- 不得在Fixture、日志、测试输出或提交内容中包含真实凭证和管理密码。
- 开始`MGMT-*`任务时，如GitHub访问可用，必须先检查本仓库打开的`codex-ready`交接
  Issue，并只执行其中属于当前工作项的`next_actions`。
- 自动handoff只允许`queue_only`且自动运行次数为0；不得建立定时Codex轮询，也不得因
  Issue创建而自动调用模型。只有用户启动实际任务后才能读取并实施`codex-ready`内容。
- 范围外发现只记录，不得顺带实施。

## 完成标准

- 单元测试、管理协议契约测试和Legacy回归测试通过。
- OpenAPI/协议文档与实现一致。
- 变更记录说明schema版本、capability、兼容影响和manager侧所需动作。
- 跨仓库变更必须关联同一个工作项编号，并在交付说明中列出对应manager任务。
- 当前工作项状态和路线图门禁证据已更新；只把依赖满足的下一项标记为`ready`，不得自动
  启动下一工作项。
- 需要manager继续处理时，必须在`coordination/handoffs/`生成符合schema的新交接JSON；
  其中`execution_policy`保持`queue_only`；禁止要求用户人工复制交接块。无需对端动作时
  使用`no_counterpart_action`只记录。
