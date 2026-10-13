# 本地额度查询恢复与最新凭证确认

2026-10-13，用户报告5193旧UI无法获取额度，确认目标是本次本地实例。原启动器是合成联调用的隔离环境，会拒绝Google请求，不能查询真实额度。用户随后要求“请修复保证功能完整”。

## 授权和数据保留

直接恢复全部网络后台的首次启动被自动审批拒绝：缺少具体目的地、凭证外发及额外后台请求授权。先完成一致性备份及可独立实施的UI修复，再向用户列明范围。用户明确选择“授权完整本地运行”：允许已导入3份Antigravity凭证访问 `oauth2.googleapis.com`、`daily-cloudcode-pa.googleapis.com`、`www.googleapis.com`，允许必要Token刷新、正常目录/邮箱后台及本机私有SQLite状态回写；主窗口只主动验证额度，不发送模型生成、不部署。

旧预览数据库用SQLite online backup复制到当前用户个人private目录，校验integrity、主表行数和data_version，并保留独立私有回滚快照；没有读取凭证字段到输出、改变schema或覆盖设置/路由seed。private目录移除继承，仅当前用户和SYSTEM访问。现有生产或原G工作区数据未动。原临时服务关闭后，从私有持久库启动相同真实web.app、原生单worker机制；不再使用后台替身，HTTPS传输仅放行上述Google域名。服务与日志不进入Git、截图或证据ZIP。

## 真实查询与凭证修复

恢复上游访问后，旧UI的3份凭证都收到Google HTTP403，已确认为真实上游拒绝，原始安全状态记录保留。一次仅在进程内检查的Google错误分类为 `PERMISSION_DENIED`；没有记录响应原文、身份或Token。公开源码比较不显示本次UI改造改变额度wire协议，未据此擅改请求体、UA、OAuth client或endpoint。

随后用户明确“凭证已经修复，请确认最新的凭证”。以下成功结果基于**当前运行库的最新凭证**，没有回滚或重新导入旧快照：

| 实际检查 | 结果 |
| --- | --- |
| 最新列表 | 3份，全部启用，无禁用项 |
| 旧UI真实额度 | 3/3返回HTTP200、Google上游200、success=true；每份返回22个模型、按既有元数据展示14个，额度卡片正常 |
| 新UI真实额度 | 桌面1440与手机390均取得HTTP/上游200；14个可见模型，百分比、隐藏模型过滤、页面无横向溢出、关闭焦点检查通过；不保存真实身份截图或响应正文 |
| 呈现定点测试 | ResultView及CredentialDetail两个文件，14/14通过；不与此前338项前端测试或244项旧接口回归累加 |
| 最终构建 | 类型检查、生产构建及六页产物检查通过：14 hashed JS、1 CSS、完整引用/注入点、六页独立加载、无DEV fixture |

新UI手机首轮一次502来自上游连接阶段的 `ConnectError`，无Google响应；桌面当轮成功记录保留，手机只单独复核一次后200。检查脚本最初对隐藏旧标题、关闭后列表刷新的焦点回退断言过严，也保留失败记录；没有将检查脚本问题或短时连接失败篡改为首轮通过。成功结论不保证Google网络、账号或额度以后始终可用。

## 代码范围

新版 `ManualResultView` 补齐合法0–1额度百分比、极小非零值、`visible=false`模型过滤、滚动168h及合法ISO恢复时间（北京时间）、结构化失败/阶段/写回原因的本地白名单说明。未知或无效值保持未知，不回显任意上游error、身份、Token或原始JSON；上游结果与本地写回状态继续分开。

只修改 `frontend/src/pages/credentials/ResultView.tsx` 并增加对应定点测试。旧front、后端、API/auth、hooks、依赖与panel-version保持不变；运行方式修复位于本机启动脚本和private数据路径，无项目运行时依赖。

本机安全证据目录：`C:/Users/lywx2/.codex/visualizations/2026/10/13/01a132fa-9639-7c50-a301-b42ba28f74ee/local-ui-functional/`。主要包括 `BACKUP_RECORD.json`、`STARTUP_RECORD.json`、`LEGACY_QUOTA_REAL_BEFORE_CREDENTIAL_REPAIR.json`、最新 `LEGACY_QUOTA_REAL_REPORT.json`、桌面 `NEW_QUOTA_REAL_REPORT.json`、手机 `NEW_QUOTA_MOBILE_REAL_REPORT.json`、生产构建日志与脚本。旧失败/403均为当时状态，不能代替凭证修复后的成功结果。

定点测试实际命令（cwd frontend）：`node node_modules/vitest/vitest.mjs run src/pages/credentials/ResultView.test.tsx src/pages/credentials/CredentialDetail.test.tsx --no-file-parallelism --maxWorkers=1`。默认沙箱在Vite配置缓存写入阶段EPERM，未运行测试；同命令在允许工作树写入的环境通过。正式构建为 `VITE_UI_FIXTURES=false npm --prefix frontend run build`（含tsc）及 `npm --prefix frontend run check:build`。

本地服务保持运行于 `http://127.0.0.1:5193/`，新版入口 `/ui/`、旧入口 `/`。用户刷新页面可加载新版结果呈现。Docker跳过，没有部署、推送、真实模型生成或额外生产操作。真实Google额度已补验；完整OAuth浏览器换码、远程数据库及收费模型调用未据此标记通过。
