import { describe, expect, test } from 'bun:test'
import { findDerivableClaudeMdSections } from '../doctorContextWarnings.js'

describe('findDerivableClaudeMdSections (2.1.206 #2)', () => {
  test('detects "## Project Structure" header', () => {
    const files = [
      {
        path: 'CLAUDE.md',
        content: '# My Project\n\n## Project Structure\n\nsrc/ — source\n',
      },
    ]
    const result = findDerivableClaudeMdSections(files)
    expect(result).toHaveLength(1)
    expect(result[0]!.path).toBe('CLAUDE.md')
    expect(result[0]!.header).toBe('## Project Structure')
    expect(result[0]!.reason).toMatch(/filesystem/)
  })

  test('detects "## File Structure" header', () => {
    const result = findDerivableClaudeMdSections([
      { path: 'a.md', content: '## File Structure\n\nfoo\n' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.header).toBe('## File Structure')
  })

  test('detects "## Directory Structure" header', () => {
    const result = findDerivableClaudeMdSections([
      { path: 'a.md', content: '## Directory Structure\n\nfoo\n' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.header).toBe('## Directory Structure')
  })

  test('detects "## Folder Structure" header', () => {
    const result = findDerivableClaudeMdSections([
      { path: 'a.md', content: '## Folder Structure\n\nfoo\n' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.header).toBe('## Folder Structure')
  })

  test('detects bare "## Directory" header', () => {
    const result = findDerivableClaudeMdSections([
      { path: 'a.md', content: '## Directory\n\nfoo\n' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.header).toBe('## Directory')
  })

  test('detects "## Dependencies" header with package-manifest reason', () => {
    const result = findDerivableClaudeMdSections([
      { path: 'a.md', content: '## Dependencies\n\nfoo\n' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.header).toBe('## Dependencies')
    expect(result[0]!.reason).toMatch(/package manifest/)
  })

  test('detects "## Tech Stack" and "## Stack" headers', () => {
    const result = findDerivableClaudeMdSections([
      { path: 'a.md', content: '## Tech Stack\n\nfoo\n' },
      { path: 'b.md', content: '## Stack\n\nbar\n' },
    ])
    expect(result).toHaveLength(2)
    expect(result.map(r => r.header).sort()).toEqual([
      '## Stack',
      '## Tech Stack',
    ])
  })

  test('flags "## Commands" only when body restates package-manager scripts', () => {
    const result = findDerivableClaudeMdSections([
      {
        path: 'a.md',
        content: '## Commands\n\n- `npm run build`\n- `bun test`\n',
      },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.header).toBe('## Commands')
    expect(result[0]!.reason).toMatch(/package.json scripts/)
  })

  test('flags "## Scripts" with npm invocation', () => {
    const result = findDerivableClaudeMdSections([
      { path: 'a.md', content: '## Scripts\n\n`yarn dev`\n' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.header).toBe('## Scripts')
  })

  test('flags "## Build Commands" with make invocation', () => {
    const result = findDerivableClaudeMdSections([
      { path: 'a.md', content: '## Build Commands\n\n`make build`\n' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.header).toBe('## Build Commands')
  })

  test('does NOT flag "## Commands" when body has no package-manager invocations', () => {
    const result = findDerivableClaudeMdSections([
      {
        path: 'a.md',
        content: '## Commands\n\nUse the slash menu to run workflows.\n',
      },
    ])
    expect(result).toHaveLength(0)
  })

  test('does not match "# Project Structure" (single-hash is not a section)', () => {
    const result = findDerivableClaudeMdSections([
      { path: 'a.md', content: '# Project Structure\n\nfoo\n' },
    ])
    expect(result).toHaveLength(0)
  })

  test('matches headers case-insensitively', () => {
    const result = findDerivableClaudeMdSections([
      { path: 'a.md', content: '## project structure\n\nfoo\n' },
      { path: 'b.md', content: '## PROJECT STRUCTURE\n\nfoo\n' },
      { path: 'c.md', content: '## Dependencies\n\nfoo\n' },
    ])
    expect(result).toHaveLength(3)
  })

  test('returns empty array when no derivable headers present', () => {
    const result = findDerivableClaudeMdSections([
      {
        path: 'a.md',
        content: '# Title\n\n## Notes\n\nSome non-derivable notes.\n',
      },
    ])
    expect(result).toEqual([])
  })

  test('returns empty array for empty file list', () => {
    const result = findDerivableClaudeMdSections([])
    expect(result).toEqual([])
  })

  test('aggregates across multiple files with correct path on each result', () => {
    const result = findDerivableClaudeMdSections([
      { path: 'CLAUDE.md', content: '## Project Structure\n\nx\n' },
      { path: 'sub/CLAUDE.md', content: '## Dependencies\n\ny\n' },
    ])
    expect(result).toHaveLength(2)
    const paths = result.map(r => r.path).sort()
    expect(paths).toEqual(['CLAUDE.md', 'sub/CLAUDE.md'])
  })

  test('section body stops at next ## header (does not swallow next section)', () => {
    // Commands section body is just `npm run build`; the following
    // "## Notes" header must terminate it. Even though "## Notes" body
    // could contain a PM cmd, the Commands section is already closed.
    const result = findDerivableClaudeMdSections([
      {
        path: 'a.md',
        content:
          '## Commands\n\n`npm run build`\n\n## Notes\n\nThis is fine.\n',
      },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.header).toBe('## Commands')
  })

  test('detects multiple derivable sections within a single file', () => {
    const result = findDerivableClaudeMdSections([
      {
        path: 'a.md',
        content:
          '## Project Structure\n\nsrc/\n\n## Commands\n\n`npm run build`\n\n## Dependencies\n\nfoo\n',
      },
    ])
    expect(result).toHaveLength(3)
    expect(result.map(r => r.header)).toEqual([
      '## Project Structure',
      '## Commands',
      '## Dependencies',
    ])
  })

  test('header with trailing text after the title is not matched', () => {
    // "## Project Structure Overview" is a different header (extra words).
    const result = findDerivableClaudeMdSections([
      { path: 'a.md', content: '## Project Structure Overview\n\nsrc/\n' },
    ])
    expect(result).toHaveLength(0)
  })
})
