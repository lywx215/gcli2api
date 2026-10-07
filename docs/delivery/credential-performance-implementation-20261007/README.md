# p08 凭证页面性能实施交付（2026-10-07）

基线：本地 master `f1ddd675bdcd7d8a1a2e2534a0618ca3dbb9adba`，工作区 `gcli2api-master-integration`。保留既有未提交的跨页取消选择修复。p08此前确认运行d1004-1/d9b65ba；本轮未部署，因此本地改善尚未进入p08。

## 实施范围

- Antigravity 列表使用每实例单份轻量索引，缓存从读取开始计时最多5秒；完整展示字段仅批量补读本页。权限、额度和403分类的筛选与统计保留原顺序，倒计时和权限有效期每响应重新投影。超50,000项或估算32MiB转有界流式扫描；全库扫描最多一路，最多20等待读请求。缓存只用于列表展示。
- 所有目录HTTP统一进入最多5路的加权公平broker，后台最多1路；全进程批量5个worker、200等待文件，每请求按10项窗口执行。独立原子CAS容量最多200，响应超时或取消后已开始写入保留强引用，明确待确认；后续业务写入停止，租约清理仅匹配原generation/lease。
- 前端合并同条件在途GET、取消过期GET，写后升刷新版本；自动刷新按filename保留展开节点。批量固定去重名单，10项顺序POST，持续进度、停止后续批次、逐文件结果及一次30秒待确认补读；权限能力撤回与登出保护保留。

## 配置及失败语义

`ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS`（T）：未设置表示未知；正有限秒数表示已经确认的最短链路期限；显式`unbounded`表示确认无代理期限。NaN/inf/非正数及其他非法文本明确拒绝。列表工作预算默认15秒，有限T时取min(15,T-10)，T≤10不扫描。队满503、超时504、配置错误503，不能返回部分统计或能力降级。

新窗口/单项默认50秒，包括准备、OAuth（最多15秒）、目录Google HTTP（最多30秒）、排队和CAS。旧N>10请求整体预算50×ceil(N/10)，受有限T-10及可选正有限`ANTIGRAVITY_LEGACY_BATCH_WORK_TIMEOUT_SECONDS`约束；未知或无期限T不把旧请求强制压成一个窗口。未进入prepare的文件started=false，已开始不能伪报未执行。查询成功与回写待确认分别表达。

`ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS`（S）：正有限秒或unbounded；未设置时最多等待5秒并记录实际停止期限未验证。关闭入口统一计时，有限S等待max(0,min(30,S-5))。没有确认的结算保持未知，连接关闭或强杀不能当作回滚。 本项目`python web.py`的单worker和asyncio多worker主入口从实际信号统一计算期限，覆盖HTTP drain、ASGI启动/关闭和应用异步清理等待。多worker适配仅接受接口检查通过的Hypercorn0.17/0.18 asyncio worker（本机真实验证0.18.0），其他版本/worker明确拒绝。第三方ASGI宿主控制自己的信号；同步阻塞、driver/default-executor线程、解释器最终join及OS进程回收不属于此异步等待边界。loop.close不确认任何未完成写入。

`ANTIGRAVITY_PANEL_TIMING_SAMPLE_RATE`默认0.01；合法值0到1，非法值回退0.01。采样仅输出固定阶段、固定结果、耗时和行数，不输出凭证名、账号、令牌、响应原文或任意异常文本。

Legacy面板响应只增量添加安全错误码、phase、started及回写状态；Management schema/capability不变，manager无需动作（no_counterpart_action）。无需DDL、Redis或广播。跨实例显示缓存最多额外滞后5秒，加上在途读取时间，不承诺所有接口线性一致。

## 证据与边界

完整隔离pytest与Node已通过，详见下节；基准使用合成数据和真实临时SQLite，其他后端为driver doubles/mock，不属于p08线上实测，也不证明真实PostgreSQL/MySQL/Mongo连接性能。尚未验证Python3.13与实际p08停止期限S。本轮不部署、不重启、不修改生产数据，不手改面板版本，不提交或推送。

此前7轮实际Claude仅审方案正文，最终findings=[]；不将方案通过写成代码通过，也不手工改Hook正式批准状态。实际代码审核结果另行记录。

## 回退

按第三批前端→第二批目录调度及预算→第一批列表索引逆序撤回性能实现，保留原跨页取消选择修复。共享链路期限解析模块只随第一批最后撤回。不得将待确认写入报告为回滚成功。

## 本机合成SQLite性能证据

真实临时SQLite、合成账号、每页25项，修复首轮列表/统计问题后重新测量。脚本[benchmark_panel_index.py](benchmark_panel_index.py)，最终计时原始结果[benchmark-panel-index-final.jsonl](benchmark-panel-index-final.jsonl)。本机单次结果会随进程调度和磁盘状态波动，不属于p08线上测量。

