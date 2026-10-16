# gcli2api 双屏统一响应式布局规格重新评估与实施方案

> **评估与设计者**：Gemini 3.8 Flash (High)\
> **修订基线**：2026-10-16（根据真实设备信息、视口假设与工程可实施性要求全面重审修正）\
> **视口与设备目标**：
> 1. **大屏候选目标**：32寸显示器，1920×1080 物理分辨率。推导基于“浏览器窗口最大化且浏览器缩放为 100%”的明确工程假设（明确操作系统缩放 100% 不等同于浏览器缩放 100%），要求充分利用侧栏以外可用空间，弹性利用大屏宽度展现高密度内容，杜绝外层无意义留白；
> 2. **小屏候选目标**：13寸 MacBook Air。鉴于具体机型（13.3寸或13.6寸代际）、macOS 缩放档位、系统菜单栏与 Dock 栏停靠/隐藏状态以及浏览器实际视口尺寸尚未现场实测确认，方案**不预设任何硬件与视口既定事实**，统一以候选测试视口（如 1440×900、1470×956 或 1280×800）作为设计参考场景，按浏览器 CSS 可用宽高响应，兼顾紧凑清晰与有限视口高度；
> 3. **全系统统一要求**：统一六大核心页面的响应式规则、基线对齐与操作习惯，而非机械套用单一固定像素宽度。\
> **交付边界**：本交付物仅为**自主布局规格评估与工程实施方案文档**，严格不修改任何前端源码与测试用例，不执行 Shell 命令，不调用后端真实业务接口与模型探测，不假定未测事实，所有预期展示能力均标明为“设计目标，待后续实施后实测”。

---

## 1. 执行摘要与旧版 1280px 方案重审

### 1.1 旧版 1280px 居中方案（`UNIFIED_PAGE_LAYOUT_GEMINI_EVALUATION.md`）缺陷重审
在此前的初步评估中，为了防止极端超宽屏下出现无节制单行拉伸，曾提出全系统统一采用 `max-w-7xl` (1280px) 并在外层采用 `mx-auto` 居中的方案。经过结合用户明确的 32寸 1920×1080 大屏与 13寸 MacBook Air 小屏使用诉求的深度审视，**确认此前的 1280px 固定居中方案不符合用户的核心使用目标，不能作为已批准的实施规格，必须予以废止和重构**：

1. **大屏场景（32寸 1920×1080 候选场景）的推导假设与留白缺陷**：
   - **浏览器窗口与缩放假设**：系统显示缩放 100% 不自动等同于浏览器渲染视口为 1920px。本推导明确建立在以下工程假设之上：① 用户将浏览器窗口最大化或全屏运行；② 浏览器自身缩放比例（Zoom Level）保持为 100%；③ 采用现代桌面浏览器的标准视口解析（在无系统经典垂直滚动条常驻侵占或视口宽度为 1920 CSS 像素的前提下）；
   - **主内容列与内容盒净宽推导**：在 1920px CSS 视口宽度下，扣除右侧 `13.5rem` (216px) 固定侧边栏后，左侧主内容列（Main Column）可用宽度为：
     $$W_{\text{Main\_Col}} = 1920\text{px} - 216\text{px} = 1704\text{px}$$
     页面 `<main>` 容器在桌面端（`md:` 断点以上）具有 `p-3 md:p-4` 内边距（左 16px、右 16px，合计 32px 水平内边距）。扣除该 padding 后，主内容区净内容盒（Content Box）宽度为：
     $$W_{\text{Content\_Box}} = 1704\text{px} - 32\text{px} = 1672\text{px}$$
   - **巨大外层留白**：若强行施加 1280px 上限并在内容盒内使用 `mx-auto` 居中，内容盒内部两侧将产生：
     $$(1672\text{px} - 1280\text{px}) / 2 = 196\text{px} \quad (\text{两组合计 } 392\text{px})$$
     这导致 392px 的可用宽度被完全浪费为无意义的空白区域；
   - **人为压缩数据密度**：在 1672px 的净内容盒内，`credentials`（凭证表格）的 6 个核心数据列被压缩在 1280px 内，多列排布局促；`overview`（概览）的统计报表无法舒适并排；`logs`（运行日志）长文本被过早折行；完全违背了用户“**大屏尽量显示更多内容、避免无意义外层留白**”的明确要求。

2. **小屏场景（13寸 MacBook Air 候选测试场景）的视口高度审视**：
   - **硬件与视口未确认声明**：13寸 MacBook Air 涉及不同代际（例如 13.3寸常见默认逻辑视口 1440×900 或 1280×800，13.6寸常见默认逻辑视口 1470×956），且 macOS 系统层面的显示缩放档位（“更多空间”、“默认”、“较大文字”）、系统顶部菜单栏显隐、底部 Dock 栏常驻或自动隐藏以及浏览器窗口外壳（标签栏、地址栏、书签栏）均具有高度不确定性。因此，**1440×900、1470×956 以及 600px~720px 高度仅作为候选测试场景与工程设计参考，并非已现场确认的硬件事实**；
   - **有限视口高度的工程考量**：在实际笔记本使用中，扣除系统外壳与浏览器工具栏后，浏览器可用视口高度往往较为受限。旧方案完全忽视纵向高度约束，若页面垂直间距过大、筛选面板展开过高或浮动底栏占高失控，将大幅挤压数据可视区域。

3. **机械居中导致的横向跳跃与认知负荷**：
   - 若某些页面使用居中（`mx-auto`），而表单页面为了阅读舒适度收窄，用户在右侧固定侧栏高频点击切换页面时，页面主标题和内容主体在屏幕水平轴上前后剧烈跳动，不仅破坏视觉秩序，也无法形成一致的操作预期。

### 1.2 重新评估后的核心架构决断
本评估报告独立推翻旧方案，确立全新的**“统一弹性基准画板（Unified Fluid Canvas）+ 内容类型化宽度策略（Content-Type Width Strategy）+ 统一靠左基线对齐（Left-Aligned Baseline）+ 紧凑高度自适应防护（Height-Aware Compactness）”**规格体系：
- **统一靠左基线对齐**：全六页外层统一放弃 `mx-auto` 居中，统一以 `<main>` 容器的左边缘（`p-3 md:p-4`，距主内容列左侧 16px）为绝对基准线靠左排布。切换页面时，页面主标题、操作条与首列容器**绝对零水平抖动**；
- **大屏数据区域全面弹性放开（Fluid Bleed for Data）**：表格、日志终端、模型路由双列工作台、概览报表放弃 1280px 人为枷锁，在大屏上完全充满主内容列（在 1920px 视口假设下净内容盒达 1672px 满幅展示），最大化展现列数据、长日志与双列对照；
- **内容类型化明确宽度（Content-Type Width Strategy）**：表单录入与配置字段按内容类型明确唯一最终值。单列录入流（添加凭证页）严格采用 `max-w-3xl`（768px）靠左阅读封套；系统设置页因包含双列卡片及 5 列差异对照表，统一采用 `w-full max-w-[1720px]` 大画板展开；
- **紧凑高度防护规则（Height-Aware Compactness）**：由 Gemini 自主设计 `@media (max-height: 720px)` 紧凑高度响应规则（作为工程设计规则而非已测设备事实），收紧垂直间距；浮动底栏锁定最大占高并严格避让右侧固定侧栏；
- **日志高度单一可行策略**：废弃多选项摇摆，采用基于 Flex 容器的自适应高度策略，动态吸收工具栏折行高度，最小高度不引发整页横向溢出；
- **模型路由保持既有表格结构**：窄屏与移动端降级保持既有表格结构并支持容器内横向滚动（`overflow-x-auto`），严格不引入未要求的卡片编辑流新实现。

