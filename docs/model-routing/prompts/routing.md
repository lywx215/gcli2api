# 路由核心窗口启动提示词

只有用户实际发送启动指令后执行。先确认MR00已通过及本次CLI有限授权；若没有，停留在只读准备，不凭保存的提示词自行开工。

> 请启动R 路由核心窗口，执行MR01、MR02、MR03。使用MR00统一master基线，在独立worktree和本窗口分支开发；严格遵循任务包和文件所有权。先报告你读取到的BASE_SHA/CONTRACT_VERSION/依赖状态，再实施。禁止Claude、真实凭证调用、生产数据、提交推送或部署。缺依赖时可做明确mock开发，但最终交付必须真实依赖验收。

当前任务仅 CLI 和 Antigravity，排除 Vertex、manager/MGMT、手动凭证/导入改造、真实数据与部署。使用 GPT-6 Astra。不要调用 Claude 或共享 review Hook。
原始任务包位于 G:/code/gemini30/gcli2api/docs/model-routing。开始先完整读取 README.md、SPEC.md、CONTRACTS.md、TASKS.md、manifest.json 和最新master的AGENTS.md/维护范围。当前原始checkout是dirty dev0916，不得在其中写业务代码。
代码基线必须由MR00锁定的origin/master提交，当前参考170d989f545218920bc84794472a0f234490694f；不是dev8/dev0916。各窗口独立worktree/分支，不独自pull，不拷贝creds/.env/日志/真实数据库。
仅修改本窗口独占文件。共享types/合同改动提交总控处理；不修改对方文件。默认不commit/push/开PR/合并/部署，不bump panel-version，不绕过hook。交付指定文件diff、新文件清单和实际测试回执。
测试先隔离临时CREDENTIALS_DIR/存储、mock全部Google/OAuth/refresh/listing；不启动默认web lifespan，不读取生产凭证。只在本窗口的master代码上验证；mock结果不算真实依赖通过。
master已有protected/events/退休检测/安全错误/额度预算/单次统计与关闭链，必须增量保留，不从旧方案重写。默认fixed errors/local-only Retry-After保持，不改fixture掩盖回归。
Claude历史未通过不阻止本次按用户明确task开发，也不能伪造已通过。缺门禁/授权/证明时准确停止对应写入，其他只读准备可继续。无跨任务自动消息或自动运行；回执只作本地queue_only交付。

## 本窗口专属要求

- 分支建议codex/model-routing-core；拥有projection/policy/routing/compiler/catalog新模块和各自测试。
- 不改six handlers、normalizer、API、存储、前端、错误栈或共有types。
- 全部算法纯函数，显式注入master规则与feature快照；不得动态fetch/refresh。
- 三协议实际旧链、家族参数优先级、非法输入与native前置重定向从master重提取，不能继承旧dev0916假设。
- target稳定证明、CLI无限后缀闭包和参数符号等价不可用有限样本替代；不能证明则准确拒绝，不放宽命名空间回避。
- 目录只消费已过滤source_catalog，空表与master同输入deep-equal；不广告全部动态内部ID。
- MR01→MR02→MR03顺序完成，结果依赖真实compiler/resolver，不留下mock当通过。

每完成一个任务输出docs/model-routing/deliveries/MRxx.json及准确测试结果；不自动启动其他窗口或主动发跨线程消息。依赖回执必须由总控明确验收，不能只因为文件存在就视为通过。
