import { createPrimitives, type WorkflowRuntimeContext } from '../primitives.js'

// Minimal mock ctx — only the fields phase() touches.
function mockCtx(): WorkflowRuntimeContext {
  return {
    runId: 'wf_test',
    workflowName: 'test',
    toolUseContext: { abortController: new AbortController(), options: { tools: [] } } as any,
    canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as any,
    availableTools: [],
    journal: undefined,
    cachedResults: undefined,
    tokenBudget: null,
    counters: { agentCount: 0, spentTokens: 0, failures: [], logs: [] },
    currentPhase: '',
    workflowProgress: [],
    seedPhaseTitles: ['scan'],
    abortController: new AbortController(),
    onProgress: undefined,
    resolveWorkflowScript: undefined,
  } as unknown as WorkflowRuntimeContext
}

const { phase } = createPrimitives(mockCtx())

// Test 1: phase(title, fn) callback form — fn must run and its result returned.
let ran = false
const r1 = await phase('scan', async () => {
  ran = true
  return { ok: true, n: 42 }
})
console.assert(ran, 'FAIL: callback did not run')
console.assert((r1 as any)?.ok === true, `FAIL: callback result not returned (got ${JSON.stringify(r1)})`)
console.assert((r1 as any)?.n === 42, 'FAIL: callback return value mismatch')
console.log('PASS: phase(title, fn) runs callback + returns result')

// Test 2: phase(title) no-callback form — binary parity, returns void.
const r2 = phase('init')
console.assert(r2 === undefined, `FAIL: phase(title) should return void, got ${r2}`)
console.log('PASS: phase(title) returns void (binary parity)')

// Test 3: phase(title, fn) with sync fn.
const r3 = phase('sync', () => 'sync-result')
console.assert((await r3) === 'sync-result', `FAIL: sync callback result (got ${r3})`)
console.log('PASS: phase(title, fn) runs sync callback + returns result')

// Test 4: phase(title, fn) where fn throws — error should propagate as rejection.
try {
  await phase('err', async () => { throw new Error('boom') })
  console.assert(false, 'FAIL: phase should reject when fn throws')
} catch (e) {
  console.assert((e as Error).message === 'boom', 'FAIL: wrong error')
  console.log('PASS: phase(title, fn) propagates fn errors as rejections')
}

console.log('\nAll phase callback tests passed.')

// --- parallel() tests ---
const { parallel } = createPrimitives(mockCtx())

// Test 5: parallel([Promise, Promise]) — the model's form (promises, not thunks).
const r5 = await parallel([Promise.resolve('a'), Promise.resolve('b')])
console.assert(JSON.stringify(r5) === JSON.stringify(['a', 'b']), `FAIL: parallel(promises) got ${JSON.stringify(r5)}`)
console.log('PASS: parallel([Promise, Promise]) returns resolved values (model form)')

// Test 6: parallel([thunk, thunk]) — backward-compat thunk form.
const r6 = await parallel([() => Promise.resolve(1), () => Promise.resolve(2)])
console.assert(JSON.stringify(r6) === JSON.stringify([1, 2]), `FAIL: parallel(thunks) got ${JSON.stringify(r6)}`)
console.log('PASS: parallel([thunk, thunk]) returns resolved values (backward compat)')

// Test 7: parallel with mixed thunks + promises.
const r7 = await parallel([() => Promise.resolve('t'), Promise.resolve('p')])
console.assert(JSON.stringify(r7) === JSON.stringify(['t', 'p']), `FAIL: parallel(mixed) got ${JSON.stringify(r7)}`)
console.log('PASS: parallel([thunk, promise]) mixed items work')

// Test 8: parallel preserves order regardless of resolve order.
const r8 = await parallel([
  new Promise(res => setTimeout(() => res('late'), 30)),
  Promise.resolve('early'),
])
console.assert(JSON.stringify(r8) === JSON.stringify(['late', 'early']), `FAIL: parallel order got ${JSON.stringify(r8)}`)
console.log('PASS: parallel preserves input order')

// Test 9: parallel([]) returns empty array.
const r9 = await parallel([])
console.assert(JSON.stringify(r9) === JSON.stringify([]), `FAIL: parallel([]) got ${JSON.stringify(r9)}`)
console.log('PASS: parallel([]) returns []')

// Test 10: parallel rejects on non-array.
let threw = false
try { await parallel('not-array' as any) } catch { threw = true }
console.assert(threw, 'FAIL: parallel(non-array) should throw')
console.log('PASS: parallel(non-array) throws')

console.log('\nAll parallel tests passed.')
