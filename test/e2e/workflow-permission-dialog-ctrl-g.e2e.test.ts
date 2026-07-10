import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT, runOcc, tempFile } from './helpers'

// Read version from package.json so the assertion doesn't rot on each bump.
const { version } = require('../../package.json') as { version: string }

/**
 * E2E coverage for the WorkflowPermissionDialog ctrl+g "edit script in $EDITOR"
 * flow (2.1.204 catch-up).
 *
 * The full model-driven path (Claude decides to call the Workflow tool →
 * dialog renders → ctrl+g → EDITOR → save → accept → workflow runs) requires
 * a live Anthropic API key, which is not available in this environment. These
 * tests instead exercise the REAL code paths the dialog depends on:
 *
 *   1. ctrl+g wiring in WorkflowPermissionDialog.tsx (source + functional).
 *   2. editFileInEditor / getExternalEditor / toIDEDisplayName contracts.
 *   3. The actual script loader (loadScript/validateScriptPath) + discovery
 *      (resolveWorkflowScript) against a real workflow script on disk.
 *   4. Binary parse smoke (the Bun-1.3.11 `using`-declaration crash fix) —
 *      verifies the built bundle launches without a SyntaxError.
 *
 * Together these verify the behavior end-to-end up to the model call: the
 * dialog can load a real script, the ctrl+g handler is wired to the real
 * editFileInEditor, and the binary that ships this dialog parses cleanly.
 */

const DIALOG = `${REPO_ROOT}/src/components/WorkflowPermissionDialog.tsx`
const PERM_REQ = `${REPO_ROOT}/src/tools/WorkflowTool/WorkflowPermissionRequest.tsx`
const PROMPT_EDITOR = `${REPO_ROOT}/src/utils/promptEditor.ts`
const EDITOR_UTIL = `${REPO_ROOT}/src/utils/editor.ts`

describe('WorkflowPermissionDialog: ctrl+g edit-script wiring', () => {
  test('imports editFileInEditor, getExternalEditor, toIDEDisplayName', async () => {
    const src = await Bun.file(DIALOG).text()
    expect(src).toContain('editFileInEditor')
    expect(src).toContain("from '../utils/promptEditor.js'")
    expect(src).toContain('getExternalEditor')
    expect(src).toContain("from '../utils/editor.js'")
    expect(src).toContain('toIDEDisplayName')
    expect(src).toContain("from '../utils/ide.js'")
  })

  test('registers the chat:externalEditor keybinding', async () => {
    const src = await Bun.file(DIALOG).text()
    expect(src).toContain('useKeybinding')
    expect(src).toContain("from '../keybindings/useKeybinding.js'")
    expect(src).toContain("'chat:externalEditor'")
    expect(src).toContain("isActive: !!scriptPath && subView !== 'summary'")
  })

  test('handleEditScript re-reads the file + shows the save message', async () => {
    const src = await Bun.file(DIALOG).text()
    expect(src).toMatch(/handleEditScript[\s\S]*?editFileInEditor\(scriptPath\)/)
    expect(src).toContain('setScriptSource(result.content)')
    expect(src).toContain('setShowSaveMessage(true)')
    expect(src).toContain('tengu_workflow_external_editor_used')
  })

  test('save message auto-hides after 5 seconds', async () => {
    const src = await Bun.file(DIALOG).text()
    expect(src).toMatch(/setTimeout\(\(\)\s*=>\s*setShowSaveMessage\(false\),\s*5000\)/)
  })

  test('renders the ConfigurableShortcutHint with the ctrl+g fallback', async () => {
    const src = await Bun.file(DIALOG).text()
    expect(src).toContain('ConfigurableShortcutHint')
    expect(src).toContain('action="chat:externalEditor"')
    expect(src).toContain('context="Chat"')
    expect(src).toContain('fallback="ctrl+g"')
    // Source uses a template literal `edit script in ${editorName}`.
    expect(src).toContain('edit script in ')
  })

  test('gates the hint on scriptPath presence + non-summary sub-view', async () => {
    const src = await Bun.file(DIALOG).text()
    expect(src).toContain("showEditHint = !!scriptPath && subView !== 'summary'")
  })

  test('scriptSource state is seeded from the prop + overridable on edit', async () => {
    const src = await Bun.file(DIALOG).text()
    expect(src).toMatch(/scriptSource:\s*scriptSourceProp/)
    expect(src).toContain('const [scriptSource, setScriptSource]')
    expect(src).toMatch(/scriptSource=\{scriptSource\}/)
  })
})

describe('WorkflowPermissionRequest: dialog dispatch + script resolution', () => {
  test('imports WorkflowPermissionDialog + resolves the script path', async () => {
    const src = await Bun.file(PERM_REQ).text()
    expect(src).toContain('WorkflowPermissionDialog')
    expect(src).toContain("from '../../components/WorkflowPermissionDialog.js'")
    expect(src).toContain('loadScript')
    expect(src).toContain('validateScriptPath')
    expect(src).toContain('resolveWorkflowScript')
  })

  test('rejects when the script cannot be resolved', async () => {
    const src = await Bun.file(PERM_REQ).text()
    expect(src).toContain('onReject')
    expect(src).toContain('Could not resolve workflow script')
  })
})

