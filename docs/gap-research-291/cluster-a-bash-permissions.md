# Gap Research 2.1.290/291 — Cluster A: Bash/命令权限检查

- 追齐基线：官方 2.1.289（OCC 当前对齐版本）
- 目标版本：官方 2.1.290（2.1.291 无本 cluster 相关增量，本文件所有 290 证据在 291 中同样存在）
- 取证对象（只读取字节，从未执行）：
  - `/tmp/cc289/package/claude`（md5 `5c920e4c…`）
  - `/tmp/cc290/package/claude`（md5 `acc2b427…`）
  - `/tmp/cc291/package/claude`（md5 `82c1f303…`）
- 取证方法：`grep -aboF '<needle>' binary` 得字节偏移；`tail -c +$((OFF+1)) binary | head -c N | tr -c '[:print:]\n' ' '` 抽取上下文。应用 JS 在 ELF 中嵌入两份（约 97–105MB 与 202–243MB 区段），minified 名每个 build 不同且跨 chunk 会撞名——所有引用均以偏移+区段双重确认。

## 判定总表

| # | changelog 条目 | 判定 | 一句话理由 |
|---|---|---|---|
| 1 | 通配符参数只读命令误自动批准（rg / git grep） | **NO-OP**（安全面）＋备注分歧 | OCC 的 `containsUnquotedExpansion` 更严格：任何未引号 glob 直接丧失只读资格→ask；官方 Tnn 简单命令例外 OCC 没有（OCC 多 ask，不多 allow） |
| 2 | zsh 与 bash 读法不同的变量名误自动批准 | **STAGED** | 官方新增非 ASCII `$[#^=~+]*name` / `$#name[…]`/`$#name:x` → ERROR → ask 升级；OCC 的 zsh 守卫只覆盖 `[[ ]]` pattern 与 `~[`/`=cmd`，裸参数 `$=vær` 类 token 按字面 word 放行 |
| 3 | 更多 `ps` 形式要求审批 | **STAGED** | OCC `ps` spec 仍是 289 旧回调（`/^[a-zA-Z]*e[a-zA-Z]*$/`），无 `respectsDoubleDash:!1`、无新四条件回调 |
| 4 | `pyright` 不再视为只读 | **STAGED** | OCC 仍保留 `PYRIGHT_READ_ONLY_COMMANDS` 并 spread 进只读表；官方 290 已从表中整体删除 |
| 5 | declare/typeset/export/readonly 前缀赋值的变量名逃过 deny/ask 规则 | **STAGED** | OCC 把前缀赋值当瞬时 env（不入 varScope），后续 `$X` → too-complex → ask（fail-safe），但 deny 规则永远匹配不到解析出的名字；官方 290 用 declarationPrefix readings 枚举让规则真正命中 |
| 6 | 只读命令 option value 里的通配符未应用 Read deny 规则/目录外读封锁 | **NO-OP**（安全面）＋备注 | 与 #1 同一官方机制（`uVe` 门）；OCC 侧任何未引号 glob 已阻断只读自动批准，且官方 2.1.271 fix B（glob 参数补入读校验）OCC 已移植（`collectUnextractedGlobArgs`） |

STAGED 移植目标文件汇总：
- #2：`src/utils/bash/ast.ts`（walkArgument word 分支 + 顶层 zsh differential 守卫区）
- #3：`src/tools/BashTool/readOnlyValidation.ts`（`ps` CommandConfig，行 363–434）
- #4：`src/utils/shell/readOnlyCommandValidation.ts`（删除 `PYRIGHT_READ_ONLY_COMMANDS`，行 1501–1537 区域）＋ `src/tools/BashTool/readOnlyValidation.ts`（去掉 import 行 20 与 spread 行 1136）；`src/utils/bash/specs/pyright.ts` 补全 spec 保留（官方也保留）
- #5：`src/utils/bash/ast.ts`（walkCommand 前缀赋值分支）＋ `src/tools/BashTool/bashPermissions.ts`（规则匹配入口，readings 重判回路）

---

## 共享机制：290 新增的 per-argv 未引号 glob 门（#1、#6 共用）

### 官方机制（字节证据）

**(a) 文本级扫描器本身没变。** 289 的 `WBe`（@210000018）与 290 的 `dVe`（@213191229）逐 token diff 后仅变量名不同：同为「单引号/双引号/反引号/转义/注释状态机 + `$name` → "variable" + 未引号 `*?[…]` → "glob"」。290 的简单命令集合 `Tnn` 与 289 的 `x6o` 完全一致：

290 @213191229 区段（scanner 结尾直接接新函数，为本版本新增）：
```
}return h?"glob":!1}var Tnn=new Set(["ls","cat","head","tail","wc","stat","grep","egrep","fgrep","diff","du","df","echo","strings","hexdump","od","nl","cut","column","tr","tac","rev","cmp","basename","dirname","realpath","readlink","sha256sum","sha1sum","md5sum","cd"]);
function xmr(e){return e.argvUnquotedGlob===void 0&&e.argv[0]==="[["&&/^\[\[[ \t\n]/.test(e.text)}function uVe(e){return!xmr(e)&&kAn(e)&&!Tnn.has(fVe(e.argv)[0]??"")&&oye()}
```
（289 中 `WBe` 之后直接是 `var x6o=new Set([...同列表...])`，**没有** `xmr`/`uVe`。）

