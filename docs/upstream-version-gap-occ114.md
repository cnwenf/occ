# OCC-114 — 版本追齐 2.1.258 → 2.1.259（gap 调研 + 对齐）

- 轮次：2026-09-04（autopilot「OCC版本追齐官方Claude Code」）
- 基线：OCC **2.1.320** ↔ 官方 **2.1.258**（OCC-113 落地）
- 官方最新：**2.1.259**（三方核实：npm `latest`/`next`、GitHub release `v2.1.259`、官方二进制下载；changelog 37 条，全文存 `/tmp/cc-diff-114/entries-114.txt`）
- 取证工作区：`/tmp/cc-diff-114/`（v2.1.258 / v2.1.259 官方 linux-x64 ELF + `claude.strings`；`added.txt`/`removed.txt` 为单行巨型 JS blob，只能定点 `grep -aboF` + `dd`）
- 方法：`aligning-with-official-binary` skill —— 官方编译产物是唯一事实来源，全部移植值逐字节核对，不猜
- 轮次纪律（沿自 OCC-113）：落地少数干净、逐字节验证过的 gap（带逐文件表）；其余分级保留并写明理由

## §1 已落地 — Gap-114b：glab MR 识别（entry 003）

> 官方 changelog 003：Added recognition of `glab mr create/merge/close/reopen/note/update` so GitLab merge requests show as `MR !N` in the collapsed tool summary and refresh the footer MR badge.

官方 2.1.259 把 gh PR 追踪族扩展到 glab MR：命令识别（`Aat` 表）、动作解析（`Rat`：gh 优先 + `--auto/--disable-auto/--undo/--ready/--draft` 细化 + 引号参数抹除 `Iue`）、URL 族（`wgt` 增加 `-/merge_requests`）、stdout 取**最后一个** URL（`Pat`）、渲染 10 动词表（`Re`）+ `MR !N` 徽标（`e6` 判 GitLab、`wje=2048` 长度上限）、遥测统一流（`F=v??x`，glab created 也计数 + 会话挂接）。全部移植，逐字节核对（2.1.259 `claude.strings` 偏移：glab 表 20130072/20136000，`auto-merge-disabled` 20129516/20130564，`enabled auto-merge on` 8566072，`MR !N` 25360041，URL 族 20131437；镜像 blob 9913366/10590456）。

### 逐文件表

| 文件 | 变更 | 二进制依据 |
|---|---|---|
| `src/tools/shared/gitOperationTracking.ts` | `PrAction` 扩展为 10 值（+ reopened/ready/draft/auto-merge-enabled/auto-merge-disabled）；新增 `GLAB_MR_ACTIONS` 6 动词表；新增 `QUOTED_ARGS_RE` 引号抹除；新增导出 `resolvePrAction()`（gh 表优先 → merge/ready 细化 → glab 表 → update 细化）；新增 `PR_URL_RE`（GitHub `pull` / Bitbucket `pull-requests` / GitLab `-/merge_requests`）、`isMrUrl()`、`PR_BADGE_URL_MAX_LENGTH=2048`；`findPrInStdout` 改为「最后一个 URL 胜出」；`detectGitOperation` pr 分支改用解析器 + URL，文本号码回退仅限 gh；`trackGitOperations` 改统一 `ghHit ?? glabHit` 遥测流，glab created 同样计数 + 会话挂接，删除旧的 glab-only 独立分支 | `Aat`/`Rat`/`Iue`/`wgt`/`e6`/`wje`/`Pat`/`F=v??x` |
| 同上（**自发现漂移修复**） | `GH_PR_ACTIONS` 补 `gh pr reopen`（`pr_reopen`）—— OCC 表缺这一行，而官方 2.1.258 已有（2.1.258 偏移 9897489/19945925 核实），属 entry 003 之前的既有漂移，本轮一并修复 | `FLe`（2.1.258/2.1.259 表一致） |
| `src/components/messages/CollapsedReadSearchContent.tsx` | prs 渲染块换为 10 动词 `Record<PrAction,string>` 表（含 `commented on`/`marked ready`/`marked draft`/`enabled auto-merge on`/`disabled auto-merge on`）；URL 在场且 ≤2048 时出徽标，`isMrUrl` 决定 `kind:'mr'`；超长/无 URL 时文本回退 `MR !N`/`PR #N` | `Re`/`Egt`（解析器已保证 URL 族，判定退化为 `wje` 长度上限） |
| `src/components/PrBadge.tsx` | 无需改动（CC 2.1.234 port 已支持 `kind:'mr'` → "MR !N"） | — |
| `src/utils/glabMrStatus.ts` + `ghPrStatus.ts` + `hooks/usePrStatus.ts` | 只读核对：页脚徽标 60s 轮询 `fetchPrStatus() = gh 路径 ?? glab 回退`（忠实的 2.1.234 `bpp` 组合）已覆盖「刷新页脚 MR 徽标」语义；官方的即时刷新（`prResolvedThisSession`）属 2.1.259 之前既有机制，见 §7 分级保留 | `bpp`（2.1.234） |
| `test/tools/version-2.1.259-gap114.test.ts` | 新增 30 个测试（行为 + 源码级断言） | — |

