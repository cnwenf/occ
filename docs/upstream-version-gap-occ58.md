# OCC-58 — 版本追齐调研 + 严格自验收(2026-08-07)

> Autopilot 轮次(OCC-58)。上一轮 OCC-46(2026-08-06,release 2.1.294)已追齐官方
> `2.1.222`/`2.1.223`。本轮官方**无新版本**,按 issue 要求转入严格自验收;
> 自验收的官方 `--help` 表面对比发现一个**真实 gap**(官方 2.1.221 静默新增
> `--autocompact` flag,无 changelog 条目),已完成字节级移植 + 测试。

## 1. 三方验证:官方最新版本(2026-08-07)

| 来源 | 结果 |
|------|------|
| npm dist-tags | `latest` = `next` = **2.1.223**,`stable` = 2.1.220;`npm time` 最后一个发布为 `2.1.223`(2026-08-05T22:51:13Z),08-06/08-07 无新发布 |
| GitHub releases(anthropics/claude-code) | 最新 `v2.1.223`(published 2026-08-06T00:52:37Z),其后无新 release |
| 全新 ELF 下载(`@anthropic-ai/claude-code-linux-x64@2.1.223`) | 290,728,968 bytes(与 OCC-46 记录一致);`grep -oa` 计 353 × `2.1.223` 标记,**零 `2.1.224+` 标记** |
| 官方 CHANGELOG(raw, freshly fetched) | `2.1.223`/`2.1.222` 段落与 OCC-46 已 triage 的内容逐条一致,无新增条目 |

**结论:官方最新仍是 `2.1.223`,OCC(release 2.1.294)已追齐 —— 无版本 gap。**

## 2. 严格自验收(像人类用户一样使用 OCC)

### 2.1 Build + 测试

- `bun run build` 绿:`dist/cli.js` 28.86 MB,MACRO.VERSION=2.1.294。
- 全量 src 套件:**1788 pass / 0 fail / 4264 expect()**(改动前基线)。
- 定向 e2e(host,真实模型端点):`occ-versioning`+`commands-alignment` 6 pass;
  `version-2.1.219-*`(6 文件)+`resume-interrupted-turn-221` 31 pass;
  `hook-ask-floor-2.1.211`+剩余 2.1.219+`repl-welcome-visual` 28 pass。
- Docker 全量 e2e:见 §5(含 runner 用户/环境分类)。

### 2.2 REPL 真实任务(tmux,真实模型)

- 冷启动:OCC v2.1.294 welcome card + occ50 "Ascendant" 彗星 logo + What's-new
  feed(正确渲染 OCC-46 条目)+ ghost prompt-suggestion(随上下文更新)。
- 真实编码任务:`创建 hello.py 打印前 10 个斐波那契数并运行` →
  Thinking → Write(hello.py) → Bash(python3 hello.py) → 正确输出 0..34,
  PreToolUse/PostToolUse hooks 正常触发(OCC-51 修复后的 Stop/prompt-hook 路径健康)。
- 多轮追问:`改成前 20 个` → Edit + Bash → 0..4181 正确。
- `Shift+Tab` 模式循环:auto → accept-edits → plan → auto ✓。
- `/status`:Version 2.1.294、Session ID、cwd、base URL、MCP servers 3 connected ✓。
- `/model` picker:custom-base-URL 分支正确(OCC-43 Gap-43b 行为)——
  Custom Opus/Sonnet/Haiku/Custom model 行 + effort 调节行 ✓。
- slash 补全:输入 `/exit` 弹出补全菜单(bundled commands + 用户 skills)✓;
  `/exit` 退出码 0,干净退出。
- 一次性观察:首个 REPL 会话在 `/model` picker 打开后的空闲期消失一次,
  **不可复现**(随后专门复测:picker 空闲 60s+ 稳定,Esc 正常关闭),
  无 crash 产物,判定为环境性偶发(当时 Docker e2e build 正在抢占资源),不阻塞。

### 2.3 与官方 binary 的一致性对比

用新下载的官方 2.1.223 ELF 直接运行 `--version`/`--help`,与 OCC 构建做表面对比:

- `--version`:官方 `2.1.223 (Claude Code)` vs OCC `OCC 2.1.294`(品牌差异,by design)。
- 顶层 `--help` flag 集合 diff(提取所有 `--flag` 名排序对比):
  - **官方有、OCC 无:`--autocompact`** → 真实 gap,见 §3。
  - OCC 有、官方无:`--dangerously-skip-protected-paths`、`--mcp-debug`
    (均为 OCC 有意新增,已记录在 CLAUDE.md 的 by-design divergences)。
  - `--print` 存在(以 `-p, --print` 形式注册,diff 脚本的假阴性)。

