import { describe, expect, test } from 'bun:test'
import { extensionForMimeType } from '../mcpOutputStorage.js'

/**
 * CC 2.1.295 (item 4) — "MCP resources with CSS/JS/XML content types were
 * persisted as .bin" fix.
 *
 * Binary evidence (/tmp/cc295/ev/ext_map_css.txt, official ext→mime map `R`):
 *
 *   var R={".html":"text/html",".css":"text/css",".js":"text/javascript",
 *     ".mjs":"text/javascript",...,".xml":"application/xml",
 *     ".avif":"image/avif",".ico":"image/vnd.microsoft.icon",
 *     ".woff":"font/woff",".woff2":"font/woff2",".ttf":"font/ttf",
 *     ".otf":"font/otf",...,".wasm":"application/wasm",...};
 *   function N4(t){return R[dLn(h(t))]}
 *
 * OCC's extensionForMimeType is the REVERSE mapping (mime→ext) used when
 * persisting MCP binary blobs; these tests assert every new official entry
 * resolves to its proper extension instead of falling through to 'bin'.
 */
describe('extensionForMimeType — 2.1.295 ext map additions', () => {
  test.each([
    ['text/css', 'css'],
    ['text/javascript', 'js'],
    ['application/xml', 'xml'],
    ['image/avif', 'avif'],
    ['image/vnd.microsoft.icon', 'ico'],
    ['font/woff', 'woff'],
    ['font/woff2', 'woff2'],
    ['font/ttf', 'ttf'],
    ['font/otf', 'otf'],
    ['application/wasm', 'wasm'],
  ])('maps %s to .%s instead of .bin', (mimeType, expectedExt) => {
    // Act
    const ext = extensionForMimeType(mimeType)

    // Assert
    expect(ext).toBe(expectedExt)
    expect(ext).not.toBe('bin')
  })

  test('strips a charset parameter before mapping the new types', () => {
    // Act + Assert
    expect(extensionForMimeType('text/css; charset=utf-8')).toBe('css')
    expect(extensionForMimeType('text/javascript;charset=UTF-8')).toBe('js')
    expect(extensionForMimeType('application/xml; boundary=x')).toBe('xml')
  })

  test('is case-insensitive for the new types', () => {
    // Act + Assert
    expect(extensionForMimeType('TEXT/CSS')).toBe('css')
    expect(extensionForMimeType('Font/WOFF2')).toBe('woff2')
    expect(extensionForMimeType('Application/WASM')).toBe('wasm')
  })

  test('leaves pre-existing mappings unchanged', () => {
    // Act + Assert — sample of the mappings that existed before 2.1.295
    expect(extensionForMimeType('application/pdf')).toBe('pdf')
    expect(extensionForMimeType('application/json')).toBe('json')
    expect(extensionForMimeType('text/csv')).toBe('csv')
    expect(extensionForMimeType('text/plain')).toBe('txt')
    expect(extensionForMimeType('text/html')).toBe('html')
    expect(extensionForMimeType('text/markdown')).toBe('md')
    expect(extensionForMimeType('image/png')).toBe('png')
    expect(extensionForMimeType('image/jpeg')).toBe('jpg')
    expect(extensionForMimeType('image/svg+xml')).toBe('svg')
    expect(extensionForMimeType('video/webm')).toBe('webm')
  })

  test('still falls back to bin for unknown or missing types', () => {
    // Act + Assert
    expect(extensionForMimeType(undefined)).toBe('bin')
    expect(extensionForMimeType('')).toBe('bin')
    expect(extensionForMimeType('application/octet-stream')).toBe('bin')
    expect(extensionForMimeType('model/gltf-binary')).toBe('bin')
  })
})
