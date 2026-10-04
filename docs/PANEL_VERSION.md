# 面板显示运行分支版本

桌面和移动端移除“检查更新”。面板只读取本服务 `/version/info`，不再比较上游
`master` 的版本文件。旧 `check_update=true` 参数继续接受，返回检查已停用，
不发起远程请求。版本响应和前端请求均禁止缓存。

## GitHub 源码部署

Zeabur 的 `ZEABUR_GIT_BRANCH` 和 `ZEABUR_GIT_COMMIT_SHA` 只在构建阶段提供。
Dockerfile 将这两个版本字段通过 `ARG`、`ENV` 留在镜像中，运行时显示对应的
分支和短提交号，例如 `d1004-1-0c589f4`。无需在运行镜像安装 Git。
字段依据 [Zeabur 官方文档](https://zeabur.com/docs/en-US/deploy/config/environment-variables)。

其他构建可使用 `SOURCE_REF`、`REVISION`、`SOURCE_COMMIT_DATE`；本地源码运行
读取当前 Git 分支、提交和时间。没有可信分支信息时，不把已保存的旧面板标签
当作当前分支；只保留可读取的提交号，或显示未知版本。

`panel-version.txt`、`version.txt` 及面板版本生成钩子未改动。手工面板标签不再
覆盖实际运行来源。现有版本响应字段保留，Management schema、capability 和
动作枚举无变化，manager 无需配套动作（`no_counterpart_action`）。

## 验证记录

只读核对 p08：绑定 `d1004-1`，部署提交为 `0c589f4`，旧版本接口仍返回
`dev8-20260907-1339` 和 `46e0b42`，确认运行版本与显示标签不一致。

隔离回归 61 项通过，包含版本来源、无 Git 的 Zeabur 场景、旧标签、缺失元数据、
旧检查参数、面板兼容、Management/OpenAPI 及 Legacy 路由。前端语法与差异检查通过。
用户已明确授权将本次修改提交并推送至 `d1004-1`。Zeabur 构建参数的实际注入
须在新部署后核对 `/version/info`，本地回归不代替线上部署验收。

回滚只撤销本次代码，保留原版本文件；旧代码会恢复手工标签与检查更新入口。
