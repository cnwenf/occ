# Security Policy

## Supported Versions

OCC is a solo-maintainer, open-source project. Only the **latest release** (`@cnwenf/occ` on npm; `main` branch on GitHub) receives security updates. Older versions are not patched — please update to the latest before reporting.

## Reporting a Vulnerability

If you discover a security vulnerability in OCC, **please do not open a public issue**. Report it privately instead:

- **Preferred — GitHub private vulnerability reporting:** go to the **Security** tab → **Advisories** → **Report a vulnerability**, or open <https://github.com/cnwenf/occ/security/advisories/new>.
- Alternatively, email the maintainer (address on the GitHub profile).

Please include:
- A description of the issue and its impact
- Steps to reproduce (a proof of concept if possible)
- The affected version (`occ --version`)

## Response Expectations

This is a best-effort, single-maintainer project. I aim to acknowledge reports within **72 hours** and to provide a fix or mitigation for confirmed issues as soon as practicable. There is no guaranteed SLA. I will coordinate disclosure timing with you and credit you in the release notes if you wish.

## Scope

**In scope:**
- The OCC codebase in this repository: `src/`, `packages/`, the build pipeline, and the GitHub Actions workflows.

**Out of scope:**
- **Model / API endpoints.** OCC calls whichever endpoint you configure (Anthropic, AWS Bedrock, Google Vertex, Azure Foundry, or a custom proxy). Their security is governed by the respective provider.
- **MCP servers** you connect via `--mcp-config` / `.mcp.json`. These are third-party processes you choose to run; review and trust them yourself.
- **Third-party npm dependencies.** Report vulnerabilities upstream; we pin and install them with `--frozen-lockfile` and track them via `bun audit` / Dependabot.

## How OCC Handles Trust

OCC is a coding agent that runs tools — shell commands, file edits, web fetches, sub-agents — on your machine.

- **It asks for your permission** before destructive or external actions. You can speed things up with `--permission-mode`, but `--dangerously-skip-permissions` is **not recommended** — review every prompt.
- **Your credentials stay local.** `ANTHROPIC_API_KEY`, Bedrock / Vertex / Azure credentials live on your machine and are sent only to the endpoints you configure. OCC has **no telemetry, no hidden reporting, no third-party analytics**.
- **Reproducible builds.** The npm tarball is built from this source on GitHub Actions. You can rebuild `dist/cli.js` from source (`bun install && bun run build`) and compare.

## Hardening Tips

- Run OCC in a sandbox / container for untrusted tasks.
- Use `--disallowedTools` to deny tools you don't want (e.g. `Bash`, `WebFetch`) for a given run.
- Pin a specific version in CI: `npm i -g @cnwenf/occ@<version>`.
- Review `.mcp.json` and `CLAUDE.md` before trusting a project's instructions.
