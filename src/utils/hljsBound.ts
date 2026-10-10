/**
 * Gap-289 #2 — bounded highlight.js emitter (official v2.1.289 port).
 *
 * Official changelog: "Fixed the terminal freezing on short code blocks with
 * many unclosed `<script>` tags or deeply nested `${` substitutions."
 *
 * Byte-faithful port of the v289 guard recovered from the official binary
 * strings dump (s289.txt @17551578; 0 occurrences in v288). The stock hljs
 * `xml` grammar's `<script>` rule carries `subLanguage: ['javascript',
 * 'handlebars']` and `handlebars` carries `subLanguage: 'xml'` — with N
 * unclosed `<script>` tags each cascade level re-highlights the remaining
 * buffer (~1.5× work per tag): exponential in tag count, independent of
 * block size, so even a ~190-char code block freezes the terminal forever.
 *
 * The fix does not touch the grammars (they are unchanged 288→289). It swaps
 * hljs's TokenTreeEmitter for a budgeted subclass and installs a per-call
 * budget plugin, so runaway grammatical work trips a HighlightBoundError
 * instead of hanging:
 *   budget = BASE_BUDGET + codeLen * (CHAR_COST + FANOUT_COST * fanout)
 *   fanout = min(grammar subLanguage-array fanout, #languages, MAX_FANOUT)
 * plus depth²-charged addText/__addSublanguage and a hard depth cap
 * (MAX_HEIGHT) that instantly exhausts the budget.
 *
 * Installed at the hljs core-load site (official: `let n=e.loadCore();Se(n);`
 * — the exact 1-token diff vs v288 @17497153); OCC's install site is
 * `src/utils/cliHighlight.ts` `loadCliHighlight()`, which every terminal
 * highlight path funnels through (cli-highlight `require`s the same
 * highlight.js module instance this configures).
 *
 * Symbol map (official minified → OCC):
 *   C  = HighlightBoundError        b  = charge
 *   ee = countNewlines              he = MAX_HEIGHT (32)
 *   me = MAX_FANOUT (64)            pe = BASE_BUDGET (4096)
 *   we = CHAR_COST (24)             Le = FANOUT_COST (3)
 *   xe = CTOR_COST (16)             te = boundedEmitter
 *   ne = isUnboundedEmitterClass    re = grammarFanout
 *   oe = makeBudgetFn               ie = budgetPlugin
 *   z  = installBounds              Se = installHighlightBounds
 */

// CC 2.1.295 #091 Layer A — the before:highlight LIMIT plugin installed by
// the restructured v295 `L` installer below (import is type-safe: hljsLimit
// imports only the BoundedHljs TYPE from this module — no runtime cycle).
import { makeHighlightLimitPlugin } from './hljsLimit.js'

/** Official `he` — max emitter stack height (nesting depth cap). */
export const MAX_HEIGHT = 32
/** Official `me` — max subLanguage fanout counted toward the budget. */
export const MAX_FANOUT = 64
/** Official `pe` — base budget (work allowed regardless of length). */
export const BASE_BUDGET = 4096
/** Official `we` — per-character charge. */
export const CHAR_COST = 24
/** Official `Le` — extra per-character charge per unit of subLanguage fanout. */
export const FANOUT_COST = 3
/** Official `xe` — emitter construction charge. */
export const CTOR_COST = 16

/** Official `C` — thrown when highlighting blows its work budget. */
export class HighlightBoundError extends Error {
  constructor() {
    super('highlighting this text takes more work than its length allows')
    this.name = 'HighlightBoundError'
  }
}

/** Official `{left: …}` — mutable per-install budget counter. */
type Budget = { left: number }

/** Official `b(e,n)` — charge the budget, throw on exhaustion. */
function charge(budget: Budget, amount: number): void {
  budget.left -= amount
  if (budget.left < 0) throw new HighlightBoundError()
}

/** Official `ee(e)` — newline count, without allocating a split array. */
function countNewlines(text: string): number {
  let n = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    n += 1
  }
  return n
}

/** The hljs TokenTreeEmitter surface the bounded subclass wraps. */
type EmitterApi = {
  stack: unknown[]
  held: number
  breaks: number
  height: number
  openNode(className: string): void
  addText(text: string): void
  addSublanguage?(other: EmitterApi, name: string): void
  __addSublanguage?(other: EmitterApi, name: string): void
  toHTML(): string
  grownTo(height: number): void
}

type EmitterClass = {
  new (options: unknown): EmitterApi
  prototype: Record<string, unknown>
  isBounded?: boolean
}

