# DIAG-02：待审核

任务范围：gcli2api 追踪与 Antigravity 只读语义诊断。未恢复 GeminiCLI 专属维护或旧统一管理开发。

- Worktree：`C:/Users/lywx2/.codex/worktrees/14f9/gcli2api`
- 分支：`codex/diag-02-gcli-diagnostics`
- 基线：`1f65d3ec10830245f22a58691e124c5129f75707`；开始时 HEAD 一致且工作区干净。
- 契约来源：CLIProxyAPI `bb291667f7b6bd7a1dab6f9b7f906b5871d1306c`
- 契约：`ai-proxy-diagnostics/1`，制品 `1.0.0-rc.1`
- SHA256SUMS 原始字节 SHA-256：`ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4`
- 本地交付 HEAD 以完成消息中的完整 Git SHA 为准；该文档不嵌入自身提交 SHA。

## 接入点与理由

| 文件 | 接入内容与必要性 |
| --- | --- |
| `src/diagnostics/propagation.py` | 多值头提取、Level 1 future-version 规则、精确 peer origin/path、IPv6 地址等价、request-local ownership 清理 |
| `src/diagnostics/runtime.py` | 固定服务身份、worker 延迟初始化/PID 检查、独立 boot、server/call 身份与序号、门控/丢失/截断证据 |
| `src/diagnostics/asgi.py`、`web.py` | 纯 ASGI 入口，位于 Starlette 错误处理外层，覆盖成功/错误/流式提交和取消；保留 FastAPI public API |
| `src/diagnostics/http.py`、`src/httpx_client.py` | 请求钩子之后的实际发送边界；保持原 transport/proxy/mount；正文 EOF/close/error/cancel 单次结算；每个 redirect 独立 call |
| `log.py` | 复用原有有界队列与 writer，保留 256 个基础记录队列位置；独立 worker/boot JSONL 文件；DEBUG 切换 epoch；fork 不继承队列/锁/缓存文件 |
| `src/diagnostics/semantic.py` | DEBUG 内才计算结构、usage、输出和解析证据；凭证使用有界 boot 内随机别名；不记录文件名/正文/工具参数/任意上游 reason |
| `src/converter/antigravity_fix.py` | 既有清理位置读出变换前后与实际删除/去空白原因，中间件无法恢复这一信息 |
| `src/api/antigravity.py` | 只在既有 retry owner 进入实际 HTTP 调用时建立 attempt 属性；每次循环独立 attemptId，attemptNo 保留业务一基序号；不改重试/选凭证逻辑 |
| `src/api/utils.py` | 利用收集器已经解析的对象和解析失败证据观察流转非流；Antigravity 调用方在收集器提前返回时关闭原 iterator |
| `src/converter/openai2gemini.py`、`anthropic2gemini.py` | 读取转换前对象及实际输出对象；流式只积累有界数值，在 server 终局前输出一次；仅 Antigravity marker 生效 |
| `src/router/antigravity/gemini.py` | Gemini 没有独立响应 converter，在现有解包装点观察；未向 API 层传入入站 headers |

头写入/复制盘点先于实现完成，见 [header inventory](DIAG-02-header-inventory.md)。没有证据表明当前三个模型路由自动复制入站头；`extra_headers` 显式能力原样保留。没有新增入站信任适配器：caller 默认 X-Request-Id/unverified，callerAlias 未知；DIAG_PEERS 不认证入站请求。

## 配置与输出

沿用 `DIAG_ENVIRONMENT`、`DIAG_DEPLOYMENT_ID`、`DIAG_NODE_LABEL`、`DIAG_INSTANCE_ID`、`DIAG_PEERS`。无确认的生产平台 replica UID 适配器，故使用合法配置 instance ID 或随机 UUID，绝不猜主机名/service ID。环境/部署默认 unassigned，buildCommit 暂为 null。身份在 worker 初始化后固定，peer 配置在入口/发送/事件边界按快照更新；无效配置整体禁用传播。

基础 process/server/call 遵守 `ENABLE_LOG`；详细事件还要求 `LOG_LEVEL=debug`。关闭日志不会停止传播或响应 ID。动态 LOG_LEVEL 切换沿用 `log.set_log_level`；请求中途打开 DEBUG 不补采，关闭再开启也标 interrupted。记录构造后才分配 logSeq，同 span 基础/DEBUG 共用；后台 writer 不读取 ContextVar。

