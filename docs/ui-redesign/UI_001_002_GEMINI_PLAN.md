# UI-001 / UI-002 最终界面重构与实施方案 (Gemini 评估与规划)

> **设计与评估者**：Gemini 3.8 Flash (High)\
> **评估日期**：2026-10-16\
> **需求批次**：UI-001 / UI-002\
> **目标范围**：右侧菜单栏布局重构、双凭证入口拆分、菜单底部退出登录、凭证搜索框紧凑化与错误分组/额度组常驻\
> **核心原则**：严格基于用户原话、保留全系统所有功能、两渠道概览导入能力不减、不改写路由/鉴权公共契约、保持暖灰紧凑令牌规范

---

## 1. 需求溯源与用户原话对照

### 1.1 UI-001 用户原话与客观事实

> **用户原话 1**：\
> *“界面调整：将头部的内容移动到其他部位， Anti凭证和cli凭证，分别作为单独菜单移到右侧菜单栏。退出登录，移到菜单栏底部。”*

* **基线事实分析**：
  * **菜单栏现有位置**：现有 `AppShell.tsx` 中桌面侧边栏 `<aside>` 位于左侧（`md:grid-cols-[13.5rem_minmax(0,1fr)]`，边框为 `border-r`）；手机端 `Header.tsx` 内使用 Sheet 抽屉，滑出方向为 `side="left"`。用户明确要求“右侧菜单栏”，必须以右侧为基准执行，不可保留或回退至左侧。
  * **两渠道现有入口**：当前在 `Header.tsx` 中通过 `changeMode("antigravity")` 与 `changeMode("geminicli")` 两个按钮切换渠道。用户要求将其从头部移出，并在右侧菜单栏中呈现独立的“Anti凭证”与“CLI凭证”菜单项。
  * **退出登录现状**：当前在 `Header.tsx` 右上角，调用 `useAuth().logout`。用户要求将其移动到菜单栏底部。
  * **其他头部内容去向**：现有 Header 还包含页面标题、当前渠道说明（“Antigravity” / “Gemini CLI” / “节点共享”）以及移动端导航汉堡按钮。根据用户原话“将头部的内容移动到其他部位”，桌面端将头部冗余标题/说明下沉至各业务页面首行，头部精简为轻量实用条（或完全融入工作区）；移动端保留必要的右侧抽屉唤起按钮。
  * **概览与导入的多渠道可达性**：用户原话虽只提及凭证拆分为两个菜单，但系统既有概览（Overview）和添加凭证（Import）同样存在两渠道页面。方案必须保证用户在移除 Header 切换后，依然能便捷进入 Antigravity / Gemini CLI 的概览与导入页面，绝不造成功能丢失。

---

### 1.2 UI-002 用户原话与客观事实

> **用户原话 2**：\
> *“界面调整：**搜索文件名或已保存邮箱**   入力框太大了，不需要那么大，腾出的位置可以放置其他功能 **错误分组**  和 **额度组**”*

* **基线事实分析**：
  * **搜索框现状**：当前 `FiltersPanel.tsx` 中搜索输入框设置了 `flex-1 min-w-[200px]`，在桌面宽屏视口下会拉伸占据 600px~800px 以上空间，造成严重的水平空间浪费。
  * **两组控件现有归属**：“错误分组”目前位于“高级筛选”折叠抽屉（`advancedOpen`）内，两渠道均支持；“额度组”同样位于折叠抽屉内，但仅由 Antigravity 支持，并受 `CAP_BY_MODE.antigravity.group` 能力标识管控。Gemini CLI 对应的高级项为 `Preview` 与 `CD`（冷却状态）。
  * **用户诉求本质**：缩小搜索框宽度，释放第一行常驻工具条的水平空间；将“错误分组”和“额度组”从二级折叠抽屉中提取出来，直接作为第一行常驻筛选器展示，大幅提升高频运维排错效率。
  * **能力与真实语义保护**：禁止为 Gemini CLI 伪造额度组后端能力；在 Gemini CLI 模式下，额度组位置自适应承载 GCLI 专属高频筛选项（如 `Preview`）或优雅占位，保持布局平衡；重置（Reset）、显式提交（Submit）、已生效高级计数（`appliedAdvancedCount`）需同步精确调整。