/** hljs instance surface this module needs (structural — avoids importing
 * highlight.js's DOM-referencing type defs into every consumer).
 * OCC-specific: two hljs generations must be supported — cli-highlight
 * (the module that actually renders terminal highlights) depends on
 * highlight.js@10.7.3, while OCC's direct dependency is 11.11.1. The
 * official binary vendors a single v11.x core. v10 differences handled
 * here: the highlight result exposes `emitter`/`top` (v11: `_emitter`),
 * and the emitter merge method is `addSublanguage` (v11:
 * `__addSublanguage`). */
export type BoundedHljs = {
  highlightAuto(code: string, subset?: string[]): {
    _emitter?: { constructor?: unknown }
    emitter?: { constructor?: unknown }
  }
  configure(options: Record<string, unknown>): void
  addPlugin(plugin: Record<string, unknown>): void
  getLanguage(name: string | undefined): object | undefined
  listLanguages(): string[]
}

/**
 * Official `te(e,n)` — wraps hljs's TokenTreeEmitter in a budgeted subclass.
 * Static `isBounded` marker feeds the official `ne` idempotency guard.
 */
export function boundedEmitter(
  Base: EmitterClass,
  budget: Budget,
): EmitterClass {
  return class BoundedEmitter
    extends (Base as unknown as new (options: unknown) => EmitterApi)
  {
    static isBounded = true
    held = 0
    breaks = 0
    height = 0

    constructor(options: unknown) {
      super(options)
      charge(budget, CTOR_COST)
    }

    openNode(className: string): void {
      this.held += 1
      charge(budget, 1)
      super.openNode(className)
      this.grownTo(this.stack.length - 1)
    }

    addText(text: string): void {
      const lines = countNewlines(text)
      this.held += text.length
      this.breaks += lines
      // Official depth² charge: text added deep in the emitter stack costs
      // quadratically more per newline.
      charge(budget, text.length + lines * (this.stack.length - 1) ** 2)
      super.addText(text)
    }

    /** Official `__addSublanguage` merge accounting: a bounded sub-emitter's
     * held/breaks/height fold into this emitter, and its breaks are charged
     * at the merged depth². */
    chargeSublanguageMerge(other: EmitterApi): void {
      if (other instanceof BoundedEmitter) {
        const depth = this.stack.length + other.height
        this.held += other.held
        this.breaks += other.breaks
        this.grownTo(depth)
        charge(budget, other.breaks * depth ** 2)
      }
    }

    // hljs v11 merge entry point (official `__addSublanguage`).
    __addSublanguage(other: EmitterApi, name: string): void {
      this.chargeSublanguageMerge(other)
      super.__addSublanguage?.(other, name)
    }

    // hljs v10 merge entry point (cli-highlight's highlight.js@10.7.3 names
    // it `addSublanguage`) — same official merge charge.
    addSublanguage(other: EmitterApi, name: string): void {
      this.chargeSublanguageMerge(other)
      super.addSublanguage?.(other, name)
    }

    toHTML(): string {
      charge(budget, this.held)
      return super.toHTML()
    }

    grownTo(height: number): void {
      this.height = Math.max(this.height, height)
      // Depth cap: nesting beyond MAX_HEIGHT instantly exhausts the budget.
      if (this.height > MAX_HEIGHT) charge(budget, Number.POSITIVE_INFINITY)
    }
  } as unknown as EmitterClass
}

/**
 * Official `ne(e)` — "is an unbounded emitter class?" Idempotency guard:
 * already-wrapped classes carry the static `isBounded` marker.
 */
function isUnboundedEmitterClass(value: unknown): value is EmitterClass {
  return (
    typeof value === 'function' &&
    'openNode' in (value as { prototype: object }).prototype &&
    !('isBounded' in (value as object))
  )
}

type GrammarNode = {
  subLanguage?: string | string[]
  contains?: unknown[]
  variants?: unknown[]
  starts?: unknown
}

/**
 * Official `re(e,n)` — walk a grammar (with a cycle set) and return its max
 * subLanguage-array fanout. An uncapped (empty) array — "auto-detect against
 * every language" — counts as Infinity, the plugin-grammar guard.
 */
function grammarFanout(hljs: BoundedHljs, grammar: object): number {
  const seen = new Set<unknown>()
  const stack: unknown[] = [grammar]
  let max = 0
  while (stack.length > 0) {
    const node = stack.pop()
    if (typeof node !== 'object' || node === null || seen.has(node)) continue
    seen.add(node)
    const rec = node as GrammarNode
    const sub = 'subLanguage' in rec ? rec.subLanguage : undefined
    const isArray = Array.isArray(sub)
    max = Math.max(max, isArray ? sub.length || Number.POSITIVE_INFINITY : 0)
    stack.push(
      ...([sub ?? []] as unknown[])
        .flat()
        .filter((u): u is string => typeof u === 'string')
        .map(u => hljs.getLanguage(u)),
      ...(rec.contains ?? []),
      ...('variants' in rec ? rec.variants ?? [] : []),
      ...('starts' in rec ? [rec.starts] : []),
    )
  }
  return max
}

