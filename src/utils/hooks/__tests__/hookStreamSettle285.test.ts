import { describe, expect, test } from 'bun:test'
import { looksLikeMissingHookScript, settleHookStreams } from '../../hooks'

/**
 * CC 2.1.285: "Fixed synchronous hooks hanging Claude Code while a background
 * process the hook started (for example `some-daemon &`) kept its output
 * open; the hook now finishes shortly after its own process exits."
 *
 * Byte evidence (linux-x64 official ELFs, JS region >150M):
 * - v285 `unt` settle helper @203477184 (verbatim):
 *   `var gIn=500,hIn=1e4;async function unt({streamsSettled:e,lastDataAt:n,
 *   holdOpen:r,quietWindowMs:s=gIn,capMs:g=hIn,arm:h,now:S=Date.now}){
 *   let w=S(),M=e.then(()=>!0);for(;;){let F=n();
 *   if(await it(M,s,h)||S()-w>=g)return;if(n()!==F)continue;if(r?.())continue;
 *   if(await new Promise((K)=>setImmediate(K)),n()===F)return}}`
 * - v285 completion keyed on 'exit' @205146855 (verbatim):
 *   `so.on("exit",(us)=>{(async()=>{await unt({streamsSettled:Promise.all(
 *   [No,vr]).then(()=>{}),lastDataAt:()=>yr,holdOpen:...}),so.stdout.
 *   removeListener("data",Cr),so.stderr.removeListener("data",Er),Xr({
 *   ...,status:us??1,aborted:w.aborted&&!fs,...us!==null&&{exitedNormally:
 *   !0},...!(Fr&&Nr)&&{stdioIncomplete:!0},...Sr&&{stdioClosedWithoutEnd:
 *   !0},...})})()})`
 *   vs v284 'close'-keyed @207336347: `so.on("close",(ps)=>{Gr=ps??1,
 *   Promise.all([kr,Nr]).then(...)})` with 'end'-only promises
 *   `kr=new Promise((Tr)=>{so.stdout.on("end",()=>Tr())})` @207334300+ —
 *   a grandchild holding the pipe open meant 'close'/'end' never fired.
 * - v285 `gFn` guard @205149950 (verbatim):
 *   `function gFn({hookEvent:e,stdout:n,stderr:r,pluginId:s,
 *   stdioIncomplete:g,stdioClosedWithoutEnd:h}){if(g===!0||h===!0)return!1;
 *   ...}` and its call site @205193800 passes
 *   `stdioIncomplete:or.stdioIncomplete,stdioClosedWithoutEnd:or.stdioClosedWithoutEnd`.
 *
 * settleHookStreams is the verbatim `unt` port (the official `arm` param is
 * unused at the completion call site and omitted; `holdOpen` consults the
 * runner subsystem which OCC does not port → always false in hooks.ts).
 */

const NEVER: Promise<void> = new Promise<void>(() => {})

describe('settleHookStreams (official unt port)', () => {
  test('returns immediately once the streams settle (no quiet-window wait)', async () => {
    // Arrange — streams already settled before the call.
    const started = Date.now()

    // Act
    await settleHookStreams({
      streamsSettled: Promise.resolve(),
      lastDataAt: () => 0,
      quietWindowMs: 5_000, // would dominate if settle were not honored
      capMs: 10_000,
    })

    // Assert — resolved far below the quiet window.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('returns after the quiet window when streams never settle but output is quiet', async () => {
    // Arrange — the 2.1.285 bug shape: a background daemon holds the pipe
    // open (streamsSettled never resolves) but no new data arrives.
    const lastData = Date.now()
    const started = Date.now()

    // Act
    await settleHookStreams({
      streamsSettled: NEVER,
      lastDataAt: () => lastData,
      quietWindowMs: 120,
      capMs: 5_000,
    })

    // Assert — finishes shortly after one quiet window, not at the cap and
    // not never (pre-2.1.285 this hung until the hook timeout).
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(110)
    expect(elapsed).toBeLessThan(2_000)
  })

  test('new data during the quiet window resets it', async () => {
    // Arrange — one late chunk lands 60ms in, then the pipe goes quiet.
    let lastData = 100
    setTimeout(() => {
      lastData = 200
    }, 60)
    const started = Date.now()

    // Act
    await settleHookStreams({
      streamsSettled: NEVER,
      lastDataAt: () => lastData,
      quietWindowMs: 100,
      capMs: 5_000,
    })

    // Assert — the first window was invalidated by the new data, so the
    // total wait spans at least two quiet windows.
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
  })

  test('capMs bounds the wait while data keeps flowing', async () => {
    // Arrange — lastDataAt always advancing: the quiet window never elapses
    // cleanly, so only the official `S()-w>=g` cap may end the wait.
    const started = Date.now()

    // Act
    await settleHookStreams({
      streamsSettled: NEVER,
      lastDataAt: () => Date.now(),
      quietWindowMs: 50,
      capMs: 300,
    })

    // Assert
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(290)
    expect(elapsed).toBeLessThan(2_000)
  })

  test('holdOpen keeps waiting until the cap (official runner branch shape)', async () => {
    // Arrange — quiet output but holdOpen() true mimics the official
    // runner-still-active case (`if(r?.())continue`).
    const started = Date.now()

    // Act
    await settleHookStreams({
      streamsSettled: NEVER,
      lastDataAt: () => 42,
      holdOpen: () => true,
      quietWindowMs: 50,
      capMs: 250,
    })

    // Assert — did not return on the first quiet window; ended at the cap.
    expect(Date.now() - started).toBeGreaterThanOrEqual(240)
  })
})

describe('looksLikeMissingHookScript — 2.1.285 stdio guard (official gFn)', () => {
  const MISSING_SHAPE = {
    hookEvent: 'Stop',
    stdout: '',
    stderr: 'bash: /path/to/hook.sh: No such file or directory',
  } as const

  test('still detects a missing script when stdio completed normally', () => {
    // Arrange / Act
    const result = looksLikeMissingHookScript({ ...MISSING_SHAPE })

    // Assert — regression guard: the new optional params change nothing
    // for a clean capture.
    expect(result).toBe(true)
  })

  test('refuses the missing-script read when stdioIncomplete is true', () => {
    // Arrange / Act — the capture went quiet before end-of-stream, so the
    // empty-stdout premise is untrustworthy (fail-closed: real exit-2 block).
    const result = looksLikeMissingHookScript({
      ...MISSING_SHAPE,
      stdioIncomplete: true,
    })

    // Assert
    expect(result).toBe(false)
  })

  test('refuses the missing-script read when stdioClosedWithoutEnd is true', () => {
    // Arrange / Act
    const result = looksLikeMissingHookScript({
      ...MISSING_SHAPE,
      stdioClosedWithoutEnd: true,
    })

    // Assert
    expect(result).toBe(false)
  })

  test('explicit false flags behave like undefined (official ===!0 guard)', () => {
    // Arrange / Act — the guard is `g===!0||h===!0`, so only TRUE refuses.
    const result = looksLikeMissingHookScript({
      ...MISSING_SHAPE,
      stdioIncomplete: false,
      stdioClosedWithoutEnd: false,
    })

    // Assert
    expect(result).toBe(true)
  })
})