公共记录写到 `<LOG_FILE>.diag.<pid>.<bootId>.jsonl`，纯 JSONL、UTF-8 LF，每行含 LF 不超过 4096 字节。已有文本日志仍有其原有内容和策略，**不属于本公共脱敏导出**。日志文件不进入 Git；交付中的 [sample-zero.jsonl](sample-zero.jsonl) 是真实 loopback 路由生成的合成数据，包含 observed-zero 与缺失字段区别，不是手造终局。

## 验证命令与结果

使用现有 `G:/code/gemini30/gcli2api/.venv/Scripts/python.exe`（运行时报告 3.12.14），未修改服务 Python 要求或升级该 venv。oracle 的锁定依赖仅安装到临时目录：

```powershell
$py = 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe'
$env:PYTHONPATH = Join-Path $env:TEMP 'gcli-diag02-validation-deps'
& $py -m pip install --target $env:PYTHONPATH -r contracts/diagnostics/v1/requirements.txt
& $py contracts/diagnostics/v1/validate.py
& $py scripts/run_diagnostic_tests.py test_diagnostics_vectors.py -q --tb=short
& $py scripts/run_diagnostic_tests.py test_diagnostics_runtime.py test_diagnostics_service.py -q --tb=short
& $py scripts/run_diagnostic_tests.py -q --tb=short
& $py scripts/verify_diagnostic_contract.py
git diff --check
```

- 冻结 oracle：退出 0，3 schemas / 53 fixtures / 9 example lines / 242 vectors；不作为实际 Python 接入的替代证据。
- 实际生产解析/配置/注入与记录不变量检查：163 个共享向量全部通过；覆盖 headers、http-ingress、copy-source、outbound、redirects、peer-response、peers、resources、semantic。另有 Gemini `:method` 目标路径回归：目标路径规则与配置 prefix 语法分开，不能误拒绝合法实际目标。
- 运行时测试：并发 ASGI/子任务、生成器跨任务读取/关闭、EOF/提前 close/read error/cancel/connect error、真实 proxy、mount、hook/redirect 顺序、DEBUG 切换、队列预留/丢失、JSONL/截断、实际 HTTP 重复头、取消、错误响应 ID。
- 真实服务测试：假上游 + 原 Antigravity 路由/normalizer/API/retry/collector/converter/httpx；各协议 stream/nonstream、内部 collected、三次重试/两个凭证别名、usage 87/重复累计/0/缺失、错误帧、无结束帧、工具/媒体、两个 worker 与重启。
- 首轮完整回归暴露的 FastAPI `.openapi()` 兼容问题已修正。最后专项命令 `scripts/run_diagnostic_tests.py test_diagnostics_vectors.py test_diagnostics_runtime.py test_diagnostics_service.py -q --tb=short` 退出 0：198 passed / 1 skipped。最终完整命令 `scripts/run_diagnostic_tests.py -q --tb=short` 退出 0：630 passed / 1 skipped / 6 warnings（33.54 秒）；Windows 下唯一预期跳过是实际 POSIX fork，Windows 多进程启动与重启已实测。既有 Pydantic/Starlette 弃用 warning 保留。
- Git 字节检查退出 0：73 个冻结契约文件工作区与 index 完全相同、UTF-8 无 BOM/LF、清单摘要匹配。已增加精确的 `.gitignore` 例外，避免仓库原有 `*.json` 规则漏掉 schema/向量。`git diff --check` 退出 0。
- 所有测试通过隔离 runner 启动：普通测试 ENABLE_LOG=0，日志/凭证/SQLite 仅临时目录，远程存储和代理环境清空。需要验证 writer 的测试只在临时目录显式开启。
- graph/source-scope/counts/coverage 的离线归并算法与 Aito 映射属于 DIAG-06/其他服务，未在本服务重复实现。运行时生成记录按冻结 schema 验证，序号/父子关系/次数/终局断言直接针对实际生成记录。

## DIAG-07 启动入口

在本 worktree 的三个独立终端运行。每个 `--root` 必须是新的空目录；脚本拒绝非 loopback upstream，固定绑定 127.0.0.1，合成凭证由独立 fixture provider 提供，不读取真实凭证。

