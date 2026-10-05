# Unicode 流式解析与取消后的资源清理

2026-10-05，在本地 master（基线 d9b65ba）选择性融合 codex/model-routing-stream 的两项修复；保留现有已合并改善。未提交、未推送。

SSE 使用 LF 行边界并转义 Unicode 分隔符，防止旧 splitlines 消费者拆开合法 JSON 字符串；JSON 解码后的正文和元数据保持一致。取消响应头发送时，AnyIO shield 保护异步源关闭和 Antigravity 预算释放；清理恰好一次且取消不记录成功统计。

增加完整 SSE→退役检查→候选身份→Completion 链路与响应头取消回归测试。验证结果与实际 Claude 审核记录如下。

管理 schema/capability 不变，兼容影响为共享流式解析与关闭修正；manager: no_counterpart_action。未修改面板版本、生产凭证或数据库，未部署。Gemini CLI 专属维护和已取消 MGMT 工作未恢复。

## 验证证据

Python 3.12.14：针对性测试 291 passed、9 deselected；完整隔离 pytest 2816 passed、1 skipped、6 warnings（114.12 秒）。新增 17 个回归用例通过。9 个单独运行依赖前序存储初始化的旧路由超时用例已在完整测试全部通过；未修改这些范围外测试。Windows 跳过 POSIX fork 用例，保留基线弃用警告。未执行 Python 3.13 或真实外部集成。

使用现有 scripts/run_diagnostic_tests.py，将凭证目录、日志和数据库状态放在临时目录；附加临时启动隔离禁用 dotenv，并阻止 Python 非本机 TCP/DNS。测试使用合成内容、模拟上游和实际生产转换/清理函数，不访问生产数据或模型 API。原前端 Node 测试此次未重复运行，未修改前端。

- targeted.txt：针对性测试输出。
- pytest.txt：完整隔离测试输出。
- claude-review.json：共享用户级 Hook 调用实际 Claude 的结果及文件快照；正式 Hook 批准状态不手工更新。

本次修复选择性移植，未整分支合并旧路由草稿。Git master HEAD 与 origin/master 保持 d9b65ba，全部修改留在工作区。

## Claude 首轮意见处理

首轮实际 Claude 提出两项遗漏（完整结果见 claude-review-round1.json）：下游重新序列化使预算/统计/Completion 的 splitlines 再次拆分 JSON；公共身份输出也重新引入原始分隔符。已补齐 Antigravity 与必要共享层的 LF 解析及公共输出转义，增加真实 Gemini 包装展开→预算进度→公共输出、Completion 终止拆分/用量合并、不保护流式统计和三协议载荷保留测试。未修改 Gemini CLI 专属源码。首轮测试保存在 *-round1.txt，最终验证为上述 2816 passed。

最终实际 Claude 复审结论见 claude-review.json；审核文件前后摘要用于验证审核期间快照稳定。
