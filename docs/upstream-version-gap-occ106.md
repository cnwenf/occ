# OCC-106 — 2026-08-27 版本追齐(官方 2.1.246;落地悬空 &&/|| 活路径补偿守卫 + allow 规则子命令前通配符启动警告;hook `if` 遗留项裁决归档;发布 2.1.313)

## 1. 版本状态(三方核实)

| 来源 | 状态 |
|------|------|
| npm `@anthropic-ai/claude-code` | latest = **2.1.246** |
| GitHub releases | **v2.1.246 = Latest**(2026-08-25T22:31:52Z) |
| changelog | 2.1.246 共 **61 条** |
| OCC(追齐状态) | OCC-105 已追齐 2.1.245(发布 2.1.312)→ **本轮 gap = 仅 2.1.246** |

二进制取证(官方平台包 `@anthropic-ai/claude-code-linux-x64@2.1.246`,`npm pack` 原样解包,`strings -n 8` dump):

| 版本 | ELF md5 | 体积 | 版本标记 |
|------|---------|------|----------|
| 2.1.246 | `bf9937903a00a66b3f0db65d48487907` | 247,905,800 bytes | `2.1.246` ×1536,`2.1.247` ×0 |

重复任务护栏:开工前已核实 workspace 内无其他 running/queued 的版本追齐任务;本 issue 即当前唯一追齐轮。

## 2. 逐版本结论

gap 窗口内只有 2.1.246 一个版本。61 条 changelog 全量逐条分诊(§5)。本轮落地 2 个安全项(均可对官方 2.1.246 ELF 逐字节验证);并对 OCC-105 遗留的最高优先项 —— **hook `if` 条件 `$()`/反引号误触发修复** —— 完成逐点取证与实机探针,作出 **staged(维持现状即安全方向)** 裁决(§3-C)。

## 3. 本轮落地项(均逐字节对照官方 2.1.246 ELF 取证)

### Gap-106a — 悬空 `&&`/`||` 畸形命令必须审批(安全;changelog:“Fixed Bash permission checks to always require approval for malformed commands with a dangling `&&` or `||` operator”)

**官方机制**:修复走 tree-sitter AST 路径 —— 尾部悬空布尔操作符是解析错误 → 一律 ask。

**OCC 现状取证**:`TREE_SITTER_BASH` / `TREE_SITTER_BASH_SHADOW` 不在 `featureFlags.ts` 的 8 项 allowlist → `parseCommandRaw` 恒返回 null → AST 路径休眠,活路径是 legacy 分词器;而活路径会**静默丢弃尾部操作符**(`splitCommand('ls &&')` → `['ls']`)。后果:在 `Bash(ls:*)` / `Bash(ls *)` / 甚至精确 `Bash(ls)` 规则下,`ls &&` 被自动放行 —— 与官方修复前同类绕过。

**落地**(沿用 M3/M4/M5 与 2.1.223 引号-`]]` 的“活路径补偿守卫”先例):
- 新检测器 `hasDanglingBooleanOperator`(`src/tools/BashTool/bashPermissions.ts`):引号/转义感知的前向扫描,仅当**最后一个未引用/未转义的 `&&`/`||` 之后只剩空白**时为 true(`echo "a &&"`、`ls \&\&` 不误报)。
- 闸门接入 `bashToolHasPermission`:位于 2.1.223 引号-`]]` 守卫之后、"0. AST-based security parse" 之前;`mode !== 'bypassPermissions'` 时命中返回 `{behavior:'ask'}`。守卫次序核实:灾难性替换 deny → G3 破坏性 deny → M3 长度 ask → M4/M5 ask → 引号-`]]` ask → **悬空操作符 ask** → AST parse → 规则匹配(所有 deny 块都在 ask 守卫之前,不会把本该 deny 的命令降级为 ask)。
- 18 个钉死测试(`danglingBooleanOperatorLivePath246.test.ts`):13 种悬空形态(含 `ls&&`、`ls &&\n`、`ls && &&`、精确规则 `Bash(ls)` 下的 `ls &&`)在宽松 allow 规则下必须 ask/deny、绝不 allow;良性对照(`ls`、`git status` 等)照常 allow;引号内 `&&` 不误报;良构复合命令 `ls && id` 不受影响。

### Gap-106b — Bash allow 规则子命令前通配符启动警告(安全;changelog:“Added a startup warning for Bash allow rules with a wildcard before the subcommand (e.g. `Bash(git * main)`) …”)

**官方机制(2.1.246 ELF 逐字节取证)**:规则校验器链 —— `ns` = `/^(?:[|&;<>]|\d+[<>])/`(操作符/重定向 token),`os` = `ns.test`,`ln` = 含未转义 `*`,`ss` = 子命令前通配符检测器(首 token 非通配、token 数 ≥3、跳过选项、遇操作符终止、`:*` 旧语法豁免),`rs(e, t)` 主校验器仅当 `t === "allow"` 时触发该警告;`mn(e)` zod `superRefine` 工厂仅在 `!valid` 时 addIssue —— **警告永不升级为 schema 错误**。警告文案逐字节匹配,含 git 专属补充(`-c`/`--exec-path` 可执行任意命令 + `Bash(git status *)` 示例)。另见 `dn`(allow 中通配工具名)检测,其二进制的来源版本不明 → **不移植**(never invent)。