**(b) 新增组合子 `kAn` + glob 正则 `St`**，290 @206274889：
```
var St=/[*?]|\[[^\]]*\]/;function V(e){return St.test(e)}function kAn(e){let t=e.argvUnquotedGlob;if(e.carveOutMayDesyncQuoteScan===!0||t===void 0&&e.argv.some(zs))return e.argv.some(V)||e.redirects.some((s)=>s.op!=="<<"&&s.op!=="<<<"&&V(s.target));if(t===void 0)return!1;if(t.length!==e.argv.length)return e.argv.some(V);return e.argv.some((s,o)=>V(s)&&(t[o]===!0||zs(s)))}
```
语义：优先用 tree-sitter 解析出的 per-argv `argvUnquotedGlob` 布尔数组逐 token 判定「token 含 glob 字符 且（解析确认未引号 或 token 含 `$(`/`${` 命令替换）」；解析信息缺失/长度失配/carve-out 可能导致引号扫描失步（`carveOutMayDesyncQuoteScan`）时退化为对全部 argv 与重定向目标做 `V` 粗判。`zs`（290 @206272516，= 289 `Pi` @203769650，两版逐字相同）判定 token 含 `$(` 或 `${`。这覆盖了 289 文本扫描器的漏检面——典型如 `rg $(echo '*.c')`：`*` 藏在替换内部的单引号里，`WBe`/`dVe` 的引号状态机看不到它，但 shell 对未引号替换结果仍会做 glob 扩展；`kAn` 通过 `zs(token)`＋替换后 argv 的 `V` 命中。

**(c) AST word walker（计算 argvUnquotedGlob 的来源）**，290 @206327026：
```
var Xt="*?[";function me(e){switch(e.type){case"word":case"number":…逐字符扫描并跳过反斜杠转义…case"string":case"raw_string":case"simple_expansion":case"arithmetic_expansion":return!1;case"concatenation":return e.children.some(…);default:return!0}}
```
且 290 的 worktree/git 前缀规则 chunk 现在把 `Me.hasUnquotedGlob,Me.argvUnquotedGlob` 传入 SimpleCommand 构造器 `tin(...)`（@213467661/@213468918）；289 的对应 worktree chunk 中 `argvUnquotedGlob` 出现次数为 0——即 289 经前缀规则（如 `git grep` 子命令）构造的 SimpleCommand 缺失该字段，这正是 changelog 点名 `git grep` 的原因。

**(d) allow 函数接入 uVe 门。** 290 @213200597 区段（逐字）：
```
let ke=fVe(_e.argv);if(uVe(_e))return!1;if(dVe(_e.text)==="glob"||H==="glob"&&_e.argv.some((Te)=>/[*?]|\[.*\]/.test(Te)))return Tnn.has(ke[0]??"");let be=wmr(ke);if(be!==null)return be;return Amr(Nmr(_e.text))
```
289 对应位置 @210009442（逐字）：
```
let be=n4t(ye.argv);if(WBe(ye.text)==="glob"||B==="glob"&&ye.argv.some((Ce)=>/[*?]|\[.*\]/.test(Ce)))return x6o.has(be[0]??"");let Ee=E6o(be);if(Ee!==null)return Ee;return A6o(N6o(ye.text))
```
唯一语义差异：290 在旧 glob 行之前插入 `if(uVe(_e))return!1;`。（`n4t`@210005575 与 `fVe`@213196959 逐字相同，仅剥 `command`/`builtin`/`noglob` 包装，不处理 git 子命令。）

**(e) 决策函数接入 xe 门。** 290 决策函数（`znn` 区段，@213224189 附近；z290.txt 第 188–189 行，逐字）：
```
let Te=fF(w&&NT(w)),Ce=Vhe(n)&&wnn(e.command),xe=s!==void 0&&uVe(s);
if(!Ce&&!xe&&ci.isReadOnly(e,w)&&!Onn(e,s)&&!h.some((Ue)=>rye(Ue,Te)))return{behavior:"allow",updatedInput:e,decisionReason:{type:"other",reason:r0e}};
```
289 对应（z289.txt 第 189 行，逐字）：
```
if(!(Lce(n)&&YYt(e.command))&&li.isReadOnly(e)&&!m4t(e,s)&&!h.some((Ae)=>gue(Ae,Ee)))return{behavior:"allow",updatedInput:e,decisionReason:{type:"other",reason:HMe}};
```
新增 `xe=s!==void 0&&uVe(s)`：解析结果带未引号 glob（非 `[[`、首命令不在 Tnn）时，禁止 read-only 自动 allow，命令落入完整规则评估，未命中规则则以 `bashMissKind:"no-rule-match"` ask。`isReadOnly` 签名同时从 `(e)` 变为 `(e,w)`（复用已解析结果）。`wnn`(290 @213186245)/`YYt`(289 @209995033) 为「存在 Read deny 规则 && 命令经 xargs 指向读命令」门，本体仅改名差异，但 290 版内部改用 `Az(e,n)`（带 declarationPrefix 的新解析包装器，见 #5）。

**(f) 门控开关。** 290 @213206061：
```
tgr="tengu_binary_lollipop";function oye(){return T(tgr,!0)}
```
默认开（`!0`）。

**(g) 路径层（deny 规则实际执行处）289→290 无语义变化。** 完整 diff 了以下函数对：`M4`(@209973747 区段)→`R5`(@213164772 区段)、per-argv 提取器 `M4o`(@209955079)/`P4o`(@209954094)→`Bpr`(@213146104)/`Dpr`(@213145119)、deny 搜索 checker `j4o`(@209965018)/`H4o`(@209964680)→`Kpr`(@213156043)/`qpr`(@213155705)、per-command 校验器 `B4o`(@209959189)→`zpr`(@213150214)、option 值切分 `D1t`(@205110450)→`A2t`(@207636225)、路径提取表 `vb={…}`(@209945460)→`_8={…}`(@213136485)（124 行结构化 diff 仅 2 处改名）。全部为纯 minified 改名。**结论：#6 的修复不在路径层，而在 (d)(e) 的自动批准短路——289 中 glob 只读命令被 auto-allow，deny 规则/目录外读封锁根本没有机会执行；290 阻断 auto-allow 后它们才生效。**

