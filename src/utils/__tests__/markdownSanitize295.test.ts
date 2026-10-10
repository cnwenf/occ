/**
 * CC 2.1.295 changelog #050 + #031 — P0 render-security wiring tests.
 *
 * > #050 - Fixed raw terminal hyperlink bytes in a reply or a teammate's
 * >        message being drawn as a clickable link with a hidden address
 * > #031 - Fixed a link address shown as text being hidden by a colour or
 * >        conceal style a reply left on, including where it wraps in a table
 * >        or a question preview
 *
 * These tests pin the WIRING of src/utils/markdownSanitize.ts (the transcribed
 * official `Ecn`/`H`/`Fe`/`X`/`De`/`ue` helpers) into the render path:
 *   • applyMarkdown  (official TNt @220898004 — `Ecn(iXe(...))` wraps BOTH the
 *                     windowed and the whole-text-safe lex)
 *   • cachedLexer    (official xn  @231692124 — `Ecn(Vr(i))` fast path and
 *                     `Ecn(zr(...))` real lex, memoized sanitized)
 *   • formatToken image case (official case"image" @220900053)
 *   • formatToken link case  (official case"link" @220900053+, #031-critical)
 *   • createHyperlink shownUrlStart (official rw @220883281 draw-as-text branch)
 *
 * Every assertion is byte-traced to the official 2.1.295 linux-x64 bundle
 * (md5-verified ELF read through a PROT_READ mmap — never executed). No
 * behavior is invented here.
 */
import { describe, expect, test } from 'bun:test'
import { Marked, type Token } from 'marked'
import stripAnsi from 'strip-ansi'
import { supportsHyperlinks } from '../../ink/supports-hyperlinks.ts'
import { createHyperlink } from '../hyperlink.ts'
import { applyMarkdown, formatToken } from '../markdown.ts'
import {
  afterStyleReset,
  CONTROL_BYTES,
  sanitizeMarkdownTokens,
  shownAddress,
  shownAddressWithTitle,
  stripControlBytes,
  stripRenderInvisible,
  STYLE_RESET_BEFORE_ADDRESS,
} from '../markdownSanitize.ts'
import { lexWithWindowing } from '../markdownWindowed.ts'

/** Control/invisible bytes spelled as escapes so this file stays pure ASCII. */
const ESC = '\x1b'
const BEL = '\x07'
const ZWSP = '\u200b' // U+200B ZERO WIDTH SPACE — code 8203, in eC's 8203..8207 band
const OSC8 = `${ESC}]8;;`

/** A raw OSC 8 terminal hyperlink: ESC ] 8 ; ; URL BEL TEXT ESC ] 8 ; ; BEL. */
function osc8(url: string, text: string): string {
  return `${OSC8}${url}${BEL}${text}${OSC8}${BEL}`
}

/** Build a minimal marked-shaped text token (cast — tsc is not part of CI). */
function textToken(text: string): Token {
  return { type: 'text', raw: text, text } as unknown as Token
}

/** Build a minimal marked-shaped link token. */
function linkToken(
  href: string,
  text: string,
  extra: Record<string, unknown> = {},
): Token {
  return {
    type: 'link',
    raw: `[${text}](${href})`,
    href,
    title: null,
    text,
    tokens: [textToken(text)],
    ...extra,
  } as unknown as Token
}

/** Build a minimal marked-shaped image token. */
function imageToken(
  href: string,
  extra: Record<string, unknown> = {},
): Token {
  return {
    type: 'image',
    raw: `![](${href})`,
    href,
    title: null,
    text: '',
    tokens: [],
    ...extra,
  } as unknown as Token
}

