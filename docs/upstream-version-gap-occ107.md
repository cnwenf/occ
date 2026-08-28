# OCC-107 — 2026-08-28 版本追齐(官方 2.1.247 落地:磁盘输出写失败子系统 + 3 处 CI 门修复;周期内官方 2.1.248 全量分诊;发布 2.1.314)

## 1. 版本状态(三方核实)

| 来源 | 状态 |
|------|------|
| npm `@anthropic-ai/claude-code` | latest = **2.1.248**,next = 2.1.250 |
| GitHub releases | **v2.1.248 = Latest**(2026-08-27T22:12:20Z);v2.1.247(2026-08-26T23:06:39Z) |
| changelog | 2.1.247 共 **33 条**;2.1.248 共 **37 条** |
| OCC(追齐状态) | OCC-106 已追齐 2.1.246(发布 2.1.313)→ 本轮开工时 gap = 仅 2.1.247;**周期内**(2026-08-27T22:12Z)官方又发 2.1.248 → 本轮落地 2.1.247 后对 2.1.248 全量分诊归档(§6),留下一轮 |

二进制取证(官方平台包 `@anthropic-ai/claude-code-linux-x64`,`npm pack` 原样解包,`strings -n 8` dump):

| 版本 | ELF md5 | 体积 | 版本标记 |
|------|---------|------|----------|
| 2.1.247 | `d6b16975db11ba90c177eecdb8ff38d9` | 250,162,696 bytes | `2.1.247` ×1555,`2.1.248` ×0 |
| 2.1.248 | `72d37391fcd841fb9c82e882411950a6` | 223,599,960 bytes | `2.1.248` ×1905,`2.1.249+` ×0 |

重复任务护栏:开工前已核实 workspace 内无其他 running/queued 的版本追齐任务;本 issue 即当前唯一追齐轮。

## 2. 逐版本结论

- **2.1.247**(33 条):全量逐条分诊(§5)。落地 **Gap-107a**(磁盘输出写失败子系统,第 16 条);其余 32 条 = 无 OCC 对应面 / staged。
- **2.1.248**(37 条):周期内新发。全量逐条分类完成(§6),本轮**不强制落地** —— 所有可移植候选均需专项逐点反编译取证,按 `aligning-with-official-binary` 纪律(不取证不移植、绝不发明)留下一轮。下一轮 gap = 仅 2.1.248。

## 3. 本轮落地项(均对官方 2.1.247 ELF 取证)

### Gap-107a — hook/后台任务输出文件写失败:无界内存增长修复 + 丢失位置标注(2.1.247 第 16 条)

changelog 原文:“Fixed unbounded memory growth when a hook's or background task's output file could not be written; the file now notes where output was lost”

**官方机制**:`DiskTaskOutput` 增加 drain 失败子系统 —— 写失败重试一次;耗尽类 errno(ENOSPC/EDQUOT/ENFILE/EMFILE)且未写量超过 16 MiB 时,丢弃已排队内容并插入 omission marker(“输出未能写盘”标注);非耗尽类 errno(如 EACCES)保留队列等待恢复;重复错误按 `${kind}:${code ?? 'no errno'}` 去重,不刷屏;`evictTaskOutput` 记录被丢弃量;读取侧(尺寸/增量/读取)输出按 errno 分类的调试日志(ENOENT 静默 —— 文件未生成属常态);失败/丢失状态下对外读取接口不再谎称“已保存”。

**落地**(与官方行为逐点对应):
- `src/utils/task/diskOutput.ts`:常量 `MAX_UNWRITTEN_CHARS_BEFORE_DROP`(16 MiB)、`OUTPUT_OMITTED_MARKER`、`DISK_EXHAUSTION_ERRNOS`;`DiskTaskOutput` 增加 `#unwrittenChars`/`#cancelCount`/`#failing`/`#seenFailureKeys`/`#lostOutput` 字段与只读 getter;`#drain()` 重试一次;`#handleFinalDrainFailure`(errno 分类、去重键、超阈值丢弃转 marker);`evictTaskOutput` 丢弃日志;读取侧助手 `logTaskOutputFailure(context, e)`(ENOENT 静默)。
- `src/utils/task/TaskOutput.ts`:pipe 模式 `getStdout()` 标注分支 —— `failing || lostOutput` 时改输出 “The full output could not all be saved to …; that file may be missing or incomplete.”,不再指向“已保存”的文件路径误导模型。
- 13 个钉死测试(`src/utils/task/__tests__/diskOutputDrainGuard247.test.ts`,48 expects):happy path、write 级失败(marker 前插)、open 级 ENOSPC >16MB 丢弃、EACCES 队列保留、cancel 语义、evict 丢弃日志、去重、读取侧三类接口的 errno 分类日志、健康/失败两分支的 getStdout 标注。
- 测试工程(均为探针实测的 Bun 1.3.14 `mock.module` 定律):命名空间是活绑定 —— mock fake 内直接包 `ns.open` 会无限递归,必须快照加载期值(`{ ...REAL_FS }`);`mock.restore()` 对 `mock.module` 无效,恢复 = 以真模块快照重新 mock;注册是进程级永久的,故恢复不当会跨文件泄漏(这正是 `scripts/ci-test.sh` 逐文件独立进程的原因)。