### OCC 现状

- 只读判定入口：`src/tools/BashTool/readOnlyValidation.ts:1681` `isCommandReadOnly`，在 regex/flag-parse 两条通道之前先跑 `containsUnquotedExpansion`（:1603–1672，调用于 :1709）：任何未引号 `*?[ ]` 或 `$name` → 直接非只读。比官方更严——官方允许 Tnn 简单命令带 glob 自动放行（`ls *.txt` allow），OCC 一律 ask。
- 命令替换独立 ask 门：`src/tools/BashTool/bashSecurity.ts:16–45` `COMMAND_SUBSTITUTION_PATTERNS`（含 `\$\(`/`\$\{`/反引号/zsh `=cmd`、`~[`、glob qualifier 等），:861 `validateDangerousPatterns` 命中即 ask；`$` 后跟 `(` 虽不被 `containsUnquotedExpansion` 的变量正则捕获（readOnlyValidation.ts:1652–1657 注释已说明由该层兜底），`$(` 本身必被此门拦下 → `rg $(echo '*.c')` 在 OCC 恒 ask。
- 顺序保证：`src/tools/BashTool/bashPermissions.ts:1984`（`checkBashRedirectAndPatternSafety`）先于 :2045（`BashTool.isReadOnly(input)` 自动放行）执行。
- per-argv `argvUnquotedGlob`/`hasUnquotedGlob` 字段：**不存在**。`src/utils/bash/ast.ts:3048–3054` 与 :3580–3582 有显式注释承认此缺口（v288 #72 遗留 STAGED：官方 awk/find 前缀规则块 gate 在 `r.hasUnquotedGlob` 上，OCC SimpleCommand 无该字段）。
- `src/tools/BashTool/pathValidation.ts:738` 注释确认 dormant AST 路径按官方「argvUnquotedGlob 缺失时的 fallback」语义对齐。

### 判定：#1 = NO-OP（安全面）；#6 = NO-OP（安全面）

官方 290 修复的用户可见结果 = 「带未引号通配符的只读命令（rg/git grep/option value 含 glob）从自动批准变为 ask/deny 评估」。OCC 现有更严格的文本级门已产生同一结果（且覆盖更宽：连 Tnn 简单命令也 ask），不存在官方所修的 auto-approve 漏洞；#6 所指的 deny 规则/目录外读封锁在 OCC 中不会被只读自动批准短路（因为 glob 命令根本进不了自动批准），且官方 2.1.271 fix B（glob 参数补入读路径校验，`pC`/`q4o`/`fe=[...U,...H]`）OCC 已字节级移植：`pathValidation.ts:745` `globCharIndex`、:754 `collectUnextractedGlobArgs`、:782–785 read 增广、:829–866 对每个路径跑 `validatePath`（deny 规则→deny，目录外→ask）。

**备注分歧（非本条目修复范围，登记备查）：**
1. OCC 缺官方 Tnn 例外 → `ls *.txt`、`cat *` 官方 allow、OCC ask（OCC 更严，UX 分歧）。若未来对齐 Tnn 例外，必须先补齐 per-argv `argvUnquotedGlob`（即 kAn 语义），否则会把官方已修的漏洞引进来。
2. `hasUnquotedGlob` 字段缺失仍是 v288 #72 的 STAGED 项（awk/find 前缀规则首分支 gate），与本次 #1/#6 判定无关但同属一个 plumbing。

---

## #2 zsh 与 bash 读法不同的变量名 → 现在 ask

### 官方机制（字节证据）

289 的 ERROR 升级条件只有「ERROR 节点 && 文本以 `${` 开头」（`$e(e)`）。290 在 parser 的 bash/zsh differential 家族（`kind:"too-complex",differential:!0`）中新增两个判定，290 @206280358 区段（逐字）：

```
function Be(e){if(e.type==="ERROR"&&(e.text.startsWith("${")||We(e.text)))return!0;for(let t of e.children)if(t&&Be(t))return!0;return!1}
function Ue(e){let t=e.children;for(let r=0;r<t.length;r++){let s=t[r];if(!s)continue;if(s.type==="simple_expansion"&&s.children.some((o)=>o?.type==="special_variable_name"&&o.text==="#")){let o="";for(let l=r+1;l<t.length;l++){let a=t[l]?.text??"";if(o+=a,!/^[\w-￿]*$/.test(a))break}let n=/^[\w-￿]*(?=\[|:[a-zA-Z&])/.exec(o);if(n&&/[-￿]/.test(n[0]))return!0}if(Ue(s))return!0}return!1}
function We(e){return/^\$[#^=~+]*[\w-￿]+$/.test(e)&&/[-￿]/.test(e)}
```

