# 凭证加载与运行时性能风险审计报告（rev.2）

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 初版日期 | 2026-09-14 |
| 本次修订 | 2026-09-15（rev.2，依据独立 Review 结论修订） |
| 审计分支 | `dev9` |
| 审计基线 | commit `dcc966e` |
| 审计触发 | 凭证加载偏慢的现场反馈 |
| 审计范围 | 凭证选取 / 凭证上传 / 控制面板列表 / 存储层连接管理 / 出站 HTTP / 后台任务 |
| 非目标范围 | 转换器（`src/converter/*`）、`/management/v1` 契约语义、前端渲染性能 |
| 本次动作 | **仅修订本审计文档，未修改任何源码、测试、配置或数据库；未实施任何修复**（遵循 `AGENTS.md`「范围外发现只记录，不得顺带实施」） |

### 1.1 rev.2 修订说明

初版（rev.1）经独立 Review 判定**不通过**：问题方向大多成立，但基准脚本复刻不忠实、存在若干事实错误，原有数字不能支撑产品收益与故障比例。

本次修订：

1. 引入**证据分级**（第 2 节），逐条标注结论的支撑强度。
2. **撤回**全部由不忠实基准得出的产品定量结论，并且**不用新的合成数字替换旧的生产预测**。
3. 重写附录基准脚本为忠实复刻，重新测量，结果一律标注为「隔离实验」。
4. 修正 6 类事实错误（详见第 10 节修订记录）。
5. 按 Review 意见重排修复优先级并重估风险（第 8 节）。
6. 新增第 9 节「遗漏项（只记录）」。

> **P0-1 的结论未被推翻**：正确性缺陷确认存在，建议**脱离本性能报告单独立项**。本文不创建实现任务。

---

## 2. 证据分级

本文每条结论标注下列三级之一。**不同级别不可混用**，尤其不得把隔离实验数值当作生产表现。

| 级别 | 含义 | 可支撑的主张 |
| --- | --- | --- |
| **【代码确认】** | 直接读取 `dcc966e` 源码或运行 `EXPLAIN` / `PRAGMA` 得到 | 代码事实、执行计划、默认值 |
| **【隔离实验】** | 在临时目录用合成数据复刻产品函数体运行所得 | **风险存在性**与量级方向 |
| **【未验证推断】** | 依据代码结构推理，未实测 | 仅作待验证假设，不作决策唯一依据 |

**隔离实验的共同边界**（适用于本文所有实验）：

- 均在临时目录建库、使用合成数据，**不接触 `creds/credentials.db`**。
- 复刻的是**单个函数体或链路片段**，隔离了初始化、日志、外部依赖、HTTP 层与真实并发形态，**不是端到端 HTTP 测试**。
- 单机单次或少数几次运行，**不是生产预测**，不得据此推算故障比例或收益倍数。

---

## 3. 结论摘要

### 3.1 已确认的代码事实

凭证相关路径上存在三类独立开销，**均为【代码确认】**：

1. **连接层**：`sqlite_manager.py` 中 29 处 `aiosqlite.connect(self._db_path)`，无驻留连接；每条 `aiosqlite` 连接自带一个工作线程。
2. **查询层**：选凭证的两条候选 SQL **没有 `LIMIT`**，且 `SELECT` 了完整 `credential_data`；面板列表的 `offset` / `limit` 未进入主 SQL，在 Python 侧分页。
3. **网络层**：每次出站调用新建 `httpx.AsyncClient` 并在用完后关闭，**跨调用之间不复用**。

### 3.2 已撤回的结论

> **撤回**：rev.1 称「凭证加载慢由三层开销叠加造成」。
>
> **理由**：缺少端到端生产剖析。不同入口不一定经过全部三层（例如无 `model_name` 的调用不解析冷却 JSON；token 未临期则不触发刷新）。三类开销的**存在**是代码事实，但它们**是否构成现场慢的主因、各自占比多少，本次未予证明**。
>
> **需要补的证据**：生产环境端到端剖析（按入口分别采样 `get_valid_credential`、token 刷新、`record_*` 的实际耗时占比）。

### 3.3 唯一的正确性缺陷

P0-1 同时是性能问题与**数据正确性缺陷**：批量上传在并发写入失败时，接口仍上报成功。**建议按缺陷流程单独立项，不并入性能优化工作项。**

问题分级：**P0 三项、P1 两项、P2 六项**。

---

## 4. 环境与方法

### 4.1 实测环境事实【代码确认】

| 项目 | 值 | 获取方式 |
| --- | --- | --- |
| 平台 | Windows 11 Pro 26200，本地 SSD | — |
| `aiosqlite` | **0.22.1** | `aiosqlite.__version__` |
| SQLite 库 | **3.53.1** | `sqlite3.sqlite_version` |
| 默认 `busy_timeout` | **5000 ms** | 新建连接 `PRAGMA busy_timeout` |
| 默认 `synchronous` | **2（FULL）** | 新建连接 `PRAGMA synchronous` |
| 默认 `cache_size` | **-2000** | 新建连接 `PRAGMA cache_size` |
| 初始化显式设置 | `journal_mode=WAL`、`foreign_keys=ON` | `sqlite_manager.py:160-161` |
| 本机样本库 | `creds/credentials.db`，`credentials` 表 7 行 | 只读查询 |

> **重要修正**：`busy_timeout` 的默认值是 **5000 ms 而非 0**。SQLite C 库默认为 0，但 Python `sqlite3.connect()` 的 `timeout` 参数默认 5.0 秒，`aiosqlite` 透传该默认值。rev.1 称「默认 0，遇锁立即报错」**错误**，据此推出的「busy_timeout 是锁错误的直接放大器」一并撤回。

### 4.2 本文实验的局限

- 所有规模数据（10 / 100 / 500 / 2000 / 5000）均为合成造数；本机真实样本库只有 7 行。
- 测量在 **Windows 本地 SSD** 完成。
- **PostgreSQL / MySQL / MongoDB 三个后端未做任何实测**，相关内容一律标注【未验证推断】，**不给出后端间的性能排名**。
- **TLS 握手成本未实测**。

### 4.3 部署环境外推的边界

> **撤回**：rev.1 称「生产若部署在 Zeabur Volume、Docker bind mount 或网络文件系统上，连接建立与 fsync 成本会显著高于此处数值」。
>
> **理由**：容器卷不必然比本地 SSD 慢，三类存储的性质差异很大：
>
> | 存储形态 | 性质 |
> | --- | --- |
> | bind mount / overlay | 通常仍是宿主本地文件系统，开销接近本地 |
> | 块存储卷 | 取决于卷的 IOPS 与延迟档位，可能优于也可能劣于本地盘 |
> | 网络文件系统（NFS/CIFS） | 除耗时外，还涉及 **SQLite WAL 的支持情况与文件锁语义**，属正确性风险而不只是性能风险 |
>
> 正确的做法是在目标部署形态上实测，不能由本地数值外推。

---

## 5. P0 问题

### P0-1：批量上传并发写入丢失凭证且接口上报成功

**这是本次审计中唯一的数据正确性缺陷。建议单独立项。**

