# 响应流式窗口启动提示词

只有用户实际发送启动指令后执行。先确认MR00已通过及本次CLI有限授权；若没有，停留在只读准备，不凭保存的提示词自行开工。

> 请启动S 响应与流式窗口，执行MR07、MR08、MR09。使用MR00统一master基线，在独立worktree和本窗口分支开发；严格遵循任务包和文件所有权。先报告你读取到的BASE_SHA/CONTRACT_VERSION/依赖状态，再实施。禁止Claude、真实凭证调用、生产数据、提交推送或部署。缺依赖时可做明确mock开发，但最终交付必须真实依赖验收。

当前任务仅 CLI 和 Antigravity，排除 Vertex、manager/MGMT、手动凭证/导入改造、真实数据与部署。使用 GPT-6 Astra。不要调用 Claude 或共享 review Hook。
原始任务包位于 G:/code/gemini30/gcli2api/docs/model-routing。开始先完整读取 README.md、SPEC.md、CONTRACTS.md、TASKS.md、manifest.json 和最新master的AGENTS.md/维护范围。当前原始checkout是dirty dev0916，不得在其中写业务代码。
代码基线必须由MR00锁定的origin/master提交，当前参考170d989f545218920bc84794472a0f234490694f；不是dev8/dev0916。各窗口独立worktree/分支，不独自pull，不拷贝creds/.env/日志/真实数据库。
仅修改本窗口独占文件。共享types/合同改动提交总控处理；不修改对方文件。默认不commit/push/开PR/合并/部署，不bump panel-version，不绕过hook。交付指定文件diff、新文件清单和实际测试回执。
测试先隔离临时CREDENTIALS_DIR/存储、mock全部Google/OAuth/refresh/listing；不启动默认web lifespan，不读取生产凭证。只在本窗口的master代码上验证；mock结果不算真实依赖通过。
master已有protected/events/退休检测/安全错误/额度预算/单次统计与关闭链，必须增量保留，不从旧方案重写。默认fixed errors/local-only Retry-After保持，不改fixture掩盖回归。
Claude历史未通过不阻止本次按用户明确task开发，也不能伪造已通过。缺门禁/授权/证明时准确停止对应写入，其他只读准备可继续。无跨任务自动消息或自动运行；回执只作本地queue_only交付。

## 本窗口专属要求

- 分支建议codex/model-routing-stream；独占两API/httpx、collector/fake/anti、中央model_api_errors/stream_passthrough及成功身份helper。三个任务顺序进行，不让内部子代理同时写这些共有文件。
- 不改six handlers、normalizer、core/存储/panel/typed合同；接口需求交总控。
- 复用已有events/protected/typed error、retirement每attempt16MiB、Completion/预算/admission/usage/settlement、aclose/prefetch和单次逻辑统计，不能另建旁路安全栈。
- 新SSE事件/未完成缓冲32MiB不改变独立retirement/generation限制；支持完整事件和bytes分片。
- collector逐候选完整parts/签名/grounding/usage保真、尾metadata消费；不使用数组位置猜缺省index。
- 成功identity只改协议字段，保留Response错误私有marker；默认fixed error与local-only Retry-After不变、不恢复上游头直传。
- 假流正文完整输出一次；业务数据已进入下游/collector后不能重放。签名与多轮引用无法证明准确阻断，不编造重编号。
- 必须跑master已有SSE/retirement/error_matrix以及手动探测parse回归，不改旧fixture去迁就新实现。

每完成一个任务输出docs/model-routing/deliveries/MRxx.json及准确测试结果；不自动启动其他窗口或主动发跨线程消息。依赖回执必须由总控明确验收，不能只因为文件存在就视为通过。
