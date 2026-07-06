import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

/**
 * F5 (2.1.186): respondToBashCommands. Controls whether Claude responds after
 * an input-box `!` bash command runs. Default true (respond); false adds the
 * output to context with a caveat and does NOT query.
 *
 * Source-grep e2e: verifies the schema field + the processBashCommand wiring
 * (setting read, telemetry, shouldQuery computed from respond, caveat
 * prepended only when not querying) — matching the official `tDm`.
 */

describe('respondToBashCommands runtime (2.1.186)', () => {
  test('schema declares respondToBashCommands (boolean, default true)', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/settings/types.ts`).text()
    expect(src).toContain('respondToBashCommands')
    expect(src).toMatch(/respondToBashCommands: z[\s\S]*?\.boolean\(\)[\s\S]*?\.optional\(\)/)
    // Official describe wording.
    expect(src).toContain('Whether Claude responds after an input-box ! bash command')
    expect(src).toContain('Set to false to add the command output to context without a response')
    expect(src).toContain('Default: true.')
  })

  test('processBashCommand reads the setting (default true) + emits respond telemetry', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/processUserInput/processBashCommand.tsx`).text()
    expect(src).toContain("getInitialSettings().respondToBashCommands ?? true")
    // Telemetry includes respond (official: q("tengu_input_bash",{powershell,respond:s})).
    const evtIdx = src.indexOf("tengu_input_bash")
    expect(evtIdx).toBeGreaterThan(-1)
    expect(src.slice(evtIdx, evtIdx + 200)).toContain('respond')
  })

  test('shouldQuery is computed from respond + safety conditions, caveat only when not querying', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/processUserInput/processBashCommand.tsx`).text()
    // Success path: S = respond && !interrupted && !backgroundTaskId && !aborted.
    expect(src).toContain('!data.interrupted && !data.backgroundTaskId && !context.abortController.signal.aborted')
    // Caveat prepended only when NOT querying (official: [...S?[]:[Wie()], ...]).
    expect(src).toContain('...shouldQuery ? [] : [createSyntheticUserCaveatMessage()]')
    // Error paths also gate on respond + aborted.
    expect(src).toContain('respond && !context.abortController.signal.aborted')
  })
})