---

## 2. 总体架构与布局重构方案 (UI-001)

### 2.1 桌面端右侧菜单栏布局 (`AppShell`)

#### 2.1.1 栅格翻转与无障碍焦点流动
* **栅格重排**：
  将 `AppShell.tsx` 的全局容器由 `md:grid-cols-[13.5rem_minmax(0,1fr)]` 调整为：
  ```tsx
  <div className="min-h-svh md:grid md:grid-cols-[minmax(0,1fr)_13.5rem]">
  ```
  主内容区容器 `<div className="min-w-0">` 排在左侧，占据动态弹性宽度；侧边栏 `<aside>` 放置在右侧，固定宽度 `13.5rem (216px)`。
* **边框调整**：
  侧边栏由原先的右边框 `border-r` 调整为左边框 `border-l bg-background`，符合右侧停靠视觉边界。
* **无障碍跳转链接 (`Skip Link`) 保护**：
  保留 `<a href="#main-content">跳到主要内容</a>` 锚点，DOM 结构置于最前，通过 Tab 键可直接唤起并聚焦到 `#main-content`，不因侧栏移至右侧影响键盘无障碍合规性。

#### 2.1.2 视口自适应与滚动隔离
* 侧边栏保持 `sticky top-0 h-svh`，内部通过 `flex flex-col` 布局，保证上部菜单与底部退出按钮始终贴合视口顶部与底部，中间通过 `flex-1 overflow-y-auto` 支持超长内容平滑滚动，不干扰主内容区独立的垂直滚动条。

---

### 2.2 移动端响应式侧滑方案 (`Header` / `Sheet`)

* **右侧滑出抽屉**：
  移动端（`< 768px`）在 `Header.tsx` 中使用 Radix UI Sheet 组件，将滑出方向由 `side="left"` 明确改为 `side="right"`：
  ```tsx
  <SheetContent side="right" className="w-64 p-0">
  ```
* **汉堡按钮右置**：
  在移动端顶栏，将打开导航的汉堡按钮 `<Button aria-label="打开导航">` 放置在顶栏右侧，与抽屉从右侧滑出的心理预期保持一致。
* **抽屉内部复用**：
  抽屉内部同样渲染 `<Sidebar route={route} onNavigate={() => setOpen(false)} />`，点击任意导航链接后自动收起抽屉。

---

### 2.3 菜单项设计：双凭证入口与渠道联动 (`Sidebar`)

#### 2.3.1 菜单结构拆分
在 `Sidebar.tsx` 的导航列表（`<nav aria-label="主导航">`）中，废弃单一的“凭证”链接，显式拆分为两个独立同级菜单：
1. **Anti凭证**：
   * 图标：`KeyRound`
   * 目标链接：`#/credentials`（通过 `panelRouteHref("credentials", "antigravity")` 生成）
   * 激活判定：`route === "credentials" && mode === "antigravity"`
   * 视觉表现：激活时展现暖灰主色前置指示条及 `bg-selected font-semibold text-foreground`，并标记 `aria-current="page"`。
2. **CLI凭证**：
   * 图标：`KeyRound`
   * 目标链接：`#/credentials?channel=geminicli`（通过 `panelRouteHref("credentials", "geminicli")` 生成）
   * 激活判定：`route === "credentials" && mode === "geminicli"`
   * 视觉表现：激活时同样展现标准高亮指示条与 `aria-current="page"`。

#### 2.3.2 两渠道概览与导入的兼容支持
为满足事实清单中“移除 Header 切换后仍必须可到达两渠道概览与导入”的约束：
* **模式保持机制**：
  点击“Anti凭证”将全局渠道安全切换为 `antigravity`；点击“CLI凭证”将全局渠道安全切换为 `geminicli`。用户在此状态下点击“概览”或“添加凭证”，将自动沿用当前激活渠道（`panelRouteHref("overview", mode)` / `panelRouteHref("import", mode)`）。