---

## 2. 真实六页与全局布局现状事实表（基于 snapshot 源码）

基于当前交付源码快照 `snapshot/frontend/src/` 的真实数据审计事实如下：

| 页面 / 组件 | 源码路径与根节点真实类名 | 现状宽度限制 | 现状水平对齐 | 浮动/固定操作栏现状 | 1920px 表现与问题（假设窗口最大化且缩放100%） | MacBook Air 表现与问题（候选视口场景） |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **AppShell** | `components/layout/AppShell.tsx`<br>`md:grid md:grid-cols-[minmax(0,1fr)_13.5rem]` | 无限制 (100vw) | 栅格左主右侧 | 无 | 主内容列 1704px，扣除 padding 后内容盒 1672px；右固定 216px 侧栏 | 在 1440px 候选视口下，主内容列 1224px，扣除 padding 后内容盒 1192px；侧栏占用 216px |
| **概览** | `pages/overview/index.tsx`<br>`section.space-y-3.5` | 无上限 (Fluid) | 靠左拉伸 | 无底栏 | 宽度拉满，但 `StatisticsTables` 触发 `xl:grid-cols-2` 双列表格，端点卡片横向拉长 | 单列卡片与双列平稳，高度受限时内容易产生纵向多屏滚动 |
| **凭证管理** | `pages/credentials/index.tsx`<br>`section.min-w-0.space-y-2.5` | 无上限 (Fluid) | 靠左拉伸 | `fixed left-0 right-0 z-40`<br>内嵌 `max-w-7xl` | 表格铺满，但浮动批量坞全屏居中，与左主列错位且遮挡侧栏底部退出项 | 表格容纳 6 列数据；在 1440px 候选视口（内容盒 1192px）下紧凑可用，底栏遮挡侧栏退出项 |
| **添加凭证** | `pages/import/index.tsx`<br>`section.mx-auto.max-w-4xl` | `max-w-4xl` (896px) | 居中 `mx-auto` | 模态确认窗口，无底栏 | 居中收缩至 896px，左边缘向内偏移约 388px，与其它页面严重不同轴 | 居中收缩，页面间切换时主标题横向跳跃明显 |
| **系统设置** | `pages/settings/index.tsx`<br>`div#settings-content.mx-auto.max-w-6xl` | `max-w-6xl` (1152px) | 居中 `mx-auto` | 内联保存栏，无底栏 | 居中收缩至 1152px，左边缘向内偏移约 260px，与概览/凭证不同轴 | 在 1440px 候选视口下内容盒为 1192px（$1192\text{px} > 1152\text{px}$），因居中产生两侧各 20px 边距，出现横向抖动 |
| **运行日志** | `pages/logs/index.tsx`<br>`section.space-y-2` | 无上限 (Fluid) | 靠左拉伸 | `LogViewer`<br>`h-[calc(100vh-160px)]` | 终端铺满，工具栏横向单行舒展 | 固定扣除 160px；若视口变短或工具栏折行，容易诱发整页外层滚动条 |
| **模型路由** | `pages/model-routing/index.tsx`<br>`div#routing-content.mx-auto.max-w-7xl` | `max-w-7xl` (1280px) | 居中 `mx-auto` | `fixed left-0 right-0 z-20`<br>内嵌 `max-w-7xl` | 主体收缩至 1280px 居中；固定底栏全屏居中并遮挡侧栏退出项 | 双列对比窗格在窄屏下挤压表格；底栏遮挡侧栏底部 |
| **登录屏** | `auth/LoginScreen.tsx`<br>`main.grid.min-h-svh.place-items-center` | `max-w-sm` (384px) | 视口绝对居中 | 独立无菜单 | 独立全屏居中卡片，体验聚焦 | 独立全屏居中卡片，体验聚焦 |

---

## 3. Gemini 自主决定的双屏统一响应式规格体系

本规格体系确立一套全系统通用、统一且无歧义的最终视觉值，**完全取代此前的 1280px 居中方案**。

### 3.1 外层画板与对齐基准（Unified Left-Aligned Canvas）

```
+---------------------------------------------------------------------------------------------------------+
| Header: gcli2api 节点控制台 [页面标题]                                                    [打开导航 (移动)]|
+--------------------------------------------------------------------------------------+------------------+
| <main id="main-content" className="min-w-0 p-3 md:p-4 outline-none">                 | <aside           |
|   +--------------------------------------------------------------------------------+ |  className="     |
|   | <div className="w-full max-w-[1720px] min-w-0 space-y-3 md:space-y-3.5">       | |  sticky top-0    |
|   |   [Page Title & Action Ribbon] (左基线绝对对齐 X = 16px)                         | |  h-svh border-l  |
|   |   +--------------------------------------------------------------------------+ | |  w-[13.5rem]     |
|   |   | [模式 A: 满幅数据密集流 (w-full)]                                         | | |  hidden md:block |
|   |   |   凭证表格 / 概览双报表 / 终端日志 / 路由工作台 / 设置双列网格与差异表      | | | ">               |
|   |   +--------------------------------------------------------------------------+ | |    Sidebar       |
|   |   | [模式 B: 靠左单列阅读封套 (max-w-3xl / 768px, 无 mx-auto)]                | | |    (216px)       |
|   |   |   添加凭证表单 / OAuth / Token 文本框 / 邮箱任务卡片 (右侧自然留白)       | | |                  |
|   |   +--------------------------------------------------------------------------+ | |                  |
|   +--------------------------------------------------------------------------------+ |                  |
| </main>                                                                              |                  |
+--------------------------------------------------------------------------------------+------------------+
| [Fixed Floating Dock] (left-0 right-0 md:right-[13.5rem])                            |                  |
|   +--------------------------------------------------------------------------------+ |                  |
|   | Inner: w-full max-w-[1720px] px-3 md:px-4 flex items-center justify-between     | | (侧栏底部完全避让) |
|   +--------------------------------------------------------------------------------+ |                  |
+--------------------------------------------------------------------------------------+------------------+
```

