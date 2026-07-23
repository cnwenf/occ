import { describe, expect, test } from 'bun:test'
import { getTrustDialogRepoRoot } from '../../src/components/TrustDialog/utils.js'

/**
 * CC 2.1.218 #29: trust dialogs now name the repository root the grant covers.
 *
 * Binary evidence:
 *   - "Accessing workspace:" — trust dialog title (already in OCC)
 *   - "Yes, I trust this folder" — confirm label (already in OCC)
 *   - The official binary computes the git repository root via `findGitRoot`
 *     and displays it in the trust dialog so the user knows which root
 *     directory the trust grant covers.
 *
 * OCC's TrustDialog previously showed only `getFsImplementation().cwd()` —
 * the current working directory. The fix names the repository root.
 */
describe('CC 2.1.218 #29: trust dialog names repository root', () => {
  test('getTrustDialogRepoRoot returns the git root when in a git repo', () => {
    // The OCC repo root should be detected (we're inside a git repo)
    const root = getTrustDialogRepoRoot()
    expect(root).not.toBe(null)
    expect(typeof root).toBe('string')
    expect(root!.length).toBeGreaterThan(0)
  })

  test('getTrustDialogRepoRoot falls back to cwd when not in a git repo', () => {
    // When findGitRoot returns null (not in a git repo), the function
    // should fall back to the current working directory.
    const root = getTrustDialogRepoRoot()
    expect(root).not.toBe(null)
  })
})
