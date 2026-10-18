# Import UI 三文件恢复 C

日期：2026-10-15。项目目标：`docs/ui-redesign/gap-repair/import-ui-recovery-c.brief.md`。写集仅 `workflowRunner.ts`、`ImportFilePicker.tsx`、`index.tsx`（均在frontend/src/pages/import）。两个有序任务、单attempt、600秒。**必须等API单文件恢复真实交付并经主窗检查，重新读取/绑定api.ts后才能派发。** 当前ready=false，不与API并发、不复用旧API绑定。

旧四文件请求transient_error/UNAVAILABLE、0文件应用；不重放，不恢复private临时副本。本准备只创建文档，不启动CLI、不改源码、不运行测试。

## 两任务与范围

1. runner仅删除未使用ImportItemFailureReason导入（当前noUnusedLocals=true），以及新API若确有需要的最小接线兼容；保留owner/validation/generation守卫、R06 safeFreeze受控reason及字节快照最少字段。Picker仅修progress文案：processing用实际percentage而非硬编码100%；未知总量只展示字节/未知；finished只表示HTTP观察结束（含413/422），interrupted只表示观察中断，不能判定导入成败。保留L06双入口共享filter、通用append函数/元组去重和旧计数progress。
2. index修上传跨页返回：method默认oauth且busy禁用切换，进度仅files面板显示。用当前有效flow.operation/owner恢复显示，或独立只读进度区域；不依赖禁用按钮，不解除disabled、不绕过actor/owner/validation/current守卫、不恢复File草稿、不重发upload、不取消存活runner。失效owner不显示旧进度，结束后正常方式切换可用。

api.ts作为本包只读context，必须是新的已交付版本；不改api/hooks/types/components/shared client。ticket/token/File/FormData/raw错误不得进入public snapshot/存储，页面卸载只撤销actor，runner在owner有效时继续。保留OAuth/RT/邮箱任务、逐次导出确认、取消/终态清理及原R05/R06/L06所有目标。

当前未改UI基线：

- workflowRunner.ts：`9c514626d5f37bfa2b9f32236849e7da0fdb54aca04bbd21dc4bc9535df97b60`。
- ImportFilePicker.tsx：`2877069c06e383f30fbdc8820e65d48739d71a5aa01a038ae573a96153b18422`。
- index.tsx：`0e30112e8a4f130ea49e2180067380d5487dd479efca05491aa068e95678bfd0`。

派发前主窗复核新API与三UI文件哈希/依赖闭包，创建新请求标识；不重放旧请求。幂等边界是已满足目标就保留，不重复添加效果/订阅/进度区域；存在范围变化由主窗重审。两个task_results须严格对应任务顺序/id并含status/notes，全部completed才可交付；不能用部分完成跳过ordered检查。CLI禁命令/测试/构建，主窗进行最少必要验收。
