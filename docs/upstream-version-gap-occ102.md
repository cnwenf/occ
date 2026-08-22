# OCC-102 — 2026-08-23 版本追齐 2.1.238 → 2.1.240(keybindingFlavor 全量展开 + placeholder/killRange 重构,其余 staged)

## 1. 版本状态(三方核实,2026-08-23)

| 来源 | 状态 |
|------|------|
| npm `@anthropic-ai/claude-code` | latest = 2.1.240,next = 2.1.240 |
| GitHub releases | v2.1.240 |
| OCC(追齐前) | 2.1.308,行为面对齐官方 2.1.238 → 本轮 gap = **2 个版本(2.1.239 + 2.1.240)** |

二进制取证(官方平台包 `@anthropic-ai/claude-code-linux-x64`,`npm pack` 原样解包):

| 文件 | 字节数 | md5 |
|------|--------|-----|
| 2.1.238 `claude` ELF | (沿用 OCC-101 取证件) | `91dd252c1687383ff2fd6577782a21f8` |
| 2.1.239 `claude` ELF | 342,563,120 | `2473849a6119e77f0e7a137d840e827c` |
| 2.1.240 `claude` ELF | 342,636,848 | `8494744db1e5ff50dd54d5ce53c8746e` |

strings 转储(`strings -n 8`):strings238.txt / strings239.txt / strings240.txt。

官方 Release notes:

- **2.1.239**:约 60 条(见 §4 分类)。
- **2.1.240**:仅 "Bug fixes and reliability improvements"。对 239 引入的全部可移植面做 strings 级复核:`killRange` ×6、`getReadlineWordBoundaries` ×4、`backwardKillWord` ×5、`placeholderEndingAt` ×4,计数与 239 完全一致;useTextInput ctrl/meta 键表、kill 帮助函数簇(见 §2.2 取证原文)逐段比对无差异。**2.1.240 无新增可移植面**,本轮实质工作 = 追齐 2.1.239。

重复任务护栏:已核实无其他 running 的版本追齐 issue。

## 2. Landed 项(全部逐字节核实,`grep -aboF` + `dd` 原样提取)

2.1.239 的可移植面集中在**同一个子系统**:2.1.238 引入的 `keybindingFlavor` 从"只覆盖 Ctrl+W"扩展为**覆盖全部词级编辑键**,并把 2.1.238 已有的 placeholder(`[Pasted text #N]` 等)吸附体系与 kill-range 删除重构为统一的 `killRange`。OCC 侧对应收敛 `imageRef*`(Image-only 窄化)为官方完整 placeholder 族。

### 2.1 placeholder 全族收敛 + `killRange` 重构(Cursor.ts / vim)

2.1.238/2.1.239 二进制中四个帮助函数逐字节一致(仅类名 `Xf`→`Qp` 变化),239 原样:

```js
placeholderEndingAt(e){if(this.text[e-1]!=="]")return null;let t=this.text.slice(0,e).match(TME);return t?{start:e-t[0].length,end:e}:null}
placeholderStartingAt(e){if(this.text[e]!=="[")return null;let t=this.text.slice(e).match(kME);return t?{start:e,end:e+t[0].length}:null}
placeholderContaining(e){for(let t of this.text.matchAll(CME)){let r=t.index,n=r+t[0].length;if(e>r&&e<n)return{start:r,end:n};if(r>=e)break}return null}
snapOutOfPlaceholder(e,t){let r=this.placeholderContaining(e);if(!r)return e;return t==="start"?r.start:r.end}
```

regex 族(模块 `vEr`,strings239 偏移 8422787 区域逐字节):

```
\[(?:Pasted text|Image|Audio|\.\.\.Truncated text) #\d+(?: \+\d+ lines)?\.*\]
TME = <pattern>+"$"      // endingAt
kME = "^"+<pattern>      // startingAt
CME = <pattern>,"g"      // containing
AME = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu   // readline 词元(见 §2.2)
```