#### 3.1.1 核心度量数值与类名定义
1. **统一外层根节点容器（Unified Outer Page Class）**：
   - **类名**：`className="w-full max-w-[1720px] min-w-0 space-y-3 md:space-y-3.5"`；
   - **绝对不使用 `mx-auto`**：由外向内保持自然靠左，与 `<main>` 的内边距通道精准咬合；
   - **最大宽度安全上限 `max-w-[1720px]`**：
     - 在 1920×1080 最大化浏览器视口下，主内容列为 1704px，扣除 `md:p-4`（32px）后的内容盒净宽为 1672px。因 $1672\text{px} < 1720px$，大屏实现 100% 满幅利用，绝无外层冗余留白；
     - 在更宽视口（如 2K 2560px 或超宽显示器）下，内容盒净宽达到 $2560 - 216 - 32 = 2312px$。此时页面优雅收敛至 1720px 上限，避免超大屏下视觉焦点过度离散。
2. **统一水平绝对对齐坐标（Zero-Shift Horizontal Alignment）**：
   - 依赖 `AppShell` 的 `<main id="main-content" className="min-w-0 p-3 md:p-4 outline-none">`；
   - 在桌面端（$\ge 768px$），所有页面的页面标题、副标题描述、操作按钮条左边缘，相对于主内容列左侧的理论坐标恒定为：
     $$X_{\text{Page\_Left}} \equiv 16\text{px} \quad (\text{md:p-4 的 padding-left})$$
   - 无论页面内部是充满表格还是收窄表单，**页面顶栏基线与标题位置在全系统六个页面切换时绝对固定在 X = 16px，零横向跳跃，操作习惯高度统一**。
3. **垂直间距设计规格（Vertical Stack Rhythm）**：
   - 移动端：`space-y-3` (12px)；
   - 桌面常规端：`md:space-y-3.5` (14px)；
   - 紧凑/矮屏防御规则（Gemini 设计的工程规则，非已测设备事实）：在 `@media (max-height: 720px)` 下由样式表统一步调收紧为 `space-y-2` (8px)。

---

### 3.2 浮动与固定操作栏统一避让与超宽对齐规则（Sidebar-Aware Dock）

针对凭证页批量操作坞（Bulk Dock）与模型路由固定底栏（Routing Toolbar），彻底修正历史偏心与侧栏遮挡，并解决在超宽视口下的对齐问题：

#### 3.2.1 定位与避让类名标准
```tsx
// 1. 凭证管理批量操作坞 (Credentials Bulk Dock - 保留原有 z-40、backdrop-blur、shadow-lg 与弹性占高约束):
className="fixed bottom-0 left-0 right-0 md:right-[13.5rem] z-40 border-t bg-card/95 backdrop-blur shadow-lg max-h-[35vh] md:max-h-[25vh] overflow-y-auto"
style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}

// 2. 模型路由固定底栏 (Model-routing Toolbar - 保留原有 z-20、backdrop-blur-xs、shadow-md):
className="fixed bottom-0 left-0 right-0 md:right-[13.5rem] z-20 border-t border-border bg-card/95 backdrop-blur-xs shadow-md max-h-[35vh] md:max-h-[25vh] overflow-y-auto"
style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}

// 3. 固定底栏内层容器唯一一致规则 (对齐主内容根容器 max-w-[1720px]，靠左不居中，保留 padding 与操作对齐):
<div className="w-full max-w-[1720px] px-3 py-2 sm:px-4 sm:py-2.5 flex flex-wrap items-center justify-between gap-2">
  {/* 子操作项保持既有结构 */}
</div>
```

#### 3.2.2 几何对齐原理与超宽视口一致性证明
1. **外层栏位精准避让**：通过声明 `fixed bottom-0 left-0 right-0 md:right-[13.5rem]`，固定外层栏在桌面端右侧终止于距离屏幕右边缘 216px 处，主内容列宽度与底栏总宽度完全物理重合（$W_{\text{Dock}} \equiv W_{\text{Main\_Col}}$），侧栏底部的“退出登录”与旧控制面板入口 100% 暴露，零重叠遮挡；
2. **超宽视口（> 1920px）下的对齐一致性**：
   - 若根容器设有 `max-w-[1720px]` 靠左，而在更宽窗口（如 2560px）下底栏内层若仅设 `w-full` 无上限，底栏右侧操作按钮将延伸到 2344px 处，与上方止于 1736px（$16px + 1720px$）的内容产生严重错位；
   - **唯一一致规则**：底栏外层保持全宽贴底贴栏，**内层容器同样声明 `w-full max-w-[1720px] px-3 sm:px-4` 靠左排布（无 `mx-auto`）**；
   - 在 1920px 候选视口下，主内容净宽 1672px，底栏内层净宽同样为 1672px（均小于 1720px），两者完全等宽满幅对齐；
   - 在 2560px 更宽视口下，主内容止于 1720px，底栏内层内容同样止于 1720px，垂直投影严格同轴咬合；
3. **视觉非相关属性完整保留**：
   - 凭证批量坞原有的 `z-40`、`backdrop-blur`、`shadow-lg` 以及路由底栏原有的 `z-20`、`backdrop-blur-xs`、`shadow-md` 等无关属性 100% 保留，不作任何非必要破坏。

---

### 3.3 内容类型化层宽策略：按内容类型明确最终值

本方案严格摒弃模糊的“768px 或 896px 二选一”，按页面的业务内容类型明确唯一最终值：

```
+----------------------------------------------------------------------------------------------------+
| 统一外层基线 (w-full max-w-[1720px], 左边缘 X = 16px)                                                |
| [页面标题 / 渠道标签 / 顶部操作栏]                                                                   |
|                                                                                                    |
| [内容类型 1: 满幅数据密集流 (Data-Dense Full Bleed: w-full)]                                         |
| +------------------------------------------------------------------------------------------------+ |
| | 凭证表格 (CredentialTable) / 日志终端 (LogViewer) / 概览双报表 (StatisticsTables)                | |
| | 模型路由工作台 (RouteTable + Comparison) / 系统设置双列网格与差异表 (Settings & Diff Table)    | |
| | 1920px 大屏: 展现 1672px 净内容盒 / 日志长行不折行 / 统计报表双列舒适展开                          | |
| | Mac Air 候选视口: 1192px 净内容盒紧凑展示 / 终端动态吸收高度                                     | |
| +------------------------------------------------------------------------------------------------+ |
|                                                                                                    |
| [内容类型 2: 靠左单列阅读封套 (Left-Aligned Reading Envelope: 明确唯一为 max-w-3xl / 768px)]          |
| +--------------------------------------------------------------+                                   |
| | 添加凭证 (ImportPage) 单列录入卡片 / OAuth 授权码 /            | (右侧保持自然呼吸留白，            |
| | 多行 Token 文本框 / 邮箱任务卡片 (EmailJobCard) / 导入结果面板 |  文本阅读舒适，杜绝横向摆头疲劳)   |
| +--------------------------------------------------------------+                                   |
+----------------------------------------------------------------------------------------------------+
```

