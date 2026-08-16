# OCC-96 — 2026-08-17 版本追齐调研 + Gap-96 shell-marker escape port

## 1. 版本状态（三方核实，2026-08-17）

| 来源 | 结果 |
|------|------|
| npm `@anthropic-ai/claude-code` dist-tags | `latest` = `next` = `2.1.233` |
| GitHub releases (cnwenf 镜像查询 anthropics/claude-code) | latest release `v2.1.233`（published 2026-08-14） |
| 全新下载官方 2.1.233 linux-x64 ELF | 324,598,064 bytes；strings 中 `2.1.233` 版本标记 ×249，`2.1.234+` 标记 ×0 |

**结论：官方最新版仍为 `2.1.233`，无新版本。** OCC 已在 OCC-95（release
`2.1.302`）追平 2.1.233 的可移植子集。本轮无版本差可追，工作重心按 issue
指示转为：清掉 OCC-95 留下的 **latent gap**（官方 `Q9` shell-marker escape
回调未移植），随后做严格自验收。

> OCC-95 gap doc §4 把该回调写作 "`B9`/`Q9`" —— 本轮在 2.1.233 ELF 里逐字节
> 核实：**只存在一个**这样的函数（`Q9`；正则签名 ``replace(/`!/g,"` !")…``
> 全 ELF 仅 1 处），"B9" 是 minified-name 歧义记录，不是第二个函数。

## 2. Gap-96：官方 Q9/Z7t/EYp shell-marker escape 家族

### 2.1 威胁模型

skill / 自定义 slash command / plugin command 的 prompt 在
`executeShellCommandsInPrompt` 里会执行 `` !`cmd` `` 内联标记与 ```` ```! ````
块标记。**用户调用命令时传入的参数**会先经 `sCt` 替换进模板 —— 如果参数值里
带着 `` !`malicious` ``，替换后就会形成一个**活的**执行标记。官方 2.1.233 的
解法：`sCt` 第 5 个参数是一个 value-transform 回调，所有会进入 shell-exec
管线的替换值都先过 `Q9` 转义。OCC-95 移植了 sCt 的 sentinel 安全重写，但
**没有移植这个回调**（当时记为 latent gap）—— 即 OCC 存在参数注入面。

### 2.2 官方函数（全部自 2.1.233 linux-x64 ELF 逐字节恢复）

```js
// Q9 — shell-marker 转义（三个 replace 串行执行，后一步看前一步的输出）
function Q9(e){return e.replace(/`!/g,"` !").replace(/!`/g,"! `").replace(/(^|\s)!/gm,"$1\\!")}

// Z7t — 尖括号 HTML 转义（不转义 &）
function Z7t(e){return e.replaceAll("<","&lt;").replaceAll(">","&gt;")}

// EYp — 用户名白名单清洗
function EYp(e){return e.replace(/[^a-zA-Z0-9._-]/g,"")}
```

`sCt` 第 5 参 insertValue 顺序（二进制 `Ckn+(o?o(d):d).replaceAll("$",vLr)+Ckn`）：
sanitize → **transform** → `$`-shield → boundary-wrap。

### 2.3 官方调用点全枚举（ELF 核实）

| 调用点 | transform | OCC 对应面 | 本轮处理 |
|--------|-----------|-----------|---------|
| sCt 定义 | 第 5 参 `o` | `substituteArguments` | ✅ 加 `valueTransform` 第 5 参 |
| plugin-command `G=sCt(G,Y,!0,S,Q9)` | `Q9` | `loadPluginCommands.ts` | ✅ 传入 `escapeShellExecutionMarkers` |
| skill-dir `q=sCt(q,D,!0,c,Xkt?Z7t(Q9):Q9)` | `Q9`，MCP 源 `Z7t(Q9)` | `loadSkillsDir.ts` | ✅ `loadedFrom==='mcp' ? Z7t∘Q9 : Q9` |
| prompt-hook `sCt(d,n)` | 无 | `hookHelpers.ts` | ✅ 不改（官方即无） |
| agent-hook `sCt(e.prompt,n)` | 无 | hooks 路径 | ✅ 不改（官方即无） |
| X9o plugin-command `X9o(G,OQ(r),cfg,Q9)` | `Q9` | `substituteUserConfigInContent` | ✅ 加第 4 参并传入 |
| X9o plugin-agent `X9o(H,OQ(n),cfg)` | 无 | `loadPluginAgents.ts` | ✅ 不改（官方即无） |
| SYp /commit-push-pr | `Q9(commitAttribution)`、`Q9(prAttribution)`、`EYp(SAFEUSER)`、`EYp(USER)`、用户参数 `Q9` | `src/commands/commit-push-pr.ts` | ✅ 全部移植 |
| JGw /commit | `Q9(commitAttribution)` | `src/commands/commit.ts` | ✅ 移植 Q9(attribution) |
| h6w/Yog `/pr` command | `Q9`/`EYp` 同族 | OCC 无 /pr 命令 | N/A（见 §4） |
| x2n claude-import SKILL.md writer | `EYp` | OCC 无 import 面 | N/A |

`Xkt`（MCP-untrusted 判定）官方按 `loadedFrom` 分派：
'skills'/'commands_DEPRECATED'/'plugin'/'managed'/'bundled' → false；
'mcp'/'syncedSkills'/'memoryStore' → true。OCC 无 syncedSkills/memoryStore
来源，故退化为 `loadedFrom === 'mcp'`。

### 2.4 经验验证（移植前，aligning-with-official-binary 纪律）

`/tmp/occ96/scratch/probe.mjs`：用官方字节重建 sCt/Q9/Z7t/EYp/RQs/cWo，
30 个探针 **30/30 通过**。关键语义：

- 串行链：``a`!b`` →（step1）``a` !b`` →（step3）``a` \!b``（step1 插入的
  空格使 step3 命中 —— 不是 ``a` !b``）。
- 12 种对抗性标记形态全部中和；模板自有的标记不受影响（transform 只作用于
  替换值，不作用于模板）。
- Z7t 只转 `<`/`>`，不转 `&`。
- 与 `>` 粘连的 `!`（如 `<b>!`id``）Q9 step3 不转义 —— 但标记本来就死了：
  INLINE_PATTERN 要求 `!` 前是行首/空白。与官方逐字节一致。

## 3. 本轮落地（OCC src）

| 文件 | 变更 |
|------|------|
| `src/utils/promptShellExecution.ts` | 新增 `escapeShellExecutionMarkers`(Q9)、`escapeAngleBrackets`(Z7t)、`sanitizeUsername`(EYp)，注释标注二进制出处 |
| `src/utils/argumentSubstitution.ts` | `substituteArguments` 增加第 5 参 `valueTransform`；insertValue 顺序 = sanitize → transform → `$`-shield → wrap（与 sCt 逐字节一致） |
| `src/skills/loadSkillsDir.ts` | skill 替换点传入 `loadedFrom==='mcp' ? Z7t∘Q9 : Q9` |
| `src/utils/plugins/loadPluginCommands.ts` | `substituteArguments` 与 `substituteUserConfigInContent` 均传入 Q9 |
| `src/utils/plugins/pluginOptionsStorage.ts` | `substituteUserConfigInContent` 增加可选第 4 参 `valueTransform`（X9o 第 4 参） |
| `src/commands/commit-push-pr.ts` | `sanitizeUsername(SAFEUSER/USER)` + `Q9(commitAttribution/prAttribution/用户参数)` |
| `src/commands/commit.ts` | `Q9(commitAttribution)` |
| `src/utils/hooks/hookHelpers.ts`、`src/utils/plugins/loadPluginAgents.ts` | **不改** —— 官方在这两处不传 transform |

**测试：**
- `src/utils/__tests__/shellMarkerEscape233.test.ts` — 23 个单测：Q9 串行链
  全形态、Z7t/EYp、sCt 第 5 参的顺序/`$`-shield/append 路径、X9o 第 4 参、
  MCP 双重转义（含粘连-`>` 官方语义）。
- `test/e2e/version-2.1.303-skill-shell-marker-escape.e2e.test.ts` — 4 个
  行为 e2e：走**真实** `createSkillCommand → getPromptForCommand` 加载路径，
  注入参数被中和、模板标记保持活性、MCP 路径双重转义、无害参数原样通过。

**验证：**
- 全量 src 套件 **2002 pass / 0 fail / 4644 expect() / 211 files**
  （基线 1979/0/4602/210，+23 全部为本轮新增）。
- 精选 e2e：occ-versioning + commands-alignment + version-2.1.163 +
  version-2.1.303（14 pass/0 fail）；version-2.1.219-* +
  resume-interrupted-turn-221（50 pass / 0 fail / 182 expect，与 OCC-46 基线一致）。
- `bun run build` 绿（`dist/cli.js` 28.90 MB）；Biome 对改动文件 0 error /
  0 warning（仓库级 lint 失败为 bridgeMain.ts 既有 suppressions 噪音，
  未改动树上同样失败）。
- `occ -p` live smoke：`say PONG` → `PONG`，exit 0。
- **tmux REPL 真人式自验收**（/tmp/occ96repl 临时项目 + probe skill）：
  - 启动正常（OCC v2.1.302 banner、模型连通、/tmp/occ96repl cwd 显示）；
  - `/probe !`echo INJECTED-PWN`` —— **模板自有标记执行**
    （输出 `TEMPLATE-LIVE-OK`），**注入标记被中和**为字面
    `\! echo INJECTED-PWN` 交给模型复述，全程无执行、无权限弹窗；
  - 普通对话回合 `say REPL-OK exactly` → `REPL-OK`（core trunk 一致）。
  - 与官方交互一致性：未发现新的不一致（见 §5）。

## 4. 记录在案、本轮不移植的差项

| 项 | 原因 |
|----|------|
| 官方 2.1.233 `/commit` 完整 prompt 重写（JGw：新增 "User guidance for this commit" 段 + 不同安全协议措辞 + 参数透传） | 属于 prompt 文案级重构且涉及 OCC `/commit` 参数面变更；本轮只移植其中与安全相关的 Q9(attribution) 一项。文案对齐留待后续版本追齐轮按字节移植。 |
| 官方 `/pr` 命令（h6w/Yog） | OCC 无此命令面；新增整条命令超出"追齐安全差"范畴，单独立项处理。 |
| claude-import SKILL.md writer（x2n 的 EYp） | OCC 无 claude-import 面，N/A。 |

## 5. 自验收结论（no-new-version 轮）

按 issue 指示以真人用户方式使用 OCC REPL：启动、模型往返、skill 调用（含
本轮新移植的转义路径）、普通对话均与官方 `uvx claude-code` 交互一致，
**未发现新的不一致/gap**。本轮唯一的对齐差（Q9 escape 家族）已移植并经
行为级验证。

## 6. 发布

OCC 版本 `2.1.302 → 2.1.303`；合入 main 后打 tag `v2.1.303` 触发
`.github/workflows/publish.yml`（build → npm publish → GitHub Release）。
