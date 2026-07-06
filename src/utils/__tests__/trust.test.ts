import { describe, expect, test } from "bun:test";
import {
  _setGlobalConfigCacheForTesting,
  isPathTrusted,
  resetTrustDialogAcceptedCacheForTesting,
} from "../config.js";
import type { GlobalConfig } from "../config.js";

/**
 * Unit tests for the trust-logic parent-walk (isPathTrusted). The full
 * trust-dialog flow (accept → persist, session-only home trust, bypass
 * one-time persist) is covered end-to-end by test/e2e/trust-gate.e2e.test.ts;
 * these tests add fine-grained coverage of the path-walk that
 * computeTrustDialogAccepted / isPathTrusted rely on.
 *
 * In NODE_ENV='test' getGlobalConfig() returns a fixed constant and ignores
 * the cache, so each case temporarily flips NODE_ENV off + injects a config
 * via _setGlobalConfigCacheForTesting, then restores.
 */
function withTrustedProjects<T>(
  projects: Record<string, { hasTrustDialogAccepted?: boolean }>,
  fn: () => T,
): T {
  const savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const config: GlobalConfig = {
    projects,
  } as unknown as GlobalConfig;
  _setGlobalConfigCacheForTesting(config);
  resetTrustDialogAcceptedCacheForTesting();
  try {
    return fn();
  } finally {
    _setGlobalConfigCacheForTesting(null);
    resetTrustDialogAcceptedCacheForTesting();
    process.env.NODE_ENV = savedEnv;
  }
}

describe("isPathTrusted (parent-walk)", () => {
  test("returns false when no projects are trusted", () => {
    expect(withTrustedProjects({}, () => isPathTrusted("/foo/bar"))).toBe(false);
  });

  test("returns true for an exactly-trusted project", () => {
    expect(
      withTrustedProjects({ "/foo": { hasTrustDialogAccepted: true } }, () =>
        isPathTrusted("/foo"),
      ),
    ).toBe(true);
  });

  test("returns true for a child of a trusted project (parent-walk)", () => {
    expect(
      withTrustedProjects({ "/foo": { hasTrustDialogAccepted: true } }, () =>
        isPathTrusted("/foo/bar/baz"),
      ),
    ).toBe(true);
  });

  test("returns false for a sibling outside the trusted tree", () => {
    expect(
      withTrustedProjects({ "/foo": { hasTrustDialogAccepted: true } }, () =>
        isPathTrusted("/bar/baz"),
      ),
    ).toBe(false);
  });

  test("does not inherit trust from a child to its parent", () => {
    // Trusting /foo/bar must NOT trust /foo (walk is upward only).
    expect(
      withTrustedProjects({ "/foo/bar": { hasTrustDialogAccepted: true } }, () =>
        isPathTrusted("/foo"),
      ),
    ).toBe(false);
  });
});
