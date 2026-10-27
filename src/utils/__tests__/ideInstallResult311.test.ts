import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// MACRO polyfill (repo convention — ide.ts reads MACRO.VERSION via
// getClaudeCodeVersion()). Per-file test runs (`bun test <file>`) guarantee
// MACRO is undefined here, so this value wins.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: '2.1.311' }
}

/**
 * CC 2.1.311 (WP-H, triage items 26+38) — /ide install-status flow.
 *
 * v310 fired the IDE-extension install and immediately claimed success
 * ("Installed plugin to …" / "Installed extension to …"). v311 awaits an
 * install-result object `{installed, previouslyInstalled?, error?}` and emits
 * precise per-branch messages, shows a cancellable pending UI, and handles
 * JetBrains separately.
 *
 * Byte evidence (official v311 binary, READ-ONLY, grep -aboF / dd):
 *   `We` install component @284842600 (dd window 284842550+2800):
 *     I=()=>{let h=!0;return c(o).then((D)=>{if(!h){return}
 *       let d=he.bold(t);let E=`To install it yourself, see ${Jln}`;
 *       if(D?.installed)i(D.previouslyInstalled
 *         ?`The Claude Code extension is installed in ${d}. Reload the ${t}
 *           window (Developer: Reload Window), then run /ide again.`
 *         :`Installed the Claude Code extension in ${d}.`);
 *       else if(D?.error)i(`Couldn't install the Claude Code extension in
 *         ${d}:\n${D.error}\n${E}`);
 *       else{let v=MNr()??(Rt()?"this session's workspace is remote":null);
 *         i(`Didn't install the Claude Code extension in ${d}
 *           ${v?` because ${v}`:""}.\n${E}`)}},()=>{h=!1})
 *     const R=`Installing the Claude Code extension in ${t}…`;
 *     k=()=>i(`Still installing the Claude Code extension in ${t}. /status
 *       shows the result when it finishes.`,{display:"system"})
 *     O=e(SK,{message:R,escAction:"stop waiting",onCancel:k})
 *   `MNr()` skip-reason @251640820:
 *     var Jln="https://code.claude.com/docs/en/vs-code#install-the-extension";
 *     function MNr(){
 *       if(i.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL)
 *         return"CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL is set";
 *       if(!(ue().autoInstallIdeExtension??!0))
 *         return"the autoInstallIdeExtension setting is off";
 *       return null}
 *   `gn` JetBrains branch @284843700:
 *     if(mye(p)){c(p);let h=Iw(p);i(`Couldn't find the Claude Code plugin
 *       running in ${he.bold(h)}.\n${he.bold(`restart ${h}`)} completely and
 *       run /ide again.\n`);return}l(p)
 *   Literal counts (v310/v311, grep -aboF):
 *     "Installed the Claude Code extension in"      0/2 (@284842914)
 *     "Couldn't install the Claude Code extension"  0/2
 *     "Couldn't find the Claude Code plugin running in" 0/2 (@284843827)
 *     "Still installing the Claude Code extension"  0/2
 *     "Installing the Claude Code extension in"     0/2
 *     "Didn't install the Claude Code extension"    0/2
 *     "Select IDE to set up Claude Code"            0/2 (@284842194)
 *     "The Claude Code extension is installed in"   0/2
 *     "code.claude.com/docs/en/vs-code#install-the-extension" 0/2
 *     "Select IDE to install extension" (v310 title) 2/0
 *
 * NOTE on message templates: the official error / didn't-install branches
 * contain REAL newlines before the `To install it yourself…` trailer, and the
 * JetBrains message ends with a trailing newline. `…` is U+2026. The display
 * name is bolded (`he.bold`) in result messages but NOT in the pending /
 * reload-window / still-installing parts. `bold` is injected as a parameter
 * so these mappers stay pure (tests use a marker wrapper).
 *
 * NOTE on the remote-workspace fallback: the official reads `Rt()` (a
 * generic workspace-is-remote predicate whose definition is in another
 * chunk). OCC has no equivalent predicate, so per the WP-H brief the mapper
 * takes a `workspaceIsRemote: boolean` option instead, producing the same
 * byte-exact reason string "this session's workspace is remote".
 */

// --- Mock seam (repo convention: snapshot real exports, override narrowly,
// restore in afterAll). config.js → deterministic getGlobalConfig. ---
const actualConfigModule = await import('../config.js')
const actualConfigExports = { ...actualConfigModule }
let mockGlobalConfig: Record<string, unknown> = {}
mock.module('../config.js', () => ({
  ...actualConfigExports,
  getGlobalConfig: () => mockGlobalConfig,
}))

afterAll(() => {
  mock.module('../config.js', () => ({ ...actualConfigExports }))
})

