# new-ui 源码交付

本分支保存 2026-10-16 已交付的六页管理界面与旧面板功能恢复源码。采用 shadcn/ui 暖灰浅色，六页独立加载；前端由 Antigravity CLI 开发，后端由 Codex 开发。总任务池为 [#40](https://github.com/lywx215/gcli2api/issues/40)。

## 本次范围

- 恢复凭证列表、手机卡片、详情、单项与批量操作、停止与安全结果详情。
- 接入独立 5H/周额度卡片与详情、已保存额度证据、原始模型额度、倒计时和到期缓存补读。缺失/不支持的额度保持未知，不用模型比例或滚动 168 小时推造周限额。
- 恢复导入页面、真实上传进度观察、RT 逐项失败原因和任务结果接线。
- 完成设置、概览、日志、模型路由、导航与渠道接线及既有诊断信息展示。
- 修复复核报告中的 12 组缺口及 7 项差异；列表异步请求按作用域和请求身份隔离。
- 后端只作向后兼容的增量改动。旧面板、旧接口和数据库 schema 保持；没有私有数据库或真实凭证入库。
- 不恢复 cancelled MGMT 工作或无关模型维护。

## 已有验证

发布前实际源码基线为 239bc48aab1d4db4f80e1197eb94e5ee7ae2c691 加完整未提交覆盖层，本提交将其纳入 Git。测试与构建对应此源码内容，无需只因提交重复执行。

- 18 个选定既有前端用例通过（13 个复用、5 个最终 Table 用例）；没有新增测试专项或全量重跑。
- npm run build（含 tsc --noEmit）退出 0。
- npm run check:build 退出 0：六个独立页面，18 个 JS 块、2 个 CSS、22 个完整产物，无开发 fixture 注入。
- 8 个隔离本地交付确认通过：生产 HTML/入口资源、旧面板、合成登录、双渠道缓存列表及上传进度能力鉴权。
- 后端既有 10 组合成证据复用，未重复后端大矩阵。
- 上述是限定交付证据，不表示所有真实账号业务场景均已运行通过。客户逐页人工确认尚未完成；当前本机预览用合成凭证，缺失 project 的凭证额度显示未知。

## 取得源码与构建

获取远程 new-ui 分支后，按仓库现有 Python/Node 依赖安装和启动方式运行；前端目录内使用 npm ci、npm run build 和 npm run check:build。生产产物输出到被 Git 忽略的 ui-dist/；依赖、产物、环境文件、凭证、数据库和本地开发授权状态不随提交上传。

公开需求见 [FULL_PARITY_REQUIREMENTS.md](FULL_PARITY_REQUIREMENTS.md)，后端增量见 [P2_BACKEND_INCREMENTS.md](P2_BACKEND_INCREMENTS.md)，上传观察契约见 [UPLOAD_PROGRESS_CONTRACT_20261015.md](gap-repair/UPLOAD_PROGRESS_CONTRACT_20261015.md)。CLIProxyAPI 参考源码及许可证保留在 [reference/cliproxy-quota](reference/cliproxy-quota/)。

仅发布 new-ui 源码分支，不合并生产分支、不打标签、不部署。Docker 和真实外部联调继续未执行；面板版本号按默认选择保持不变。此前文档里的“未推送”描述为其历史检查时点，本次推送由所有者另行明确授权。