**落地**:
- `src/utils/settings/permissionValidation.ts`:新增 `OPERATOR_TOKEN_RE` / `isOperatorToken` / `hasUnescapedStar` / `wildcardBeforeSubcommand`(与二进制 `ns`/`os`/`ln`/`ss` 逐字节对应);`validatePermissionRule` 增加可选 `behavior?: PermissionBehavior` 参数,`behavior === 'allow'` 时触发警告(文案逐字节,含 git 补充)。
- `src/utils/permissions/permissionSetup.ts` 三处启动校验调用点传入 behavior:settings 落盘规则循环传 `rule.ruleBehavior`,`--allowed-tools` 传 `'allow'`,`--disallowed-tools` 传 `'deny'`。
- schema 路径零行为变化:`PermissionRuleSchema.superRefine` 仍只在 `!valid` 时 addIssue,与官方 `mn()` 语义一致。
- 17 个测试(`wildcardBeforeSubcommand246.test.ts`):`Bash(git * main)` / `Bash(npm * install)` 警告文案逐字节断言;deny/ask/不传 behavior 不警告;豁免齐全(尾通配、`:*` 旧语法、2-token、仅选项、通配首 token、转义 `\*`、操作符、fd 重定向);2.1.210 Write 规范名警告不被遮蔽。

### C — OCC-105 遗留项裁决:hook `if` 条件 `$()`/反引号误触发(2.1.243 安全修复)→ **STAGED,维持现状即安全方向**

逐点取证 + 实机探针结论:
1. OCC 的 hook `if: Bash(...)` 匹配走 `prepareIfConditionMatcher`(`src/utils/hooks.ts`)→ 工具名匹配后对规则内容调 patternMatcher;BashTool 侧 `preparePermissionMatcher`(`BashTool.tsx` L607)在 `parseForSecurity` 结果非 `'simple'` 时返回 `() => true`。
2. OCC 的 tree-sitter 路径休眠(§Gap-106a 取证),`parseForSecurity` **恒**返回 `parse-unavailable` → matcher 恒为 `() => true` → 任何 hook `if: Bash(…)` 对**所有** Bash 命令都触发。
3. 实机探针(临时测试,取证后已删):`if: Bash(cat *)` 与 `if: Bash(git push *)` 对不匹配命令同样命中 —— 确认**过度触发(over-fire)**。
4. 方向判定:过度触发意味着 hook **只会多触发、不会漏触发**,安全类 hook(拦截/审计)永不被绕过 —— 这是保守(安全)方向的偏差。官方 2.1.243 精化的是 AST 匹配器,OCC 没有该路径;要移植只能**发明**一个 legacy 匹配器,违反 `aligning-with-official-binary`(never invent)。
5. 裁决:**不移植**,留档为“已取证的有意偏差”;若未来 OCC 激活 AST 路径,届时按官方匹配器逐字节移植。

## 4. 验证(全部实测)

| 项 | 结果 |
|----|------|
| 新增测试 | 18(悬空守卫)+ 17(通配警告)全绿 |
| 全量 src 套件 | **2236 pass / 8 fail / 5181 expect()**(较 OCC-105 基线 2201/8/5096:+35 测试、+85 expect 恰为两文件之和) |
| 8 个失败 | 全部为 OCC-105 前既有:agent-spawn telemetry ×2、interactive permission telemetry ×1、agentHookTrust ×5;与本轮 diff 无任何导入交集(按域核实) |
| e2e | `occ-versioning` + `commands-alignment` 6 pass / 12 expect() |
| 构建 | `bun run build` → `dist/cli.js` **28.93 MB**(30,330,426 bytes) |
| 真模型 `-p` | `echo "say PONG" \| occ -p` → `PONG`,exit 0 |
| tmux REPL | 启动 + `/status` 往返绿 |
| 安全自查 | 两处 diff 均为纯函数 + fail-closed/仅警告;无密钥、无输入执行面;守卫不碰 bypassPermissions 模式 |

## 5. 2.1.246 其余项分诊(本轮未落地,逐项理由)

**无 OCC 对应面(不落地):**

