# 旧模型 API 矩阵归因

2026-10-13。用户已确认方案并恢复正式开发及测试。本轮只修正旧矩阵的共享测试初始化，不恢复 Gemini CLI 专属维护或已取消 MGMT 工作，不修改产品模型运行时，不部署。

## 正式 fixture 修正与本轮验证

提交前基线：`419873f42ed0b82ef1997ea25edef940342ce500`；唯一测试源码修改为 `tests/test_model_api_error_matrix.py` 的 per-test autouse fixture。它为无 lifespan 的 ASGI 测试提供初始化的内存 routing adapter，保留缺失键 default/sentinel 语义、深拷贝读写、独立配置缓存和临时安全环境。没有绕过 resolver、修改断言/参数/错误期望、skip 或 xfail，也没有修改任何产品运行时文件。

本轮重新执行，结果不复用此前已撤回实验：

| 正式执行 | 用例数 | 通过 | 失败 |
| --- | ---: | ---: | ---: |
| 原 282 项整组：矩阵 + request compatibility + routing panel | 282 | 282 | 0 |
| 独立共享 routing integration + safe errors | 125 | 125 | 0 |
| 矩阵先运行，再运行上述共享回归及另外两个原文件 | 407 | 407 | 0 |

两次包含矩阵的执行分别在全部 272 个矩阵 case teardown 后核验 adapter 对象身份、config 初始化标记、cache 对象及内容、相关环境变量恢复到 setup 前状态：各 272/272 通过，无污染。独立与组合执行中全部对应 nodeid/outcome 一致。三次审计的数据库/外部 socket 禁止尝试数均为 0；全部使用临时合成数据、内存上游 mock，无真实 DB/network/lifespan。

受测矩阵源码 SHA-256：`7e90a0ade124ac325d175f245f5cdffee050c9c080f29f5a364df64b9bc1a8fb`。正式证据位于下方原证据目录的 `formal/`：`original-282.json`、`shared-standalone.json`、`combined.json` 及各自日志；`summary.json` 包含全部统计和跨组比较；`run_isolated.py` 保存环境与 teardown 审计逻辑。

```powershell
$e = 'C:/Users/lywx2/.codex/visualizations/2026/10/13/01a132fa-9639-7c50-a301-b42ba28f74ee/model-matrix/formal'
$w = 'C:/Users/lywx2/.codex/worktrees/ui-redesign/gcli2api'
python -u "$e/run_isolated.py" $w "$e/original-282.json" tests/test_model_api_error_matrix.py test_antigravity_request_compat.py test_model_routing_panel.py *> "$e/original-282.log"
python -u "$e/run_isolated.py" $w "$e/shared-standalone.json" test_model_routing_integration.py test_model_routing_safe_errors.py *> "$e/shared-standalone.log"
python -u "$e/run_isolated.py" $w "$e/combined.json" tests/test_model_api_error_matrix.py test_model_routing_integration.py test_model_routing_safe_errors.py test_antigravity_request_compat.py test_model_routing_panel.py *> "$e/combined.log"
```

限制：本轮仅验证指定本地共享模型路由回归及 fixture 清理，不代表全仓库、真实上游或生产验证。按用户确认不运行 Docker，不部署、push 或调用 Claude。

## 原始对照结论（先前完成证据）

这组原始测试的全部 253 个失败已存在于 UI 改造基线。基线和当前版本各收集 282 项，全部 nodeid、outcome、phase 及规范化完整失败文本 SHA-256 一致，差异为 0；不是抽样外推。

| 对照 | SHA / 状态 | 通过 | 失败 |
| --- | --- | ---: | ---: |
| 完整基线归档，原始 fixture | `ebda92be2a4a5562963360bdbab2d33379e63077` | 29 | 253 |
| 完整当前归档，原始 fixture | `fe99b43a1b916f56f33d2f3b35aaf7c9eab6bbfd` | 29 | 253 |
| 基线临时 fixture 实验，已撤回 | 内存 adapter + 安全配置 | 282 | 0 |
| 当前临时 fixture 实验，已撤回 | 同一临时修正 | 282 | 0 |

原始矩阵本身为 272 项：19 通过、253 失败；另外两个文件共 10 项通过。相关 `src/router/`、`src/api/`、`src/model_routing/`、`config.py` 及三个测试文件共 39 个源码文件逐字节 SHA-256 一致，Git 对相应路径的基线至当前 diff 也为空。

**此前客户页面确认阶段保留原始 253 个失败，未修复、未标记为通过；本轮正式修正后的新结果见上方。** 临时 fixture 两次验证在收到暂停指令前已启动，停止检查时已经真实完成；随后从当前 SHA 原始 archive 精确恢复 `tests/test_model_api_error_matrix.py`，核验该文件 Git diff 为空。这些临时实验结果没有被充作本轮正式开发验收；本轮重新执行并保存独立证据。

