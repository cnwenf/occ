import { describe, expect, test } from 'bun:test'
import { classifyGuiEditor } from './editor.js'

// 2.1.216 #16: /memory must not block on the editor closing for GUI editors
// (they open in a separate window). The routing decision hinges on
// classifyGuiEditor — a non-undefined return means the editor is a GUI
// editor that can be spawned detached (non-blocking); undefined means a
// terminal editor that needs the alt-screen blocking handoff.
describe('classifyGuiEditor', () => {
  test.each([
    ['code'],
    ['cursor'],
    ['windsurf'],
    ['codium'],
    ['subl'],
    ['notepad++'],
    ['notepad'],
  ])('classifies %s as a GUI editor', editor => {
    // Act
    const family = classifyGuiEditor(editor)

    // Assert — non-undefined => GUI editor (non-blocking spawn eligible)
    expect(family).toBeDefined()
  })

  test.each([
    ['vi'],
    ['vim'],
    ['nvim'],
    ['nano'],
    ['emacs'],
    ['micro'],
    ['helix'],
    ['hx'],
  ])('classifies %s as a terminal editor (undefined)', editor => {
    // Act
    const family = classifyGuiEditor(editor)

    // Assert — undefined => terminal editor (blocking alt-screen handoff)
    expect(family).toBeUndefined()
  })

  test('preserves code-insiders as a GUI editor via the code substring match', () => {
    // Arrange
    const editor = 'code-insiders'

    // Act
    const family = classifyGuiEditor(editor)

    // Assert — code-insiders still matches the 'code' family
    expect(family).toBe('code')
  })

  test('uses basename so a directory containing the editor name does not false-match', () => {
    // Arrange — /home/vim/bin/kak must NOT match 'vim' via the dir segment
    const editor = '/home/vim/bin/kak'

    // Act
    const family = classifyGuiEditor(editor)

    // Assert — kak is not a GUI editor; the directory 'vim' must not match
    expect(family).toBeUndefined()
  })
})
