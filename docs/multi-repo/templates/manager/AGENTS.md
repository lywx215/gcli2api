# gcli2api-manager Codex 协作约束

本仓库是多仓库方案中的中央管理端。开始实现节点、凭证、负载、版本兼容或外部集成
前，必须依次阅读：

1. `docs/multi-repo/COORDINATION_SPEC.md`
2. `docs/multi-repo/MANAGEMENT_API_CONTRACT.md`
3. `docs/multi-repo/MANAGER_CODEX_GUIDE.md`
4. `docs/multi-repo/AUTOMATED_HANDOFF.md`

## 必须遵守

- 只能通过HTTPS API访问gcli2api；不得读取节点SQLite、Volume或源码。
- 所有节点调用必须经过适配器，UI和领域服务不得直接拼接Legacy端点。
- 优先使用capability决定行为；未知节点默认只读，缺失能力的操作必须禁用。
- 缺失字段保留`null`和“未知”语义，不得填0制造假数据。
- 不得保存、展示或记录完整凭证、Token和节点明文密码。
- 凭证不得上传、迁移、复制或自动去重；跨节点重复只告警。
- 写操作必须携带幂等键，耗时操作必须使用任务模型并提供逐项结果。
- Preview、额度、风险和测试属于主动外部操作，必须限制并发并披露副作用。
- manager生产持久化使用MySQL 8和Alembic；不得把SQLite或应用容器Volume作为生产
  manager数据库，数据库变更必须提供迁移和恢复验证。
- manager只使用一个专用MySQL账号，供运行时、Alembic迁移和人工排障共用；该账号仅
  能访问manager独立数据库，不得拥有全局权限、`GRANT OPTION`或桌面端数据库权限。
- 首版只提供一个Web管理员账号；不得实现注册、RBAC、角色、团队、租户或多用户管理。
- Web前端使用React、Vite、TypeScript、Ant Design和ProComponents的轻量骨架；采用
  紧凑运维界面，并支持用户选择亮色、暗色或跟随系统且持久化偏好。
- 配色和页面层次可参考Cockpit Tools；不得复制完整Ant Design Pro、Cockpit Tools业务
  模块、品牌资源或未明确授权的源码。
- 桌面端App与manager任务、业务、数据库和发布完全独立；不得引入桌面端同步或共享逻辑。
- new-api本阶段不得接入、读取或修改；只能保留通用的只读健康和容量输出。
- 任何Management API契约变更必须关联gcli2api仓库的同编号工作项。
- 开始`MGMT-*`任务时，如GitHub访问可用，必须先检查本仓库打开的`codex-ready`交接
  Issue，并只执行其中属于当前工作项的`next_actions`。
- 自动handoff只允许`queue_only`且自动运行次数为0；不得建立定时Codex轮询，也不得因
  Issue创建而自动调用模型。只有用户启动实际任务后才能读取并实施`codex-ready`内容。
- 范围外发现只记录，不得顺带实施。

## 完成标准

- Modern、Legacy Current、Legacy Minimal和Unknown适配场景测试通过。
- 当前现网版本Fixture和Docker兼容矩阵通过。
- 单节点失败不会影响其他节点；未知版本不会执行写操作。
- 数据库、日志、浏览器响应和Fixture通过敏感信息扫描。
- `SHOW GRANTS`证明manager数据库账号没有跨库或全局权限，且单管理员登录、会话安全和
  登录限流验证通过。
- 交付说明列出支持矩阵、schema兼容性、迁移、测试、灰度和回滚。
- 需要gcli2api继续处理时，必须在`coordination/handoffs/`生成符合schema的新交接JSON；
  其中`execution_policy`保持`queue_only`；禁止要求用户人工复制交接块。无需对端动作时
  使用`no_counterpart_action`只记录。
