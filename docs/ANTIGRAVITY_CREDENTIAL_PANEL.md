# Antigravity 凭证页显示、检索与上传邮箱补全

本次改动以 `d1007/a44d0ca` 为基线，限于 Antigravity 凭证页及其必要共享设施。Gemini CLI 专属功能和统一管理项目仍按现有维护范围处理。控制面板版本号不变，不涉及部署。

## 显示与检索接口

Antigravity 管理页在宽屏使用可用宽度、两侧保留 20px。筛选分组、状态徽章和按钮整枚换行，长文件名、邮箱省略显示并有完整提示；其他页面恢复原容器宽度。

`GET /creds/status?mode=antigravity&search=1621` 接受可选检索条件，去首尾空格后最多 255 字符。空值兼容原行为；非空条件仅支持 Antigravity。

- 纯 ASCII 数字按 `编号_` 精确匹配文件名前缀，`1621` 不匹配 `16210_`，前导零保留。
- 其他文字对文件名或已保存邮箱进行字面包含匹配，忽略 ASCII 字母大小写；不使用正则、SQL 通配符或从文件名推测邮箱。
- 检索在分页前应用；Opus 总览、列表总数与选择全部筛选结果使用相同检索范围。全局统计口径保持原行为。
- 面板能力声明 `antigravity.credentials.search`。客户端先确认能力再发送检索参数，能力撤回时取消旧选择与请求。

## 新上传邮箱任务

JSON、ZIP、单个及批量 refresh token、OAuth 的每次成功保存都会尝试立即入队。响应在原字段之外增加：

```json
{"email_enrichment":{"job_id":"opaque-id","accepted":1,"skipped":0,"status_url":"/creds/email-enrichment/opaque-id"},"warnings":[]}
```

上传成功只表示凭证保存成功；邮箱获取失败、队满、旧存储缺少身份校验或服务禁用不会将上传改为失败。批量 RT 上传的邮箱告警只在请求顶层汇总，单项结果不会继承其他账号的告警；单条上传和直接内部调用仍返回自身告警。无可用任务时 `job_id` 和 `status_url` 为 null，计入 skipped 并提示使用现有手动邮箱入口。仅处理本次上传，不补全历史缺失邮箱，不从文件名解析账号，不自动重试。 验证失败或全部保存失败且没有任何待结算导入、逐项记录或省略结果的空任务立即释放容量，公开任务引用为 null；待结算的晚提交和有 skipped 计数的任务继续保留。

同名覆盖会在同一原子导入中清除旧邮箱并保留其他状态。内部导入回执来自实际提交，包含 generation 和内容 version，但不返回给 HTTP 调用者。邮箱服务按该精确身份读取、刷新及写回；替换、删除或版本变化会使该项 superseded。导入等待被 HTTP 请求取消时，已经开始的原子导入仍由结算回调观察；晚提交成功只将它自己的回执加入队列。

`antigravity.credentials.auto_email` 只在生命周期服务启用、原生启动器已确认单 worker 且后端已确认支持身份校验时声明。`python web.py` 的 `WORKERS=1` 可确认；多 worker 或外部 ASGI 启动模式未知时禁用并返回警告。当前就绪检查使用后端已确认的完整身份 schema；每条回执的补全支持标记是最终校验。此内存服务要求部署为单实例，不能用于多实例共享任务调度。

固定默认值：4 个邮箱执行 worker、1000 个待执行项、128 个任务、5000 个逐项记录，每项开始执行后总预算 10 秒，排队最多 45 分钟，终态任务保留 15 分钟，保留时间从所有导入及逐项工作均结束后开始；等待晚提交、排队或执行中的任务不会按终态期限删除。队列到期由独立清理任务检查，全部执行槽等待写回时也会清理。记录上限导致无法保留逐项条目时增加 skipped 计数和警告，不扩大内存。邮箱网络与写回不持有上传准入槽；原子导入仍使用原有上传写入限制。

## 进度、终态与关闭

鉴权接口 `GET /creds/email-enrichment/{job_id}?offset=0&limit=100` 返回：

```json
{"job_id":"opaque-id","sealed":true,"complete":true,"counts":{"success":1,"skipped":0},"total":1,"items":[{"filename":"1621_example.json","status":"success","reason":null,"user_email":"example@example.test"}]}
```

`offset` 非负，`limit` 为 1..200。`total` 是可分页逐项记录数；counts 也包含达到记录上限时的 skipped 项。公开状态为 queued、running、settlement_pending、success、failed、superseded、skipped、unknown，前三种非终态。只公开文件名、安全枚举原因及成功邮箱，不公开回执、令牌或原始授权响应。列表项增加 `email_enrichment_status`、`email_enrichment_reason`，供首次展示。当前页统一遍历任务记录一次取得最新文件状态，避免按每行重复扫描全部记录。

前端每 2 秒分页查询，complete 时停止；退出登录取消查询，重启或 15 分钟过期后 404 明确提示任务已失效。上传请求结束仅封闭任务，不取消已保存项。

