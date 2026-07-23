import { describe, expect, test } from 'bun:test';
import { pickWelcomeTip, WELCOME_TIPS } from '../../src/components/LogoV2/welcomeTips.js';

// Unit tests for the condensed-logo welcome tip picker (OCC-18). The tip line
// must be deterministic (no Math.random) so a given boot always shows the same
// hint and the logo never re-renders a different tip mid-session.

describe('pickWelcomeTip', () => {
  test('always returns a tip from the pool', () => {
    for (let i = 0; i < 50; i++) {
      const tip = pickWelcomeTip(`session-${i}`, i);
      expect(WELCOME_TIPS).toContain(tip);
    }
  });

  test('is deterministic — same session + startup → same tip', () => {
    const a = pickWelcomeTip('abc-123', 4);
    const b = pickWelcomeTip('abc-123', 4);
    expect(a).toBe(b);
  });

  test('different sessions can surface different tips', () => {
    const tips = new Set<string>();
    for (let i = 0; i < 200; i++) {
      tips.add(pickWelcomeTip(`session-${i}`, 1));
    }
    // Across 200 distinct sessions we expect more than one tip to appear.
    expect(tips.size).toBeGreaterThan(1);
  });

  test('falls back deterministically when the session id is empty', () => {
    // Pipe mode (no session id) must still return a stable tip keyed off the
    // startup counter, never undefined/blank.
    const tip = pickWelcomeTip('', 3);
    expect(typeof tip).toBe('string');
    expect(tip.length).toBeGreaterThan(0);
    // Same call again → same result.
    expect(pickWelcomeTip('', 3)).toBe(tip);
  });

  test('the tip pool is non-empty and all tips are non-blank', () => {
    expect(WELCOME_TIPS.length).toBeGreaterThan(0);
    for (const tip of WELCOME_TIPS) {
      expect(tip.length).toBeGreaterThan(0);
    }
  });
});
