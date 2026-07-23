# OCC REPL 启动欢迎页视觉优化（OCC-18）

> 设计说明。记录 OCC REPL 启动欢迎页（logo / 横幅 / 版本信息 / 上下文 / 提示行）的视觉优化思路、现状盘点、grok-build 设计理念提炼与落地差异。只学设计与手法，不照抄 grok-build 代码（license / 归属）。

## 1. 现状盘点（优化前）

OCC REPL 启动欢迎页入口是 `src/components/LogoV2/LogoV2.tsx`，由 `src/components/Messages.tsx` 挂载。两种渲染路径：

- **Condensed（默认，每次启动）**：`isCondensedMode = !hasReleaseNotes && !showOnboarding && !CLAUDE_CODE_FORCE_FULL_LOGO` → 渲染 `CondensedLogo.tsx`。单行卡片：doge + `OCC v{version}` + `model · billing` + `@agent · cwd`。
- **Full（版本升级首启 / onboarding / `CLAUDE_CODE_FORCE_FULL_LOGO=1`）**：圆角边框盒子，标题 `OCC v{version}`，左侧 `Welcome back!` + doge + 模型/cwd，右侧 `FeedColumn`（Recent activity / What's new）。

不足：
- `Clawd.tsx` 的 doge 仅 4 行单色 ASCII（`/\___/\` / `( o o )` / `( =w= )` / `|_____|`），无层次、无高光、无 tail，视觉单薄。
- Condensed 缺少「提示行」——用户首屏看不到任何快捷键引导。
- 上下文信息只有 cwd，缺少 git 分支等更高密度上下文（grok-build 顶部栏有 git 分支 / worktree / cwd）。

## 2. grok-build 设计理念提炼（学习对象）

研读 `xai-org/grok-build`（Rust + TUI）的欢迎页模块（`crates/codegen/xai-grok-pager/src/views/welcome/`），提炼可借鉴的设计手法：

| 理念 | grok-build 手法 | OCC 借鉴点 |
|------|----------------|-----------|
| Logo shimmer 动画 | logo 行做量化 shimmer（不跑满帧但视觉顺滑） | OCC 已有 `AnimatedClawd`（click 触发 crouch/jump/look，fullscreen 下生效）；保持静态 doge 为默认，避免首屏闪烁/撕裂 |
| 欢迎菜单 | `label … shortcut` 排列 | OCC 用 dim 提示行呈现单条 shortcut，信息密度更轻 |
| 顶部栏 | git 分支 / worktree / cwd | OCC 保留 cwd；git 分支仅异步可得（`getCachedBranch()` Promise），同步渲染路径不引入，避免布局抖动 |
| tips 横幅 | 首屏一条 tip | **本次新增**：Condensed 增加确定性 per-session tip 行 |
| hero box / 公告 | 圆角淡边框 + 版本号 | OCC Full 模式已是圆角边框 + `OCC v{version}` 标题；Condensed 维持无框紧凑卡 |
| braille logo + 版本号 | 极简模式只渲染一次进 scrollback | OCC Condensed 同样只渲染一次（`OffscreenFreeze`） |

**设计原则差异**：grok-build 是 Rust 原生 TUI，可精细控制每帧；OCC 是 React/Ink，首屏要避免重渲染撕裂。因此 OCC 选择「静态 doge + 两色分层 + 确定性 tip」，而非 shimmer 满帧动画——视觉提升来自层次与信息密度，而非动画。

## 3. 落地实现（OCC-18）

### 3.1 `Clawd.tsx` —— doge 两色分层 + 摇摆尾巴
- doge 扩展为 5 行：耳朵 `/\___/\`、眼睛+眉毛 `( o w o )~~`、鼻吻 `( =w= )`、腹部 `\_____/`、爪子 `| | |`，并加摇摆尾巴 `~~`。
- **两色分层**：身体描边用品牌色 `clawd_body`（橙 rgb(215,119,87)），眼睛 / 眉毛 / 鼻吻 / 尾巴用更亮的 `claudeShimmer`（浅橙）逐字符着色，给 mascot 立体感。
- `normalizeLines` 将所有艺术行 pad 到等宽，保证 doge 始终是整齐矩形，无锯齿右沿。
- 全 ASCII 字形，legacy 终端 100% 兼容（无 braille / box-drawing 依赖）。
- `pose` prop 保留以兼容 `AnimatedClawd`（忽略，doge 静态）。

### 3.2 `welcomeTips.ts` —— 确定性提示行
- 8 条 OCC 快捷键 tip 池（`/ for commands`、`@ to reference`、`# to memory`、`! bash`、`Ctrl+O expand`、`/help`、`Tab accept`、`Esc twice interrupt`）。
- **确定性选取**：FNV-1a 32-bit hash(sessionId) + numStartups 取模，同一次启动恒定同一 tip，永不中途变 tip（避免重渲染撕裂）。**不使用 `Math.random`**（该 runtime 禁用）。
- 空 sessionId（pipe 模式）回退到 `boot-{numStartups}` 种子，保证不渲染空行。

