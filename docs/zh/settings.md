# 配置

OCC 的配置分三层：**环境变量**、**settings.json 文件**、**命令行参数**。命令行参数优先级最高，其次是 settings.json，最后是环境变量。

## 设置文件位置

OCC 按"来源"（setting sources）加载配置，默认从三个来源加载：

| 来源 | 路径 | 作用域 |
|------|------|--------|
| user | `~/.claude/settings.json` | 全局，所有项目 |
| project | `<项目根>/.claude/settings.json` | 项目级，随仓库提交 |
| local | `<项目根>/.claude/settings.local.json` | 项目级，不提交（加入 .gitignore） |

优先级：local > project > user（更具体的覆盖更通用的）。

可用 `--setting-sources` 限定加载来源：

```bash
occ --setting-sources user,project   # 不加载 local
```

用 `--settings <file-or-json>` 追加加载额外配置：

```bash
occ --settings ./my-settings.json
occ --settings '{"model":"opus"}'
```

## settings.json 结构

```jsonc
{
  // 模型
  "model": "sonnet",            // 默认模型（别名或全名）
  "effort": "high",             // 默认 effort: low/medium/high/max
  "agent": "general-purpose",   // 默认 agent

  // 思考
  "alwaysThinkingEnabled": true, // 默认开启 extended thinking

  // 权限
  "permissions": {
    "allow": ["Bash(git:*)", "Read", "Edit"],
    "deny": ["Bash(rm:*)"],
    "ask": ["Bash(npm install:*)"]
  },

  // 环境变量（注入到工具进程）
  "env": {
    "NODE_ENV": "development",
    "MY_TOKEN": "xxx"
  },

  // Hooks
  "hooks": {
    "PreToolUse": [ /* ... */ ],
    "PostToolUse": [ /* ... */ ],
    "Stop": [ /* ... */ ]
  },

  // 归因
  "includeCoAuthoredBy": true,  // 提交信息附加 Co-Authored-By

  // 其他
  "verbose": false,
  "theme": "dark",
  "outputStyle": "default"
}
```

### 关键设置键

| 键 | 类型 | 说明 |
|----|------|------|
| `model` | string | 默认模型，可用别名（`sonnet`/`opus`）或全名 |
| `effort` | string | 默认 effort 级别 |
| `agent` | string | 默认 agent |
| `alwaysThinkingEnabled` | boolean | 是否默认开启 extended thinking |
| `permissions` | object | 权限规则（allow/deny/ask） |
| `env` | object | 注入到工具子进程的环境变量 |
| `hooks` | object | Hooks 配置，见 [Hooks](./hooks.md) |
| `includeCoAuthoredBy` | boolean | 提交信息是否附加 `Co-Authored-By`（OCC 默认附加；设 `false` 禁用） |
| `verbose` | boolean | verbose 模式 |
| `theme` | string | 主题 |
| `outputStyle` | string | 输出风格 |
| `apiKeyHelper` | string | 获取 API key 的命令（`--bare` 模式下唯一可用的 key 来源，不读 OAuth/keychain） |

### 权限规则格式

`permissions.allow` / `deny` / `ask` 是字符串数组，格式为工具名 + 可选参数模式：

```jsonc
"permissions": {
  "allow": [
    "Read",              // 允许所有 Read
    "Edit",              // 允许所有 Edit
    "Bash(git:*)",       // 允许所有 git 子命令
    "Bash(npm install:*)" // 允许 npm install
  ],
  "deny": [
    "Bash(rm -rf:*)"     // 禁止 rm -rf
  ],
  "ask": [
    "Bash(npm publish:*)" // publish 需确认
  ]
}
```

详见 [权限](./permissions.md)。

## 环境变量

### Provider 选择

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic 直连 API Key |
| `CLAUDE_CODE_USE_BEDROCK` | `1` 启用 AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | `1` 启用 Google Vertex |
| `CLAUDE_CODE_USE_FOUNDRY` | `1` 启用 Azure Foundry |
| `AWS_REGION` | Bedrock 区域 |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Bedrock 凭据（或用标准 AWS 凭据链） |
| `CLOUD_ML_REGION` | Vertex 区域 |
| `ANTHROPIC_VERTEX_PROJECT_ID` | Vertex 项目 ID |
| `ANTHROPIC_BASE_URL` | 自定义 API base URL（第三方 provider） |

