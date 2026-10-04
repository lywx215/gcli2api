# 模型路由只读预检与升级门禁

本工具检查候选版本对某个权威配置快照的兼容性。在线切版必须由现有部署流程提供以下冻结、排空和实例核验门禁；本任务不创建自动升级协调器，不执行生产部署、数据库迁移或 Management 动作。单次 exit 0 不表示在线切版安全。

## 工具使用与结果

在候选版本的 checkout 中，使用 Python 3.12+ 与该版本依赖运行：

```text
python -m src.model_routing.preflight
```

没有 URI、数据库密码、API Key、配置文件或路由键命令行参数；任何参数都安全拒绝，不回显参数。工具不加载 `.env`。数据库选择来自已经存在的进程环境，因此启动环境必须与实际实例的后端、数据库和作用域逐项核对。不要把连接串放进 shell 历史或公开记录。

stdout 只有一份安全 JSON，包含：

- `backend_identity_digest`：所选后端、连接位置及实际配置作用域的摘要；不包含密码。
- `config_digest`：canonical JSON `{"exists": bool, "value": raw_or_null}` 的 SHA-256；键排序、紧凑分隔、UTF-8、禁止 NaN。缺键与已存在的 null 是不同摘要。
- `policy_digest`：同一候选 checkout 中真实 compiler 使用的纯策略摘要。
- `validation`：两个渠道各自的 `valid` 与安全 issues；包含行号、固定 reason，不包含目标名、自由文本诊断、连接串或凭证。

退出码对应：

| exit | 含义 | 后续动作 |
| --- | --- | --- |
| 0 | 该次只读快照在候选策略下双渠道通过 | 继续外部门禁，不能直接切版 |
| 2 | 结构、语义或证明失败；也包括候选 compiler 不可用 | 保留旧版，修复配置或候选实现后重新预检 |
| 3 | 后端、读取、作用域或只读保证失败 | 保留旧版，核对实际后端、权限及基础设施；禁止回落 |

读失败时不可获得的摘要为 null，不伪装为空表。缺少配置键会以 `{"routes": []}` 编译；存在 null、坏 JSON、重复 JSON 字段、非对象或不可归属结构不转为空表。可归属渠道的失败只标记该渠道，整体退出码仍为 2；全局失败标记双渠道。

本工具延迟加载 `compiler.parse_route_table`、`compiler.compile_channel` 和 `policy.build_policy_snapshot`。缺模块时 exit 2。单元测试注入的 compiler mock 只验证报告边界，不是 MR02 或 MR06 真实依赖通过证据。

## 源码证明与进程更新

安装的源码 AST 指纹每进程只计算一次，避免在每个生成或目录请求中同步读取和解析大文件。
部署必须重启全部更新的进程；不支持在运行中原地修改 Python 文件并继续使用旧进程缓存。
只读预检使用独立的新进程，因此读取候选安装的实际源码。缓存不读取配置或动态模型目录。

当转换器、规范化、模型数据或协议结构的指纹不在已审范围内时，该渠道任何配置行
都必须重新证明，包括停用条目；否则报告 `AMBIGUOUS_COMPATIBILITY`，生成和目录安全 503。
只有真正没有行且没有该渠道解析错误时才无需目标证明，继续真实 legacy 链，
不因没有使用的映射能力阻断空表或缺键请求。坏行、未知渠道、坏 JSON 和读失败
不能伪装为空表。源码读取或 AST 解析失败仍属于安全故障，不绕过为成功。
不能通过自行重算并替换常量摘要来宣布新规则已获证明；应先审查实际规则并补相应测试。

## 严格读取约束

选择优先级与当前 adapter 的首次环境选择一致：`MYSQL_URI` 与非空 `GCLI_SERVER_NAME` 同时存在时选择 MySQL，其后 PostgreSQL、MongoDB、SQLite。预检忽略非严格模式的回落行为：选中后端失败即 exit 3，不尝试另一个后端。`REDIS_URL`、配置缓存、凭证缓存均不参与。

现有 `/storage-engine/switch` 可改变运行中实例的 adapter，而环境变量仍保留旧值；`STORAGE_STRICT=0` 也可能使实例此前已回落。CLI 不读取运行中 adapter，不能仅凭环境证明实际后端。必须从可信运行时信息逐实例核对；发现不一致或无法确认时，在线升级门禁失败。

