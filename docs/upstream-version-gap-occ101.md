# OCC-101 — 2026-08-22 版本追齐 2.1.237 → 2.1.238(1 项 landed,其余 staged/无移植面)

## 1. 版本状态(三方核实,2026-08-22)

| 来源 | 状态 |
|------|------|
| npm `@anthropic-ai/claude-code` | latest = 2.1.238,next = 2.1.238(2.1.239 未发布) |
| GitHub releases | v2.1.238 |
| OCC(追齐前) | 2.1.307,行为面对齐官方 2.1.237 → 本轮 gap = **1 个版本** |

二进制取证(官方 npm 包,2.1.113+ 为 Bun 编译 ELF,JS 以字符串内嵌):

| 文件 | 字节数 | 版本标记计数 |
|------|--------|--------------|
| 2.1.237 `cli.js` ELF | 334,715,184 | "2.1.237" ×122 |
| 2.1.238 `cli.js` ELF | 338,860,336(+4,145,152) | "2.1.238" ×379,"2.1.237"/"2.1.239" ×0 |

strings 转储(`strings -n 8 | sort -u`):s237 289,861 行 / s238 291,877 行;差集 new238 = 10,596 行。

官方 CHANGELOG(抓自 GitHub raw):**2.1.238** 39 条。

新特性取证:`keybindingFlavor` 在 s237 中命中 **0** 次、在 s238 中命中 **4** 次 → 2.1.238 真新增,且是本轮唯一"干净、自包含、可完整逐字节核实"的可移植项。

## 2. Landed 项(1 项,全部逐字节核实)

### 2.1 `keybindingFlavor` 设置(2.1.238 changelog 第 1 条)

> Added a `keybindingFlavor` setting: set it to `"readline"` to make Ctrl+W in the prompt delete back to the previous whitespace, as in Bash; the default (`"classic"`) is unchanged.

**v238 ELF 逐字节取证:**

1. **设置字段**(schema describe 命中偏移 106365413 / 302371634;枚举 `tBu` 偏移 302254975):

```js
keybindingFlavor:Pr(tBu).optional().catch(void 0).describe(`Which conventions the prompt's editing keys follow: "readline" matches Bash and other readline programs (Ctrl+W deletes back to the previous whitespace); "classic" (default) keeps Claude Code's long-standing behavior (Ctrl+W deletes the previous word)`)
// tBu=["classic","readline"]
```

   字段位置:紧跟 `editorMode` 之后、`vimInsertModeRemaps` 之前。OCC 的 `editorMode` 在全局配置(getGlobalConfig)而非设置 schema,故 port 时保持相对顺序——放在 `vimInsertModeRemaps` 紧邻之前。

2. **默认值读取器**(偏移 317765640):

```js
var Arh="classic";function kKi(){return Sh((e)=>e.settings.keybindingFlavor)??Arh}
```

3. **消费点(恰好 2 处,`command grep -aboF` 全量枚举):**

   - `kKi()==="readline"` ×2:`useTextInput` 主输入钩子(偏移 317787054 区域,`let Y=kKi()==="readline"`)与 `useSearchInput` 搜索输入钩子(偏移 320274841 区域,`let h=kKi()==="readline"`)。两处均在渲染时求值一次。
   - `.deleteWORDBefore()` ×2(偏移 317788559 / 320278000):即上述两个消费点各一处。**Meta+Backspace 路径不分支**(二进制只有 2 处真实调用点),port 保持同样行为。

4. **Ctrl+W 分派**(useTextInput 键表,逐字节):

```js
["w",Y?_e:ge]   // Y=readline 时用 _e(WORD-kill),否则 ge(word-kill)
```

5. **`deleteWORDBefore` 实现**(Cursor 类 `Xf`,逐字节):