### 伴随项:修复 3 处既有 CI 门失败(本轮 CI 有望首次转绿)

上一轮合入后 main 的 CI 即为红(run 32998677980:3075 pass / **7 fail** / 317 skip),3 个失败文件全部在本轮修复:

| 文件 | 根因 | 修复 |
|------|------|------|
| `autoCompactExplicitlyOff.test.ts` | mock 整体替换 `config.js` 丢掉其余导出 → `Export named 'saveGlobalConfig' not found in module config.ts` | 改为展开真模块、仅覆盖 `getGlobalConfig`(仓库既有惯例,同 OCC-97 Gap-97b 教训) |
| `generalPurposeDefault235.test.ts`(5 用例) | CI 无凭据 + bun 自动 `NODE_ENV=test` → auth guard(`src/utils/auth.ts`)在凭据解析前抛错 | 测试文件头部 hermetic 播种 `process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'`(本机已有真密钥时为 no-op) |
| `anthropicDefaultModel236.test.ts`(14 用例) | 同上 | 同上 |

三个文件在**本机环境**与 **CI 模拟环境**(`env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN CI=1`)双向验证全绿。

## 4. 验证(全部实测)

| 项 | 结果 |
|----|------|
| 新增测试 | 13 pass / 48 expects(单文件独立进程 = CI 模式) |
| 3 处 CI 修复 | 5 + 5 + 14 用例,本机与 CI 模拟环境双绿 |
| 全量门 `scripts/ci-test.sh`(404 文件逐文件独立进程) | **3172 pass / 14 fail / 11 skip**;14 fail(9 文件)全部为 tmux/交互/真模型 e2e,全部 A/B 核实与干净树一致(§4a) |
| 构建 | `bun run build` → `dist/cli.js` **28.93 MB** |
| 真模型 `-p` | `echo "say PONG" \| occ -p` → `PONG`,exit 0 |
| tmux REPL | 启动渲染完整(欢迎框 + 项目行 + 提示符)绿 |
| lint | `biome lint` 6 个改动/新增文件,零告警 |

### 4a. 全量门说明

`scripts/ci-test.sh` 是官方测试门:每个测试文件在**自己的 bun 进程**中运行(`bun test "$f" --timeout 10000`),计数求和,任一失败即非零退出 —— 正是因为 §3 所述的 `mock.module` 进程级永久注册定律。CI workflow(lint → build → ripgrep → ci-test.sh)与本地跑的是同一脚本。

本机全量跑会包含 e2e(tmux + 真模型凭据),其中一小撮 tmux/交互类 e2e 属**既有环境性失败**(OCC-11 sandbox-stall 类):已用 `git stash -u`/detached-checkout + 重建 A/B 双向核实 —— 在干净树(无本轮 diff)上失败集合**完全一致**,且这些文件在 CI 中被 `describe.skipIf(!!process.env.CI || !TOKEN || !BASE_URL)` 跳过,不进 CI 门。本轮实测失败集合(9 文件):`feedback-ai`、`goal-gate`、`goal-panel`、`repl-interactive`、`resume-command-name`、`trust-gate`、`version-2.1.208-screen-reader`、`version-2.1.210-plan-approval`(本轮新增 A/B:base 提交 025e3e5 上同样 0 pass / 2 fail)、`workflow-permission-dialog-ctrl-g`(上一轮全量门同样失败);`workflow-save-dialog-config-dir` 为已知 flaky,本轮通过。

## 5. 2.1.247 其余项分诊(本轮未落地,逐项理由)

**无 OCC 对应面(不落地):**

