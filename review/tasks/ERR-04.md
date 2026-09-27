# ERR-04：六路由、转换器、抗截断和统计集成

最终状态：done。ERR-05 集中回归 1143 passed、1 skipped；2026-09-27 最终第 3 轮 Claude 代码复审 findings=[]。下文较早的复审等待描述为历史记录，最新证据见 ERR-05 与最终审核实录。

已完成的开发接线：

- Gemini CLI 与 Antigravity 的 OpenAI、Claude、Gemini 六个生成路由使用受保护 `APIRoute`，并显式传递 `events=True`。
- 非流式和假流式在转换前识别 HTTP-200 `error` envelope 与模型退役通知；不把上游正文或模型名交给固定错误渲染器。
- 事件模式每个 upstream attempt 新建退役识别状态；确认退役或缓冲超限时终止为类型化错误。
- 首包读取异常、真正空流、首包后的流异常和响应资源关闭进入统一边界；默认未接入路由仍保持旧行为。
- 抗截断与 Claude 流转换不再把异常文本拼入客户端错误事件；`finishReason` 结束时关闭输入迭代器。
- 真实 Request 的非流式和假流式底层均 `record_logical=False`；非流式由路由完成器、流式由 tracked iterator 记录一次。直接调用无 Request 的兼容路径保留旧调用约定。

以下本地集中验证已纳入 ERR-05 的 1059 passed/1 skipped；修复后 Claude 复审仍待明确授权：

- 2×3×4 隔离矩阵、首包提交前/后的状态与协议终止帧；
- HTTP-200 错误、退役通知、任意 sentinel/模型名不泄露；
- 重试次数、正文后不重放、统计恰好一次、取消与 `aclose`；
- Legacy、Vertex、面板、管理协议、诊断回归；
- 本组方案审核通过，代码审核返回 9 项，已由 Codex 修复和本地验证；本组 3 次审核额度耗尽，修复后尚未 Claude 复审。

本任务不提交、不推送、不部署，也不修改凭证、数据库、Volume 或 `panel-version.txt`。
