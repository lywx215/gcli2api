# ERR-02 已知模型退役通知识别器

日期：2026-09-27

工作区：`C:/Users/lywx2/.codex/worktrees/14f9/gcli2api`

基线：`dev0926` / `0b3a07e003ead2ba7a9f7827426c09f8ff996813`

## 实现文件

- `src/router/model_retirement.py`
- `tests/test_model_retirement.py`

仅修改以上两个实现/测试文件及本报告；没有修改路由、转换器、统计、ERR-01 模块、协议契约、凭证、数据库或版本文件。

## 接口与语义

- `inspect_non_stream(payload: Any) -> RetirementResult`：检查已解析的完整 Google 响应，支持顶层 `candidates` 和 `response.candidates` 包装；在转换前调用。
- `check_non_stream(payload: Any) -> RetirementResult`：`inspect_non_stream` 的描述性别名。
- `is_model_retirement_notice(payload: Any) -> bool`：仅返回是否命中，不返回匹配文本。
- `RetirementStream(*, max_buffered_event_bytes: int = 16 * 1024 * 1024)`：每次上游 attempt 新建；`feed(event, *, finish=False)` 接收一个已解析事件，`finish()` 处理 EOF，`reset()` 仅供显式复用。
- `new_attempt(**kwargs) -> RetirementStream` / `ModelRetirementStream`：便于接线方明确按 attempt 隔离状态。
- `RetirementResult` 只有 `action`、安全的 `events` 和必要的 `status_code`。`PASS` 返回按原顺序可释放的原事件；`BUFFER` 不返回事件；`RETIRED` 固定 `404`；`BUFFER_OVERFLOW` 固定 `502`。退役和超限结果不携带原句、模型名、异常或上游 payload，也不自行生成协议 JSON。

## 识别规则

- 只扫描每个 candidate 的首次展示文本：忽略 `thought=True` 文本；候选前已有 function/tool、inline/file/image 等非文本 part 时，该候选转为普通成功并停止扫描。
- 仅当展示正文从可选最多 64 个开头空白后开始 `Gemini <名称> is no longer available.` 时命中；大小写不敏感，名称只接受 ASCII 字母、数字、空格、`. _ / + - ( )`，长度 1–128。切换建议不会进入识别或输出。
- 不扫描展示正文中间的通知、引用、代码围栏、普通讨论、thought、工具参数、图片和元数据。
- 流式状态按 candidate index 独立维护；尚可能匹配时暂存完整事件，确认不匹配后按原事件顺序释放，确认退役时清空队列并返回固定 404。
- 展示前的 thought/usage/metadata 立即放行，不计入展示前缀上限；混合事件只要包含尚未判定的展示正文就整体暂存。
- 展示前缀最多保留 256 个展示字符；事件队列按 compact UTF-8 JSON（字符串/bytes 按 UTF-8 bytes）计量，16 MiB 以内含边界，超过后清空并返回固定 502。前缀排除优先于队列大小判断。
- EOF 或所有待定 candidate 的 `finishReason` 到达时，未形成完整通知的前缀按普通内容释放；完整通知确认优先返回 404。每次 attempt 均从空状态开始。

## 测试证据

命令（均从指定 14f9 工作区执行，并设置 `PYTHONDONTWRITEBYTECODE=1`）：

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' -m py_compile src/router/model_retirement.py tests/test_model_retirement.py
& 'G:/code/gemini30/gcli2api/.venv/Scripts/python.exe' scripts/run_diagnostic_tests.py -c pyproject.toml --asyncio-mode=auto tests/test_model_retirement.py
```

结果：语法检查通过；诊断测试 `17 passed in 0.05s`。

覆盖项包括：response 包装、大小写/前导空白/名称字符和长度边界、首段与中间引用反例、thought、工具/图片、多 candidate、逐字符跨事件前缀、事件顺序、EOF、`finishReason`、前缀排除、16 MiB 精确边界与超限 502、Pydantic-like 输入以及新 attempt 状态隔离。测试只使用内存对象，没有真实 Google/生产请求。

## 集成边界和未解决项

本任务只交付纯识别器，不接入六个路由、不负责 SSE 解码、不渲染 OpenAI/Claude/Gemini 协议错误，也不负责统计和抗截断接线；这些属于 ERR-03/ERR-04。窗口 A 可在验收后将 `RetirementStream` 接到每个上游 attempt，并将 `RETIRED.status_code` / `BUFFER_OVERFLOW.status_code` 交给 ERR-01 的固定 renderer。窗口 B 在本报告后停止写入。