describe('295 #050 — OSC 8 raw hyperlink bytes neutralized to inert text', () => {
  test('sanitizer deletes the ESC/BEL of a raw OSC 8 link, leaving inert visible text', () => {
    // Arrange — a reply carrying raw terminal hyperlink bytes (NOT markdown
    // link syntax), the exact #050 attack: a clickable link whose address the
    // reader never sees.
    const raw = `before ${osc8('https://evil.example', 'click')} after`

    // Act
    const [sanitized] = sanitizeMarkdownTokens([textToken(raw)]) as [
      { text: string },
    ]

    // Assert — no OSC 8 introducer survives; the residue is inert text.
    expect(sanitized.text).not.toContain(OSC8)
    expect(sanitized.text).not.toContain(ESC)
    expect(sanitized.text).not.toContain(BEL)
    expect(sanitized.text).toContain(']8;;https://evil.example')
    expect(sanitized.text).toContain('click')
  })

  test('applyMarkdown end-to-end emits no OSC 8 for a hostile hyperlink payload', () => {
    // Arrange — the required end-to-end payload.
    const hostile = osc8('http://evil', 'click')

    // Act
    const out = applyMarkdown(`before ${hostile} after`, 'dark')

    // Assert — no clickable OSC 8 link reaches the terminal.
    expect(out).not.toContain(OSC8)
    expect(out).not.toContain(`${ESC}]8;`)
    expect(stripAnsi(out)).toContain('click')
  })

  test('OSC 8 in the whole-text-safe path is neutralized too (Ecn wraps iXe, both paths)', () => {
    // Arrange — a SMALL doc takes marked's whole-text-safe lexer, not the
    // windowed one. Official TNt wraps `iXe` (which covers both) in `Ecn`, so
    // the safe path must be sanitized identically. This is the assertion that
    // supersedes the pre-#050 markdownWindowed295 expectation that the safe
    // path kept its OSC 8 bytes.
    const small = applyMarkdown(osc8('https://evil.example', 'click'), 'dark')

    // Act / Assert
    expect(small).not.toContain(`${ESC}]8;`)
  })
})

describe('295 #050 — SGR styling preserved while control bytes are dropped', () => {
  test('a surviving SGR is kept and flags link/image tokens afterStyle', () => {
    // Arrange — an SGR (colour) the model legitimately authored, next to a link.
    const marked = new Marked()
    const doc = `${ESC}[31mred${ESC}[0m and [click me](http://x.example/path)`

    // Act
    const tokens = sanitizeMarkdownTokens(marked.lexer(doc))

    // Assert — the SGR survives (styling preserved), and the link is flagged
    // afterStyle so the renderer answers with Fe before any drawn address.
    const textTok = findToken(tokens, 'text') as { text: string } | null
    expect(textTok).not.toBeNull()
    expect((textTok as { text: string }).text).toContain(`${ESC}[31m`)
    const link = findToken(tokens, 'link')
    expect(link).not.toBeNull()
    expect(afterStyleReset(link as Token)).toBe(STYLE_RESET_BEFORE_ADDRESS)
  })

  test('stripControlBytes keeps SGR introducers but drops OSC 8 / bare control bytes', () => {
    // Arrange / Act
    const cleaned = stripControlBytes(
      `${ESC}[1mbold${ESC}[22m ${OSC8}http://evil${BEL}x${OSC8}${BEL}`,
    )

    // Assert — SGR kept, OSC 8 ESC + BEL gone.
    expect(cleaned).toContain(`${ESC}[1m`)
    expect(cleaned).toContain(`${ESC}[22m`)
    expect(cleaned).not.toContain(OSC8)
    expect(cleaned).not.toContain(BEL)
  })
})

describe('295 #050 — CR folded to LF', () => {
  test('CRLF and lone CR are both folded to LF so a CR can never rewind a line', () => {
    // Arrange / Act
    const folded = stripControlBytes('a\r\nb\rc')

    // Assert
    expect(folded).toBe('a\nb\nc')
    expect(folded).not.toContain('\r')
  })

  test('the sanitizer folds CR inside token text', () => {
    // Arrange / Act
    const [sanitized] = sanitizeMarkdownTokens([
      textToken('line1\r\nline2\rline3'),
    ]) as [{ text: string }]

    // Assert
    expect(sanitized.text).toBe('line1\nline2\nline3')
  })
})

describe('295 #031 — href is NOT cleaned by the sanitizer but IS stripped at draw time', () => {
  test('sanitizeMarkdownTokens leaves href bytes intact (the OSC 8 target must survive)', () => {
    // Arrange — a link whose href carries an invisible code point.
    const href = `http://x${ZWSP}.evil/path`

    // Act
    const [sanitized] = sanitizeMarkdownTokens([linkToken(href, 'click')]) as [
      { href: string },
    ]

    // Assert — official `Ecn` excludes `href` from cleaning (`i!=="href"`), so
    // the ZWSP is still present in the token after sanitizing.
    expect(sanitized.href).toBe(href)
    expect(sanitized.href).toContain(ZWSP)
  })

  test('stripRenderInvisible / shownAddress drop the invisible byte at draw time', () => {
    // Arrange
    const href = `http://x${ZWSP}.evil/path`

    // Act
    const stripped = stripRenderInvisible(href)
    const drawn = shownAddress(href, '')

    // Assert — the address shown to the reader has the invisible byte removed.
    expect(stripped).toBe('http://x.evil/path')
    expect(stripped).not.toContain(ZWSP)
    expect(drawn).toBe('http://x.evil/path')
  })

  test('shownAddressWithTitle prefixes the style reset and wraps the stripped address', () => {
    // Arrange / Act — official `ue` = `${t} (${H(e)}${n})`.
    const out = shownAddressWithTitle(`http://x${ZWSP}.evil`, STYLE_RESET_BEFORE_ADDRESS, ' "t"')

    // Assert
    expect(out).toBe(`${STYLE_RESET_BEFORE_ADDRESS} (http://x.evil "t")`)
  })
})

