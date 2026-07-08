# Workflow

Workflow 工具让你用自包含的 JavaScript 脚本编排多代理、多阶段任务。脚本在 vm 沙箱中执行，提供 `agent`、`parallel`、`pipeline` 等原语。OCC 中由 `WORKFLOW_SCRIPTS` feature flag 启用（已在白名单）。

## 概念

一个 workflow 是一个 `.js` 脚本，导出 `meta` 和默认 async 函数。OCC 在 vm 沙箱中运行它，注入原语让脚本派生代理、并行执行、分阶段推进。workflow 可以同步运行（实时进度）或异步运行（后台，不阻塞 REPL）。

## Workflow 工具

工具名 `Workflow`（`src/tools/WorkflowTool/WorkflowTool.ts`），`isOpenWorld() = true`，`isConcurrencySafe() = false`。

### 输入 schema

```jsonc
{
  "scriptPath": "/abs/path/to/workflow.js",   // 绝对路径，自包含脚本
  "args": { "key": "value" },                 // 传给 workflow 的参数对象
  "resumeFromRunId": "wf_abcdefgh1234",       // 恢复（需匹配 /^wf_[a-z0-9-]{6,}$/）
  "name": "my-workflow",                      // 预定义 workflow 名
  "remote": true                              // 异步后台运行
}
```

`scriptPath` 与 `name` 二选一。`name` 从 `.claude/workflows/`、`~/.claude/workflows/` 或内置解析（`resolveWorkflowScript`）。

### 输出 schema

```jsonc
{
  "result": "...",
  "message": "...",
  "agentCount": 5,
  "logs": ["..."],
  "failures": ["..."],
  "durationMs": 12345
}
```

## 脚本格式

ESM 脚本，导出 `meta` 和默认 async 函数：

```javascript
// my-workflow.js
export const meta = {
  name: "refactor-workflow",
  description: "跨文件重构",
  phases: ["explore", "refactor", "verify"]
};

export default async ({ agent, parallel, pipeline, phase, log, budget, workflow, resolveWorkflow, args }) => {
  const { target } = args;

  // 阶段 1：探索
  await phase("explore");
  const files = await agent(`找出所有引用 ${target} 的文件`);

  // 阶段 2：并行重构
  await phase("refactor");
  const fileLists = splitFiles(files.result);
  const results = await parallel(
    fileLists.map(files => () => agent(`重构这些文件中的 ${target}: ${files}`))
  );

  // 阶段 3：验证
  await phase("verify");
  const verify = await agent("运行测试，确认重构正确");
  log("完成", verify.result);

  return { refactored: results.length };
};
```

### 原语

| 原语 | 说明 |
|------|------|
| `agent(prompt, opts?)` | 派生子代理执行任务，返回结果。相同 `(prompt, opts)` 在 resume 时返回缓存结果 |
| `parallel(items)` | 并行执行（最多 4096 项，约 10 并发） |
| `pipeline(items, ...stages)` | 流水线处理（每阶段处理上阶段输出） |
| `phase(title)` | 标记阶段 |
| `log(...args)` | 记录日志 |
| `budget` | 预算对象：`{total, remaining(), spent()}` |
| `workflow(nameOrRef)` / `resolveWorkflow(name)` | 调用其他 workflow |

### 脚本要求

- **确定性**：脚本必须可重复执行以支持 resume —— 禁止 `Date`、`Math.random`、动态 `import`。
- **自包含**：所有依赖通过原语获取，不依赖外部状态。

## 运行 ID 与恢复

每个 workflow 运行有 `runId`（`generateWorkflowRunId()` → `wf_<12字符>`）。

`resumeFromRunId` 恢复中断的运行：缓存的 `agent()` 调用若 `(prompt, opts)` 未变则立即返回，跳过已完成的步骤。日志/journal 存在 `<taskOutputDir>/wf-runs/<runId>/`（`WorkflowJournal`）。