| 项 | 理由 |
|----|------|
| `SendFeedback` 工具 + `feedbackDrafts` 设置 | OCC 无 SendFeedback 工具面(现有 `/feedback` 命令是独立实现,无“起草-审阅-发送”流程) |
| `/claude-api cost-optimize` + Admin API 覆盖更新 ×2 | OCC 的 bundled skill .md 文件为有意 1-byte stub(历轮既定) |
| plugins ×2(marketplace 名控制/隐形字符加固、无版本 plugin 缓存目录重建) | plugins 面已裁剪 |
| cloud 会话 ×2(切模式显示旧 permission mode、容器重启吞声) | OCC 无云会话子系统 |
| Remote Control 工作树 diff 上报 | 无 Remote Control 子系统 |
| self-hosted runner 过早报 running | 无 self-hosted runner 子系统 |
| 首启 “Unable to connect to Anthropic services”(managed settings 网关) | managed-settings 组织子系统(与 OCC-46 staged 同批) |
| analytics 自启动即保持关闭 | OCC analytics 为 stub |
| 后台会话 ×3(`opening…` 永久、前台结转命令 `[exited with code -1]`、…)| `BG_SESSIONS` 休眠;OCC 用自研 daemon supervisor |
| 跨会话消息折叠预览(`Message from @<sender>`) | KAIROS 休眠 |
| gateway 登录 `surface=claude_code` 标识 | Claude apps gateway 登录面 |
| 组织登录强制(读不到 managed settings 即退出) | managed-settings 组织子系统 |

**Staged(有 OCC 对应面,需专项逐点反编译/行为核对,留后续轮次):**

| 项 | 备注 |
|----|------|
| **sub-agent 首调模型 404 → 会话 fallback 模型链 + 错误细节**(第 7 条) | AgentTool LIVE 面;**建议下一轮优先**(2.1.248 无同类项,为本批最高优先) |
| **hook/后台代理 MB 级错误输出溢出会话致 “Prompt is too long”**(第 8 条) | 与 Gap-107a 相邻但不同路径(会话级插入而非写盘);OCC 有 `src/utils/shell/outputLimits.ts` 限额面,需逐点核对是否已覆盖 |
| `spinnerTipsOverride` 扩展(`{id, text, cooldownSessions, priority}` + `tipsFile` + `label`) | OCC 有 `src/services/tips/tipRegistry.ts` 面 |
| Bash 权限提示的 auto-mode 引导 + 一键切换 | OCC auto-mode classifier 为 LIVE 面 |
| 快速方向键+Enter 作用于上一行(history search / `/config` / `/mcp` / `/skills` / 后台任务 / `/model`) | 输入/选单竞态,需专项复现取证 |
| kitty 协议终端非拉丁布局 Ctrl 快捷键失效 | 输入层 |
| 鼠标报告跨读分割转义残留(`<35;150;7M>` 入 prompt) | 输入层 |
| Bash sandbox 命令后清理误删 dotfile 管理的 `~/.claude/settings.json` 符号链接 | 沙箱面(OCC 经 `sandbox-runtime`) |
| `/terminal-setup` 覆盖 Zed `keymap.json`(应合并) | 面存在(Onboarding/PromptInput 提及) |
| `/rename` registry 更新失败时静默确认 | 小修复,需逐点核对 |
| `--agent` 会话 `/compact`/“Summarize from here” 误用默认 system prompt | compact 面 |
| `/install-github-app` over SSH 复制提示 | 面存在(`src/commands.ts`) |
| Bedrock/Vertex/Foundry(+ 关遥测)会话告知 MCP 连接失败 | 提供方面 |
| **Sonnet 5 默认 auto-compact 窗口改全量 1M(~967K 阈值)** | `src/services/compact/autoCompact.ts` LIVE 面;阈值改动需逐字节取证 |
| 渲染 markdown 终端超链接:网络/自动挂载路径、控制字符、隐形字符开头 → 纯文本 | 与 OCC-46 staged 的“隐形 Unicode 对话渲染”同批 |
| prompt-footer PR badge 终端重聚焦时 1 分钟内跳过 GitHub 重查 | OCC 有 glab badge 面(OCC-98,`gitOperationTracking`) |

**已裁决归档:** 无(本轮无新裁决;OCC-106 hook `if` 裁决维持)。

## 6. 2.1.248 全量分诊(周期内新发,本轮仅分类,留下一轮)

下一轮 gap = **仅 2.1.248**(若届时 latest 未再前移)。37 条分类如下:

**安全/新模式(下一轮最高优先):**

| 项 | 备注 |
|----|------|
| **`--restricted` / `CLAUDE_CODE_RESTRICTED=1`** 新运行模式:移除跑命令/代码的内置工具与 WebFetch(除非 `--tools` 点名),文件工具限制在工作目录内,拒绝 `bypassPermissions`,忽略 user/project/local settings | 大新安全面;需专项逐点反编译(工具过滤集、目录围栏实现、与现有权限/信任体系的互操作) |

**有 OCC 对应面 → staged(需专项取证):**

