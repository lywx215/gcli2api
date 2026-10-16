# UI-001 / UI-002 已同步基线事实

本聊天独立工作树从70e6bf5建立，再同步主窗口最终验收清单中177个前端文件，所有SHA-256精确匹配。不是旧70e6bf5界面。没有复制真实后端/凭证/数据库。仅实现固定的UI-001、UI-002；需求文件里旧准备状态不代表当前授权或基线。

实际现状：AppShell桌面aside在左侧，Header手机SheetContent side=left。用户明确要求右侧菜单栏，必须按原话评估，不可默认为左侧。两渠道现有入口为Header中的changeMode按钮；原有导航锚点通过panelRouteHref和路由守卫工作。退出Header用useAuth.logout，不能另造不清状态的退出行为。可由Gemini决定右侧布局如何落地；仅在发现无法从明确需求消解的实质歧义时报告。

FiltersPanel现有主行包含搜索、状态、订阅等级、应用、高级、重置。错误分组在advancedOpen中，两渠道均有；额度组也在advancedOpen中，仅Antigravity，受CAP_BY_MODE.antigravity.group控制。Gemini CLI高级项为Preview/CD，继续保留，不要为了两组入口新增后端能力或强行显示CLI额度组。保留normalizeFilters、draft与已应用状态、显式submit、reset以及capability禁用语义。把常驻化后的计数语义保持清楚；Codex不决定具体视觉呈现。

保留概览/导入两渠道选择能力：如果移除Header切换，必须仍可从菜单或Gemini决定的位置到达原有两渠道概览和导入。设置离开保护不能被普通导航或渠道切换绕过。旧控制面板入口也要保留。

全部布局、尺寸、间距、配色、控件实现和前端代码/必要测试仅由Gemini决定及交付；Codex只核验事实、范围、兼容和验收。不要执行shell、真实请求或模型探测。继续shadcn/ui暖灰风格及已接受紧凑化，无提交/推送/部署。

本次先输出最终方案与逐文件实施清单，不写源码。计划须声明actual allowed_files（单独文件路径）、必须只读依赖、兼容风险与必要定点验证。实施优先沿用现有公共契约，不因菜单呈现改造重写路由/鉴权。若确需改动这些逻辑，先在方案中说明证据及最小范围。
