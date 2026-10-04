# 配置设置页窗口启动提示词

只有用户实际发送启动指令后执行。先确认MR00已通过及本次CLI有限授权；若没有，停留在只读准备，不凭保存的提示词自行开工。

> 请启动P 配置与设置页窗口，执行MR04、MR05、MR06。使用MR00统一master基线，在独立worktree和本窗口分支开发；严格遵循任务包和文件所有权。先报告你读取到的BASE_SHA/CONTRACT_VERSION/依赖状态，再实施。禁止Claude、真实凭证调用、生产数据、提交推送或部署。缺依赖时可做明确mock开发，但最终交付必须真实依赖验收。

当前任务仅 CLI 和 Antigravity，排除 Vertex、manager/MGMT、手动凭证/导入改造、真实数据与部署。使用 GPT-6 Astra。不要调用 Claude 或共享 review Hook。
原始任务包位于 G:/code/gemini30/gcli2api/docs/model-routing。开始先完整读取 README.md、SPEC.md、CONTRACTS.md、TASKS.md、manifest.json 和最新master的AGENTS.md/维护范围。当前原始checkout是dirty dev0916，不得在其中写业务代码。
代码基线必须由MR00锁定的origin/master提交，当前参考170d989f545218920bc84794472a0f234490694f；不是dev8/dev0916。各窗口独立worktree/分支，不独自pull，不拷贝creds/.env/日志/真实数据库。
仅修改本窗口独占文件。共享types/合同改动提交总控处理；不修改对方文件。默认不commit/push/开PR/合并/部署，不bump panel-version，不绕过hook。交付指定文件diff、新文件清单和实际测试回执。
测试先隔离临时CREDENTIALS_DIR/存储、mock全部Google/OAuth/refresh/listing；不启动默认web lifespan，不读取生产凭证。只在本窗口的master代码上验证；mock结果不算真实依赖通过。
master已有protected/events/退休检测/安全错误/额度预算/单次统计与关闭链，必须增量保留，不从旧方案重写。默认fixed errors/local-only Retry-After保持，不改fixture掩盖回归。
Claude历史未通过不阻止本次按用户明确task开发，也不能伪造已通过。缺门禁/授权/证明时准确停止对应写入，其他只读准备可继续。无跨任务自动消息或自动运行；回执只作本地queue_only交付。

## 本窗口专属要求

- 分支建议codex/model-routing-settings；独占store/settings_routes/readonly/preflight、四后端、panel config/root注册、前端入口与专用页及测试。
- 不改core解析/证明、six handlers、网络/错误/collector；不改creds、antigravity_manual/import和Management。
- MR04可先使用MR00类型mock，最终必须MR02真实compiler。four backendsfresh读取不是全量cache刷新，不DDL或读真实凭证。
- GET/PUT默认HTTP结构按合同；dedicated-only读写保护、原子保存、channel故障隔离和管理员修复必须真实验证。
- 设置页tab绑定示例，AG整名不自动search；保留当前master新增手动测试/导入UI。浏览器测试只启动隔离mock app。
- 预检禁止initialize/修表/修凭证/改WAL/fallback，只允许必要的只读DB连接，Google/OAuth/listing调用计数0。
- 升级runbook必须排空已受理PUT、hash绑定与全部可写实例策略确认；无门禁不在线切版，不建设自动升级器。

每完成一个任务输出docs/model-routing/deliveries/MRxx.json及准确测试结果；不自动启动其他窗口或主动发跨线程消息。依赖回执必须由总控明确验收，不能只因为文件存在就视为通过。