- `We`：整 token 形如 `$` + 零或多个 `#^=~+`（zsh 扩展 flag 字符：`$=var` 分词、`$~var` glob、`$^var` rc-expand、`$+var` 存在性测试）+ 名字，且**必须含非 ASCII 字符**（`[-￿]`）。正则中的 `[#^=~+]` 字符类为 290 新增（@100798919/@206280358 两处，289 无）。
- `Ue`：`$#` + 名字 + 紧跟 `[` 或 `:字母/&`（zsh 下标/修饰符语法），名字含非 ASCII。
- 原 289 判定 `$e` 被替换为 `(Be(t)||Ue(t))`：命中即 ERROR → too-complex → ask。非 ASCII 是关键：bash 变量名只允许 ASCII，`$=vær` 这类 token 在 bash 下是惰性字面量、在 zsh 下会展开——静态分析无法两全，官方选择 ask。
- 同区段可见该家族的既有成员（289 已有）：comment glued to paren、case pattern group comment 等，均带 `differential:!0`。

### OCC 现状

- zsh 守卫只存在于三处：
  1. `src/utils/bash/ast.ts:531–546` `ZSH_TILDE_BRACKET_RE`（`~[`）与 `ZSH_EQUALS_EXPANSION_RE`（词首 `=cmd`），:669–678 拒绝；
  2. `src/utils/bash/ast.ts:1474–1489`：`[[ ]]` 操作数内 zsh `$name[expr]`/`$name:mod` 递归求值 → too-complex（2.1.221 移植）；
  3. `src/utils/bash/ast.ts:1537`：`[[ ]]` regex/extglob pattern 文本中的 `/\$[({[\w#?!*@$'"+~^=-]/` 扫描（2.1.221/223 移植）。
- **裸参数位置无等价守卫**：`walkArgument` 的 `word` 分支（ast.ts:2082–2109）只做 brace-expansion 拒绝与反斜杠 unescape，`$=vær`、`$~vær`、`$^vær`、`$+vær`、`$#vær[x]` 类 token 以字面 argv 放行；`containsUnquotedExpansion` 的 `$` 检查（readOnlyValidation.ts:1652–1657）只认 `/[A-Za-z_@*#?!$0-9-]/` 后继字符，`=`/`~`/`^`/`+` 不在集合内 → `cat $=vær` 可被判为只读自动放行。
- OCC 确实可能运行在 zsh 下：`src/utils/shell/bashProvider.ts:53`（`shellPath.includes('zsh')` 分支）、:31–45（注释明确 zsh EXTENDED_GLOB / command_not_found_handler 差异）。zsh 执行时 `$=vær` 会做词分裂 → 额外参数走私，与官方修复前的漏洞同型。
- grep 证据：`grep -rn '\$[#^=~+]\|u0080\|non-ASCII' src/utils/bash/ast.ts src/tools/BashTool/bashSecurity.ts src/tools/BashTool/readOnlyValidation.ts` 无命中（仅注释中提及 `$#` 特殊变量）。

### 判定：STAGED

### 移植方案

目标：`src/utils/bash/ast.ts`。

1. 在顶层 differential 守卫区（`ZSH_TILDE_BRACKET_RE`/`ZSH_EQUALS_EXPANSION_RE` 旁，:531–546）新增两个官方等价判定：
   - `zshDifferentialVarTokenRe = /^\$[#^=~+]*[\w-￿]+$/` + 非 ASCII 复验（对应 `We`）；
   - `$#` + 名字 + `(?=\[|:[a-zA-Z&])` + 名字含非 ASCII（对应 `Ue`）。
2. 挂接点（对齐官方语义「解析期 ERROR 升级」）：
   - `walkArgument` 的 `word` 分支（:2082）：word 文本命中 → `{kind:'too-complex', reason: <官方 differential 风格文案>, nodeType:'word'}`；
   - 保守起见同时覆盖 `concatenation` 的子 word（官方 `Be` 是递归子树扫描，`Ue` 也是全树递归）。
3. reason 文案：官方 ERROR 升级复用通用 too-complex 出口，无独立用户文案；OCC 按既有 differential 家族风格给 `zsh reads $=<name> differently from bash (word splitting/expansion flags) — can't be checked before it runs` 类描述（OCC-specific 措辞，官方无对应字符串可逐字移植——`Be`/`Ue` 只产出 ERROR 节点，走通用出口）。
4. 非 ASCII 限定必须保留：纯 ASCII `$=var` 官方不升级（`We` 要求非 ASCII），不要加严，否则会发明比官方更多的 ask。

### 测试计划（e2e，真实 REPL）

前置：zsh 可用环境下 `SHELL=/bin/zsh`；对照组 bash。

| 用例 | 期望（官方 290/291 语义） |
|---|---|
| `cat $=vær`（zsh 会话，`vær` 已定义为 `x /etc/passwd`） | ask（too-complex） |
| `cat $~vær` / `cat $^vær` / `cat $+vær` | ask |
| `cat $#vær[1]` / `cat $#vær:h` | ask |
| `cat $=var`（纯 ASCII） | 不因此升级（维持既有判定路径；官方不 ask） |
| `cat "$=vær"`（引号内） | word 解析为 string，不命中裸 token 升级（官方 `We` 匹配整 token `^\$…$`） |
| `VAR=x; cat $VAR` | 回归：仍按既有 varScope 解析，不受影响 |
| `[[ $=vær == x ]]` | 回归：既有 :1537 守卫仍生效 |

单测：`src/utils/bash/__tests__/` 新增 `zshDifferentialVar290.test.ts`，AAA 结构，覆盖上表 token 形态 + 非 ASCII 边界（`` 起、组合字符）。

---

## #3 更多 `ps` 形式要求审批

### 官方机制（字节证据）