| 后端 | 只读保证与作用域 | 失败条件 |
| --- | --- | --- |
| SQLite | 仅 Windows 已提供防删除/替换及非 WAL 切 WAL 的句柄保证；`CREDENTIALS_DIR` 下 `credentials.db`，空变量表示当前目录；`mode=ro`，只查询配置表元信息与 `config.key=model_routing`；禁止其他表读取 | 文件/配置表缺失、配置表为 view、句柄/权限/锁失败、同键多行、其他平台无法证明保证均失败 |
| PostgreSQL | 独立连接，从连接建立起默认只读；`repeatable_read` 只读事务并检查 `transaction_read_only`；绑定实际 database、认证用户、search_path、配置表实际 namespace | 只读状态未生效、配置表缺失/view/非本地表、连接到 recovery 副本均失败 |
| MySQL | 独立连接，不使用 pool；会话默认 `TRANSACTION READ ONLY`，验证只读变量后启动只读事务；绑定实际 database、认证用户、`GCLI_SERVER_NAME`，查询 `gcli_config` 单键；结束只 rollback/close | 会话只读无法证明、配置表非 BASE TABLE、权限不足、同键多行均失败 |
| MongoDB | 绑定 `MONGODB_DATABASE`（覆盖 URI path）、实际认证身份及集群选择选项；primary、local read concern；`connectionStatus(showPrivileges=true)` 检查完整有效权限仅为读取 action 白名单；检查现有 `config` collection，再查询同键最多两行 | 无认证、无完整权限证明、任何写入/未知 action、缺 collection/view、同键重复均失败 |

PostgreSQL/MySQL 的保证是该独立连接的只读会话和固定查询，不声称帐号本身没有写权限。MongoDB 没有对应只读事务保护，因此必须证明有效身份权限；拥有 `readWrite` 等额外能力的身份不能通过。若没有匹配权威后端作用域的可证明只读身份，应记录 exit 3，不用角色名称、一次 find 成功或管理员声明替代有效权限证明。

SQLite 不使用 `immutable=1`，以免忽略已经提交到 WAL 的新配置。Windows 使用 `CreateFileW` 的 `OPEN_EXISTING` 获取既存文件句柄，所有句柄始终不共享 DELETE。先尝试仅 `FILE_SHARE_READ` 的主库句柄，拒绝并发写入及删除/替换，证明非 WAL 文件在读取期间不能被切换到 WAL；若已有 writer 导致该强句柄失败，仅在主库已为 WAL、主库/WAL/SHM 三个既存句柄均可获取且再次读取主库 header 确认 WAL 时，才允许主库共享 READ|WRITE。WAL 与 SHM 都须既存，并允许 READ|WRITE 共享以保持现有 SQLite 读取协调；任一步失败都在 SQLite connect 前终止，不创建/重建侧文件。

全部保护句柄持有到 SQLite 连接关闭以后，阻止最后 writer 正常关闭时删除侧文件而造成 `mode=ro` 重建。其共享语义持续到句柄关闭，缺少 `FILE_SHARE_DELETE` 会禁止删除和重命名；依据是 [Microsoft CreateFileW 文档](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) 和 [DeleteFileW 文档](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew)。`HANDLE` 按指针宽度声明，所有 WinAPI 失败仅转为安全读取错误。

主库 header 的读写 journal 版本只接受成对的 `1/1` 或 `2/2`。混合版本 `1/2`、`2/1` 以及未知版本都在 SQLite connect 前安全失败；不能把非 `2/2` 一概当成普通非 WAL 文件，否则 SQLite 仍可能创建侧文件。

Linux/POSIX 普通 open 不能阻止 unlink，也不能证明初始非 WAL 文件不会被并发切换到 WAL；当前没有经过验证的 VFS/ACL 方案，因此这些平台的全部 SQLite 预检都返回 exit 3，不能宣称该平台严格只读支持。不要用复制数据库、忽略 WAL、修改 ACL/副文件、安装新依赖或先修复生产侧文件来替代本门禁。

工具不 checkpoint、不修改 journal mode。SQLite 自身的读取锁及现有 SHM 协调不等于数据库/WAL 写入；本工具不承诺整个目录所有字节绝对不变，也不阻止 WAL 分支中真实 writer 的已授权写入。隔离测试证明主库和 WAL 不因预检变化、最新 WAL 提交可见、最后 writer 在 connect 前关闭时侧文件身份保持不变，以及非 WAL 分支的新 writer 在切换到 WAL 之前被拒绝。writer 关闭自身可能合法 checkpoint，竞态 fixture 预先完成 checkpoint，以明确区分 writer 的动作与工具造成的文件变化。

这些连接不调用普通 adapter 的 initialize，不导入 web，不创建表、索引、凭证目录、后台任务或 Redis；不修复凭证/文件名，不全量载入配置或凭证。允许的网络仅是上述严格只读数据库连接，OAuth、Google、目录 listing 和模型业务调用均为零。

## 在线切版的外部顺序

