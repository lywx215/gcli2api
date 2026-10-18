# Import 已交付后的最小修正

日期：2026-10-15。项目目标：`docs/ui-redesign/gap-repair/import-feedback-minimal-correction.brief.md`。本准备仅写产物文档；不改前端，不运行 CLI、命令或测试。

精确写集仅 api.ts、workflowRunner.ts、ImportFilePicker.tsx、index.tsx（四者均位于 frontend/src/pages/import）；两任务依次执行，单 attempt，900 秒。原七文件已实际交付，不重复开发。

## 确定问题

- api.ts:199–200：projectSafeOAuthCompletion 的 return 对象后遗漏函数闭合括号；主窗实际 npm run typecheck 已以 TS1005 失败（R/TYPECHECK_AFTER_IMPORT.log）；本准备未重跑。
- workflowRunner.ts:32：ImportItemFailureReason 新导入仅出现一次且未使用，当前 tsconfig noUnusedLocals=true；解析修复后仍有类型检查风险。仅移除此 unused import。
- api.ts:584、607–632：能力响应有上传形状时，interceptedUploadRaw 被直接 normalizeResult 并返回，跳过真实 POST；能从能力接口产生导入成功/confirmedFilenames。此分支必须完全删除。capability/ticket/poll 不得成为上传结果来源，不为旧 mock 改生产语义。
- api.ts:581 起：无 onProgress 的旧调用也先发现能力、建票和轮询，违反原普通调用保持单 POST 的兼容约束；仅有回调时启用观察，生产runner已有回调。
- api.ts:724–747、801–833：期限只在两次 GET 之间检查，悬挂 GET 可越过900秒；零剩余TTL在发布 available=true 后直接退出；每轮 setTimeout 完成不移除 abort listener。需独立可取消的硬期限及逐轮清理。
- api.ts:804–810、838、850：poll 401/403会拒绝，但catch仅在上传结束后附加；慢上传期间可能产生unhandled rejection。立即管理观察promise，使用shared client真实鉴权/失效语义，不盲目普通fallback或重传。
- api.ts:601–605：capability时间字段只检查number/正数，Infinity可进入setTimeout造成溢出和过快poll；固定合同500ms，时间字段必须有限安全整数且符合合同，畸形能力不可视为supported。
- api.ts:749–784：received只检查typeof及非负，再floor；NaN/Infinity/小数和未知phase未按合同拒绝。progress字段按白名单严格验证；非法观察不能假装available。
- ImportFilePicker.tsx:400–407：processing硬编码100%；finished包括错误响应而当前文案暗示传输成功，interrupted不可判定上传失败。只改该展示分支为实算比例及观察状态。

- index.tsx:65、769、874–882：上传中离页再回，method重置为oauth且busy禁用方式切换，唯一进度区域被method===files隐藏。仅修页面展示：根据当前有效flow.operation/owner恢复文件面板或独立显示只读进度。保留disabled、actor、owner/validation/current guards，不放开busy按钮、不恢复已清理File草稿、不重发upload、不清空或取消存活runner；失效owner旧进度不得显示。

## 保留边界

已交付R06的types→API白名单→safeFreeze→固定摘要链已存在；L06选择与拖放共用筛选、通用appendAndDeduplicateFiles保持通用且三元组去重。这些不重写。runner校验owner/validation/generation并仅公开冻结数字/枚举，hooks页面卸载只撤销actor，跨页runner可继续；不得为修轮询而取消页面卸载时的任务。

共享api/client.ts只读，沿用同源服务根、redirect:error、面板鉴权与业务401/403精确区分。ticket只在当前操作私有内存，不进入公共快照/持久化/日志。原upload响应决定成功、partial、failed、unknown及导出许可；观察失败只影响进度，上传开始后不重传。后端合同固定SHA-256为56e149612474d410384163083ea48fe6a27a3a0512a3919d18e5d169b7d4ff17。

定点源码搜索发现新增的危险成功来源为上述interceptedUploadRaw。未见 import.meta.env.TEST 或 mock 鉴权豁免；已有 DEV+VITE_UI_FIXTURES 分支继续受原预览边界约束，不扩大。旧mock不表达新capability请求时报告测试限制，不加入生产fallback-shape成功路径。

主窗完成新brief/context绑定及与B2的写集冲突检查后派发。CLI不执行任何命令/测试/构建；主窗交付后执行typecheck和必要验收。准确返回两个task_results，不声称验证通过。

本次请求已将 index.tsx 从只读 context_files 移入 allowed_files，避免同请求write/read重叠；仍为两个有序任务、单attempt900秒。修正完成后，进行中文件上传跨页返回即可看到当前owner的进度，不依赖点击被禁用的方式按钮。主窗完成绑定后本请求保持稳定。