#### 代码事实【代码确认】

| 事实 | 位置 |
| --- | --- |
| `batch_size = 1000`，随后 `asyncio.gather` 一次性放行整批任务 | `src/panel/creds.py:338` |
| `tier_detection_semaphore = asyncio.Semaphore(5)` **仅包围 tier 探测及其附带的存储写入**，不保护此前的初始写入 | `src/panel/creds.py:339`、`:365-368` |
| `add_credential` / `add_antigravity_credential` 的调用位于 `async with tier_detection_semaphore` **之前**，完全无限流 | `src/panel/creds.py:355-358` |
| ZIP 解包**没有条目数上限** | `src/panel/creds.py:70` |
| `store_credential` 捕获异常后 `return False`，**不抛出**，并写一条 `log.error` | `src/storage/sqlite_manager.py:682`、`:726-728` |
| `add_credential` / `add_antigravity_credential` **忽略返回值**，无条件 `log.info("Credential added/updated")` | `src/credential_manager.py:131-132`、`:140-141` |
| 写入采用「先 `SELECT` 是否存在 → 存在则 `UPDATE` 保留状态；不存在则 `SELECT MAX(rotation_order)+1` 后普通 `INSERT`」 | `src/storage/sqlite_manager.py:691-721` |

#### 关于 `process_single_file` 的修正

> **修正**：rev.1 称 `process_single_file` **无条件**返回 `status: "success"`。**该表述错误**——它有 `except json.JSONDecodeError` 与 `except Exception` 两个分支，会返回 `status: "error"`。
>
> **准确表述**：缺陷成因是**异常在下游被吞掉**。`store_credential` 以 `return False` 而非抛出的方式报告失败，因此 `process_single_file` 的两个 `except` 分支在这条失败路径上**不会触发**，成功分支照常返回。

#### 关于可观测性的修正

> **修正**：rev.1 称「日志中每一条都显示成功，用户无从察觉」。**该表述错误**——存储层会为每次失败写一条 `log.error(f"Error storing credential {filename}: {e}")`。
>
> **准确表述**：**HTTP 响应体**会把失败计入成功计数，与实际落库数不符；运维可以从 `log.error` 察觉，但**调用方无法从接口返回值察觉**。风险在于响应与事实不一致，而非完全不可见。

#### 隔离实验【隔离实验】

复刻内容：产品 `_create_tables` 的 `credentials` 表定义与两条索引（`idx_disabled`、`idx_rotation_order`）；`store_credential` 的完整语句序列（含存在性查询与 UPDATE 分支）与异常语义；`add_credential` 忽略返回值；`process_single_file` 的成功/异常分支；整批 `gather` 无信号量。提交 300 个**互不相同**的合成文件。脚本见附录 A.3。

| 运行 | 接口上报成功 | 实际落库行数 | 存储层 error 日志 | 重复 `rotation_order` | 峰值线程 |
| --- | --- | --- | --- | --- | --- |
| 1 | 300 / 300 | 236 | 64 | 226 | 301 |
| 2 | 300 / 300 | 231 | 69 | 222 | 301 |
| 3 | 300 / 300 | 185 | 115 | 176 | 301 |
| 4 | 300 / 300 | 239 | 61 | 232 | 301 |

错误均为 `OperationalError: database is locked`（在 `busy_timeout=5000 ms` 生效的前提下仍然发生）。

**该实验支持的结论**：
- 接口上报成功数与实际落库数**每次都不一致**，且差值不小 —— 这是稳定复现的定性结论。
- `MAX(rotation_order)+1` 存在竞态，产生大量重复序号。
- 无限流的整批 `gather` 会产生与任务数同量级的 OS 线程。

**该实验不支持的结论**：
- 不得把 185–239 这个区间当作生产落库率。批次大小、凭证是否已存在（走 UPDATE 分支而非 INSERT）、磁盘特性、并发形态都会改变结果。

> **撤回**：rev.1 称「上传 300 个，接口返回成功 300/300，实际仅落库约 184 个」。该数字来自不忠实的基准脚本（见第 10 节 A.3 修订说明），**不得继续作为产品实测事实引用**。

#### 处置建议（只记录，不实施）

(a) `add_credential` / `add_antigravity_credential` 检查 `store_credential` 返回值并向上传递失败；(b) 上传路径的 DB 写入加信号量限流；(c) ZIP 条目数与解压总字节设上限；(d) `rotation_order` 的并发不变量需先明确再定方案（见第 8 节对原 7 项的风险重估）。

---

### P0-2：选凭证读取全部候选行并携带完整凭证明文

#### 代码事实【代码确认】

`src/storage/sqlite_manager.py:557`（geminicli 分支）与 `:607`（antigravity 分支）：

```sql
SELECT filename, credential_data, model_cooldowns, preview, tier
FROM credentials
WHERE disabled = 0
{health_clause} {tier_clause}
ORDER BY RANDOM()          -- 无 LIMIT
```

随后 `fetchall()` 取回**所有满足 SQL 条件的候选行**。

> **修正**：rev.1 称此处为「全表扫描」。**表述不准确**。按产品 schema 与索引在临时库上取执行计划：
>
> ```
> SEARCH credentials USING INDEX idx_disabled (disabled=?)
> USE TEMP B-TREE FOR ORDER BY
> ```
>
> 即：**走 `idx_disabled` 索引检索 `disabled=0` 分区，而非物理全表扫描**；但 `ORDER BY RANDOM()` 会强制建立临时 B 树排序，这部分开销真实存在。准确表述应为「读取所有满足 SQL 条件的候选行，并为随机排序建立临时 B 树」。

> **修正**：rev.1 称「逐行 `json.loads`，搬运 N 份完整凭证 JSON 并解析 N 次」。**需按分支区分**：
>
> | 分支 | 冷却 JSON 解析 | `credential_data` 解析 |
> | --- | --- | --- |
> | geminicli，指定 `model_name` | 遍历候选逐行解析 | **通常只解析选中的一份** |
> | geminicli，无 `model_name` | **不解析冷却** | 只解析选中的一份 |
> | antigravity，指定 `model_name` | 逐行解析，但**命中即提前返回**，不必遍历全部 | 只解析选中的一份 |
>
> 即：完整 `credential_data` 会被**传输** N 份，但通常只**解析** 1 份。

#### 隔离实验：变量分解【隔离实验】

rev.1 的 A.1 把「连接生命周期」与「查询形态」两个变量捆在一起改，无法归因。本次改为三配置对照，且忠实复刻了 preview 分组与优先级、`excluded` 集合语义。脚本见附录 A.1。

| 凭证数 | A 产品原样 | B 仅复用连接 | C 复用 + SQL 下推 | A→B 降幅 | B→C 降幅 |
| --- | --- | --- | --- | --- | --- |
| 10 | 1.72 ms | 0.19 ms | 0.16 ms | **89%** | 17% |
| 100 | 2.04 ms | 0.42 ms | 0.20 ms | **79%** | 52% |
| 500 | 3.56 ms | 1.47 ms | 0.35 ms | 59% | 76% |
| 2000 | 9.34 ms | 6.32 ms | 0.89 ms | 32% | **86%** |