describe('295 #050 — identity fast-path (clean tree returned by same reference)', () => {
  test('a control-byte-free token tree is returned by identity (no rebuild)', () => {
    // Arrange
    const marked = new Marked()
    const clean = marked.lexer('# Head\n\npara with **bold** and [a](http://x.y)')

    // Act
    const result = sanitizeMarkdownTokens(clean)

    // Assert — same reference: an already-clean tree is a pure pass-through,
    // which is what makes clean-doc rendering byte-identical to before #050.
    expect(result).toBe(clean)
  })

  test('the gate is CONTROL_BYTES.test(raw) — a control byte forces a rebuild', () => {
    // Arrange
    const marked = new Marked()
    const dirty = marked.lexer(`before ${osc8('http://evil', 'click')} after`)

    // Act
    const result = sanitizeMarkdownTokens(dirty)

    // Assert — new reference (rebuilt), and the CONTROL_BYTES gate agrees.
    expect(result).not.toBe(dirty)
    expect(CONTROL_BYTES.test(dirty[0].raw)).toBe(true)
  })
})

describe('295 #031 — image case emits style-reset + stripped address when afterStyle flagged', () => {
  test('no text / no title → De(href, Fe): reset then invisible-stripped address', () => {
    // Arrange — official case"image": `if(!e.text&&!e.title)return De(e.href,X(e))`.
    const img = imageToken(`http://a${ZWSP}.evil/p.png`, { afterStyle: true })

    // Act
    const out = formatToken(img, 'dark')

    // Assert — Fe (reveal + default fg/bg) precedes the stripped address.
    expect(out).toBe(`${STYLE_RESET_BEFORE_ADDRESS}http://a.evil/p.png`)
    expect(out).toContain(STYLE_RESET_BEFORE_ADDRESS)
    expect(out).not.toContain(ZWSP)
  })

  test('with alt text → text + ue(href, Fe) (address in parens after the text)', () => {
    // Arrange
    const img = imageToken('http://a.evil/p.png', { text: 'alt', afterStyle: true })

    // Act
    const out = formatToken(img, 'dark')

    // Assert
    expect(out).toBe(
      `alt${STYLE_RESET_BEFORE_ADDRESS} (http://a.evil/p.png)`,
    )
  })

  test('not flagged afterStyle → no reset prefix (clean doc unchanged)', () => {
    // Arrange — a clean image token (no surviving SGR) is never flagged.
    const img = imageToken('http://a.evil/p.png')

    // Act
    const out = formatToken(img, 'dark')

    // Assert — no Fe, address shown bare (identity behavior preserved).
    expect(out).toBe('http://a.evil/p.png')
    expect(out).not.toContain(STYLE_RESET_BEFORE_ADDRESS)
    expect(afterStyleReset(img)).toBe('')
  })
})

describe('295 #031 — link case routes the reset to drawn addresses', () => {
  test('mailto with differing text → text + ue(email, Fe) (official mailto branch)', () => {
    // Arrange
    const link = linkToken('mailto:a@b.com', 'email me')

    // Act
    const out = formatToken(link, 'dark')

    // Assert — visible text is `email me (a@b.com)` (Fe stripped by stripAnsi).
    expect(stripAnsi(out)).toBe('email me (a@b.com)')
  })

  test('mailto whose text equals the address → De(email, Fe): reset then bare address', () => {
    // Arrange
    const link = linkToken('mailto:a@b.com', 'a@b.com')

    // Act
    const out = formatToken(link, 'dark')

    // Assert
    expect(stripAnsi(out)).toBe('a@b.com')
  })

  test('MAILTO detection is case-insensitive (official /^mailto:/i)', () => {
    // Arrange — uppercase scheme; the pre-port OCC check was case-sensitive.
    const link = linkToken('MAILTO:a@b.com', 'a@b.com')

    // Act
    const out = formatToken(link, 'dark')

    // Assert — treated as mailto (no clickable link, address drawn as text).
    expect(stripAnsi(out)).toBe('a@b.com')
    expect(out).not.toContain(OSC8)
  })

  test('a styled link draws its address with the Fe reset and no invisible byte', () => {
    // Arrange — an SGR surviving next to a link flags it afterStyle; the href
    // carries a ZWSP that must not reach the reader.
    const marked = new Marked()
    const doc = `${ESC}[31mred${ESC}[0m [click](http://x${ZWSP}.evil/p)`
    const supported = supportsHyperlinks()

    // Act
    const out = applyMarkdown(doc, 'dark')

    // Assert — branch on terminal capability (both are #031-safe):
    if (supported) {
      // OSC 8 branch: the address lives inside the escape (hoverable), the
      // drawn text carries no hidden address, and no stray reset leaks.
      expect(out).toContain(OSC8)
    } else {
      // Drawn-as-text branch: Fe reset precedes the invisible-stripped address.
      expect(out).toContain(STYLE_RESET_BEFORE_ADDRESS)
      expect(stripAnsi(out)).not.toContain(ZWSP)
    }
    // In both branches the model's SGR styling is preserved (#050).
    expect(out).toContain(`${ESC}[31m`)
  })
})