| 项 | 备注 |
|----|------|
| **agent frontmatter `experimental.cacheTtl`**(`"5m"`/`"1h"`,无 subagent TTL 设置时生效) | OCC 已有 agent frontmatter + prompt-cache TTL 子系统(OCC-105)——衔接自然 |
| **hooks stdout `{…}` 非法 JSON 不再当纯文本,报含解析信息的 hook 错误** | `src/utils/hooks.ts` LIVE 面;影响 hook 输出可信度 |
| **长会话约每小时一次 prompt-cache miss(OAuth token 刷新后工具定义重渲染)** | auth + 请求构建路径;OCC-105 TTL 子系统的相邻面 |
| 服务器托管 settings 诊断(加载失败启动警告 + `/doctor`、`/status` 行) | managed-settings 组织子系统(与 OCC-46 staged 同批) |
| `/model` 与 fast-mode 切换提示中模型名(含 `[1m]` 后缀)按代码渲染不转链接 | OCC 有 `[1m]` 后缀面,小修复 |
| `ScheduleWakeup` 工具定义随用量超额变化 → `--resume` 首轮全量 cache miss | 工具注册面(休眠门控下核对) |
| token 刷新锁竞争时被踢登录页 → 可重试错误 | `src/utils/auth.ts` 面 |
| Console 登录在不可用机器(如有 `ANTHROPIC_API_KEY` 时)先报 OAuth 错误 → 直接回退 API-key 登录 | auth 面 |
| `--agent`/agent view 相关后台会话修复 ×6(旧会话复活、旧对话顶掉输入、重复启动、已合并 worktree 分支的删除拒绝、非法 hook 应答静默等待、`PermissionRequest`/`PreToolUse` 报错命名) | `BG_SESSIONS` 休眠 + 自研 daemon;逐项核对适用性 |
| worktree 会话后台化丢 checkout(持锁) | OCC 有 worktree 面(OCC-46 staged 同批) |
| `claude agents` 键盘无响应/信任提示跳过(`CI` 时)/PR 缓存坏项崩溃 ×3 | 平台/守护面 |
| `claude logs` 残留鼠标跟踪/括号粘贴/备用屏 | OCC 有 `occ logs` 对应面(自研) |
| 信任对话框长规则截断于 emoji 中间的乱码 | UI 小修复 |
| shift+tab 紧跟 ctrl+c 时权限模式指示器被退出提示遮挡 | UI 小修复 |
| 启动警告(如 “N MCP servers need authentication”)右移一列 | UI 小修复 |
| `@` 提及非拉丁字符(韩文 IME)失配 | 输入/匹配面 |
| 第三方端点/关遥测下跨会话消息(`SendMessage`/`ListAgents`) | OCC 工具在册(`ListPeersTool`),KAIROS 门控 |
| 无效 `crossSessionInbound` 值警告+暂扣/拒绝 | 同上 |
| `/web-setup` GitHub token 缺 `workflow` scope 警告 | 面存在(`src/commands/remote-setup`) |
| MCP `headersHelper` 供 `Authorization` 时 401 应重跑 helper 重试而非走 OAuth 发现 | MCP OAuth 面 |
| `apiKeyHelper` 为唯一凭据时 gateway 模型发现不运行 | OCC-46 staged 同批 |
| `/login` Claude apps gateway + managed-settings 安全审批对话框挂起 | gateway 登录面 |
| 限流/用量提示让跑 `/usage-credits` 而该命令不可用时 | 面存在(`src/commands/usage-credits`) |
| Desktop/Cowork 会话 30 天消失(清理豁免 + `desktopSessionCleanupPeriodDays`) | 无 Desktop/Cowork 面 → 实际不落地 |
| `/ultrareview`/云会话上传 `prod.env`、`*.tfvars`、凭据临时文件 | 无云/ultrareview 面 → 实际不落地 |
| Windows `claude agents` 键盘 | 平台专属 |

**无 OCC 对应面(不落地):** self-hosted-runner `--client-label`(无该子系统);Windows 专属项;cloud/Desktop/Cowork/ultrareview/Remote Control 项(见上)。

## 7. 结论

OCC 追齐至官方 **2.1.247**(本轮开工时的 npm latest)。本轮发布 **2.1.314**。周期内官方发布 2.1.248(npm latest 现为 2.1.248),已完成 37 条全量分诊(§6)——**下一轮 gap = 仅 2.1.248**,优先项:`--restricted` 新模式、`experimental.cacheTtl`、hook 非法 JSON 错误、OAuth 刷新 cache miss;并结转 2.1.247 staged 最高优先两项(子代理 404 fallback 链、MB 级错误输出会话级限额核对)。