**该实验支持的结论**：两个变量的贡献随规模反转。**小规模（≤100 凭证）下绝大部分开销来自连接生命周期，不是查询形态**；规模增大后查询形态才成为主项，交叉点约在数百凭证量级。这直接影响第 8 节的修复顺序。

**该实验不支持的结论**：
- 配置 C 的 SQL 下推**未保留 preview 分组优先级语义**（产品在非 preview 模型时优先取 `preview=0`，无则回退 `preview=1`），也未覆盖 tier 过滤与 `excluded` 集合。C 列只能视为「下推的性能上界」，**不是可直接落地的实现**。
- 绝对数值不可外推到生产。

#### 后端对比【未验证推断】

> **修正**：rev.1 称「PostgreSQL 是唯一既无 Redis 快路径、又用最差 SQL 模式的后端」。**错误**——`sqlite_manager.py` 与 `psql_manager.py` 中 `_redis_enabled` 出现次数均为 **0**，**SQLite 同样没有选凭证的 Redis 快路径**。

| 后端 | 选凭证 Redis 快路径 | SQL 回退形态 |
| --- | --- | --- |
| SQLite | 无（0 处 `_redis_enabled`） | 取全部候选 + `ORDER BY RANDOM()` |
| PostgreSQL | 无（0 处） | 取全部候选 + `ORDER BY RANDOM()` |
| MySQL | 有（10 处） | 取全部候选 + `ORDER BY RAND()` |
| MongoDB | 有（19 处） | 已下推筛选 + `count` + 随机 `skip` + `limit(1)` |

> **修正**：rev.1 称四后端「同构」、MongoDB 写法「最优」。**均不准确**。MongoDB 已下推筛选并使用 `count + skip + limit(1)`，与三个 SQL 后端**不同构**；但「最优」是未经实测的价值判断，本文不再给出后端间排名。
>
> **修正**：rev.1 称 MySQL 的 `ORDER BY RAND()` 会「强制物化临时表」。**不能仅凭 SQL 文本断言**——是否物化取决于 MySQL 版本、优化器与具体执行计划，需实际 `EXPLAIN` 才能确认。本文降级为【未验证推断】。

#### 关于参照实现的修正

> **修正**：rev.1 称 `sqlite_manager.py:873` `management_list_credentials_bounded` 是「同文件内的正确写法，可直接借鉴」。**表述过强**。
>
> 它确实可作为**有界查询**的参考（keyset 分页 + `json_each` / `json_extract` SQL 侧过滤），但：
> - 它**仍执行一次 `COUNT(*)`**；
> - 它使用 **`filename` keyset 排序**，与 Legacy 的 `rotation_order` 排序、以及运行时选凭证的随机 + preview 优先级语义**都不同**；
> - 因此**不能直接替代**这两条路径，只能作为「把过滤下推到 SQL」这一手法的参考。

---

### P0-3：存储层每次操作新建连接（含新建线程）

#### 代码事实【代码确认】

- `src/storage/sqlite_manager.py` 中 **29 处** `aiosqlite.connect(self._db_path)`，无驻留连接、无池化。
- `aiosqlite.Connection` 内部持有一个工作线程（`.venv/Lib/site-packages/aiosqlite/core.py:90` `Thread(target=_connection_worker_thread, ...)`）。
- 初始化除 `journal_mode=WAL` 外还设置 `foreign_keys=ON`（`:160-161`）。
- `busy_timeout` / `synchronous` / `cache_size` **未被代码显式设置**，取环境默认值（见 4.1：5000 / 2 / -2000）。

#### 关于「每请求 2–4 次连接」的修正

> **修正**：rev.1 给出的「每请求 2–4 次连接」**不是完整范围**，且把全部连接成本计入响应延迟**不成立**。
>
> | 环节 | 是否计入响应延迟 | 说明 |
> | --- | --- | --- |
> | `get_next_available_credential` | 是 | 每次调用 1 次连接 |
> | token 临期时 `_refresh_token` → `store_credential` | 是 | 条件触发 |
> | `record_success` | **否（部分）** | `credential_manager.py:318` 是 `asyncio.create_task(...)`，**fire-and-forget**，不阻塞响应；但仍消耗连接、线程与事件循环时间 |
> | `record_failure` | 是 | 失败路径为 `await` |
> | `set_model_cooldown` | 是 | 失败且有 `model_name` 时触发 |
> | `get_credential_state` + `update_credential_state` | 是 | 禁用凭证时 |
>
> 且 `get_valid_credential` 最多重试 3 次，每次重选都会再走一遍选凭证（可能再加一次刷新与存储），**叠加上游重试后总次数可超过 4**。准确表述：**次数随路径浮动，下界约 2，无固定上界**。

#### 关于 1.62 ms 的修正

> **修正**：rev.1 把 1.62 ms 当作「连接开销常数」并用它乘以次数推算每请求 3–6 ms。**该推算撤回**。
>
> 1.62 ms 是**本环境下 `connect + SELECT 1 + close` 的微基准结果**，包含建立连接、启动工作线程、打开数据库文件、执行一条平凡查询、关闭与线程回收的总和，**既不是纯线程开销，也不是普遍常数**。不同平台、文件系统与 SQLite 版本下差异很大。

---

## 6. P1 问题

### P1-1：出站 HTTP 客户端不跨调用复用

#### 代码事实【代码确认】

- `src/httpx_client.py:37` 每次 `async with httpx.AsyncClient(**client_kwargs) as client`，用完即关，**跨调用之间不复用**。
- `web.py:122` 调用 `await http_client.close()`，但 `HttpxClientManager` **不存在 `close` 方法**；该调用抛 `AttributeError`，被外层 `except` 记录后继续。

#### 三处修正

> **修正 1**：rev.1 称「无连接池」。**不准确**——**每个 `AsyncClient` 实例内部仍有自己的连接池**，问题在于实例本身不跨调用复用，池随实例一起销毁。准确表述是「客户端不复用，池无法跨调用生效」。

> **修正 2**：rev.1 断言「无 DNS 缓存复用」「TLS 握手是凭证刷新延迟中最大的单项」。**均未证明**：
> - 不能排除操作系统解析器缓存或上游代理的 DNS 缓存仍在生效；
> - TLS 成本未实测，**不能断言它是最大单项**。
> 本条降级为【未验证推断】，需实测出站调用的耗时分解才能定性。

> **修正 3**：rev.1 称「无 HTTP/2 多路复用」并暗示引入驻留客户端即可获得。**错误**——`httpx.AsyncClient` 的 `http2` 参数**默认为 `False`**（已实测确认；本环境 `h2` 4.3.0 虽已安装，但不会自动启用）。**驻留客户端不会自动开启 HTTP/2**，那是一项需要显式开启并单独评估的独立变更。

#### 关于历史成因的修正

