# Antigravity Claude Opus 5.5

当前权限保护说明见 [按凭证权限保护](ANTIGRAVITY_MODEL_ACCESS.md)（2026-10-04）；以下保留首次模型切换及后续部署证据。

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
- 上述首次切换仅修改本地实现与回归测试，未部署、未修改真实凭证或生产状态；
  后续 p04 / p05 排查与发布验收单独记录如下，不将首次隔离验收视为生产验收。

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

## p04 / p05 分类问题：部署与运行文件验收

2026-10-03，所有者反馈 p04、p05 的面板分类异常，并明确指出 p05 已使用 master。
本轮分别检查服务实际绑定、部署记录、运行文件和面板数据路径；
不能仅根据分支名称、面板版本标签或一次 `RUNNING` 状态认定两台服务运行相同代码。
共享 Zeabur 工具的服务别名分别为 `p04` 与 `p05/gcli2api`；
p05 包含多个服务，裸别名 `p05` 不等同于其 gcli2api 服务。

### 版本显示的证据边界

排查基线为 `b7d97ccd738458fd20e84a4cc041c19adfff7af7`。该提交中的
`version.txt` 仍记录 `46e0b42`，`panel-version.txt` 仍记录
`dev8-20260907-1339`。Docker 的 `REVISION` 构建参数默认值为 `unknown`；
未注入有效 `GCLI2API_REVISION`、且容器内无法读取 Git 信息时，
`/version/info` 会回退到历史版本文件。面板显示版本还会优先采用手工维护的
`panel-version.txt`。因此旧标签不证明运行文件过旧，标签改变也不代替运行文件验证。
本轮不自动修改需所有者单独确认的 `panel-version.txt`。

根页面返回 `Cache-Control: no-store`，`common.js` 的查询参数包含其内容
SHA-256 前 12 位，即使版本文件不更新，前端内容改变也会改变该资源 URL。
应同时读取实际根页面及其引用的 JavaScript；仅浏览器截图或已有标签页不能排除旧页面。
前端文件匹配只能证明该前端资源，后端分类逻辑仍需独立验证。

### 每个服务必须独立完成的验收

1. 先读取服务实际 `gitTrigger` 的仓库和分支、构建根目录与监控路径，
   再读取该分支 HEAD；本地登记文件的分支只作定位参考。记录目标提交、当前部署 ID、
   最新部署状态及仍在运行的部署，保留失败构建的日志证据。
2. 新部署必须对应明确的目标 SHA，并达到 `RUNNING`；若最新构建失败，
   不能把仍可访问的旧实例当成本轮发布成功。共享工具 `redeploy --wait` 不校验目标 SHA，
   所以命令成功后仍须重新读取部署提交，不能仅凭等待结束验收。
3. 将容器内关键源码的 SHA-256 与目标提交逐一比较，至少覆盖模型目录、
   凭证额度响应、统计归属、人工测试及 `front/common.js`；公开 HTTP 返回的
   JavaScript 也须匹配。使用 `git show <目标提交>:<路径>` 计算基线，
   不把可能含未提交改动的工作区作为发布依据。
4. 面板回归必须使用真实后端响应结构，覆盖响应内的分组字段、公开标记、
   `badge` 及模型档位元数据；验证 Opus 5.5 Low / Medium / High 的显示与归类、
   旧 4.6 的隐藏、历史统计保留，以及桌面和移动端共用的实际渲染函数。
   仅构造理想化前端对象或确认目录出现 5.5 不足以证明分类正确。
5. 汇总本轮完整隔离回归与各服务的发布后结果；任一服务未取得证据时，
   明确保留未验收状态，不沿用上方 2078 项历史结果代替本轮结果。

部署修复只更换应用代码与必要的服务 Git 绑定，不迁移、重写或清空凭证、
SQLite 表、历史统计或 Zeabur Volume。回滚沿用同一数据卷，回到记录的上一可用制品；
恢复旧代码不代表旧模型重新获得上游可用性，也不修改已保存的数据以制造通过结果。

### 两个服务的不同根因

| 服务 | 排查时的运行证据 | 结论 |
| --- | --- | --- |
| p04 | 实际绑定 `d0930`，RUNNING 部署为 `170d989`；容器模型目录与 `common.js` 均匹配该旧提交，5.5 元数据为 `public: false`、兼容分类 | 旧代码没有当前 5.5 公开目录，导致兼容标签；更新绑定与代码后该问题已解决 |
| p05/gcli2api | 实际绑定 master，`2026-10-03T13:45:40.713Z` 的部署 `b7d97cc` 为 RUNNING；容器模型目录及 `common.js` 哈希匹配该提交，本地 5.5 三档元数据正确 | 本就运行正确的公开目录；应用协议下查询的一个有效 Pro 样本未获 Google 返回 5.5，不能通过重新部署制造该账号的上游额度 |