```js
deleteWORDBefore(){if(this.isAtStart())return{cursor:this,killed:""};
let e=this.snapOutOfPlaceholder(this.prevWORD().offset,"start"),
t=new Xf(this.measuredText,e),r=this.text.slice(t.offset,this.offset);
return{cursor:t.modifyText(this),killed:r}}
```

   OCC 既有件对照:`prevWORD()`(line 821,whitespace-only 边界,与二进制逐字节一致)、`snapOutOfImageRef()`(line 340,= 二进制 `snapOutOfPlaceholder`)、`isAtStart()`、`isOverWhitespace()`、`deleteWordBefore()`(line 916,classic 路径,基于 `prevWord()` 的 Intl.Segmenter 词边界)。差异仅在含 `-`/`/`/`:` 的输入:readline 杀到上一空白(整段 `foo-bar`),classic 只杀最后一个 Segmenter 词(`bar`)。

**Port(OCC 侧,5 个文件):**

| 官方 | OCC |
|------|-----|
| settings schema `keybindingFlavor` 字段 | `src/utils/settings/types.ts`:`z.enum(['classic','readline']).optional().catch(undefined)` + 逐字节 describe 文本,置于 `vimInsertModeRemaps` 之前 |
| `kKi()`/`Arh` 读取器 | `src/utils/keybindingFlavor.ts`(新):`getKeybindingFlavor()`/`isReadlineKeybindingFlavor()`;显式 `=== 'readline'` 判定,非法值(如 `'emacs'`)落回 `'classic'`(对齐 `.catch(undefined)` + `?? "classic"` 语义) |
| `Xf.deleteWORDBefore` | `src/utils/Cursor.ts`:新增 `deleteWORDBefore()`,逐语句镜像二进制(`snapOutOfImageRef(this.prevWORD().offset,'start')` → killed slice → `modifyText`) |
| useTextInput `["w",Y?_e:ge]` | `src/hooks/useTextInput.ts`:新增 `killWORDBefore()`(deleteWORDBefore + kill ring prepend + SR announce,与既有 `killWordBefore()` 同构),Ctrl+W 表项改为 `['w', isReadline ? killWORDBefore : killWordBefore]` |
| useSearchInput `h` 分支 | `src/hooks/useSearchInput.ts`:`case 'w'` 按 `isReadline` 分支 `deleteWORDBefore()`/`deleteWordBefore()`,kill ring 行为不变 |

两处 Meta+Backspace 路径按二进制保持 classic 不分支。

**测试:**

- `src/utils/__tests__/cursor-deleteWORDBefore.test.ts` — 7 例(空文本起点、跨 `foo-bar` 的 WORD-kill、与 classic `deleteWordBefore` 的对照、纯词、空白+前词、边界停留、尾随空白)
- `src/utils/__tests__/keybindingFlavor.test.ts` — 4 例(缺省 classic / readline / classic / 非法值回落;经临时 `CLAUDE_CONFIG_DIR` 磁盘播种真实设置路径,不用 mock.module——后者会进程级泄漏,曾在本轮打破 screenReader.test.ts,按 OCC-97 教训改为磁盘 seam)
- `src/utils/settings/__tests__/keybindingFlavor.test.ts` — 4 例(schema 接受 classic/readline/缺省;非法值被 `.catch(undefined)` 吞掉)
- `test/e2e/version-2.1.238-keybinding-flavor.e2e.test.ts` — 2 例真实 tmux REPL e2e:播种设置后启动真 `occ`,输入 `foo-bar` 发 `C-w`,classic 留 `foo-`、readline 清空
- 全量:`bun test src` **2129 pass / 8 fail**;8 个失败经 `git stash` A/B 验证全部为**存量失败**(2.1.202 telemetry ×2、2.1.216 permission telemetry ×1、2.1.218 agentHookTrust ×5),与 keybindingFlavor/Cursor/textInput/settings 新字段无关;新增 15 例单测全绿,2 例 e2e 全绿。

## 3. Staged 项(其余 38 条,逐条理由)

**子系统缺失/休眠**(OCC 无对应实现面,不新造——与 CLAUDE.md 已记录的 trimmed 边界一致):