| 项 | 理由 |
|----|------|
| plugin 修复 ×6(cache SHA 重复目录、skill 名 `plugin:` 双前缀、`plugin update` 裸名、UTF-8 BOM、`/reload-plugins` skill 计数、`${CLAUDE_PLUGIN_ROOT}` 展开) | OCC 已裁剪 plugins 面(历轮既定) |
| background sessions / `claude agents` ×5(45s 打开失败、EACCES、respawn 中停止、重复列行、retention sweep 误删自制 worktree) | `BG_SESSIONS` 休眠;OCC 用自研 daemon supervisor |
| cloud / ultrareview / Remote Control ×3 | OCC 无云会话/ultrareview/Remote Control 子系统 |
| telemetry 凭据误发第三方主机、WIF 遥测归因、OpenTelemetry plugin 事件 ×3 | OCC analytics 为 stub;plugins 已裁剪 |
| Windows/macOS headless `~/.claude/sessions` 清理 | 平台专属;非本运行时 |
| `install.sh` Raw mode(Team/Enterprise) | 官方安装脚本,OCC 无 |
| self-hosted runner work-poll 重试 | OCC 无 self-hosted runner 子系统 |
| `claude install/update` managed-settings consent 推迟 | managed-settings 组织子系统(与 OCC-46 staged 同批) |
| VS Code 扩展 plan-mode 恢复(VS Code 侧) | OCC 无 VSCode 扩展(`-p` 侧已单独列于下方 staged) |

**Staged(有 OCC 对应面,需专项逐点反编译/行为核对,留后续轮次):**

| 项 | 备注 |
|----|------|
| **第三方端点流式 `tool_use` 无 `id` 的渲染守卫** | OCC 常态即 `ANTHROPIC_BASE_URL` 网关,**建议下一轮优先** |
| MCP `requiresUserInteraction` 隐藏 “don't ask again” | 选项写入的 allow 规则被工具忽略,误导用户 |
| `--strict-mcp-config` 不再询问永不加载的 `.mcp.json` | 影响后台会话启动等待 |
| sandbox 文件系统配置尊重 `--setting-sources` / sandbox 网络提示期间 `Notification` hook 不触发 | 沙箱专项两项 |
| `/--` 开头 prompt 误判未知斜杠命令 | 输入解析小修复 |
| plan-mode 会话经 `-p --continue/--resume` 恢复后脱离 plan mode | `-p` 恢复路径 |
| Write 覆盖超大文件后 OOM/冻结 | 文件写入路径 |
| `/stats` 活动热图 UTC 东时区偏移一格 | OCC 有 heatmap 面 |
| 子代理 `maxTurns` 截停标记 partial + `SendMessage` 续跑提示 | AgentTool 记账 |
| `/cd` 后项目配置/hooks/.mcp.json/skills/agents 立即生效 | `/cd` 专项 |
| MCP 调用被打断 → 显式 interrupted 错误(而非 “completed with no output”)/ 空 schema `{}` 参数按真实类型发送 | MCP 传输两项 |
| `/goal` 空闲长任务 check-in 上限 3/次 | `/goal` Stop-hook 路径 |
| 命令中途被打断显示 “Ran 1 shell command” 无截断标记 | BashTool 渲染 |
| markdown 渲染 “前 500 字符无 markdown 即整条禁用” 修复 | `Markdown.tsx` 门控,需先核实 OCC 是否同构 |
| `keybindings.json` 未知 action 不再静默失效 + `--debug` 警告 | keybindings 面 |
| `@` 文件 picker 失配后仍停留 / 路径补全含 NUL 字节失败 | 补全专项(面待取证) |
| `/rename` 覆盖主题 `promptBorder` / 自定义主题 diff 色被忽略 | 主题子系统两项 |
| status line 成本/时长归零(切 agents 视图往返) | `StatusLine` 面 |
| fullscreen 三项(改尺寸空白、超长单行 diff 拖慢、乱跳滚动)+ 点击终端鼠标焦点漂移 | OCC 有 fullscreen 面(`isFullscreenEnvEnabled`),滚动/虚拟列表专项 |
| `apiKeyHelper` 短命 JWT 过期预刷新 + 401/403 静默重试 | OCC 有 `apiKeyHelper` 面 |
| 恢复会话历史含非法 tool 块导致每轮 400 | resume + 第三方代理产物清理 |
| `-p`/SDK 中断响应自动续跑 | 非交互传输路径 |
| transcript 视图内存随行数增长(每行保留全量 tool lookup) | 渲染内存专项 |
| Bash snapshot 函数 base64 重放延迟优化 | 性能优化项 |
| auto mode 安全检查期限随 prompt 规模缩放 | OCC auto-mode classifier 为 LIVE 面 |
| 动态工作流 ←/`/background` 误重启已完成子代理 → 先询问 | `WORKFLOW_SCRIPTS` LIVE 面 |
| `/fork` 自 fork/后台会话再 fork 得到空会话 | OCC 有 `/fork`(`src/commands/fork/`) |
| `/code-review` 在 Bedrock/Vertex/Foundry/gateway/关遥测时允许 Claude 自启 | OCC `/code-review` 为独立实现,核对启动门控 |

**已裁决归档:** hook `if` 条件 `$()`/反引号误触发修复(2.1.243,OCC-105 遗留)→ §3-C,过度触发为安全方向,不移植。

## 6. 结论

OCC 追齐至官方 **2.1.246**(= npm latest = GitHub Latest)。本轮发布 **2.1.313**。下一轮优先项:第三方端点 `tool_use` 无 `id` 渲染守卫(OCC 网关常态)+ §5 staged 批量取证。
