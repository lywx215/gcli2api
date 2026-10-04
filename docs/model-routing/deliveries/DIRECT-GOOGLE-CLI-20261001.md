# Google CLI 原生直连诊断 — 2026-10-01

## 结论

已经使用当前已上传的 CLI 凭证，完全绕过 gcli2api，向 Google Code Assist 接口完成三次串行真实请求。三次均在约 120 秒后出现 `ReadTimeout`，未取得完整可用响应。本轮没有记录到 Google 原始 HTTP 503，不能确定它与此前公开 503 的原因相同；有效语义与联网验收均未通过。

这次读取超时不需要经过项目的路由、请求归一化、响应转换或错误映射就能出现。但具体原因仍可能涉及服务端处理、网络链路或等待时限，不能据此确定许可、配额、账号、模型故障或搜索工具故障。

## 独立性与调用范围

- 测试对象是公开路由 `gemini-3.2-flash` 当时指向的同一目标；目标名称仅在进程内使用，没有写入报告或输出原始 `modelVersion`。
- 驱动只依赖标准库与 httpx，不导入任何 gcli2api 模块、旧诊断 helper 或存储管理器；没有向本地服务发送模型请求。
- SQLite 使用 URI `mode=ro`、`query_only` 和 SQL authorizer，读取唯一启用的 CLI 凭证及既有路由配置；没有执行持久化、计数更新、封禁或路由修改。
- TLS 验证开启；固定 Google HTTPS 目的地，关闭环境代理、重定向和 HTTP 重试。
- 总预算严格为三次实际 HTTPS 发送，包含条件式 OAuth 刷新。执行时按凭证记录的有效期检查无需刷新，最终生成 3 次、OAuth 0 次，无重跑。
- 本轮仅 CLI 非流式，不测试 Antigravity、Vertex、SSE 或其他目标；超时后没有增加调用。

原生接口是 `POST https://cloudcode-pa.googleapis.com/v1internal:generateContent`。官方 CLI 使用这个 Code Assist 入口及 `model/project/request` 请求封装，不是 AI Studio API Key 接口。[官方传输实现](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/server.ts#L389)、[请求定义和转换](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/converter.ts#L30)

Google Search 位于内层 `request.tools`，结构是 `[{"googleSearch": {}}]`，官方 CLI 的搜索配置采用相同字段。[官方搜索配置](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/defaultModelConfigs.ts#L237)

## 脱敏请求结构

```json
{
  "model": "<仅在内存中填入实际目标>",
  "project": "<既有凭证项目，仅在内存中使用>",
  "request": {
    "contents": [
      {
        "role": "user",
        "parts": [
          {
            "text": "请使用联网搜索定位Gemini API的Grounding with Google Search官方文档，返回该页准确标题和官网HTTPS链接，正文50字以内。"
          }
        ]
      }
    ],
    "generationConfig": {"maxOutputTokens": 2048},
    "tools": [{"googleSearch": {}}]
  }
}
```

无工具对照使用同一文档问题，唯一工具差别是省略 `tools`。语义测试使用“请严格仅输出：测试成功”。HTTP 认证来自内存中的 OAuth token；请求头、令牌、签名和自由错误文本未保存。UA 使用当前 CLI 路径的静态格式，但不执行项目代码。

## 实测结果

| 请求 | Google 原始 HTTP | 实测耗时 | 观测结果 | 内容 / 联网 |
|---|---|---:|---|---|
| 语义：仅输出“测试成功” | 未记录到可用值 | 120.469 秒 | ReadTimeout | 未通过 |
| 官方文档定位，无工具 | 未记录到可用值 | 120.437 秒 | ReadTimeout | 未通过 |
| 同一文档定位，googleSearch | 未记录到可用值 | 120.469 秒 | ReadTimeout | 未通过 |

“实测耗时”是从发起请求到失败的时间，不是服务器处理时间或首字时间。连接、写入和连接池超时为 15 秒，读取超时为 120 秒；读取时限不是总请求截止时间。

驱动在 `client.post()` 完整返回之后才保存状态码。因而证据中的 `http: null` 表示没有可用原始状态观测，**不能证明 Google 从未发送响应头**；本轮未细分响应头与正文读取阶段。没有取得完整 JSON，不能判断 Google status/reason、finishReason、模型身份或 grounding。

三项均不算语义成功。搜索项没有可验证的 `webSearchQueries/groundingChunks/groundingSupports`，但其状态是“不可判定”，不是已证实搜索未触发或项目删除了元数据。客户端超时也不证明上游没有执行请求或没有消耗额度。

## 与此前 503 诊断的区别

本轮原生请求输出上限为 2048，读取时限为 120 秒，不经过项目的 safety/thinking 等归一化。上一轮经过真实项目处理链的诊断，客户端请求的输出上限被归一化为 64000；项目 API 向工厂传入 300 秒，但当时安全客户端替身实际读取时限为 180 秒。证据中 `previous_project_request_timeout_seconds: 300` 指项目传参，不应理解成上一轮实际客户端采用了 300 秒。

上一轮无工具请求在 139.125 秒取得 HTTP 200，但正文为空且结束原因为 `MALFORMED_FUNCTION_CALL`；这个实测时间已超过本轮 120 秒读取时限。带搜索项当时也出现读取超时。因此，本轮不是等参数重放，不能凭三次超时认定此前 503 的原因，也不能确定减少输出预算有无效果。[上一轮诊断](CLI-503-DIAG-20261001.md)

此前项目将部分上游拒绝、容量错误和本地无可用凭证映射成公开 503 的机制，已经离线验证；本轮完全绕过该机制。当前没有捕获真实 403、429、500 或 503，旧请求缺失的原始错误记录仍然无法恢复。

## 下一步建议（本轮未实施）

1. 若授权进一步诊断，采用原生 HTTP 流式读取方式立即记录响应头状态，再读取非流式 JSON 的正文。注意这不等于改用模型 SSE 接口。
2. 分开记录连接、响应头、正文完成及超时阶段；只记录 allowlist 状态、reason、请求参数指纹和时间，不记录令牌、原始模型身份、签名或自由错误文案。
3. 使用相同最终出站 payload、相同等待条件做项目路径与独立路径对照，再单独比较 2048 与 64000。避免同时改变多项参数而错误归因。
4. 不根据三次读取超时自动刷新、换凭证、切模型或打开无限重试；这些动作会改变对照且可能继续消耗额度。
5. 搜索验收仍要求完整正文及原生 grounding 证据，并核验来源与支持片段；HTTP 200 和模型自称搜索不足以通过。

## 证据与服务状态

- 独立驱动：`C:/Users/lywx2/AppData/Local/Temp/gcli2api-local-routing-d79786d2b91f44f5ab2075e3d14fb1d9/direct_google_cli_probe.py`
- 脱敏证据：`C:/Users/lywx2/AppData/Local/Temp/gcli2api-local-routing-d79786d2b91f44f5ab2075e3d14fb1d9/direct-google-cli-probe-evidence.json`
- 已审核的 48 个业务文件 SHA256 未改变；本轮只新增临时诊断材料和此测试报告，没有修改业务代码、凭证或路由，也没有提交、推送或运行 Claude 审核。
- 本地服务仍仅监听 `127.0.0.1:7861`，监听 PID `35396`；没有重启。正式凭证库未使用。
