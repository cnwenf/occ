import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getModelMaxOutputTokens } from "../context";
import { getMaxOutputTokensForModel } from "../../services/api/claude";

/**
 * OCC-99 (2026-09-27 strict self-acceptance round) — model max_output_tokens
 * registry parity with official 2.1.283.
 *
 * Ground truth: the official 2.1.283 linux-x64 ELF (md5 b5afa820...). The
 * registry is a byte-extracted `max_output_tokens: {default, upper}` table
 * read by U5(e) via Kl(canonicalModel) at offset ~197060200:
 *
 *   claude-opus-5-5        default=128000  upper=128000   <-- ONLY model
 *                                                            whose default
 *                                                            equals upper
 *   claude-opus-5          default=64000   upper=128000
 *   claude-mythos-5        default=64000   upper=128000   (canonical → fable-5)
 *   claude-mythos-5-1      default=64000   upper=128000   (canonical → fable-5-1)
 *   claude-fable-5         default=64000   upper=128000
 *   claude-fable-5-1       default=64000   upper=128000
 *   claude-sonnet-5        default=64000   upper=128000
 *   claude-sonnet-4-6      default=32000   upper=128000
 *   claude-opus-4-6/7/8    default=64000   upper=128000
 *   claude-opus-4-5        default=32000   upper=64000
 *   claude-sonnet-4-5      default=32000   upper=64000
 *   claude-sonnet-4-0      default=32000   upper=64000
 *   claude-haiku-4-5       default=32000   upper=64000
 *   claude-3-7-sonnet      default=32000   upper=64000
 *   claude-opus-4-0/4-1    default=32000   upper=32000
 *   claude-3-5-sonnet      default=8192    upper=8192
 *   claude-3-5-haiku       default=8192    upper=8192
 *
 * That is the full 20-id official registry; every id above is now asserted
 * below (OCC-140 closed the last 4: fable-5, opus-4-5, sonnet-4-5, sonnet-4-0).
 *
 * Gap fixed here: OCC's branch table caught `claude-opus-5-5` with the
 * generic `m.includes('opus-5')` launch-model branch → 64000/128000, halving
 * the default output budget for what is now OCC's default model. The
 * `opus-5-5` branch is placed BEFORE the `opus-5` group; `mythos-5` (and
 * `-5-1` via substring) were entirely missing.
 */

const SAVED_USER_TYPE = process.env.USER_TYPE;
beforeEach(() => {
  // The ant path (resolveAntModel) and the model-capability override are both
  // gated on USER_TYPE=ant — keep it unset so the public branch table decides.
  delete process.env.USER_TYPE;
});
afterEach(() => {
  if (SAVED_USER_TYPE === undefined) {
    delete process.env.USER_TYPE;
  } else {
    process.env.USER_TYPE = SAVED_USER_TYPE;
  }
});