OCC 既有件 `imageRefEndingAt`/`imageRefStartingAt`/`snapOutOfImageRef`(`src/utils/Cursor.ts:325/330/340`)是同构窄化(仅 `\[Image #\d+\]`)。本轮改名为官方名并扩到全族;唯一族外调用点 `src/vim/operators.ts:503-504` 同步改名。

**`killRange`(239 新增,238 中命中 0 次;逐字节):**

```js
killRange(e,t){let r=this.snapOutOfPlaceholder(e,"start"),n=this.snapOutOfPlaceholder(t,"end"),o=new Qp(this.measuredText,r),i=new Qp(this.measuredText,n);return{cursor:o.modifyText(i),killed:this.text.slice(r,n)}}
```

239 把六个删除方法全部改经 `killRange`(双端点 placeholder 吸附,修复跨 `[Pasted text #N]` 的词级删除):

```js
deleteWordBefore(){if(this.isAtStart())return{cursor:this,killed:""};return this.killRange(this.prevWord().offset,this.offset)}
deleteWORDBefore(){if(this.isAtStart())return{cursor:this,killed:""};return this.killRange(this.prevWORD().offset,this.offset)}
deleteWordAfter(){if(this.isAtEnd())return this;return this.killRange(this.offset,this.nextWord().offset).cursor}
deleteToLineStart(){if(this.offset>0&&this.text[this.offset-1]===`
`)return{cursor:this.left().modifyText(this),killed:`
`};let e=this.startOfLine();return this.killRange(e.offset,this.offset)}
deleteToLineEnd(){if(this.text[this.offset]===`
`)return{cursor:this.modifyText(this.right()),killed:`
`};return this.killRange(this.offset,this.endOfLine().offset)}
deleteToLogicalLineEnd(){if(this.text[this.offset]===`
`)return this.modifyText(this.right());return this.killRange(this.offset,this.endOfLogicalLine().offset).cursor}
```

`deleteTokenBefore` 同步改用 `placeholderStartingAt`,且其内联 token regex 含 `Audio #\d+`(238/239 均含;OCC 窄化版缺,本轮补齐——OCC 暂无 Audio token 生产者,属保真收敛):

```
/(^|\s)\[(Pasted text #\d+(?: \+\d+ lines)?|Image #\d+|Audio #\d+|\.\.\.Truncated text #\d+ \+\d+ lines\.\.\.)\]$/
```

`nextWord`/`prevWord` 在 238/239 均为 placeholder 感知(两版逐字节一致;OCC 缺,本轮补齐——239 的 `deleteWordBefore = killRange(prevWord().offset, …)` 语义依赖它):

```js
nextWord(){if(this.isAtEnd())return this;let e=this.placeholderStartingAt(this.offset)??this.placeholderContaining(this.offset);if(e)return new Qp(this.measuredText,e.end);let t=this.measuredText.getWordBoundaries();for(let r of t)if(r.isWordLike&&r.start>this.offset){let n=this.snapOutOfPlaceholder(r.start,"end");return new Qp(this.measuredText,n)}return new Qp(this.measuredText,this.text.length)}
prevWord(){if(this.isAtStart())return this;let e=this.placeholderEndingAt(this.offset);if(e)return new Qp(this.measuredText,e.start);let t=this.placeholderContaining(this.offset);if(t)return new Qp(this.measuredText,t.start);let r=this.measuredText.getWordBoundaries(),n=null;for(let o of r){if(!o.isWordLike)continue;if(o.start<this.offset){if(this.offset>o.start&&this.offset<=o.end){let i=this.snapOutOfPlaceholder(o.start,"start");return new Qp(this.measuredText,i)}n=o.start}}if(n!==null){let o=this.snapOutOfPlaceholder(n,"start");return new Qp(this.measuredText,o)}return new Qp(this.measuredText,0)}
```

### 2.2 readline 词移动体系(239 新增,238 中命中 0 次)

