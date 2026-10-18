# 导入反馈修复包：合同绑定版 R05 / R06 / L06

兼容补充：`appendAndDeduplicateFiles` 已导出为通用 tuple 追加／去重纯函数，既有测试也以 TXT 样本验证其通用规则。保留该 helper 的现有语义；JSON/ZIP 格式筛选在用户选择和拖放两个入口共用同一筛选逻辑，然后再调用原 helper，不借格式恢复改变通用去重函数。计数型 progress 仍只显示文件计数，不被转换成新字节百分比。

日期：2026-10-15。状态：**后端合同已应用并绑定；本请求未派发，整体 ready=false，等待 batch/API 交付及主窗 dependency closure 与归属确认**。

本文件与相邻 `import-feedback.contract-bound-template.json` 是新增准备产物。原模板、原 brief、应用源码及所有在途上下文均未修改。模板没有实际授权 ID；保持七个前端允许文件、四个有序任务、单 attempt、1800 秒。此次只读取文档及文件字节哈希，未调用官方 CLI、命令、测试、构建或真实接口。

主窗集成时统一范围仍为 `docs/ui-redesign/PARITY_GAP_REPAIR_SCOPE_20261015.json`；**本 brief 项目复制目标为 `docs/ui-redesign/gap-repair/import-feedback.contract-bound.brief.md`**。本准备任务只在产物目录落盘，不向 W 复制，不覆盖任何在途 context。合同已位于 W 的 `docs/ui-redesign/gap-repair/UPLOAD_PROGRESS_CONTRACT_20261015.md`，SHA-256：`56e149612474d410384163083ea48fe6a27a3a0512a3919d18e5d169b7d4ff17`。

`APPLIED_UPLOAD_BACKEND.json` 记载 `web.py` 与 `src/panel/upload_progress.py` 两文件已真实应用，10 组针对性合成确认绑定已应用字节；本次读取的 W 文件哈希与记录一致。本次没有重跑该确认，也不将记录解释为整套前端测试、真实部署或生产验收通过。

## 依据和范围

- W：`C:/Users/lywx2/.codex/worktrees/ui-full-parity/gcli2api`。
- 需求：W 的 `AGENTS.md`、`docs/MAINTENANCE_SCOPE.md`、`docs/ui-redesign/FULL_PARITY_REQUIREMENTS.md`。
- 差异证据：`full-parity-execution/windows-close-20261015/functional-recheck-20261015-01/FUNCTIONAL_RECHECK.json` 中 R05、R06、L06，及同目录 `workflows-audit.md` 的 W-F1、W-F2、W-D1。
- 本次授权范围为已确认 12+7 差异中的导入三项。双渠道旧 UI 恢复例外适用，不恢复已取消 MGMT、新模型适配、生产数据操作或额外模型调用。
- 全部前端源码由官方 Antigravity CLI 编写；Codex 负责需求、后端进度能力、合同、派发与交付检查。此准备任务不运行验收。

| 差异 | 当前证据 | 要交付的用户行为 |
| --- | --- | --- |
| R05 / UI-COMP-039 / UI-SUPP-002 | `index.tsx:881` 固定 `progress={null}`；`api.ts:517` 的 FormData 只调用 requestJson；runner 无真实上传进度 | 大文件上传可观察真实服务器接收字节；可计算时显示百分比，总量未知明确显示未知；传输完成与导入完成分开 |
| R06 / UI-COMP-038 / UI-SUPP-002 | `normalizeResult` 根据 error/error_code 判失败却丢弃原因；types、runner whitelist、components 均无原因通路 | 每个失败项显示受控、可区分的原因；未知错误给固定摘要，不回显凭证或 raw 错误 |
| L06 / UI-COMP-039 / UI-SUPP-002 | `ImportFilePicker.tsx` 选择/拖放接受任意 File，input 没有 accept | JSON/ZIP 可追加并去重；其他格式即时拒绝并有提示；混合输入保留合法项 |

上表是静态源码证据，不能转述为本次运行复现或测试通过。行号来自功能复查基线，派发前须重新绑定当前文件。

## 写集与并行约束

精确写集仅七个现有文件：

1. `frontend/src/pages/import/api.ts`
2. `frontend/src/pages/import/types.ts`
3. `frontend/src/pages/import/workflowRunner.ts`
4. `frontend/src/pages/import/hooks.ts`
5. `frontend/src/pages/import/components.tsx`
6. `frontend/src/pages/import/index.tsx`
7. `frontend/src/pages/import/ImportFilePicker.tsx`

