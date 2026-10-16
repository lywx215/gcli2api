# Antigravity 模型迁移及 UI 分支兼容合并

2026-10-16，将 2026-10-13 本地未提交迁移合入 `new-ui`；保留当前 Opus 4.6 Thinking、Opus 5.5 三档、自定义路由、额度目录缓存及 Token 刷新字段保全。

## 精确迁移和退役

- 3.6 / 3.7 Flash 的 high、medium、low 精确迁移到同档 3.8 Flash；裸名 3.5、3.6、3.7 Flash 默认 3.8 Flash Medium，3.8 裸名继续 Medium。
- 先处理原有功能前缀；转换器的已有后缀语义与迁移组合，不泛化改写未知或相似的服务模型名。
- 仅退役 `gemini-3.1-pro`、`gemini-3.1-pro-high`、`gemini-3.1-pro-low`、`gemini-pro-agent`。返回本地 404 `Resource unavailable.`；在凭证读取、OAuth、上游调用及状态结算前停止。
- 公共目录移除旧 Flash 档位及退役 Pro，并保留当前 Opus 版本。静态目录现为 9 个基础 ID，按现有三种功能形式投影为 27 项；仍与实际已观察的上游目录取交集，不保证账号可调用性。
- 原始额度 ID、余额、重置时间和缺失值保留；隐藏仅表示展示策略，不推断为不可用。旧 22-ID 合成快照不是当前目录数量承诺。

## 路由兼容

保留当前 route_context、显式目标检查、响应身份重写和超时策略；纯策略镜像采用与真实转换器相同的精确迁移规则。退役目标在配置校验中拒绝，启用和禁用行均检查；不会自动写回已有路由配置。

源码校验保持固定指纹及未知源码拒绝。当前 UI 分支在 AuthCallbackRequest 和 AuthCallbackUrlRequest 增加了默认 True 的 include_credentials 字段；本次仅同步该既有、已核对的 models.py 指纹，不修改认证行为。

策略源码指纹按进程缓存。运行中的后端不会因合并文件而确认加载新规则；本次不主动重启主窗口服务。

## 人工测试实际版本

仅操作级增量能力 `antigravity.test.model_version` 与可空 `upstream_model_version`。成功生成且通过原有校验后，从上游 modelVersion 读取并整串验证；不从请求别名猜测，不写入日志或数据库。

旧面板合并既有显示补丁；新 React 页面由官方 Antigravity CLI / gemini-3.8-flash-high 接入。缺能力提示旧节点，支持但无值提示上游未返回；失败时不展示版本。

## 验证与边界

使用当前工作树的独立源码副本、临时 SQLite、合成响应和外网阻断验证。Windows 使用 Selector 事件循环；测试网络隔离只豁免标准库 socketpair 的本地 IPC 建立，普通网络连接仍拒绝。

当前验证明细及文件哈希见本次合并记录。2026-10-13 的 1707+27 项测试是旧基线证据，不替代本次新分支验证。

不迁移数据库，不改真实凭证、Management schema / capability、panel-version.txt 或 Gemini CLI 专属行为；manager 无配套动作（no_counterpart_action）。未提交、推送、部署或执行 Docker。回滚仅恢复本次文件补丁，不清空任何数据。