> **撤回**：rev.1 在第 8 节暗示连接池「曾经存在或本应存在，现已缺失」，并把修复描述为「恢复」。**该判断在本分支上没有证据支持**。
>
> 【代码确认】的历史事实：
> - `f99df8d` 标题为「fix: 内存泄漏优化 - httpx持久化连接池 + fire-and-forget任务回调」，是 `dev9` 的祖先，**它添加了 `web.py` 的关机调用**；
> - 但该提交的变更文件清单中**不含 `src/httpx_client.py`**，其时该文件仍是逐次创建客户端；
> - 遍历 `dev9` 祖先链上 `src/httpx_client.py` 的全部历史版本，**从未出现过 `def close`**。
>
> 结论：`web.py` 那句调用是一个**从未兑现的承诺**，而非被移除的实现。相应修复应按**新增设计或整合设计**描述与评审，不得称为「恢复被移除的池」。

---

### P1-2：控制面板 `/creds/status` 取全部候选后在 Python 内分页

#### 代码事实【代码确认】

- `src/storage/sqlite_manager.py:1478` `get_credentials_summary` 接收 `offset` / `limit`，但**二者未进入主 SQL**；分页发生在 `paginate_and_classify_summaries`（`src/error_classification.py:160`）的 Python 切片。
- 主查询执行计划为 `SCAN credentials USING INDEX idx_rotation_order`（走索引扫描全部行）。
- 前端默认 `pageSize: 25`（`front/common.js:183`）。

> **修正**：rev.1 称「对每行执行 4 次 `json.loads`」。**不固定**——正常行（未禁用且未永久禁用）在构造 summary 之前还会经 `has_active_model_cooldown` 对 `model_cooldowns` **额外解析一次**；被筛选条件提前 `continue` 的行则不足 4 次。准确表述是「每行 3–5 次，随行状态与筛选条件浮动」。

#### 隔离实验：事件循环归因【隔离实验】

> **撤回**：rev.1 称「每次面板刷新阻塞事件循环约 50 ms」。该 51 ms 是**包含异步连接、SQL、fetch 与关闭在内的总耗时**，其中 SQL 执行发生在 `aiosqlite` 的工作线程上，`await` 期间事件循环并未被阻塞，**不能由总耗时推出阻塞时长**。

本次重测将两段分离（脚本见附录 A.2）：

| 凭证数 | SQL + fetch（工作线程，`await` 让出） | Python 汇总循环（事件循环线程） | 合计 |
| --- | --- | --- | --- |
| 50 | 1.16 ms | 0.41 ms | 1.58 ms |
| 200 | 1.59 ms | 1.59 ms | 3.18 ms |
| 1000 | 3.61 ms | 8.45 ms | 12.06 ms |
| 5000 | 14.33 ms | **43.36 ms** | 57.69 ms |

**该实验支持的结论**：真正占用事件循环线程的是 **Python 汇总循环**，它随行数线性增长；在 5000 行合成数据下该段约 43 ms。这印证了「阻塞在 Python 段而非 SQL 段」的方向。

**该实验不支持的结论**：
- 43.36 ms **不是生产阻塞时长**。本复刻仍省略了筛选分支、403 分类与其附加查询，实际值可能更高或因提前 `continue` 而更低。
- 工作线程段也并非完全无代价：GIL 竞争与行对象转换仍会与事件循环争用 CPU，本实验未量化该部分。

#### 后端一致性【未验证推断】

> **修正**：rev.1 称四后端「写法一致」。**过强**。四者的共性是**都在取回全部候选、在应用层处理后才分页**；但字段集合、JSON 解析位置与执行方式各不相同，不能称一致。PG 与 MySQL 是否额外叠加显著的网络传输开销，**未实测**。

---

## 7. P2 问题

### P2-1：Token 刷新无单飞（single-flight）保护

【代码确认】`src/credential_manager.py:58` `get_valid_credential` 中每个请求独立执行 `_should_refresh_token` 并调用 `_refresh_token`；`src/google_oauth_api.py:78` `Credentials.refresh()` 无去重锁。

> **修正**：rev.1 称「N 个并发请求会发起 N 次刷新」。**表述过强**——这是**条件性风险**，需要同时满足：多个并发请求恰好选中**同一个**凭证（选取是随机的）、且该凭证处于 5 分钟临期窗口内。不是任意 N 个请求必然触发。

**处置建议（只记录）**：加在途刷新锁。注意键必须是 **`(mode, filename)`** 而非仅 `filename` —— `geminicli` 与 `antigravity` 是两张独立表，同名凭证在两个 mode 下是不同记录。

### P2-2：SMART 429 探测循环周期性取全部凭证状态

【代码确认】`src/smart_429.py:416` 在 `_probe_loop`（`:411`）中调用 `get_all_credential_states(mode="geminicli")`——取回全部行并对每行解析 `model_cooldowns` / `error_codes` / `cycle_stats` / `last_cycle_stats`，仅为筛出 `health_status` 为 `checking` / `risk_quarantined` 的少数行。

> **修正**：rev.1 称「每 60 秒」。**不准确**——(a) 该循环仅在 **SMART 429 开启且 worker 已启动**时运行，默认关闭；(b) 周期是**本轮处理完成后再 `await asyncio.sleep(60)`**，即「至少 60 秒」而非固定 60 秒。

**处置建议（只记录）**：改为 SQL 条件查询 `WHERE health_status IN (...) AND next_probe_at <= ?`。

### P2-3：批量操作串行执行

【代码确认】`src/panel/creds.py:1195` `creds_batch_action` 对 `filenames` 逐个 `await`，无并发。

> **修正**：rev.1 称「每个凭证消耗 3 次连接」。**仅适用于 GeminiCLI `enable` 的正常路径**（`get_credential` + `get_credential_state` + `update_credential_state`）。其他 mode 与动作（`delete`、`permanent_disable`、`enable_credit` / `disable_credit`）的次数不同；`enable_credit` 分支还会追加 `clear_all_model_cooldowns_for_credential`。

### P2-4：`refresh_all_user_emails` 无批次总时间预算

【代码确认】`src/panel/creds.py:612` 起串行 `await credential_manager.get_or_fetch_user_email()`，**无批次总时间预算**。

> **修正**：rev.1 称「无超时」。**错误**——单次调用是有超时的：`src/httpx_client.py:65` `get_async` 默认 `timeout=30.0`，`:77` `post_async`（OAuth token 刷新走此路径）默认 `timeout=900.0`。缺的是**批次级预算**。
>
> **修正**：rev.1 称「失败时已完成的部分无法反馈」。**错误**——该函数逐项捕获异常并汇总进 `results` 返回。真实风险是**批次总时长可能超过上游网关超时**，导致整个响应丢失。

**注意**：`post_async` 默认 900 秒超时本身值得单独评估——单个卡住的 OAuth 刷新即可长时间占住一个串行位。

### P2-5：启动路径常驻一次性迁移逻辑

【代码确认】`src/storage/sqlite_manager.py:382` `_repair_credential_filenames` 在 `initialize()` 中把两张表的 `filename` 列整列读出，在 Python 侧逐行比对 `os.path.basename`。其执行计划为 `SCAN credentials USING COVERING INDEX sqlite_autoindex_credentials_1`——走 `filename` 唯一索引的覆盖扫描，不回表，**代价低于 rev.1 暗示的「全表扫描」**，但仍是 O(N) 且位于启动关键路径上。