289 @209985176（逐字节选）：
```
,ps:{safeFlags:{"-e":"none","-A":"none","-a":"none","-d":"none","-N":"none","--deselect":"none","-f":"none","-F":"none","-l":"none","-j":"none","-y":"none","-w":"none","-ww":"none","--width":"number","-c":"none","-H":"none","--forest":"none","--headers":"none","--no-headers":"none","-n":"string","--sort":"string","-L":"none","-T":"none","-m":"none","-C":"string","-G":"string","-g":"string","-p":"string","--pid":"string","-q":"string","--quick-pid":"string","-s":"string","--sid":"string","-t":"string","--tty":"string","-U":"string","-u":"string","--user":"string","--help":"none","--info":"none","-V":"none","--version":"none"},additionalCommandIsDangerousCallback:(e,n)=>n.some((r)=>!r.startsWith("-")&&/^[a-zA-Z]*e[a-zA-Z]*$/.test(r))}
```

290 @213176201（safeFlags 逐字相同，两处变化）：
```
,ps:{respectsDoubleDash:!1,safeFlags:{…同上…},additionalCommandIsDangerousCallback:(e,n)=>{let r=n.some((S)=>!Cze(S)&&/[eE]/.test(S)),s=n.some((S)=>/^-[a-zA-Z]*e/.test(S)),g=n.every((S)=>S==="--forest"||/^-[AacdeFfjlwHLTm]+$/.test(S)),h=n.flatMap((S)=>S==="--forest"?[S]:S.match(/[HLTm]/g)??[]);return r||s&&!(g&&h.length<=1)}}
```
配套新 helper，290 @206581431：
```
function Cze(e){return e.startsWith("-")&&e.length>1&&rf.test(e)}   // rf=/^-[a-zA-Z0-9_-]/
```
语义分解（`e`=命令名, `n`=argv 其余部分）：
- `r`：任何**非合法 flag 形态**的 token（`Cze` 为假：不以 `-` 开头，或 `-` 后无字符/字符不在 `[a-zA-Z0-9_-]`）只要含 `e`/`E` → 危险（289 只看「纯字母且含 e」的裸 token，`/^[a-zA-Z]*e[a-zA-Z]*$/`，放过 `foo1e`、`-Xe` 之类）；
- `s`：存在 `-[字母]*e` 形态 flag（如 `-e`、`-fe`）；
- `g`：所有 token 都是 `--forest` 或 `-[AacdeFfjlwHLTm]+` 白名单短 flag 组合；
- `h`：收集 `--forest` 与 token 中的 `H/L/T/m` 字符；
- 结果：`r || (s && !(g && h.length<=1))` —— 含 e 的 flag 只有在「全部 token 落在安全字母集合且 forest/线程类 flag 至多一个」时才放行；其余一律危险 → ask。
- 新增 `respectsDoubleDash:!1`：`ps -- xxx` 不再被当作选项终止符（ps 不尊重 `--`，后面的 token 仍按 ps 自己的语义解析），堵 `ps -- -e …` 类走私。

### OCC 现状

- `src/tools/BashTool/readOnlyValidation.ts:363–434`：`ps` CommandConfig 为 **289 旧形态**——无 `respectsDoubleDash:false`；:428 回调逐字为 `a => !a.startsWith('-') && /^[a-zA-Z]*e[a-zA-Z]*$/.test(a)`（旧正则）。
- OCC 的 `CommandConfig` 类型已支持 `respectsDoubleDash`（同文件类型定义；pyright 条目已在用），无需扩类型。

### 判定：STAGED

### 移植方案

`src/tools/BashTool/readOnlyValidation.ts` 的 `ps` 条目（:363–434）：
1. 加 `respectsDoubleDash: false`；
2. safeFlags 不动（两版逐字一致）；
3. 回调替换为官方 290 四条件实现，`Cze` 以模块内小 helper 落地（如 `isWellFormedFlagToken(a){return a.startsWith('-')&&a.length>1&&/^-[a-zA-Z0-9_-]/.test(a)}`），保持不可变、无副作用；命名遵循 OCC 风格，逻辑与官方布尔式一一对应：`r || (s && !(g && h.length <= 1))`。

### 测试计划

单测（`readOnlyValidation` 既有测试文件内追加或新建 `psFlags290.test.ts`）：

| 命令 | 289/OCC 现状 | 290 期望 |
|---|---|---|
| `ps -e` | 危险(ask) | ask（s 真，g 真但 h=0≤1 → 放行？注意：`-e` 含 e，`g` 检查 `-e`∈`-[AacdeFfjlwHLTm]+` 为真，h=[]→ `s&&!(g&&true)`=false → **allow**）——以官方布尔式为准逐例断言 |
| `ps -ef` | ask（`-ef` 非裸 token，289 回调只看非 `-` 开头 token → 实际 allow！） | `-ef`：s 真（`-[a-zA-Z]*e`），g：`f,e`∈白名单 → 真，h=[] → allow |
| `ps -eH` | allow | s 真，g 真（H 在白名单），h=[H] → h.length≤1 → allow |
| `ps -eHL` | allow | h=[H,L] → 2 > 1 → **ask**（新收紧点） |
| `ps -e --forest` | allow | h=[H?无] → `--forest` 计 1 → allow |
| `ps -eT --forest` | allow | h=[T,--forest]=2 → ask |
| `ps foo1e` | allow（`foo1e` 不匹配纯字母正则） | `Cze("foo1e")`=false 且含 e → r 真 → **ask**（新收紧点） |
| `ps -- -e` | `--` 终止选项解析 | `respectsDoubleDash:false` → `--` 后仍按 ps 语义 → ask |
| `ps -ax` | allow | s 假（无 e）→ r 假 → allow（回归） |