// Import AFTER mocks are registered.
const {
  IDE_INSTALL_DOCS_URL,
  getIdeInstallSkipReason,
  formatIdeInstallResultMessage,
  formatJetBrainsPluginNotRunningMessage,
  formatIdeInstallPendingMessage,
  formatIdeInstallStillInstallingMessage,
} = await import('../ide.js')
type IdeStatus = import('../ide.js').IDEExtensionInstallationStatus

// Marker bold so tests can assert exactly which spans the official bolds.
const bold = (s: string): string => `<b>${s}</b>`

const SKIP_ENV_KEY = 'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL'
let skipEnvSnapshot: string | undefined

beforeEach(() => {
  skipEnvSnapshot = process.env[SKIP_ENV_KEY]
  delete process.env[SKIP_ENV_KEY]
  mockGlobalConfig = {}
})

afterEach(() => {
  if (skipEnvSnapshot === undefined) {
    delete process.env[SKIP_ENV_KEY]
  } else {
    process.env[SKIP_ENV_KEY] = skipEnvSnapshot
  }
})

describe('2.1.311 WP-H — getIdeInstallSkipReason (official MNr)', () => {
  test('returns null when auto-install is allowed (default setting, env unset)', () => {
    expect(getIdeInstallSkipReason()).toBeNull()
  })

  test('returns null when autoInstallIdeExtension is explicitly true', () => {
    mockGlobalConfig = { autoInstallIdeExtension: true }
    expect(getIdeInstallSkipReason()).toBeNull()
  })

  test('reports the env var when CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL is set', () => {
    process.env[SKIP_ENV_KEY] = '1'
    expect(getIdeInstallSkipReason()).toBe(
      'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL is set',
    )
  })

  test('env var takes precedence over the setting (official MNr checks env first)', () => {
    process.env[SKIP_ENV_KEY] = '1'
    mockGlobalConfig = { autoInstallIdeExtension: false }
    expect(getIdeInstallSkipReason()).toBe(
      'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL is set',
    )
  })

  test('reports the setting when autoInstallIdeExtension is off', () => {
    mockGlobalConfig = { autoInstallIdeExtension: false }
    expect(getIdeInstallSkipReason()).toBe(
      'the autoInstallIdeExtension setting is off',
    )
  })
})

describe('2.1.311 WP-H — docs URL constant (official Jln)', () => {
  test('is the v311 install-the-extension docs URL', () => {
    expect(IDE_INSTALL_DOCS_URL).toBe(
      'https://code.claude.com/docs/en/vs-code#install-the-extension',
    )
  })
})