### 运行时

| 变量 | 说明 |
|------|------|
| `CLAUDE_CODE_SIMPLE` | `--bare` 模式设置，简化启动 |
| `MAX_THINKING_TOKENS` | 限制思考 token 预算（bash: `export MAX_THINKING_TOKENS=10000`） |
| `DISABLE_TELEMETRY` | 禁用遥测（OCC 中遥测本就是空实现，但可显式设置） |

### Provider 选择逻辑

OCC 在 `src/utils/model/providers.ts` 中选择 provider：

1. 若 `CLAUDE_CODE_USE_BEDROCK=1` → AWS Bedrock（用 `@anthropic-ai/bedrock-sdk` + AWS 凭据链）。
2. 若 `CLAUDE_CODE_USE_VERTEX=1` → Google Vertex（用 `@anthropic-ai/vertex-sdk` + gcloud 凭据）。
3. 若 `CLAUDE_CODE_USE_FOUNDRY=1` → Azure Foundry（用 `@anthropic-ai/foundry-sdk` + `@azure/identity`）。
4. 若 `ANTHROPIC_BASE_URL` 设置 → 第三方 provider（自定义端点）。
5. 否则 → Anthropic 直连（`ANTHROPIC_API_KEY` 或 OAuth）。

## 多 Provider 配置示例

### Anthropic 直连 + OAuth

```bash
# 第一次登录
occ
> /login   # 完成 OAuth

# 或用 API key
export ANTHROPIC_API_KEY="sk-ant-..."
occ
```

### AWS Bedrock

```jsonc
// ~/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "AWS_REGION": "us-east-1"
  }
}
```

```bash
# 或环境变量
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=us-east-1
occ
```

AWS 凭据通过标准凭据链解析：环境变量 → `~/.aws/credentials` → IAM role。也可用 `/setup-bedrock` 交互式配置。

### Google Vertex

```jsonc
{
  "env": {
    "CLAUDE_CODE_USE_VERTEX": "1",
    "CLOUD_ML_REGION": "us-east5",
    "ANTHROPIC_VERTEX_PROJECT_ID": "your-project-id"
  }
}
```

凭据通过 gcloud 标准链解析。也可用 `/setup-vertex`。

### Azure Foundry

```bash
export CLAUDE_CODE_USE_FOUNDRY=1
occ
```

Azure 凭据通过 `@azure/identity` 解析（DefaultAzureCredential 链）。

### 第三方 / 自托管端点

```bash
export ANTHROPIC_BASE_URL="https://my-proxy.example.com"
export ANTHROPIC_API_KEY="my-key"
occ
```

## 命令行覆盖

任何 settings.json 键都可用命令行参数覆盖：

```bash
occ --model opus --effort max          # 覆盖 model/effort
occ --verbose                          # 覆盖 verbose
occ --permission-mode acceptEdits      # 覆盖权限模式
occ --allowed-tools "Bash Read"        # 限制工具
```

完整 CLI 参数见 [CLI 参考](./cli-reference.md)。

## /config 命令

REPL 内用 `/config` 打开交互式配置界面，可直接编辑设置：

```bash
> /config
```

也可用 `/theme`、`/color`、`/effort`、`/model` 等针对性命令快速切换单项设置。

## 与 Claude Code 的差异

OCC 的配置系统与 Claude Code 对齐。差异：

- OCC 不接入 Statsig / GrowthBook（feature gating 完全由 `src/utils/featureFlags.ts` 的静态白名单决定，无远程下发）。
- OCC 的 Analytics / Sentry 为空实现，配置中的遥测相关键无实际效果。
- `includeCoAuthoredBy`：OCC 默认在提交信息附加 `Co-Authored-By`（除非设 `false`）。

## 下一步

- [CLI 参考](./cli-reference.md) —— 命令行参数全表。
- [权限](./permissions.md) —— 权限规则详解。
- [Hooks](./hooks.md) —— 在 settings.json 中配置 hooks。
