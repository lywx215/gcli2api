# Import E1：观察期限与结束清理的局部修正

日期：2026-10-15。项目目标：`docs/ui-redesign/gap-repair/import-observation-e1.brief.md`。只写api.ts，单有序任务、900秒、max_attempts=1。其他三UI文件全部只读，不重做已交付4文件。状态ready_pending_fresh_hash_and_conflict_binding；root完成actual source-import闭包/哈希/冲突检查后决定派发。

E已实际交付，主窗确认npm typecheck退出0；本准备没有运行验证。实际API哈希为`828b2c1b67b2d1ab695c231e26cb915c860ef5e691b59a94111b702e21fd6e40`。

## 仅修已确证的三处

1. api.ts:783–784在ticket创建响应返回后才启动900秒窗口。若服务器创建后响应延迟，前端观察期限超过票据创建期限。发出建票前记录单调时间，并以同一时钟保持<=900秒硬上限；expires只收紧，不因迟到响应重置。到期ticket不能再用于尚未开始的关联upload；若当前绑定有效且尚未upload，安全执行唯一普通upload，不重复建票。
2. api.ts:793–795的期限回调只abort；挂起GET在942直接break，等待阶段在806退出，均不发布不可用，因此最后available=true会保留直到upload settle。超时对仍有效操作发布available=false/phase=interrupted的固定安全观察状态再停止；不增加公共reason类型、不说业务失败/成功/回滚，失效owner不能收到发布。
3. api.ts:891/903/938–970的terminal/invalid/expiry/failure只break，观察deadline与forwardAbort到upload settle才清理。用小范围幂等统一结束路径立即清理观察timer/listener/controller及私有ticket，覆盖terminal/failure/timeout/cancel/scope loss/upload settle；不要取消或重发真实上传。

保持现有500ms串行单in-flight、unknown Record严格投影、即时promise catch、D四critical、旧无callback单POST、auth/scope隔离及R06/L06/UI接线。上传一旦开始，只等待该POST真实响应作结果；观察终止无权授予结果或导出。其他UI文案不在本请求写集。

context基于实际E-after-F完整依赖闭包，保留只读三UI及真实导出链。主窗再做递归actual source闭包，不为与H并行删除必要依赖；若冲突，本短包先行。CLI不运行命令/测试/构建/真实接口，只交唯一完整task_results；strict ordered检查不变，不恢复private或重放旧请求。