（表中 289 列按旧回调语义推演，写测试时以真实旧实现跑一遍作 RED 基线；290 列全部按官方布尔式手工求值，GREEN 断言。）
e2e：REPL 中 `ps -eHL` 触发权限提示、`ps -ax` 静默执行。

---

## #4 `pyright` 不再视为只读

### 官方机制（字节证据）

289 把 pyright 放在独立对象 `AVo` 并 spread 进只读表：
- 289 @204054686（逐字）：
```
AVo={pyright:{respectsDoubleDash:!1,safeFlags:{"--outputjson":"none","--pythonversion":"string","--pythonplatform":"string","--level":"string","--stats":"none","--verbose":"none","--version":"none","--dependencies":"none","--warnings":"none"},additionalCommandIsDangerousCallback:(e,n)=>n.some((r)=>r==="--watch"||r==="-w")}}
```
- 289 表组装处 @209993069 上下文含 `...AVo,...gbn`（`gbn=["docker ps","docker images"]` 等）。
- 290 表组装处 @213184281 上下文只剩 `...CTn`（`CTn={"docker logs":{...},"docker inspect":{...}}` @206578819），**`AVo`/pyright 条目整体消失**。
- 命中计数交叉验证：`pyright:{` 在 289 出现 2 次（只读表 + Fig 补全 spec），290/291 各 1 次（仅 Fig spec，@221670108/@221623198）——官方保留了 shell 补全 spec，只删了只读表条目。

删除后 `pyright …` 不再匹配只读表 → 走到 `no-rule-match` ask。动机与 289 时代 pyright 注释一致：`pyright --createstub`/`--watch` 类能力使其不适合作只读命令（290 直接整体除名而非继续打补丁）。

### OCC 现状

- `src/utils/shell/readOnlyCommandValidation.ts:1501–1537`：`PYRIGHT_READ_ONLY_COMMANDS`（:1504）含 `pyright` 完整 spec（:1506–1523，`respectsDoubleDash:false` + safeFlags + watch 回调），:1721–1723 还留有「`pyright -- --createstub os` 走私」的防御注释；:1539 `EXTERNAL_READONLY_COMMANDS` 聚合。
- `src/tools/BashTool/readOnlyValidation.ts:20` import `PYRIGHT_READ_ONLY_COMMANDS`，:1136 `...PYRIGHT_READ_ONLY_COMMANDS` spread 进 CommandConfig 表——即 OCC 现状 = 官方 289 行为（`pyright --outputjson` 等自动放行）。
- `src/utils/bash/specs/pyright.ts`：Fig 补全 spec——官方 290 保留，OCC 保留，不动。

### 判定：STAGED

### 移植方案

1. `src/utils/shell/readOnlyCommandValidation.ts`：删除 `PYRIGHT_READ_ONLY_COMMANDS`（:1501–1537 区域）并从 `EXTERNAL_READONLY_COMMANDS`（:1539）聚合中移除；若该常量被其他模块引用则一并清理（grep 确认仅 readOnlyValidation.ts:20/:1136 两处）。
2. `src/tools/BashTool/readOnlyValidation.ts`：删除 :20 import 与 :1136 spread。
3. `src/utils/bash/specs/pyright.ts` 保留（对齐官方）。
4. 顺手核对 `READONLY_COMMAND_REGEXES`/`COMMAND_ALLOWLIST` 是否另有 pyright 条目（grep `pyright` 全 src，测试文件除外）。

### 测试计划

单测：
- `pyright --outputjson`：isReadOnly → false（RED：当前 true）；
- `pyright --version`：false（官方连 --version 也不再自动放行——整条命令除名）；
- `pyright --watch` / `pyright -- --createstub os`：false（回归，原本靠回调拦，现在靠除名拦）；
- `docker logs x` / `docker inspect x`：不受影响（CTn 等价物仍放行，若 OCC 已移植）。
e2e（REPL）：`pyright --outputjson` 弹出权限 ask；allow 规则 `Bash(pyright:*)` 可显式放行（规则通道不受除名影响）。

---

## #5 declare/typeset/export/readonly 前缀赋值的变量名逃过 deny/ask 规则

### 官方机制（字节证据）

**(a) 解析器包装器 `Az` 新增 `declarationPrefix` 模式。** 290 @206276467 区段（逐字节选）：
```
function Ior(e,t){let r=(o)=>Array.from({length:e},(n,l)=>o(l));if(e<=3)return{readings:Array.from({length:2**e},(o,n)=>r((l)=>Math.floor(n/2**l)%2===1)),exhaustive:!0};let s=[r(()=>!1),r(()=>!0)];for(let o=0;e<=8&&o<e;o++)s.push(r((n)=>n===o));if(t?.length===e&&!s.some((o)=>o.every((n,l)=>n===t[l])))s.push([...t]);return{readings:s,exhaustive:!1}}
function Az(e,t,{plainUnquotedHeredocs:r=!1,declarationPrefix:s}={}){…
```
`Ior(names,operands)` 枚举「哪些前缀赋值名字实际持久化」的 readings：名字数 ≤3 → 2^n 全枚举（`exhaustive:!0`）；>3 → 启发式集合（全假、全真、单名字 ≤8 个、operands 提示的读法），`exhaustive:!1`。289 的解析入口（@203775174）无 `declarationPrefix` 参数——`declarationPrefix` 一词在 289 全二进制 0 命中。

**(b) `Az` 内部新状态与 too-complex 出口**（az289/az290 diff）：290 新增 reading 状态 `P=s`；分支/循环内声明前缀赋值 → too-complex，官方文案（逐字）：
```
A variable set in front of a declaration inside a branch or loop can't be checked before it runs
```
reading 数与实际声明前缀数失配 → too-complex：
```
The variables set in front of declarations in this command can't be checked before it runs
```
解析结果在 `s===void 0` 时携带 `declarationPrefixes` / `declarationPrefixBashKeeps`（模块态 `Zt()`→bashKeeps 数组、`Gt()`→前缀计数）。