## 3. Gap-58:官方 2.1.221 静默新增 `--autocompact <auto|tokens>`(已移植)

### 3.1 发现与定位

官方 2.1.223 ELF 的 `--help` 含 `--autocompact <auto|tokens>`,但官方 CHANGELOG
从无该 flag 的任何条目(静默新增)。逐版本二分下载官方 linux-x64 binary 验证:

| 版本 | `--help` 是否含 `--autocompact` |
|------|------|
| 2.1.218(OCC help 对齐基线) | ❌ 无 |
| 2.1.219 | ❌ 无 |
| 2.1.220 | ❌ 无 |
| **2.1.221** | ✅ **有(该版本静默新增)** |
| 2.1.222 / 2.1.223 | ✅ 有 |

OCC-44 对 2.1.221 的 ~40 条 triage 基于 changelog,因此漏掉了这个无条目变更。

### 3.2 官方行为(全部从 2.1.223 ELF 字节级逆向,未发明任何行为)

- **argParser(`Jon`)**:trim+lowercase;`auto` 直通;`Nm` 后缀 ×1e6;`Nk` 后缀 ×1e3;
  裸数 N∈[100,1000] 为千位简写("200"→200000),否则按原值;必须有限且在
  [100000, 1000000] 内,否则 undefined → Commander 抛
  `It must be 'auto', or between 100k and 1M (e.g. 500k, 200000, or 200 as shorthand)`。
- **settings key**:`autoCompactWindow` — `z.number().int().min(1e5).max(1e6).optional().catch(void 0).describe("Auto-compact window size")`(flag-settings schema,describe 文案逐字)。
- **合并语义(`Fju`)**:CLI flag 覆盖 settings;flag 传 `auto` 表示本会话清空 settings 覆盖。
- **优先级**:env `CLAUDE_CODE_AUTO_COMPACT_WINDOW` > CLI flag > settings > auto
  (官方 `/autocompact` 在 env 存在时拒绝修改:"…is set and takes precedence")。
- **消费**:window 只收缩有效上下文(cap 到模型窗口,"capped to model limit of …")。
- **非交互 `/autocompact [auto|<tokens>]`**(`-p` 变体):无参 → 当前 window 描述
  (`Auto-compact window: auto|N tokens (from settings|CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  [· capped to M by model]` + 说明行);有参 → 解析(reset/unset/default 等价 auto)+
  写 userSettings + 逐字成功/失败消息(含 `Couldn't parse '…'. Expected 'auto' or
  100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)`、`(capped to model limit of …)`、
  `, but a higher-priority override is active (… tokens)`),telemetry
  `tengu_autocompact_command {action: auto|set, tokens?}`。
- **交互 `/autocompact`**:官方为专用 dialog;OCC 现有实现打开 Settings 的 Config 页(保持)。

### 3.3 本轮移植(OCC 侧)

- `src/utils/autoCompactWindow.ts`(新增):`parseAutoCompactWindowInput`(`Jon` 逐字移植)、
  `resolveAutoCompactWindowOverride`(`Fju` 逐字移植)、session holder、范围常量。
- `src/main.tsx`:注册 `--autocompact <auto|tokens>`(官方 help 文案逐字,en-dash;
  argParser 抛官方逐字错误);action handler 最前部解析 `Fju(options.autocompact, settings)`
  并 `setSessionAutoCompactWindow()`,覆盖 headless 与 REPL 两条路径。
- `src/utils/settings/types.ts`:新增 `autoCompactWindow` schema key(官方 zod 定义逐字)。
- `src/services/compact/autoCompact.ts`:`getEffectiveContextWindowSize` 在无 env 时应用
  session window(`Math.min` —— 只收缩、不超过模型窗口);env 优先级保持不变。
- `src/commands/autocompact/autocompact-noninteractive.ts`(新增)+ `src/commands.ts`:
  非交互 `/autocompact` 描述/设置双路径,全部用户可见字符串逐字来自 ELF;
  注册模式与 `contextNonInteractive` 一致(`supportsNonInteractive`、非交互才启用)。
- 测试:
  - `src/utils/__tests__/autoCompactWindow.test.ts` — 21 tests(parser 全分支、schema
    bounds/catch、`Fju` 语义、threshold 消费、env 优先级)。
  - `test/e2e/version-2.1.221-autocompact.e2e.test.ts` — 9 e2e(help 文案、非法值拒绝、
    flag 真实会话往返、`-p /autocompact` 描述/设置/持久化/reset/简写 200→200k/非法输入/
    env 优先级),全绿(Docker runner + host 真实模型)。