1. **确定权威存储与候选版本。** 列出全部实例、全部可写入口、实际 backend/scope、候选构建及 `policy_digest`。核对 MySQL server scope、Mongo database、PG search_path/实际配置 namespace、SQLite 绝对路径/挂载。环境选定后端与任何实例实际 adapter 不一致时停止。对不同权威作用域分别建立摘要绑定，不以一个作用域的结果覆盖另一个。
2. **先做候选预检。** 在候选版本运行真实工具，保存安全结果与三项摘要、执行时间和候选构建标识。任一 exit 2/3、缺真实依赖或未知证明条件均停止。此结果只为提前发现问题，随后仍须在冻结后 fresh 重验。
3. **冻结所有实例、所有写入口。** 冻结整条 `PUT /config/model-routing` 链路，包括直连节点、负载均衡、旧版本、备用/定时实例及其他持有写权限的流程。同时冻结存储切换、迁移和恢复等会改变权威后端或路由值的入口，包括 `/storage-engine/switch`。冻结必须在应用接受新写入之前生效，不能只冻结设置页按钮或一个代理入口。通用配置接口禁止路由键不意味着旧版本/绕行入口已经冻结。
4. **排空已受理写入并确认提交。** 对冻结前已经通过入口的 PUT 等待其完成；核对每个请求最终数据库提交/回滚已结束，包含仍在事务中或响应丢失的请求。只看到 HTTP 响应、当前队列为空或瞬间 active=0，不能证明已受理写入全部提交。必须有外部流程提供的可核查排空证据；无法关联提交状态时停止。连接重试、延迟提交、旧 writer 仍可写入都属于未排空。
5. **保持冻结，权威 fresh 重读并重新预检。** 在所有已受理写入提交/回滚以后，用相同候选和后端作用域再次运行真实只读工具。比较 `backend_identity_digest`、`config_digest`、`policy_digest`；任何摘要变化都使之前绑定失效，必须重新保存通过证据并确认冻结仍覆盖全部 writer。配置值空白排版变化且语义不变可以得到相同 canonical 摘要；缺键与 null 不能混同。候选构建或策略改变也必须重检。
6. **核查可写前提，再维持冻结切版。** SQLite/PG/MySQL 的现有单键约束及提交方式必须能够支持路由原子保存。MongoDB 当前初始化不保证 `config.key` 唯一，运行时路由写入要求已经存在的、没有 partial filter、非 sparse、不带非简单 collation 的单字段 `key` 唯一索引；缺约束时写入安全失败，不能把只读预检 exit 0 当作可写验收。索引缺失应标记升级写入门禁未验证/失败，本任务不做 DDL 或 schema 迁移。只有部署流程能够持续维持全入口冻结且上述条件满足时，才能启用候选策略。
7. **确认全部可写实例一致。** 在继续冻结期间，验证全部可写实例使用新的构建/`policy_digest` 与正确 fresh 配置作用域。旧实例、备用实例和旧写入口必须摘除或明确禁止写入；仅滚动更新一部分实例或删除负载均衡记录不足以证明旧直连入口已经失效。记录逐实例证据。发现旧 writer、配置变动或冻结失效时停止，保持冻结并恢复已验证版本，重新排空、重读和预检。
8. **最后解冻。** 只有全部可写实例确认新 policy、旧写入口摘除、摘要绑定仍有效、存储可写前提已满足之后才能解冻。解冻后通过认证的专用 GET 确认状态；本任务不自动执行生产 PUT、模型调用、凭证操作或部署。

任一步冻结丢失、无法排空、摘要不符、运行时后端不明、旧入口残留，都禁止在线切版。若现有平台不能提供上述门禁，应使用经所有者另行批准的完整停写/停机部署流程；不要宣称滚动切版安全。

## 验证状态与回滚

MR06 测试中的 SQLite 数据库为临时自建测试库。WAL 在途写入测试证明：预检只看到已提交快照，后续已受理 PUT 提交会改变 `config_digest`，故必须在排空后 fresh 重验。模拟策略升级、单渠道失效和全局故障使用明确 compiler mock；远程会话/权限/缺表/重复键测试使用明确 driver mock。它们不能替代真实候选 compiler 集成、隔离远程数据库服务验证或生产外部门禁。

最终 MR06 状态须另行记录真实 MR02/MR04 依赖和各后端实测结果。缺基础设施、Mongo 现有唯一约束无法证明、真实 compiler 未集成或在线冻结证据缺失均记录 unverified/blocked，不以 mock 或 skip 宣称通过。

兼容配置失败时保留旧实现；配置修复须经现有已认证专用接口和任务明确授权。清空路由可撤销映射但身份保护仍存在；完整回滚需恢复前一实现版本。回滚同样应冻结全部写入口、排空写入并核对策略与配置绑定，不迁移或恢复凭证、SQLite schema 或 Zeabur Volume。本功能只声明本地专用能力，Management schema/capability 不变，manager 无配套动作；已取消 MGMT 工作不恢复。
