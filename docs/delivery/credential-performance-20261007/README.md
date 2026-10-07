# p08 凭证页面性能退化调查（2026-10-07）

主要退化来自 10 月 4 日新增的全量权限统计、额度组统计和共享目录并发门。它们影响后台成本；前端现有的完成等待与重复点击方式进一步放大用户等待。此报告给出代码归因和隔离复现，未实施性能优化。

## 实际运行范围

用户确认截图来自 p08。共享 [zeabur-ops 技能](C:/Users/lywx2/.codex/skills/zeabur-ops/SKILL.md)只读核对：服务 RUNNING，绑定 d1004-1，GitHub 与部署 SHA 均为 `d9b65ba`。本地 master 为 `f1ddd67`，另有昨天跨页取消选择的未提交修复；这些未发布变更不在 p08 此次运行范围。

部署 SHA 是标识匹配证据，未验证容器文件逐字节一致。有限运行日志没有提供接口耗时、存储后端、总账户量、CPU/连接池/锁等待。下面的行号指向本地 master；涉事函数行为与 d9b65ba 一致。

## 具体变更归因（北京时间）

| 引入提交 | 时间 | 已确认的成本变化 |
| --- | --- | --- |
| afbcd21 | 10-04 16:58 | 新 Opus 权限保护把面板额度、目录读取与后台恢复共用全局 Semaphore(2)；批量外层5路因此实际最多2路上游查询。排队没有总体 deadline，30秒上游 timeout 取得名额后才开始。 |
| 0ff4b2f | 10-04 18:36 | 权限总览和筛选把 Antigravity 摘要强制 offset=0、limit=None，先处理全部匹配凭证再分页；新增一次全库权限读取。即使没有权限筛选也执行。SQLite 默认分页快路径被绕过。 |
| 10d9313 | 10-04 20:31 | 共享额度筛选增加额度状态解析；SQLite 默认列表重复全表额度/冷却统计，同一条额度投影算两次。前端新增全局冷却到期自动刷新。 |
| 0c589f4 | 10-04 22:28 | 双版本权限展示再增加一次全库 family 权限读取，实际重复读取相同四列并重新做 JSON/身份散列校验。每条手动额度查询也增加版本状态补读。 |

`d9b65ba` 保留上述结构，列表相关改变主要为能力错误响应及生命周期防护；未带来新的列表数量级变化。

### 列表加载与刷新

- [creds.py](../../../src/panel/creds.py:568)：后端摘要 `limit=None`；587、588 两次全库权限读；筛选后才分页。页面仅25项不代表后台只处理25项。
- [antigravity_model_access.py](../../../src/storage/antigravity_model_access.py:77)：family reader 再调用同一个 list reader；88–110 两次各读 filename、credential_data、generation、model_access_state。权限 identity 校验需要解析当前凭证内容（仅内部使用），两次重复解析/散列。
- [sqlite_manager.py](../../../src/storage/sqlite_manager.py:1597)：默认开启的 bounded 路径要求 limit 为整数，None 强制落到 legacy。旧路径仍有全局冷却扫描，所以不能声称旧总复杂度完全 O(P)。主要放大的是完整摘要、403补充分类和权限身份处理。
- [error_classification.py](../../../src/error_classification.py:197)：原只补当前页的403错误信息，现在覆盖所有匹配403账户；每500项一批。它是批次数膨胀，不是每行一次查询。
- [sqlite_manager.py](../../../src/storage/sqlite_manager.py:2058)：Antigravity 额外全库冷却读取与逐条配额投影，默认无过滤也执行。

SQLite 普通无过滤、权限 ready、bounded 默认 true、初始化完成时，基本 SELECT 从3变5；另外403补读从 ceil(K_page/500) 扩大到 ceil(K/500)。关闭 bounded、使用原错误/冷却筛选时旧代码本就走 legacy；其他筛选可有额外COUNT。PostgreSQL/MySQL/Mongo旧代码本来就做全摘要后 Python 分页，其新增主要成本是两次全权限读取、403补读范围及额度解析，不能套用 SQLite 快路径归因。Mongo cursor getMore 还可能增加实际网络往返。

### 查看额度与批量检测

- [antigravity.py](../../../src/api/antigravity.py:1242)：全部 `fetch_quota_info` 等共享2路名额。
- [antigravity_access_runtime.py](../../../src/antigravity_access_runtime.py:15)：后台持名额范围包括 claim、读凭证、可能的 OAuth、Google查询、权限写回；后台每60秒扫描待检，2个worker处理。名额可能被后台数据库/刷新令牌等待占用。线上实际竞争程度尚未采样。
- [antigravity_manual.py](../../../src/panel/antigravity_manual.py:58)：成功且无需换代/刷新令牌路径仍有 snapshot、access snapshot、Google、observe、public、family public、额度同步等串行步骤。
- 以Mongo无冲突、generation已存在、token未过期、Google成功为例：4次单读+2次原子读写，静态8次DB往返；170d989对应1次单读+1次原子，静态3次。该数未计配置/Redis、CAS冲突，属于代码静态计数而非真实Mongo测量。
- 数据库原子操作会用 SQLite BEGIN IMMEDIATE、SQL行锁或Mongo CAS；它们会增加并发时资源争用风险，但锁未跨Google HTTP持有，不能把HTTP等待全算作数据库锁。
- OAuth 的900秒默认 timeout 是旧问题，并非10月4日新增；缺少整体 deadline 会把它变成长批次尾部等待。

