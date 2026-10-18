# 额度卡片中文文案与退役模型显示修正

需求：用户2026-10-16截图要求减少英文，保留Gemini、Claude等固有名称，Gemini Models显示Gemini 模型，Claude分组显示Claude模型，不再显示GPT-OSS相关内容。范围仅卡片展示，不下线后端模型、不改共享额度计量。

目标工作树：`C:/Users/lywx2/.codex/worktrees/ui-full-parity/gcli2api`，分支new-ui，当前交付70e6bf5。不要改G主目录。当前联网宿主65476读取该工作树ui-dist；旧隔离5193与两套私有数据不动。

## 具体呈现

| 当前显示 | 目标显示 |
| --- | --- |
| Gemini Models | Gemini 模型 |
| Claude and GPT Models | Claude模型 |
| Models within this group: Gemini Flash, Gemini Pro | 包含模型：Gemini Flash、Gemini Pro |
| Models within this group: Claude Opus, Claude Sonnet, GPT-OSS | 包含模型：Claude Opus、Claude Sonnet |
| Five Hour Limit Remaining | 5小时剩余额度 |
| Weekly Limit Remaining | 每周剩余额度 |

Gemini、Claude、Flash、Pro、Opus、Sonnet、Antigravity固有名称保持原名与大小写。不要翻译真实凭证文件名。标题若CSS text-transform:uppercase造成全大写，应让上述固有名称按给定大小写显示。

GPT-OSS只从显示标题/模型说明/专属展示项中隐藏，保留Claude与GPT共享组的真实额度桶、比例和重置时间。不得因为混合组曾含GPT而移除整个Claude组；不得把共享额度声明为Claude独占；不得修改group_id、bucket_id、window、fraction、reset或原始API响应。若确有单独GPT-OSS展示组可隐藏该展示组，不影响其他组。未知组/品牌保持原名，避免猜译；仅对已知通用窗口使用中文标签，不根据标签推断window。

## 定位与归属

`frontend/src/pages/credentials/quota/QuotaCard.tsx`直接显示group.display_name、group.description，resolveGroupBuckets优先使用b.display_name，故上游英文穿透。`src/panel/quota_summary_normalize.py`忠实保留白名单名称；本次不通过改后端DTO绕过前端归属要求。

前端源码、样例及测试仍须由官方Antigravity CLI编写；本简报不构成Hook开发授权。待人类按AGENTS.md明确激活本次开发后再派发，不复用先前grant。CLI开发应包括项目AGENTS.md、docs/MAINTENANCE_SCOPE.md、本简报和必要卡片源码上下文。不得附真实截图、私有库、密码、Token或完整业务文件名；仅用合成结构示例。

## 最小验证与交付边界

检查已知英文标签中文化、品牌大小写、混合组去除GPT-OSS但保留Claude及原始额度、0%与100%语义、未知组与缺失窗口语义。按实际变更运行必要定点验证、类型检查、生产构建及既有产物检查；不重复全量测试或真实Google额度调用。只需本地构建更新ui-dist供现有65476托管，不重启服务、不动数据、不提交/推送/部署、Docker跳过。报告实际修改文件与验证结果。
