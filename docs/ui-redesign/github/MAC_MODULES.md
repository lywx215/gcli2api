# Mac 独立模块交接

准备日期：2026-10-15。状态：只读源核对及任务规划，未派发、未开发、未运行本轮测试。

本交接使用当前已落地源码，不把旧失败请求或组件计划视为交付。实际核对：`LegacyModelQuota.tsx/.test.tsx`、`AgQuotaEvidence.tsx/.test.tsx` 均不存在；`CredentialBatchPanel.tsx/.test.tsx` 和 `AdvancedTools.tsx` 也不存在。现有 `model.ts`、`ResultView.tsx`、`advancedApi.ts`、`batch.ts` 及 Core/session 已存在。

完整的允许路径、只读上下文、接口、行为验收及 SHA256 在 [MAC_TASK_PACKAGES.json](MAC_TASK_PACKAGES.json)。所有执行路径都相对仓库根目录；需移交当前源码与公开文档，不能仅凭历史分支名重建基线。

## 分工与授权

| 执行端 | 本轮职责 | 不能改动 |
| --- | --- | --- |
| Mac | LegacyModelQuota 两文件；AgQuotaEvidence 两文件 | Page/index、Detail、App/routes、任何 API、Core、共享组件/样式/配置 |
| Windows | 基础页激活、维护 API、Files/Email、Import runner/接线、最终 Detail/Page 集成 | Mac 保留的四个新文件；Mac 运行期间冻结的真实公共依赖 |

前端源码与测试只通过官方 Antigravity `agy` 开发和已批准的本地交付流程生成。Codex 负责计划、静态检查、命令验收；后端由 Codex 处理，本次两个模块不需要后端更改。

**Windows 旧外部开发授权已关闭。** Mac 必须在自己的项目和会话中取得人类新的明确开发授权，并检查本机官方 CLI 与受认可共享流程；不得搬运旧授权状态、认证存储、临时副本或已消费请求。本文件不构成调用授权，也不允许审核模型调用、额外重试、自动派发、提交/推送、部署、真实凭证/数据库/OAuth/模型请求。不要在 Mac 猜用 Windows CLI 路径或新建替代派发器。

## 模块一：LegacyModelQuota

允许新增且仅新增：

- `frontend/src/pages/credentials/LegacyModelQuota.tsx`
- `frontend/src/pages/credentials/LegacyModelQuota.test.tsx`

任务输入接口约定：导出 `LegacyModelQuota` 与 `LegacyModelQuotaProps`。只读 props 为 `models: Readonly<Record<string, unknown>>`、`mode: PanelMode`、`busy: boolean`、`scope: Readonly<PanelScope>`、`isCurrent: () => boolean`、`onTestModel: (id: string) => void | Promise<void>`，以及可选 `onExpiryReadback: () => void | Promise<void>`。

`models` 来自当前已拥有的人工结果，不能猜测 row 数据。调用方的 `isCurrent` 捕获真实 filename/task/session/validation 身份，不能把旧事件自动转给最新回调。组件不拥有 HTTP。

交付完整原始/友好名称切换、真实模型分组/可见性、剩余额度、有效恢复时间、滚动168h未知恢复提示和明确点击的模型测试回调。自己的有效字段优先，未知不补0；测试目标只用真实 `testModel`，仅旧 GCLI 缺字段时可用真实原始模型键。单一本地计时器仅通知拥有者读取保存状态，不能自动测试/查额度/释放，不能因倒计时到0宣称恢复。5H和周摘要仍为独立后端证据，不由此组件推导。

只需两个聚焦行为组：真实显示/精确点击；真实 Core 身份变化与受控时钟下的到期一次、busy延迟、拒绝不重试、旧事件失效。保留原既定行为，不扩大为矩阵。

## 模块二：AgQuotaEvidence

允许新增且仅新增：

- `frontend/src/pages/credentials/AgQuotaEvidence.tsx`
- `frontend/src/pages/credentials/AgQuotaEvidence.test.tsx`

导出 `AgQuotaEvidence`、`AgQuotaEvidenceProps` 和 `AgQuotaEvidenceReceipt`。props：`mode`、只读 `scope`、`filename`、`receipt | null`、可选 `disabled` 与 `onRefresh: () => void`。

receipt 固定为只读对象：`{ source: 'response' | 'saved', filename, scope, validation: SessionValidationSnapshot, result: ManualResult }`。调用方必须在真实拥有的结果落定时创建稳定对象，保留验证快照的对象身份；不能在渲染时给旧数据盖上新 scope/验证身份。`ManualResult` 是现有 `ResultView` 导出类型，不另造 DTO。

现有适配器为 `createAdvancedCredentialApi(mode, scope).releaseQuotaGroup(filename, group, signal?)`，返回 `Promise<ReleaseQuotaGroupResult>`。使用真实 API，不改它或改成直接 fetch。真实 `PanelScope` 必须含 mode/channelEpoch/sessionEpoch；渠道快照缺少 sessionEpoch。验证快照只有 sessionEpoch/status，禁止假设另有 validationEpoch/token 字段。

