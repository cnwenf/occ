import { describe, expect, test } from 'bun:test'
import {
  isDangerousRmPattern,
  isBackgroundAmpPattern,
  shouldAutoDenyInAutoMode,
  _resetDenialsForTesting,
} from '../../src/utils/autoModeDenials.js'

/**
 * CC 2.1.218 #27: auto mode — the dangerous-rm and background-`&` checks
 * no longer open permission dialogs (auto handles them instead of prompting).
 *
 * In the official binary, `background_amp` is a compound-statement type
 * detected by `/(^|[^&])&\s*$/m`, and `dangerousPatterns` is a function
 * that flags rm -rf targeting root/home. Previously these forced a
 * permission dialog (behavior: 'ask'); in auto mode the classifier
 * auto-decides them instead.
 *
 * Binary evidence:
 *   - `if(/(^|[^&])&\s*$/m.test(e))return"background_amp"`
 *   - `dangerousPatterns` function name
 *   - OCC `findDestructiveCommandBlock` / `findCatastrophicSubstitutionBlock`
 *     already hard-deny catastrophic removals; these new patterns cover the
 *     non-catastrophic dangerous-rm + background-& that previously prompted.
 */
describe('CC 2.1.218 #27: auto-mode auto-deny patterns', () => {
  test('isDangerousRmPattern detects rm -rf targeting root or home', () => {
    expect(isDangerousRmPattern('rm -rf /')).toBe(true)
    expect(isDangerousRmPattern('rm -rf ~')).toBe(true)
    expect(isDangerousRmPattern('rm -rf /*')).toBe(true)
    expect(isDangerousRmPattern('rm -rf ~/')).toBe(true)
    expect(isDangerousRmPattern('rm -rf $HOME')).toBe(true)
    expect(isDangerousRmPattern('rm -rf $UNSET/*')).toBe(true)
  })

  test('isDangerousRmPattern does not flag safe rm commands', () => {
    expect(isDangerousRmPattern('rm file.txt')).toBe(false)
    expect(isDangerousRmPattern('rm -rf build/')).toBe(false)
    expect(isDangerousRmPattern('rm -rf node_modules')).toBe(false)
    expect(isDangerousRmPattern('echo hello')).toBe(false)
    expect(isDangerousRmPattern('')).toBe(false)
  })

  test('isBackgroundAmpPattern detects trailing & (background process)', () => {
    expect(isBackgroundAmpPattern('sleep 100 &')).toBe(true)
    expect(isBackgroundAmpPattern('long-running-task &')).toBe(true)
    expect(isBackgroundAmpPattern('foo && bar')).toBe(false) // && is not background
    expect(isBackgroundAmpPattern('foo & bar')).toBe(false) // & mid-command is not background
    expect(isBackgroundAmpPattern('echo hello')).toBe(false)
    expect(isBackgroundAmpPattern('')).toBe(false)
  })

  test('shouldAutoDenyInAutoMode denies dangerous-rm in auto mode', () => {
    _resetDenialsForTesting()
    const result = shouldAutoDenyInAutoMode('Bash', 'rm -rf /')
    expect(result.deny).toBe(true)
    expect(result.reason).toContain('dangerous')
  })

  test('shouldAutoDenyInAutoMode denies background-& in auto mode', () => {
    _resetDenialsForTesting()
    const result = shouldAutoDenyInAutoMode('Bash', 'sleep 100 &')
    expect(result.deny).toBe(true)
    expect(result.reason).toContain('background')
  })

  test('shouldAutoDenyInAutoMode does not deny safe commands', () => {
    _resetDenialsForTesting()
    const result = shouldAutoDenyInAutoMode('Bash', 'ls -la')
    expect(result.deny).toBe(false)
  })

  test('shouldAutoDenyInAutoMode records denial when auto-denying', () => {
    _resetDenialsForTesting()
    shouldAutoDenyInAutoMode('Bash', 'rm -rf /')
    const { getAutoModeDenials } = require('../../src/utils/autoModeDenials.js')
    const denials = getAutoModeDenials()
    expect(denials.length).toBe(1)
    expect(denials[0].toolName).toBe('Bash')
    expect(denials[0].reason).toContain('dangerous')
  })
})
