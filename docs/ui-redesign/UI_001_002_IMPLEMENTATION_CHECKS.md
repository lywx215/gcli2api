# 实施兼容核对补充

接受Gemini自主制定的UI_001_002_GEMINI_PLAN.md总体视觉方案；以下是Codex事实/验收约束，不是另选视觉方案。

1. 路由实际行为：routes.ts parseFragment没有channel参数时explicitChannel为undefined，transition可能继续acceptedMode。因此panelRouteHref(credentials,antigravity)生成的无参数链接本身不足以保证从CLI回Anti。已有navigatePanel(route,mode?)支持显式模式并执行transition守卫；也有显式channel解析。由Gemini选择符合现有契约的最小安全接线，不改routes/channels/auth底层，不把先无保护切换模式再导航作为替代。实现后必须实际验证CLI凭证→Anti凭证，以及设置草稿存在时点击任一凭证入口的离开保护。保留a链接可达性与修饰键打开链接行为。
2. 退出仍必须用现有useAuth.logout，桌面和手机仅当前可见菜单可操作，不保留头部重复退出。菜单底部保留旧面板回退入口；位置和样式仍由Gemini决定。
3. 不新增虚构“节点状态”或任何无数据源的徽章；沿用真实已有渠道/页面说明即可。两渠道概览与导入均可达并能明确感知当前渠道。
4. 筛选仍为draft+显式应用：搜索/下拉变化不自动请求，不触发邮箱补全。计划表中“即时筛选”不得解释为onChange自动提交。移动到主行的错误/额度/Preview选项保留完整原值、capability与规范化语义。高级计数只计隐藏且已应用条件。
5. 手机控件保留已验收的输入16px及粗指针点击区域，按钮/导航/退出文字不得裁切、底部不可被挤出而无法到达。不扩大到其它页面或新CSS系统。
6. 现有项目使用npm并已离线npm ci就绪，计划里的pnpm/tsc-b只是建议文本，验收将使用npm run build（含tsc --noEmit）、npm run check:build与本次实际相关的定点既有兼容测试。不要启动新增测试专项、不要要求全量矩阵。
7. App.test.tsx只适配受本次入口迁移影响的查找，并补足这次真实风险覆盖；不能删除、skip或放宽原业务保护断言来让测试通过。其它测试与业务层为只读。

实际桌面1440x900合成基线：aside位于x=0，宽216；搜索宽约624，筛选容器宽1177。此为实测事实，不预设实现尺寸（尺寸由Gemini方案决定）。
