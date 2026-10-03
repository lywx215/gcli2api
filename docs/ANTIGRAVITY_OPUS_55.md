# Antigravity Claude Opus 5.5

更新日期：2026-10-03。范围仅为 Antigravity Opus 4.6 切换到 Opus 5.5；
不恢复 Gemini CLI 或已取消的统一管理开发，不同时适配 Sonnet 5.5。

## Google 官方接口证据

2026-10-03T13:14:12.559800Z（北京时间 2026-10-03 21:14:12），
使用一个现有有效 Pro OAuth access token，直接请求
Google 官方端点 `POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`，
收到 HTTP 200；响应 `Date` 为 `Sat, 03 Oct 2026 13:14:12 GMT`。
本次响应的 Opus 模型为：

| 原始模型 ID | 官方展示名 |
| --- | --- |
| `claude-opus-5-5-low` | Claude Opus 5.5 (Low) |
| `claude-opus-5-5-medium` | Claude Opus 5.5 (Medium) |
| `claude-opus-5-5-high` | Claude Opus 5.5 (High) |

Google [Antigravity 模型说明](https://antigravity.google/docs/models)也列出 Opus 5.5
及其 Pro 正式订阅 / Ultra 适用条件；请求模型 ID 以本次官方接口实际返回值为依据。
本次 Pro 响应未包含 Opus 4.6，这不代表已证明所有账号均已退役 4.6。
该次目录查询未发送内容生成请求；三档真实生成结果见下方独立验收记录。
目录查询过程中只读已有凭证，未刷新 token、修改数据库或保存凭证明文。

## 接口与兼容行为

- 公开目录改为 Opus 5.5 的 `low`、`medium`、`high` 三档，仍与上游可用模型取交集。
- `claude-opus-5-5` 裸模型名默认解析到 `claude-opus-5-5-medium`；
  未公开列出的 `claude-opus-5-5-thinking` 兼容别名同样解析到 Medium；
  明确指定三档时保留原始档位 ID。
- Opus 4.6 请求在本地返回 HTTP 400 和固定英文错误，不转发到上游，
  也不自动改写为 Opus 5.5。检查覆盖每个路径段内的旧完整标识，
  功能前缀、未知前缀、后续路径或尾斜线均无法绕过；`4-60` / `4.60` 不误判为 4.6。
  其公开模型入口和额度面板条目不可见；若 Google 原始额度响应仍含 4.6，
  原始额度 API 保留该条目及原始 ID，标记不可见，不伪造新的上游结果。
- 验证脚本的 Opus 家族改为 `claude-opus-5-5`，优先验证 `medium`，
  不可用时依次选择 `high`、`low`。指定 `--models` 可逐档验证精确 ID，
  与家族/全量选项互斥，去重保序且仅接受当前公开目录包含的 ID。
  该模式只允许临时隔离服务，并关闭自动生成重试，每个指定档位最多派发一次生成请求。
- 新请求归入 Opus 5.5 统计；历史 Opus 4.6 统计与冷却状态保留原有名称和归属，
  不迁移已有数据，历史状态不使 4.6 重新成为可请求模型。
- Management schema、capability 和 `panel-version.txt` 无变化；
  manager 无需配套动作（`no_counterpart_action`）。
- 此次只修改本地实现与回归测试，不部署、不修改真实凭证或生产状态。

## 当前验收

本次严格切换版本最终完整隔离回归：**2078 passed、0 skipped、8 warnings**（34.35 秒）；
`node --check front/common.js` 与 `git diff --check` 均通过。
8 条提示均为既有 Pydantic、pypinyin 和 Starlette 弃用警告。
2026-10-03 13:39:07–13:39:19 UTC（北京时间 21:39:07–21:39:19），
使用一个已有且有效的 Pro access token 完成三档各一次真实最小生成。
临时受限转发器直接连接 Google 官方 `https://daily-cloudcode-pa.googleapis.com`，
仅放行模型目录与生成端点，并记录实际发送的模型 ID：

| 实际上游模型 ID | Google HTTP | Google 响应 Date（UTC） | 最终正文 | 生成次数 |
| --- | --- | --- | --- | --- |
| `claude-opus-5-5-low` | 200 | 2026-10-03 13:39:15 | 测试成功 | 1 |
| `claude-opus-5-5-medium` | 200 | 2026-10-03 13:39:16 | 测试成功 | 1 |
| `claude-opus-5-5-high` | 200 | 2026-10-03 13:39:19 | 测试成功 | 1 |

三次请求均通过本地候选服务的路由、凭证选择和转换链路，
最终正文均为四个汉字，临时统计增加 3 次成功、0 次失败。
这是本次 Pro 账号的实际可用性证据，不保证其他账号、套餐或时间的可用性。
生产 SQLite 只读提取一条凭证的 access token、expiry、project_id；
未取 refresh token、client secret 或邮箱，未刷新令牌，也未写生产数据库。
临时源库权限为 0600，位于 0700 临时目录，源库和候选库均已自动清理；
脱敏结果保存在 `/private/tmp/gcli-opus55-live-final.json`，不含凭证或项目标识。

真实生成仅使用自动清理的临时服务与临时数据库，不使用 `--live-url`；
精确三档验证命令为：

```sh
python scripts/validate_antigravity_model_catalog.py \
  --source-db /path/to/read-only-source.db --port 7862 \
  --models claude-opus-5-5-low claude-opus-5-5-medium claude-opus-5-5-high \
  --workers 1
```

每档只要求回复 `测试成功`，非流式输出上限 256 tokens；缺少任一指定公开 ID 时，
在生成前终止，不自动改档、探测其他家族或增加生成次数。源 SQLite 使用只读连接，
仅取一条启用的 Pro 凭证写入临时库，生产凭证和状态不变。

## 历史快照验证

2026-10-03，严格切换规则实施前的完整隔离回归：
**1709 passed、0 skipped、8 warnings**（35.50 秒）。
覆盖单元测试、Management 协议测试和 Legacy 回归；8 条提示来自既有的
Pydantic、pypinyin 和 Starlette 弃用警告。
`node --check front/common.js` 与 `git diff --check` 均通过。

前一快照曾通过 1677 项测试；补齐面板旧 Opus 别名的实际模型统计归属及 32 项回归后，
重新执行上述历史快照验证。该快照曾将旧 4.6 请求映射到 5.5；
当前方案已改为本地 HTTP 400，故这些通过记录不能代替当前版本的重新验收。

测试使用临时凭证与日志目录，清空外部数据库、Redis、代理和 keepalive 配置；
网络测试仅使用本机回环模拟服务。诊断契约依赖安装于临时目录，未修改依赖锁文件。
首次执行因缺少诊断测试依赖无法收集，补齐后又遇到沙箱禁止回环监听；
允许本地测试监听后完整重跑通过。上述回归不包含 Google 真实内容生成，未执行部署。
