import { afterAll, describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

import {
  clearCACertsCache,
  dedupeCerts,
  getCACertificates,
} from "../caCerts";

/**
 * claude-code 2.1.303 (`D`, dd-verified @233,826,026: `D(e)=[...new Set(e)]`)
 * — the loader tail is `y = D([...store, ...extra])`. The trust sources
 * overlap in practice: system stores commonly re-ship Mozilla roots that are
 * also bundled, and NODE_EXTRA_CA_CERTS may re-add a root the store already
 * holds. OCC-123 supplement pin: the official dedupe was missing from the
 * OCC-163 loader port (`return [...storeCerts, ...extraCerts]`).
 */
const BLOCKED_CERT_HASHES = [
  "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b",
  "bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3",
  "40f6af0346a99aa1cd1d555a4e9cce62c7f9634603ee406615833dc8c8d00367",
  "125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f",
];

function certHash(pem: string): string {
  return createHash("sha256")
    .update(new X509Certificate(pem).raw)
    .digest("hex");
}

/** First bundled root that is NOT on the deny list. */
const benignPem = tls.rootCertificates.find(
  (pem) => !BLOCKED_CERT_HASHES.includes(certHash(pem)),
);

const savedCertStore = process.env.CLAUDE_CODE_CERT_STORE;
const savedExtra = process.env.NODE_EXTRA_CA_CERTS;
const dir = mkdtempSync(join(tmpdir(), "occ-ca-dedupe-"));

afterAll(() => {
  if (savedCertStore === undefined) delete process.env.CLAUDE_CODE_CERT_STORE;
  else process.env.CLAUDE_CODE_CERT_STORE = savedCertStore;
  if (savedExtra === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = savedExtra;
  clearCACertsCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("2.1.303 dedupeCerts (official D)", () => {
  test("collapses exact-duplicate PEM strings, preserving first-occurrence order", () => {
    expect(dedupeCerts(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  test("is identity on a duplicate-free list and on the empty list", () => {
    expect(dedupeCerts(["a", "b"])).toEqual(["a", "b"]);
    expect(dedupeCerts([])).toEqual([]);
  });

  test("does not mutate its input", () => {
    const input: readonly string[] = Object.freeze(["a", "a"]);
    expect(dedupeCerts(input)).toEqual(["a"]);
    expect([...input]).toEqual(["a", "a"]);
  });
});

describe("2.1.303 getCACertificates loader dedupe (official Xn tail: y = D([...A, ...f]))", () => {
  test("NODE_EXTRA_CA_CERTS re-adding an already-bundled root does not duplicate it", () => {
    expect(benignPem).toBeDefined();
    process.env.CLAUDE_CODE_CERT_STORE = "bundled";
    const path = join(dir, "duplicate-of-bundled.pem");
    // Exact string match with the bundled entry — the official D dedupe is
    // Set-based, so the file content must be byte-identical (no trailing
    // newline) to collapse, exactly like the official loader.
    writeFileSync(path, benignPem as string, "utf8");
    process.env.NODE_EXTRA_CA_CERTS = path;
    clearCACertsCache();
    try {
      const certs = getCACertificates() as string[];
      expect(certs).toBeDefined();
      // Store contributes rootCertificates.length - 4 (blocked roots excised);
      // the extra file's single cert is byte-identical to a bundled root, so
      // the official dedupe collapses it — total stays at the store count.
      expect(certs.length).toBe(tls.rootCertificates.length - 4);
      expect(certs.filter((pem) => pem === benignPem).length).toBe(1);
      expect(new Set(certs).size).toBe(certs.length);
    } finally {
      delete process.env.NODE_EXTRA_CA_CERTS;
      clearCACertsCache();
    }
  });

  test("bundled,system output contains no duplicate PEM strings", () => {
    process.env.CLAUDE_CODE_CERT_STORE = "bundled,system";
    delete process.env.NODE_EXTRA_CA_CERTS;
    clearCACertsCache();
    try {
      const certs = getCACertificates() as string[];
      expect(certs).toBeDefined();
      // System stores commonly re-ship Mozilla roots that are also bundled;
      // whatever the overlap is on this machine, D collapses it.
      expect(new Set(certs).size).toBe(certs.length);
    } finally {
      if (savedCertStore === undefined)
        delete process.env.CLAUDE_CODE_CERT_STORE;
      else process.env.CLAUDE_CODE_CERT_STORE = savedCertStore;
      clearCACertsCache();
    }
  });
});