| 项数 | 旧路径秒 / SELECT | 新冷路径秒 / SELECT | 新重复路径秒 / SELECT | 重复轻扫描行 / 重展示行 | 缓存估算字节 |
| --- | --- | --- | --- | --- | --- |
| 2,000 | 0.393 / 5 | 0.212 / 2 | 0.022 / 1 | 0 / 25 | 4,556,073 |
| 10,000 | 1.009 / 5 | 1.044 / 2 | 0.095 / 1 | 0 / 25 | 22,780,073 |
| 50,000 | 14.232 / 5 | 12.329 / 2 | 12.159 / 2 | 50,000 / 25 | 0（超过32MiB，有界流式） |

10,000项热请求只补读25项，不扫描全库凭证；此单次测量约为旧路径的1/10.6。JSON解析调用由旧路径130,000次降至新冷路径50,175次、热路径175次。冷请求要建立索引并估算内存，仍可能略慢，因此不声称所有请求都提速。50,000项超过对象容量，无热缓存收益，查询次数由5降至2、解析调用由650,000降至250,175，只保留页和处理批次。TTL未延长；慢于5秒的构建只共享当前在途同键请求。

独立tracemalloc探针峰值分别为4,689,681／22,627,314／33,235,366字节，见较早的[内存探针原始结果](benchmark-panel-index.jsonl)。该探针直接调用内部单次构建，未套请求工作期限，且早于最后一次仅计时测量，不能用作15秒预算验收；追踪开销可能使构建超过5秒，故其缓存不发布。对象估算只扣除实际共享常量（40种）的重复大小，未提高32MiB上限。JSONL里的legacy `index_scan_rows/page_rows=0`表示旧路径未经过新索引仪表，不能解释成旧路径未读取/解析数据；旧路径的全量读取由源码、SELECT和解析调用证据另证。

## 实际代码首轮审核修订

[Claude实际代码首轮报告](claude-code-review-round1.json)提出7项问题，保留原报告及被审源码SHA-256；不覆写历史结论。此次修订包括：最终新鲜列表只校验本页删除/凭证身份，避免无关写入连续拒绝；整体批量预算耗尽不再创建后续窗口，未开始结果明确request_budget；按真实进度记录OAuth/HTTP/CAS阶段；broker内部关闭取消映射安全错误而调用者取消继续传播；主入口从真实信号开始关闭预算；立即记录待确认数量；Mongo成功计数恢复原子$inc，四后端恢复统计失败的原兼容返回行为。

额外独立复核修复了CAS已完成但owner尚未消费时取消的竞态（结果保持pending或已确认，不伪报skipped），以及Hypercorn启动等待和asyncio.Runner抗取消清理可能绕过绝对期限的问题。真实离线Hypercorn信号和抗取消子进程测试与多worker协议/mock证据分开记录；不将其视为p08停止期限S已核实。

## 五次重复样本

[重复原始结果](benchmark-panel-index-repeated.jsonl)每规模每路径5次。p50使用中位数，p95使用nearest-rank；5个样本的p95即该组最大值，只作本机波动展示，不能推断生产尾延迟。

| 项数 | 旧路径 p50 / p95 秒 | 新冷路径 p50 / p95 秒 | 新重复路径 p50 / p95 秒 |
| --- | --- | --- | --- |
| 2,000 | 0.2072 / 0.4010 | 0.2212 / 0.2275 | 0.0229 / 0.0241 |
| 10,000 | 1.0650 / 1.0899 | 1.1097 / 1.1372 | 0.0976 / 0.0999 |
| 50,000 | 6.8301 / 14.1739 | 4.8718 / 11.8992 | 8.5680 / 13.3801 |

50,000项没有热缓存，因此两次新扫描耗时会波动；本组重复扫描p50甚至高于旧路径，不能声称超容量时每次都更快。全部新请求均在默认15秒预算内完成，查询与解析数量证据与单次表一致。

## 最终验证（第四轮审核的源码快照）

- Python3.12.14：完整隔离pytest **2,946 passed / 2 skipped / 6 warnings**，152.43秒，正常退出0；包含Management/Legacy契约和既有兼容回归。[原始输出](pytest-final.txt)。Windows跳过原有`test_actual_fork_child_identity_and_writer`及新增POSIX外部SIGTERM+空闲Hypercorn测试，spawn/重启及Windows真实本地信号/抗取消回归仍运行；6条为既有Pydantic/Starlette弃用告警。未验证Python3.13。
- Node：四个测试文件 **66/66通过**，正常退出0，包括最新跨页取消全选修复、23项10/10/3窗口、停止后续批次、写后读取、卡片/详情缓存、能力撤回与登出重登录。[原始输出](node-final.txt)。
- 针对性：索引与四后端额度68项、批量deadline与目录/关闭运行时最新62项通过、1项POSIX跳过；Legacy/Management额度37项通过；完整套件包含这些测试。首轮完整重跑有4项日志断言因隔离ENABLE_LOG=0失败，随后仅把子进程合成告警改为显式spy，最终完整重跑正常通过，未把失败轮次标为通过。
- 真实临时SQLite、真实本地Hypercorn0.18.0+信号/抗取消子进程，与PostgreSQL/MySQL/Mongo driver doubles及multi-worker协议/mock分别记录。Mongo128路并发替身确认原子计数完整；不推断真实远程数据库性能或多worker线上停止时序。
- `git diff --check`通过，master基线仍f1ddd675；panel-version、Management实现/契约、协调交接无新增变更。无DDL、无manager动作、不提交/推送/部署/重启/生产写入。