`frontend/src/api/client.ts` 保持只读。**不新增 `import/uploadTransport.ts`，不使用 XHR 或独立 fetch。** 保持前端模块划分，无新增依赖、测试、fixture 或配置改动。所有新增公开字段/参数必须可选，旧调用和已有测试源码仍作为只读兼容依据。

导入页面与 Mac 先前归属重叠，只有主窗可协调冻结/释放；该准备包不自行解除冻结。`frontend/src/pages/credentials/api.ts` 是导出依赖，属于本包只读 context；必须在其 batch/API 交付完成后重读、重绑。并行批次的 write/write 和 write/context 都必须无冲突，不能因为详情代码没有直接改 import 就忽略共享 API 依赖。

## R05：已应用的真实接收字节合同

固定合同与 `web.py`、`src/panel/upload_progress.py` 均是只读 context。能力为 `panel.credentials.upload_progress.v1`，属于面板增量接口；不改变 Management schema/capability，manager 无需动作。原上传响应、解析、预算及落库语义继续权威。

全部请求经现有 `api/client.ts` 的 `requestJson`，沿用 service-base/子路径、same-origin、`redirect:error`、`cache:no-store`、Bearer/session epoch、PanelScope、AbortSignal 以及精确面板鉴权与业务 401/403 区分；共享 client 只读。不得另建 fetch/XHR/transport 或依赖，不将面板 token 放 query。

### 固定路径与能力字段

| 步骤 | 实际接口与要求 |
| --- | --- |
| 能力发现 | `GET /creds/upload-progress/capabilities`，同样须面板鉴权。200 字段：`capability` 精确能力名、`supported:boolean`、`reason:null 或 multi_worker/worker_count_invalid/single_worker_unconfirmed`、`modes:[geminicli,antigravity]`、`ttl_seconds:900`、`poll_interval_ms:500`。确认本次 mode 被支持后才创建 ticket。 |
| 创建 | 每次上传一个 `POST /creds/upload-progress?mode=<capturedMode>`，无 body，不将 mode 放 JSON；201 返回下表 Progress。 |
| 原上传关联 | `POST /creds/upload?mode=<capturedMode>&progress_id=<ID>`，只追加可选 query，保留原 FormData files 与响应；浏览器自行设置 multipart Content-Type/Content-Length。 |
| 读取 | `GET /creds/upload-progress/<ID>?mode=<capturedMode>`，200 返回 Progress，仍用相同面板身份与 mode。 |

路径交给现有服务根构造逻辑，不能绕过部署子路径。`WORKERS=1` 本身不是能力确认；外部 ASGI launcher 未确认单 worker 时可能返回 unsupported，前端不得尝试调用内部 Python helper 或改变运行设置。

### Progress 字段与展示语义

| 字段 | 固定类型及使用边界 |
| --- | --- |
| `progress_id` | 32 位小写十六进制 nonce；只在本次操作私有内存保留。知识本身不能替代面板鉴权；校验读回 ID/mode 与当前操作匹配。 |
| `mode` | `geminicli` 或 `antigravity`，必须匹配捕获渠道。 |
| `received_bytes` | 非负整数，实际 ASGI receive 消费的请求体字节，含 multipart 边界和头；不能用文件数、读取 File、定时器、Promise 或客户端响应消费量代替。 |
| `total_bytes` | 非负整数或 null，实际有效 Content-Length 口径；缺失、无效等为 null，不能用 File.size 总和替代 multipart 长度。 |
| `phase` | `receiving / processing / finished / interrupted`。 |
| `http_status` | 整数或 null，仅说明已观察到 HTTP response start，不能授予成功或导出。 |
| `bound` | boolean；false 表示尚未绑定上传，true 表示已绑定，不能用于推断导入结果。 |
| `expires_in_seconds` | 剩余单调 TTL 的向上取整非负整数；读取/接收不会延长期限。 |

所有字段进行白名单和有限整数/枚举验证；不将原始响应直接放公共快照。只有 `total_bytes>0` 且值合法时，以真实 received/total 计算有限、有界百分比；null 或 0 显示字节与总量未知。`receiving` 可处于排队或接收；`processing` 说明请求体已消费完；`finished` 只是最终 HTTP body 已发送，包含 413/422 等失败；`interrupted` 不能证明数据库回滚。100% 是接收完成，实际上传响应仍决定成功、partial、failed、unknown、receipt、confirmedFilenames 和导出许可。

