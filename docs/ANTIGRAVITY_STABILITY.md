# Antigravity 稳定性修复

范围：仅 Antigravity 及必要共享设施；Gemini CLI 和 MGMT 后续开发保持停止。
不变更数据库 schema 或管理 capability；manager 无需动作；不更新 panel-version.txt。

## 上传正确性（已修复）

只有存储层确认成功才计入 uploaded_count。全部失败 HTTP 400、部分成功 HTTP 200；
文件上传保留 uploaded_count / total_count / results / message，增加 failed_count，
失败项增加 error_code。全部失败保留字符串 detail 并返回完整 results。

示例：`{"uploaded_count":0,"total_count":1,"failed_count":1,"results":[{"filename":"sample.json","status":"error","error_code":"credential_store_failed","message":"凭证存储失败，请稍后重试"}],"detail":"没有 antigravity 文件上传成功"}`。

Refresh token 导入同样检查存储结果；附加信息更新失败返回 warnings，凭证仍计为成功。
Antigravity 错误不回传底层异常或 token；批量结果的 refresh_token_preview 固定为 [redacted]。

验证：test_antigravity_import.py 和 test_upload_tier_detection.py，10 项通过。

## 后续提交

## 分阶段超时（已修复）

环境变量以 ANTIGRAVITY_TIMEOUT_ 为前缀，单位秒，必须为正有限数：
CONNECT=15、WRITE=30、HEADERS=60、FIRST=180、IDLE=120、TOTAL=300。
每次请求读取配置；没有新增面板配置控件。其他 provider 的默认 HTTP 行为不变。

HEADERS 从请求体写完开始；FIRST 包含选凭证、刷新、退避和重试；
IDLE 仅由文本、思考、工具调用或媒体内容更新，心跳和元数据不会更新。
真流和抗截断续接共用预算，有效内容持续输出时无总时长上限。
原生非流、流转非流和假流使用 TOTAL 总预算。
超时提交响应前为 HTTP 504，提交后为对应协议的错误事件，不输出正常完成标记。
取消会清理上游流与凭证预取任务；一个逻辑请求只记录一次结果。

验证：test_antigravity_timeouts.py 覆盖三种格式、真流/假流/抗截断入口、
阶段超时、有效内容识别、跨重试预算和取消；原有防重放与统计测试保持通过。

## 冷却结算（已修复）

按凭证、现有额度组和 Pro/Flash/Other 分项去重。High/Low 在同轮冷却只结算一次。
同额度组延长冷却时，同步延长组内已有具体键，防止分项提前过期造成二次结算；
整个组过期进入新轮时，只移除该组旧键。有效冷却不被过期更新缩短。
历史组级键保守保持快照，直到冷却过期或显式清除。不重算旧统计。

SQLite 使用 BEGIN IMMEDIATE；PostgreSQL 使用事务和 FOR UPDATE 行锁。
MySQL/MongoDB 当前不具备这套轮次结算能力，本轮不新增能力。
验证：临时 SQLite 并发 High/Low、独立分项、延长/清除/过期，以及 PostgreSQL
事务调用模拟；连同现有冷却测试共 19 项通过。未连接真实 PostgreSQL 实例。

- 有界批量导入。

回滚：分别撤回对应代码提交，不覆盖运行数据，不重算历史统计。