#### 3.3.1 规格最终明确规则
1. **纯单列认知录入流（添加凭证页 `import/index.tsx`）**：
   - **最终明确值**：**`max-w-3xl`（768px / 48rem），外层靠左对齐（无 `mx-auto`）**；
   - **决策依据**：该页面为纯单列配置输入流程（OAuth 码、单字段或多行 Token、邮箱补全任务卡片、结果提示面板）。45~85 个半角字符为最佳阅读行长，768px 在高分辨率屏幕下能保证长 Token 的聚焦审查，且避免输入框过度拉伸导致视线横向往返疲劳；右侧自然留白，左边缘与页面标题 $X = 16px$ 严格共线。
2. **系统设置页（`settings/index.tsx`）**：
   - **最终明确值**：**`w-full max-w-[1720px]`，外层靠左对齐（无 `mx-auto`）**；
   - **决策依据**：设置页内部包含两项核心结构：① 双列配置卡片网格（`grid gap-2.5 md:grid-cols-2`）；② 包含 5 列横向数据的“修改对照表”（`CredentialsDiffTable`，包含字段名、原基线、草稿、最近提交、当前观察 5 个数据列）。若将设置页限制在 768px 或 896px，双列卡片将被迫变为紧窄单列，5 列差异表更会严重挤压；采用 `w-full max-w-[1720px]` 靠左大画板，使得双列卡片在 1920px 下舒展自如，差异表横向从容展开，完全符合高信息量要求。
3. **数据密集型资产（凭证、概览、日志、路由）**：
   - **最终明确值**：**`w-full max-w-[1720px]` 弹性拉满**，最大化展现列数据与并排视图。

---

## 4. 双轴响应式条件与断点规范矩阵

### 4.1 核心响应式断点与设备映射总表

| 可用视口条件 | 典型场景对应 | 侧栏呈现 | 主内容列与净内容盒 | 核心数据资产表现（设计目标，待实测） | 表单/设置封套明确值 | 浮动/固定底栏表现 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **W < 768px**<br>(移动断点) | 主流手机 (320~430px)、原生 200% 缩放桌面小窗 | 隐藏，顶栏汉堡按钮唤起右侧 Sheet 抽屉 | 主内容列 100% 视口<br>扣除 `p-3` 后内容盒净宽 = 视口宽 - 24px | 凭证表格支持容器内横滚；日志终端自适应高度；报表单列垂直堆叠 | 表单满宽自适应，触控热区 $\ge 40px$ | `left-0 right-0` 满屏浮动，含安全区沉底，`max-h-[35vh]` |
| **768px $\le$ W < 1280px**<br>(平板 / 窄窗) | iPad、桌面缩窄窗口、1280×800 候选场景 | 右侧固定<br>`13.5rem` (216px) | 主列宽 552px ~ 1064px<br>扣除 `p-4` 后内容盒 520px ~ 1032px | 凭证表格容器内滚动 (`overflow-x-auto`)；报表单列；路由双列上下堆叠且保持表格内滚 | 添加凭证页靠左 `max-w-3xl` 占满可用宽；设置页自适应双列/单列 | 避让侧栏，内层充满，`max-w-[1720px]` 靠左 |
| **1280px $\le$ W < 1600px**<br>(标准小屏/笔记本) | **13寸 MacBook Air 候选测试场景** (如 1440×900, 1470×956) | 右侧固定<br>`13.5rem` (216px) | 1440 视口下主列宽 1224px<br>扣除 `p-4` 后**净内容盒为 1192px** | 凭证表格 6 列横向舒展展示；概览双报表并排；路由双列并排 | 添加凭证页靠左 `max-w-3xl` (768px)，右侧留白；设置页双列舒展 | 避让侧栏，内层与主内容盒严格对齐 |
| **W $\ge$ 1600px**<br>(桌面全高清大屏) | **32寸 1920×1080 (浏览器最大化且缩放100%)**、2K超宽屏 | 右侧固定<br>`13.5rem` (216px) | 1920 视口下主列宽 1704px<br>扣除 `p-4` 后**净内容盒为 1672px** | **高信息量展现（目标待测）**：凭证表格充分展开，完整容纳多行丰富数据；日志单行承载长文本；报表舒展大屏 | 添加凭证页靠左 `max-w-3xl` (768px) 保持聚焦；设置页 1672px 大画板 | 避让侧栏，底栏内层受限于 1720px 靠左，与内容盒在超宽屏下严格对齐 |

---

### 4.2 矮屏视口工程防护规则（针对较小可用高度的设计规格）

针对 MacBook Air 等设备可能出现的较小可用浏览器高度，确立以下由 Gemini 设计的工程自适应防护规则（作为工程设计规格而非已测事实）：

1. **垂直间距动态收紧工程规则**：
   - 设计 `@media (max-height: 720px)` 紧凑高度响应规则，将页面主容器的垂直间距由 `space-y-3.5` (14px) 收紧为 `space-y-2` (8px)；
2. **凭证页表头基线与真实多行凭证数据呈现说明**：
   - 保持 UI-002 设计：高级筛选默认折叠，高频错误/额度组以单行胶囊呈现，使桌面端 TableHeader 垂直坐标位于屏幕前部；
   - **杜绝不切实际的行数与无截断承诺**：真实系统已接受凭证行**并非简单的单行文本**，每行通常聚合了凭证标识、渠道模式、额度徽标（5H/周额度）、健康状态、冷却倒计时、更新时间及错误诊断信息等多行丰富信息，其实际行高远高于常规单行表格（30~35px）；
   - **展示能力定位为“设计目标，待后续实测”**：实际首屏可见行数取决于真实渲染行高、数据复杂度以及实际浏览器视口高度。设计目标是最大限度保留全部信息、稳定表头基线，杜绝无意义截断，待后续代码实施后通过人工实测核验实际行数；
3. **浮动操作坞高度锁定**：
   - 批量操作坞与路由保存底栏声明 `max-h-[35vh] md:max-h-[25vh]`；若操作内容多行，通过内部滚动（`overflow-y-auto`）消化，占高绝不超过视口的 1/4；
