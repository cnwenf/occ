import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

describe('TaskCreate description wording (2.1.169, e2e)', () => {
  test('prompt says "create and manage" (binary-exact)', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/tools/TaskCreateTool/prompt.ts`).text()
    // Official 2.1.200 binary: "Use this tool to create and manage a structured task list..."
    expect(src).toContain('create and manage a structured task list')
    expect(src).not.toContain('create a structured task list for your current')
  })
})
