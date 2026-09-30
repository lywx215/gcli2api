# Antigravity 人工直连测试交付记录

日期：2026-09-29。基线：dev0927 / f9d48c0。实施依据：Claude已批准的v10方案。

## 已实施

- `src/panel/creds.py`：认证后的Antigravity面板入口显式转入人工分支；默认内部调用、
  Management及Gemini CLI保持legacy。批量保留每项Google状态和回写结果。
- `src/panel/antigravity_manual.py`：指定凭证直连生成/额度/项目查询；保留旧请求构造，
  分离HTTP状态、本地回复验证与状态写入。明确失败不冒充成功，错误使用固定英文。
- `src/storage/antigravity_quota.py`：旧记录代次初始化、安全原始快照、条件项目保存、
  一次性分层结算、人工额度同步；复用四后端事务/CAS及既有统计出口，无schema变更。
- `src/manual_google.py`、OAuth辅助函数和Antigravity额度查询：人工请求局部上下文内
  在首次日志出口隐藏原文，保存OAuth/项目/额度真实状态，其他调用维持既有行为。
- `front/common.js`：人工结果分别展示Google状态、回复验证、分项回写和阶段；
  项目检验明确禁用状态不变，HTTP200本地校验失败不再显示成功。
- 两个诊断脚本及文档：说明面板额度采样具有状态恢复副作用；目录验证的默认临时实例
  与`--live-url`指定服务明确区分。未执行真实诊断脚本。

实施中补充了两处必要细节：旧导入可改变凭证内容而不旋转代次，因此Token冲突回退额外
核对稳定身份字段；项目查询失败时不能仅因早期阶段拿到tier而清除错误或宣称检验成功。

## 验证

- 新增41项人工路径测试，包括模拟Google、临时SQLite、三种远程后端驱动替身及Node UI调用。
- 更新原“人工/管理应一致拦截”的测试，明确人工恢复、Management继续自动保护语义。
- 完整pytest：1595通过、1跳过、6个现有警告，约83秒。
- 全量通过后补正Token回写冲突的本地/Google阶段区分，41项人工测试再次通过；
  最后的前端阶段显示补充另经针对性UI测试及Node语法检查。
- `git diff --check`通过。测试环境补齐缺失的jsonschema；未改应用依赖清单。

本次Claude代码审核后，又修复4项已确认问题并新增7个回归场景。
人工路径现为48项通过；修复后完整pytest为1602通过、1跳过、6个警告，退出码0。
审核发现、修复说明及本轮测试环境诊断详见
[代码审核记录](MANUAL_TEST_DIRECT_CODE_REVIEW.md)。

验证没有连接真实Google或生产数据库。PostgreSQL/MySQL/MongoDB验证使用驱动替身，
没有声称完成这些数据库的在线集成测试。此前暂缓的稳定性证据缺口仍暂缓。

## 当前状态

代码已在本地完成，未提交、推送或部署；panel-version.txt未改。
Management schema/capability不变，无数据迁移、无manager侧动作。
方案通过Claude审核；首轮实际Claude代码审核发现4项问题，Codex已修复并验证。
2026-09-30用户重新明确启用复审，实际Claude方案关联和代码复审均返回`findings=[]`，代码审核已通过。
本轮未再修改业务代码或测试，沿用1602通过/1跳过的回归证据；批准后仅补记审核结果文档。
批准快照、时间和修复文件摘要见[代码审核记录](MANUAL_TEST_DIRECT_CODE_REVIEW.md)。
原`.codex/review-code-diff.patch`和审核历史均保留，没有覆盖为本次审核证据。

行为说明见 [Antigravity人工测试](../docs/ANTIGRAVITY_MANUAL_TESTS.md)。