- 真实行为验证(host,隔离 HOME):`-p "/autocompact 500k"` →
  `Auto-compact window set to 500k tokens (capped to model limit of 200k)`(端点模型
  200K 窗口,精确命中官方 capped 分支)+ settings.json 落 `{"autoCompactWindow":500000}`;
  `/autocompact` 复述 `(from settings) · capped to 200k by model`;`reset` 清空;
  env 存在时逐字 precedence 消息。`--autocompact 99` → Commander 逐字错误退出。

### 3.4 Staged(本轮不移植,附理由)

| 项 | 理由 |
|----|------|
| `S3` 的 server-driven window 源(`experiment`/`clientdata`,bootstrap `auto_compact_windows` 缓存)与 `unknown-model` 默认窗口 | Anthropic 后端绑定(OCC 无 fetchBootstrapData/GrowthBook 实数据面),与既往轮次同类 staging |
| 交互式 `/autocompact` 专用 dialog(dialog 组件逐字提取需专项反编译) | OCC 现以 Settings Config 页替代(既有行为);非交互设置路径已完整 |
| `apply_flag_settings` query 事件(设置后的 SDK control-request 回显) | OCC `-p` 无该 SDK 控制面;行为不可观测,不发明 |

## 4. 顺带修复(验收中发现)

- **Gap-58b(test infra)**:`test/e2e/Dockerfile` 用裸 `bun build` 而非 `bun run build`,
  未注入 MACRO.VERSION → 容器内 REPL 显示 v2.1.270(dev polyfill 默认值),
  导致 3 个 `repl-welcome-visual` 版本断言长期红。已改用 `bun run build`,
  容器内现为 `OCC 2.1.294`,welcome e2e 5/5 转绿。

## 5. Docker 全量 e2e 结果与失败分类

runner.sh(非 root `occ` 用户,官方 `--dangerously-skip-permissions` 拒绝 root):

- 改动前基线:**634 pass / 1 skip / 22 fail / 5 errors / 2289 expect(),657 tests**。
- 本轮改动后:**647 pass / 1 skip / 18 fail / 5 errors / 2333 expect(),666 tests**
  (+9 新增 autocompact e2e 全绿;3 个 repl-welcome-visual 因 Gap-58b 修复转绿;
  1 个 goal-gate 用例本轮转为绿 —— 该组为模型时延相关的抖动用例)。

失败分类(全部为**既有问题**,已逐项核对;A/B 验证:v2.1.294 dist 复跑同样失败):

- **root-only 运行(run.sh 一次性流)的 `--dangerously-skip-permissions` 类**:
  非 root runner 下已全部转绿(real-coding 等)。
- **容器模块解析(5 errors + occ-update-argv/resume-PTY)**:测试以相对路径
  `../../src/...` 直接 import 源码,挂载到 `/test/e2e` 后解析失败 —— 结构性问题,host 上通过。
- **goal-gate/goal-panel/trust-gate 等待 "for shortcuts"**:该 footer 文案被 mode
  指示符抑制(当前 footer 逻辑),**A/B:v2.1.294 同样失败**,非本轮回归;记录为下一轮候选。
- **repl-interactive "auto-mode opt-in dialog"**:OCC-44 已记录的既有 gap(A/B 一致)。
- **长时 tmux+模型类**(plan-approval ×2、screen-reader、/feedback、--append-system-prompt):
  模型时延相关的超时/断言抖动,非功能性回归。

## 6. 残留分支清理(验收员职责)

GitHub 上 v2.1.294 之后的合并 PR(#261、#263)对应分支与两个已关闭未合并的
 superseded 分支(PR #262 Monolith Rising 设计候选、PR #264 goal continueOnBlock
备选方案)共 5 条 agent 分支,均已随 PR 关闭,予以删除(见 issue 评论记录)。

## 7. 安全审查与发版

**安全审查(本轮 diff,release-gate)**:verdict **SAFE TO RELEASE**。
无网络/外泄/动态代码;settings 写路径仅 `autoCompactWindow` 单键、写前
parser 强校验 int∈[100k,1M]、undefined 真删键、读侧 zod `.catch(undefined)`
中和磁盘篡改值;零权限放宽、fail-closed 完整;`Math.min` 只收缩窗口、env
优先级保留;无硬编码 secret,`tengu_autocompact_command` 仅固定字面量+整数。
3×LOW 发现(已处理):analytics 字符串字段改用代码库既有的
`AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 转换模式;
事件名为新增(payload 惰性、通道既有);`findCommand` 不查 enablement 的
重名命令模式与既有 `context`/`contextNonInteractive` 一致(记录不改)。

**发版**:main 上 v2.1.294 之后已有 2 个未发布提交(OCC-51 hooks fix、occ50 logo)+ 本轮
Gap-58 移植与 infra 修复 → 验收通过后按发版流程发布 **2.1.295**(tag → publish.yml
→ npm + GitHub Release,`/releases` 与 `/tags` 一致性核验)。