## 异步执行

`remote: true` 时 workflow 异步运行（`runWorkflow` 在后台 promise 中）：

- 用 `createSubagentContext(context)`，其 `setAppState` 与 `setAppStateForTasks` 是 **NO-OP**（防止 Ink 跨根 `flushSync` 崩溃）。
- 进度写入 `~/.claude/wf-progress/<runId>.json`（`writeWorkflowProgress`）。
- 主线程轮询器（`useWorkflowProgressPoller`）读文件并安全更新 AppState。
- 完成/失败通过主线程的 `setAppState` 在 `setTimeout(0)` 中调用 `completeWorkflowTask`/`failWorkflowTask`。

这让长运行 workflow 不阻塞 REPL，你可在 workflow 运行时继续对话。

## 同步执行

`remote` 未设时 workflow 同步运行，实时进度通过 `updateWorkflowProgressBatch` + `onProgress` 渲染 `WorkflowProgressTree`。

## /workflows 命令

```bash
> /workflows
```

`/workflows`（`src/commands/workflows/`）是 `local-jsx` 命令，挂载 `WorkflowDetailDialog` —— 自动刷新的运行/完成 workflow 浏览器，按启动类型分组，读取 `appState.tasks` 中 `local_workflow` 类型的任务。

完成的 workflow 作为 `local_workflow` 任务保留在 `appState.tasks` 中，可浏览（`requires: { ink: true }`，`immediate: true`）。

## /goal 命令

```bash
> /goal 所有测试通过且 lint 无错误
> /goal clear
```

`/goal`（`src/commands/goal/`）设定会话级 **Stop hook**（`addSessionHook(... 'Stop' ..., {type:'prompt', prompt:condition})`），阻止 Claude 停止直到条件达成。

- `CLEAR_ALIASES`：`clear`/`stop`/`off`/`reset`/`none`/`cancel`。
- `GOAL_CONDITION_MAX = 4000`（条件文本上限）。
- 成功时（`tengu_goal_achieved`/`goal_met`）或不可能时（`tengu_goal_failed`）自动清除。
- 需信任工作区 + hooks 启用（`disableAllHooks`/`allowManagedHooksOnly` 会阻止）。

交互式（`goalInteractive`，REPL）与管道模式（`goalNonInteractive`，`-p`）两种变体。

## 内置 workflow

内置 workflow 编译进 CLI（`src/tools/WorkflowTool/bundled/index.js`），通过 `name` 参数调用。

## 启用条件

`isWorkflowsEnabled()`（`src/utils/effort/workflowDiscovery.ts`）返回 `feature('WORKFLOW_SCRIPTS')`，OCC 中为 true。`CLAUDE_CODE_WORKFLOWS_DISABLED=1` 可禁用。

`WORKFLOW_SCRIPTS` flag 一次性解开：Workflow 工具（`src/tools.ts`）、`/workflows` 命令、`getWorkflowCommands`（`src/commands.ts`）。

## 与守护进程的关系

异步 workflow 的主要路径是**进程内**（WorkflowTool 中的后台 promise）。`workflowWorker.ts` 的 `runWorkflowWorker()` 是**独立进程回退** —— 从环境变量读参数（`CLAUDE_WORKFLOW_SCRIPT_PATH`、`CLAUDE_WORKFLOW_ARGS`、`CLAUDE_WORKFLOW_RUN_ID` 等），用 NO-OP `setAppState` 构建非交互上下文，进度写 `~/.claude/wf-progress/<runId>.json`，孤儿看门狗在父进程消失时刷新为 `'aborted'`（避免 REPL 轮询器看到卡住的 `running`）。

详见 [守护进程](./daemon.md)。

## 下一步

- [工具](./tools.md) —— Workflow 工具与其他工具。
- [子代理](./sub-agents.md) —— `agent()` 原语派生的子代理。
- [守护进程](./daemon.md) —— 异步执行与 worker。