/**
 * Official `oe(e,n)` — builds the per-call budget function
 * `(language, codeLength) => BASE_BUDGET + codeLength * (CHAR_COST +
 * FANOUT_COST * fanout)`. Grammar fanouts are WeakMap-cached; the cache is
 * invalidated whenever the registered-language count changes (a newly
 * registered language can grow an existing grammar's reachable fanout).
 */
function makeBudgetFn(
  hljs: BoundedHljs,
  maxFanout: number,
): (language: string | undefined, codeLength: number) => number {
  let cache = new WeakMap<object, number>()
  let cachedLanguageCount = 0
  function fanout(grammar: object | undefined): number {
    const languageCount = hljs.listLanguages().length
    if (grammar === undefined) return 0
    if (languageCount !== cachedLanguageCount) {
      cache = new WeakMap()
      cachedLanguageCount = languageCount
    }
    const value = cache.get(grammar) ?? grammarFanout(hljs, grammar)
    cache.set(grammar, value)
    return Math.min(value, languageCount, maxFanout)
  }
  return (language, codeLength) =>
    BASE_BUDGET + codeLength * (CHAR_COST + FANOUT_COST * fanout(hljs.getLanguage(language)))
}

/**
 * Official `ie(e,n)` — per-call budget plugin: `before:highlight` resets the
 * shared budget counter from (language, code length); `after:highlight` is
 * the belt-and-braces exhaust check (charges throw eagerly, but a negative
 * remainder at the end is still surfaced) and re-arms Infinity so a throw
 * here cannot poison the next call.
 */
function budgetPlugin(
  budget: Budget,
  budgetFor: (language: string | undefined, codeLength: number) => number,
): Record<string, unknown> {
  return {
    'before:highlight': (args: { language?: string; code: string }) => {
      budget.left = budgetFor(args.language, args.code.length)
    },
    'after:highlight': () => {
      const exhausted = budget.left < 0
      budget.left = Number.POSITIVE_INFINITY
      if (exhausted) throw new HighlightBoundError()
    },
  }
}

/**
 * Official `z(e,n)` / `Se(e)`; CC 2.1.295 shape (`L(r,e)` @57119 in the hl
 * module):
 *   `let o=r.highlightAuto("",[])._emitter.constructor;
 *    if("isBounded"in o)return;
 *    if(r.addPlugin(B(r)),!U(o))return;
 *    let n={left:Infinity};
 *    r.configure({__emitter:Z(o,n)}),r.addPlugin(Y(n,X(r,e)))`
 * One-time installer. Grabs hljs's current emitter class via an empty
 * highlightAuto probe; returns immediately when already bounded. Otherwise
 * installs the 2.1.295 #091 LIMIT plugin FIRST (it guards pure-regex
 * backtracking that never reaches the emitter budget), then — only when the
 * emitter class is wrappable — swaps in the bounded subclass and adds the
 * per-call budget plugin. Safe to call on every core load.
 */
export function installHighlightBounds(
  hljs: BoundedHljs,
  maxFanout: number = MAX_FANOUT,
): void {
  // Official: `e.highlightAuto("",[])._emitter.constructor`. OCC reads
  // `_emitter ?? emitter` — v11 exposes `_emitter`, cli-highlight's v10
  // exposes `emitter`.
  const probe = hljs.highlightAuto('', [])
  const emitterCtor = (probe._emitter ?? probe.emitter)?.constructor
  // Official v295 early return: `"isBounded"in o` — checked BEFORE the limit
  // plugin so re-installs don't stack duplicate plugins.
  if (emitterCtor !== undefined && 'isBounded' in (emitterCtor as object)) return
  // Official v295: `r.addPlugin(B(r))` — the length/long-line limit plugin
  // (hljsLimit.ts), installed even when the emitter class can't be wrapped.
  hljs.addPlugin(makeHighlightLimitPlugin(hljs))
  if (!isUnboundedEmitterClass(emitterCtor)) return
  const budget: Budget = { left: Number.POSITIVE_INFINITY }
  hljs.configure({ __emitter: boundedEmitter(emitterCtor, budget) })
  hljs.addPlugin(budgetPlugin(budget, makeBudgetFn(hljs, maxFanout)))
}
