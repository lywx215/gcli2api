# 模型 API 固定英文错误：本轮交付记录

发布整理（2026-09-27）：用户在审核完成后明确授权创建 `dev0927` 并提交、推送。该分支从已审核的 `dev0926` 工作区创建，源码和测试与最终批准的117文件摘要一致；以下“未提交/未推送”描述保留为审核结束时的历史状态。本次提交范围包含5个新增测试文件（显式纳入Git，保留既有忽略规则）、本工作项源码、文档与不含凭证的审核配置。提交与远程状态以Git记录为准，未授权部署，控制面板版本号保持不变。

日期：2026-09-27。唯一工作区：`C:/Users/lywx2/.codex/worktrees/14f9/gcli2api` / `dev0926`。未提交、未推送、未部署。

## 结论

**ERR-05 完成。** 本组第 1 轮 2 项、第 2 轮 4 项问题均已修复并补测；第 3 轮真实 Claude 代码复审返回 findings=[]、error=null。完整回归 **1143 passed、1 skipped、6 warnings（65.43s）**。

原始结果与逐项处置见 `review/MODEL_API_FIXED_ERRORS_CLAUDE_CODE_REVIEW.md`；失败修复过程和详细证据见 `review/tasks/ERR-05.md`。

## 变更与兼容影响

- 六个 Gemini CLI/Antigravity 生成路由及其计数接口的错误从零生成固定英文 JSON/协议错误帧；计数接口不增加生成统计。
- 非流式和假流式在转换前统一验证 HTTP-200 error、退役、非法 JSON/非对象/response 包装。首错误在提交前返回对应 4xx/5xx JSON；不再先提交 200；Claude 错误没有 [DONE]/成功尾帧。
- 流事件模式识别顶层及嵌套 error，error:null 不误判；纯 DONE/空流按既有预算尝试，终局 502；EOF 释放普通缓冲，完成识别后的 usage 尾帧保留。
- 实际 httpx 超时通过私有元数据传递为 504；空响应/collector 格式错误为 502；维持重试预算与 Antigravity 原有最终 HTTP 错误优先级。默认底层调用的旧响应 wire 保留，受保护出口读取私有类型。
- 本地计算的 Retry-After 带 LOCAL 私有标记，允许保留整数值；上游 Retry-After/其他原始错误头不转发。
- 六路由局部包装既有认证函数，仅实际本地鉴权 401/403 标 CLIENT，返回认证/权限文案与必要 WWW-Authenticate；来源不明或上游 401/403 仍为中性服务文案。其他路由/global utils 不变。测试 override 应使用包装依赖，而非原 utils 别名。
- 受保护流不使用原两短语退役统计启发式；普通引用正常成功，合并 error+[DONE] 帧记失败，最终只记录一次。非流式/假流式真实 Request 调用关闭底层重复逻辑统计。
- 保留成功转换诊断；类型化模型错误不冒充传输错误。冻结诊断契约未改。Vertex 源路径和默认按行/空流 204 行为未改；不声称执行了真实 Vertex 模型调用。
- ERR-02 独占识别器、测试和报告未编辑，集成层按其 PASS/BUFFER/RETIRED/BUFFER_OVERFLOW 接口处理。

## 最终验证命令

从上述工作区执行：

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:PYTHONPATH='C:/Users/lywx2/AppData/Local/Temp/gcli-diag02-validation-deps'
$regressionFiles = @(rg --files -g 'test_*.py' -g '!tests/**')
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/run_diagnostic_tests.py -c pyproject.toml --asyncio-mode=auto -q tests @regressionFiles --tb=short
```

实际结果：**1143 passed, 1 skipped, 6 warnings in 65.43s**（1144 项）。包含 tests/ 和根目录全部 37 个测试模块，覆盖管理/OpenAPI、Legacy、面板、订阅、模型、凭证工具的隔离测试及 DIAG 回归。1 个既有平台 fork skip；6 个 Pydantic/Starlette 弃用 warning。所有状态和凭证使用临时隔离/mock，DIAG 使用 loopback 合成上游。

冻结契约检查：`scripts/verify_diagnostic_contract.py` PASS，73 文件逐项哈希一致，worktree == index；manifest SHA-256：`ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4`。实际清单与 HEAD 比较无差异，冻结目录和 panel-version.txt 无工作区状态。`git diff --check` 通过（仅 LF/CRLF 提示）。

`jsonschema` 仅通过已有临时 PYTHONPATH 提供；未安装依赖或改变生产环境。新增 tests/ 文件被既有 gitignore 忽略，作为本工作区本地交付保留，未暂存/提交；共享 review.json 已覆盖 tests/**/*.py 和 test_*.py。旧分批计数为历史记录，不与本次合并计数相加。

## 最终门禁与任务状态

- ERR-01、ERR-03、ERR-04：开发和本轮范围内修复完成，本地集中验证及最终 Claude 代码复审通过。
- ERR-02：保留窗口 B 的交付，本轮合并测试包含其 17 项。
- ERR-05：done；本组实际 0 次方案、3 次代码审核，第 3 次 findings=[]。批准快照摘要 `8d8ff44609431d5c690c06a3db0a63b074a1264d6566618adf67fbff9b5f3911`。审核前后 117 个源码/测试文件摘要均为 `028431889e9a8f26433a67c5b1e101098f7e6c5dd8c72ace22ff5f9116c3340f`；通过后仅保存审核记录和完成状态，代码/测试未再改动。
- 未执行真实 Google/Vertex 上游、生产凭证、部署或生产 Volume 验证。
- 无新增管理 schema、capability、manager 依赖；不涉及管理协议变更，无 manager 对端动作。
- 未提交、推送、部署；未修改真实凭证、SQLite/Volume、panel-version.txt。


## 本组第二轮修复补充

Response→异常边界统一保留私有 TIMEOUT/BAD_FORMAT；空凭证池附 LOCAL 503；流/非流重试 finally 取消并等待未消费的凭证预取任务，父取消继续传播。直接 API 数据后异常不重放、抗截断第二轮 HTTP/超时/格式/退役停止、预取任务 return/close/cancel 和六路由私有类型均补测试。定向 312 passed；完整结果以上述 1143 为准。静态检查后仅清理空白行行尾空格，无语义变更。
