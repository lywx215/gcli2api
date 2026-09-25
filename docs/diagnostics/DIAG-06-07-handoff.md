# DIAG-02 → DIAG-06/07：容量与终局证据说明

本文件供协调窗口交接，只有用户启动后续任务才实施，不触发自动任务、轮询或模型调用。对应 DIAG-02 R2 修订；没有变更冻结 schema/capability，也未更改其他仓库。

## 当前日志边界

- 公共文件为 `<LOG_FILE>.diag.<pid>.<bootId>.jsonl`，单文件硬上限 **16 × 1024 × 1024 = 16,777,216 字节**，单行含 LF 最多 4096 字节。
- 下一整行会超过上限时，当前进程永久停写该路径；open/write/flush 失败也可能停写。没有自动轮转，不删除其他 boot/worker 文件。
- 达上限后增长的 sinkDroppedTotal 无法写入已经停止的文件，文件中没有“停写”专用事件。只看文件不能区分该 boot 空闲、停写、崩溃或导出不完整。
- 上限只约束单个文件，**目录总量无界**。多 worker、反复重启均增加文件；运维负责归档、清理和总容量管理。
- flush 失败计数是已知损失下界，可能有多条缓冲记录一起丢失，不能据该计数精确还原所有丢失事件。

## DIAG-06 分析与提示要求

1. 导入时保留原始文件大小、行数、来源/导出证据与 boot 边界，避免因文件静默而认定进程无请求或全程覆盖。
2. 文件大小接近上限，例如 **≥ 16,777,216 − 4096 = 16,773,120 字节**，可显示“接近生产者单文件上限，疑似尾部截断/证据缺口”。该阈值只是线索，**不得标为确定丢失或确定达到上限**；正常文件也可能恰好接近上限，小文件也可能因 I/O/导出失败缺尾。
3. 结合 span 终局、expectedLastLogSeq、已知丢失计数、source/export 覆盖等证据判定；未知就保持 unknown，不能以近上限替代确定性检查。不得新增或伪造冻结事件来表达 sink_stopped。
4. attempt 身份采用 `(resource, serverSpanId, retryScope, attemptId)`；本服务 attemptNo 会在外层续写重新从 1 开始，不按 attemptNo 聚合。attempt 的 server-span 终局在 diag.server 前；独立 call 终局可以晚到，不跨 span 比较 logSeq。
5. holder 结算的 attempt 记录的是 server 结束时已知证据；以后 call 的真实 EOF 不得反向把原 attempt 改写为 success。只有确认的 HTTP EOF 才是 eofSeen，不以 DONE 推断成功。
6. Claude message_start 交付的占位 0 可能出现在 deliveredUsage/source=converted；不等同于 upstream/source=upstream 的 observed zero，不能用前者补齐后者。

## DIAG-07 验证与部署前条件

- 在合成环境验证近上限/停写及不完整导出时，分析提示保持“疑似/未知”；同时验证正常接近上限的文件不会被断言为确定截断。不要修改冻结制品来制造新事件。
- **生产启用前**需单独确定并验收轮转或可配置容量、留存/归档与目录总配额方案。当前 16 MiB/boot 停写限制不能直接当作长驻生产的完整诊断方案。本轮不实现轮转框架，不授权部署。
- 部署审批核对现网镜像实际 httpx 版本和依赖解析记录，评估与 `httpx[socks]==0.28.1` 的差异；不假定现网已运行该版本。
- 在 Linux/POSIX 环境实际执行 fork writer 隔离、父缓冲不重复刷出、旧文本日志在子进程的行为，以及相关并发/取消路径。Windows 的条件跳过不是通过，也不证明所有竞争时序安全。
- DIAG-02 本地测试使用临时凭证/日志/SQLite和 loopback 合成上游，未调用生产服务。跨服务、生产环境和上述部署前门槛仍由对应后续任务提供证据。
