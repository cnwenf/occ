# OCC-97 — 2026-08-18 无版本差 · 严格自验收轮(官方仍 2.1.233),发现并修复 Gap-97a/b/c/d/g/h

## 1. 版本状态(三方核实,2026-08-18)

| 来源 | 结果 |
|------|------|
| npm `@anthropic-ai/claude-code` dist-tags | `latest` = `next` = `2.1.233` |
| GitHub releases (anthropics/claude-code) | latest release `v2.1.233`(published 2026-08-14) |
| 已缓存官方 2.1.233 linux-x64 ELF strings(`/tmp/occ97/strings.txt`) | `2.1.233` 版本标记在位,无 `2.1.234+` 标记 |

**结论:官方最新版仍为 `2.1.233`,无新版本。** OCC 已在 OCC-95/96(release
`2.1.302`/`2.1.303`)追平 2.1.233 的可移植子集。本轮无版本差可追,按 issue
指示执行**严格自验收**:像真实用户一样使用 OCC REPL,以官方 Claude Code
2.1.233 为基准逐项核对行为/输出/参数/错误处理,发现的任何不一致记录为 gap
并按流程修复。

基准工具:官方 2.1.233 ELF 的 `strings` 逐字节提取(官方 settings schema、
SDK schema、picker 循环函数 `VXm`、picker commit `FZn`、get_settings 响应构造
均逐字节核实)+ 官方 REPL 行为探针 + 本地日志代理(端口 9731)对比 API 层
请求体。

## 2. 自验收发现与修复(本轮 landed)

### Gap-97a — `doctor` 命令描述过期