4. **日志终端高度单一可行策略（废除多选项摇摆）**：
   - **废除弹性/减190/减140多选项**，确立**基于 Flex 列布局的单一确定性策略**；
   - **动态工具栏折行处理**：`LogsPage` 根容器声明为 Flex 列容器，其整体高度绑定为视口可用高度：
     ```tsx
     <section className="flex flex-col h-[calc(100vh-4.75rem)] md:h-[calc(100vh-5rem)] w-full max-w-[1720px] min-w-0 space-y-2 text-foreground" aria-label="运行日志">
     ```
     顶部工具栏 `<header>` 设为 `shrink-0 min-w-0`。当视口较宽时，工具栏呈单行紧凑排布（高度约 36px）；当窗口缩窄导致筛选输入框与操作按钮折行成两行（高度增至约 72px）时，Flex 容器自然让工具栏占据实际高度，**而不会将下方终端强行顶出视口外**；
   - **终端动态吸收剩余高度**：`LogViewer` 容器作为 Flex 子项，统一声明为：
     ```tsx
     <div ref={container} tabIndex={0} aria-label="日志文本" className="flex-1 min-h-[260px] min-w-0 overflow-y-auto rounded-lg border border-border bg-control-background p-2.5 font-mono text-[12px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
     ```
     `flex-1` 确保终端自动充满除去工具栏后的全部剩余高度，滚动条完全闭环在终端内部；
   - **短视口与最小高度不引发整页横溢出机制**：
     - 当遇到极端矮视口（如视口高度不足 380px）时，`min-h-[260px]` 启动保底机制，确保终端日志依然具备基本的阅读空间；此时外层页面若出现纵向滚动条属于预期保底降级；
     - **横向防溢出保证**：在整个 Flex 链条中，父级与子级均严格声明 `min-w-0` 与 `w-full`，配合 `LogViewer` 内部每一行日志原有的 `<pre className="whitespace-pre-wrap break-all ...">` 文本折行规则，确保无论纵向如何压缩或工具栏如何折行，**整页绝对不会产生横向滚动条**（保证 `document.documentElement.scrollWidth === clientWidth`）；
   - **核心业务逻辑零改动**：本高度适配策略完全属于呈现与 CSS 层，**严格不改动任何日志连接、重连退避、流式传输（useLogStream）与缓存清理逻辑**。

---

## 5. 六大业务页面大屏与小屏逐页映射方案

### 5.1 页面映射与大/小屏对比总表

| 页面名称 | 页面路由 | 根容器推荐统一 Class | 大屏 (32寸 1920×1080 假设全屏100%缩放) 表现 | 小屏 (13寸 Mac Air 候选测试场景) 表现 | 窗口缩窄与移动回退表现 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **概览** | `#/overview` | `section.w-full.max-w-[1720px].min-w-0.space-y-3.md:space-y-3.5` | 1672px 净内容盒满幅。5 列 KPI 单行铺开；端点双列平铺；`StatisticsTables` 2 列并排，无外层无效留白 | 1192px 净内容盒充满。KPI 5 列紧凑；服务地址双列；`StatisticsTables` 2 列并排，矮屏下间距紧凑 | `< 768px`：KPI 转为 2~3 列网格；端点与报表转为单列堆叠；整页无横向溢出 |
| **凭证管理** | `#/credentials` | `section.w-full.max-w-[1720px].min-w-0.space-y-3.md:space-y-3.5` | 1672px 净内容盒满幅。表格 6 列横向舒展，多行凭证数据舒展排开；批量坞避让侧栏，内层贴合主内容 | 1192px 净内容盒充满。表格 6 列紧凑无横滚；TableHeader 居于屏幕前部，首屏展示目标待实测；批量坞避让侧栏 | `< 768px`：表格支持容器内横向滑动；底栏恢复全屏居底并兼容触控安全区 |
| **添加凭证** | `#/import` | `section.w-full.max-w-[1720px].min-w-0.space-y-3.md:space-y-3.5` | 外层 1672px 靠左。标题在 $X=16px$；**表单卡片、提示条与两渠道子组件统一以 `max-w-3xl` (768px) 靠左排布**，右侧自然留白 | 外层 1192px 充满。标题在 $X=16px$；表单 `max-w-3xl` 靠左占据主要区域，两渠道组件同轴排列 | `< 768px`：表单自适应 100% 满宽；输入框与拖拽上传区单列排布；热区 $\ge 40px$ |
| **系统设置** | `#/settings` | `div#settings-content.w-full.max-w-[1720px].min-w-0.space-y-3.md:space-y-3.5` | 外层 1672px 靠左。标题在 $X=16px$；设置卡片网格 `md:grid-cols-2` 充分展开，5 列修改差异对照表横向从容 | 外层 1192px 充满。双列卡片适度紧凑，5 列差异表平稳自适应，纠正旧居中左右边距抖动 | `< 768px`：配置卡片转为单列垂直堆叠；差异表允许容器内部横向平滑滚动 |
| **运行日志** | `#/logs` | `section.flex.flex-col.h-[calc(100vh-4.75rem)].md:h-[calc(100vh-5rem)].w-full.max-w-[1720px].min-w-0.space-y-2` | 1672px 满幅。工具栏单行紧凑；`LogViewer` 充满剩余高度，长日志单行呈现，滚动闭环在内部 | 1192px 充满。工具栏折行由 Flex 自然吸收；终端动态填充剩余高度，不引发外层滚动 | `< 768px`：工具栏按钮多行折叠；终端维持 `min-h-[260px]` 保底，无整页横向溢出 |
| **模型路由** | `#/model-routing`| `div#routing-content.w-full.max-w-[1720px].min-w-0.space-y-3.md:space-y-3.5` | 1672px 满幅。主表 + 18rem 对比窗格双列并排舒展；固定底栏避让侧栏，内层贴合主内容 | 1192px 充满。主表 + 18rem 双列紧凑并排；固定底栏避让侧栏 | `< 1280px` 及移动端：双列转为上下堆叠；**保持既有表格结构，内部横向滚动，不新增卡片编辑流** |
| **登录屏** | 独立路由 | `main.grid.min-h-svh.place-items-center.bg-background.p-3.5` | **判定保留独立规格**：`max-w-sm` (384px) 全屏绝对居中，不套用大屏满幅规格 | 保持 `max-w-sm` 全屏居中 | 单列居中卡片，输入框热区 $\ge 40px$ |

---

### 5.2 逐页详细实现规格与子组件策略

#### 5.2.1 概览页 (`overview/index.tsx` & `StatisticsTables.tsx`)
- **根节点规格**：
  ```tsx
  <section
    className="w-full max-w-[1720px] min-w-0 space-y-3 md:space-y-3.5 text-sm text-foreground"
    aria-label={`${channelLabel} 概览`}
    aria-busy={loading}
  >
  ```
- **大屏优势展现（设计目标，待实测）**：
  - 核心指标卡片：在 1672px 净内容盒下，5 个卡片排布开阔；
  - 统计报表（`StatisticsTables.tsx` 中的 `<div className="grid gap-2.5 xl:grid-cols-2">`）：在 1920px 视口下必定触发 `xl:grid-cols-2`，模型家族今日报表与近期报表并排展示，消除了纵向堆叠导致的无效翻页。
