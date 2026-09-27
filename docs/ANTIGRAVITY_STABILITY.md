# Antigravity 稳定性修复

更新日期：2026-09-22。四项修复均已实现；本轮仅涉及 Antigravity 及必要共享设施。
Gemini CLI 专属维护与 MGMT 后续开发保持停止。
数据库 schema、Management capability、panel-version.txt 均不变，manager 无需动作。

## 上传结果真实性

只有存储层确认成功才计入 uploaded_count。全部失败 HTTP 400、部分成功 HTTP 200；
文件上传保留 uploaded_count / total_count / results / message，增加 failed_count，
失败项增加稳定的 error_code。全部失败保留字符串 detail 并返回完整 results。

```json
{
  "uploaded_count": 0,
  "total_count": 1,
  "failed_count": 1,
  "results": [{
    "filename": "sample.json",
    "status": "error",
    "error_code": "credential_store_failed",
    "message": "凭证存储失败，请稍后重试"
  }],
  "message": "批量上传完成: 成功 0/1 个 antigravity 文件",
  "detail": "没有 antigravity 文件上传成功"
}
```

Refresh token 单个/批量导入使用同一存储检查。凭证已保存、附加信息更新失败时，
仍计为成功并返回 warnings，其中 code=credential_metadata_update_failed。
失败项不回传底层异常或 token；Antigravity 批量结果的 refresh_token_preview 固定为 [redacted]。

## 生成请求超时

以下环境变量单位为秒，必须是正有限数；每个生成请求读取一次，不新增面板控件。

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| ANTIGRAVITY_TIMEOUT_CONNECT | 15 | 连接/连接池等待 |
| ANTIGRAVITY_TIMEOUT_WRITE | 30 | 请求写入 |
| ANTIGRAVITY_TIMEOUT_HEADERS | 60 | 请求体写出后完整响应头等待 |
| ANTIGRAVITY_TIMEOUT_FIRST | 180 | 首个有效内容预算，含选凭证、刷新、退避和全部重试 |
| ANTIGRAVITY_TIMEOUT_IDLE | 120 | 有效内容空闲时间 |
| ANTIGRAVITY_TIMEOUT_TOTAL | 300 | 非流式/流转非流式/假流式总时间，含重试 |

真流和抗截断续接共用单调时钟预算；持续输出有效内容时无总时长上限。
文本、思考、工具调用和媒体是有效进展，心跳、空行、纯元数据不会刷新期限。
流转非流同时受 FIRST/IDLE 和 TOTAL 约束；原生非流式只采用总时间和 HTTP 阶段限制。
预算耗尽在响应提交前为 HTTP 504，提交后为 Gemini/OpenAI/Anthropic 对应错误事件。
2026-09-27 融合后，受保护模型路由沿用固定英文错误：OpenAI 错误 code 为整数 504，
并以一个 [DONE] 终止错误流；Claude 使用 event: error；Gemini 不添加 [DONE]。
该 OpenAI 终止帧不代表成功，不重放已经输出的内容。已收到 HTTP 错误后再次遇到
单次传输异常时保留原 HTTP 错误优先级；整个共享预算耗尽则按 504 处理。
取消清理上游流和凭证预取任务，
逻辑请求最多计数一次，客户端断开继续沿用不计最终结果的规则。
其他 provider 的 HTTP 默认行为不变。

## 冷却结算

按凭证、现有额度组和 Pro/Flash/Other 分项去重。High/Low 在同轮冷却只结算一次。
延长共享冷却时同步延长组内已有具体键，防止分项提前过期造成二次结算；
整个额度组过期后进入新轮时，仅移除该组旧键。过期更新不缩短有效冷却。
历史组级键保守保持快照，直到过期或显式清除。不扩大额度组、不重算旧统计。

SQLite 使用 BEGIN IMMEDIATE；PostgreSQL 使用事务和 FOR UPDATE 行锁。
MySQL/MongoDB 当前没有这套轮次结算能力，本轮不新增能力。

