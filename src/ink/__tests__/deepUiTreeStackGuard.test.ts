import { describe, expect, test } from 'bun:test'
import type { DOMElement } from '../dom.js'
import { LayoutDisplay, type LayoutNode } from '../layout/node.js'
import {
  CharPool,
  HyperlinkPool,
  StylePool,
  createScreen,
} from '../screen.js'
import Output from '../output.js'
import renderNodeToOutput from '../render-node-to-output.js'

/**
 * Claude Code 2.1.218 #16 (UI-trees half): "Fixed crashes (maximum call
 * stack size exceeded) when rendering deeply nested UI trees". The
 * directory-tree half was ported in PR #204; this covers the Ink
 * RENDERING half.
 *
 * The pre-fix renderer recursed mutually:
 *   renderNodeToOutput → renderChildren → renderNodeToOutput → ...
 * Each nesting level consumed ~2 native call-stack frames, so a
 * sufficiently deep UI tree (~3–5k+ nested boxes) blew the JS stack with
 * "Maximum call stack size exceeded".
 *
 * Isolation note (mirrors PR #204's injectable-readdir seam): OCC ships
 * a pure-TypeScript yoga (`src/native-ts/yoga-layout`) whose own
 * `calculateLayout` is recursive and overflows at similar depths — a
 * confound that does not exist in official Claude Code (real C yoga, no
 * JS-stack limit). To test the RENDER recursion in isolation and
 * host-independent, the deep tree is built with stub LayoutNodes that
 * return canned non-zero computed geometry, so `calculateLayout` never
 * runs and the only thing that can overflow is the JS render descent.
 *
 * The test feeds the synthetic deep tree to BOTH:
 *   (a) a synchronous recursive DOM descent — proves the depth is
 *       sufficient to overflow sync recursion on Bun (the crash-class
 *       anchor), and
 *   (b) the production `renderNodeToOutput` (now iterative) — proves it
 *       completes without overflowing.
 */

const TERMINAL_WIDTH = 80
const TERMINAL_HEIGHT = 24
const DEEP_DEPTH = 10_000

/**
 * Stub LayoutNode returning canned non-zero geometry so the renderer
 * descends into children without invoking yoga's recursive
 * `calculateLayout`. Only the getters the renderer reads are meaningful;
 * everything else is a no-op via a Proxy.
 */
function makeStubYoga(): LayoutNode {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'getDisplay') return () => LayoutDisplay.Flex
        if (prop === 'getComputedLeft' || prop === 'getComputedTop')
          return () => 0
        if (prop === 'getComputedWidth') return () => TERMINAL_WIDTH
        if (prop === 'getComputedHeight') return () => 1
        if (prop === 'getComputedBorder' || prop === 'getComputedPadding')
          return () => 0
        if (prop === 'getParent') return () => null
        if (prop === 'getChildCount') return () => 0
        return () => {}
      },
    },
  ) as unknown as LayoutNode
}

function makeBox(): DOMElement {
  return {
    nodeName: 'ink-box',
    attributes: {},
    childNodes: [],
    parentNode: undefined,
    yogaNode: makeStubYoga(),
    style: {},
    dirty: true,
  } as unknown as DOMElement
}

function makeRoot(): DOMElement {
  return {
    nodeName: 'ink-root',
    attributes: {},
    childNodes: [],
    parentNode: undefined,
    yogaNode: makeStubYoga(),
    style: {},
    dirty: true,
  } as unknown as DOMElement
}

function buildDeepNestedTree(depth: number): {
  root: DOMElement
  deepest: DOMElement
} {
  const root = makeRoot()
  let current: DOMElement = root
  for (let i = 0; i < depth; i++) {
    const box = makeBox()
    box.parentNode = current
    current.childNodes.push(box)
    current = box
  }
  return { root, deepest: current }
}

function makeOutput(): Output {
  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  const screen = createScreen(
    TERMINAL_WIDTH,
    TERMINAL_HEIGHT,
    stylePool,
    charPool,
    hyperlinkPool,
  )
  return new Output({
    width: TERMINAL_WIDTH,
    height: TERMINAL_HEIGHT,
    stylePool,
    screen,
  })
}

/**
 * Synchronous MUTUAL-RECURSIVE DOM descent mirroring the OLD render
 * crash class: renderNodeToOutput → renderChildren → renderNodeToOutput
 * consumed ~2 native call-stack frames per nesting level. The two
 * functions (A↔B) reproduce that 2-frames-per-level shape so the chosen
 * depth reliably overflows sync recursion on Bun (the single-function
 * walk stays just under the limit at 10k — the crash needs the mutual
 * form). Proves the depth suffices to reproduce the crash class.
 */
function recursiveDescendA(node: DOMElement): void {
  for (const child of node.childNodes) {
    if (child.nodeName !== '#text') {
      recursiveDescendB(child as DOMElement)
    }
  }
}
function recursiveDescendB(node: DOMElement): void {
  for (const child of node.childNodes) {
    if (child.nodeName !== '#text') {
      recursiveDescendA(child as DOMElement)
    }
  }
}

describe('2.1.218 #16 (UI-trees half) — deeply-nested UI tree stack guard', () => {
  test('recursive descent overflows on a deep tree (crash-class anchor)', () => {
    // A 50k-level tree reliably overflows synchronous recursion on Bun
    // (host-PATH_MAX-independent), mirroring PR #204's directory-tree
    // anchor. This proves the crash class the changelog names is real at
    // these depths and that the render fix below is exercising the
    // overflow regime, not a trivially-shallow tree.
    const { root } = buildDeepNestedTree(50_000)
    expect(() => recursiveDescendA(root)).toThrow(RangeError)
  })

  test('production renderNodeToOutput completes the deep tree without overflowing', () => {
    const { root, deepest } = buildDeepNestedTree(DEEP_DEPTH)
    const output = makeOutput()

    // The iterative renderer must complete without "Maximum call stack
    // size exceeded". Before the fix this threw RangeError.
    expect(() =>
      renderNodeToOutput(root, output, { prevScreen: undefined }),
    ).not.toThrow()

    // Full-depth proof: the renderer reached the deepest node and cleared
    // its dirty flag (set at construction). Before the fix the throw
    // happened mid-descent, so the deepest node stayed dirty. This proves
    // the iterative walk did not silently truncate at a depth cap.
    expect(deepest.dirty).toBe(false)
  })

  test('iterative render scales past the overflow point (30k levels)', () => {
    const { root, deepest } = buildDeepNestedTree(30_000)
    const output = makeOutput()

    expect(() =>
      renderNodeToOutput(root, output, { prevScreen: undefined }),
    ).not.toThrow()
    expect(deepest.dirty).toBe(false)
  })
})