- **MacBook Air 候选场景协同**：
  - 在 1440px 候选视口（净内容盒 1192px）下仍可触发 `xl` 双列并排；`StatisticsTables.tsx` 协同在矮屏响应下收紧内边距与表头高度，避免产生多余纵向滚动。

#### 5.2.2 凭证管理页 (`credentials/index.tsx` & `CredentialTable.tsx`)
- **根节点规格**：
  ```tsx
  <section
    ref={workspace}
    className="w-full max-w-[1720px] min-w-0 space-y-3 md:space-y-3.5"
    style={{
      paddingBottom: isDockVisible
        ? `calc(${dockHeight || 64}px + 1rem + env(safe-area-inset-bottom, 0px))`
        : undefined,
    }}
    aria-label={mode === 'geminicli' ? 'Gemini CLI 凭证' : 'Antigravity 凭证'}
    aria-busy={busy || c.loading}
  >
  ```
- **浮动批量坞规格（对齐超宽规则，保留既有属性）**：
  ```tsx
  <aside
    ref={bulkDockRef}
    id={mobilePanelIds.bulk}
    role="region"
    aria-label="批量操作"
    className="fixed bottom-0 left-0 right-0 md:right-[13.5rem] z-40 border-t bg-card/95 backdrop-blur shadow-lg max-h-[35vh] md:max-h-[25vh] overflow-y-auto"
    style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
  >
    <div className="flex w-full max-w-[1720px] px-3 py-2 sm:px-4 sm:py-2.5 flex-wrap items-center justify-between gap-2">
  ```
- **表格呈现与多行数据说明**：
  - `CredentialTable.tsx` 桌面分支维持内部滚动防护：`<div data-testid="desktop-branch" className="hidden overflow-x-auto rounded-lg border bg-card md:block shadow-sm">`；
  - 真实凭证包含渠道标识、额度状态胶囊、错误说明及刷新时间戳等多行聚合信息，行高天然高于基础文本行；方案以保留完整信息为原则，表头基线保持靠前，具体首屏展现行数标定为设计目标待实测。

#### 5.2.3 添加凭证页 (`import/index.tsx` & `import/components.tsx`)
- **根节点规格**：
  ```tsx
  <section className="w-full max-w-[1720px] min-w-0 space-y-3 md:space-y-3.5 text-sm text-foreground">
  ```
- **内部核心阅读封套（明确唯一规格为靠左 max-w-3xl）**：
  ```tsx
  // 1. 导入方式 Tabs 栏靠左排列：
  <TabsList className="h-8 p-0.5 max-w-3xl flex">...

  // 2. 核心录入卡片（OAuth、文件上传、Token 多行输入）统一声明 max-w-3xl（无 mx-auto）：
  <Card className="max-w-3xl border border-border">
    <CardHeader className="p-3.5 pb-2">...</CardHeader>
    <CardContent className="space-y-3 p-3.5 pt-0">...</CardContent>
  </Card>

  // 3. 状态条与提示（如 flow.busy、flow.message）靠左同轴对齐：
  <div role="status" className="max-w-3xl flex items-center ...">...</div>

  // 4. 导入结果面板 (ImportResults) 统一声明 max-w-3xl 靠左：
  <div className="max-w-3xl">
    <ImportResults result={flow.result} ... />
  </div>

  // 5. Antigravity 专属邮箱补全卡片 (EmailJobCard) 统一声明 max-w-3xl 靠左：
  <div className="max-w-3xl space-y-2.5">
    {flow.emailJobs.map(job => (
      <EmailJobCard key={job.jobId} job={job} ... />
    ))}
  </div>
  ```

#### 5.2.4 系统设置页 (`settings/index.tsx`)
- **根节点规格**：
  ```tsx
  <div
    id="settings-content"
    tabIndex={-1}
    className="w-full max-w-[1720px] min-w-0 space-y-3 md:space-y-3.5"
  >
  ```
- **布局与数学逻辑说明**：
  - 彻底移除原 `mx-auto max-w-6xl`。在 1440px 候选视口下，扣除 padding 后的净内容盒为 1192px；原 1152px（`max-w-6xl`）居中时由于 $1192\text{px} > 1152\text{px}$，产生了两侧各 20px 的偏移；改用统一靠左画板后，标题与卡片严格在 $X = 16px$ 对齐；
  - 核心配置卡片维持 `grid gap-2.5 md:grid-cols-2` 双列网格；
  - 修改对照表（`CredentialsDiffTable`）横向容纳 5 列数据，依托大画板完整展示，并自带 `overflow-x-auto` 容器内滚动保护。

#### 5.2.5 运行日志页 (`logs/index.tsx` & `LogViewer.tsx`)
- **根节点与 Flex 容器规格**：
  ```tsx
  <section
    className="flex flex-col h-[calc(100vh-4.75rem)] md:h-[calc(100vh-5rem)] w-full max-w-[1720px] min-w-0 space-y-2 text-foreground"
    aria-label="运行日志"
  >
  ```
- **工具栏与终端联动**：
  - 工具控制栏设为 `shrink-0 min-w-0`，当发生多行折叠时动态扩展，不挤占外部视口；
  - `LogViewer.tsx` 声明为：
    ```tsx
    <div
      ref={container}
      tabIndex={0}
      aria-label="日志文本"
      className="flex-1 min-h-[260px] min-w-0 overflow-y-auto rounded-lg border border-border bg-control-background p-2.5 font-mono text-[12px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
    ```
  - 保证内部纵向滚动闭环，不改动任何日志连接与重连逻辑。

#### 5.2.6 模型路由页 (`model-routing/index.tsx`, `RouteTable.tsx`, `Comparison.tsx`)
- **根节点规格**：
  ```tsx
  <div
    id="routing-content"
    tabIndex={-1}
    className="w-full max-w-[1720px] min-w-0 space-y-3 md:space-y-3.5"
    style={{
      paddingBottom: `calc(${toolbarHeight || 56}px + 1rem + env(safe-area-inset-bottom, 0px))`,
    }}
  >
  ```
- **底栏避让与移动降级原则**：
  - 固定底栏内层容器声明为：
    ```tsx
    <div ref={toolbarRef} className="fixed bottom-0 left-0 right-0 md:right-[13.5rem] z-20 border-t border-border bg-card/95 backdrop-blur-xs shadow-md max-h-[35vh] md:max-h-[25vh] overflow-y-auto">
      <div className="w-full max-w-[1720px] px-3 py-2 sm:px-4 sm:py-2 flex flex-wrap items-center justify-between gap-2">
    ```
  - **移动降级保留既有表格内部滚动**：在 `< 1280px` 及移动端断点下，路由双列转为上下堆叠。**主路由表严格保留既有桌面与移动呈现结构，桌面表格依托容器内部横向滚动（`overflow-x-auto`）进行安全降级，严格不引入任何未要求的新“卡片编辑流”实现**，避免扩大业务范围。

---

