# Antigravity 邮箱刷新保留上传字段

2026-10-16。修复上传自动邮箱及手动获取邮箱过程中，必要 Token 刷新可能丢失原始上传字段的问题。仅后端修复，不恢复已取消的 MGMT 工作，也不扩大 Gemini CLI 专属维护。

## 行为与实现

- 自动邮箱：原 quota_current_credential 会将数据库控制状态 enable_credit 覆盖到凭证视图，worker 写回前又删除该键；如果上传 JSON 原本有同名字段，刷新会丢失该字段。现在内部读取方法增加仅关键字参数 include_credit_state，默认 True 保持所有既有调用兼容；邮箱 worker 传 False，读取原始上传值，保留身份/内容版本标记，写回时只移除内部 _quota_ 标记，不再删除原始 enable_credit。
- 手动获取邮箱：原 Credentials.to_dict 只包含 OAuth 已知字段，直接替换会丢失 type、scopes、token_uri 和自定义元数据。现在仅 Antigravity 分支在原始 credential_data 上合并刷新结果；存在旧 token 别名时同步更新，原来没有该别名则不新增。
- 继续使用原 generation 与 expected_version CAS。刷新写回成功后以实际完整字典计算下一版本，再写邮箱。并发重新导入或内容变化仍会拒绝旧结果；没有关闭/绕过身份围栏，也没有修改存储替换语义。
- 不改变 HTTP 接口、DTO、数据库 schema、现有 capability 或 panel-version。manager 无需配套动作：no_counterpart_action。

## 验证

新增 test_antigravity_refresh_preservation.py 共11项，直接使用真实项目后端、合成凭证、临时 SQLite 和合成 OAuth/邮箱响应，不加载本机启动器补丁，不请求真实 Google：

- 原始 enable_credit 缺失、False、True 分别验证，默认控制状态视图仍兼容。
- 自动/手动刷新保留原始自定义嵌套字段、type、scopes、token_uri 等；只更新实际刷新字段。
- Token 别名存在与不存在、刷新 Token 轮转、邮箱成功落库以及精确内容版本延续。
- 并发更换 generation 或原始内容时拒绝旧写回，刷新失败保持上传原样。

修复前新增测试运行结果为7 failed / 4 passed，其中4项复现字段丢失，3项因新的可选读取参数尚不存在而失败。修复后下列命令106项全部通过，5条既有Pydantic弃用warning：

```powershell
$env:ENABLE_LOG='0'
$env:PYTHONDONTWRITEBYTECODE='1'
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' -m pytest test_antigravity_refresh_preservation.py test_antigravity_email_enrichment.py test_antigravity_review_regressions.py test_antigravity_runtime_import_regressions.py -q --tb=short -p no:cacheprovider
```

既有邮箱、取消/超时、晚提交、导入收据及相关控制面兼容回归一并通过。git diff --check在修改的受跟踪后端/测试文件通过。未执行全量测试或真实模型调用；本次没有调用外部审核。

## 数据与运行边界

本次没有读取或修改已有私有凭证库、没有数据迁移、没有重启现有5193或65476、没有提交/推送/部署。其他窗口的前端紧凑显示改动保持原样。

本机测试启动器源文件中的重复 _write monkeypatch 已移除，后续启动使用项目实现；当前已运行进程仍是此前加载的实现，不宣称已热更新。此次106项验证完全独立于该宿主保护。

回滚仅恢复此次后端及测试代码，无数据库回滚或schema动作。该修复保护之后的邮箱刷新，不自动恢复历史上已丢失且无原始备份的字段；已有凭证保持原样。本轮范围限已确认的邮箱刷新路径，不改变模型调用凭证选择或其他既有刷新路径。


## 2026-10-16 10:35：授权重启与真实Google验证

上述“未重启”是后端实现阶段的边界。所有者随后明确授权重启65476及必要Google请求；已先备份当前持久工作库并验证独立恢复，再重启原端口加载项目修复，当前PID40556。

运行时确认邮箱实例无自定义_write属性，方法绑定到项目EmailEnrichmentService._write；原始读取参数include_credit_state已加载，三个相关后端源码摘要与工作树一致。启动器中已无字段保留monkeypatch；仍保留正常本机配置、Google白名单和禁止模型生成的限制。

真实验收在独立空白私有库进行，没有对当前工作库重复导入。通过实际上传接口上传一份仅用于本机验证的测试副本，副本有效期设为过期以触发刷新，并加入合成嵌套探针字段。上传HTTP200，Google OAuth刷新1次200、userinfo查询1次200，自动邮箱任务success1；原始非Token字段及enable_credit存在性/值、嵌套字段完整保留，新Token/有效期落库，旧token别名同步。邮箱已保存，仅在内存比较，不输出身份。

主页面及列表接口200，当前凭证集合、身份、内容和原有邮箱与重启前快照完全一致（两渠道各1条）。旧5193保留；独立验收进程停止但私有验证库和上传副本保留。没有额外额度请求或模型生成，没有提交/推送/部署。

安全运行记录位于当前用户私有测试目录，报告仅包含状态码、计数和布尔验证结果，不包含真实邮箱、完整业务文件名、令牌或原始响应。该实测与此前106项合成回归分开记录，不累加为测试套件通过数。


## 2026-10-16 10:41：手动获取邮箱真实验证

根据所有者明确授权，新建独立空白私有测试库，用项目后端存储方法保存一份当前测试凭证的内存副本，仅在该副本设置过期并加入合成嵌套探针；初始邮箱为空，不使用自动邮箱队列。测试前一致性快照完整性通过并设为只读。

实际POST /creds/fetch-email/{filename}?mode=antigravity 返回200，触发Google OAuth刷新1次200、userinfo查询1次200，共2次Google请求。邮箱已持久保存，原始所有非Token字段及enable_credit存在性/值、嵌套字段完整保留；Token/有效期更新、旧token别名同步、身份generation保持。没有命中邮箱缓存，不依赖启动器对手动获取或邮箱写回的替换，加载源码摘要与项目一致。

当前65476库前后两渠道凭证内容/身份/邮箱完全一致，仍为各1条，未覆盖/清空或重复导入。主65476和旧5193未重启；独立手动验收进程已停止，私有测试库、快照和安全记录保留，ACL仅当前用户与SYSTEM。没有记录真实身份、邮箱、Token或原始响应，没有模型生成、提交/推送/部署。本实测与此前自动路径及106项合成回归分别记录，不累加测试套件数量。


## 2026-10-16：其他Antigravity刷新写回路径

所有者随后授权检查并修复其他Token刷新路径。本轮已修复自动选择、旧项目检验、旧批量额度和旧模型测试中的原始字段丢失/运行时字段混入风险，加入共用合并函数，并核对其余入口。新增14项回归，最终311项隔离测试通过；现有凭证、运行服务未改动，未提交/推送/部署。详见[完整入口审计](../ANTIGRAVITY_TOKEN_REFRESH_WRITEBACK_AUDIT.md)。