## 原因与证据

`src/model_routing/store.py::_get_adapter()` 要求已初始化 adapter；`prepare_route_context()` 在 upstream mock 前读取路由配置，不可用时返回安全本地 503。旧矩阵 `_app()` 没有真实 lifespan，也没有提供路由初始化 fixture，导致生成请求在预期 upstream mock 之前被拒绝，响应、Retry-After、流式边界和统计断言随之失败。

已撤回实验只提供每例独立内存 adapter 的 `get_config_fresh` / `set_config` 与明确安全配置；保留缺失配置的 default/sentinel 语义，不替换 resolver、compiler、handler、converter 或错误边界，不修改断言、参数、skip 或 xfail。两份完整组都通过，支持旧 fixture 缺少初始化依赖的归因。该实验仅保留为历史对照；本轮正式修正及重新执行结果见上方。

253 个失败覆盖 10 个测试族、27 种失败文本指纹，全部对应关系在两个 SHA 上一致。归一化只替换 checkout 路径与运行时对象内存地址，保留断言、HTTP 状态、响应正文及堆栈行号。

- 排序失败 nodeid 集合 SHA-256：`a9fb80dd32f3206b6256b6e2a2dc5620787f85797531d2a6475c490623487cc3`
- 排序 nodeid → 失败指纹映射 SHA-256：`f5fc11b4cdd17165e1ecfbf328aff89c4cb420acfeb5e55c49a80f3d480d61b3`

## 隔离与复现记录

Python 3.12.10 / pytest 8.4.2，两份完整 `git archive` 在各自独立临时目录运行。runner 仅保留 OS/runtime 环境变量白名单，清除真实 DB、代理、密码配置，使用临时 `CREDENTIALS_DIR`、`ENABLE_LOG=0`、无服务 loopback endpoint，禁止 bytecode/cache 写入，仅加载 pytest-asyncio。audit hook 阻断 SQLite 与非 loopback socket；保留 loopback 供 Windows asyncio 使用。四次完成运行的被阻断 DB/外部网络尝试数均为 0。没有真实 lifespan、真实凭证、模型/OAuth/管理 API 或生产数据操作，不能证明生产上游可用性。

首次普通沙箱运行卡在收集后，未生成完成证据；仅停止本任务两个进程，在相同隔离 runner 下提权重跑。以下是完成运行的命令记录：

```powershell
$e = 'C:/Users/lywx2/.codex/visualizations/2026/10/13/01a132fa-9639-7c50-a301-b42ba28f74ee/model-matrix'
$w = 'C:/Users/lywx2/.codex/worktrees/ui-redesign/gcli2api'
git --work-tree=$w archive --format=zip --output=$e/baseline.zip ebda92be2a4a5562963360bdbab2d33379e63077
git --work-tree=$w archive --format=zip --output=$e/current.zip fe99b43a1b916f56f33d2f3b35aaf7c9eab6bbfd
python "$e/extract.py"
python -u "$e/run_isolated.py" 'C:/Users/lywx2/AppData/Local/Temp/matrix-baseline-e7i8fgbv' "$e/baseline-original.json" *> "$e/baseline-original.log"
python -u "$e/run_isolated.py" 'C:/Users/lywx2/AppData/Local/Temp/matrix-current-8igooud5' "$e/current-original.json" *> "$e/current-original.log"
python "$e/compare.py"
python "$e/summarize.py"
# 已撤回实验：在暂停指令前启动，不应自动重放。
python -u "$e/run_isolated.py" 'C:/Users/lywx2/AppData/Local/Temp/matrix-baseline-e7i8fgbv' "$e/baseline-fixed.json" *> "$e/baseline-fixed.log"
python -u "$e/run_isolated.py" $w "$e/current-fixed.json" *> "$e/current-fixed.log"
```

runner 实际 pytest 参数：

```text
-p pytest_asyncio.plugin -p no:cacheprovider --tb=short -q tests/test_model_api_error_matrix.py test_antigravity_request_compat.py test_model_routing_panel.py
```

证据位于上述 `$e`：`baseline-original.json` / `current-original.json` 含全部 case、失败全文和指纹；`original-comparison.json` 为完整逐项比较；`summary.json` 含统计、失败族及总指纹；`source-comparison.json` 含 39 个源码文件双方 SHA。原始日志及 zip 保留；临时展开目录已用于实验，不应再当作 pristine 基线。当时临时 fixture 内容保存在证据脚本 `add_fixture.py`，并在暂停阶段恢复了仓库测试源码；本轮正式修正已重新应用。

未修改产品运行时、schema、capability、旧接口或版本号；manager 无需动作（`no_counterpart_action`）。此前原始失败的归因保持不变：253 个失败非 UI 引入；本轮只修正测试初始化，并以本轮独立证据将指定回归组更新为通过。
