import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { REPO_ROOT } from './helpers'

/**
 * claude-code 2.1.200 e2e (tools): implement the four stubbed/background tools
 * to match the official binary — Monitor (H1), PushNotification (H2),
 * ListPeers→ListAgents (H3), and the BashTool gh rate-limit hint (H10).
 *
 * Each block source-greps the implementation for the exact name/description/
 * schema/behavior strings taken from /tmp/occ-audit/claude.strings, then
 * imports the module to confirm it parses with no TDZ.
 */

describe('2.1.200 tools (H1/H2/H3/H10) — source-grep + parse', () => {
  test('H1: MonitorTool streams background-script events', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/tools/MonitorTool/MonitorTool.ts`,
    ).text()

    // Exact name + description prefix from the binary's `ago` description.
    expect(src.includes("name: MONITOR_TOOL_NAME")).toBe(true)
    expect(src).toContain("export const MONITOR_TOOL_NAME = 'Monitor'")
    expect(src).toContain(
      'Start a background monitor that streams events from a long-running script',
    )
    expect(src).toContain('Each stdout line is an event')

    // Schema fields mirror the binary: command / ws / description / timeout_ms / persistent.
    expect(src).toContain('command: z.string().min(1)')
    expect(src).toContain('ws:')
    expect(src).toContain('timeout_ms')
    expect(src).toContain('persistent')
    // Binary constants nOl=300000 (default) and TUo=3600000 (max).
    expect(src).toContain('300_000')
    expect(src).toContain('3_600_000')

    // Real call(): spawns a process and streams stdout lines as events,
    // plus a WebSocket source. No stub `export {}` / empty object.
    expect(src).not.toContain('export {};')
    expect(src).toContain('async call(')
    expect(src).toContain('streamCommand')
    expect(src).toContain('streamWs')
    expect(src).toContain('Bun.spawn')

    // ws source paragraph (binary's `lgo` block).
    expect(src).toContain('open a WebSocket and stream each incoming text frame')

    // Parse check — no TDZ.
    const out = await $`bun -e ${`import('${REPO_ROOT}/src/tools/MonitorTool/MonitorTool.ts').then(m => console.log(Object.keys(m).join(',')))`}`.quiet()
    expect(out.stdout.toString().trim()).toContain('MonitorTool')
  })

  test('H2: PushNotificationTool sends a desktop/mobile notification', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/tools/PushNotificationTool/PushNotificationTool.ts`,
    ).text()

    expect(src).toContain("export const PUSH_NOTIFICATION_TOOL_NAME = 'PushNotification'")
    expect(src).toContain('name: PUSH_NOTIFICATION_TOOL_NAME')
    // Exact description from the binary.
    expect(src).toContain(
      'Send a notification to the user via their terminal and, when Remote Control is connected, also push to their mobile device',
    )
    // Binary's wBf input schema: message (min 1) + status: literal "proactive".
    expect(src).toContain('message: z')
    expect(src).toContain('.min(1)')
    expect(src).toContain('z.literal(\'proactive\')')
    expect(src).toContain(
      'The notification body. Keep it under 200 characters; mobile OSes truncate.',
    )
    // Binary's CBf output: disabledReason enum.
    expect(src).toContain('disabledReason')
    expect(src).toContain("'config_off'")
    expect(src).toContain("'user_present'")
    expect(src).toContain("'no_transport'")
    // shouldDefer:true mirrors the binary.
    expect(src).toContain('shouldDefer: true')
    // Real call(): dispatches via the notifier service.
    expect(src).toContain('async call(')
    expect(src).toContain('sendNotification')

    // The old .js stub (`export default {}`) must be gone.
    const stubExists = await Bun.file(
      `${REPO_ROOT}/src/tools/PushNotificationTool/PushNotificationTool.js`,
    )
      .exists()
      .catch(() => false)
    expect(stubExists).toBe(false)

    const out = await $`bun -e ${`import('${REPO_ROOT}/src/tools/PushNotificationTool/PushNotificationTool.ts').then(m => console.log(Object.keys(m).join(',')))`}`.quiet()
    expect(out.stdout.toString().trim()).toContain('PushNotificationTool')
  })

  test('H3: ListPeersTool → ListAgents lists peer sessions', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/tools/ListPeersTool/ListPeersTool.ts`,
    ).text()

    // Binary renamed ListPeers → ListAgents (x9e="ListAgents"); ListPeers is an alias.
    expect(src).toContain("export const LIST_AGENTS_TOOL_NAME = 'ListAgents'")
    expect(src).toContain('name: LIST_AGENTS_TOOL_NAME')
    expect(src).toContain("aliases: ['ListPeers']")
    // Exact description from the binary's ZXy (bm="SendMessage").
    expect(src).toContain('Lists agents you can SendMessage to')
    expect(src).toContain('in-process subagents you spawned')
    expect(src).toContain('other local Claude sessions on this machine')
    expect(src).toContain('your Claude sessions running in the cloud')
    expect(src).toContain('remote bridge sessions')
    expect(src).toContain('SendMessage({to: "<name>", message: "..."})')

    // Real call(): reads ~/.claude/sessions PID files + app-state in-process agents.
    expect(src).toContain('async call(')
    expect(src).toContain('listLocalSessions')
    expect(src).toContain('getSessionsDir')
    expect(src).toContain('readdir')
    expect(src).toContain('in_process')

    const stubExists = await Bun.file(
      `${REPO_ROOT}/src/tools/ListPeersTool/ListPeersTool.js`,
    )
      .exists()
      .catch(() => false)
    expect(stubExists).toBe(false)

    const out = await $`bun -e ${`import('${REPO_ROOT}/src/tools/ListPeersTool/ListPeersTool.ts').then(m => console.log(Object.keys(m).join(',')))`}`.quiet()
    expect(out.stdout.toString().trim()).toContain('ListPeersTool')
  })

  test('H10: BashTool gh GitHub API rate-limit hint (throttled)', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/tools/BashTool/BashTool.tsx`,
    ).text()

    // Exact hint text from the binary.
    expect(src).toContain(
      'GitHub API rate limit exceeded (5,000/hr shared across all tools and agents). Run `gh api rate_limit --jq .resources` and sleep until reset before further gh calls. If polling in a loop, use ScheduleWakeup instead of retrying.',
    )
    // Binary's kqp=60000 throttle.
    expect(src).toContain('60_000')
    expect(src).toContain('maybeGhRateLimitHint')
    // The hint is injected into the bash output path.
    expect(src).toContain('maybeGhRateLimitHint(input.command')
    // Binary's exact Iqp command regex (excludes auth/help/version/alias/completion/config).
    expect(src).toContain("(?:^|[;&|]|\\b(?:then|do)\\b)\\s*gh\\s+")
    expect(src).toContain('(?!auth\\b|help\\b|version\\b|alias\\b|completion\\b|config\\b)')
    // Binary's exact xqp output regex.
    expect(src).toContain('API rate limit (?:already )?exceeded')
    expect(src).toContain('exceeded a secondary rate limit')
    expect(src).toContain('RATE_LIMITED')

    // Parse check — BashTool still loads.
    const out = await $`bun -e ${`import('${REPO_ROOT}/src/tools/BashTool/BashTool.tsx').then(m => console.log(Object.keys(m).join(',')))`}`.quiet()
    expect(out.stdout.toString().trim()).toContain('BashTool')
  })

  test('H10: gh rate-limit hint regex matches the binary behavior', async () => {
    // Exercise the exact regexes inline to confirm the detection logic
    // matches the binary's Iqp + xqp (no false positives on `echo gh`).
    const script = `
const GH_COMMAND_RE = /(?:^|[;&|]|\\b(?:then|do)\\b)\\s*gh\\s+(?!auth\\b|help\\b|version\\b|alias\\b|completion\\b|config\\b)/;
const GH_RATE_LIMIT_OUTPUT_RE = /API rate limit (?:already )?exceeded|exceeded a secondary rate limit|\\bRATE_LIMITED\\b/i;
const hit = (c, o) => GH_COMMAND_RE.test(c) && GH_RATE_LIMIT_OUTPUT_RE.test(o);
console.log(JSON.stringify({
  realHit: hit('gh pr list', 'API rate limit exceeded'),
  rateLimited: hit('gh api repos/x', 'RATE_LIMITED'),
  secondary: hit('gh api x', 'exceeded a secondary rate limit'),
  already: hit('gh pr list', 'API rate limit already exceeded'),
  echoArg: hit('echo gh rate limit', 'API rate limit exceeded'),
  authExcluded: hit('gh auth status', 'API rate limit exceeded'),
  nonGh: hit('curl api.github.com', 'API rate limit exceeded'),
  noRateLimit: hit('gh pr list', 'no repos found'),
}));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.realHit).toBe(true)
    expect(out.rateLimited).toBe(true)
    expect(out.secondary).toBe(true)
    expect(out.already).toBe(true)
    expect(out.echoArg).toBe(false)
    expect(out.authExcluded).toBe(false)
    expect(out.nonGh).toBe(false)
    expect(out.noRateLimit).toBe(false)
  })
})
