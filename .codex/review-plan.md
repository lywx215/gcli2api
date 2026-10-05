# 本次任务：Unicode 流式解析与取消后清理融合

用户要求在现有本地 master 上融合两项旧草稿修复，不提交、不推送，并请实际 Claude 审核。基线 d9b65ba。仅移植两项确认缺失的行为，保留当前路由、Opus、额度与防截断改善。

1. SSE 行边界只按 LF 分割；序列化时转义 U+0085、U+2028、U+2029，候选身份层输出使用 JSON ASCII 转义，防止后续旧消费者 splitlines 破坏字符串。保持解码后的正文、签名、工具参数语义。
2. 公共身份响应与共享流式响应的异步资源关闭使用 AnyIO shield；Antigravity 同时关闭源和 GenerationBudget，保持一次关闭和取消不记录逻辑结果。
3. 增加真实生产函数链路的 UTF-8 单字节/整块解析测试，以及响应头取消作用域下源与预算恰好关闭一次的测试，涵盖预保护和未预保护路径。
4. 隔离运行针对性与完整 pytest；随后共享 Hook 调用实际 Claude 审查未提交文件。审核发现修复后复测复审。记录实际结果与快照，正式 Hook 批准状态不手工修改。

边界：Antigravity 与必要共享基础设施；不恢复 Gemini CLI 专属维护或取消的 MGMT，不修改管理 schema/capability，不涉及生产数据、面板版本、部署、Git 提交或远程推送。manager 无配套动作。

实际 Claude 第1轮指出下游重序列化与公共输出重新引入 Unicode 分隔符。已核实并补齐：Antigravity 预算、Completion 与逻辑统计的 SSE 解析统一使用 LF；公共身份流式输出也转义三种分隔符。Antigravity 数据事件检测同步 LF。增加真实 Gemini unwrap→预算 observe→公共输出测试，扩展 Completion 终止分离与不保护流式统计测试，并验证三种公共协议的正文/签名/工具参数无损。无 CLI 专属修改。复测后进行第2轮实际代码审核。