```js
forwardWord(){if(this.isAtEnd())return this;let e=this.placeholderStartingAt(this.offset)??this.placeholderContaining(this.offset);if(e)return new Qp(this.measuredText,e.end);for(let t of this.measuredText.getReadlineWordBoundaries())if(t.end>this.offset){let r=this.snapOutOfPlaceholder(t.end,"end");return new Qp(this.measuredText,r)}return new Qp(this.measuredText,this.text.length)}
backwardWord(){if(this.isAtStart())return this;let e=this.placeholderEndingAt(this.offset)??this.placeholderContaining(this.offset);if(e)return new Qp(this.measuredText,e.start);let t=this.measuredText.getReadlineWordBoundaries();for(let r=t.length-1;r>=0;r--){let n=t[r];if(n.start<this.offset){let o=this.snapOutOfPlaceholder(n.start,"start");return new Qp(this.measuredText,o)}}return new Qp(this.measuredText,0)}
killWord(){let e=this.forwardWord();if(e.offset===this.offset)return{cursor:this,killed:""};return this.killRange(this.offset,e.offset)}
backwardKillWord(){let e=this.backwardWord();if(e.offset===this.offset)return{cursor:this,killed:""};return this.killRange(e.offset,this.offset)}
```

`MeasuredText.getReadlineWordBoundaries`(239 新增,逐字节;`AME` 见 §2.1):

```js
getReadlineWordBoundaries(){if(!this.readlineWordBoundariesCache){let e=[],t=!1;for(let r of this.getWordBoundaries()){let n=this.text.slice(r.start,r.end);for(let o of n.matchAll(AME)){let i=this.snapToGraphemeBoundary(r.start+o.index),s=r.start+o.index+o[0].length,a=this.snapToGraphemeBoundary(s),l=a===s?s:this.nextOffset(a),c=e.at(-1);if(c&&(i<c.end||i===c.end&&t))c.end=Math.max(c.end,l);else e.push({start:i,end:l});t=l!==s}}this.readlineWordBoundariesCache=e}return this.readlineWordBoundariesCache}
```

语义:在 Intl.Segmenter 词边界内再按 `[\p{L}\p{N}][\p{L}\p{N}\p{M}]*` 切出"字母数字词元",相邻词元(含跨组合字符接续 `t` 标志)合并——即 readline 的 `foo-bar` 整段为一个词,与 OCC-101 已移植的 `prevWORD`(whitespace 边界)形成互补:239 的 readline 词移动用新体系,`Ctrl+W` 的 `deleteWORDBefore` 保持 `prevWORD`(238/239 `nextWORD`/`prevWORD`/`endOfWORD` 逐字节无变化,已核)。

### 2.3 keybindingFlavor 消费点全量展开

238 只有 `["w",Y?_e:ge]` 一处;239 展开到全部词级键。`useTextInput`(239 钩子 `lns`,`Y=nns()==="readline"`,逐字节):

```js
function fe(){return Y?j.forwardWord():j.nextWord()}     // Alt+F / 修饰右箭头
function we(){return Y?j.backwardWord():j.prevWord()}    // Alt+B / 修饰左箭头
function Ie(){let{cursor:yt,killed:Ct}=j.killWord();return Se(Ct,"append"),yt}        // readline Alt+D
function xe(){let{cursor:yt,killed:Ct}=Y?j.backwardKillWord():j.deleteWordBefore();return Se(Ct,"prepend"),yt}  // Meta/Ctrl+Backspace
function Ne(){let{cursor:yt,killed:Ct}=j.deleteWORDBefore();return Se(Ct,"prepend"),yt} // readline Ctrl+W(238 已有)
// meta 键表:
[["b",we],["f",fe],["d",()=>Y?Ie():j.deleteWordAfter()],["y",Fe]]
// 键分派(mt 内):
case"left": …if(yt.ctrl||yt.meta||yt.fn)return we();…
case"right":…if(yt.ctrl||yt.meta||yt.fn)return fe();…
case"backspace":if(yt.superKey)return he();if(yt.meta||yt.ctrl)return xe();return j.deleteTokenBefore()??j.backspace();
// is-kill 判定(ot):
if(Y&&yt.meta&&!yt.ctrl&&yt.key==="d")return!0;   // ← 239 新增分支
```