## 6. 系统既有约束与 UI-001 / UI-002 保全声明

为确保本次双屏响应式重审方案完全向下兼容，严格重申以下底线保全约束：

### 6.1 UI-001 约束完整保全
1. **右侧固定侧栏与移动抽屉**：
   - 桌面端固定在屏幕右侧（`md:grid-cols-[minmax(0,1fr)_13.5rem]`），左边框分割（`border-l`）；
   - 移动端从右侧滑出抽屉（`SheetContent side="right"`），顶栏汉堡按钮保持在右侧；
   - 键盘无障碍锚点 `<a href="#main-content">跳到主要内容</a>` 原样保留在 DOM 最前列。
2. **双凭证独立入口与显式传参保护**：
   - `Sidebar.tsx` 中 Anti 凭证项严格保持 `href: "#/credentials?channel=antigravity"` 并显式传递 `targetMode: "antigravity"`；
   - CLI 凭证项严格保持 `panelRouteHref("credentials", "geminicli")` 并传递 `targetMode: "geminicli"`；
   - **严禁退回或简化为无参数链接 `#/credentials`**，严格保留激活指示线与 `aria-current="page"` 语义。
3. **菜单底部退出登录与现有面板链接保护**：
   - `Sidebar` 底部包含退出登录按钮与旧面板外链；通过在固定底栏追加 `md:right-[13.5rem]`，彻底消除物理遮挡风险。
4. **视觉非相关属性零改动**：
   - 凭证页批量坞 `z-40` 与 `backdrop-blur`、路由页底栏 `z-20` 与 `backdrop-blur-xs`、按钮阴影、边框圆角等既有 UI 属性原样保留，坚决不进行无意义改动。

### 6.2 UI-002 约束完整保全
1. **凭证搜索框紧凑化**：文件名/邮箱输入框在桌面端维持受限宽度，不随大屏无限伸展；
2. **高频分组常驻第一行**：
   - “错误分组”全渠道常驻显示；
   - “额度组”作为 Antigravity 专属能力常驻首行，Gemini CLI 保持专属高级项兼容；
   - 重置、显式提交与已生效计数准确对应。

### 6.3 底线不变量清单 (Invariants)
- **零后端变更**：不改变任何 API 请求路径、管理契约或入参出参；
- **零鉴权与状态破坏**：未保存退出守卫（`UnsavedChangesGuard`）、草稿内存保护、敏感凭证清理机制完全原样运作；
- **真实数据语义不变**：保留 5H 额度、周额度、未知状态与冷却计时的真实数据解析；
- **风格体系沿用**：完全沿用 `WARM_GRAY_STYLE.md` 与 `COMPACT_UI_DESIGN.md` 中定义的暖灰浅色令牌与控件阶梯。

---

## 7. 未来实施路径、最小文件清单与依赖分析

### 7.1 未来实施文件清单 (Implementation Targets)
本方案将未来潜在实施范围收敛至最小集合，包含所有实际需要修改的页面、组件与样式文件：

| 目标文件路径 | 预期修改类型 | 预估代码行变动 | 核心改动说明 |
| :--- | :--- | :--- | :--- |
| `frontend/src/styles/globals.css` | 紧凑高度响应基准定义 | ~8 行 | **实现 height 规则的最小位置**：集中声明 `@media (max-height: 720px)` 紧凑间距与行高实用规则，供全系统调用，避免在各 TSX 中散落零散的任意媒体查询 |
| `frontend/src/pages/overview/index.tsx` | 根容器类名调整 | ~4 行 | 根节点 `<section>` 替换为统一画板类名 `w-full max-w-[1720px] min-w-0 space-y-3 md:space-y-3.5`，大屏下全面铺满 |
| `frontend/src/pages/overview/StatisticsTables.tsx` | 矮屏协同紧凑化 | ~6 行 | 协同矮屏规则，微调卡片内边距与表头高度，确保双列报表在受限高度视口下紧凑利落 |
| `frontend/src/pages/credentials/index.tsx` | 根容器与底栏对齐 | ~10 行 | 根节点替换为统一画板类名；批量操作坞 `<aside>` 追加 `md:right-[13.5rem]`，内层容器增加 `max-w-[1720px]` 靠左对齐，保留既有 `z-40` 与模糊 |
| `frontend/src/pages/credentials/CredentialTable.tsx` | 容器横滚保护 | ~2 行 | 桌面端表格外层包裹容器由 `overflow-hidden` 调整为 `overflow-x-auto`，窄屏下保护多列数据不被裁切 |
| `frontend/src/pages/import/index.tsx` | 根容器与内部封套 | ~16 行 | 根节点替换为统一画板类名；表单卡片、状态条及两渠道子组件明确采用 `max-w-3xl` (768px) 统一靠左阅读封套 |
| `frontend/src/pages/import/components.tsx` | 子组件封套协同 | ~8 行 | `ImportResults` 与 `EmailJobCard` 声明 `max-w-3xl` 靠左，确保与主表单严格同轴对齐 |
| `frontend/src/pages/settings/index.tsx` | 根容器类名调整 | ~4 行 | 根节点 `<div>` 由 `max-w-6xl` 替换为统一画板类名，大画板舒展承载双列网格与 5 列差异对照表，消除切换跳动 |
| `frontend/src/pages/logs/index.tsx` | Flex 自适应容器改造 | ~6 行 | 根节点 `<section>` 改造为 Flex 列容器并绑定视口高度，工具栏设为 `shrink-0`，吸收折行 |
| `frontend/src/pages/logs/LogViewer.tsx` | 终端 Flex 充满与最小高 | ~4 行 | 终端容器设为 `flex-1 min-h-[260px] min-w-0 overflow-y-auto`，闭环内部滚动，杜绝整页横向溢出 |
| `frontend/src/pages/model-routing/index.tsx` | 根容器与底栏对齐 | ~10 行 | 根节点替换为统一画板类名；固定底栏追加 `md:right-[13.5rem]`，内层容器增加 `max-w-[1720px]` 靠左对齐，保留既有 `z-20` |

> **工程实施规模核定**：
> 1. 核心实施目标收敛为 **1 个全局样式文件 + 6 个页面文件 + 4 个协同组件文件**；
> 2. 总代码改动行数实事求是预估在 **70 ~ 85 行**；
> 3. 改动性质 100% 为 CSS 类名与 DOM 结构对齐微调，零底层业务逻辑、鉴权及数据流风险。

