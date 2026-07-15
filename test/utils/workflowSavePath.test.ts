import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../src/utils/envUtils.js'
import {
  displayWorkflowPath,
  resolveWorkflowFilePath,
  resolveWorkflowsDir,
  tildeShortenPath,
  userWorkflowsDir,
} from '../../src/utils/effort/workflowSavePath.js'

// getClaudeConfigHomeDir is memoized on the CLAUDE_CONFIG_DIR env value, so
// each test points it at a fresh temp dir and clears the cache (same
// pattern as test/utils/fable.test.ts).
const PREV_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
let tmpConfigDir: string

function resetConfigDirCache(): void {
  getClaudeConfigHomeDir.cache.clear()
}

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'wf-save-path-'))
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  resetConfigDirCache()
})

afterEach(() => {
  resetConfigDirCache()
  rmSync(tmpConfigDir, { recursive: true, force: true })
  if (PREV_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = PREV_CONFIG_DIR
  resetConfigDirCache()
})

describe('workflowSavePath — 2.1.208 #25 CLAUDE_CONFIG_DIR fix', () => {
  describe('resolveWorkflowsDir', () => {
    test('user scope resolves under CLAUDE_CONFIG_DIR, not ~/.claude', () => {
      // Arrange
      const cwd = '/some/project'

      // Act
      const dir = resolveWorkflowsDir('user', cwd)

      // Assert — honors the effective config dir, ignores cwd.
      expect(dir).toBe(join(tmpConfigDir, 'workflows'))
      expect(dir).not.toContain(join('/.claude', 'workflows'))
    })

    test('project scope resolves under the project cwd', () => {
      // Arrange
      const cwd = '/work/myproj'

      // Act
      const dir = resolveWorkflowsDir('project', cwd)

      // Assert
      expect(dir).toBe(join('/work/myproj', '.claude', 'workflows'))
    })

    test('user scope changes when CLAUDE_CONFIG_DIR changes', () => {
      // Arrange — first config dir
      const dir1 = resolveWorkflowsDir('user', '/cwd')
      expect(dir1).toBe(join(tmpConfigDir, 'workflows'))

      // Act — relocate the config dir
      const other = mkdtempSync(join(tmpdir(), 'wf-save-path-other-'))
      process.env.CLAUDE_CONFIG_DIR = other
      resetConfigDirCache()
      const dir2 = resolveWorkflowsDir('user', '/cwd')

      // Assert — follows the env var, not a hardcoded ~/.claude
      expect(dir2).toBe(join(other, 'workflows'))
      expect(dir2).not.toBe(dir1)
      rmSync(other, { recursive: true, force: true })
    })
  })

  describe('displayWorkflowPath', () => {
    test('user scope with custom CLAUDE_CONFIG_DIR displays the temp dir verbatim, not ~/.claude', () => {
      // Arrange
      const name = 'cleanup'

      // Act
      const display = displayWorkflowPath('user', name, '/cwd')

      // Assert — the 2.1.208 fix: shows CLAUDE_CONFIG_DIR location.
      expect(display).toBe(join(tmpConfigDir, 'workflows', 'cleanup.js'))
      // Must NOT regress to the hardcoded pre-fix string.
      expect(display).not.toBe('~/.claude/workflows/cleanup.js')
      expect(display).not.toContain('~/.claude')
    })

    test('project scope displays the relative .claude/workflows path', () => {
      // Arrange
      const name = 'build'

      // Act
      const display = displayWorkflowPath('project', name, '/cwd')

      // Assert — matches the binary's project ternary branch.
      expect(display).toBe('.claude/workflows/build.js')
    })

    test('user scope with default config dir (no CLAUDE_CONFIG_DIR) tilde-shortens', () => {
      // Arrange — simulate the default (unset) config dir.
      delete process.env.CLAUDE_CONFIG_DIR
      resetConfigDirCache()
      const home = require('os').homedir()
      const name = 'deploy'

      // Act
      const display = displayWorkflowPath('user', name, '/cwd')

      // Assert — default dir is ~/.claude → tilde-shortened to
      // ~/.claude/workflows/<name>.js. This matches the pre-fix DISPLAY
      // string only because the default config dir IS ~/.claude; the fix
      // matters when CLAUDE_CONFIG_DIR points elsewhere (covered above).
      expect(display).toBe(`~/.claude/workflows/deploy.js`)
      expect(display.startsWith('~')).toBe(true)
    })
  })

  describe('resolveWorkflowFilePath (end-to-end save path)', () => {
    test('user-scope file lands under CLAUDE_CONFIG_DIR/workflows', () => {
      // Arrange
      const cwd = '/proj'
      const name = 'release'

      // Act
      const filePath = resolveWorkflowFilePath('user', name, cwd)

      // Assert — actual write target honors the config dir.
      expect(filePath).toBe(join(tmpConfigDir, 'workflows', 'release.js'))
      // And the parent dir actually receives the file when written.
      mkdirSync(join(tmpConfigDir, 'workflows'), { recursive: true })
      writeFileSync(filePath, '// test', 'utf8')
      expect(existsSync(filePath)).toBe(true)
      expect(readFileSync(filePath, 'utf8')).toBe('// test')
    })
  })

  describe('tildeShortenPath', () => {
    test('replaces homedir prefix with ~', () => {
      const home = require('os').homedir()
      expect(tildeShortenPath(home)).toBe('~')
      expect(tildeShortenPath(join(home, 'x', 'y.js'))).toBe('~/x/y.js')
    })

    test('leaves paths outside homedir unchanged', () => {
      expect(tildeShortenPath('/tmp/custom/workflows/foo.js')).toBe(
        '/tmp/custom/workflows/foo.js',
      )
    })
  })

  describe('userWorkflowsDir', () => {
    test('equals join(getClaudeConfigHomeDir, workflows)', () => {
      expect(userWorkflowsDir()).toBe(join(getClaudeConfigHomeDir(), 'workflows'))
    })
  })
})
