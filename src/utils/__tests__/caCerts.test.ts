import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CERT_STORES, resolveCertStores } from "../caCerts";

/**
 * claude-code 2.1.101: trust the OS CA store by default
 * (default stores = ["bundled", "system"]); CLAUDE_CODE_CERT_STORE selects
 * "bundled"/"system"/"bundled,system".
 */
const SAVED = process.env.CLAUDE_CODE_CERT_STORE;
const SAVED_OPTS = process.env.NODE_OPTIONS;
afterEach(() => {
  if (SAVED === undefined) {
    delete process.env.CLAUDE_CODE_CERT_STORE;
  } else {
    process.env.CLAUDE_CODE_CERT_STORE = SAVED;
  }
  if (SAVED_OPTS === undefined) {
    delete process.env.NODE_OPTIONS;
  } else {
    process.env.NODE_OPTIONS = SAVED_OPTS;
  }
});

describe("2.1.101 resolveCertStores", () => {
  test("default is bundled + system (OS store trusted by default)", () => {
    delete process.env.CLAUDE_CODE_CERT_STORE;
    delete process.env.NODE_OPTIONS;
    expect(DEFAULT_CERT_STORES).toEqual(["bundled", "system"]);
    expect(resolveCertStores()).toEqual(["bundled", "system"]);
  });

  test("CLAUDE_CODE_CERT_STORE=bundled → bundled only", () => {
    process.env.CLAUDE_CODE_CERT_STORE = "bundled";
    expect(resolveCertStores()).toEqual(["bundled"]);
  });

  test("CLAUDE_CODE_CERT_STORE=system → system only", () => {
    process.env.CLAUDE_CODE_CERT_STORE = "system";
    expect(resolveCertStores()).toEqual(["system"]);
  });

  test("CLAUDE_CODE_CERT_STORE=bundled,system → both (order preserved, deduped)", () => {
    process.env.CLAUDE_CODE_CERT_STORE = "system,bundled,system";
    expect(resolveCertStores()).toEqual(["system", "bundled"]);
  });

  test("CLAUDE_CODE_CERT_STORE with whitespace + case → normalized", () => {
    process.env.CLAUDE_CODE_CERT_STORE = " Bundled , SYSTEM ";
    expect(resolveCertStores()).toEqual(["bundled", "system"]);
  });

  test("CLAUDE_CODE_CERT_STORE with only unknown values → falls back to default", () => {
    process.env.CLAUDE_CODE_CERT_STORE = "foo,bar";
    expect(resolveCertStores()).toEqual(["bundled", "system"]);
  });

  test("CLAUDE_CODE_CERT_STORE with one unknown + one valid → keeps the valid one", () => {
    process.env.CLAUDE_CODE_CERT_STORE = "foo,bundled";
    expect(resolveCertStores()).toEqual(["bundled"]);
  });
});
