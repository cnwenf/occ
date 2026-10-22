// OCC-126 (CC 2.1.305/306) — startup securityWarnings rendered through the
// banner-notice registry (official `security-warnings` entry), NOT seeded
// into the REPL messages list.
//
// Official v306 binary (byte-verified, /tmp/ccbin strings dump):
//   X_={id:"security-warnings",tier:"warning",type:"warning",
//       isActive:(m)=>m.securityWarnings.length>0,
//       render:(m)=>e(Q,{children:m.securityWarnings.map((h)=>
//         e(Nc,{status:"warning",children:h},h))})}
//   k0=[A_(safe-mode),...D_,P_(large-memory-files),L_,F_(large-agent-
//       descriptions),U_(claude-ai-external-token),B_(api-key-conflict),
//       H_(both-auth-methods),f0,g0,p0,V_,G_,$_ ,K_,q_,Y_(unusable-managed-
//       mcp),X_(security-warnings),W_,j_,Z_,Q_(hipaa),n0,r0,i0,l0,h0,c0,...]
//   im(m){return k0.filter((h)=>h.isActive(m))}
//   → warnings bucket rendered as JSX under the logo:
//     qe.warnings.map(Et=><Fragment key={Et.id}>{Et.render(ut)}</Fragment>)
// `Nc` is the same shared notice-line component OCC ported as `NoticeLine`
// (official 2.1.278 `Jm` — verified: the v306 large-memory-files entry
// renders through `Nc` too); `Q` is the fragment/column wrapper; the map key
// is the warning text itself (`,h)` key argument).
//
// Consequence of the official mechanism (the OCC-126 defect): banner rows are
// transient JSX — they are NEVER messages, so they never reach
// recordTranscript, and a resumed session re-renders them from CURRENT state
// (no stale/duplicate rows). OCC previously seeded them as
// createSystemMessage(w, 'warning') rows into the messages initializer, which
// persisted them into the transcript and double-rendered/staled on /resume.

import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import * as React from 'react'
import { createSystemMessage } from '../messages.js'
import {
  getActiveNotices,
  statusNoticeDefinitions,
  type StatusNoticeContext,
} from '../statusNoticeDefinitions.js'

// MACRO polyfill (the notice-definitions import graph may read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const ROW_A = 'Deny rule Glob(path:src/**) never matches · use Read(…)'
const ROW_B = 'Ask rule Foo(bar) matches no tool · check for typos'

function makeContext(
  overrides: Partial<StatusNoticeContext> = {},
): StatusNoticeContext {
  return {
    config: {} as never,
    memoryFiles: [],
    securityWarnings: [],
    ...overrides,
  } as StatusNoticeContext
}

function findNotice(id: string) {
  const notice = statusNoticeDefinitions.find(n => n.id === id)
  expect(notice).toBeDefined()
  return notice!
}

/** Collects every string child in the element tree, in document order. */
function collectText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('|')
  const el = node as React.ReactElement<{ children?: React.ReactNode }>
  return collectText(el.props?.children)
}

type El = React.ReactElement<Record<string, unknown>>

function collectElements(node: React.ReactNode): El[] {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(collectElements)
  const el = node as El
  return [el, ...collectElements(el.props?.children)]
}

