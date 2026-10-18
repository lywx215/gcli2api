# Import Critical D：单文件关键上传链

日期：2026-10-15。项目复制目标：`docs/ui-redesign/gap-repair/import-critical-d.brief.md`。写集仅frontend/src/pages/import/api.ts；**单有序任务、540秒、max_attempts=1**。新模板仅候选，不启动CLI、不改源码、不执行测试。

## 失败事实与新基线

API C以“Ordered task package incomplete/outoforder”终结，0文件应用。本次不是UNAVAILABLE。主窗只读发现共享Hook生成schema把task_results设为可选，而交付要求完整有序结果；这只是已知schema/交付要求不一致，**尚不能断言C具体为何缺失或乱序**。强化必填与安全拒绝原因诊断仍为其他agent准备的候选，尚未安装；本文件不改变、不绕过旧检查。保留旧C失败，不重放、不恢复private临时代码。

actual api.ts哈希仍为`204dc2e7273175e51e42d374f0152a83a3cbfa0068bc865e36a4f47ee08f1d60`。主窗派发前重读新绑定；有并发变化则重审，不套旧请求。

## D仅修四项

1. 补projectSafeOAuthCompletion在return对象后、classifyFailureReason导出前丢失的函数闭合。
2. 删除interceptedUploadRaw和capability返回results/uploaded_count/success_count/status=success形状就normalizeResult返回的整个成功旁路。只有本次真实POST响应可生成ImportResult、confirmedFilenames及导出许可。
3. 无onProgress调用保持原单POST，不发现能力/建票/轮询；有回调的现观察接口继续保留。
4. 精确沿shared requestJson的panel-auth/session/scope/abort保护，失效或取消不blindfallback；业务401/403不自行注销。只有尚未上传、绑定仍有效的非鉴权能力不可用可普通上传，已发upload不重传。

保留既有poll、TTL/字段处理及全部其余代码，后置E负责完整观察与UI；D不得扩为整段观察重写。禁止旧mock成功/TEST/认证豁免，DEV+VITE_UI_FIXTURES原边界不扩大，R06/OAuth/RT/邮箱保留。共享client只读。

## 输出与交付

严格遵循共享Hook实际输出schema，必须返回结构化JSON对象及恰一项task_results，id为repair_critical_upload_path_only，含status/notes；仅完整完成才completed。schema可选不代表可省略，现有ordered检查不弱化。CLI不运行命令/测试/构建；主窗做最少检查。runner unused import仍由E处理，D交付不能宣称整体类型检查或R05完成。

D实际交付后，E重新读取新api.ts哈希并绑定，不能拿旧C副本接续，也不重复D已完成目标。全部未完成目标映射如下：

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