**(c) 规则匹配器按 reading 重判。** 290 `wVe`（bash 规则匹配，@213265034）新增参数 h（当前 reading）与 S（回调）→ `S(no.declarationPrefixes,no.declarationPrefixBashKeeps)`。inline-script 决策循环（@213255257，nm290.txt）逐字要点：
```
zt=await wVe(…,hn)   // 每个 reading 重跑规则匹配
```
deny 命中即胜；`ot||=!Dn`（reading 非穷举 → 强制 ask）；`ot||=Vgr(En)!==void 0||…Az(Nt,wn,{declarationPrefix:hn}).kind==="too-complex"`（任一 reading 下重解析 too-complex → ask）。289 的同位置（nm289.txt）只跑一次、无 readings 循环。

语义：bash 中 `X=v declare -x X`（及 typeset/export/readonly）的前缀赋值**持久化**（declare 是特殊内建），但静态无法确定持久化范围/值，289 干脆没把这些名字纳入规则匹配 → `Bash(evil:*)` deny 规则匹配不到 `$X` 解析出的命令名 → 漏判。290 对每种可能的持久化 reading 重跑 deny/ask 匹配：任一 reading deny → deny；readings 非穷举 → ask。

（旁证排除：289 `U3n`@208316502 / 290 `rSr`@213435187 的 git-worktree-guard declaration_command 分支 diff 为纯改名，与本条无关。）

### OCC 现状

- `src/utils/bash/ast.ts:1924–1943`（walkCommand 的 `variable_assignment` 分支）：前缀赋值一律推入 `envVars`（瞬时），注释明确「Do NOT add to global varScope」。**没有** declare/export/readonly/typeset 特殊内建的持久化例外——`X=evil declare -x X` 之后 `$X` 在 OCC 中是未跟踪变量。
- 未跟踪 `$X`（裸参数）→ `resolveSimpleExpansion`（ast.ts:2619–2690）→ `tooComplex` → ask。即 OCC **fail-safe**：不会自动批准 `$X` 命令，但也永远给不出 deny——`Bash(evil:*)` deny 规则匹配不到 too-complex 命令的解析名。
- declaration_command 本体（`export FOO=bar` 无命令前缀形式）由 ast.ts:829–935 处理（argv[0]=内建名，值经 walkVariableAssignment 校验，2.1.271 fix C flag-charset 已移植），与本条的前缀形式是两条路径。
- grep 证据：`declarationPrefix`/readings 枚举在 OCC src 无命中；`src/tools/BashTool/__tests__/declarationFlagCharset271.test.ts` 只覆盖 271 fix C。

### 判定：STAGED

安全面说明：OCC 无 auto-approve 漏洞（too-complex → ask 兜底），缺口是**规则精度**——官方 290 中 deny 规则可命中的命令，OCC 只会 ask；ask 规则场景两者等价。属对齐性 STAGED，非 P0 安全洞。

### 移植方案

1. `src/utils/bash/ast.ts` walkCommand 前缀赋值分支（:1924）：识别「前缀赋值 + 命令名为 `declare`/`typeset`/`export`/`readonly`/`local`」的组合（bash 特殊内建持久化语义），把涉及的变量名收集为 `declarationPrefixes`（对齐官方 parse-result 字段），不再简单丢弃；分支/循环体内的该形态按官方文案直接 too-complex（`A variable set in front of a declaration inside a branch or loop can't be checked before it runs`——逐字）。
2. 实现 `Ior` 等价 readings 枚举（≤3 名字全枚举 exhaustive；>3 启发式：全假/全真/单名字≤8/operands 读法，非穷举）。
3. `src/tools/BashTool/bashPermissions.ts` 规则匹配入口：对含 declarationPrefixes 的命令逐 reading 重跑 deny/ask 匹配（reading = 该组名字是否视为持久化，持久化时以赋值字面量入 varScope 重解析 argv），deny 优先；非穷举 readings → 强制 ask；任一 reading 重解析 too-complex → ask（官方 `ot||=` 三条件逐一对应）。
4. too-complex 文案第二条逐字：`The variables set in front of declarations in this command can't be checked before it runs`。

### 测试计划

单测（新建 `declarationPrefix290.test.ts`）：
- `X=evil declare -x X && $X --run` + deny 规则 `Bash(evil:*)` → **deny**（RED：现状 ask）；
- 同命令无规则 → ask；
- `A=1 B=2 C=3 D=4 export A B C D && $A`（4 名字 >3 → 非穷举）→ ask；
- `if true; then X=evil declare -x X; fi && $X` → too-complex，reason 逐字；
- `X=/etc/passwd export X && cat $X` + Read deny `/etc/passwd` → deny（reading 解析后路径校验命中）；
- 回归：普通 `X=evil cmd`（非声明内建）仍瞬时、不入 scope（ast.ts:1938 注释语义不变）；`export FOO=bar`（无前缀）路径不受影响。
e2e（REPL + settings deny 规则）：`X=evil declare -x X; $X` 被 deny 规则拦截并显示规则来源。

---

## #6 Read deny 规则 / 目录外读封锁对只读命令 option value 通配符生效

### 官方机制（字节证据）