### 前端放大因素与普通凭证详情

- [common.js](../../../front/common.js:2662)：批量POST成功后仍 await 列表refresh，之后才显示完成。批量实际等待加上已经变慢的列表等待。这段来自旧 e9988eff。
- [common.js](../../../front/common.js:417)：任务编号废弃旧响应，但不 abort/coalesce 旧请求。连续刷新/改筛选仍让服务器执行多个全量请求。
- [common.js](../../../front/common.js:2610)：批量没有busy保护；重复确认可发并发批量POST。开始toast约3.3秒消失，缺少持续进度，用户可能误以为没启动而重复点击。该交互欠缺是旧问题，近期后端变慢将其放大。
- [common.js](../../../front/common.js:4487)：10d9313新增到期自动refresh会清空列表、重建卡片、丢弃详情缓存；可能碰上正在展开的额度请求，detached-node保护丢弃显示结果，再次展开会再查询。成功刷新会移除过期时间，不能称为永久15秒轮询；分散的全局截止时间可能持续触发。
- [common.js](../../../front/common.js:1412) 与 [creds.py](../../../src/panel/creds.py:1261)：普通查看内容仍为按需单账户读取，近期未新增Google请求。此操作变慢可能是共同数据库/事件循环资源争用；尚无线上阶段耗时，不能把它直接归因于某个新详情步骤。
- 正常首次列表加载经隔离验证仅1条status请求；能力恢复的额外请求是条件触发。默认25卡片的渲染未有浏览器CPU/时序证据，不能将增加徽章当主因。

## 隔离复现结果

### 1. 额度并发

抽取当前真实 fetch_quota_info AST，底层替换为100ms模拟IO；20项、批量外层5路：

| 路径 | 用时 | IO峰值 |
| --- | ---: | ---: |
| 共享并发门加入前的外层5路结构 | 0.436秒 | 5 |
| 当前实际共享门+外层5路 | 1.079秒 | 2 |

单并发限制约2.475倍；未模拟后台竞争、数据库和Google，不能当作p08端到端倍数。

### 2. 列表规模

抽取5个提交实际 status函数、SQLite bounded门禁、纯错误分类器；以内存假存储和权限计数桩执行。10,000账户、每页20：

| 提交 | 摘要物化条数* | 权限读取条数* | 全部403时错误补读 | 返回条数 |
| --- | ---: | ---: | ---: | ---: |
| 170d989 | 20 | 0 | 20 | 20 |
| 0ff4b2f | 10,000 | 10,000 | 10,000 | 20 |
| 10d9313 | 10,000 | 10,000 | 10,000 | 20 |
| 0c589f4 / d9b65ba | 10,000 | 20,000 | 10,000 | 20 |

*由实际调用参数/门禁驱动的桩模拟，验证工作量规模；不是实际SQL执行基准。403列是全部账户都为403的案例，无403时补读0。

### 3. 真实前端函数离线桩

正常首次加载1条请求；连续刷新3条并发请求、0个abort signal；批量POST成功而status未返回时完成弹窗0个，status返回后1个；两次确认产生2个批量POST、禁用按钮0；开始toast在未完成时清空。脚本所有断言通过，无浏览器真实渲染计时。

## 建议改善顺序

1. **优先恢复列表读取规模。** 合并两次权限SELECT与校验为一次同快照投影；将页面摘要和全局统计分离，保留先筛选后分页正确性，普通页面恢复SQL分页；在全局计数需要扫描时使用必要字段并复用一次额度解析。不能直接在权限筛选前截断候选，所有版本与额度筛选语义应保持。
2. **治理额度队列。** 为手动交互、批量与后台恢复安排有界且公平的调度，给手动操作优先级；将排队纳入整体deadline，明确显示等待。根据上游限流证据调整并发，保留后台恢复上限；先避免后台DB/OAuth占用查询名额的时间。
3. **减少手动成功路径串行补读。** 在CAS和身份代次校验完整的前提下，从一致结果同时生成public与family投影，减少快照/public重复读取。
4. **先反馈批量结果，再刷新列表。** 增加busy/防重复提交/持续已处理进度；合并重复status请求，保持展开内容并避免到期刷新销毁进行中的额度视图。
5. **用p08阶段耗时验收。** 分开记录列表summary、权限SQL、身份校验、过滤分页、序列化；额度queue_wait、OAuth、Google、CAS写回；浏览器请求TTFB/渲染和批量后的列表等待。用实际账户量和后端测p50/p95及查询数。现有证据不足以承诺改善到具体毫秒。

保持权限、额度和CAS安全语义；管理schema/capability及manager动作不涉及此诊断。当前仅新增报告与合成证据，业务代码未进行性能修改；先前3个未提交跨页取消选择修复保留。未调用Claude、生产模型/额度API，未修改生产凭证/数据库，未部署、重启、提交或推送。

## 证据文件

- storage-synthetic.py / storage-synthetic.jsonl：真实status函数参数与工作量复现。
- quota-concurrency.py / quota-concurrency.json：实际并发wrapper的模拟IO基准。
- frontend-request-repro.cjs / frontend-request-repro-output.txt / frontend-findings.txt：真实前端请求与反馈顺序复现。
- deployment-observation.txt：经筛选的p08部署标识与只读状态证据。

脚本默认针对本次工作区/提交运行；全部使用合成数据，非生产接入工具。