原子写回通过默认关闭的 `AtomicRegistry.run(on_settled=...)` 确认实际结果。截止或等待取消后的 settlement_pending 项继续占用原执行槽，直到同一操作结算；期间不发起新网络请求或新写入。邮箱写回晚成功才算 success，token 刷新晚成功仅表示 token 保存，邮箱仍未获取；CAS false 标为 superseded，无法确认提交标为 unknown。邮箱索引失效由原子提交链路触发，因此晚提交邮箱也能被检索。

关机沿用现有从信号开始的绝对关闭期限；期限耗尽返回状态 unknown 与固定原因码 shutdown_commit_unconfirmed，其含义是“可能已写入，提交结果未确认”；公开 reason 保持枚举码，连接关闭不表示回滚。任务只存在当前进程内存，重启不恢复、不扫描。同一进程的生命周期关闭并完全结束后，重新启动会恢复固定的 4 个执行 worker 和 1 个清理任务；旧写回仍等待结算或关闭尚在进行时拒绝重启，避免增加执行槽或继续旧任务的新网络请求。

## 验证和兼容

新增合成数据测试覆盖新上传入口、精确回执隔离、并发替换、token/邮箱晚结算、取消竞态、排队过期、容量限制、鉴权分页与期限耗尽。列表和存储测试覆盖编号边界、邮箱检索、组合筛选、缓存失效及后端回退。既有契约、Legacy 和面板状态回归继续执行。

数据库 schema 和管理协议 schema 版本不变；上述能力属于既有面板响应，不新增管理 API capability。manager 动作为 `no_counterpart_action`，无需 MGMT 工作项交接。用户于 2026-10-07 明确重新授权方案及代码 Claude 复审，使用本机共享 Hook 和实际 Claude Opus 5.5。本组审核状态以共享 Hook 的本次结果记录为准；历史方案审核与本地测试不代表代码审核通过。

## 本地验证记录（2026-10-07）

- Claude 修正后的扩展回归集：1233 项通过、1 项平台条件跳过，9 项已在干净基线复现的模型路由失败被排除。包含真实临时 SQLite 晚提交邮箱后的索引检索、面板、上传、共享原子设施、管理契约和 Legacy 回归，均使用合成凭证。
- JavaScript：81 项通过，覆盖检索能力撤销、全选竞态、邮箱轮询分页、登录隔离及同名替换后的旧邮箱隔离。
- 离线 Chromium：6 个场景通过，覆盖 1920、1440、1024、390px、桌面页窄屏及实际 125% CSS 缩放。全页截图和测量数据在忽略目录 `.cache/credential-panel-ui/`，可运行 `python -X utf8 test_panel_visual.py` 重现。
- 广测中的 9 项 `test_antigravity_timeouts.py::test_real_routes_timeout_before_first_content` 已在未修改的 `a44d0ca` 基线复现，均因路由配置加载抛出 `ModelApiErrorException(503)`。最终相关回归集排除这 9 项既有失败，未修改范围外模型路由实现，不能将其记为通过。
- Windows 测试使用 `python -X utf8`；旧提取式前端测试夹具已适配新增全局邮箱 tracker，旧 RT 夹具已改为模拟回执接口，不写入真实存储。`git diff --check` 通过。

上一组三轮由实际 Claude Opus 5.5 执行：方案通过；第一次代码审核提出晚提交任务过期计时及逐行重复扫描，均已修正。最后一次代码审核提出记录上限后前端持续等待、失败空任务占满容量及 Redis 候选池三项。前两项已修正；Redis 一项经当前 MRO 和公开调用链核实不适用，Antigravity 无论是否指定模型均通过 AntigravityQuotaMixin 读取数据库，不会调用仅供非 Antigravity 的旧 Redis 选取路径。新增 MongoDB/MySQL 八项合成回归确认过期 Redis 池不影响新上传及晚提交凭证选取，未修改生产缓存实现。用户随后明确发送“继续 Claude 审核”启动新一组复审。新组首轮代码审核提出批量 RT 邮箱警告归属与同一进程邮箱服务重启两项，均已修正；增加六项警告归属测试和两项生命周期测试，包括关闭期限耗尽后的旧 CAS 结算期间禁止新增执行槽。新组第二轮仅提出关闭期限耗尽时 reason 应使用固定原因码，已统一为 shutdown_commit_unconfirmed，并保留其可能已写入的语义及晚结算行为。最终审核结论以共享 Hook 对实际文件快照的批准记录为准。

本地验证服务已运行于 http://127.0.0.1:7861/，原生 WORKERS=1，SQLite 数据与日志位于忽略目录 `.cache/local-service/`，默认面板密码 `pwd`。服务只监听本机，未复制原有凭证或数据库；当前进程记录在 `service.pid`。启动、登录、健康、静态资源、检索能力和进度鉴权检查通过。