describe("OCC-99: official 2.1.283 max_output_tokens registry parity", () => {
  test("claude-opus-5-5 → 128000/128000 (default equals upper — the fix)", () => {
    expect(getModelMaxOutputTokens("claude-opus-5-5")).toEqual({
      default: 128_000,
      upperLimit: 128_000,
    });
  });

  test("claude-opus-5-5[1m] variant also resolves via canonical name", () => {
    const r = getModelMaxOutputTokens("claude-opus-5-5[1m]");
    expect(r.default).toBe(128_000);
    expect(r.upperLimit).toBe(128_000);
  });

  test("claude-opus-5 stays 64000/128000 (new branch must not shadow it)", () => {
    expect(getModelMaxOutputTokens("claude-opus-5")).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    });
  });

  test("claude-mythos-5 / claude-mythos-5-1 → 64000/128000 (via fable-5 canonicalization, NOT the mythos-5 branch)", () => {
    // OCC-140 honesty fix: getCanonicalName maps claude-mythos-5 → claude-fable-5
    // and claude-mythos-5-1 → claude-fable-5-1 (mythos is the alias for fable),
    // so these assertions are satisfied by the `fable-5` launch-model branch in
    // getModelMaxOutputTokens — NOT by the `m.includes('mythos-5')` branch, which
    // is unreachable for any `claude-`-prefixed (canonical) name. The value is
    // correct; the coverage comes from the fable-5 fallback. Do not read this
    // test as exercising the mythos-5 branch.
    expect(getModelMaxOutputTokens("claude-mythos-5")).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    });
    expect(getModelMaxOutputTokens("claude-mythos-5-1")).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    });
  });

  test("claude-fable-5-1 → 64000/128000 (covered by fable-5 substring)", () => {
    expect(getModelMaxOutputTokens("claude-fable-5-1")).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    });
  });

  // OCC-100 acceptance-P3 precision note (applies to the four registry-id
  // tests below): coverage ≠ universal observability — within the 32000/64000
  // group (`opus-4-5 || sonnet-4 || haiku-4`), deleting `m.includes('sonnet-4')`
  // is MASKED for sonnet-4-0/4-5 because the default fall-through is the
  // identical 32000/64000 (MAX_OUTPUT_TOKENS_DEFAULT/UPPER_LIMIT), so
  // `claude-opus-4-5` below is that group's deletion nail; the sonnet pins
  // instead bite over-broad substring mutations (e.g. a `sonnet-5` tier
  // check widened to `sonnet`), and the fable-5 pin bites directly
  // (deletion drops it to the 32000/64000 default).

  test("OCC-140: claude-fable-5 (bare, canonical) → 64000/128000", () => {
    // Previously unasserted registry id. claude-mythos-5 canonicalizes HERE
    // (claude-fable-5), so this branch is the real source of the mythos-5 tier.
    expect(getModelMaxOutputTokens("claude-fable-5")).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    });
  });

  test("OCC-140: claude-opus-4-5 → 32000/64000 (silent-regression channel — mutation-pinned)", () => {
    // Previously unasserted. This is the proven silent-regression channel from
    // the v2.1.358 acceptance: the official 2.1.283 registry declares
    // claude-opus-4-5 default=32000 upper=64000. Deleting the `opus-4-5` arm
    // from the branch table makes the canonical name fall through to the
    // generic `opus-4` branch → 32000/32000 (upper halved), yet every prior
    // test stayed green. This assertion is the mutation kill-switch.
    expect(getModelMaxOutputTokens("claude-opus-4-5")).toEqual({
      default: 32_000,
      upperLimit: 64_000,
    });
  });

  test("OCC-140: claude-sonnet-4-5 / claude-sonnet-4-0 → 32000/64000 (sonnet-4 tier)", () => {
    // Previously unasserted registry ids. claude-sonnet-4-5 canonicalizes to
    // itself; claude-sonnet-4-0 canonicalizes to claude-sonnet-4. Both land on
    // the `sonnet-4` branch (NOT the sonnet-4-6 branch, which is 32000/128000).
    expect(getModelMaxOutputTokens("claude-sonnet-4-5")).toEqual({
      default: 32_000,
      upperLimit: 64_000,
    });
    expect(getModelMaxOutputTokens("claude-sonnet-4-0")).toEqual({
      default: 32_000,
      upperLimit: 64_000,
    });
  });

  test("claude-sonnet-5 → 64000/128000 (unchanged)", () => {
    expect(getModelMaxOutputTokens("claude-sonnet-5")).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    });
  });

  test("claude-sonnet-4-6 → 32000/128000 (unchanged)", () => {
    expect(getModelMaxOutputTokens("claude-sonnet-4-6")).toEqual({
      default: 32_000,
      upperLimit: 128_000,
    });
  });

  test("claude-opus-4-6/4-7/4-8 → 64000/128000 (unchanged)", () => {
    for (const m of ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"]) {
      expect(getModelMaxOutputTokens(m)).toEqual({
        default: 64_000,
        upperLimit: 128_000,
      });
    }
  });

  test("claude-haiku-4-5 → 32000/64000 (unchanged)", () => {
    expect(getModelMaxOutputTokens("claude-haiku-4-5")).toEqual({
      default: 32_000,
      upperLimit: 64_000,
    });
  });

  test("claude-3-7-sonnet → 32000/64000 (unchanged)", () => {
    expect(getModelMaxOutputTokens("claude-3-7-sonnet")).toEqual({
      default: 32_000,
      upperLimit: 64_000,
    });
  });

  test("claude-opus-4-1 / claude-opus-4-0 → 32000/32000 (unchanged)", () => {
    expect(getModelMaxOutputTokens("claude-opus-4-1")).toEqual({
      default: 32_000,
      upperLimit: 32_000,
    });
    expect(getModelMaxOutputTokens("claude-opus-4-0")).toEqual({
      default: 32_000,
      upperLimit: 32_000,
    });
  });

  test("claude-3-5-sonnet / claude-3-5-haiku → 8192/8192 (unchanged)", () => {
    expect(getModelMaxOutputTokens("claude-3-5-sonnet")).toEqual({
      default: 8_192,
      upperLimit: 8_192,
    });
    expect(getModelMaxOutputTokens("claude-3-5-haiku")).toEqual({
      default: 8_192,
      upperLimit: 8_192,
    });
  });

  test("wire-path getMaxOutputTokensForModel(claude-opus-5-5) → 128000", () => {
    // This is the function that actually fills `max_tokens` on every request
    // (src/services/api/claude.ts:2143). tengu_otk_slot_v1 statsig cap is
    // default-false and CLAUDE_CODE_MAX_OUTPUT_TOKENS is unset here.
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    expect(getMaxOutputTokensForModel("claude-opus-5-5")).toBe(128_000);
  });

  test("CLAUDE_CODE_MAX_OUTPUT_TOKENS env override still wins (bounded)", () => {
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "10000";
    try {
      expect(getMaxOutputTokensForModel("claude-opus-5-5")).toBe(10_000);
    } finally {
      delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    }
  });
});
