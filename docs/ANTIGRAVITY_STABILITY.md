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

- 分阶段超时和共享重试预算。
- 同额度组、同统计分项冷却去重。
- 有界批量导入。

回滚：分别撤回对应代码提交，不覆盖运行数据，不重算历史统计。