> **修正**：rev.1 称「每次 `initialize()` 时」。**需补充**——`initialize()` 开头有双重检查短路（`if self._initialized: return`，锁内再查一次，`:142-147`），因此**同一进程内的重复调用不会重复扫描**。准确表述是「每次**进程冷启动**扫描一次」。

### P2-6：日志同步 stdout 写入与 f-string 预求值

【代码确认】
- `log.py` 的文件写入走 deque + 独立 writer 线程（`_write_to_file`，写法正确），但 `log.py:249` 的 `print(entry)` 是**事件循环线程上的同步 stdout 写入**。
- `src/storage/sqlite_manager.py:1183` `update_credential_state` 内含 **8 条**（非 rev.1 所称约 10 条）`log.debug`，其 f-string 在调用前即被求值，与日志级别无关。

> **修正**：rev.1 建议「改为惰性求值（传 format 参数而非拼接好的字符串）」。**该建议不可直接套用**——本仓库的 `log.py` 使用自定义 `Logger` 类（`log.py:265`），其 `debug/info/warning/error` 只接受单个 `message: str`，**不支持标准 `logging` 的 `%s` + args 形式**。可行方向是：在调用点先判级别再拼串、或为自定义 Logger 增加惰性接口——但这属于实现方案，需单独评估。

---

## 8. 修复优先级（rev.2 重排）

### 8.1 适用假设

下列排序基于**明确的前提**，前提变化则排序需重算：

- 后端为 **SQLite**；
- 凭证规模**小于 50**；
- **没有生产剖析数据**。

依据 P0-2 的变量分解实验：小规模下连接生命周期贡献最大（10 凭证时占 89%），查询形态要到数百凭证量级才成为主项。

### 8.2 排序

| 新序 | 原序 | 动作 | 风险 |
| --- | --- | --- | --- |
| 1 | 原 2 | 上传路径：DB 写入信号量 + ZIP 条目/字节上限 + **检查 `store_credential` 返回值并如实上报** | 低 |
| 2 | 原 1 | SQLite 连接生命周期改造（见 8.3 拆分） | 中 |
| 3 | 原 5 | 出站 HTTP 客户端驻留化（**按新增设计评审，非恢复**） | 中 |
| 4 | 原 6 | Token 刷新加 `(mode, filename)` 单飞锁 | 低 |
| 5 | 原 3 | 选凭证查询下推 | **中高** |
| 6 | 原 4 | `get_credentials_summary` 分页下推 | **高** |
| 7 | 原 7 | `rotation_order` 并发不变量 | **高** |

> 第 1 项排首位不是因为性能收益最大，而是因为它是**正确性缺陷**且风险最低。

### 8.3 对原第 1 项的拆分要求

> **rev.1 把「连接长驻/连接池」与「`synchronous=NORMAL`」捆绑为一项，本次拆开，且不默认采纳 NORMAL。**

| 子项 | 注意事项 |
| --- | --- |
| 连接生命周期 | **共享单连接不会自动隔离多个协程的完整事务**——当前多处「先读后写」（`store_credential`、`record_success`、`update_credential_state`）依赖各自独立连接的隐式边界，改为共享连接后需显式事务管理，否则会引入新的交叉污染。**小连接池也不能保证消除锁错误**，只是降低概率 |
| `busy_timeout` | 当前默认已是 5000 ms（见 4.1 修正），**不是待修项**；若要显式设置，应说明与默认值的差异理由 |
| `synchronous=NORMAL` | **独立决策项**。它牵涉断电/内核崩溃后**已提交事务的持久性取舍**，属数据安全权衡而非纯性能调优，不应与连接改造捆绑通过 |

### 8.4 对第 5、6、7 项的风险重估

**第 5 项（选凭证下推）—— 中高风险。** 下推必须完整保留以下语义，缺一即为行为变更：

- `tier` 过滤（`required_tiers_for_geminicli_model`）
- **preview 分组与优先级**（非 preview 模型优先取 `preview=0`，无则回退 `preview=1`）
- `health_status` 健康过滤（仅 SMART 429 开启时）
- `excluded_credentials` 排除集合
- 模型级冷却判定
- MySQL / MongoDB 的 **Redis 快路径分支**不得被绕过

本文附录 A.1 的配置 C **未保留 preview 优先级**，只能作为性能上界参考，不是可落地实现。

**第 6 项（面板分页下推）—— 高风险。** 必须保留：

- 不受筛选影响的**全局统计**（`total` / `normal` / `disabled` / `permanent_disabled` / `in_cooldown` / `no_cooldown`）
- **筛选后的 `total`**（与全局统计是两个不同的数）
- 403 错误的**细分类**（`is_http_403_classification_filter` 及其前置分页语义）
- `rotation_order` 排序与既有分页契约（`offset` / `limit` / `has_more`）

**第 7 项（`rotation_order`）—— 高风险，且不能只加约束。**

- 库中**已存在重复值**会直接导致唯一约束创建失败；
- 仅加唯一约束会把**竞态从「重复值」变成「插入失败」**，若失败仍被吞掉，问题只是换了形态；
- 正确顺序是：**先明确业务不变量**（`rotation_order` 是否必须唯一？重复会破坏哪些行为？）→ 再定迁移与回滚方案。

### 8.5 关于 `AGENTS.md` 迁移要求的适用范围

> `AGENTS.md` 的迁移要求针对**真实凭证数据、SQLite 表结构或 Volume 的修改**。
>
> 因此：**保持语义不变的纯查询优化（第 5、6 项）不自动触发数据迁移要求**，但仍必须验证行为兼容性（`/creds/*`、控制面板、`/management/v1` 均不得失效）。**第 7 项涉及表约束变更，落在迁移要求之内。**

---

## 9. 遗漏项（只记录，不在本次处理）

以下为独立 Review 指出、本审计初版未覆盖的条目，按 `AGENTS.md`「范围外发现只记录」处理：

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| O-1 | 上传响应**同步等待**最多 5 并发的 tier 探测完成，该网络等待可能直接主导批次延迟，量级未评估 | 未验证 |
| O-2 | ZIP **同步解压**且无解压总字节上限，会同时放大事件循环阻塞与内存占用 | 未验证 |
| O-3 | `record_success` 每次都 UPDATE 并 commit；fire-and-forget 只是移出响应链路，**并未消除写竞争** | 代码确认 |
| O-4 | Token 刷新后的 `store_credential` **返回值同样被忽略**（`credential_manager.py:_refresh_token`），写入失败会导致下次请求重复刷新 | 代码确认 |
| O-5 | 批量 `enable` / `disable` **忽略 `set_cred_disabled` 的布尔返回值**后仍递增成功计数——与 P0-1 同型的**额外正确性缺陷** | 代码确认 |
| O-6 | `cycle_stats` 采用「先读整体、后整体写回」，存在并发覆盖风险 | 未实测 |

> **O-5 与 P0-1 同型**，建议一并纳入 P0-1 的独立缺陷立项范围。

---

## 10. 修订记录（rev.1 → rev.2）

