# Antigravity Token刷新写回审计与修复

日期：2026-10-16。范围：所有仍可到达的Antigravity既有Token刷新写回路径。保留真实凭证数据，不恢复Gemini CLI专属维护或取消的MGMT事项。

## 风险及处理

| 入口/共用链路 | 核对结论与最终行为 |
| --- | --- |
| CredentialManager._refresh_token：普通模型请求、流/非流、模型目录与权限后台共享 | 原来把选中视图里的运行时enable_credit持久化，可能新增或覆盖上传同名字段；没有保存OAuth轮转的refresh_token，且原地修改选择字典。现在按原generation读取不叠加Credit状态的原始快照并核对内容版本，合并Token/轮转refresh_token/有效期后CAS写回，再读取当前选择视图，保留运行时Credit语义并返回真实落库版本。读取仍受原有deadline约束，过期身份/内容在OAuth前拒绝。 |
| verify_credential_project_common：旧项目检验 | 刷新时直接to_dict替换会丢失自定义字段。现在仅AG分支合并原始上传数据；项目检验本身明确更新的project_id仍按原行为更新。项目检验成功与无法获取项目的分支均保留刷新前上传元数据。 |
| _fetch_quota_for_credential：旧版批量额度/恢复工具 | 原来即便没有刷新，to_dict与原JSON不同也会触发缩减式覆盖。现在仅AG真实发生Token刷新才保存，并先合并原JSON、同步已有token别名。 |
| test_credential_common：旧模型测试入口（origin=legacy） | 刷新时直接to_dict替换会丢失字段，现改为AG原JSON合并，CAS和后续测试/计数语义不变。回归只用合成模型响应。 |
| antigravity_manual.prepare：人工测试/额度/项目、新额度摘要共用 | 原来已合并原数据，此轮复用统一保留函数，仍使用原generation/version围栏。 |
| 自动上传邮箱、手动获取邮箱 | 前轮已修复，本轮复用统一保留函数；自动邮箱继续读取不叠加运行时Credit的原始数据。 |
| GET /creds/quota/{filename}的AG分支 | 在公共旧代码前直接委托manual.quota，已覆盖prepare；后面残留的to_dict公共段对AG不可到达，未借此修改GCLI。 |
| 风控立即重查、配置Preview、上传订阅检测 | 明确为GCLI或拒绝AG；本轮不修改。 |
| google_oauth_api中的userinfo、项目查询等助手 | 可以刷新传入Credentials对象，但不自行写存储；持久化由上述入口负责。新OAuth/RT导入是显式新导入语义，不当作刷新回写修改。 |
| manager/storage_adapter的quota_refresh_credential包装及存储CAS | 仅委托或按完整字典进行有围栏替换，保持原存储语义，不在底层静默吞并不同调用者的数据。 |

## 共用规则

新增src/antigravity_refresh.py的refreshed_credential_data，以原始上传字典为基底合并刷新字段，不引入OAuth序列化的None占位；保留已有token别名并同步，原来没有该别名则不凭空增加。剔除保留命名空间_quota_运行时标记，不把内部身份/版本写回凭证JSON。调用者必须提供原始快照，不能把控制状态投影视为原始数据。

自动选凭证路径持久化原始Credit字段，但返回给模型请求的enable_credit仍来自数据库控制状态；两者不混淆。版本使用实际落库原始字典计算，继续支持竞争刷新中复用胜者、拒绝旧身份/旧内容。未改变HTTP DTO、数据库schema、存储capability、panel-version或管理协议；manager侧no_counterpart_action。

## 验证证据

新增test_antigravity_refresh_writeback_paths.py共14项：原始Credit缺失/False/True × token别名缺失/存在、refresh_token轮转、返回视图及CAS版本、选择输入不被修改、generation/content过期时不发起OAuth、项目检验两结果、旧额度真实刷新与无需刷新、旧模型测试、准备读取超时不发起OAuth。

先新增13项场景在旧实现上全部失败，复现数据丢失/污染、轮转Token未保存、无需刷新也覆盖等风险；修复后首组119项通过。再加入准备deadline回归并补验共用手动操作和额度摘要，最终7文件311项全部通过（5条既有Pydantic弃用warning）：

```powershell
$env:ENABLE_LOG='0'
$env:PYTHONDONTWRITEBYTECODE='1'
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' -m pytest test_antigravity_refresh_writeback_paths.py test_antigravity_refresh_preservation.py test_antigravity_email_enrichment.py test_antigravity_review_regressions.py test_antigravity_runtime_import_regressions.py test_antigravity_manual.py test_panel_quota_summary.py -q --tb=short -p no:cacheprovider
```

补充验收第一次命令因自动权限审批超时未启动，按返回许可重试一次后上述测试实际执行并通过；该审批超时不计作测试失败。改动源码及新增测试AST解析通过，受跟踪修改git diff --check通过。

所有OAuth、模型、目录响应均为合成替身，存储仅临时SQLite；没有载入本机测试启动器补丁，没有读写已有私有凭证库，也没有真实Google或模型请求。

## 交付与边界

本轮业务源码涉及src/antigravity_refresh.py、src/credential_manager.py、src/panel/creds.py、src/panel/antigravity_manual.py、src/antigravity_email_enrichment.py；新增上述14项回归及本审计说明，沿用前轮测试不覆盖其他窗口改动。其他前端和主G工作区保持不动。

没有数据迁移或历史回填；不能凭代码恢复已丢失且无备份的旧字段。本轮没有重启现有5193/65476，当前进程未自动热加载这些最新改动。回滚只需恢复本轮源码，不回滚或覆盖数据库。未提交、推送、部署、Docker或外部审核，不自动开展后续任务。
