# 总控窗口启动提示词

将以下内容作为总控窗口的人类启动指令。只有用户实际发送，才构成实施/有限恢复授权；保存本文件不启动任何任务。

> 我要求从最新 origin/master 开始实施这份模型路由任务包，并且仅为本次公开模型名称路由、响应身份、必要保真及其回归恢复所需的 Gemini CLI 开发，不恢复其它 CLI 维护或已取消的 MGMT 待办。排除 Vertex，不调用 Claude。
>
> 请先执行 MR00。在独立的总控 worktree 工作，不切换或覆盖现有 dirty checkout；完成统一 master 基线、实际兼容行为、最小共享类型和合同门禁。不要自动创建/启动其他 Codex 窗口或向其他任务发消息。MR00 通过后报告三份 worker 启动条件和路径，等待用户分别启动 R/P/S。
>
> R/P/S 交付后，我再要求你继续 MR10/MR11 时进行指定文件整合、唯一六处理器接线及联合验收；当前不要提前实现它们。不要commit/push/部署、改凭证/正式DB或运行真实模型测试。

当前任务仅 CLI 和 Antigravity，排除 Vertex、manager/MGMT、手动凭证/导入改造、真实数据与部署。使用 GPT-6 Astra。不要调用 Claude 或共享 review Hook。
原始任务包位于 G:/code/gemini30/gcli2api/docs/model-routing。开始先完整读取 README.md、SPEC.md、CONTRACTS.md、TASKS.md、manifest.json 和最新master的AGENTS.md/维护范围。当前原始checkout是dirty dev0916，不得在其中写业务代码。
代码基线必须由MR00锁定的origin/master提交，当前参考170d989f545218920bc84794472a0f234490694f；不是dev8/dev0916。各窗口独立worktree/分支，不独自pull，不拷贝creds/.env/日志/真实数据库。
仅修改本窗口独占文件。共享types/合同改动提交总控处理；不修改对方文件。默认不commit/push/开PR/合并/部署，不bump panel-version，不绕过hook。交付指定文件diff、新文件清单和实际测试回执。
测试先隔离临时CREDENTIALS_DIR/存储、mock全部Google/OAuth/refresh/listing；不启动默认web lifespan，不读取生产凭证。只在本窗口的master代码上验证；mock结果不算真实依赖通过。
master已有protected/events/退休检测/安全错误/额度预算/单次统计与关闭链，必须增量保留，不从旧方案重写。默认fixed errors/local-only Retry-After保持，不改fixture掩盖回归。
Claude历史未通过不阻止本次按用户明确task开发，也不能伪造已通过。缺门禁/授权/证明时准确停止对应写入，其他只读准备可继续。无跨任务自动消息或自动运行；回执只作本地queue_only交付。

## 本窗口专属检查

- 只拥有MR00及后续MR10/MR11。types.py、包__init__、公共合同和六处理器/目录入口/normalizer由你独占。
- MR00重新核对master远端；若已前进，在worker开工前统一repin；记录有限CLI授权和master停止维护的范围例外，不能把任务视为整体恢复维护。
- 先核对master已有AG三协议aliases、native前置重定向、家族思考/采样规则、公开目录交集、受保护错误/retirement/Completion。历史review-plan不作为旧链truth。
- 创建最小共享types/合同测试；不实现R/P/S算法。通过前worker只能做只读/mock准备。
- 三个worker材料只复制显式docs/types/fixture并核验hash，不复制整个dirty工作区；未经批准提交可交付指定文件patch。
- 缺少四后端测试服务、浏览器或无法证明的签名/续传组合均准确列unverified，不计为完整验收。