OCC 的 `doctor` 子命令描述仍是旧文案("Check the health of your Claude Code
auto-updater…")。官方 2.1.233 注册文案已改为:
`Check the health of your Claude Code installation. Reads settings files in the current directory without a trust prompt. For a full checkup that can also fix issues, run /doctor in a session.`
→ `src/main.tsx` 描述更新为逐字节一致。

### Gap-97b — `todoToolsAvailability233.test.ts` mock 泄漏(test-only)

该测试文件使用 `mock.module` 后未在 `afterAll` 还原,泄漏到同进程后续测试
文件,造成 e2e 套件顺序敏感。→ 补 `afterAll(() => { restore... })`,与
Bun `mock.module` 语义一致。纯测试修复,无行为变化。

### Gap-97c — xhigh effort:持久化、展示与官方文案

官方 2.1.233 的 effort 体系是五级 `low/medium/high/xhigh/max`,其中
`xhigh` 是可持久化档位(`max` 不是 —— 官方 settings schema 只收四档)。
自验收发现:settings.json 写 `effortLevel: "xhigh"` 后,OCC REPL 芯片掉回
`high`。逐项修复:

- **展示不回退**:`getDisplayedEffortLevel` / `getEffortSuffix` 按配置值
  原样显示(官方探针:非 xhigh 模型上配置 xhigh,芯片仍显示 `xhigh`,
  降级只发生在 API 层 `output_config.effort`,不在 UI)。
- **官方描述文案**:`getEffortLevelDescription` 的 xhigh/max 文案取自官方
  `TU_` 表逐字节恢复(xhigh = "Deeper reasoning than high, just below
  maximum (Fable 5, Opus 4.7+, Sonnet 5)";max = "Maximum capability with
  deepest reasoning. May use excessive tokens …")。
- **`/effort` 命令面**:参数提示 `argumentHint`、非法参数报错文案
  ("Invalid argument: X. Valid options are: low, medium, high, xhigh, max,
  ultracode, auto")、`med` 别名、help 文本、`xhigh` 档写入后缀
  ("with xhigh effort")全部与官方 REPL 探针逐字节一致。
- **持久化**:`toPersistableEffort('xhigh')` 保留(官方会把它写回
  settings.json);`max` 对非 ant 用户仍不落盘。
- e2e `version-2.1.154-k1-k2-k3` 重新钉住官方 help bullet(原先钉的
  `ULTRACODE_EFFORT_DESCRIPTION` 导入已被移除)。

### Gap-97d — 官方 2.1.233 model registry 能力移植

官方 model registry(自 ELF 逐字节恢复)中七个模型的能力位:

| 能力 | 模型 |
|------|------|
| `effort` / `max_effort` | opus-4-6/4-7/4-8/opus-5、sonnet-4-6/sonnet-5、fable-5 |
| `xhigh_effort` | opus-4-7/4-8/opus-5、sonnet-5、fable-5(**不含** opus-4-6/sonnet-4-6) |
| `adaptive_thinking` | opus-4-6/4-7/4-8/opus-5、sonnet-4-6/sonnet-5(+fable-5 走 1P 默认) |
| `default_effort: xhigh` | **opus-4-7** |
| `max_output_tokens 64000/128000` | opus-4-7/4-8/opus-5/sonnet-5/fable-5 |

→ `src/utils/effort.ts`(allowlist + `getDefaultEffortForModel` opus-4-7 →
xhigh + `resolveAppliedEffort` API 层语义)、`src/utils/thinking.ts`
(adaptive 名单)、`src/utils/context.ts`(64k/128k 输出上限,原先掉到
32k/64k 默认档)。

### Gap-97g — settings / SDK schema 与官方对齐

官方 settings schema(ELF 逐字节核实):
`effortLevel:Pr(["low","medium","high","xhigh"]).optional().catch(void 0).describe("Persisted effort level for supported models.")`
— **无 USER_TYPE 门控,永不收 `max`**。OCC 旧 schema 是 ant-gated 的
三/四档枚举且不含 `xhigh` —— 这就是 Gap-97c 芯片掉档的根因(parse 阶段把
持久化的 xhigh 丢了)。修复:

- `src/utils/settings/types.ts`:`effortLevel` → 官方四档枚举 + `.catch(undefined)`
  + 官方 `.describe()` 文案,无门控。
- `src/entrypoints/sdk/coreSchemas.ts`:`ModelInfoSchema.supportedEffortLevels`
  → `["low","medium","high","xhigh","max"]`;`AgentDefinitionSchema.effort`
  → `union([五级枚举, int])`(与官方 SDK schema 一致)。
- `src/entrypoints/sdk/controlSchemas.ts`:get_settings 响应 `applied.effort`
  → 五级枚举 nullable(`resolveAppliedEffort` 现在可产出 xhigh)。
- `src/services/api/src/utils/effort.ts` stub 类型同步五级。
- `src/utils/frontmatterParser.ts`:agent `effort:` frontmatter 注释补齐五级
  + 整数。

### Gap-97h — `/model` picker 的 effort 循环缺 xhigh

官方 picker 循环函数 `VXm`(逐字节恢复):五级基础列表按能力过滤
(`xhigh` 需 `xhigh_effort`、`max` 需 `max_effort`);当前档位模型不支持时
先 clamp 到 `high` 再循环;档位不在列表时回落到**最后一项**。OCC 旧实现是
三档硬编码。→ `src/components/ModelPicker.tsx`:`cycleEffortLevel` 导出并
按 `VXm` 重写;displayEffort 与官方一致(chip 原样,仅 picker 内 clamp);
React Compiler memo 槽位 `_c(82)` → `_c(84)`(新增 focusedSupportsXhigh
缓存槽 + 循环 handler 依赖键)。REPL 实测:glm-5.2(非 xhigh 模型)上
xhigh clamp 为 "High effort (default)",三档循环 ○ ◐ ● 正常 —— 与官方
对非 xhigh 模型的行为一致。

> 官方 `VXm` 还会在 workflows 开启时向循环追加 `ultracode` —— 该分支依赖
> Gap-97f 的 ultracode appState 管线,同批 staged(见 §3)。

## 3. Staged(本轮不移植,记录依据)

| 项 | 依据 |
|----|------|
| **Gap-97e** effort 滑条(picker 内左右键精细调档) | 官方交互在 ELF 中为纯渲染态,无可验证的状态机;不猜 |
| **Gap-97f** get_settings 响应 `applied.advisor` / `applied.ultracode` / 顶层 `errors` | 官方构造为 `applied:{model,effort,advisor:mJo(...),ultracode:Yne(...)}` + `errors`(settings 解析错误,过滤 warning)。`Yne(e,t,r)=r===true&&YD()&&Kne(e,t)==="xhigh"`(`YD()`=isWorkflowsEnabled);`mJo`=advisor 解析(gated)。OCC 当前无 ultracode settings-key / appState 字段 / advisorModel-in-appState —— OCC 的 ultracode 是 session flag(`isUltracodeEnabled()`),整体管线需先行,超出本轮 |
| picker 循环追加 `ultracode` 档 | 同上,共享 Gap-97f 管线 |
| thinking `display:"omitted"` 微差 | API 层观察项,官方在 thinking 被裁剪时回显该标记;需专项核对渲染路径 |

Staged 纪律与前轮一致(CLAUDE.md:"picker-UI render stays staged" 先例):
二进制里含糊的、移植即"发明"的,不移植、只记录。

## 4. 自验收执行记录

- **API 层**:本地日志代理(9731)捕获 OCC 请求体,`output_config.effort`
  语义与官方一致(xhigh 配置在非 xhigh 模型上 API 降为 high,芯片不回退);
  adaptive thinking 以 `{type:"adaptive"}` 随支持模型下发。
- **REPL(tmux 实测,`bun dist/cli.js`)**:芯片 `◍ xhigh · /effort`;
  welcome 行 "MODEL glm-5.2 with xhigh effort";`/effort` 当前值/help/
  非法参数/`med` 别名/`xhigh` 写入全部与官方逐字节一致;`/model` picker
  三档循环与 clamp 行为一致。settings.json `effortLevel:"xhigh"` 持久化
  读写闭环。
- **单元**:`src` 全量 **2027 pass / 0 fail / 4717 expect()**;新增
  `effortGap97.test.ts` 25 tests(Gap-97c/d/g/h 逐项)。
- **e2e**:model/alignment/versioning/ultracode 组 **45 pass**;opus5 组
  **27 pass**;2.1.183/2.1.200 命令组 **17 pass**(共 5 个批次文件,0 fail)。
- **Lint**:Biome 对 7 个改动源文件 clean;**构建**:绿,`dist/cli.js`
  28.90 MB,MACRO.VERSION=2.1.303(发布前 bump)。

## 5. 安全审查(issue 要求:检查是否有后门)

security-reviewer 对本轮全部改动(15 文件,~194+/64-)逐行审查:纯
schema/类型/UI 文案/测试 diff,无新增网络调用、无 eval、无凭据访问、无
可疑 URL、无依赖变更、无硬编码密钥。结论:**PASS,未发现后门**。

## 6. 发布(release v2.1.304)

用户可见修复已合入(xhigh 持久化与展示、/effort 文案、picker 循环、doctor
文案)→ 按发布流程:`package.json` bump `2.1.303 → 2.1.304`、CHANGELOG
补记、tag `v2.1.304` 推送触发 publish.yml;发布后核对 `/releases` 数 ==
`/tags` 数。

## 7. 残留分支清理(验收项)

| 分支 | 状态 | 处理 |
|------|------|------|
| `origin/agent/occ-leader/5b73b8ec` | 已并入 main(PR #282) | 删除 |
| `origin/agent/occ-leader/220da977` | 内容(occ85 gap doc)已在 main | 删除 |
| local `agent/blog-writer/905813a2` | 无领先 main 的提交 | 删除 |
| local `occ69-unit-note` | 内容(2092 pass 自验收行)已在 main | 删除 |
| `agent/occ-leader/d9f49d66`(本轮) | PR 合入后 | 删除 |