实际Claude代码已完成四轮审核，最后findings=[]；各轮历史结果见下文。

## 实际代码第二轮审核修订

[Claude实际代码第二轮报告](claude-code-review-round2.json)提出2项问题。单worker信号处理在同步记录原期限后调用`loop.call_soon_threadsafe(event.set)`，显式唤醒POSIX selector；测试覆盖Windows可运行的唤醒调用/处理器恢复，以及仅POSIX平台可运行的外部SIGTERM+空闲Hypercorn回归（本机Windows跳过，未声称Linux实测）。目录/批量/生命周期定向61 passed、1 skipped。

Legacy/Management复用的`_fetch_quota_for_credential`遇到本地`error_code`不写目录失败，避免排队满、期限和关闭错误造成900秒权限退避；真实TEMP SQLite合成测试确认这三类错误不改变权限或缓存epoch，确认Google403仍保留原900秒退避。连同原有Legacy/Management额度回归37 passed；Management schema/capability与manager动作不变。

调度补充合成测量：20个100ms asyncio操作完成0.4332秒；混合四类35项时峰值总并发5、后台1，最终队列和active均0。该模拟未调用HTTP/OAuth/数据库，不代表Google或p08时延。原始结果见[调度合成测量](directory-synthetic-benchmark.json)。

## 实际代码第三轮审核修订

[Claude实际代码第三轮报告](claude-code-review-round3.json)指出信号处理器直接关闭队列会重入正常记账。修订后处理器仅记录首次monotonic时间并用`call_soon_threadsafe`安排普通loop callback，所有runtime/config/log/队列修改都在该callback执行；提前退出也使用已捕获的首次信号时间，不延长预算。定向62 passed、1 POSIX skipped；新增在无await记账段触发重复信号的纯调度断言及callback未运行前serve早退的确定回归。

第二轮修订快照曾完整通过2,945项、跳过2项；这属于第三轮信号修订之前，不能作为最新源码的最终验证。最新完整回归通过2,946项、跳过2项，第四轮实际Claude返回findings=[]。用户此前明确暂时无视3次限制，本次沿用已授权的实际代码复审，不手工修改Hook正式批准状态。

## 最终实际Claude结论

通过本机共享`C:/Users/lywx2/.codex/review/hook.py`的既有`ask_claude`入口，实际模型`claude-opus-5-5`完成四轮代码审核：首轮7项、第二轮2项、第三轮1项、第四轮`findings=[]`。方案此前7轮正文审核与本次代码审核分别记录，不复用为代码通过证据。

[第四轮实际报告](claude-code-review-round4.json)包含审核起止时间、方案SHA-256及被审文件SHA-256。审核完成后核对全部实施源码/测试/前端与报告hash一致；后续仅追加本交付记录、最终测试输出和既有合成测量归档，未修改实施代码。Hook正式批准状态未手工改写。

性能实施完成时，本地master基线为f1ddd675，全部改善保留为未提交变更；后续Git交付授权见下节。p08运行代码、生产凭证/数据库、面板版本、Management schema/capability未由本轮修改；真实线上验收需后续授权及实际流量。Python3.13、真实远程PostgreSQL/MySQL/Mongo、Linux信号和p08实际停止期限S仍未验证。

## 后续Git交付授权（2026-10-07）

所有者随后要求提交当前本地master，不推送远程master；从提交后的最新master新建`d1007`，仅推送到`origin/d1007`。此次交付包括已验证性能实现、跨页取消选择修复、针对性测试、调查与审核证据；实施源码保持Claude第四轮审核快照。提交Hook继续保留原面板版本，不新增版本更新授权。实际提交SHA与远程分支核对结果在本次操作回复中记录。

此Git授权不包含Zeabur部署/重启、生产数据或凭证变更；原线上与其他运行环境验证缺口继续保留。

提交准备时标准化了归档输出的换行，并移除历史合成复现及基准脚本末尾空行；JSON数据等价、脚本AST一致，相应更新历史证据哈希。实施源码与测试未改动。