### 3.3 `CondensedLogo.tsx` —— 清理 JSX + 提示行 + 层次
- 由 React Compiler 输出（`_c()` memo 缓存）重写为干净手写 JSX（`Clawd.tsx` 早已是手写，证明干净 JSX 被构建接受；`bun build` 仅打包，无 babel 编译步骤，`_c()` 仅优化）。
- 信息层次：`OCC`（bold, claude 色）+ `v{version}`（dim）→ `model · billing`（dim）→ `@agent · cwd`（dim）→ **tip（dim italic，新增）**。
- 保留全部副作用：guest-passes / overage upsell seen-count `useEffect`、fullscreen → `AnimatedClawd` 分支、`OffscreenFreeze` 只渲染一次。

## 4. 与官方 Claude Code 的一致性

官方 `uvx claude-code` 启动欢迎页首屏要素：mascot + 版本号 + 模型 + cwd + 提示。OCC 优化后保持一致：doge（mascot）+ `OCC v2.1.276` + `glm-5.2 · API Usage Billing` + cwd + tip 行。在此基础上以两色分层 doge 与确定性 tip 行做 OCC 自身的视觉提升，不引入与官方相悖的交互。

## 5. 真机验收

- **REPL tmux e2e**（`test/e2e/repl-welcome-visual.e2e.test.ts`）：启动 built `dist/cli.js`，断言 Condensed / Full / 窄终端三场景均渲染 brand、`v2.1.276`、doge 字形（`/\___/\` / `=w=` / `~~`）与 tip。3/3 pass。
- **窄终端**：60 列下 Full 模式 `getLayoutMode` 切换 compact，不崩溃、不撕裂，doge 耳朵仍渲染。
- **legacy 兼容**：doge 全 ASCII，无 braille / box-drawing 依赖，任何终端均可渲染。
- **动画不闪烁**：doge 静态为默认；`AnimatedClawd` 仅 fullscreen 下 click 触发，首屏无满帧动画，无撕裂。
- **单元测试**（`test/utils/welcomeTips.test.ts`）：tip 选取确定性 / 池非空 / 空 sessionId 回退。5/5 pass。

## 6. 涉及文件

| 文件 | 变更 |
|------|------|
| `src/components/LogoV2/Clawd.tsx` | doge 两色分层 + 尾巴，5 行等宽矩形 |
| `src/components/LogoV2/welcomeTips.ts` | 新增，确定性 tip 选取（FNV-1a，无 Math.random） |
| `src/components/LogoV2/CondensedLogo.tsx` | 重写为干净 JSX，加 tip 行 + 层次，保留全部副作用 |
| `test/e2e/repl-welcome-visual.e2e.test.ts` | 新增，tmux REPL 真机验收（condensed/full/narrow） |
| `test/utils/welcomeTips.test.ts` | 新增，tip 选取单元测试 |