### 降级和错误边界

- **上传开始前**：旧服务能力接口 404/405、`supported=false`、503 `upload_progress_unsupported`、创建 ticket 429 `upload_progress_capacity`，或其他已判定为非鉴权的进度不可用，可在 owner/validation/generation/scope 仍有效时只执行一次不带 progress_id 的原普通上传，并显示进度不可用/未知。无法验证的能力响应不可假装 supported。
- **鉴权不是降级**：面板鉴权失败、HTTPBearer 缺失/畸形授权拒绝、session/scope 失效和 abort 走共享 client 原有失效/取消路径；不能 catch-all 后 blind fallback 到普通上传。业务 401/403 维持现有精确分类。任何 raw detail/error 都不得回显。
- **上传开始后**：poll 404 `upload_progress_not_found`（含失效/过期/错误 owner/mode）、503、不合法快照、进程重启或读取失败，只令观察不可用并停止轮询；不得重发原上传。上传自身 409 `upload_progress_unavailable`、503、400/422 也不能触发自动普通重传。无法确定结果不等于未落库。
- 400 `upload_progress_invalid_mode` 或标准 422 是参数/绑定错误，不得谎称能力未支持；使用固定安全提示，按实际上传结果处理。
- 票据容量是进程最多 256、同 owner 最多 8（包括保留中的未绑定/进行中/完成票据）；无删除接口。不可循环创建 ticket 或通过重试填满容量。

### 500ms 串行轮询与所有权清理

上传与观察使用现有客户端，但各自控制器职责清楚；停止观测不得无故中止上传。每次能力发现、ticket 创建、上传、poll 和发布绑定 `capturedOwner`、`capturedValidation`、operation generation、PanelScope 及这一次 upload，在发送前、响应后和发布前均验证当前性。

一个上传最多一个未完成 GET；前一次 settle 后至少等待 **500ms** 再读取，不能 setInterval 重叠。读取失败即停止观察，不自动重试。ticket 从创建起 **900 秒硬 TTL**，使用返回 expires_in_seconds 收紧本地不超过 900 秒的观察期限，轮询/流量不续期；到期不取消导入。上传 settle、finished/interrupted、TTL/返回零剩余秒、取消、身份/渠道/validation/scope 失效或 runner teardown 都停止读取并清除定时器、监听、控制器及私有 ticket。迟到响应不得污染下一任务。

普通跨页导航可以让存活 runner 保留操作及数字进度；页面卸载清理页面 actor/订阅，旧 closure 不得更新新页。runner/scope 真正销毁时才清理其观察；两种清理的职责不能混淆。取消客户端不代表服务端回滚。ticket/token 不进入 flowStore 公共快照、localStorage/sessionStorage、导航 URL、日志或导出，也不保存 File/FormData、raw error。只在当前操作私有内存使用 ticket；只读请求 URL 中的 progress_id 是合同所需网络关联，不是持久化许可。

### 前端兼容与完整接线

`ImportApi.uploadFiles(files, signal)` 和旧便利调用保持可用；字节观察参数与类型均可选。现有 `ImportProgress={completed,total}` 是计数契约，Picker 的 `3 / 10` 且无百分比规则保留；新增独立可选字节字段。`api -> workflowRunner -> hooks -> index -> ImportFilePicker` 必须贯通真实生产值，不能继续以固定 null 作为唯一进度源。R06、L06 及 OAuth、邮箱、RT、逐次导出确认、双渠道既有语义不变。需要共享 client 或额外文件改动时报告 blocked，由主窗处理。

## R06：逐项失败原因的最小安全投影

已有生产源码确认的三类受控码：

| 错误码 | 固定显示摘要示例 |
| --- | --- |
| `credential_exchange_failed` | 授权无效或网络异常 |
| `credential_store_failed` | 凭证存储失败，请稍后重试 |
| `credential_import_failed` | 凭证导入失败 |

证据位于 `src/panel/creds.py` 的 RT 单/批量/helper，以及 `src/credential_manager.py:33` 的 `CredentialStorageError`。GCLI batch 普通返回分支仅转发 `error`，未转发 helper 的 `error_code`；不能假设两渠道所有失败都有码。