| # | rev.1 表述 | 处置 | 依据 |
| --- | --- | --- | --- |
| 1 | 「凭证加载慢由三层开销叠加造成」 | **撤回**确定性口吻，改为「三类开销存在，主因未证明」 | 无端到端生产剖析 |
| 2 | 「上传 300 个实际仅落库约 184 个」 | **撤回**，替换为忠实复刻的隔离实验区间，并明确不作生产预测 | 原 A.3 不忠实 |
| 3 | `process_single_file`「无条件返回 success」 | **修正**：存在两个 except 分支；缺陷成因是异常在下游被吞 | `src/panel/creds.py` |
| 4 | 「日志全部成功，用户无从察觉」 | **修正**：存储层写 `log.error`；不可见的是**接口返回值** | `sqlite_manager.py:726` |
| 5 | 「全表扫描」 | **修正**为「读取全部满足条件的候选行」 | `EXPLAIN`：`SEARCH ... USING INDEX idx_disabled` |
| 6 | 「逐行解析 N 份完整凭证」 | **修正**：传输 N 份，通常只解析 1 份；冷却解析按分支区分 | 代码分支分析 |
| 7 | 「PostgreSQL 是唯一无 Redis 快路径的后端」 | **修正**：SQLite 同样没有 | `_redis_enabled` 计数 0 |
| 8 | 四后端「同构」、MongoDB「最优」 | **修正**：MongoDB 不同构；删除后端性能排名 | 代码结构 + 未实测 |
| 9 | MySQL `ORDER BY RAND()`「强制物化临时表」 | **降级**为未验证推断 | 不能凭 SQL 文本断言 |
| 10 | `management_list_credentials_bounded`「可直接借鉴」 | **修正**：仍执行 COUNT、用 filename keyset，不能替代两条路径的语义 | 代码阅读 |
| 11 | 「`busy_timeout` 默认 0，是锁错误的直接放大器」 | **撤回**：实测默认 5000 ms | `PRAGMA busy_timeout` |
| 12 | 「每请求 2–4 次连接，约 3–6 ms 纯开销」 | **撤回**推算：`record_success` 是 create_task；重试可超 4 次 | `credential_manager.py:318` |
| 13 | 「1.62 ms 连接开销」 | **降级**为本环境微基准，非常数、非纯线程开销 | 实验边界 |
| 14 | 「无连接池 / 无 DNS 复用 / TLS 是最大单项 / 无 HTTP/2」 | **修正**：每个 client 内部有池；DNS 与 TLS 未证明；`http2` 默认 False，驻留不自动开启 | `httpx.AsyncClient` 签名实测 |
| 15 | 连接池「曾被移除，应恢复」 | **撤回**：`f99df8d` 未改 `httpx_client.py`；dev9 祖先链从无 `def close` | git 历史遍历 |
| 16 | 「阻塞事件循环约 50 ms」 | **撤回**：51 ms 含工作线程段。重测分离为 14.33 / 43.36 ms | 附录 A.2 重写 |
| 17 | 「每行 4 次 `json.loads`」 | **修正**：3–5 次，随行状态浮动 | `has_active_model_cooldown` 额外解析 |
| 18 | P2-1「N 请求必然 N 次刷新」 | **修正**为条件性风险；单飞键需含 mode | 选取随机 + 双表 |
| 19 | P2-2「每 60 秒」 | **修正**：仅 SMART 开启时运行，且为「本轮完成后再 sleep 60」 | `smart_429.py:411` |
| 20 | P2-3「每凭证 3 次连接」 | **修正**：仅适用 GeminiCLI enable 正常路径 | 分支枚举 |
| 21 | P2-4「无超时」「失败无法反馈」 | **修正**：GET 30s / POST 900s；逐项汇总返回。缺的是批次预算 | `httpx_client.py:65,77` |
| 22 | P2-5「每次 initialize 扫描」「全表扫描」 | **修正**：有双重检查短路，实为每进程冷启动一次；且为覆盖索引扫描而非全表扫描 | `sqlite_manager.py:142-147`；`EXPLAIN`：`SCAN ... USING COVERING INDEX` |
| 23 | P2-6「约 10 条 debug」「改用 format 参数」 | **修正**：实为 8 条；自定义 Logger 不支持 format 参数写法 | 计数 + `log.py:265` |
| 24 | 修复顺序 1→7 | **重排**为 原2→原1→原5→原6→原3→原4→原7；拆分原 1；重估 5/6/7 风险 | 变量分解实验 + Review |
| 25 | 「容器卷显著慢于本地 SSD」 | **撤回**：区分 bind mount / 块存储 / 网络文件系统；NFS 另涉 WAL 与锁语义 | 存储形态差异 |
| 26 | — | **新增**第 9 节遗漏项 O-1 ~ O-6 | Review 补充 |

---

## 11. 仍然开放的问题

以下问题本次修订未能解决，需要本文范围之外的信息或动作：

1. **生产剖析缺失**（阻塞 3.2 节结论）：需按入口采样 `get_valid_credential`、token 刷新、`record_*` 的实际耗时占比，才能判断三类开销中哪一类是现场慢的主因，乃至是否还有本文未覆盖的主因。
2. **真实凭证规模**：决定 8.1 节排序前提是否成立。若规模远超 50，第 5、6 项应前移。
3. **部署存储形态**：bind mount / 块存储 / 网络文件系统，决定 4.3 节的外推方向；若为网络文件系统，还需先确认 SQLite WAL 与文件锁语义是否被支持。
4. **非 SQLite 后端**：若生产使用 MySQL 或 MongoDB，其 Redis 快路径的**实际启用率与命中率**决定 P0-2 的影响是否已被大幅覆盖。
5. **出站调用耗时分解**：需实测才能给 P1-1 定性（TLS、DNS、连接建立各占多少）。
6. **`rotation_order` 的业务不变量**：是否必须唯一、重复会破坏哪些行为——这是第 7 项修复能否开工的前置条件。

---

## 附录 A：基准脚本（rev.2 忠实复刻版）

三个脚本均在临时目录建库、使用合成数据，**不触碰 `creds/credentials.db`**。所有脚本均采用产品的建表定义与索引（`idx_disabled`、`idx_rotation_order`），并保留 `aiosqlite` 的默认 `busy_timeout`（本环境 5000 ms）。

> **rev.1 附录的问题**（已修正）：
> - **A.1**：找到首个可用行即 `break`，**漏掉产品的 preview 分组与优先级**，也省略了 tier 过滤、`excluded` 集合与产品索引；且「当前实现」与「优化组」同时改变了连接生命周期与查询形态，**无法归因**。
> - **A.2**：省略全局冷却统计查询、完整 summary 构造、筛选分支、403 分类及其附加查询，缺少产品排序索引；且把总耗时当作事件循环阻塞时长。
> - **A.3**：**省略了存在性查询与 UPDATE 分支**，改用 `INSERT OR REPLACE`；简化了 schema 与索引；`timeout_ms=0` 分支**根本没有执行 PRAGMA**，因此两组实际都在 5000 ms 下运行，原「busy_timeout 对照」不成立。

### A.1 选凭证：连接生命周期 vs 查询形态 的变量分解