describe('2.1.311 WP-H — formatIdeInstallResultMessage (official We mapper)', () => {
  const baseStatus = {
    installed: true,
    error: null,
    installedVersion: '2.1.311',
    ideType: 'vscode',
  } as const

  test('fresh install: "Installed the Claude Code extension in <bold>."', () => {
    const message = formatIdeInstallResultMessage(
      { ...baseStatus, previouslyInstalled: false },
      'VS Code',
      { bold, skipReason: null, workspaceIsRemote: false },
    )
    expect(message).toBe(
      'Installed the Claude Code extension in <b>VS Code</b>.',
    )
  })

  test('previously installed: reload-window message bolds only the IDE name in the first sentence', () => {
    const message = formatIdeInstallResultMessage(
      { ...baseStatus, previouslyInstalled: true },
      'VS Code',
      { bold, skipReason: null, workspaceIsRemote: false },
    )
    expect(message).toBe(
      'The Claude Code extension is installed in <b>VS Code</b>. Reload the VS Code window (Developer: Reload Window), then run /ide again.',
    )
  })

  test('error: "Couldn\'t install…" with real newlines around the error and the docs trailer', () => {
    const message = formatIdeInstallResultMessage(
      {
        installed: false,
        error: 'Command failed with exit code 1',
        installedVersion: null,
        ideType: 'vscode',
      },
      'Cursor',
      { bold, skipReason: null, workspaceIsRemote: false },
    )
    expect(message).toBe(
      "Couldn't install the Claude Code extension in <b>Cursor</b>:\n" +
        'Command failed with exit code 1\n' +
        'To install it yourself, see https://code.claude.com/docs/en/vs-code#install-the-extension',
    )
  })

  test('not installed with explicit skip reason: "Didn\'t install … because <reason>." + trailer', () => {
    const message = formatIdeInstallResultMessage(
      {
        installed: false,
        error: null,
        installedVersion: null,
        ideType: 'vscode',
      },
      'VS Code',
      {
        bold,
        skipReason: 'the autoInstallIdeExtension setting is off',
        workspaceIsRemote: false,
      },
    )
    expect(message).toBe(
      "Didn't install the Claude Code extension in <b>VS Code</b> because the autoInstallIdeExtension setting is off.\n" +
        'To install it yourself, see https://code.claude.com/docs/en/vs-code#install-the-extension',
    )
  })

  test('not installed without any reason: no "because" clause', () => {
    const message = formatIdeInstallResultMessage(
      {
        installed: false,
        error: null,
        installedVersion: null,
        ideType: 'vscode',
      },
      'Windsurf',
      { bold, skipReason: null, workspaceIsRemote: false },
    )
    expect(message).toBe(
      "Didn't install the Claude Code extension in <b>Windsurf</b>.\n" +
        'To install it yourself, see https://code.claude.com/docs/en/vs-code#install-the-extension',
    )
  })

  test('remote workspace supplies the fallback reason (official Rt() branch)', () => {
    const message = formatIdeInstallResultMessage(
      {
        installed: false,
        error: null,
        installedVersion: null,
        ideType: 'vscode',
      },
      'VS Code',
      { bold, skipReason: null, workspaceIsRemote: true },
    )
    expect(message).toBe(
      "Didn't install the Claude Code extension in <b>VS Code</b> because this session's workspace is remote.\n" +
        'To install it yourself, see https://code.claude.com/docs/en/vs-code#install-the-extension',
    )
  })

  test('explicit skip reason wins over the remote-workspace fallback (MNr() ?? Rt())', () => {
    const message = formatIdeInstallResultMessage(
      {
        installed: false,
        error: null,
        installedVersion: null,
        ideType: 'vscode',
      },
      'VS Code',
      {
        bold,
        skipReason: 'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL is set',
        workspaceIsRemote: true,
      },
    )
    expect(message).toBe(
      "Didn't install the Claude Code extension in <b>VS Code</b> because CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL is set.\n" +
        'To install it yourself, see https://code.claude.com/docs/en/vs-code#install-the-extension',
    )
  })

  test('null result (official D?.installed / D?.error optional chaining) → didn\'t-install branch', () => {
    const message = formatIdeInstallResultMessage(null, 'VS Code', {
      bold,
      skipReason: null,
      workspaceIsRemote: false,
    })
    expect(message).toBe(
      "Didn't install the Claude Code extension in <b>VS Code</b>.\n" +
        'To install it yourself, see https://code.claude.com/docs/en/vs-code#install-the-extension',
    )
  })

  test('skipReason option omitted → mapper falls back to getIdeInstallSkipReason()', () => {
    mockGlobalConfig = { autoInstallIdeExtension: false }
    const message = formatIdeInstallResultMessage(
      {
        installed: false,
        error: null,
        installedVersion: null,
        ideType: 'vscode',
      },
      'VS Code',
      { bold, workspaceIsRemote: false },
    )
    expect(message).toBe(
      "Didn't install the Claude Code extension in <b>VS Code</b> because the autoInstallIdeExtension setting is off.\n" +
        'To install it yourself, see https://code.claude.com/docs/en/vs-code#install-the-extension',
    )
  })

  test('bold defaults to identity (pure mapper, no chalk dependency)', () => {
    const message = formatIdeInstallResultMessage(
      { ...baseStatus, previouslyInstalled: false },
      'VS Code',
      { skipReason: null, workspaceIsRemote: false },
    )
    expect(message).toBe('Installed the Claude Code extension in VS Code.')
  })

  test('error text is embedded verbatim but never leaks extra context', () => {
    const status: IdeStatus = {
      installed: false,
      error: 'spawn code ENOENT',
      installedVersion: null,
      ideType: 'vscode',
    }
    const message = formatIdeInstallResultMessage(status, 'VS Code', {
      skipReason: null,
      workspaceIsRemote: false,
    })
    expect(message).toContain('spawn code ENOENT')
    expect(message.startsWith("Couldn't install the Claude Code extension in ")).toBe(true)
  })
})

describe('2.1.311 WP-H — formatJetBrainsPluginNotRunningMessage (official gn branch)', () => {
  test('matches the official template byte-for-byte incl. trailing newline', () => {
    const message = formatJetBrainsPluginNotRunningMessage('IntelliJ IDEA', bold)
    expect(message).toBe(
      "Couldn't find the Claude Code plugin running in <b>IntelliJ IDEA</b>.\n" +
        '<b>restart IntelliJ IDEA</b> completely and run /ide again.\n',
    )
  })

  test('bold defaults to identity', () => {
    const message = formatJetBrainsPluginNotRunningMessage('PyCharm')
    expect(message).toBe(
      "Couldn't find the Claude Code plugin running in PyCharm.\n" +
        'restart PyCharm completely and run /ide again.\n',
    )
  })
})

describe('2.1.311 WP-H — pending + still-installing literals (official We/SK)', () => {
  test('pending message uses the U+2026 ellipsis and an unbolded display name', () => {
    const message = formatIdeInstallPendingMessage('VS Code')
    expect(message).toBe('Installing the Claude Code extension in VS Code…')
    expect(message.endsWith('…')).toBe(true)
    expect(message.includes('...')).toBe(false)
  })

  test('still-installing cancel message is a system-display literal', () => {
    const message = formatIdeInstallStillInstallingMessage('Cursor')
    expect(message).toBe(
      'Still installing the Claude Code extension in Cursor. /status shows the result when it finishes.',
    )
  })
})