describe('OCC-126 banner-registry entry (official X_)', () => {
  test('registry ships the official security-warnings entry with type warning', () => {
    const notice = findNotice('security-warnings')
    expect(notice.id).toBe('security-warnings')
    expect(notice.type).toBe('warning')
  })

  test('isActive mirrors the official gate m.securityWarnings.length > 0', () => {
    const notice = findNotice('security-warnings')
    expect(notice.isActive(makeContext({ securityWarnings: [] }))).toBe(false)
    expect(notice.isActive(makeContext({ securityWarnings: [ROW_A] }))).toBe(
      true,
    )
    expect(
      notice.isActive(makeContext({ securityWarnings: [ROW_A, ROW_B] })),
    ).toBe(true)
    // Defensive: a context built by an older caller without the field must
    // not crash the whole registry filter pass.
    expect(
      notice.isActive({ config: {}, memoryFiles: [] } as StatusNoticeContext),
    ).toBe(false)
  })

  test('getActiveNotices includes security-warnings only when rows exist', () => {
    const withRows = getActiveNotices(makeContext({ securityWarnings: [ROW_A] }))
    expect(withRows.some(n => n.id === 'security-warnings')).toBe(true)
    const withoutRows = getActiveNotices(makeContext())
    expect(withoutRows.some(n => n.id === 'security-warnings')).toBe(false)
  })

  test('render emits one status:"warning" notice line per row, keyed by the row text (official e(Nc,…,h))', () => {
    const notice = findNotice('security-warnings')
    const tree = notice.render(
      makeContext({ securityWarnings: [ROW_A, ROW_B] }),
    )
    const elements = collectElements(tree)
    // Each row renders through the shared NoticeLine (status prop) wrapper.
    const statusLines = elements.filter(el => el.props?.status === 'warning')
    expect(statusLines.length).toBe(2)
    const texts = statusLines.map(el => collectText(el.props?.children))
    expect(texts[0]).toContain(ROW_A)
    expect(texts[1]).toContain(ROW_B)
    // Official key = the warning text itself.
    const keys = statusLines.map(el => String(el.key))
    expect(keys).toEqual([ROW_A, ROW_B])
  })

  test('registry position matches official k0: after both-auth-methods, before jetbrains-plugin-install', () => {
    const ids = statusNoticeDefinitions.map(n => n.id)
    const secIdx = ids.indexOf('security-warnings')
    const bothAuthIdx = ids.indexOf('both-auth-methods')
    const jetbrainsIdx = ids.indexOf('jetbrains-plugin-install')
    expect(secIdx).toBeGreaterThan(bothAuthIdx)
    expect(jetbrainsIdx).toBeGreaterThan(secIdx)
  })
})