与 #1 完全同源（见「共享机制」(a)–(g)）。要点重申：
- 路径执行层（`R5`/`Bpr`/`Dpr`/`Kpr`/`qpr`/`zpr`/`A2t`/提取表 `_8`）289→290 **零语义变化**（全部函数对 diff 完毕，纯改名）；
- 289 的漏洞在决策函数（z289.txt:189）：`li.isReadOnly(e)` 为真即 `{behavior:"allow"}`，`R5` 的 deny/ask 结果（第 176 行先行计算）对非路径受限命令（rg 不在 `Oce`/`qhe` 集合）本来就是 passthrough，只读自动批准又短路一切 → Read deny 规则与 `blockReadsOutsideWorkingDirectories` 对「option value 带通配符的只读命令」双双失效；
- 290 在 allow 函数（`if(uVe(_e))return!1;` @213200597）与决策函数（`xe=s!==void 0&&uVe(s)` @213224189 区段）双层阻断，命令落入完整评估；`kAn` 的 per-token 判定天然覆盖 option value 形态 token（`--glob=*.txt` 整体是一个 argv token，`V` 直接命中），`t.length!==e.argv.length` / `carveOutMayDesyncQuoteScan` fallback 兜住解析降级场景；
- 重定向目标同样纳入：`kAn` 检查 `e.redirects.some((s)=>s.op!=="<<"&&s.op!=="<<<"&&V(s.target))`。

### OCC 现状

- 只读自动批准对任何未引号 glob 关闭：`readOnlyValidation.ts:1709`（`containsUnquotedExpansion` → 非只读），option value 形态 `--glob=*.txt` 中的 `*` 未引号即命中（:1664–1668 对全文逐字符扫描，不区分位置）；引号形态 `--glob='*.txt'` 两版官方与 OCC 都放行（shell 不扩展，语义一致）。
- deny 规则对 glob 参数的应用（官方 2.1.271 fix B）已移植：`pathValidation.ts:720–785`（`globCharIndex`/`collectUnextractedGlobArgs`/read 增广）＋ :829–866 `validatePath`（rule → deny；目录外 → ask，含 `blockedPath` 与 addDirectories 建议）。
- 命令替换形态由 `bashSecurity.ts:861` ask 门兜底（同 #1）。

### 判定：NO-OP（安全面）

官方 290 修复的两个失效面（auto-allow 短路、option value 漏检）在 OCC 分别被更严的 `containsUnquotedExpansion` 与已移植的 271 fix B 覆盖；不存在需要移植的缺口。备注分歧同 #1（Tnn 例外缺失、`hasUnquotedGlob` plumbing 为 v288 #72 遗留 STAGED）。

---

## 附：本 cluster 使用的全部字节偏移索引

| 证据 | 289 偏移 | 290 偏移 |
|---|---|---|
| 文本 glob 扫描器 `WBe`/`dVe` | 210000018 | 213191229 |
| 简单命令集 `x6o`/`Tnn` + `xmr`/`uVe`（290 新增） | 210000018 区段尾 | 213191229 区段尾 |
| `kAn` + `St` 正则（290 新增） | — | 206274889 |
| AST word walker `Xt="*?["`（290） | — | 206327026 |
| argv 归一化 `n4t`/`fVe` | 210005575 | 213196959 |
| allow 函数（uVe 插入点） | 210009442 | 213200597 |
| 决策函数 auto-allow 行 | 210032256 区段（z289.txt:189） | 213224189 区段（z290.txt:188–189） |
| 门控 `oye`/`tengu_binary_lollipop` | — | 213206061 |
| `ps` spec | 209985176 | 213176201 |
| `Cze`/`rf`（290 新增） | — | 206581431 |
| pyright `AVo` 对象 | 204054686 | —（已删除） |
| 只读表组装 spread | 209993069（`...AVo,...gbn`） | 213184281（仅 `...CTn`） |
| Fig pyright spec（两版保留） | 2 处命中 | 290:221670108 / 291:221623198 |
| `Ior` readings 枚举（290 新增） | — | 206276467 |
| `Az` 解析包装器（290 加 declarationPrefix） | 203775174 | 206276467 区段 |
| `Be`/`Ue`/`We` zsh 升级（290 新增） | —（289 为 `$e`） | 206280358（正则另见 100798919） |
| `wVe` 规则匹配（290 加 reading 参数） | — | 213265034 |
| inline-script readings 循环 | nm289.txt | 213255257（nm290.txt） |
| 路径层 `M4`/`R5` | 209973747 区段 | 213164772 区段 |
| 提取器 `M4o`/`P4o` → `Bpr`/`Dpr` | 209955079 / 209954094 | 213146104 / 213145119 |
| checker `j4o`/`H4o` → `Kpr`/`qpr` | 209965018 / 209964680 | 213156043 / 213155705 |
| per-command `B4o` → `zpr` | 209959189 | 213150214 |
| 调度 `FYt` → `cnn` | 209964070 | 213155095 |
| 切分 `D1t` → `A2t` | 205110450 | 207636225 |
| 提取表 `vb={` → `_8={` | 209945460 | 213136485 |
| `YYt` → `wnn`（xargs 读命令门） | 209995033 | 213186245 |
| worktree chunk 传递 argvUnquotedGlob | —（0 命中） | 213467661 / 213468918 |

diff 工作文件（scratchpad `forensic/`）：reg/dec/z/dcl/nm/az 系列、m4_289.txt、r5_290.txt、m4o289/bpr290、p4o289/dpr290、j4o289/kpr290、h4o289/qpr290、b4o289/zpr290、fyt289/cnn290、d1t289/a2t290、vb289/u8_290、yyt289/wnn290、wbe289scanner/wbe290scanner。