建议用可选受控枚举作为原因 DTO，再由固定字典生成摘要。若为了 GCLI 兼容必须识别旧 error，只允许源码已确认的固定完整字符串或锚定固定前缀；分类以后完全丢弃原字符串及后缀。没有可信分类时视图显示固定“导入失败，原因不可用”。不能截断 raw error、做一般性脱敏后回显，不能显示任何未知 error_code。

必须同时修改 `types.ts` 的可选类型、`api.ts` 的白名单投影、`workflowRunner.ts` 的再次验证/冻结和 `components.tsx` 的实际结果行。仅 API 存了字段而 runner 丢弃，不算完成。未知/矛盾项继续 unknown；失败原因不能改变 confirmedFilenames、成功 receipt 或导出许可。未知 raw 数据无需加入可选字段，从而保持旧失败和 unknown 对象形状兼容。

现有 `api-projection.test.ts` 的 canary 断言要求 Token、token preview、任意 error_code/error/message/detail/payload 都不出现在序列化结果；这些是只读检查依据，不得为适应实现而改测试。请求输入 clientSecret/Token 也不能被复制到原因、进度快照或日志。

## L06：选择和拖放统一过滤

旧 `front/common.js:1173` 接受 JSON/ZIP 的 MIME 或扩展名。恢复 input `accept` 提示，同时在选择/拖放两条路径使用同一实际过滤；支持合法 `.json/.zip` 扩展名（大小写处理明确）及缺失 MIME 的常见浏览器输入。前端只做格式选择提示，不读文件内容，后端继续承担格式与解压预算验证。

混合批次追加合法项并提示拒绝；全部非法不增加列表；合法同名重复文件继续按现有 `name/size/lastModified` 元组去重，而不是回退到旧 `name/size` 规则。保留已有文件顺序、名称/大小、清空、移除和同文件再次选择。所有提示/追加都受 mounted、render identity、disabled、isCurrent guard 约束。提示用固定内容/数量即可，避免把外部错误或文件内容引入 UI。

## 派发与后续验收

1. 后端依赖已 ready；主窗仍须完成 Mac 归属协调，并等待 batch 对 `frontend/src/pages/credentials/api.ts` 及其他 context 的交付。所有 write/write 与 write/context 冲突关闭后再完成 dependency closure。整体 `ready=false` 保持到这些门禁完成；不能把后端 ready 误认为可立即派发。
2. 将本新 brief 复制到项目目标后，重新读取七个 allowed files 及所有 context，重新记录哈希。固定合同 SHA-256 为 `56e149612474d410384163083ea48fe6a27a3a0512a3919d18e5d169b7d4ff17`；`web.py` 为 `6180f41f46d457956f40a605512bd5901a1c42760406255122e9625c15aae9f1`；`src/panel/upload_progress.py` 为 `8436cafd0d9792a4317fced78bbb93a39f2aa7cd7d1e43df025dd81d0aaa0da4`。如果变化须重新审查，不能沿用当前证据。准备产物不会修改任何在途 context。
3. 主窗基于本项目/本会话当前有效的人类开发授权生成新请求，安全绑定授权；模板不带实际 ID、不消耗请求、不复用历史 grant。四任务顺序为 `safe_item_failure -> picker_file_filter -> real_received_byte_progress -> owner_lifecycle_and_delivery`；`max_attempts=1`、`timeout_seconds=1800`，不自动重试，不派发 reviewer。
4. CLI 只写七个允许文件，按四个任务顺序返回 task_results。主窗检查完整 diff/写集，再按授权进行命令验收；本准备任务及 CLI 均不执行命令、测试、构建或真实业务调用。

后续验收观察点：双渠道真实接收字节/未知总量/100% 等待处理；旧服务 404/405 与 unsupported/capacity 的上传前降级；鉴权失败不 blind fallback；已开始上传不因观察失败重发；500ms 单 in-flight 与 900 秒不续期；owner/validation/generation 隔离、跨页延续及终态清理；三类受控原因/未知 raw canary 清除；JSON/ZIP 选择和拖放混合过滤/去重；旧 uploadFiles 和 Picker 计数兼容。仅使用合成传输和数据，不读真实凭证或生产接口。

本次未运行上述验收。后端已有 10 组合成确认只对应 APPLIED_UPLOAD_BACKEND.json 所绑定两文件，不能代替前端交付后验收。需要写集外文件或合同改变时报告依赖，不扩大写集、不把缺项标为完成。