describe('295 #031 — createHyperlink shownUrlStart (draw-as-text branch only)', () => {
  test('unsupported terminal: shownUrlStart prefixes the drawn address', () => {
    // Arrange / Act — official rw @220883281: `return `${i}${e}`` (i=shownUrlStart).
    const out = createHyperlink('http://a.evil', undefined, {
      shownUrlStart: STYLE_RESET_BEFORE_ADDRESS,
      supportsHyperlinks: false,
    })

    // Assert
    expect(out).toBe(`${STYLE_RESET_BEFORE_ADDRESS}http://a.evil`)
  })

  test('supported terminal: OSC 8 branch does NOT emit shownUrlStart (address is in the escape)', () => {
    // Arrange / Act
    const out = createHyperlink('http://a.evil', 'text', {
      shownUrlStart: STYLE_RESET_BEFORE_ADDRESS,
      supportsHyperlinks: true,
    })

    // Assert — reset is not prepended; the OSC 8 sequence is intact.
    expect(out.startsWith(STYLE_RESET_BEFORE_ADDRESS)).toBe(false)
    expect(out).toContain(OSC8)
    expect(out).toContain('http://a.evil')
  })

  test('default (no shownUrlStart) is byte-identical to the pre-#031 contract', () => {
    // Arrange / Act — existing callers (linkifyIssueReferences, sign-in) pass no
    // shownUrlStart, so the unsupported branch must still return the bare url.
    const out = createHyperlink('http://a.evil', 'text', {
      supportsHyperlinks: false,
    })

    // Assert
    expect(out).toBe('http://a.evil')
  })
})

describe('295 #050 — clean docs render byte-identical (regression guard)', () => {
  // Visible-text goldens captured from applyMarkdown BEFORE the #050/#031
  // wiring. Because clean docs hit the identity fast-path (proven above), the
  // token tree reaching the renderer is the same reference as before, so these
  // outputs are byte-identical post-change; stripAnsi makes the comparison
  // independent of the environment's chalk level.
  const GOLDENS: ReadonlyArray<readonly [string, string]> = [
    ['# Head\n\npara', 'Head\n\npara'],
    ['**bold**', 'bold'],
    ['- a\n- b\n', '- a\n- b'],
    ['1. one\n2. two\n', '1. one\n2. two'],
    ['> quoted\n', '▎ quoted'],
    ['```js\nconst x=1\n```\n', 'const x=1'],
    ['use `x` here', 'use x here'],
    ['| a | b |\n|---|---|\n| 1 | 2 |\n', '| a   | b   |\n|-----|-----|\n| 1   | 2   |'],
    ['*em* text', 'em text'],
    ['---\n', '---'],
    ['just plain text', 'just plain text'],
  ]

  test('every clean doc renders to its pre-#050 visible golden', () => {
    for (const [doc, expected] of GOLDENS) {
      // Act
      const out = applyMarkdown(doc, 'dark')

      // Assert
      expect(stripAnsi(out)).toBe(expected)
    }
  })

  test('every clean doc lexes to an identity-preserved (unrebuilt) token tree', () => {
    // Arrange
    const marked = new Marked()
    for (const [doc] of GOLDENS) {
      // Act
      const tokens = lexWithWindowing(marked, doc)

      // Assert — the sanitizer is a pure pass-through for control-byte-free
      // docs, so applyMarkdown's input is byte-identical to before the wiring.
      expect(sanitizeMarkdownTokens(tokens)).toBe(tokens)
    }
  })
})

/** Depth-first search for the first token of a given type. */
function findToken(tokens: readonly Token[], type: string): Token | null {
  for (const token of tokens) {
    if (token.type === type) return token
    const children = (token as { tokens?: Token[] }).tokens
    if (children) {
      const found = findToken(children, type)
      if (found) return found
    }
  }
  return null
}