交付两固定组及其它真实组、保存/当前成功响应的来源区别、损坏/未知阻断/计时冷却/人工放行、Opus5.5/4.6检查/下次检查/不可用/目录缺失证据。未知原始原因不回显；GCLI 不显示、不调用。保持目录权限、生成验证、本地写回、保护状态和独立5H/周摘要的各自含义。

释放必须经过当前成功 response、blockedUnknown 且非 invalid、相同已验证 owner、精确 validation 身份及每次确认。以稳定 receipt 身份和 group 消耗一次性票据；在调用前同步消耗，保留跨重挂载的消耗/退役状态。旧确认、旧取消、receipt A→B→A、验证/渠道 ABA 均不能消耗新票据；晚到结果不能更新新 UI。释放只改异常阻断，不能清计时冷却或声称补充额度。它是 UI 策略，不是假造服务端票据。

测试只需两个聚焦组：来源/显示/未知/GCLI；真实 Core+适配器+合成 transport 的确认、取消、重复、ABA、重挂载及忽略 abort 的晚到行为。不能 mock 所有权来“自证”。

## 冻结、并行与停止条件

1. Mac 收到快照后，对 JSON manifest 的仓库相对路径运行 `shasum -a 256 <path>`，核对真实文件字节；四个允许文件仍应不存在。换行转换造成差异也先协调重新冻结，不能默默忽略。
2. 先读 AGENTS、维护范围、完整恢复需求与小型公开契约。JSON 中“源接口已存在”和“新组件接口约定”有明确区别；组件开发不能借机更改依赖。
3. 两个 Mac 包写入互不重叠，可在新的本机授权和限制内并行。Windows 页面激活/维护 API/独立 Files、Email、Import 与它们没有必然写冲突。
4. 但 Windows 的 `ResultView.tsx` 结构化回执更新，以及 `model.ts`、`advancedApi.ts`、Core/session/client、共享 UI/测试配置改动，会改变 Mac 只读基线。它们必须等待，或停止受影响包并重新冻结。不能删除真实上下文来伪造并行。
5. 真正的父集成等 Mac 源码与测试交付、实际 exports 验收后，由 Windows 只做一次 Detail、一次 Page 聚合。基础 GCLI 凭证页支持声明不等待这些可选功能，更不意味着64项全恢复。
6. 如已存在目标文件、依赖改变、需改父/API/共享文件、契约含糊或发现范围外缺陷：停止受影响包并提供具体证据。模型失败按 Mac 新授权限制处理，不重放已消费请求、不恢复临时输出、不隐式启动审核。

## 最小验收与回传

遵守当前 `frontend/package.json` 的 Node 版本范围和现有 lockfile，不顺带升级依赖。安装依赖若有需要由 Mac 协调者正常准备；外部作者只写允许文件。

协调者在 `frontend` 目录运行：

```sh
npm run typecheck
npm test -- --maxWorkers=2 src/pages/credentials/LegacyModelQuota.test.tsx src/pages/credentials/ResultView.test.tsx
npm test -- --maxWorkers=2 src/pages/credentials/AgQuotaEvidence.test.tsx src/pages/credentials/advancedApi.test.ts
```

每个模块回传：仅允许文件的 patch/文件集、输出文件 SHA256、实际导出接口、已运行命令和退出状态、未完成事项。作者普通交付 JSON 仅 `summary/changed_files/verification_notes`；明确“文件已写、命令未运行”，不带 ordered task 结果，不冒称验收通过。无需为了交接自行提交或推送。

Windows 应核对允许路径和上下文变化，再复跑上述相关检查后冻结父接线输入。模块通过仅证明组件层；真实页面、full64/P3、全套测试、build、check:build 和浏览器验收另记，不能用元数据代替功能恢复。

## 后续可选 Mac 模块

`CredentialBatchPanel.tsx/.test.tsx` 可作为后续独立 source+tests 包，复用已存在 controller 和真实 adapters，保留 max2、quota每块最多10、safe BatchReceipt、stop/dispose及不回滚声明。它读取 `credentials/api.ts`，故须等 Windows 维护 API 修复交付验收后再冻结，不能与 API writer 并行。共享父仍由 Windows 修改；不重复 executor，不依赖 raw manual.data/ResultView。

`AdvancedTools` 目前只是历史计划名，既不存在，也没有被冻结的必需接口。不要为了名称新增抽象：单文件 Preview 可由 Windows 后续直接接现有 Detail，批量 Preview 属于 BatchPanel。

## 排除项

合成后端工作已停止。本轮只完成公开源码阅读，未写入 `synthetic_ui_backend.py`、未启动任何服务；不得在 Mac 模块中恢复它。没有 frontend/source 修改，没有部署、私库/state/temp访问或新模型调用。