```python
"""变量分解：连接生命周期 vs 查询形态，各自贡献多少。产品 schema+索引，合成数据，临时库。"""
import asyncio, json, os, sqlite3, tempfile, time
import aiosqlite

TMP = tempfile.mkdtemp(); DB = os.path.join(TMP, "c.db")

def seed(n):
    for p in (DB, DB+"-wal", DB+"-shm"):
        os.path.exists(p) and os.remove(p)
    c = sqlite3.connect(DB); c.execute("PRAGMA journal_mode=WAL")
    c.execute("""CREATE TABLE credentials(
        id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT UNIQUE NOT NULL,
        credential_data TEXT NOT NULL, disabled INTEGER DEFAULT 0,
        model_cooldowns TEXT DEFAULT '{}', preview INTEGER DEFAULT 1,
        tier TEXT DEFAULT 'pro', health_status TEXT DEFAULT 'healthy',
        rotation_order INTEGER DEFAULT 0)""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_disabled ON credentials(disabled)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_rotation_order ON credentials(rotation_order)")
    blob = json.dumps({"access_token":"x"*300,"refresh_token":"y"*180,"project_id":"p"*20})
    cd = json.dumps({"gemini-2.5-pro": time.time()-10})
    c.executemany("INSERT INTO credentials(filename,credential_data,rotation_order,"
                  "model_cooldowns,preview) VALUES(?,?,?,?,?)",
                  [(f"c{i}.json", blob, i, cd, i % 2) for i in range(n)])
    c.commit(); c.close()

SQL = ("SELECT filename, credential_data, model_cooldowns, preview, tier FROM credentials "
       "WHERE disabled = 0 AND COALESCE(health_status,'healthy')='healthy' ORDER BY RANDOM()")

def select_body(rows, model, excluded, now):
    """忠实复刻产品 geminicli 分支：preview 分组 + 优先级 + excluded"""
    is_preview_model = "preview" in model.lower()
    non_preview, preview = [], []
    for fn, cj, mc, pv, tier in rows:
        if fn in excluded: continue
        cds = json.loads(mc or '{}')
        cd = cds.get(model)
        if cd is None or now >= cd:
            (preview if pv else non_preview).append((fn, cj))
    if is_preview_model:
        if preview: return preview[0][0], json.loads(preview[0][1])
    else:
        if non_preview: return non_preview[0][0], json.loads(non_preview[0][1])
        if preview:     return preview[0][0], json.loads(preview[0][1])
    return None

async def cfg_a(it, model):        # 产品原样：新建连接 + 原查询 + Python 分组
    t = time.perf_counter()
    for _ in range(it):
        async with aiosqlite.connect(DB) as db:
            async with db.execute(SQL) as cur:
                select_body(await cur.fetchall(), model, set(), time.time())
    return (time.perf_counter()-t)/it*1000

async def cfg_b(it, model):        # 只改连接：复用连接 + 原查询 + 同样 Python 分组
    db = await aiosqlite.connect(DB)
    t = time.perf_counter()
    for _ in range(it):
        async with db.execute(SQL) as cur:
            select_body(await cur.fetchall(), model, set(), time.time())
    d = (time.perf_counter()-t)/it*1000
    await db.close(); return d

async def cfg_c(it, model):        # 连接复用 + SQL 下推
                                   # 注意：未保留 preview 优先级/tier/excluded 语义，仅作性能上界
    db = await aiosqlite.connect(DB)
    t = time.perf_counter()
    for _ in range(it):
        async with db.execute(
            "SELECT filename, credential_data FROM credentials "
            "WHERE disabled = 0 AND COALESCE(health_status,'healthy')='healthy' "
            "AND (json_extract(model_cooldowns, '$.\"'||?||'\"') IS NULL "
            "     OR json_extract(model_cooldowns, '$.\"'||?||'\"') <= ?) "
            "ORDER BY RANDOM() LIMIT 1", (model, model, time.time())) as cur:
            row = await cur.fetchone()
            if row: json.loads(row[1])
    d = (time.perf_counter()-t)/it*1000
    await db.close(); return d

async def main():
    model = "gemini-2.5-pro"
    for n in (10, 100, 500, 2000):
        seed(n)
        a = await cfg_a(50, model); b = await cfg_b(50, model); c = await cfg_c(50, model)
        print(f"n={n:>5} A={a:>6.2f}ms B={b:>6.2f}ms C={c:>6.2f}ms  "
              f"A->B {(a-b)/a*100:>3.0f}%  B->C {(b-c)/b*100:>3.0f}%")

asyncio.run(main())
```

### A.2 面板列表：工作线程段 vs 事件循环段 的分离

```python
"""分离：aiosqlite 工作线程内的 SQL+fetch  vs  事件循环线程上的 Python 汇总循环"""
import asyncio, json, os, sqlite3, tempfile, time
import aiosqlite
TMP = tempfile.mkdtemp(); DB = os.path.join(TMP, "s.db")

def has_active_model_cooldown(raw, now):      # 产品 error_classification 同名函数的等价语义
    try: cds = json.loads(raw or "{}")
    except Exception: return False
    return any(v > now for v in cds.values() if isinstance(v, (int, float)))

def seed(n):
    for p in (DB, DB+"-wal", DB+"-shm"): os.path.exists(p) and os.remove(p)
    c = sqlite3.connect(DB); c.execute("PRAGMA journal_mode=WAL")
    c.execute("""CREATE TABLE credentials(filename TEXT PRIMARY KEY, disabled INTEGER DEFAULT 0,
      error_codes TEXT DEFAULT '[]', last_success REAL, user_email TEXT, rotation_order INTEGER,
      model_cooldowns TEXT DEFAULT '{}', preview INTEGER DEFAULT 1, tier TEXT DEFAULT 'pro',
      success_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0,
      permanent_disabled INTEGER DEFAULT 0, cycle_stats TEXT DEFAULT '{}',
      last_cycle_stats TEXT DEFAULT '{}', remark TEXT DEFAULT '')""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_rotation_order ON credentials(rotation_order)")
    cyc = json.dumps({"pro": {"success": 12, "failure": 3},
                      "flash": {"success": 40, "failure": 1}})
    cd  = json.dumps({"gemini-2.5-pro": time.time()+600, "gemini-2.5-flash": time.time()-5})
    c.executemany("INSERT INTO credentials(filename,rotation_order,model_cooldowns,cycle_stats,"
      "last_cycle_stats,error_codes,user_email) VALUES(?,?,?,?,?,?,?)",
      [(f"c{i}.json", i, cd, cyc, cyc, '[429]', f"u{i}@e.com") for i in range(n)])
    c.commit(); c.close()

COLS = ("filename, disabled, error_codes, last_success, user_email, rotation_order,"
        " model_cooldowns, preview, tier, success_count, failure_count, permanent_disabled,"
        " cycle_stats, last_cycle_stats, remark")

def summary_loop(rows, now):
    """产品 get_credentials_summary 的 Python 段：全局冷却计数 + 逐行构造 summary"""
    stats = {"in_cooldown": 0, "no_cooldown": 0}; out = []
    for r in rows:
        is_normal = not bool(r[1]) and not bool(r[11])
        if is_normal:                                  # 正常行的额外一次冷却解析
            stats["in_cooldown" if has_active_model_cooldown(r[6], now) else "no_cooldown"] += 1
        mc = json.loads(r[6] or '{}')
        out.append({"filename": r[0], "disabled": bool(r[1]),
                    "error_codes": json.loads(r[2] or '[]'),
                    "model_cooldowns": {k: v for k, v in mc.items() if v > now},
                    "cycle_stats": json.loads(r[12] or '{}'),
                    "last_cycle_stats": json.loads(r[13] or '{}'),
                    "remark": r[14] or ""})
    return out[0:25], stats

async def measure(n, it=30):
    seed(n); sql_t = 0.0; py_t = 0.0
    for _ in range(it):
        async with aiosqlite.connect(DB) as db:
            t0 = time.perf_counter()
            async with db.execute("SELECT disabled, permanent_disabled, COUNT(*) FROM credentials "
                                  "GROUP BY disabled, permanent_disabled") as c1:
                await c1.fetchall()
            async with db.execute(f"SELECT {COLS} FROM credentials ORDER BY rotation_order") as cur:
                rows = await cur.fetchall()
            t1 = time.perf_counter()
            summary_loop(rows, time.time())            # 这一段跑在事件循环线程上
            t2 = time.perf_counter()
        sql_t += t1-t0; py_t += t2-t1
    return sql_t/it*1000, py_t/it*1000

async def main():
    for n in (50, 200, 1000, 5000):
        s, p = await measure(n)
        print(f"n={n:>5} SQL+fetch(worker)={s:>6.2f}ms  Python(event loop)={p:>6.2f}ms")

asyncio.run(main())
```

