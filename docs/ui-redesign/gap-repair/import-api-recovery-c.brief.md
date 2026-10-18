# Import API 单文件恢复 C

日期：2026-10-15。项目目标：`docs/ui-redesign/gap-repair/import-api-recovery-c.brief.md`。本文件与相邻请求是新范围分配，不是失败四文件请求的重放。写集仅 `frontend/src/pages/import/api.ts`；两个有序任务、单attempt、900秒。主窗完成新绑定后决定是否派发；本准备不启动CLI、不改源码、不运行测试。

## 已确认状态与幂等边界

失败的 gapfix-import-minimal-20261015-b 为 transient_error，last_status ERROR、foreground_error_marker UNAVAILABLE，615.059秒，CLI进程exit0但structured_output_is_dict=false，0文件应用。66次view_file/7次replace记录不等于真实交付；不恢复其private临时文件。不是登录失败，不要求登录。B2已delivered，共享batch69403结束。

当前api.ts哈希仍为 `204dc2e7273175e51e42d374f0152a83a3cbfa0068bc865e36a4f47ee08f1d60`，为真实工作树基线。只对仍存在的缺陷修正，若主窗新绑定时发现他人已修复某项，不叠加重复分支/控制器，而是核对满足同一验收；范围或签名变化由主窗重新协调。当前三UI文件不在本包写集，不能借机完成后置UI修正。

## 两任务的确定目标

1. 先补projectSafeOAuthCompletion在return对象后遗漏的函数闭合，保留classifyFailureReason模块顶层。删除interceptedUploadRaw及capability内容像上传结果就直接normalizeResult返回的整个旁路。只有本次真实POST creds/upload响应可产生结果、confirmedFilenames和导出许可。无onProgress的旧调用保持单POST；有回调的生产链继续真实观察。
2. 同一文件完整实现安全观察：固定v1合同路径/字段，500ms串行且一个in-flight，有限safeinteger验证，自ticket创建开始不超过900秒且可abort悬挂GET的硬期限，剩余TTL只收紧；逐轮/终态监听清理；promise创建立即处理拒绝。ticket仅私有内存。API所有进度投影为真实数字/枚举/布尔，不拿phase生成百分比或结果。

能力发现GET `creds/upload-progress/capabilities`，建票POST `creds/upload-progress?mode` 无body，上传POST `creds/upload?mode&progress_id` 保留FormData，读取GET `creds/upload-progress/<ID>?mode`。capability为panel.credentials.upload_progress.v1，ttl_seconds=900，poll_interval_ms=500。固定合同SHA-256：`56e149612474d410384163083ea48fe6a27a3a0512a3919d18e5d169b7d4ff17`，以只读合同为精确字段依据。

旧服务器404/405、unsupported/capacity只能在上传前且scope/signal有效时降级普通上传。明确面板鉴权失败、session/scope失效、abort不得blindfallback；业务401/403保留shared client精确区别。上传一旦开始，poll/TTL/opt-in错误均不能重传或判断服务器回滚。全部走只读shared requestJson的同源服务根、redirect:error、认证及取消保护。

保留已有R06受控reason/normalizeResult、OAuth、RT和邮箱API。禁止为旧mock加入生产模拟成功、TEST或认证豁免；旧mock限制由主窗按实际最少检查处理。精简context不包含旧测试大文件，CLI不执行命令/测试/构建。

两个task_results必须与tasks顺序和id完全一致且含status/notes；仅全部completed方可Hook交付，不弱化检查。API真正交付、主窗检查后，后置UI包才能重新绑定并执行；本包通过不等于整个Import已完成。