p05 本地工具登记的 `dev0927` 已过时，实际服务绑定和运行文件优先于登记信息。
只读检查真实 Web 进程环境及默认配置，确认 p04、p05 的 gcli2api **均使用 SQLite**。
p05 项目内的 PostgreSQL 属于其他服务，不能据此判断 gcli2api 的存储后端。
本轮未写生产数据库、凭证或额度状态。

### Google 目录的应用协议验证

脱敏证据为 `/private/tmp/opus-official-service-catalog.json` 的
`app_equivalent_rows`。验证从真实实现提取请求头，调用实际 `fetch_quota_info`，
以 `POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`、
JSON `{}`、`User-Agent: antigravity/cli/1.1.24 windows/amd64` 和
`requestType: agent` 查询；保留应用要求的其他请求头和请求 ID，未记录令牌值。
每个服务分别只取一个已有且有效的 Pro 凭证样本，未刷新令牌。

| 样本来源 | Google HTTP / 响应 Date（UTC） | Google 原始 Opus 目录 | 实际后端解析结果 |
| --- | --- | --- | --- |
| p04，一个有效 Pro 样本 | 200 / 2026-10-03 14:22:35 | `claude-opus-5-5-low`、`medium`、`high`，内部字段分别为 `MODEL_PLACEHOLDER_M400`、`M401`、`M402` | 三档均 `public: true`、`visible: true`、`availability: public`、`badge: null` |
| p05，一个有效 Pro 样本 | 200 / 2026-10-03 14:22:37 | 仅 `claude-opus-4-6-thinking`，内部字段为 `MODEL_PLACEHOLDER_M26`；无 5.5 | 旧 4.6 为 `public: false`、`visible: false`、`availability: unavailable`；不生成 5.5 额度条目 |

此前每个服务另查过三个样本，但这些查询的 User-Agent 和请求体与应用不同，
只作比较材料，不作为应用协议的可用性证据。上述结果只覆盖各自一个账号和该查询时刻，
不能推广到服务内全部账号；没有证据解释 Google 为什么对两个样本返回不同目录，
不归因为分批开放、会员计划或其他未经验证的原因。

上方 13:39 UTC 的 Low / Medium / High 三次真实生成均返回 HTTP 200 和“测试成功”，
是当时所用 Pro 账号的独立生成证据，不是 p05 样本已获得 5.5 的证据。
本节目录查询未追加真实生成请求。

### 已完成的阶段发布与后续验收

两服务均已绑定 master，并完成阶段提交
`10ca8d76e1aa2debf2ad9bd5cb6c2d5c241e6b3e` 的发布。
每个服务的 13 个关键运行源码 SHA-256 与该提交一致；公开 HTTP 返回的
`common.js` 也匹配，根页面返回 `Cache-Control: no-store`。
该阶段已解决 p04 的旧代码兼容标签，并排除两服务运行源码不一致的问题。

该阶段提交前完整隔离回归为 **2078 passed、0 skipped、8 warnings**（33.88 秒），
模型目录与面板真实响应结构测试包含在全套中；`git diff --check` 通过，
警告均为既有弃用提示。这些结果不代替后续面板提示修改的重新验收。

### 最终面板提示与回归

额度请求成功且返回有效模型对象时，面板按 Google 本次实际返回的目录显示提示：

- Low / Medium / High 全部缺失：提示“本次 Google 官方模型目录未返回 Claude Opus 5.5，
  暂无对应额度或可测试模型。”旧 4.6 仍隐藏；其他实际返回的模型照常显示。
- 仅部分档位缺失：列出缺失的档位名称，只显示已返回档位的额度卡片与测试入口。
- 三档齐全：不显示缺失提示，三档仍归入公开模型，测试按钮发送各自精确模型 ID。

缺少模型对象、模型对象格式无效、业务响应失败或 HTTP 失败时，不把错误误判为
“Google 未返回 5.5”。该提示复用已有响应，不追加请求，不修改原始响应对象，
不伪造模型卡片、额度、测试入口或账号可用性。桌面和移动端使用同一渲染实现。

最终代码完整隔离回归为 **2078 passed、0 skipped、8 warnings**（33.02 秒）；
`node --check front/common.js` 与 `git diff --check` 均通过，警告均为既有弃用提示。
回归使用真实后端解析形成的响应结构，覆盖三档齐全、各单档、部分缺失、仅旧 4.6、
空目录、仅内部模型，以及有效和无效模型对象、业务失败和 HTTP 失败的区别；
验证没有额外请求、伪造卡片或原始响应变更，并保留旧模型隐藏及精确测试路由检查。

最终发布的 Git SHA、部署状态和运行文件验收由脱敏报告
`/private/tmp/opus-final-verification.json` 记录，避免将文档自身的提交 SHA
循环写入本次提交。两服务须分别确认实际绑定 master、目标 SHA 的部署为 `RUNNING`、
13 个关键运行源码及公开 `common.js` 哈希与目标提交一致，并确认根页面的
`Cache-Control: no-store`。只有报告中的实际检查结果能够证明最终发布完成；
上方 `10ca8d7` 是已验证的阶段发布，不代表最终提示修改已发布。
