import { describe, expect, test } from 'bun:test'
import {
  computeReconnectHoldoffMs,
  nextRapidDropCount,
  RAPID_DROP_THRESHOLD_MS,
  reconnectBackoffMs,
} from '../client'

/**
 * claude-code 2.1.295 (item 3) — remote MCP reconnect rapid-drop backoff.
 *
 * Official binary evidence (`yDo` close-handler factory + `gnt` backoff):
 *
 *   nns = 1e4                                rapid-drop lifetime threshold
 *   gnt(a) = min(30_000, 1000 * 2^(a-1))     capped exponential hold-off
 *   rapidDrops = lifetime < 1e4 ? prev + 1 : 0
 *   holdoff = rapidDrops > 1 ? max(0, gnt(rapidDrops-1) - lifetime) : 0
 *
 * The shared/headless onclose path in client.ts redials dropped remote
 * transports using exactly these primitives (the interactive REPL keeps its
 * own reconnect loop in useManageMCPConnections).
 */
describe('2.1.295 reconnectBackoffMs (official gnt)', () => {
  test('doubles from the 1000ms base per attempt', () => {
    expect(reconnectBackoffMs(1)).toBe(1000)
    expect(reconnectBackoffMs(2)).toBe(2000)
    expect(reconnectBackoffMs(3)).toBe(4000)
    expect(reconnectBackoffMs(4)).toBe(8000)
    expect(reconnectBackoffMs(5)).toBe(16000)
  })

  test('caps at 30000ms', () => {
    // Arrange — uncapped 2^5 * 1000 would be 32000
    // Act & Assert
    expect(reconnectBackoffMs(6)).toBe(30000)
    expect(reconnectBackoffMs(10)).toBe(30000)
  })
})

describe('2.1.295 computeReconnectHoldoffMs (official hold-off T)', () => {
  test('reconnects immediately for the first rapid drop and healthy connections', () => {
    // Arrange & Act & Assert — attempt <= 1 keeps the old immediate redial
    expect(computeReconnectHoldoffMs(0, 500)).toBe(0)
    expect(computeReconnectHoldoffMs(1, 500)).toBe(0)
  })

  test('subtracts the connection lifetime already managed from the backoff', () => {
    // Arrange & Act & Assert
    // attempt 2 → gnt(1)=1000, lifetime 300 → hold 700
    expect(computeReconnectHoldoffMs(2, 300)).toBe(700)
    // attempt 3 → gnt(2)=2000, lifetime 1500 → hold 500
    expect(computeReconnectHoldoffMs(3, 1500)).toBe(500)
  })

  test('never goes negative when the lifetime exceeds the backoff', () => {
    // Arrange & Act & Assert — attempt 2 → gnt(1)=1000, lifetime 5000 → 0
    expect(computeReconnectHoldoffMs(2, 5000)).toBe(0)
  })

  test('clamps at the 30000ms ceiling for sustained flapping', () => {
    // Arrange & Act & Assert
    expect(computeReconnectHoldoffMs(7, 0)).toBe(30000)
    expect(computeReconnectHoldoffMs(20, 0)).toBe(30000)
  })
})

describe('2.1.295 nextRapidDropCount (official rapid-drop counting)', () => {
  test('increments the previous count when the drop was rapid', () => {
    // Arrange & Act & Assert
    expect(nextRapidDropCount(0, 9999)).toBe(1)
    expect(nextRapidDropCount(5, 9999)).toBe(6)
  })

  test('resets to zero when the connection lived past the threshold', () => {
    // Arrange & Act & Assert — strict `<` in the official: exactly 10000ms
    // is NOT rapid
    expect(RAPID_DROP_THRESHOLD_MS).toBe(10000)
    expect(nextRapidDropCount(5, 10000)).toBe(0)
    expect(nextRapidDropCount(5, 60000)).toBe(0)
  })
})