> **归因边界**：`await` 期间事件循环未被阻塞，但工作线程段仍因 GIL 竞争与行对象转换与事件循环争用 CPU，本脚本未量化该部分。

### A.3 上传链路忠实复刻

```python
"""忠实复刻 upload -> add_credential -> store_credential 链路（合成数据，临时库）"""
import asyncio, json, os, sqlite3, tempfile, threading, time
import aiosqlite

TMP = tempfile.mkdtemp(); DB = os.path.join(TMP, "credentials.db")
errors_logged = []          # 代替 log.error

def build_schema():
    """产品 _create_tables 的相关列 + 产品两条索引"""
    c = sqlite3.connect(DB)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("""CREATE TABLE IF NOT EXISTS credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT UNIQUE NOT NULL,
        credential_data TEXT NOT NULL,
        disabled INTEGER DEFAULT 0, permanent_disabled INTEGER DEFAULT 0,
        cycle_stats TEXT DEFAULT '{}', last_cycle_stats TEXT DEFAULT '{}',
        error_codes TEXT DEFAULT '[]', error_messages TEXT DEFAULT '[]',
        last_success REAL, user_email TEXT, model_cooldowns TEXT DEFAULT '{}',
        preview INTEGER DEFAULT 1, tier TEXT DEFAULT 'unknown',
        health_status TEXT DEFAULT 'healthy', rotation_order INTEGER DEFAULT 0,
        call_count INTEGER DEFAULT 0, success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0, remark TEXT DEFAULT '',
        created_at REAL DEFAULT (unixepoch()), updated_at REAL DEFAULT (unixepoch()))""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_disabled ON credentials(disabled)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_rotation_order ON credentials(rotation_order)")
    c.commit(); c.close()

async def store_credential(filename, credential_data, mode="geminicli"):
    """产品 sqlite_manager.store_credential 的语句序列与异常语义"""
    filename = os.path.basename(filename)
    try:
        async with aiosqlite.connect(DB) as db:      # 默认 timeout=5.0 -> busy_timeout=5000
            async with db.execute(
                "SELECT disabled, error_codes, last_success, user_email, rotation_order, call_count "
                "FROM credentials WHERE filename = ?", (filename,)) as cur:
                existing = await cur.fetchone()
            if existing:                              # 存在则 UPDATE 保留状态
                await db.execute(
                    "UPDATE credentials SET credential_data = ?, updated_at = unixepoch() "
                    "WHERE filename = ?", (json.dumps(credential_data), filename))
            else:                                     # 不存在则 MAX+1 后普通 INSERT
                async with db.execute(
                    "SELECT COALESCE(MAX(rotation_order), -1) + 1 FROM credentials") as cur:
                    next_order = (await cur.fetchone())[0]
                await db.execute(
                    "INSERT INTO credentials (filename, credential_data, rotation_order, "
                    "last_success, tier) VALUES (?, ?, ?, ?, ?)",
                    (filename, json.dumps(credential_data), next_order, time.time(), "unknown"))
            await db.commit()
            return True
    except Exception as e:                            # 产品：吞异常、写 error 日志、返回 False
        errors_logged.append(f"Error storing credential {filename}: {e}")
        return False

async def add_credential(name, data):
    """产品 credential_manager.add_credential：忽略返回值"""
    await store_credential(name, data)
    # log.info(f"Credential added/updated: {name}")   <- 产品无条件记成功

async def process_single_file(file_data):
    """产品 panel/creds.process_single_file 的成功/异常分支"""
    try:
        filename = os.path.basename(file_data["filename"])
        credential_data = json.loads(file_data["content"])
        await add_credential(filename, credential_data)   # 信号量之前，无限流
        return {"filename": filename, "status": "success", "message": "上传成功"}
    except json.JSONDecodeError as e:
        return {"filename": file_data["filename"], "status": "error", "message": str(e)}
    except Exception as e:
        return {"filename": file_data["filename"], "status": "error", "message": str(e)}

async def main(n=300):
    build_schema()
    files = [{"filename": f"c{i}.json",
              "content": json.dumps({"access_token": "x"*300, "refresh_token": "y"*180,
                                     "project_id": f"p{i}"})} for i in range(n)]
    base = threading.active_count(); peak = [base]; stop = False
    async def watch():
        while not stop:
            peak[0] = max(peak[0], threading.active_count()); await asyncio.sleep(0.005)
    w = asyncio.create_task(watch())
    t = time.perf_counter()
    results = await asyncio.gather(*[process_single_file(f) for f in files])  # 整批 gather
    el = time.perf_counter() - t
    stop = True; w.cancel()

    reported = sum(1 for r in results if r["status"] == "success")
    c = sqlite3.connect(DB)
    actual = c.execute("SELECT COUNT(*) FROM credentials").fetchone()[0]
    dup = c.execute("SELECT COUNT(*)-COUNT(DISTINCT rotation_order) FROM credentials").fetchone()[0]
    bt = c.execute("PRAGMA busy_timeout").fetchone()[0]
    print(f"busy_timeout={bt}ms reported={reported}/{n} actual_rows={actual} "
          f"error_logs={len(errors_logged)} dup_order={dup} peak_threads={peak[0]} "
          f"elapsed={el*1000:.0f}ms")

asyncio.run(main())
```

> **该脚本仍然隔离掉的部分**：完整的存储管理器初始化、真实日志系统、HTTP 上传层、tier 探测的网络等待、ZIP 解压，以及多 worker / 多进程形态。因此它**支持风险存在，不支持生产比例预测**。
