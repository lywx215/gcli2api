# 新 UI 人工测试实际模型版本兼容

当前合并目标：`new-ui`，保留主窗口正在制作的全系统紧凑界面，不改变布局方案。

本次旧补丁已经包含 `front/common.js` 的旧面板兼容显示，Codex 仅合并现有补丁。
新的 React UI 目前没有对应字段投影和展示，须由官方 Antigravity CLI / gemini-3.8-flash-high 决定具体呈现并实现。

后端增量契约：人工生成测试结果（含批量结果项）携带
`capabilities: ["antigravity.test.model_version"]` 以及可空 `upstream_model_version`。
仅显示上游实际返回、格式合法的版本，不根据请求别名猜测。仅成功且 phase=generation 的结果展示。
合法版本匹配完整字符串 `(gemini|claude|gpt-oss)-[A-Za-z0-9._-]{1,120}`。
旧节点无 capability 时提示“当前节点未提供模型版本信息”；有 capability 但缺合法值时提示“上游未返回模型版本”。
失败结果不展示版本。不把版本写入日志、数据库，也不改变按钮动作、事件、请求、焦点和旧接口。

需要评估的当前文件：
- frontend/src/pages/credentials/api.ts：现有安全字段白名单 / 结果投影；
- frontend/src/lib/manual-result.ts（如实际存在；以仓库搜索结果为准）：结果解析；
- frontend/src/pages/credentials/ResultView.tsx：人工单项、批量结果共用显示。

Codex 不编写 React UI；拿到当前会话明确的反重力开发授权后，先冻结最新文件和文件归属，再派发最少文件包。
本说明只是待派发需求，不包含授权 ID，不启动任何 CLI、不复用其他窗口的授权。
验收仅必要类型检查、生产构建和合成字段兼容检查；页面样式由人工确认，不扩展详细视觉测试。