describe('OCC-126 legacy transcript strip (v2.1.397/398 seeded rows)', () => {
  // Versions 2.1.397/2.1.398 seeded the banner rows as
  // createSystemMessage(row, 'warning') messages, which recordTranscript
  // persisted. Sessions recorded by those versions must not resurface the
  // stale rows on /resume (the rows reflect the rules AT RECORD TIME — after
  // a rule fix they are wrong, and alongside the re-rendered banner they
  // double up). The resume choke point (deserializeMessages) therefore drops
  // system/informational/level-warning rows whose content matches the
  // security-row templates (`${capitalize(behavior)} rule …`).
  let deserializeMessages: typeof import('../conversationRecovery.js')['deserializeMessages']

  const userRow = {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content: 'hello' },
  }

  test('seeded legacy security rows are dropped on resume load', async () => {
    ;({ deserializeMessages } = await import('../conversationRecovery.js'))
    const legacy = [
      createSystemMessage(ROW_A, 'warning'),
      createSystemMessage(ROW_B, 'warning'),
      userRow,
    ] as never[]
    const messages = deserializeMessages(legacy)
    expect(
      messages.filter(
        m =>
          m.type === 'system' &&
          (m as { subtype?: string }).subtype === 'informational' &&
          (m as { content?: string }).content?.startsWith('Deny rule '),
      ).length,
    ).toBe(0)
    expect(messages.some(m => m.type === 'user')).toBe(true)
  })

  test('other informational warning rows survive (no over-strip)', async () => {
    ;({ deserializeMessages } = await import('../conversationRecovery.js'))
    const keep = createSystemMessage(
      'Session resumed without branch: some error',
      'warning',
    )
    const messages = deserializeMessages([keep, userRow] as never[])
    expect(
      messages.some(
        m =>
          m.type === 'system' &&
          (m as { content?: string }).content ===
            'Session resumed without branch: some error',
      ),
    ).toBe(true)
  })

  test('OCC-128 P3: legitimate warnings that merely START with the legacy prefix survive (predicate is full-template, not prefix-wide)', async () => {
    ;({ deserializeMessages } = await import('../conversationRecovery.js'))
    // The old `/^(Allow|Deny|Ask) rule /` prefix guard silently dropped any
    // future warning-level system message beginning with "Deny rule " —
    // e.g. a hypothetical enforcement notice. Only the exact v2.1.397/398
    // seeded-row TEMPLATE SHAPES ("… never matches[ · use X(…)]" /
    // "… matches no tool · check for typos") may be stripped.
    const legitimate = createSystemMessage(
      'Deny rule X will be enforced from next run',
      'warning',
    )
    const messages = deserializeMessages([legitimate, userRow] as never[])
    expect(
      messages.some(
        m =>
          m.type === 'system' &&
          (m as { content?: string }).content ===
            'Deny rule X will be enforced from next run',
      ),
    ).toBe(true)
  })

  test('OCC-128 P3: both full legacy template shapes are still stripped after the predicate tightening', async () => {
    ;({ deserializeMessages } = await import('../conversationRecovery.js'))
    const shapes = [
      'Allow rule Bash(command:*) never matches', // Grep-style S-row: no " · use" tail
      'Deny rule Glob(path:src/**) never matches · use Read(…)', // Glob S-row
      'Ask rule Write(file_path:/x) never matches · use Edit(…)', // Write/NotebookEdit S-row
      'Allow rule Foo(bar) matches no tool · check for typos', // unknown-tool S-row
    ]
    const legacy = [
      ...shapes.map(shape => createSystemMessage(shape, 'warning')),
      userRow,
    ] as never[]
    const messages = deserializeMessages(legacy)
    for (const shape of shapes) {
      expect(
        messages.some(
          m => m.type === 'system' && (m as { content?: string }).content === shape,
        ),
      ).toBe(false)
    }
    expect(messages.some(m => m.type === 'user')).toBe(true)
  })

  test('OCC-128 P2 (review round 2): validator-loop (Loop-2) legacy rows are stripped too — the seeded channel merged BOTH producer families', async () => {
    ;({ deserializeMessages } = await import('../conversationRecovery.js'))
    // v2.1.397/398 seeded the whole `securityWarnings` array, which
    // permissionSetup composes from collectPermissionRuleSecurityWarnings
    // (first loop) AND collectPermissionRuleSecurityNotices (validator
    // loop). The validator rows embed real rule content in the use-tail
    // (`… · use Edit(src/**)`) or carry notice-only tails (`allows any
    // option at its * …`), so a first-loop-only predicate lets them
    // resurface on resume — the exact OCC-126 symptom. Shapes below are the
    // real rows pinned by securityWarnings305.test.ts (:232/:241/:250) plus
    // the two remaining validator templates (permissionValidation.ts
    // :290/:324/:339/:420).
    const loop2Shapes = [
      'Deny rule Write(src/**) never matches · use Edit(src/**)',
      'Allow rule Bash(git * main) allows any option at its * · use an exact value',
      'Ask rule Bash(npm * run:*) reads its * literally · use Bash(npm * run*)',
      'Deny rule Bash(npm * :*:*) reads its * literally',
      'Allow rule Bash(npm run:*build) reads its :* as a wildcard · use an exact value',
    ]
    const legacy = [
      ...loop2Shapes.map(shape => createSystemMessage(shape, 'warning')),
      userRow,
    ] as never[]
    const messages = deserializeMessages(legacy)
    for (const shape of loop2Shapes) {
      expect(
        messages.some(
          m => m.type === 'system' && (m as { content?: string }).content === shape,
        ),
      ).toBe(false)
    }
    expect(messages.some(m => m.type === 'user')).toBe(true)
  })

  test('non-warning-level and non-system rows starting with "Deny rule " survive', async () => {
    ;({ deserializeMessages } = await import('../conversationRecovery.js'))
    const infoLevel = {
      ...createSystemMessage(`Deny rule ${ROW_A}`, 'warning'),
      level: 'info',
    }
    const userText = {
      type: 'user',
      uuid: randomUUID(),
      message: { role: 'user', content: `Deny rule ${ROW_A}` },
    }
    const messages = deserializeMessages([infoLevel, userText] as never[])
    expect(
      messages.some(
        m => m.type === 'system' && (m as { level?: string }).level === 'info',
      ),
    ).toBe(true)
    expect(
      messages.some(
        m =>
          m.type === 'user' &&
          (m as { message: { content: string } }).message.content.startsWith(
            'Deny rule ',
          ),
      ),
    ).toBe(true)
  })
})

describe('OCC-126 REPL no longer seeds securityWarnings into messages', () => {
  // Structural guard (unit-level; the behavioral gate is the tmux e2e
  // test/e2e/security-warnings-banner-306.e2e.test.ts): the messages
  // initializer must not prepend createSystemMessage rows — banner rendering
  // lives in the StatusNotices registry now.
  test('REPL.tsx messages initializer has no securityWarnings seeding', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(
      new URL('../../screens/REPL.tsx', import.meta.url),
      'utf8',
    )
    expect(src).not.toContain(
      'securityWarnings.map(warning => createSystemMessage',
    )
    // The prop still exists — it feeds the banner via <Messages …>.
    expect(src).toContain('securityWarnings?: string[]')
    expect(src).toContain('securityWarnings={securityWarnings}')
  })
})

afterAll(() => {})
