# 六页生产包与本地后端联调

2026-10-13，用户授权继续并行收尾：先完成六页生产包与本地后端联调，确认旧接口兼容；Docker 暂时跳过，暂不部署。本次只验证现有实现，不启动取消的 MGMT 或 Gemini CLI 专属开发。

## 来源与隔离

源码为 `codex/ui-warm-gray` 的 `16818bb98ec243b573eeaf94702f766548d8e9d3`；生产包运行源码仍为 `1977f9b9e8ad9f59d429675592aedf286bd12fe6`。现有 `ui-dist/` 与此前交付包的 17 个文件逐 SHA-256 完全一致，没有重新构建、启用 DEV fixture、更改业务源码或替换同源 API 响应。

真实 `web.app` 仅监听 `127.0.0.1:5193`，实际进入和退出应用 lifespan，使用新建临时 SQLite、合成面板密码、合成凭证、独立日志和旧 front 的字节一致临时副本。继承的数据库、代理及远端环境变量清除，dotenv 不读取，数据库路径受限于临时目录，外部传输拒绝。没有读取或修改现有凭证、数据库或生产数据。

为避免自动访问上游，只在验收进程禁用 keepalive、smart429 probe、model access scan、email enrichment 四类网络后台启动；保留配置/存储初始化、SQLite 统计任务及目录原子结算。JSON 导入经过真实上传、凭证管理器和 SQLite 提交；邮箱后台关闭导致补全跳过及警告，未据此宣称邮箱查询或上游认证成功。

## 实际结果

| 门禁 | 结果与范围 |
| --- | --- |
| 六页生产浏览器 | Chromium 1440/390 两个宽度，24 项有界检查通过，69 个页面 HTTP 响应；六页全部使用真实本地 API，13 张 PNG。没有页面运行错误、失败请求或外部请求尝试 |
| 登录与概览 | 无认证旧接口拒绝、错误密码401、正确密码登录；概览读取真实 SQLite 统计并核对可见数值 |
| 导入与凭证 | 合成 JSON 上传保存、列表读取、抽屉备注保存回读、禁用/启用回读、保存错误显示、关闭焦点恢复、确认删除并核对列表已移除、登出 |
| 设置 | 无效数字仅前端拒绝，无保存请求；直接非流超时480→600真实保存、GET回读和页面重新读取；不修改密码或管理 Token |
| 模型路由 | 无效目标400且完整表未改；修改AG公开名后真实PUT/GET，完整期望表逐项一致，原目标、启用、顺序及旧CLI行完整保留；没有调用任何模型 |
| 日志 | 两个真实 WebSocket 连接接收独立日志文件内容；筛选、真实下载及合成日志文件清空确认。不声称断线无损恢复或生产 WS 行为 |
| HTTP托管与旧入口 | 44 项检查通过：旧 `/`、`/model-routing`、旧 common.js，动态UI元信息、307保留query、14JS/1CSS逐字节一致及MIME/immutable/nosniff，私有dist文件与缺资源404，旧接口认证门禁及keepalive HEAD |
| 旧接口隔离回归 | 10个现有文件，244 passed、0failed/0skipped、6条现有Pydantic弃用warning；Python3.12.10、pytest8.4.2。外部socket尝试0、意外storage初始化0，源码/测试/旧front散列前后一致 |
| 服务收尾 | 已停止监听5193，真实lifespan退出，临时DB/front/log全部删除。外层PowerShell的Ctrl+C退出码为1，不能写为正常exit0；服务证据为stopped及cleanup成功 |

浏览器控制台有两条预期资源报错，分别对应主动测试的错误密码401及无效路由400；不写为控制台零错误，也未发现额外错误。各组检查不累加成新的测试总数，不重跑前端338项或后端模型大矩阵。

现有回归文件：`test_ui_hosting.py`、`test_model_routing_panel.py`、`test_model_routing_config_api.py`、`test_frontend_static.py`、`test_panel_embed.py`、`test_panel_credential_capabilities.py`、`test_panel_config_save_failures.py`、`test_oauth_flow_isolation.py`、`test_selected_credential_tools.py`、`test_antigravity_panel_api.py`。其ASGI/驱动替身测试与本次真实本地服务闭环分开记录。

## 原始尝试与证据

默认沙箱中最初的pytest组合卡在首个TestClient，未产生通过数。未加guard、未导入业务的纯FastAPI探针同样停在Windows socketpair/self-pipe；沙箱外同探针0.015秒返回200，再补跑上述未完成组合通过。原始超时栈与尝试保留，不能算产品失败，也不能改写为当时通过。

后端入口首轮因验收guard将临时SQLite的只读 `file:///C:/...?mode=ro` 误判为目录外而拒绝启动；仅修正验收脚本对URI的规范化，并仍检查最终绝对路径属于临时目录。原始 `SERVER_INITIAL_ATTEMPT.json` 保留；正式运行blocked为空，产品源码未改。

本机证据目录：`C:/Users/lywx2/.codex/visualizations/2026/10/13/01a132fa-9639-7c50-a301-b42ba28f74ee/local-backend-integration/`。入口脚本、合成JSON、`BROWSER_LOCAL_REPORT.json`、`HTTP_LOCAL_REPORT.json`、`SERVER_EVIDENCE.json`、`legacy/runtime-escalated/legacy-results.xml`、隔离/运行日志及截图均保留。`index.html` 和 `SUMMARY.md` 用于查看本地联调结果，不是外部客户签收记录。

实际主窗口命令（绝对脚本路径位于上述证据目录）：

```powershell
python -B <证据目录>/run_local_backend.py
python -B <证据目录>/http_local.py
python -B <证据目录>/browser_local.py
```

回归runner精确参数、进程隔离措施及首轮诊断另见 `legacy/` 的记录。需要Windows正常事件循环与Chromium启动权限；不通过降低外部传输或数据库隔离条件绕过沙箱问题。临时服务已关闭，截图入口可以离线查看。

**六页生产包与本地后端联调、旧接口必要兼容检查完成。** 本地SQLite及合成凭证的结果不能替代真实OAuth换码、上游模型请求、邮箱查询、远程数据库或生产验收。Docker按用户要求跳过；没有部署、推送、默认入口切换、依赖升级、panel-version变更或跨仓库配套任务。