## 批量导入限制

以下环境变量必须是正整数。请求/写入并发门控按每个服务进程配置，调整并发值后重启进程。
大小单位均为字节。

| 环境变量 | 默认值 |
|---|---:|
| ANTIGRAVITY_IMPORT_REQUEST_BYTES | 33554432（32 MiB，包含 multipart 开销） |
| ANTIGRAVITY_IMPORT_FILES | 100 |
| ANTIGRAVITY_IMPORT_ZIP_ENTRIES | 1000（整个请求全部 ZIP 条目，包含目录及非 JSON） |
| ANTIGRAVITY_IMPORT_JSON_BYTES | 1048576（1 MiB，单 JSON 解压后） |
| ANTIGRAVITY_IMPORT_EXPANDED_BYTES | 67108864（64 MiB，全部 JSON 解压后累计） |
| ANTIGRAVITY_IMPORT_REQUESTS | 2 |
| ANTIGRAVITY_IMPORT_WRITES | 1 |

/creds/upload?mode=antigravity 在 multipart 解析前检查实际请求字节数，缺少或伪造
Content-Length 也会计数。请求体和校验后的 JSON 使用临时文件，内存阈值各为 1 MiB。
ZIP 中央目录先按实际记录计数，再创建条目对象；解压同时检查元信息和实际读取字节。
普通 ZIP（含 ZIP64 本地文件头）受支持；ZIP64 扩展中央目录、分卷、加密或不支持的压缩
格式按对应文件/条目报告错误，不递归解压内嵌 ZIP。

超限 HTTP 413，整批未写入；坏 JSON、编码错误、非对象 JSON、不支持条目均逐项报告。
同批同名文件保留首项，后续项报 duplicate_filename；已有数据库同名凭证沿用更新语义。
所有文件校验完成后才开始存储；存储阶段不是整批事务，部分失败保留已成功项。
并发请求共用门控，文件导入和 token 导入共用写入门控；SQLite 默认串行写入，其他后端
保守沿用同一限制。取消校验先等待有界后台工作结束再清理文件，不进入存储阶段。

## 验证与回滚

新增测试：test_antigravity_import.py、test_antigravity_timeouts.py、
test_antigravity_cycle_settlement.py、test_antigravity_import_limits.py。
覆盖临时 SQLite 并发结算、三种协议的真流/假流/抗截断超时、长流、防重放、取消、
真实本地 HTTP 慢响应头、上传限额、伪造 ZIP 信息、批量结果与敏感错误屏蔽。
PostgreSQL 验证使用事务调用模拟，没有连接真实 PostgreSQL 或调用真实模型。
来源分支历史验证执行 `python -m pytest -q --tb=short`：405 项通过，6 条现有依赖弃用警告；
包含管理协议、Legacy、模型转换及面板回归。`git diff --check` 通过。

2026-09-27 的 dev0927 融合验证与冲突取舍见
[融合交付记录](../review/ANTIGRAVITY_STABILITY_INTEGRATION.md)；以上来源分支历史结果
不替代融合后回归，也不代表本次代码经过新的 Claude 审核。

按上传、超时、冷却、导入限制拆分提交；回滚通过撤回对应代码，存在依赖时按逆序撤回，
不覆盖运行数据、不进行历史统计重算。性能优化及终身统计仍后置。


2026-09-22 本地 SQLite 联调追加：真实 HTTP 服务 25 项检查通过。发现超大分块上传
提前返回 413 后可能污染 HTTP/1 长连接，已改为有界丢弃在途数据（最多 4 MiB / 1 秒）
并关闭该连接，避免后续请求卡住；HTTP/2 不发送 Connection 头。
补充真实 Hypercorn 网络回归：同一客户端超限上传后继续请求正常返回。
测试使用独立临时 SQLite 和本地模拟上游；结束后清理模拟凭证/故障触发器，恢复默认配置。