`useSearchInput`(239 `phA`/`WL`)同构展开:

```js
phA(e,t){if(e.ctrl&&(e.key==="k"||e.key==="u"||e.key==="w"))return!0;
if((e.meta||e.ctrl)&&e.key==="backspace")return!0;          // ← 239:Ctrl+Backspace 纳入 kill(修复单字符截断)
if(t&&e.meta&&!e.ctrl&&e.key.toLowerCase()==="d")return!0;  // ← 239:readline Alt+D
return!1}
// 239 顺序:interrupt-dispatch 在 passthrough return 之前(238 在之后)
// backspace:if(j.meta||j.ctrl){h?backwardKillWord:deleteWordBefore;kill prepend}
// 修饰箭头:ctrl||meta||fn → flavored ie()/ne()
// meta 表:b/f flavored;d:h?{killWord→kill append}:deleteWordAfter
```

### 2.4 掩码输入加固(239 安全修复簇)

239 把四处掩码敏感面全部加门(修复掩码输入经 kill ring / 历史 / SR 播报泄漏):

```js
// kill 分派(239 新增函数):掩码输入不落 kill ring,改发 interrupt
function Se(yt,Ct){Q.dispatch(p===""?{type:"kill",text:yt,direction:Ct}:{type:"interrupt"}),OME(yt,p)}
// SR 播报(238 的 LKi 与 239 的 OME 逐字节一致,均带掩码参数;掩码时播 "deleted" 而非原文):
function OME(e,t){if(e==="")return;if(t!==""){r5e("deleted");return}let r=e.trim()===""?e.includes(`
`)?"new line":e.includes("\t")?"tab":"space":e.replaceAll(`
`," ").trim();r5e(r)}
// Esc 清空存历史:238 `if(s&&e.trim()!=="")` → 239 `if(s&&p===""&&e.trim()!=="")`
// Ctrl+U 提示:239 `p===""&&Ct.length>=3` 才出 "Ctrl+Y to paste deleted text"
```

OCC 的 kill ring 为模块级 API(官方为 reducer `{type:"kill"|"interrupt"|…}`)——该结构分歧在 OCC-101 已接受,观测契约等价;本轮 `interrupt` 对应 `resetKillAccumulation()`。OCC 的 `announceDeletedText`(`src/utils/srA11y.ts`)此前无掩码参数/空白映射,本轮按 `OME` 补齐。

### 2.5 isKillKey 收敛

239 完整集合:`ctrl&&(k|u|w)` + `readline&&meta&&!ctrl&&d` + `backspace&&(meta||superKey||ctrl)` + `delete&&(meta||superKey)`。后两项**官方 238 已有**(238 `et()` 逐字节核实),OCC 自 238 起滞后;本轮连同 239 新增的 readline Alt+D 一次收敛,并为 backspace/delete 补 `super` 分支(`super→killToLineStart`/`super→killToLineEnd`,与 isKillKey 语义自洽,否则 super+backspace 会被跳过 `resetKillAccumulation` 却不记录 kill,污染后续累积)。

## 3. 已对齐、本轮无动作

- `nextWORD`/`prevWORD` 238↔239 逐字节无变化(两端各命中 1 次全文比对);`endOfWORD` 两版均含 placeholder 前置吸附(逐字节一致)。
- 2.1.240:§2 全部簇在 strings240 中逐段一致(计数 + 键表/帮助函数簇比对),无可移植面。

## 4. Staged 项(不移植,逐条理由)

### 4.1 2.1.239 changelog 中无 OCC 可移植面的条目

