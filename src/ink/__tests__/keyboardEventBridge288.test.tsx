import { afterEach, describe, expect, test } from 'bun:test'
import { PassThrough } from 'stream'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { Box, render, Text, useInput } from '../../ink.js'
import { InputEvent } from '../events/input-event.js'
import type { ParsedKey } from '../parse-keypress.js'
import { Select } from '../../components/CustomSelect/select.js'

/**
 * v2.1.288 Item #64 — "/permissions: in screen reader mode, typing a rule's
 * number now picks it instead of opening search."
 *
 * Official mechanics (all dd-verified against
 * /tmp/cc-diff-288/v288/package/claude):
 *
 * - Select digit handler @222622084: `if(t!=="numeric"&&/^[0-9]$/.test(I)){
 *   h.preventDefault();let V=parseInt(I)-1;if(V>=0&&V<i.options.length){…}}`
 *   — preventDefault fires BEFORE the range check (an out-of-range digit is
 *   still consumed by the select and never reaches search routers).
 * - PermissionRuleList search router @238030944: `else if(!De.defaultPrevented
 *   &&De.key.length===1&&De.key!=="j"&&…)De.preventDefault(),_e(!0),Vt(De.key)`
 *   — the printable-char search fallback skips keys whose default was already
 *   prevented by the select's digit shortcut.
 *
 * OCC divergence (bridge): the official has ONE keyboard event object shared
 * by the useInput family and DOM onKeyDown handlers. OCC has two — the
 * useInput family gets an `InputEvent` (EventEmitter path), the DOM onKeyDown
 * handlers get a separate `KeyboardEvent` (dispatcher path). So OCC adds
 * preventDefault/defaultPrevented to InputEvent and App.processKeysInBatch
 * carries the flag across: `dispatchKeyboardEvent(item, event.defaultPrevented)`
 * → ink.tsx pre-prevents the KeyboardEvent before dispatch.
 */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type KeyRecord = { key: string; prevented: boolean }

function makeParsedKey(name: string, sequence: string): ParsedKey {
  return {
    kind: 'key',
    fn: false,
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence,
    raw: sequence,
    isPasted: false,
  }
}

async function setupInteractive(node: React.ReactNode) {
  const chunks: string[] = []
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    chunks.push(chunk.toString())
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  // Per-property casts: ReadStream's declared setRawMode/ref/unref signatures
  // (`this`-returning) conflict with no-op polyfill assignments otherwise.
  ;(stdin as unknown as { isTTY: boolean }).isTTY = true
  ;(stdin as unknown as { setRawMode: () => void }).setRawMode = () => {}
  ;(stdin as unknown as { ref: () => void }).ref = () => {}
  ;(stdin as unknown as { unref: () => void }).unref = () => {}
  const instance = await render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
  })
  return {
    instance,
    stdin,
    output: () => stripAnsi(chunks.join('')),
  }
}

/**
 * Recorder box: focused (so it is the dispatch target and its onKeyDown
 * fires at_target), records what DOM keydown handlers observe. Optional
 * useInput digit handler that preventDefault()s — the probe for the
 * InputEvent → KeyboardEvent bridge.
 */
function Recorder({
  records,
  preventDigits,
  children,
}: {
  records: KeyRecord[]
  preventDigits?: boolean
  children: React.ReactNode
}) {
  useInput((input, _key, event) => {
    if (preventDigits && /^[0-9]$/.test(input)) {
      event.preventDefault()
    }
  })
  return (
    <Box
      tabIndex={0}
      autoFocus
      onKeyDown={e => {
        records.push({ key: e.key, prevented: e.defaultPrevented })
      }}
    >
      {children}
    </Box>
  )
}

const mounted: { unmount: () => void }[] = []

afterEach(() => {
  while (mounted.length > 0) {
    const m = mounted.pop()
    try {
      m?.unmount()
    } catch {
      // already unmounted
    }
  }
})

describe('2.1.288 #64: InputEvent preventDefault (bridge source)', () => {
  test('InputEvent starts unprevented and preventDefault() marks it', () => {
    const event = new InputEvent(makeParsedKey('5', '5'))
    expect(event.defaultPrevented).toBe(false)
    event.preventDefault()
    expect(event.defaultPrevented).toBe(true)
  })

  test('preventDefault is idempotent', () => {
    const event = new InputEvent(makeParsedKey('5', '5'))
    event.preventDefault()
    event.preventDefault()
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('2.1.288 #64: useInput preventDefault reaches DOM onKeyDown (bridge)', () => {
  test('a digit prevented by a useInput handler arrives defaultPrevented at onKeyDown', async () => {
    const records: KeyRecord[] = []
    const { instance, stdin } = await setupInteractive(
      <Recorder records={records} preventDigits>
        <Text>probe</Text>
      </Recorder>,
    )
    mounted.push(instance)
    await delay(30)

    stdin.write('5')
    await delay(30)
    expect(records).toEqual([{ key: '5', prevented: true }])

    // A key nobody prevented arrives unprevented (search routers still fire).
    stdin.write('x')
    await delay(30)
    expect(records).toEqual([
      { key: '5', prevented: true },
      { key: 'x', prevented: false },
    ])
  })
})

describe('2.1.288 #64: Select digit shortcut prevents the default', () => {
  const options = [
    { label: 'One', value: 'v0' },
    { label: 'Two', value: 'v1' },
  ]

  test('typing an in-range digit selects the option AND prevents the default', async () => {
    const records: KeyRecord[] = []
    let selected: string | undefined
    const { instance, stdin } = await setupInteractive(
      <Recorder records={records}>
        <Select
          options={options}
          onChange={value => {
            selected = value
          }}
          onCancel={() => {}}
        />
      </Recorder>,
    )
    mounted.push(instance)
    await delay(30)

    stdin.write('2')
    await delay(30)
    // Official digit branch: onChange with the numbered option's value…
    expect(selected).toBe('v1')
    // …and h.preventDefault() so the PermissionRuleList-style search
    // fallback (`!De.defaultPrevented&&De.key.length===1`) skips the key.
    expect(records.some(r => r.key === '2' && r.prevented)).toBe(true)
  })

  test('an out-of-range digit is still prevented (official: preventDefault before the range check)', async () => {
    const records: KeyRecord[] = []
    let selected: string | undefined
    const { instance, stdin } = await setupInteractive(
      <Recorder records={records}>
        <Select
          options={options}
          onChange={value => {
            selected = value
          }}
          onCancel={() => {}}
        />
      </Recorder>,
    )
    mounted.push(instance)
    await delay(30)

    stdin.write('9')
    await delay(30)
    expect(selected).toBeUndefined()
    expect(records.some(r => r.key === '9' && r.prevented)).toBe(true)
  })
})
