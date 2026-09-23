import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStringIsolated } from '../../../components/CustomSelect/__tests__/renderIsolated280.js'
import { AppStateProvider } from '../../../state/AppState.js'
import { CheckGitHubStep } from '../CheckGitHubStep.js'
import { ChooseRepoStep } from '../ChooseRepoStep.js'

// CC 2.1.280 (#066): "Improved /install-github-app: the GitHub CLI check and
// repository selection steps now show 'Esc to cancel'".
//
// Official v280 evidence (win.py windows):
// - CLI-check step @226720089: `r(s,{flexDirection:"column",gap:1,paddingX:2,
//   children:[m,e(n,{dimColor:!0,children:e(Xe,{action:"confirm:no",
//   context:"Settings",fallback:"Esc",description:"cancel"})})]})`
//   (v278 @226930814: bare `e(s,{paddingX:2,children:e(lr,{message:...})})`).
// - Repo-select footer @226723066: `we=e(Xe,{action:"confirm:no",
//   context:"Settings",fallback:"Esc",description:"cancel"})` appended as a
//   third item in `r(_e,{children:[ge,Ge,we]})` — ge (up/down select) stays
//   conditional on currentRepo (v278 @226933375 had only `[Ro,xi]`).
// Xe = configurable keybinding hint → OCC ConfigurableShortcutHint; without a
// KeybindingContext it renders the "Esc" fallback (useShortcutDisplay).
// _e = middot joiner → OCC Byline (" · ").

const noop = () => {}

function renderChooseRepo(currentRepo: string | null, useCurrentRepo: boolean): Promise<string> {
  // AppStateProvider: the repoUrl TextInput branch calls useAppState, which
  // throws outside the provider.
  return renderToStringIsolated(
    <AppStateProvider>
      <ChooseRepoStep
        currentRepo={currentRepo}
        useCurrentRepo={useCurrentRepo}
        repoUrl=""
        onRepoUrlChange={noop}
        onToggleUseCurrentRepo={noop}
        onSubmit={noop}
      />
    </AppStateProvider>,
    100,
  )
}

describe('2.1.280 #066 install-github-app Esc-to-cancel hints', () => {
  test('CheckGitHubStep shows a dim Esc-cancel hint below the CLI-check message', async () => {
    // Act
    const out = await renderToStringIsolated(<CheckGitHubStep />, 80)
    const lines = out.split('\n').filter(line => line.trimEnd().length > 0)

    // Assert — message kept, hint added on a separate line below it
    expect(out).toContain('Checking GitHub CLI installation')
    const hintLine = lines.find(line => line.includes('Esc to cancel'))
    expect(hintLine).toBeDefined()
    expect(lines[0].includes('Esc to cancel')).toBe(false)
    expect(lines.indexOf(hintLine!)).toBeGreaterThan(lines.findIndex(line => line.includes('Checking GitHub CLI')))

    // paddingX={2} from the v280 column wrapper applies to both lines
    expect(lines[0].startsWith('  ')).toBe(true)
    expect(hintLine!.startsWith('  ')).toBe(true)
  })

  test('ChooseRepoStep footer gains Esc-cancel as third hint (no currentRepo → two items)', async () => {
    // Arrange — no currentRepo: the up/down-select hint stays hidden
    // (official ge = m ? … : null), so the footer shows exactly
    // enter-continue + esc-cancel joined by OCC's middot convention.
    const out = await renderChooseRepo(null, false)

    // Assert
    expect(out).toContain('Enter to continue · Esc to cancel')
    expect(out).not.toContain('↑/↓ to select')
  })

  test('ChooseRepoStep footer with currentRepo: ↑/↓ select · Enter continue · Esc cancel', async () => {
    // Arrange — currentRepo present: all three footer hints render
    const out = await renderChooseRepo('owner/repo', true)

    // Assert — official v280 `[ge,Ge,we]` order, Byline " · " separators
    expect(out).toContain('↑/↓ to select · Enter to continue · Esc to cancel')
  })
})