* **概览/导入内的渠道辅助感知**：
  在 `Sidebar.tsx` 的“概览”和“添加凭证”旁，或在顶栏/页面首行保留当前生效渠道状态标识；当用户处于 Gemini CLI 渠道时，概览与导入明确标识为 `[CLI]`，确保用户对两渠道具有完全的掌控力。

#### 2.3.3 退出登录移至菜单栏底部
* **位置与布局**：
  在 `Sidebar.tsx` 底部 `div className="mt-auto border-t pt-3 space-y-2"` 区域内：
  1. 放置**退出登录**按钮：
     ```tsx
     <Button
       variant="ghost"
       size="sm"
       className="w-full justify-start text-[12px] h-8 text-muted-foreground hover:text-foreground hover:bg-hover px-2"
       data-panel-action="logout"
       onClick={logout}
     >
       <LogOut className="mr-2 size-3.5 shrink-0" aria-hidden="true" />
       退出登录
     </Button>
     ```
  2. 下方紧跟原有的**现有控制面板**外链（`#manage` / `#antigravity-manage`）及当前渠道说明文字，保持既有系统运维回退链路完整。
* **敏感状态清理保证**：
  点击退出登录直接触发 `useAuth().logout()`，完整调用既有 `registerSessionCleanup` 回调、注销验证令牌、重置物化数据与路由内部状态，绝不遗留内存凭证。

---

### 2.4 头部内容精简与下沉 (`Header`)

* **迁移后 Header 定位**：
  原 Header 中的退出登录已移至侧栏底部，凭证渠道切换已由“Anti凭证”/“CLI凭证”接管。
* **Header 重构形态**：
  * **高度压缩**：从 48px/64px 进一步精简为紧凑轻量条（高度约 36px ~ 40px），仅保留全局面包屑（例如 `gcli2api / 凭证管理`）、当前节点状态徽章与移动端导航触发器。
  * **桌面端沉浸体验**：各页面的核心 `h1`（如 `Antigravity 凭证` / `Gemini CLI 凭证`）由各页面主体首行独立承载，避免顶栏与内容区标题重复堆叠。

---

## 3. 凭证筛选工具条重构方案 (UI-002)

### 3.1 搜索框空间缩减与常驻栏尺寸规划

在 `FiltersPanel.tsx` 中，对第一行常驻工具条进行空间重构：

```
+----------------------------------------------------------------------------------------------------------------------------------+
| [搜索文件名/邮箱 (w-48)]  [状态 (w-32)]  [订阅等级 (w-32)]  [错误分组 (w-32)]  [额度组 / Preview (w-36)]  [应用筛选] [高级筛选 (1) v] [重置] |
+----------------------------------------------------------------------------------------------------------------------------------+
```

#### 3.1.1 搜索框尺寸约束
* 由原 `flex-1 min-w-[200px]`（无上限拉伸）调整为受控紧凑宽度：
  `w-full sm:w-44 md:w-48 lg:w-52`（约 176px ~ 208px 弹性格局）。
* 保留既有安全占位符：`placeholder="搜索不会触发邮箱补全"`；
* 保留 `maxLength={255}`，保留无障碍标签 `aria-label="搜索文件名或已保存邮箱"`。

#### 3.1.2 “错误分组”常驻提升
* 从折叠抽屉提取至第一行常驻栏；
* 适用范围：Antigravity 与 Gemini CLI 两个渠道均常驻展示；
* 控件定义：宽度 `w-full sm:w-32`，使用 `FilterSelect`，绑定 `draft.error`；
* 选项保持完整（10项）：`全部错误`、`无错误`、`403 全部`、`403 封禁`、`403 赋权`、`403 其他`、`429`、`401`、`400`、`500`。