describe('real workflow script loading (the dialog data source)', () => {
  const SCRIPT = `export const meta = {
  name: "smoke-workflow",
  description: "A tiny workflow for e2e smoke",
  phases: ["gather", "merge"],
};
export default async ({ agent }) => {
  const r = await agent("hello");
  return r;
};
`

  test('validateScriptPath rejects UNC + empty, accepts real path', async () => {
    const { path, cleanup } = tempFile('wf.js', SCRIPT)
    try {
      const script = `
        const { validateScriptPath } = await import("${REPO_ROOT}/src/tools/WorkflowTool/scriptLoader.ts");
        const results = { accepted: null, unc: null, empty: null };
        try { results.accepted = validateScriptPath(${JSON.stringify(path)}); } catch (e) { results.accepted = String(e); }
        try { validateScriptPath("\\\\\\\\server\\\\share\\\\wf.js"); } catch (e) { results.unc = e.message; }
        try { validateScriptPath(""); } catch (e) { results.empty = e.message; }
        console.log(JSON.stringify(results));
      `
      const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim())
      expect(out.accepted).toBe(path)
      expect(out.unc).toContain('UNC paths are not allowed')
      expect(out.empty).toContain('non-empty string')
    } finally {
      cleanup()
    }
  })

  test('loadScript parses meta (name/description/phases) + body', async () => {
    const { path, cleanup } = tempFile('wf.js', SCRIPT)
    try {
      const script = `
        const { loadScript } = await import("${REPO_ROOT}/src/tools/WorkflowTool/scriptLoader.ts");
        const r = loadScript(${JSON.stringify(path)});
        const out = {
          name: r.meta.name,
          description: r.meta.description,
          phases: r.meta.phases,
          hasDefaultExport: r.hasDefaultExport,
          scriptPath: r.scriptPath,
          sourceHasMeta: r.source.includes("smoke-workflow"),
        };
        console.log(JSON.stringify(out));
      `
      const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim())
      expect(out.name).toBe('smoke-workflow')
      expect(out.description).toBe('A tiny workflow for e2e smoke')
      expect(out.phases).toEqual(['gather', 'merge'])
      expect(out.hasDefaultExport).toBe(true)
      expect(out.scriptPath).toBe(path)
      expect(out.sourceHasMeta).toBe(true)
    } finally {
      cleanup()
    }
  })

  test('resolveWorkflowScript finds a project workflow by name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'occ-wf-disc-'))
    const wfDir = join(dir, '.claude', 'workflows')
    mkdirSync(wfDir, { recursive: true })
    writeFileSync(join(wfDir, 'named-flow.js'), SCRIPT)
    try {
      const script = `
        const { resolveWorkflowScript } = await import("${REPO_ROOT}/src/utils/effort/workflowDiscovery.ts");
        const found = resolveWorkflowScript("named-flow", "project", ${JSON.stringify(dir)});
        const missing = resolveWorkflowScript("nope-not-here", "project", ${JSON.stringify(dir)});
        console.log(JSON.stringify({ found, missing }));
      `
      const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim())
      expect(out.found).toBe(join(wfDir, 'named-flow.js'))
      expect(out.missing).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('loadScript rejects a script missing the meta statement', async () => {
    const { path, cleanup } = tempFile('bad.js', 'export default async () => 1;\n')
    try {
      const script = `
        const { loadScript, WorkflowScriptError } = await import("${REPO_ROOT}/src/tools/WorkflowTool/scriptLoader.ts");
        try {
          loadScript(${JSON.stringify(path)});
          console.log("NO_ERROR");
        } catch (e) {
          console.log(JSON.stringify({ isWfErr: e instanceof WorkflowScriptError, msg: e.message }));
        }
      `
      const out = (await $`bun -e ${script}`.quiet()).stdout.toString().trim()
      expect(out).not.toBe('NO_ERROR')
      const parsed = JSON.parse(out)
      expect(parsed.isWfErr).toBe(true)
      expect(parsed.msg).toContain('export const meta')
    } finally {
      cleanup()
    }
  })
})

describe('editFileInEditor / getExternalEditor contracts', () => {
  test('editFileInEditor returns EditorResult + no-op when no editor', async () => {
    const src = await Bun.file(PROMPT_EDITOR).text()
    expect(src).toMatch(/export function editFileInEditor\(filePath:\s*string\):\s*EditorResult/)
    expect(src).toContain('return { content: null }')
    expect(src).toContain('return { content: editedContent }')
  })

  test('getExternalEditor resolves VISUAL > EDITOR', async () => {
    const src = await Bun.file(EDITOR_UTIL).text()
    // getExternalEditor is a memoized const; check the export + body.
    expect(src).toContain('export const getExternalEditor')
    expect(src).toMatch(/VISUAL/)
    expect(src).toMatch(/EDITOR/)
  })
})

describe('binary parse smoke (Bun 1.3.11 using-declaration crash fix)', () => {
  test('dist/cli.js contains zero using-declaration statements', async () => {
    const bundle = await Bun.file(`${REPO_ROOT}/dist/cli.js`).text()
    const usingDecl = bundle.match(/^\s*(await\s+)?using\s+\w+\s*=/gm)
    expect(usingDecl).toBeNull()
    expect(bundle).not.toMatch(/using\s+_\s*=\s*slowLogging/)
  })

  test('dist/cli.js launches and prints --version (no SyntaxError)', async () => {
    const r = await runOcc(['--version'], {}, 30_000)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(version)
    expect(r.stderr).not.toContain('SyntaxError')
    expect(r.stderr).not.toContain('Unexpected identifier')
  })
})