- plugin marketplace `headersHelper` ×2(条目 2–3)— Plugins/Marketplace 已裁剪
- `claude self-hosted-runner --defer-shutdown-max-min`、`--proxy-authorization-command/file`、runner 误移除修复(条目 4、5、10)— 无 self-hosted runner 子系统(new238 中 self-hosted-runner 相关新字符串 ×26,全部属该子系统)
- Remote Control ×8(条目 19、21–26、33;new238 中 remoteControl 相关新字符串 ×48)— OCC 无 RC
- `ListAgents`/`SendMessage` ×2(条目 27、28)— 休眠 KAIROS 子系统(feature flag 关闭,启用有挂起风险,见 `featureFlags.ts` 头部文档)
- 跨会话消息 ×2(条目 29、30)— 休眠 UDS_INBOX 子系统(同上)
- `claude-api` skill 更新(条目 35)— OCC 内置技能 .md 为有意 stub(历轮既定裁决)
- MCP `headersHelper` trust/凭据剥离 ×2(条目 38、39)— OCC MCP 面已简化,无 headersHelper
- remote session invalid-role 退出(条目 20)— RC 服务端

**无可移植字符串表面 / 需逐站点反编译**(有 OCC 对应面但修复站点歧义,按 `aligning-with-official-binary` "绝不猜测/绝不部分移植"裁决,留待后续专门轮次):

- 子代理工具结果出显示窗口即释放(条目 6)— new238 有 "released once" 表面,但修复站点需消息窗口生命周期反编译
- 自定义/项目/插件 output styles 中途漂移(条目 7)— OCC 有 output styles,修复站点需反编译
- `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true` 近限额保持(条目 8)— OCC 无账户限额/建议系统
- worktree-isolation Bash 拒绝文案(条目 9)— OCC 无 worktree-isolation 沙箱(new238 worktree-isolation 表面 ×8 均属官方沙箱)
- MCP elicitation URL>4096 / 权限提示宽度丢"不再询问"(条目 11)— OCC MCP 已简化,两站点均需反编译
- `/tmp/claude-*-cwd` 残留清理(条目 12)— OCC 有同款 `claude-${id}-cwd` 模板(`src/utils/shell/bashProvider.ts`),清理站点需反编译(下一轮最自然的候选)
- 大突发按键下 Ctrl+H=Backspace 被忽略(条目 13)— 输入路径突发处理站点需反编译
- 权限 diff 宽字符/制表符折行(条目 14)— 权限 UI 站点需反编译
- Ctrl+Z 杀会话后终端残留括号粘贴/隐藏光标(条目 15)— 终端清理路径需反编译
- stdio MCP `server/discover` 先于 `initialize`(条目 16)— OCC 无 server/discover 协议
- 代理拒绝连接被报为通用网络错误(条目 17)— 网络层报错站点需反编译
- `/model`/`/effort` cache-miss 误报(条目 18)— OCC `/model` 无对应警告面
- macOS 裸启动提速(条目 31)— 平台/性能,无可对齐表面
- zsh 条件式 Bash 权限检查改进(条目 32)— 与 OCC-44/46 同类的 AST 安全面,需逐站点反编译对齐(下一轮候选)
- 自动更新检查延后 10s(条目 34)— OCC 无自动更新器
- Ctrl+L/Cmd+K 全屏仅重绘、去掉双击 `/clear`(条目 36)— OCC 全屏路径需反编译
- `mcp list`/`mcp get` 显示 `⊘ Disabled`(条目 37)— 渲染站点需反编译(下一轮候选)

## 4. 版本指针

- 本轮发布 **OCC 2.1.308** = 官方 2.1.238 行为面(唯一干净可移植项 keybindingFlavor 已 landed;其余 38 条均附逐条取证理由)。
- 下一轮起点:官方 2.1.239 之后的版本(如有);staged 候选中最自然的后续为 `/tmp/claude-*-cwd` 残留清理与 `mcp list` 的 `⊘ Disabled` 显示。