### 7.2 只读参考依赖清单 (Read-Only Dependencies - 严禁修改)
以下文件在后续实施中作为只读架构底座，**严格禁止修改**：
- `frontend/src/components/layout/AppShell.tsx`（保持 `md:grid-cols-[minmax(0,1fr)_13.5rem]` 双列骨架）；
- `frontend/src/components/layout/Header.tsx`（保持顶栏指示与移动汉堡按钮）；
- `frontend/src/components/layout/Sidebar.tsx`（保持双凭证显式带参入口、底部退出按钮与已有面板外链）；
- `frontend/src/auth/LoginScreen.tsx`（保持独立 `max-w-sm` 居中认证门禁）；
- `frontend/src/styles/theme-warm-gray.css`（暖灰调色彩与阴影令牌只读底座）；
- `frontend/src/pages/credentials/FiltersPanel.tsx`（UI-002 紧凑筛选体系只读）；
- `frontend/src/pages/model-routing/components/RouteTable.tsx`（保持既有表格结构与内部横滚，不引入卡片编辑流）；
- `frontend/src/pages/model-routing/components/Comparison.tsx`（保持双列对比窗格逻辑）；
- `frontend/src/pages/settings/components/ConfigField.tsx`（保持配置字段组件呈现）。

---

## 8. 未来真实环境可观察验收标准与验证指引

> **工程声明**：本阶段**仅交付本方案文档，严格未修改任何前端源码，未运行任何构建与测试命令，严禁伪称已完成实测**。以下指标为未来经用户正式授权进入代码实施阶段后，在真实浏览器环境下的客观验收规范。

### 8.1 视觉几何与基线对齐测量 (Visual Geometry Verification)
1. **左侧垂直基线绝对统一（设计目标，待实测）**：
   - 在 1440px 候选视口与 1920px 视口下，连续点击侧栏菜单（概览 -> Anti凭证 -> CLI凭证 -> 添加凭证 -> 设置 -> 日志 -> 模型路由）；
   - 使用开发者工具审查各页面主标题左边缘相对于主内容列左侧的绝对 X 坐标；
   - **验收指标**：所有六个页面的标题左坐标恒定为 **$X = 16px$**（误差 $0px$），彻底消除页面切换时的横向抖动。
2. **大屏高信息量展现核验（设计目标，待实测）**：
   - 在 32寸 1920×1080 浏览器全屏且 100% 缩放下，主内容净内容盒应达到约 1672px；
   - `overview` 页面的两个统计报表表格（`StatisticsTables`）应舒适并排显示为 2 列，而非纵向堆叠；
   - `credentials` 表格所有 6 列数据舒展排开，完整容纳多行凭证信息，两侧无无效空白孤岛；
   - `logs` 终端宽度达到 1672px，长单行日志可读性提升。
3. **底栏避让与超宽对齐核验（设计目标，待实测）**：
   - 触发凭证批量操作坞与模型路由保存底栏；
   - 在 1920px 视口下，底栏内层与主内容列净宽完全重合；
   - 在 > 1920px（如 2560px）视口下，主内容止于 1720px，底栏内层同样受限于 1720px 靠左排布，两者垂直投影对齐；
   - 检查侧栏底部“退出登录”与“现有控制面板”，确认视觉 100% 可见且交互点击灵敏，无任何遮挡。

### 8.2 矮屏视口与无障碍缩放验证 (Short Viewport & A11y Verification)
1. **较小可视高度可用性核验（设计目标，待实测）**：
   - 将浏览器视口调整为 1440×700 或 1280×650 候选矮屏场景；
   - 打开凭证页，检查表头位置：TableHeader 垂直坐标位于屏幕前部，首屏可见数据行数达到合理密度；
   - 勾选凭证唤起批量坞，核对批量坞占高不超过视口高度的 25%，表格核心数据仍有充分浏览空间；
   - 打开日志页，确认工具栏折行被 Flex 容器自然吸收，滚动条仅出现在 `LogViewer` 终端内部，整页不发生跳动且绝无横向滚动条。
2. **原生 200% 浏览器缩放核验（设计目标，待实测）**：
   - 在 1920px 视口下将浏览器原生缩放调至 200%（有效逻辑视口变为 960px）：侧栏保持 216px，主内容平滑收缩，文字无截断；
   - 在 1440px 视口下将浏览器原生缩放调至 200%（有效逻辑视口变为 720px）：侧栏平滑收起至右侧抽屉，页面自动降级为移动端单列排布，整页绝不出现横向滚动条。
3. **移动端极限回退核验（设计目标，待实测）**：
   - 路由表格与凭证表格在窄屏下保持容器内部横向滚动，不发生整页撑爆；
   - 按钮与交互控件保持触控热区 $\ge 40px$；
   - 整页外层始终满足 `document.documentElement.scrollWidth === clientWidth`。

### 8.3 精简工程构建指引 (Minimal Build Pipeline)
后续进入代码实施后，建议仅执行以下轻量验证指令，以生产构建与人工视觉核验为主，不设冗余全量测试专项：
```bash
# 1. 执行生产打包与内嵌类型检查 (package.json 中 build 脚本内含 tsc --noEmit && vite build)
npm run build

# 2. 校验构建产物完整性
npm run check:build

# 3. 定点人工页面核对 (重点确认 1920px 满幅展示、MacBook Air 候选矮屏表头位置与底栏避让)
```

---

## 9. 总结与最终推荐

本修正方案严格立足于真实设备信息、严密视口推导与扎实的工程可实施性：
1. **打破 1280px 僵化上限**：彻底推翻旧版 1280px 居中方案，将大屏数据资产全面释放为 **`w-full max-w-[1720px]` 弹性画板**，消除了 32寸 1080p 大屏上 392px 的外层留白，兑现了大屏多展现内容的核心价值；
2. **求真求实的视口与硬件定位**：删除所有将未知 13寸 MacBook Air 硬件事实化的断言，将其定位于候选测试视口；删除不切实际的“首屏 8~10 行”和“文件名完全无截断”承诺，基于真实多行凭证数据定位展示目标；
3. **消除数学矛盾与超宽不对齐**：修正了 1192px 与 1152px 的逻辑矛盾，明确区分主列宽与净内容盒；给出底栏内层与主内容统一约束在 `max-w-[1720px]` 靠左的唯一一致规则，解决超宽视口下的对齐问题；
4. **确定单一的日志高度策略**：废弃多选项摇摆，确立基于 Flex 列自适应容器的单一可行策略，动态吸收工具栏折行高度，最小高度不引发整页横溢出，且零改动流式日志连接逻辑；
5. **明确表单最终值与克制边界**：单列录入流明确为 `max-w-3xl`（768px）靠左，设置页明确为 `w-full max-w-[1720px]` 靠左；模型路由降级保留既有表格内滚，坚决不顺带新增卡片编辑流；
6. **自洽的最小文件清单**：将 `globals.css`、`StatisticsTables.tsx` 与 `LogViewer.tsx` 完整纳入实施目标清单，移出只读清单，彻底消除自相矛盾；
7. **全方位保全既有资产**：100% 保留 UI-001 / UI-002 的双凭证入口、右侧导航、紧凑筛选与全部系统底线约定，为后续经授权后的低风险代码实施提供了唯一、严谨、可直接落地的技术规格。
