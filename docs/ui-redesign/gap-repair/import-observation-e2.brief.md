# Import E2：初始化到期边界及两句观察文案

日期：2026-10-15。项目目标：`docs/ui-redesign/gap-repair/import-observation-e2.brief.md`。只写api.ts与ImportFilePicker.tsx；单有序任务id=fix_observation_initialization_edge_and_copy、900秒、max_attempts=1。状态ready_pending_fresh_hash_and_zero_conflict_binding，不自动派发。

## 已知精确编辑位置

无需逐个读所有只读依赖。先定位下面函数anchors与文本；context保留完整实际生产闭包，用于需要时确认接口，不是遍历检查清单。禁止重写整段uploadFiles。

1. **api初始化顺序**：当前831–866的stopObservation、881–897的setupDeadlineTo，以及899–905的forwardAbort赋值/注册。setup在remaining<=0可同步stop，此后原代码仍注册listener，而幂等early return无法再清。将必要注册放在任何可能同步stop之前，并在已停/已abort时禁止新增资源；保留现有清理内容。
2. **api发出前guard**：当前812的uploadTicketId捕获与1111–1119的唯一真实POST。ticketResTime初检之后，emitProgress回调或FormData构建可跨期限。就在POST实际发出前以相同单调时钟重查deadline与owner/scope/signal：观察已到期而业务仍有效、且从未发送upload时，只发唯一不带progress_id的普通POST；失效则取消，未到期仍原关联POST。不得在已发请求之后fallback重传，不能让清理破坏决定好的query。
3. **Picker两个字符串**：finished“传输完成，等待处理”改“进度观察已结束，等待上传结果”；interrupted“传输中断”改“进度观察已中断，上传结果仍待确认”。available=false“进度不可用”保持；其余数字、条件、事件、样式、ARIA、业务/导出语义全部不变。

## 已交付基线与保留边界

actual E1 api.ts SHA-256：`ed9021937a0effbe89cb9c16432e8b596de31dc5bfda86d3d124c9ee127a342e`。Picker SHA-256：`cc84d04646d3831688422baa0cdb0fd30f164794c594bcca42c0b6074ec9153f`。E1只读检查已确认原三处正常生命周期修复闭合，唯一本初始化edge仍阻塞；runner/Picker/index哈希仍为E交付版本。

D/E/E1真实POST唯一结果、无回调旧单POST、auth/scope/abort、不重传、严格Record投影、单调<=900秒、500ms串行、统一观察清理、owner代次、R06/L06和页面接线都保留，不重做。原Picker文案请求尚未派发，合入本新任务，不另行重放。

当前batch69588已partial退出，H CLI ERROR且0交付，无在途writer；不恢复任何旧private副本。主窗仍要重新读取actual source/import闭包和哈希。与Files I仅在完整write/write及write/context零冲突时并行；readonly caller/导出链全部保留，不为并行删依赖。

最终按Hook实际schema返回完整结构化对象，task_results恰一项exact id=fix_observation_initialization_edge_and_copy，含status/notes；仅全部真实完成才completed，strict ordered检查不变。CLI不运行命令/测试/构建/真实接口；主窗完成差异与最少验证。本任务不创建额外需求或重构。