#### 3.1.3 “额度组”常驻提升与渠道自适应
* **Antigravity 模式**：
  * 常驻展示“额度组”下拉选择框（宽度 `w-full sm:w-36`）；
  * 真实能力控制：`disabled={!caps.has(CAP_BY_MODE.antigravity.group)}`；
  * 选项完整保留（7项）：`全部额度`、`任意组受限`、`全部组未受限`、`Gemini 受限`、`Gemini 未受限`、`Claude / GPT 受限`、`Claude / GPT 未受限`；
  * 数据与状态绑定至 `draft.group`。
* **Gemini CLI 模式**：
  * 依据 `UI_001_002_BASELINE_FACTS.md` 明确要求：“不要为了两组入口新增后端能力或强行显示CLI额度组”；
  * 在 Gemini CLI 下，该常驻槽位无缝呈现 GCLI 专属高频筛选项 **Preview**（支持/不支持/全部），宽度 `w-full sm:w-32`，绑定至 `draft.preview`；
  * 保持第一行控件在两渠道下的布局均衡与视觉稳定性，Gemini CLI 用户同样获得首屏高频操作便利，且不伪造任何后端额度逻辑。

---

### 3.2 高级筛选抽屉与计数语义修正

#### 3.2.1 折叠抽屉瘦身
随着“错误分组”和“额度组”（或 GCLI 的 Preview）提升至常驻行，“高级筛选”折叠抽屉中仅保留低频配置项：
* **Antigravity**：权限版本（`family`: Opus 5.5 / Opus 4.6）、版本权限（`access`）、备注筛选（`remark`）与“仅无备注”勾选框；
* **Gemini CLI**：冷却状态（`cooldown`: CD中/Pro未CD/Flash未CD/未CD）、备注筛选（`remark`）与“仅无备注”勾选框。

#### 3.2.2 高级筛选激活计数 (`appliedAdvancedCount`) 精确重算
原计算逻辑将 `error` 和 `group` 计入高级筛选生效数。常驻化后，必须修正计数逻辑，**避免常驻可见项导致折叠按钮徽章误报**：
```tsx
const appliedAdvancedCount =
  (isGcli
    ? (appliedFilters.cooldown && appliedFilters.cooldown !== 'all' ? 1 : 0)
    : (appliedFilters.access && appliedFilters.access !== 'all' ? 1 : 0) +
      (appliedFilters.family && appliedFilters.family !== initialFilters.family ? 1 : 0)) +
  (appliedFilters.remark !== '__all__' ? 1 : 0);
```
此举确保只有真正隐藏在折叠抽屉内的生效条件才会累加至 `高级筛选 (N)` 徽章中，逻辑完全清晰。

---

### 3.3 响应式流式布局与小屏自适应

* **桌面宽屏 (≥ 1280px)**：
  搜索框、状态、等级、错误分组、额度组/Preview 与动作按钮组（应用筛选、高级筛选、重置）在单一水平行弹性排开，纵向高度仅占 32px，彻底释放纵向首屏空间。
* **中等屏 / 平板 (768px ~ 1279px)**：
  利用 `flex-wrap gap-2 items-end`，前 3 个控件占第一行，后 2 个控件与动作按钮排入第二行，各控件均保留明确文字标签，绝不产生重叠或文字切断。
* **移动端 (< 768px)**：
  在 `MobileControls` 折叠抽屉内，所有 Select 控件设为 `w-full` 垂直堆叠，满足粗指针触摸热区标准（高度 38px~40px）。

---

## 4. 视觉设计令牌与统一风格保证

本方案严格遵守项目暖灰风格系统（`WARM_GRAY_STYLE.md`）与紧凑设计规范（`COMPACT_UI_DESIGN.md`）：

