# Gemini 3.8 Flash（High）：五例本地重放摘要

2026-10-09，用户在首次Low测试及Claude复审完成后，另行授权重放其提供的五份完整Gemini请求，指定High模型。本摘要不包含真实凭证、认证头、公司输入或原始业务响应。

在临时 `127.0.0.1:8135` HTTP服务挂载实际Antigravity Gemini路由，保留认证、转换器、API及Google HTTP链路，凭证provider/配置/统计在内存隔离。请求模型为 `gemini-3.8-flash-high`，Flash方式为native。先完成健康与未认证401检查，再串行运行五例，每例最多一次生成，无自动重试或换账号。

五份输入canonical SHA均与原文件两份元数据记录匹配，保留googleSearch、temperature0、maxOutputTokens32768；现有normalizer实际发送64000，未使用首次短提示测试的512护栏。客户端480秒、连接10秒；服务使用默认headers60/total300秒等既有预算。

| 实例 | 预期条数 | 本地/上游HTTP | 耗时秒 | 结果 |
| --- | --- | --- | --- | --- |
| E01 | 8 | 429/429 | 1.953 | RESOURCE_EXHAUSTED，提示个人配额到限 |
| E02 | 10 | 200/200 | 38.266 | STOP且有正文，外层JSON代码围栏违反纯JSON要求 |
| E03 | 4 | 429/429 | 1.312 | RESOURCE_EXHAUSTED，提示个人配额到限 |
| E04 | 10 | 200/200 | 13.156 | STOP且有正文，外层JSON代码围栏违反纯JSON要求 |
| E05 | 10 | 429/429 | 3.391 | RESOURCE_EXHAUSTED，提示个人配额到限 |

两份200证明本轮High/native实际成功生成。原始返回均有Markdown JSON代码围栏，严格业务格式未通过。仅诊断去除一对围栏后，各10条记录，整数id、顺序、数量及字段类型检查全部通过；不能追认原始纯JSON验收通过。

两份响应未包含grounding元数据，本次未独立核实来源或公司事实。三份429的上游提示是“Individual quota reached”；同一账号本轮仍返回两份200，不将该提示推广为所有请求或所有账号不可用。

本批实际尝试为5次生成＋必要1次OAuth，使用同一份只读测试凭证，最终stdout确认原文件hash未变。该新批次与初始Low批次的8次限额分开记录，未重置或追加初始批次的调用。临时服务测试结束后关闭，生产服务/数据库未修改。

本轮未复现原报告的504、TLS异常或响应头前断连；串行localhost测试不覆盖原生产TLS/反向代理及256并发，不能据此宣称原生产问题已修复。

16个已审核实现文件仍与最终Claude快照一致，新增临时适配器经过Codex独立审计，不冒称已由Claude审过。完整脱敏响应与输入仅保留在Git忽略目录 `.cache/flash-five-cases/20261009T071830-live-39baba/`，不进入远程提交。
