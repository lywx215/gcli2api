# 旧模型 API 矩阵归因记录

记录日期：2026-10-13。用户最新流程为先确认客户页面，再进入正式开发及详细测试。本记录只归档已完成证据；不启动后续测试或修复，不部署，不恢复 Gemini CLI 专属维护或已取消 MGMT 工作。

## 结论与当前状态

完整原始对照证实：这组测试中的全部 253 个失败已存在于 UI 改造基线，在当前 UI SHA 上没有新增失败。两次各收集 282 项，逐项比较 nodeid、outcome、phase 以及规范化后的完整失败文本 SHA-256，282 项全部一致，差异为 0。此结论不是从单一失败样本外推。

当前分支的 `tests/test_model_api_error_matrix.py` 已恢复为 `fe99b43` 原样；253 个旧失败仍未修复，不能将该原始回归组标记为通过，也不据此宣称所有模型功能或生产环境通过。

| 对照 | SHA / 文件状态 | 通过 | 失败 |
| --- | --- | ---: | ---: |
| 完整基线归档，原始 fixture | `ebda92be2a4a5562963360bdbab2d33379e63077` | 29 | 253 |
| 完整当前归档，原始 fixture | `fe99b43a1b916f56f33d2f3b35aaf7c9eab6bbfd` | 29 | 253 |
| 基线临时 fixture 实验，已撤回 | 基线归档加内存 adapter | 282 | 0 |
| 当前临时 fixture 实验，已撤回 | 当前工作树临时修改 | 282 | 0 |

原始组内，矩阵本身为 272 项：19 通过、253 失败；`test_antigravity_request_compat.py` 2 项通过；`test_model_routing_panel.py` 8 项通过。

临时 fixture 实验在收到“先客户页面确认、停止新增测试”的指令之前已经启动，停止检查时两次均已完成。随后精确撤回本代理唯一的测试源码修改，核验该文件 Git diff 为空。保留实验机器证据是为了准确记录已发生的操作；上述 282 通过不代表当前已恢复的原始测试通过，也不是正式开发验收门禁。

## 全部失败的归因

`src/model_routing/store.py::_get_adapter()` 要求已有 `_initialized=True` 的 adapter；`prepare_route_context()` 在 upstream mock 之前读取路由配置，配置不可用时按现有逻辑返回安全的本地 503。旧矩阵 `_app()` 构造的 FastAPI 没有启动真实 lifespan，原始 fixture 也没有注入这个初始化契约。结果是生成请求在命中预期 upstream mock 之前被拒绝，成功响应、错误类型、Retry-After、正文后错误及统计断言随之失败。认证和无需该路由读取的测试仍可通过。

验证中没有替换 resolver、compiler、handler、converter 或错误边界。临时实验仅按测试隔离要求提供每例独立内存 adapter 的 `get_config_fresh` / `set_config`（缺失配置保留 default/sentinel，写入深拷贝），并设置明确的安全配置缓存及环境。原始断言、参数矩阵、错误期望均未修改，无 skip / xfail。该实验使基线及当前全部 282 项通过，支持“旧 fixture 缺少路由初始化依赖”的归因；修正已按用户流程撤回，后续是否纳入由正式开发阶段决定。

全部失败分布如下：

| 测试族 | 失败数 |
| --- | ---: |
| two_backend_three_protocol_four_mode_success_matrix | 24 |
| http200_error_and_retirement_are_fixed_once | 6 |
| converter_failure_is_fixed_and_counted_once | 1 |
| postcommit_error_is_terminal_without_replay_or_success_tail | 6 |
| precommit_error_matrix | 96 |
| fake_retirement_is_http404_before_stream | 6 |
| nullable_error_and_quoted_retirement_are_success | 18 |
| only_local_retry_after_survives | 36 |
| alias_uses_one_normalized_statistics_key_in_every_mode | 48 |
| postcommit_response_preserves_private_error | 12 |
| 合计 | 253 |

253 个失败对应 27 种完整失败文本指纹；全部 nodeid 与其指纹映射在两个 SHA 上一致。归一化仅替换 checkout 绝对路径与运行时对象内存地址，不删除断言、HTTP 状态、响应正文或堆栈行号。

- 排序失败 nodeid 集合 SHA-256：`a9fb80dd32f3206b6256b6e2a2dc5620787f85797531d2a6475c490623487cc3`
- 排序 nodeid → 失败指纹映射 SHA-256：`f5fc11b4cdd17165e1ecfbf328aff89c4cb420acfeb5e55c49a80f3d480d61b3`
- 对 `src/router/`、`src/api/`、`src/model_routing/`、`config.py` 和本次三个测试文件共 39 个文件逐字节 SHA-256 对照，无文件变化；Git 对相应路径的基线至当前 diff 也为空。

## 隔离与命令

Python 3.12.10，pytest 8.4.2。两份源代码来自完整 `git archive`，没有使用 dirty 的历史 integration 工作树。runner 只保留 OS/runtime 环境变量白名单，清除真实数据库、代理、密码及服务配置，创建临时 `CREDENTIALS_DIR`，设置 `ENABLE_LOG=0`、临时日志路径与无服务的 loopback endpoint。禁用 pytest 自动插件发现，仅显式启用 pytest-asyncio；禁止 bytecode 与 pytest cache 写入。

Python audit hook 阻断 SQLite connect 与非 loopback socket connect；loopback 仅为 Windows asyncio socketpair / 内存 ASGI TestClient 所需而保留。四次完成执行的 `blocked_database` / `blocked_network` 均为 0，表示没有触发这些受禁止连接尝试。没有启动真实应用 lifespan、读取真实凭证、访问真实模型/OAuth/管理 API 或改动生产数据。模型请求全部是测试内 ASGI/mock transport，不能证明外部上游可用性。

首次普通沙箱执行卡在收集后，未生成完成证据；仅停止这两个本任务 runner 进程，然后在保持相同隔离配置及 audit hook 的条件下使用提权进程完成对照。这些卡住的尝试不计入结果。

实际使用的 PowerShell 命令（`$e` 是本次证据目录，`$w` 是主集成工作树）：

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
```

runner 在各 checkout cwd 内实际调用的 pytest 参数为：

```text
-p pytest_asyncio.plugin -p no:cacheprovider --tb=short -q tests/test_model_api_error_matrix.py test_antigravity_request_compat.py test_model_routing_panel.py
```

已撤回实验的执行命令为（实验源码内容保存在证据目录 `add_fixture.py`，不自动重放）：

```powershell
python -u "$e/run_isolated.py" 'C:/Users/lywx2/AppData/Local/Temp/matrix-baseline-e7i8fgbv' "$e/baseline-fixed.json" *> "$e/baseline-fixed.log"
python -u "$e/run_isolated.py" $w "$e/current-fixed.json" *> "$e/current-fixed.log"
```

机器证据目录：`C:/Users/lywx2/.codex/visualizations/2026/10/13/01a132fa-9639-7c50-a301-b42ba28f74ee/model-matrix/`。`baseline-original.json` / `current-original.json` 含全部 case 的 outcome、失败全文与 SHA-256；`original-comparison.json` 为逐项比较；`summary.json` 含统计及总指纹；`source-comparison.json` 含 39 个文件的双方源码 SHA-256。原始 zip 仍保留，临时解压目录已用于实验，不应再冒充未修改基线。

本记录不修改 schema、capability、旧接口或版本号，manager 无需动作（`no_counterpart_action`）。尚未完成的正式开发与详细测试保持后置。
