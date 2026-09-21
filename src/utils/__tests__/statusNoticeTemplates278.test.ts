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
import { getMemoryCharThreshold, type MemoryFileInfo } from '../claudemd.js'
import { getContextWindowForModel } from '../context.js'
import { formatNumber } from '../format.js'
import { getMainLoopModel } from '../model/model.js'
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

// ---------------------------------------------------------------------------
// large-memory-files (official n9t, threshold = getMemoryCharThreshold(
// getContextWindowForModel(getMainLoopModel())))
// ---------------------------------------------------------------------------

const N9T_PATH = '/outside-cwd-gap133n9t/CLAUDE.md'

/**
 * Renders the large-memory-files notice with one seeded file whose content
 * length sits `delta` chars over the LIVE threshold (same computation the
 * notice itself performs). The path is outside getCwd() so displayPath stays
 * the absolute path (n9t: `file.path.startsWith(getCwd()) ? relative(…) :
 * file.path` — no relativization branch here, deterministic across machines).
 */
function renderLargeMemoryNotice(delta = 5): {
  tree: React.ReactNode
  threshold: number
  file: MemoryFileInfo
} {
  const threshold = getMemoryCharThreshold(
    getContextWindowForModel(getMainLoopModel()),
  )
  const file: MemoryFileInfo = {
    path: N9T_PATH,
    type: 'Project',
    content: 'x'.repeat(threshold + delta),
  }
  const notice = statusNoticeDefinitions.find(
    n => n.id === 'large-memory-files',
  )
  expect(notice).toBeDefined()
  const ctx = { config: {} as never, memoryFiles: [file] }
  expect(notice!.isActive(ctx)).toBe(true)
  return { tree: notice!.render(ctx as never), threshold, file }
}

test('large-memory-files renders the official 2.1.278 n9t template byte-for-byte: <path> is over the <T>-char limit (<N> chars) · /memory to free up context', () => {
  const { tree, threshold, file } = renderLargeMemoryNotice()
  // Exact whole-line equality (not toContain): collectText walks the NoticeLine
  // children only — the icon lives inside NoticeLine's own render, so the
  // concatenated text is precisely the official template
  //   {displayPath} is over the {ws(threshold)}-char limit ({ws(len)} chars)
  //   · /memory to free up context
  // with the JSX-collapsed single spaces shown here.
  expect(collectText(tree)).toBe(
    `${file.path} is over the ${formatNumber(threshold)}-char limit (${formatNumber(file.content.length)} chars) · /memory to free up context`,
  )
})

test('large-memory-files uses the official Jm NoticeLine structure (width=2 flexShrink=0 icon cell + flexGrow text cell + warning status) with bold path and dimColor tail', () => {
  const { tree } = renderLargeMemoryNotice()
  expect(hasElementWithProps(tree, { width: 2, flexShrink: 0 })).toBe(true)
  expect(hasElementWithProps(tree, { flexGrow: 1, flexShrink: 1 })).toBe(true)
  expect(hasElementWithProps(tree, { status: 'warning' })).toBe(true)
  // n9t: <Text bold>{displayPath}</Text>
  const pathLeaves = leafTextElements(tree, N9T_PATH)
  expect(pathLeaves.length).toBeGreaterThanOrEqual(1)
  expect(pathLeaves.some(el => el.props?.bold === true)).toBe(true)
  // n9t: <Text dimColor> · /memory to free up context</Text>
  // Dedupe by identity: collectElements walks NoticeLine's children twice —
  // once on the element itself and once through the expanded render output —
  // so the same Text element instance is visited from both paths.
  const tails = [...new Set(leafTextElements(tree, '/memory to free up context'))]
  expect(tails.length).toBe(1)
  expect(tails[0]!.props?.dimColor).toBe(true)
})

test('large-memory-files stale pre-2.1.278 framing is gone ("Large … will impact performance (N chars > T) · /memory to edit" — zero official-binary hits)', () => {
  const text = collectText(renderLargeMemoryNotice().tree)
  expect(text).not.toContain('will impact performance')
  expect(text).not.toContain('Large ')
  expect(text).not.toContain('chars >')
  expect(text).not.toContain('/memory to edit')
})

test('large-memory-files stays silent at exactly the threshold (getLargeMemoryFiles filters content.length > threshold, strict)', () => {
  const threshold = getMemoryCharThreshold(
    getContextWindowForModel(getMainLoopModel()),
  )
  const notice = statusNoticeDefinitions.find(
    n => n.id === 'large-memory-files',
  )
  expect(notice).toBeDefined()
  const ctx = {
    config: {} as never,
    memoryFiles: [
      {
        path: N9T_PATH,
        type: 'Project' as const,
        content: 'x'.repeat(threshold),
      },
    ],
  }
  expect(notice!.isActive(ctx as never)).toBe(false)
  expect(collectText(notice!.render(ctx as never))).toBe('')
})