`PrAction` 联合类型的其余消费方仅 `src/types/message.ts:155` 与 `src/utils/collapseReadSearch.ts`（类型透传），扩展安全。

## §2 分级保留 — Gap-114a：`--permission-prompts none`（entry 002，下一轮 P0）

> Added `--permission-prompts none` for unattended headless hosts: anything that would prompt is denied automatically while the active permission mode (including auto mode) keeps deciding.

本轮已完成规格取证（未移植，原因见下）：

- CLI：`--permission-prompts <target>`，choices `["host","none"]`，默认 `"host"`；判定 `wJ(e){return e==="none"}`；print 路径设置 `hostAnswersElicitations=false` 并打日志
- 权限工厂 `ny` 的 none 分支：先跑 `hasPermissionsToUseTool`（`qd`）；ask 结果走 PermissionRequest hook（`_zt`→`vfo`，hook allow/deny 都被尊重，错误文案 `PermissionRequest hook failed for headless agent: ...`）；hook 未回答的 ask → 直接拒绝（`Ki(se)`）；非 allow 结果统一走 `emitPermissionDenied(toolName,...)`
- 沙箱：`lt.initialize(bu(Ne?Mu(pe):pe.createSandboxAskCallback(...)))`
- OCC 落点：`src/main.tsx` ~1064（`--permission-prompt-tool` 注册处，新 flag 在此注册、3132 处传入）；`src/cli/print.ts` `getCanUseToolFn` ~4369、`createCanUseToolWithPermissionPrompt` ~4221、SandboxManager ~641

**保留原因**：`permission_denied` 在 2.1.259 出现 24 次（偏移 8032911/8069562/9333424/9333717/9334265...），其 stream-json 事件**形状**尚未逐字节取出；`hostAnswersElicitations` 的读写点清单也未穷尽。按 skill「Never invent」，留到下一轮取证完整后移植。

## §3 分级保留 — entry 011（`CLAUDE_CODE_MAX_CONTEXT_TOKENS` × 未识别 Vertex 风格 ID）

> Fixed `CLAUDE_CODE_MAX_CONTEXT_TOKENS` being ignored for Vertex-style model IDs (`@YYYYMMDD` suffix) of model versions Claude Code doesn't recognize.