| 界面元素 | 尺寸 / 高度 | 内边距 / 间距 | 字体 / 图标尺寸 | 颜色与边框令牌 |
| :--- | :--- | :--- | :--- | :--- |
| **右侧侧边栏** | 宽度 `13.5rem` (216px) | `p-3` 内边距 | 标题 14px / 导航 13px | `bg-background border-l border-border` |
| **导航链接项** | 高度 `h-8` (32px) | `px-2.5 py-1` | `text-[13px]`, 图标 16px | 激活：`bg-selected text-foreground font-semibold` |
| **退出登录按钮**| 高度 `h-8` (32px) | `px-2.5 py-1` | `text-[12px]`, 图标 14px | 次要强调：`text-muted-foreground hover:text-foreground` |
| **筛选输入框** | 高度 `h-8` (32px) | `px-2.5 py-1` | `text-[13px]` | `border-input bg-control-background` |
| **下拉选择框** | 高度 `h-8` (32px) | `px-2.5 py-1` | `text-[13px] leading-5` | 禁用态：`disabled:bg-secondary disabled:opacity-100` |
| **操作按钮** | 高度 `h-8` (32px) | `px-2.5` | `text-[12px] font-medium` | 主操作：`default` / 次操作：`outline` / `ghost` |

---

## 5. 最小逐文件实施清单与只读依赖

实施工作严格遵循最小修改面原则，仅对直接涉及布局与控件的 4 个前端文件及 1 个测试套件进行微创修改，严禁污染业务逻辑、API 契约或领域模型。

### 5.1 实施修改清单 (`Actual Allowed Files`)

1. `frontend/src/components/layout/AppShell.tsx`:
   * 将全局栅格调整为左主内容、右侧边栏（`md:grid-cols-[minmax(0,1fr)_13.5rem]`）；
   * 侧边栏边框由 `border-r` 调整为 `border-l`；
   * 保持无障碍跳转链接可用。
2. `frontend/src/components/layout/Header.tsx`:
   * 移除顶部已迁移的“退出登录”按钮与凭证渠道切换按钮；
   * 移动端 Sheet 展开方向改为 `side="right"`；
   * 移动端汉堡菜单按钮右置；
   * 精简头部标题与渠道描述。
3. `frontend/src/components/layout/Sidebar.tsx`:
   * 导航中将单“凭证”链接拆解为“Anti凭证”（`#/credentials`）与“CLI凭证”（`#/credentials?channel=geminicli`）；
   * 实现两项各自的激活高亮与 `aria-current="page"` 逻辑；
   * 在侧边栏底部容器增设“退出登录”操作项（`data-panel-action="logout"`，触发 `useAuth().logout`）；
   * 保留现有控制面板外链与说明。
4. `frontend/src/pages/credentials/FiltersPanel.tsx`:
   * 缩小搜索输入框宽度（`w-full sm:w-48 lg:w-52`）；
   * 将“错误分组”提升至第一行常驻栏；
   * 将“额度组”（Antigravity）/“Preview”（Gemini CLI）提升至第一行常驻栏，严格绑定能力鉴权；
   * 修正高级筛选激活计数器 `appliedAdvancedCount`；
   * 折叠抽屉中移出已常驻的冗余项。
5. `frontend/src/app/App.test.tsx`:
   * 适配测试用例中的导航链接查找：将原有遍历中针对单一 `"凭证"` 的点击拓展为验证 `"Anti凭证"` 与 `"CLI凭证"`；
   * 验证侧栏底部“退出登录”按钮正常触发注销；
   * 确保整套集成测试绿灯。

### 5.2 核心只读依赖清单 (`Read-Only Dependencies`)

在实施过程中严禁修改以下底层依赖文件，仅供类型引入与契约调用：
* `frontend/src/app/routes.ts`：路由定义、`panelRouteHref`、路由守卫与快照获取；
* `frontend/src/app/channels.tsx`：`usePanelChannel`、渠道上下文及模式变更回调；
* `frontend/src/auth/AuthProvider.tsx` & `frontend/src/auth/session.ts`：鉴权状态机、`logout`、会话生命周期与清理机制；
* `frontend/src/domain/panel.ts`：`PanelMode` 核心领域类型与快照方法；
* `frontend/src/pages/credentials/model.ts`：`CAP_BY_MODE`、`Filters` 结构体及默认状态；
* `frontend/src/styles/theme-warm-gray.css`：暖灰主题令牌变量。

