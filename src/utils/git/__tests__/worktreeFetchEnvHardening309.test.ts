/**
 * 309 review dataflow-01 + dataflow-02 + dataflow-07 regression pins.
 *
 * dataflow-01 (P2): the worktree base-branch fetch env used to be built from
 * raw `{...process.env, ...GIT_NO_PROMPT_ENV}`, so ambient
 * GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* redirect vars leaked into the
 * remote-resolving subprocess while every sibling spawn in the same routine
 * scrubbed them through buildMergedGitEnv (probe: a decoy GIT_DIR silently
 * fetched the WRONG remote). The call site now routes through the merged
 * builder; this file pins both the composed env behavior and the call-site
 * wiring (a revert to the raw formula turns the source pin RED).
 *
 * dataflow-07: the old PARTIAL-WIRING DECLARATION comment claimed the merge
 * scrub "would strip the SSH_ASKPASS pins" — falsified by probe. The pins are
 * applied by resolveFetchSshFailFast AFTER the env build and the scrub lists
 * carry only GIT_* keys; test 2 below pins that composition directly.
 *
 * dataflow-02 (P2): buildMergedGitEnv's OCC hardening defaults (deviation #4)
 * neutralize malicious `.git/config` `alias.remote-*` smuggling and pin
 * GIT_TERMINAL_PROMPT=0 on this network sink; behavioral pins live in
 * gitEnv309.test.ts, the fetch-formula assertions below cover the composed
 * production env.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { resolveFetchSshFailFast } from '../../gitFetchSshFailFast.js'
import { GIT_CONFIG_PARAMETERS_BASE, buildMergedGitEnv } from '../gitEnv.js'

/** worktree.ts GIT_NO_PROMPT_ENV (module-private) — kept in sync by the
 *  source pin below asserting the call site spreads it. */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' }

describe('dataflow-01 — worktree fetch env composition (merged builder → fail-fast)', () => {
  test('production formula scrubs ambient GIT_DIR/GIT_CONFIG_* and carries the OCC hardening defaults', () => {
    // Arrange — hostile ambient env (the review probe's decoy shape)
    const base = {
      GIT_DIR: '/decoy/should-not-resolve-the-remote',
      GIT_WORK_TREE: '/decoy/worktree',
      GIT_CONFIG_GLOBAL: '/evil/global-config',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'alias.remote-none',
      GIT_CONFIG_VALUE_0: '/evil',
      HOME: '/ok',
    }

    // Act — exactly the call-site formula: buildMergedGitEnv({...GIT_NO_PROMPT_ENV})
    const env = buildMergedGitEnv({ ...NO_PROMPT }, { base })

    // Assert — redirect vars scrubbed (dataflow-01 core)
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined()
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined()
    expect(env.HOME).toBe('/ok')
    // Assert — no-prompt shape + OCC hardening defaults (dataflow-02)
    expect(env.GIT_ASKPASS).toBe('')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_CONFIG_PARAMETERS).toBe(GIT_CONFIG_PARAMETERS_BASE)
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe('1')
  })

  test('dataflow-07: the SSH_ASKPASS fail-fast pins survive the merged-builder composition', async () => {
    // Act — resolveFetchSshFailFast(mergedEnv, cwd, tty-probe:=true) is the
    // production composition; probe forced true so the pinning branch runs.
    const merged = buildMergedGitEnv(
      { ...NO_PROMPT },
      { base: { GIT_DIR: '/decoy', HOME: '/ok' } },
    ) as NodeJS.ProcessEnv
    const spawn = await resolveFetchSshFailFast(merged, process.cwd(), async () => true)

    // Assert — pins applied on top of the scrubbed env (comment falsified:
    // the scrub never touches SSH_* keys)
    expect(spawn.env.SSH_ASKPASS_REQUIRE).toBe('never')
    expect(spawn.env.SSH_ASKPASS).toBe('false')
    expect(spawn.withoutControllingTerminal).toBe(true)
    // Assert — scrub still in effect in the final composed env
    expect(spawn.env.GIT_DIR).toBeUndefined()
    expect(spawn.env.GIT_CONFIG_PARAMETERS).toBe(GIT_CONFIG_PARAMETERS_BASE)
  })
})

describe('dataflow-01/07 — worktree.ts call-site wiring pin (mutation killer)', () => {
  const worktreeSource = readFileSync(
    join(import.meta.dir, '../../worktree.ts'),
    'utf8',
  )

  test('the fetch env is routed through buildMergedGitEnv into resolveFetchSshFailFast', () => {
    // A revert to the raw `{ ...process.env, ...GIT_NO_PROMPT_ENV }` formula
    // (the dataflow-01 defect) breaks this pattern.
    expect(worktreeSource).toMatch(
      /resolveFetchSshFailFast\(\s*buildMergedGitEnv\(\{ \.\.\.GIT_NO_PROMPT_ENV \}\) as NodeJS\.ProcessEnv,\s*repoRoot,\s*\)/,
    )
  })

  test('the falsified PARTIAL-WIRING DECLARATION comment is gone (dataflow-07)', () => {
    expect(worktreeSource).not.toContain(
      'would strip the SSH_ASKPASS',
    )
    expect(worktreeSource).not.toContain('PARTIAL-WIRING DECLARATION')
  })
})
