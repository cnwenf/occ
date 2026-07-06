import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

describe('PowerShell -ExecutionPolicy Bypass (2.1.143, e2e)', () => {
  test('buildPowerShellArgs + sandbox path both include -ExecutionPolicy Bypass', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/shell/powershellProvider.ts`).text()
    // Official 2.1.200 binary: ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-EncodedCommand",n]
    // OCC must add -ExecutionPolicy Bypass to BOTH the -Command path (buildPowerShellArgs)
    // and the -EncodedCommand sandbox path.
    const epCount = (src.match(/'-ExecutionPolicy'/g) || []).length
    const bypassCount = (src.match(/'Bypass'/g) || []).length
    expect(epCount).toBeGreaterThanOrEqual(2)
    expect(bypassCount).toBeGreaterThanOrEqual(2)
  })

  test('sandbox path places -ExecutionPolicy Bypass before -EncodedCommand', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/shell/powershellProvider.ts`).text()
    const encodedIdx = src.lastIndexOf("'-EncodedCommand'")
    // the -ExecutionPolicy immediately preceding -EncodedCommand (sandbox path)
    const epBeforeEncoded = src.lastIndexOf("'-ExecutionPolicy'", encodedIdx)
    expect(epBeforeEncoded).toBeGreaterThan(-1)
    expect(epBeforeEncoded).toBeLessThan(encodedIdx)
  })
})
