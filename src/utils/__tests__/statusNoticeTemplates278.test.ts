// Gap-133b (OCC-133) — status notice render alignment to official Claude Code
// 2.1.278, from the FULLY decompiled notice chunk (linux-x64 ELF @217714393+
// for the shared line component `Jm`, @217735634+ for the definitions
// `n9t`/`a9t`/`r9t`/`i9t`/`s9t`, @194659982 for the token-action switch
// `Sne`, @206523300 chunk-5t00n66n.js for the status style map `yIt` + icon
// `_t`, @217750300+ for the container).
//
// Official 2.1.278 render structures (decompiled, verbatim shapes):
//
//   Jm (shared notice line):
//     <Box flexDirection="row">
//       <Box width={2} flexShrink={0}><StatusIcon status={status}/></Box>
//       <Box flexGrow={1} flexShrink={1}>
//         <Text color={STATUS[status].color} dimColor={!color}>{children}</Text>
//       </Box>
//     </Box>
//
//   both-auth-methods (s9t):
//     <Box flexDirection="column" marginTop={1}>
//       <Jm status="warning">Both {token} and {key} set · auth may not work
//         as expected</Jm>
//       <Box flexDirection="column" paddingLeft={2}>
//         <Text dimColor>· to use {tokenName}: {keyAction}</Text>
//         <Text dimColor>· to use {key}: {Sne(tokenSource)}</Text>
//       </Box>
//     </Box>
//
//   claude-ai-external-token (r9t):
//     <Box marginTop={1}><Jm status="warning">{source} overriding Claude
//       subscription login<Text dimColor> · unset it or /logout to sign it
//       out</Text></Jm></Box>
//
//   api-key-conflict (i9t):
//     <Box marginTop={1}><Jm status="warning">{source} overriding saved
//       Console key<Text dimColor> · unset it or /logout to clear the saved
//       key</Text></Jm></Box>
//
//   large-agent-descriptions (a9t):
//     <Jm status="warning">Agent descriptions are over the {15,000}-token
//       limit (~{N} tokens)<Text dimColor> · ask Claude to trim agent
//       descriptions in .claude/agents/</Text></Jm>
//
// Live side-by-side evidence (tmux, seeded HOME with BOTH
// ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set, official 2.1.278 ELF vs
// OCC dist, same project dir):
//
//   OFFICIAL 2.1.278:
//     ⚠ Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set · auth may not work as expected
//       · to use ANTHROPIC_AUTH_TOKEN: Unset the ANTHROPIC_API_KEY environment variable, or claude /logout then say "No" to the API key approval before login.
//       · to use ANTHROPIC_API_KEY: Unset the ANTHROPIC_AUTH_TOKEN environment variable.
//
//   OCC (pre-fix, v2.1.345/v2.1.346):
//     ⚠Auth conflict: Both a token (ANTHROPIC_AUTH_TOKEN) and an API key (ANTHROPIC_API_KEY) are set. This may lead to unexpected behavior.
//         · Trying to use ANTHROPIC_AUTH_TOKEN? Unset the ANTHROPIC_API_KEY environment variable, or occ /logout ...
//         · Trying to use ANTHROPIC_API_KEY? Unset the ANTHROPIC_AUTH_TOKEN environment variable.
//
// ZERO binary hits for OCC's stale framing: `Auth conflict`, `Trying to
// use`, `This may lead to unexpected behavior`.
//
// Sne (token-source → action switch, @194659982) ported minus the `profile`
// case: OCC's getAuthTokenSource union has no 'profile' member (ant-internal
// `ant auth logout` surface), so that arm is unreachable here — documented,
// not invented.
//
// Container (StatusNotices.tsx): official warnings path renders
// `<Box flexDirection="column">` with NO paddingLeft (paddingLeft:1/2 exist
// only in the announcement-slot and ant-notices branches, @217750300+) —
// OCC's t4=1 paddingLeft was a divergence, fixed to 0.
//
// The official notice registry (L9t, 31 entries + tier/announcement-slot
// governance) is a larger trimmed surface in OCC (6 notices); the remaining
// entries are backend/ant/environment-dependent — ledger item, not ported.

import { afterAll, expect, test } from 'bun:test'
import type * as React from 'react'
import { statusNoticeDefinitions } from '../statusNoticeDefinitions.js'

const PREV_ENV: Record<string, string | undefined> = {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
}