```powershell
# Terminal 1
& $py scripts/diagnostic_harness.py upstream --root "$env:TEMP/diag07-new/upstream" --port 19090 --scenario success
# Terminal 2
$env:DIAG_ENVIRONMENT='test'; $env:DIAG_DEPLOYMENT_ID='gcli-pool'; $env:DIAG_INSTANCE_ID='gcli-1'
& $py scripts/diagnostic_harness.py gcli --root "$env:TEMP/diag07-new/gcli-1" --port 19091 --upstream http://127.0.0.1:19090 --debug
# Terminal 3
$env:DIAG_ENVIRONMENT='test'; $env:DIAG_DEPLOYMENT_ID='gcli-pool'; $env:DIAG_INSTANCE_ID='gcli-2'
& $py scripts/diagnostic_harness.py gcli --root "$env:TEMP/diag07-new/gcli-2" --port 19092 --upstream http://127.0.0.1:19090 --debug
```

三个真实入口：`/antigravity/v1beta/models/gemini-3.7-flash:generateContent`（流式用 streamGenerateContent）、`/antigravity/v1/chat/completions`、`/antigravity/v1/messages`。合成认证为 `Authorization: Bearer synthetic-local-password`。CPA 可直接把这两个 loopback 服务设为 peer；普通 new-api 样式调用同样走真实入口。假上游场景支持 success/zero/missing/error/retry/slow/tool/media/empty/incomplete。加 `--nonstream-upstream` 切换真实非流上游；不加则走既有 stream2nostream。

`GET /__health` 用于就绪检查；`POST /__shutdown` 优雅结束并刷完 JSONL。这些测试端点只存在 harness，不进入 `web.py`。DIAG-07 应保存独立实例文件，导出时只读取 `.diag.*.jsonl`。这里验证 CPA 兼容的入站 traceparent，不宣称已经启动真实 CPA；跨服务双边联调仍由 DIAG-07 完成。

## 覆盖边界与风险

- 基础入口覆盖 web.py 所有 HTTP 路由，但不提供 WebSocket/browser span。共享 HTTP manager 内的请求有观察；另行构造的 httpx 客户端、未归属于活动入站请求的后台调用不声称覆盖。非模型同步辅助调用目前使用 callKind=other，未扩展 OAuth 专属业务。
- 支持正常 Gemini/OpenAI/Claude 流式与非流式的转换观察，以及 Gemini 抗截断解包装；假流式专属转换、异常提前返回的所有 converter 分支尚非完整细节覆盖，不据事件缺失推断未执行。基础终局和 attempt 错误证据独立存在。
- 没有发现本范围内现存 token 速率限制器；重试 sleep 不是 token throttle。未伪造 `throttle.finished` 或 capability，也未新增限速逻辑。
- 流式工具参数碎片尚未合成验证时，delivered validToolCalls 记 null。Gemini outputTotal 没有直接观察值时为 null，candidate/reasoning/raw 分列；不重新计算业务 token 总数。
- 诊断 SSE 单行/非流 JSON 观察上限 64 KiB；超过或解析不全只报告 incomplete，不阻止业务。只观察已经读取的字节，不预读、不改正文或背压。大型输出不会在诊断模块无限积累。
- 当前收集器会在 `[DONE]` 处返回，不一定读到 HTTP EOF。这种 attempt 保留 terminalSeen/usage/output，但 eofSeen=false、resultClass=incomplete；本地转换与响应仍可完成。未通过额外读取伪造 EOF。生产记录写出前有轻量跨字段约束检查，实际样例同时通过冻结 oracle 的语义校验。
- httpx 使用 `_send_single_request` / `_build_redirect_request` 两个私有扩展点。当前安装版本已测 proxy/mount/hook/redirect；未来 httpx 升级须重跑测试，不宣称所有未来版本兼容。
- POSIX 实际 fork 未在 Windows 执行；实现有 after-fork writer 清理和 PID 重建，并附条件运行测试。多 worker stdout 原子性未宣称；公共日志采用按 boot 独立文件。
- enqueue 后发生的 I/O 丢失只有 sink 级计数，进程崩溃/尾部丢失须由导出证据判定。full 仅限声明的 capability 与已导出记录，不代表业务成功或调用方收到/计费。

未部署、未合并、未推送、未调用 Claude、未派发子任务、未调用生产模型，未读取真实 Key/凭证/数据库/Volume，`panel-version.txt` 保持基线。等待协调窗口检查及准确 HEAD 的 Claude 审核。
