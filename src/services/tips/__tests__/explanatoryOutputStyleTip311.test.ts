import { afterEach, describe, expect, test } from 'bun:test'
import { getIsRemoteMode, setIsRemoteMode } from '../../../bootstrap/state.js'
import {
  EXPLANATORY_OUTPUT_STYLE_TIP_CONTENT,
  EXPLANATORY_OUTPUT_STYLE_TIP_ID,
  explanatoryOutputStyleTip,
} from '../tipRegistry.js'

/**
 * claude-code 2.1.311 triage-T1 item 2 — the `explanatory-output-style`
 * spinner tip, registered in v311 (byte-verified @278472840):
 *
 *   `{id:"explanatory-output-style",priority:1,providerAgnostic:!0,
 *      content:async()=>R$n,cooldownSessions:15,maxLifetimeShows:3,
 *      advertisedCommand:"config",
 *      isRelevant:async(e)=>(e.explanationRequestCount??0)>=J&&!Rt()
 *        &&Jt("localSettings")&&pe("flagSettings")?.outputStyle===void 0
 *        &&pe("policySettings")?.outputStyle===void 0&&await ayt()===null}`
 *
 * The content template `R$n` (byte-verified @266639753) is
 *   ``R$n=`${"Want Claude to teach as it works?"} \xB7 /${"config"} outputStyle=explanatory`;``
 * so the shipped literal is
 *   `Want Claude to teach as it works? · /config outputStyle=explanatory`
 * with `\xB7` (U+00B7 MIDDLE DOT) at index 34, single-spaced on both sides
 * and no space between `/` and `config`.
 *
 * The threshold `J` is `var J=2` (byte-verified @278455253).
 *
 * Gate mapping: `Rt()` → getIsRemoteMode(); `Jt("localSettings")` →
 * isSettingSourceEnabled('localSettings'); `pe(src)` → getSettingsForSource(src);
 * `ayt()` → getOutputStyleConfig(). `maxLifetimeShows` maps to OCC's
 * `maxImpressions` — the same lifetime-cap field tipHistory persists and
 * getRelevantTips enforces via isTipLifetimeCapped.
 */

const SAVED_REMOTE = getIsRemoteMode()

afterEach(() => {
  setIsRemoteMode(SAVED_REMOTE)
})

describe('2.1.311 #2: explanatory-output-style tip identity', () => {
  test('exports the official tip id', () => {
    expect(EXPLANATORY_OUTPUT_STYLE_TIP_ID).toBe('explanatory-output-style')
    expect(explanatoryOutputStyleTip.id).toBe(EXPLANATORY_OUTPUT_STYLE_TIP_ID)
  })

  test('ships the byte-identical official content string', () => {
    expect(EXPLANATORY_OUTPUT_STYLE_TIP_CONTENT).toBe(
      'Want Claude to teach as it works? · /config outputStyle=explanatory',
    )
  })

  test('uses U+00B7 MIDDLE DOT at index 34 (official \\xB7)', () => {
    expect(EXPLANATORY_OUTPUT_STYLE_TIP_CONTENT.indexOf('·')).toBe(34)
    expect(EXPLANATORY_OUTPUT_STYLE_TIP_CONTENT.charCodeAt(34)).toBe(0xb7)
  })

  test('keeps the official spacing around the separator and slash', () => {
    expect(EXPLANATORY_OUTPUT_STYLE_TIP_CONTENT.slice(33, 36)).toBe(' · ')
    expect(EXPLANATORY_OUTPUT_STYLE_TIP_CONTENT).toContain('/config outputStyle=explanatory')
    expect(EXPLANATORY_OUTPUT_STYLE_TIP_CONTENT).not.toContain('/ config')
  })

  test('content() resolves to the exported literal', async () => {
    expect(await explanatoryOutputStyleTip.content({})).toBe(
      EXPLANATORY_OUTPUT_STYLE_TIP_CONTENT,
    )
  })
})

describe('2.1.311 #2: explanatory-output-style tip scheduling fields', () => {
  test('priority is 1', () => {
    expect(explanatoryOutputStyleTip.priority).toBe(1)
  })

  test('providerAgnostic is true', () => {
    expect(explanatoryOutputStyleTip.providerAgnostic).toBe(true)
  })

  test('cooldownSessions is 15', () => {
    expect(explanatoryOutputStyleTip.cooldownSessions).toBe(15)
  })

  test('maxImpressions carries the official maxLifetimeShows of 3', () => {
    expect(explanatoryOutputStyleTip.maxImpressions).toBe(3)
  })

  test('advertisedCommand is "config"', () => {
    expect(explanatoryOutputStyleTip.advertisedCommand).toBe('config')
  })
})

describe('2.1.311 #2: explanatory-output-style tip relevance gate', () => {
  test('is false below the explanationRequestCount threshold of 2', async () => {
    setIsRemoteMode(false)
    expect(await explanatoryOutputStyleTip.isRelevant()).toBe(false)
    expect(
      await explanatoryOutputStyleTip.isRelevant({ explanationRequestCount: 0 }),
    ).toBe(false)
    expect(
      await explanatoryOutputStyleTip.isRelevant({ explanationRequestCount: 1 }),
    ).toBe(false)
  })

  test('is true at and above the threshold', async () => {
    setIsRemoteMode(false)
    expect(
      await explanatoryOutputStyleTip.isRelevant({ explanationRequestCount: 2 }),
    ).toBe(true)
    expect(
      await explanatoryOutputStyleTip.isRelevant({ explanationRequestCount: 7 }),
    ).toBe(true)
  })

  test('is false in a remote session (official !Rt())', async () => {
    setIsRemoteMode(true)
    expect(
      await explanatoryOutputStyleTip.isRelevant({ explanationRequestCount: 5 }),
    ).toBe(false)
  })
})
