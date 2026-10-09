# Antigravity Flash 非流式请求方式

控制面板的桌面、手机配置页新增“Antigravity Flash 非流式传输”。默认跟随原有全局“流式转非流式”开关，可保存并热更新。

| 配置值 | 面板名称 | 上游方式 |
| --- | --- | --- |
| `inherit` | 跟随全局 | 全局开关开启时聚合流式结果，关闭时直接非流 |
| `native` | 直接非流 | `generateContent` |
| `stream_collect` | 流转非流 | `streamGenerateContent` 并聚合完整结果 |

配置键为 `antigravity_flash_non_stream_mode`。非空环境变量 `ANTIGRAVITY_FLASH_NON_STREAM_MODE` 优先于数据库配置，并锁定面板选项；空值视为未设置，读取数据库配置。两者均未配置时默认 `inherit`，历史配置或非空环境变量无效时也回退为 `inherit`。保存接口仅接受表中的三个字符串。希望通过面板切换时，不设置该环境变量。

## 请求范围

只影响客户端非流式请求及已有假流式入口，支持 OpenAI、Gemini、Anthropic 协议。真实流式及流式抗截断仍实时输出。仅文本 Gemini Flash（含 Lite、preview、thinking、agent 和思考档位）应用此设置；图片 Flash、内部 `tab_*`、非 Flash 使用全局开关。

判断以规范化后的最终上游模型为准：自定义别名指向文本 Flash 时应用选项，Flash 名字的别名指向非 Flash 时使用全局开关。请求在开始时捕获不可变配置快照，进行中的请求及其重试不受热更新影响。

沿用现有凭证准入、重试、冷却、超时和统计。`native` 失败时遵循已有错误处理与重试规则，不追加流式接口重发。

## 面板兼容

`GET /config/get` 在 `config` 中返回规范化配置值，并在顶层 `capabilities` 中声明 `antigravity.flash.non_stream_transport`。旧服务未声明能力时，新面板禁用选项，保存时不发送该字段；加载失败、能力撤销和退出登录也会禁用。环境变量锁定时显示其名称，并省略保存字段。

新增配置使用现有键值存储，不修改数据库 schema、`/management/v1` 或面板版本号。manager 无需动作（`no_counterpart_action`）。本次实现不涉及部署。

## 验证与启用

自动验证采用合成凭证及模拟上游，覆盖三态与全局开关组合、最终目标分类、双向别名、各协议的非流/假流/真实流/抗截断入口、配置兼容及快照稳定性，并运行相关错误、超时、工具调用、usage 和逻辑计数回归。

2026-10-09 验证记录：

- 81 个相关 Python 测试模块：`2620 passed, 1 skipped`，未排除用例。跳过项为 Windows 不适用的 POSIX 外部 SIGTERM 测试。
- Flash 新控件及既有面板状态、性能、额度、冷却 JavaScript 回归：`89 passed`。
- 受保护的 11 个路由源码 AST 指纹与 `d1007/6245cbb` 一致。
- 既有 9 个真实路由超时用例补充合成内存路由存储和配置缓存，保留原有 504 及单次逻辑计数断言；不涉及生产代码修复。

这些测试验证本地行为，不证明真实上游对 `generateContent` 的当前可用性。上线选择 `native` 后，应先小流量验证；需要恢复原行为时选择“跟随全局”，或将环境变量改为 `inherit`。

## 2026-10-09 本地真实凭证测试

按用户授权，只读使用指定测试目录的一份凭证，不导入既有服务或数据库。所有短期token当时均已到期，通过原OAuth helper在内存刷新一次成功（HTTP 200），原始凭证文件hash未变。

实际调用本地router、converter、API和HTTP路径，测试模型为 `gemini-3.8-flash-low`，选择 `native` 并将全局流转非流设为开启，真实请求仍使用 `generateContent`，确认Flash独立覆盖选择生效。本次已启用脚本输出护栏（`output_budget_guard_applied=true`），最终发送的 `maxOutputTokens` 为512（`effective_max_output_tokens=512`），并非生产normalizer的64000。

此请求的上游及协议响应均为HTTP 429，无成功生成正文或usage。按停止规则未继续 `stream_collect`、真实流式、OpenAI或Anthropic，不将这些项目标为真实通过。此次只能确认OAuth刷新和真实transport选择，未获得native可成功生成的证据；一份凭证的429结果不能推广为所有账号或该接口均不可用。

本任务真实HTTP共2次（OAuth 1、native 1），累计预算8次。未自动重发、切换传输、轮询其他凭证或模型。本任务唯一OAuth刷新已使用，token未持久化；剩余6次预算也不足完整矩阵，因此后续脚本修复后未再实测，余下真实验证明确未完成。若要再次实际验证，需另行明确启动测试任务及安排预算，不自动探测429恢复或重置已有次数。

手动脚本 `scripts/verify_antigravity_flash_live.py` 默认只预检。真实调用需同时显式传入 `--execute` 和 `--max-http-requests`，缺少预算参数会拒绝执行。调用者必须跨运行累计预算，以 `--max-http-requests` 传剩余额度，并依据最终 `network_summary` 结算；计数未知时全额扣除预占。

脚本为限制测试消耗，在最终HTTP payload中仅将输出上限压为512，并明确记录 `output_budget_guard_applied`。既有生产normalizer会强制64000；该测试护栏不改变生产行为，也不证明产品遵守客户max_tokens或默认64000请求在真实上游可用。


脚本后续修订增加完整矩阵预算和token有效期前置检查，仅用合成数据/模拟HTTP验证。完整矩阵为7次生成，需要刷新时共8次；显式预算不足时在OAuth/生成前退出，报告 `insufficient_complete_run_budget` 和0次网络请求。存储token及刷新返回token的剩余有效期须严格超过735秒，覆盖7次90秒生成、45秒刷新和60秒余量；不足或未知时不继续生成，也不追加刷新。上述修訂并未重新调用真实上游，不能称为修订版脚本的真实测试通过。