---

## 6. 兼容性、离开保护与回退保障

1. **路由守卫与未保存保护**：
   从“Anti凭证”切换到“CLI凭证”（或点击其他导航链接），其本质仍为触发 `window.location.hash` 变更。现有 `routes.ts` 中的 `registerRouteGuard` 机制完全生效，若用户在“设置”页有未保存草稿，将正常拦截并弹窗提示，不因菜单拆分产生穿透漏洞。
2. **敏感退出清理一致性**：
   侧栏底部退出登录直接调用既有 `logout()` 句柄，触发 `AUTH_STORAGE_KEY` 移除与 `registerSessionCleanup` 广播，所有内存数据、详情弹窗、物化选择集即刻物理销毁，彻底杜绝数据泄露。
3. **旧版 URL 别名兼容**：
   外部书签或旧入口 `#manage` 与 `#antigravity-manage` 继续分别标准化重定向至 `#/credentials?channel=geminicli` 与 `#/credentials`，与新菜单栏中“CLI凭证”与“Anti凭证”的高亮状态完全对应。
4. **额度语义与指标真实性**：
   不为 Gemini CLI 新增虚拟额度组，Antigravity 额度组严格遵守后端上报的 capability；继续保留 5H 与周额度百分比条的真实物理剩余含义，绝不制造伪造数据。

---

## 7. 验收标准与验证方案 (Verification & Acceptance)

> *注：当前规划阶段不运行 shell 或命令，以下为实施交付后由 Codex 执行的命令验证与用户人工验收矩阵。*

### 7.1 命令验证套件 (Codex 后续执行)
* `pnpm --dir frontend test -- --run src/app/App.test.tsx`：验证完整登录、两渠道菜单导航与退出流程；
* `pnpm --dir frontend test -- --run src/app/routes-modes.test.tsx`：验证路由模式切换与守卫机制；
* `pnpm --dir frontend test -- --run src/app/channels.test.tsx`：验证渠道状态提供者稳定性；
* `pnpm --dir frontend build` (或 `tsc -b frontend`)：确保纯净类型检查与构建无报错。

### 7.2 交互与视觉人工验收矩阵

| 序号 | 验证场景 | 预期表现 | 覆盖需求 |
| :---: | :--- | :--- | :---: |
| 1 | **桌面菜单位置** | 视口宽 1440px 下，导航菜单栏固定展示在屏幕右侧，具有清晰左边框分隔 | UI-001 |
| 2 | **双凭证独立菜单** | 菜单中包含“Anti凭证”与“CLI凭证”，点击分别直达对应渠道并正确高亮指示条 | UI-001 |
| 3 | **底部退出登录** | 侧边栏底部清晰可见“退出登录”按钮，点击后清除凭证数据并返回登录界面 | UI-001 |
| 4 | **搜索框宽度** | 凭证页“搜索文件名或已保存邮箱”输入框宽度约 200px，不再贯穿占满全屏 | UI-002 |
| 5 | **错误分组常驻** | 错误分组下拉框在第一行常驻可见，能即时筛选 403/429/500 等错误码 | UI-002 |
| 6 | **额度组常驻 (AG)** | Antigravity 渠道下额度组常驻第一行，可直接筛选 Gemini/Claude 等组受限状态 | UI-002 |
| 7 | **GCLI 筛选项协调**| Gemini CLI 渠道下不伪造额度组，相应槽位显示 Preview 筛选，布局不坍塌 | UI-002 |
| 8 | **高级筛选抽屉瘦身**| 点击“高级筛选”，展开抽屉仅含权限版本/备注等低频项，徽章数字计数真实反映抽屉内生效项 | UI-002 |
| 9 | **移动端响应式** | 手机视口 (< 768px) 下点击顶栏右侧汉堡图标，菜单自右侧向左滑出，各控件可触摸操作无裁切 | UI-001/002 |