afterAll(() => {
  for (const [k, v] of Object.entries(PREV_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/** Collects every string child in the element tree, in document order. */
function collectText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  const el = node as React.ReactElement<{ children?: React.ReactNode }>
  return collectText(el.props?.children)
}

type El = React.ReactElement<Record<string, unknown>>

/**
 * Every element in the tree, document order. Function components (e.g. the
 * NoticeLine `Jm` port) are expanded by invoking them directly — safe for
 * hook-free components; hook-using ones throw outside a renderer and are
 * skipped (their props stay inspectable on the element itself).
 */
function collectElements(node: React.ReactNode): El[] {
  if (node === null || node === undefined || typeof node !== 'object')
    return []
  if (Array.isArray(node)) return node.flatMap(collectElements)
  const el = node as El
  let rendered: React.ReactNode = []
  if (typeof el.type === 'function') {
    try {
      rendered = (el.type as (p: Record<string, unknown>) => React.ReactNode)(
        el.props ?? {},
      )
    } catch {
      rendered = []
    }
  }
  return [
    el,
    ...collectElements(el.props?.children),
    ...collectElements(rendered),
  ]
}

/** True if some element in the tree carries all of `props`. */
function hasElementWithProps(
  node: React.ReactNode,
  props: Record<string, unknown>,
): boolean {
  return collectElements(node).some(el =>
    Object.entries(props).every(([k, v]) => el.props?.[k] === v),
  )
}

/** Leaf elements (string-only children) whose text contains `needle`. */
function leafTextElements(
  node: React.ReactNode,
  needle: string,
): El[] {
  return collectElements(node).filter(el => {
    const children = el.props?.children
    const hasElementChild = collectElements(children).length > 0
    return !hasElementChild && collectText(children).includes(needle)
  })
}

function renderNotice(
  id: string,
  ctx: Partial<Parameters<NonNullable<(typeof statusNoticeDefinitions)[0]>['render']>[0]> = {},
): React.ReactNode {
  const notice = statusNoticeDefinitions.find(n => n.id === id)
  expect(notice).toBeDefined()
  return notice!.render({ config: {} as never, memoryFiles: [], ...ctx } as never)
}

function renderBothAuthNotice(): React.ReactNode {
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-auth-token-gap133b'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy'
  const notice = statusNoticeDefinitions.find(
    n => n.id === 'both-auth-methods',
  )
  expect(notice).toBeDefined()
  const ctx = { config: {} as never, memoryFiles: [] }
  expect(notice!.isActive(ctx)).toBe(true)
  return notice!.render(ctx)
}

// ---------------------------------------------------------------------------
// both-auth-methods (official s9t)
// ---------------------------------------------------------------------------

test('both-auth main line uses the official 2.1.278 template: Both <token> and <key> set · auth may not work as expected', () => {
  const text = collectText(renderBothAuthNotice())
  expect(text).toContain(
    'Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set',
  )
  expect(text).toContain('auth may not work as expected')
})

test('both-auth stale pre-2.1.278 framing is gone (zero official-binary hits for these)', () => {
  const text = collectText(renderBothAuthNotice())
  expect(text).not.toContain('Auth conflict')
  expect(text).not.toContain('Trying to use')
  expect(text).not.toContain('This may lead to unexpected behavior')
})

test('both-auth bullets use the official "· to use <name>: <action>" template with byte-identical action tails', () => {
  const text = collectText(renderBothAuthNotice())
  expect(text).toContain(
    '· to use ANTHROPIC_AUTH_TOKEN: Unset the ANTHROPIC_API_KEY environment variable, or occ /logout then say "No" to the API key approval before login.',
  )
  expect(text).toContain(
    '· to use ANTHROPIC_API_KEY: Unset the ANTHROPIC_AUTH_TOKEN environment variable.',
  )
})

test('both-auth bullet column uses the official paddingLeft=2 box (s9t: flexDirection column, paddingLeft 2 — NOT marginLeft)', () => {
  const tree = renderBothAuthNotice()
  expect(
    hasElementWithProps(tree, { flexDirection: 'column', paddingLeft: 2 }),
  ).toBe(true)
})

test('both-auth bullets are dimColor text (official s9t: dimColor:!0 — not warning-colored)', () => {
  const tree = renderBothAuthNotice()
  const bullets = leafTextElements(tree, '· to use')
  expect(bullets.length).toBeGreaterThanOrEqual(2)
  for (const bullet of bullets) {
    expect(bullet.props?.dimColor).toBe(true)
  }
})

test('both-auth header line uses the official Jm notice-line structure (width=2 flexShrink=0 icon cell + flexGrow text cell)', () => {
  const tree = renderBothAuthNotice()
  expect(hasElementWithProps(tree, { width: 2, flexShrink: 0 })).toBe(true)
  expect(hasElementWithProps(tree, { flexGrow: 1, flexShrink: 1 })).toBe(true)
})

// ---------------------------------------------------------------------------
// claude-ai-external-token (official r9t)
// ---------------------------------------------------------------------------

test('claude-ai-external-token uses the official template: <source> overriding Claude subscription login · unset it or /logout to sign it out', () => {
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-auth-token-gap133b'
  const text = collectText(renderNotice('claude-ai-external-token'))
  expect(text).toContain(
    'ANTHROPIC_AUTH_TOKEN overriding Claude subscription login',
  )
  expect(text).toContain(' · unset it or /logout to sign it out')
  expect(text).not.toContain('Auth conflict')
})

// ---------------------------------------------------------------------------
// api-key-conflict (official i9t)
// ---------------------------------------------------------------------------

test('api-key-conflict uses the official template: <source> overriding saved Console key · unset it or /logout to clear the saved key', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy'
  const text = collectText(renderNotice('api-key-conflict'))
  expect(text).toContain('ANTHROPIC_API_KEY overriding saved Console key')
  expect(text).toContain(' · unset it or /logout to clear the saved key')
  expect(text).not.toContain('Auth conflict')
})

// ---------------------------------------------------------------------------
// large-agent-descriptions (official a9t, threshold bSe=15000)
// ---------------------------------------------------------------------------

test('large-agent-descriptions uses the official template: Agent descriptions are over the <formatNumber(15000)>-token limit (~N tokens) · ask Claude to trim agent descriptions in .claude/agents/', () => {
  const text = collectText(
    renderNotice('large-agent-descriptions', {
      agentDefinitions: {
        activeAgents: [
          {
            source: 'user',
            agentType: 'test-agent',
            whenToUse: 'does test things',
          },
        ],
      } as never,
    }),
  )
  expect(text).toContain('Agent descriptions are over the')
  // Official a9t uses ws(bSe) — the shared formatNumber — same compact
  // rendering as OCC's formatNumber(15000) = "15.0k".
  expect(text).toContain('15.0k-token limit (~')
  expect(text).toContain(' tokens)')
  expect(text).toContain(' · ask Claude to trim agent descriptions in .claude/agents/')
  expect(text).not.toContain('/agents to manage')
})