取证：修复点在 env-override 适用性门（2.1.258 `wL` → 2.1.259 `GL`，带规范化链 `cr`/`Et`/`cy`/`oW`/`iW`/`pge`）——未识别的带日期 `claude-*` ID 经日期剥离后 `d!==o`，从而拿到 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`。OCC 的 `getContextWindowForModel`（`src/utils/context.ts`）位于整个门家族之前，无对应宿主结构可挂 —— 与 2.1.257/2.1.258 轮同样分级保留，不猜。

## §4 测试与验证

- 新增 30 个测试：`test/tools/version-2.1.259-gap114.test.ts`（行为：`resolvePrAction` 全动词 + 细化 + 引号抹除 + gh 优先；`isMrUrl`；`detectGitOperation` glab URL 提取/最后 URL 胜出/无文本回退/gh 文本回退保留/既有 commit 检测不受影响；源码级：渲染器 10 动词表、`MR !` 前缀、`kind` 传递、统一遥测流、6 动词表完整性、reopen 漂移修复）
- 全量门（`scripts/ci-test.sh`，逐文件进程隔离）：**3477 pass / 15 fail / 12 skip**；基线 3447 / 15 / 12 —— 增量恰为 +30，15 个失败全部是已知环境性 tmux/live-model e2e，与基线相同
- `bun run build` 绿：`dist/cli.js` 28.97 MB（MACRO.VERSION=2.1.321）
- 冒烟绿：`occ --version` → `OCC 2.1.321`；`echo "say PONG" | occ -p` → `PONG`（exit 0）；tmux REPL 真实启动 + 交互往返（`say PONG` → `● PONG`，token 计数推进，auto mode/effort 指示正常）
- 安全审查（issue 要求）：全 diff 审查 —— 无后门、无新增外发、无权限/沙箱弱化、无供应链变更；两条 LOW（`PR_URL_RE` 最坏二次回溯受命令动词门 + stdout 截断约束，且与官方二进制逐字节一致；OSC 8 超链接控制字符净化为既有缺口非本轮引入）。**APPROVE**

## §5 OCC 天然 no-op（按设计不追）

| entries | 原因 |
|---|---|
| 004 | `claude plugin validate --json` —— OCC 已裁剪插件系统，无 validate 面 |
| 013 | claude.ai 后台 GitHub 连接检查 —— OCC 无此面 |
| 016 | Artifact 云发布 —— OCC 无 Artifact 云 |
| 019 | 云会话 OTEL 属性 —— OCC 无云会话/受管 OTEL |
| 024 | Remote Control 会话的 Stop —— OCC 无此子系统 |
| 028 | 远端（claude.ai）会话 MCP 页面失效延迟 —— OCC 无 |
| 030 | 终端重绘/首帧渲染内部性能优化 —— 无可移植面 |
| 032 | headless 首 turn 50ms 微优化 —— 无用户可见面 |
| 036 | [VSCode] 会话列表过滤器 —— OCC 无 VSCode 扩展 |
| 037 | 远端/计划会话连接器权限提示 —— OCC 无 |

## §6 分级保留 — 安全类（下一轮 P0 候选）

- **007（本轮新增，P0）** Bash `Read()` deny 规则未覆盖：选项值形式给文件（`--ignore-revs-file=.env`、`-f.env`、`@file`）、`git diff`/`git grep` 的文件操作数、`cd DIR && cat FILE` 复合命令；对含被拒文件的目录执行 `grep -r`/`cp -r` 现在应询问。OCC 的 Bash deny 规则是活路径 —— 需逐点取证官方的新匹配器再移植
- **承自 OCC-113 §6**（未变，逐点取证待排期）：046（auto 模式复合命令内 `permissions.ask` 跳过）、054（`< file` 重定向与 `tac`/`egrep` 类读取命令绕过 `Read()`/`Edit()` deny）、070（zsh `[[ ]]` 解析差异残留形态核查）、052（非 JSONL 灌入 `-p --input-format stream-json` 无界内存）、051（`.mcp.json` FIFO/设备符号链接挂死）、091（项目 `defaultMode: "bypassPermissions"` 应忽略）、005（2.1.257 auto 模式 Containment Escape 规则）、082（MCP 连接/OAuth 日志脱敏）、093（`--add-dir` 网络路径）、047（插件组件符号链接逃逸，核对 OCC 自建 loader）

## §7 分级保留 — 其余（需逐点取证，不猜）

- **002** → 见 §2（Gap-114a，下一轮 P0）
- **011** → 见 §3
- **001** `managedMcpServers` 受管设置 —— OCC 受管设置面裁剪，需核对承载
- **005** 并发会话互相回退 `~/.claude.json` —— OCC 配置写入路径需取证（读写锁/原子合并）
- **006** thinking 一次被拒后每轮被拒 —— 需取证 API 层错误分类
- **008** OAuth token 刷新导致缓存失效（遥测关闭会话）—— OCC 遥测裁剪，核对缓存键
- **009** 全屏模式长 turn 后空白会话 —— 全屏渲染路径取证
- **010 + 015** frontmatter `model:` 命名不支持 auto 模式的模型时应保持会话模型（命令 + 技能、交互式）—— OCC frontmatter model 面待核
- **012** shell 实时输出预览在早行换行时隐藏最新行 —— 渲染取证
- **014** 含无 payload 附件条目的会话 `--resume` 失败/`--continue` 空会话 —— OCC resume 解析需核
- **017** 受管 `forceRemoteSettingsRefresh` 启动被忽略 —— 受管设置面裁剪
- **018** worktree 隔离在 `git rev-parse` 报非标准错误消息时拒绝 hook 创建的 worktree —— OCC worktree 隔离的错误分类取证
- **020** MCP 启动列工具时断连显示「已连接无工具」而非报错 —— OCC MCP 生命周期取证
- **021** 文件编辑权限对话框截断变更行无提示 —— 权限 UI 取证
- **022** 瞬时 git 探测失败后丢失已知仓库身份 —— `detectRepository` 缓存语义取证
- **023** 受管设置解析失败时拒绝启动并点名来源 —— OCC 受管设置面裁剪，核对承载
- **025** 恢复 workflow 运行时上一停止实例仍在退出 → 重复代理 —— OCC workflow 引擎生命周期取证
- **026** github.com 仓库 URL 尾斜杠/悬空 `?#` → 不可用 `.git` clone URL —— marketplace 已裁剪，核对 OCC 仓库 URL 处理
- **027** 阻塞式 Stop hook 导致下一 turn 丢失本轮 reasoning（部分模型还丢缓存）—— OCC hook 阻塞路径取证
- **029** worktree 隔离会话误拒 Bash 循环/xargs 管道/启动器包裹命令 —— OCC worktree 隔离可达性检查取证
- **031** `/workflows` 代理详情 JSON 美化 + 折叠 —— OCC workflow UI 取证
- **033** `/install-github-app` GitLab 仓库内提示 —— OCC 无此命令面
- **034** 嵌套后台 subagent 结果存入父 subagent transcript —— OCC transcript 结构取证
- **035** `allowedMcpServers` 只管用户自加服务器 —— 受管 MCP 语义，OCC 面裁剪
- **Gerrit 追加（changelog 未点名）**：2.1.259 git 追踪子系统还含 Gerrit 支持（`Dvn` URL 正则、`Jwo` provider 含 `"gerrit"`、`Mue` code_change_published 分支、`Pat`/`nEo` 去重上限 `tEo=10`、`Ojt` 溢出尾部 `rEo=8192`）——changelog 未点名且 OCC 无对应承接面，分级保留
- **既有漂移笔记（2.1.259 前官方机制，OCC 一直缺失，非本轮 entry 范围）**：`pr_review`（`Qwo`）遥测、`prResolvedThisSession`/`markPrResolvedThisSession` 即时徽标刷新、contribute-link 子系统（`Cat`/`Mue`/`Pue`/`dEo`、`K8e` flush、`Ivn`/`Pvn`）—— 2.1.258 二进制同样存在，属历史欠账，独立立项处理

## §8 发版

- 版本：**2.1.321**（OCC 2.1.3xx ↔ 官方 2.1.2xx；2.1.320 ↔ 2.1.258，2.1.321 ↔ 追齐 2.1.259）
- CHANGELOG：`Caught up with upstream Claude Code through 2.1.259` + 用户可见变更
- 流程（固化）：合入 main → tag `v2.1.321` → push 触发 `.github/workflows/publish.yml`（build → npm publish → `gh release create "$GITHUB_REF_NAME" --generate-notes --title "$GITHUB_REF_NAME"`，`permissions: contents: write`、`if: success()`、幂等 `gh release view` 探测、无 `--target`）
- 发版后校验：`gh api repos/cnwenf/occ/releases` 计数 == `/tags` 计数；`comm -23 <(tags) <(releases)` 为空
