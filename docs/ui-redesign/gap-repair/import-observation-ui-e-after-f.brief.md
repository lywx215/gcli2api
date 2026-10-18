# Import Observation/UI E：D交付后四文件剩余修正

日期：2026-10-15。项目复制目标：`docs/ui-redesign/gap-repair/import-observation-ui-e-after-f.brief.md`。写集仅api.ts、workflowRunner.ts、ImportFilePicker.tsx、index.tsx（frontend/src/pages/import）；**两有序任务、900秒、max_attempts=1**。状态：ready=true、status=ready_pending_fresh_binding；D前提已满足，但主窗哈希/依赖冲突检查仍待实际绑定，本模板不自动启动。

## 硬依赖与幂等边界

D已真实DELIVERED（session81141退出0、唯一task_results completed），四critical只读检查无blocking。actual D api.ts SHA-256为`e137bc7047d6c5c9d6da65f51d3f36d360e69210a6c59860a51c49ae62952f28`。E按此新基准准备；主窗派发前仍须重读actual source及四文件/所有context并检查哈希与依赖冲突，变化则重审。C旧API或失败私有临时代码不得恢复。D四项关键修复属于已完成前提，E只保留和核对，不再重复插入闭合/普通上传分支或第二套结果控制。当前三UI文件未改，仍分别为runner `9c514626d5f37bfa2b9f32236849e7da0fdb54aca04bbd21dc4bc9535df97b60`、Picker `2877069c06e383f30fbdc8820e65d48739d71a5aa01a038ae573a96153b18422`、index `0e30112e8a4f130ea49e2180067380d5487dd479efca05491aa068e95678bfd0`；主窗派发前重新读取全部源/context闭包。

## 两任务

1. 先修实际类型诊断api.ts:753 TS7022（pollRes推断循环导致隐式any）：用Record<string, unknown>明确接收值类型，或unknown加逐字段运行时收窄；不得any、不安全强转、@ts-ignore/ts-nocheck或放宽tsconfig。随后API观察完整性：沿已固定panel.credentials.upload_progress.v1合同与现requestJson，严格验证能力/Progress字段和有限safeinteger；固定500ms串行、一个in-flight；从ticket创建起不超过900秒的独立硬期限能abort悬挂GET，剩余TTL只收紧；promise创建立即处理拒绝，逐轮/终态清理timer/listener/controller。真实received/total才算比例，未知/null/0不造百分比；ticket仅私有内存。auth/scope/abort沿D/共享client，不因观察失败重发上传或得出导入结果。
2. runner仅移除unused ImportItemFailureReason并做必要接线，保留safeFreeze/owner/validation/generation和数字快照。Picker以实际percentage展示processing、准确区分finished/interrupted观察语义，保留L06入口filter/通用append及旧计数。index用当前有效operation/owner恢复跨页进行中文件进度展示，保留disabled/actor/current guards，不恢复File、不重发、不取消存活runner。

合同项目路径docs/ui-redesign/gap-repair/UPLOAD_PROGRESS_CONTRACT_20261015.md，SHA-256为`56e149612474d410384163083ea48fe6a27a3a0512a3919d18e5d169b7d4ff17`。旧C和UI的全部未完成目标保持：

| 旧C/UI未完成目标 | 新包归属 | 保留边界 |
| --- | --- | --- |
| projectSafeOAuthCompletion闭合/顶层分类器 | D唯一任务 | E只保留，不重做 |
| 删除capability伪上传结果、真实POST唯一结果与导出权威 | D唯一任务 | E不得回退或新造成功旁路 |
| 无onProgress旧调用单POST | D唯一任务 | E观察仍为可选，不增加旧调用网络动作 |
| 精确auth/abort/scope不blindfallback | D关键上传分支；E观测各请求接续相同边界 | shared client只读，业务401/403不误判登录失效 |
| 固定500ms、严格字段projection、900秒硬TTL、promise/监听清理 | E任务1 | 基于actual D API，上传不重传，ticket不公开 |
| runner unused import/安全字节投影与owner守卫 | E任务2 | R06三原因safeFreeze及现有清理保留 |
| Picker实际percentage及phase准确文案 | E任务2 | 旧计数progress不变，观察不判导入结果 |
| index跨页返回持续上传进度可见 | E任务2 | 保留disabled/actor/owner，不恢复File、不重发、不取消runner |
| R06链路/L06共享filter与通用append/OAuth/RT/邮箱/导出保护 | D/E共同保留项 | 不重新开发、不删减，主窗最终检查 |

## 输出与失败边界

C本次失败为Ordered task package incomplete/outoforder、0应用，不是先前B的UNAVAILABLE。主窗已确认Hook schema强化安装成功、strict predicate等检查不变；C具体结果缺陷仍未知，不能把推测写成原因。E严格遵循实际schema返回结构化JSON及两个完整task_results，顺序/id与tasks相同且含status/notes，只有都completed才能交付；不弱化检查、不恢复私有编辑、不重放消耗过请求。

context只保留必要生产接口/合同，不包含旧测试大文件；四allowed文件不再放context。CLI禁命令/测试/构建/真实API，主窗进行最少检查。D/E均通过交付与主窗检查后才能闭合Import目标。

## 实际类型检查分工

主窗已执行TYPECHECK_AFTER_CRITICAL_D.txt所记录的tsc --noEmit。本准备只读该日志，未重跑。Import内两项为api.ts:753 TS7022 pollRes隐式any（本包任务1）和workflowRunner.ts:32 TS6196未使用ImportItemFailureReason（既有任务2）。其余credentials/batch.ts:1131 updates枚举、CredentialDetail.tsx:419 readonly空updates和credentials/index.tsx:1302 manual publicDetails DTO可选性三项已由F兼容模块交付，待主窗最终类型确认，E不修改这三个文件，也不宣称完整typecheck已通过。

与G五任务模块并行必须经主窗实际source-import闭包及write/write、write/context检查；ready=true只表示D前提与范围已准备，不能跳过剩余root绑定门禁。四文件、两任务、900秒、max_attempts=1均保持；完整旧C观察目标没有删减。


## Actual compatibility prerequisite

F has now actually delivered API/batch/Detail and root inspected the four narrowly scoped changes. These files are readonly here; G only writes its remaining five-file Legacy/List/Files module. Root must prove zero intersections using the complete actual recursive dependency closure before joint dispatch. Post-F hashes: {"frontend/src/pages/credentials/api.ts": "bde675fe96a673199b6c8839113e636dd69e35927e174ddbd6fbd95e904efe70", "frontend/src/pages/credentials/batch.ts": "134458aec64a8d41c815ba13064556477e20d638f079bb6bdaa20d0f617f5e0d", "frontend/src/pages/credentials/CredentialDetail.tsx": "280cd485420e2b3050b728e9aab993eb2a75b67064a1a886b6ba507daca45c16"}
