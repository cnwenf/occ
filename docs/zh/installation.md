# 安装

OCC 基于 Bun 运行时构建（不是 Node.js）。本章介绍三种安装方式与环境要求。

## 环境要求

| 项目 | 要求 |
|------|------|
| 运行时 | Bun >= 1.3.11（仅从源码构建时需要；npm 安装版自带 bundle） |
| API 凭据 | 有效的 Anthropic API Key，或 AWS Bedrock / Google Vertex / Azure Foundry 凭据 |
| 操作系统 | macOS、Linux、WSL（Windows 原生支持有限，PowerShell 工具可用） |
| 终端 | 支持 ANSI 的现代终端（iTerm2、Windows Terminal、Alacritty 等） |

## 方式一：npm 全局安装（推荐）

```bash
npm i -g @cnwenf/occ
occ
```

安装后即可使用 `occ` 命令。此方式不需要本地装 Bun —— npm 包里是已构建好的单文件 bundle（`dist/cli.js`，约 27MB）。

验证安装：

```bash
occ --version
# 输出: 2.1.204（或类似）
```

## 方式二：从源码构建

适合需要审查源码、自定义构建、或跟踪最新开发进度的情况。

### 1. 安装 Bun

OCC 需要 Bun >= 1.3.11。旧版 Bun 会产生误报错误。

```bash
# 官方安装脚本
curl -fsSL https://bun.sh/install | bash

# 或通过 npm
npm install -g bun

# 已安装则升级
bun upgrade
```

验证：

```bash
bun --version
# 应 >= 1.3.11
```

### 2. 克隆并安装依赖

```bash
git clone <你的 OCC 仓库地址>
cd occ
bun install
```

`bun install` 会解析 Bun workspaces（`packages/*`、`packages/@ant/*`）。

### 3. 开发模式运行（直接执行源码）

```bash
bun run dev
# 等价于: bun run src/entrypoints/cli.tsx
```

工作正常时版本号打印为 `2.1.204`。

### 4. 构建产物

```bash
bun run build
# 输出: dist/cli.js（约 27MB，5300+ 模块，单文件 bundle）
# 构建脚本: scripts/build.ts
# 目标: bun run build src/entrypoints/cli.tsx --outdir dist --target bun
```

构建后可直接运行：

```bash
bun dist/cli.js
# 或
node dist/cli.js   # 不推荐，Bun API 在 Node 下不可用
```

## 方式三：npx 临时运行

不想全局安装时：

```bash
npx @cnwenf/occ
```

## 配置 API 凭据

安装后需要配置 API 凭据。OCC 支持多种 Provider，详见 [配置](./settings.md) 与 [CLI 参考](./cli-reference.md)。

### Anthropic 直连

```bash
# 环境变量
export ANTHROPIC_API_KEY="sk-ant-..."
occ
```

或在首次启动时通过 `/login` 命令完成 OAuth 登录（Anthropic 账户）。

### AWS Bedrock

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION="us-east-1"
# 使用标准 AWS 凭据链（环境变量、~/.aws/credentials、IAM role）
occ
```

也可用 `/setup-bedrock` 命令交互式配置。

### Google Vertex

```bash
export CLAUDE_CODE_USE_VERTEX=1
export CLOUD_ML_REGION="us-east5"
export ANTHROPIC_VERTEX_PROJECT_ID="your-project-id"
# 使用标准 gcloud 凭据
occ
```

也可用 `/setup-vertex` 命令交互式配置。

### Azure Foundry

```bash
export CLAUDE_CODE_USE_FOUNDRY=1
# Azure 凭据通过 @azure/identity 解析
occ
```

## 验证安装

```bash
# 打印版本
occ --version

# 管道模式冒烟测试
echo "say hello" | occ -p

# 交互式 REPL
occ
```

如果 `occ -p` 能正常返回响应，说明 API 凭据与运行时都配置正确。

## 开发命令

从源码工作时的常用命令：

```bash
bun run dev          # 开发模式运行
bun run build        # 构建 dist/cli.js
bun test             # 运行测试（Bun test runner，config 在 bunfig.toml）
bun test test/e2e    # 运行某个目录
bun test path/to/file.test.ts   # 运行单个文件
bun run lint         # Biome lint（格式化器已禁用以避免大 diff）
bun run lint:fix     # 自动修复 lint
bun run check:unused # knip 检测未使用的导出/依赖
bun run health       # 代码健康检查（scripts/health-check.ts）
```

## 关于类型错误

OCC 代码库有约 1300 个 `tsc` 类型错误（多为 `unknown`/`never`/`{}` 类型），这些**不影响 Bun 运行时执行**。`tsconfig.json` 设为 `strict: false` + `skipLibCheck: true`，`tsc` 不在 CI 中。质量门槛是 Biome lint。

如果你在 IDE 中看到大量红色波浪线，这是预期现象，不是你的配置问题。

## 下一步

- [快速开始](./quickstart.md) —— 首次使用。
- [CLI 参考](./cli-reference.md) —— 所有命令行参数。
- [配置](./settings.md) —— settings.json 与环境变量。