- Remote Control / cloud sessions / plugins / 移动端推送簇:OCC 无该面(无官方服务端组件)。
- Bedrock/Vertex/第三方 provider 修复:OCC provider 面独立,官方修复点不在 OCC 代码路径上。
- VSCode 扩展 / Windows / IDE 集成条目:平台面不在 OCC 移植范围。
- KAIROS(休眠代理)相关:strings 中为 dormant 配置面,无运行时行为。
- voice 移除相关:239 为官方下线语音输入;OCC 的 voice 集成件为 OCC 自有面,不随官方下线。
- `claude-api` skill stub 条目:官方内置 skill 分发面。
- org policy / 登录流 re-send 条目:官方账号服务端交互面。

### 4.2 预存分歧(238/239 二进制逐字节一致,非本轮 delta,留待专项)

| 位置 | 官方 | OCC | 不移植理由 |
|------|------|-----|-----------|
| Ctrl+A/E | `startOfLogicalLine`/`endOfLogicalLine`(238 起) | `startOfLine`/`endOfLine` | 多行 wrapped-line vs logical-line 语义差异,238 时代已分歧;影响多行编辑习惯,需独立评审与 e2e |
| Ctrl+K | kill-to-line-end | OCC 移除(`chat:clearScreen` 独占) | OCC 有意适配,保留 |
| 左箭头手势簇(`tengu_left_arrow_editing_guard`/`leftArrowGesture`/`soloKeypress`/`disarmLeftArrowConfirm`) | 实验旗标门控的空输入左箭头确认/附着 | 无 | 依赖 OCC 缺失的一整套手势基建 + statsig 旗标,需专项移植 |
| home/end/pageUp/pageDown/return 的 `ctrl` 守卫 | `if(yt.ctrl)return`(no-op) | 无守卫 | 238 起即分歧;需先审计 OCC 键绑定上下文是否在别处绑定这些组合,避免死键/双触发 |
| up/down `shift\|\|ctrl\|\|meta` 守卫 | no-op | 仅排除 shift | 同上,238 起分歧 |
| `case"enter"`(CSI-u Ctrl+Enter 插换行) | `return j.insert("\n")` | 无(name 恒为 `return`) | parse-keypress 层差异,需先核 OCC 是否会产出 `enter` name |
| super+left/right → startOfLine/endOfLine | 238 起 | 无 | 纯移动面,非本轮 delta;与键绑定上下文审计一并处理 |
| vim `nextVimWord`/`endOfWORD` 的 placeholder 前置吸附 | 238 起 | 无 | vim 专用面;本轮已收敛 `snapOutOfImageRef`→`snapOutOfPlaceholder` 供 `src/vim/operators.ts` 使用,vim 词移动吸附留待 vim 专项 |
| kill ring 结构:官方 reducer dispatch vs OCC 模块级函数 | — | — | OCC-101 已接受,观测契约等价 |

### 4.3 需独立验证的官方修复候选(本轮未展开二进制取证,建议后续追齐或独立 issue 跟进)

- WebFetch 内容保留策略、cwd 被删崩溃、UTF-8 BOM、`posix_spawn` ENOENT、`/goal` 退避、`claudeMdExcludes` symlink、`-c` 会话规范化、org-policy re-send。

## 5. 验收

- 新增/扩展单元测试覆盖:placeholder 族四函数、`killRange` 六删除、`getReadlineWordBoundaries`、`forwardWord`/`backwardWord`/`killWord`/`backwardKillWord`、掩码 kill/历史/hint 门、两钩子 flavored 分派。
- `bun test src` 全量(预期 8 个预存失败:2.1.202/2.1.216 telemetry ×2 + 2.1.218 agentHookTrust,A/B stash 核过)。
- 真机 REPL e2e:`test/e2e/version-2.1.239-keybinding-flavor.e2e.test.ts`(tmux 内真实键序列,含 `keybindingFlavor: "readline"` 与 classic 双态)。
- `bun run build` 通过;安全审查(后门/混淆/外联)通过后合入 `main`。
