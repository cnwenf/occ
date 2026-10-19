import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

import { clearCACertsCache, filterExpiredCertificates, getCACertificates } from "../caCerts";
import {
  collectBlockedBundledRoots,
  dropBlockedCertificates,
  findPemBlocks,
  resolveTrustedCertificates,
  warnIgnoredExtraCerts,
} from "../caDenyList";

/**
 * claude-code 2.1.303: the CLI carries a root-certificate deny list (four
 * eMudhra/emSign roots). Blocked roots are cut out of the bundled store, the
 * system store, and NODE_EXTRA_CA_CERTS before any TLS connection.
 *
 * Fixtures are derived from the live bundled store (tls.rootCertificates) by
 * deny-list hash, so the pins hold across runtime root-store updates.
 */
const BLOCKED_CERT_HASHES = [
  "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b",
  "bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3",
  "40f6af0346a99aa1cd1d555a4e9cce62c7f9634603ee406615833dc8c8d00367",
  "125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f",
];

/** Self-signed fixture, notAfter = 2025-10-20 (already expired). */
const EXPIRED_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIICyDCCAbCgAwIBAgIUTFyEXLejMJVqbJZnl5BAhV1iqf0wDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTb2NjLWV4cGlyZWQtZml4dHVyZTAeFw0yNDEwMjAwMDAw
MDBaFw0yNTEwMjAwMDAwMDBaMB4xHDAaBgNVBAMME29jYy1leHBpcmVkLWZpeHR1
cmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDTzXqaN/6dJM26Va5z
rjTeNTVJ/xMjj5iZtEJjlZ9cVvrdOUeBeLVi+tHh+cC7AR4Di6CAzSyENFmsECmx
uqY3yhCZj8K1gBLlsLJr4fk/SZ//bbAtp9tT/LtVX3u4NjO0SvhD43+f8ui0Q7G4
ofUXCNbhCPHxlK74+11WjfXIvU6OWILJwqyWWFsgc0O57+eskpUomuXWyF0UBmiu
CtFgYO1abtgDtTwdrRuz4sT5b+co1GuWRMCytLq5b4UtsWxyqpjO2epjleKRCycm
U/QfwMkg8eOqevKGwG0xDOk1T6weuSQUaY5vMTf08x18SOiIkrHRbj4QDxVunYmf
ipXJAgMBAAEwDQYJKoZIhvcNAQELBQADggEBALcTapRiXUmxu/X0niga9o25gY0q
hI+pn4CcjZL1t19b3fYfoeTNhjBVm+1bwamnFATKP4CfbtRaDLKr88a+71J6Ig06
rJ9VSR/I9t9s1DHI68LBOZV26Vw1IUdYHwadzU9pDtDiampRGA/ApnDo7c9R/ELO
2eUEX7BzKdkFNA3dECP6ednwkEzVVPbsx6SyE7spyIKsJ4x9BSkYTr/6rO6J0CNg
luX4iSkuwo+YFFU0wUoSZGf3sQOndD/5W3VjMiHmM3RBWSmuza1J+dtZgOofnXo1
bv218vFXCwFxp/KG8ftSAnBFvE7t41T6rQgAU3IRLMS9diKjf1DwjzwXKb4=
-----END CERTIFICATE-----`;

function certHash(pem: string): string {
  return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
}

function pemBody(pem: string): string {
  return pem
    .slice(pem.indexOf("-----", 5) + 5, pem.lastIndexOf("-----END"))
    .replace(/\s+/g, "");
}

function tryParse(pem: string): X509Certificate | undefined {
  try {
    return new X509Certificate(pem);
  } catch {
    return undefined;
  }
}

/** Hashes of every parseable PEM block across all entries. */
function allCertHashes(entries: readonly string[]): string[] {
  const hashes: string[] = [];
  for (const text of entries) {
    for (const [start, end] of findPemBlocks(text)) {
      const parsed = tryParse(text.slice(start, end));
      if (parsed) {
        hashes.push(certHash(text.slice(start, end)));
      }
    }
  }
  return hashes;
}

const blockedPems: string[] = [];
let benignPem = "";
for (const pem of tls.rootCertificates) {
  const parsed = tryParse(pem);
  if (!parsed) continue;
  const hash = certHash(pem);
  if (BLOCKED_CERT_HASHES.includes(hash)) {
    blockedPems.push(pem);
  } else if (!benignPem) {
    benignPem = pem;
  }
}

beforeAll(() => {
  // All four deny-listed emSign roots must be present in the bundled store,
  // otherwise the deny-list would be a no-op and these pins vacuous.
  expect(blockedPems.length).toBe(4);
  expect(benignPem).not.toBe("");
});

describe("2.1.303 collectBlockedBundledRoots (official nt)", () => {
  test("finds exactly the four eMudhra/emSign roots in the bundled store", () => {
    const blocked = collectBlockedBundledRoots(tls.rootCertificates);
    expect(blocked.length).toBe(4);
    const hashes = blocked.map((entry) => entry.hash).sort();
    expect(hashes).toEqual([...BLOCKED_CERT_HASHES].sort());
    for (const pem of blockedPems) {
      expect(new X509Certificate(pem).subject).toContain("emSign");
    }
  });

  test("records truncated-DER base64 that substring-matches the PEM body", () => {
    const blocked = collectBlockedBundledRoots(tls.rootCertificates);
    for (const entry of blocked) {
      const sourcePem = blockedPems.find((pem) => certHash(pem) === entry.hash);
      expect(sourcePem).toBeDefined();
      expect(pemBody(sourcePem as string).includes(entry.base64)).toBe(true);
    }
  });
});

describe("2.1.303 findPemBlocks (official Qe)", () => {
  test("returns one range per consecutive certificate block", () => {
    const text = `${benignPem}\n${blockedPems[0] as string}`;
    const ranges = findPemBlocks(text);
    expect(ranges.length).toBe(2);
    for (const [start, end] of ranges) {
      expect(text.slice(start, end)).toStartWith("-----BEGIN ");
      expect(text.slice(start, end)).toEndWith("-----");
      expect(tryParse(text.slice(start, end))).toBeDefined();
    }
  });

  test("ignores a dangling -----END with no preceding BEGIN", () => {
    expect(findPemBlocks("-----END CERTIFICATE-----")).toEqual([]);
  });

  test("ignores an END label containing a newline before its closing dashes", () => {
    const text = `${benignPem}\n-----END XYZ\n-----`;
    const ranges = findPemBlocks(text);
    expect(ranges.length).toBe(1);
    expect(tryParse(text.slice(ranges[0]![0], ranges[0]![1]))).toBeDefined();
  });
});

describe("2.1.303 dropBlockedCertificates (official Ee)", () => {
  const blocked = collectBlockedBundledRoots(tls.rootCertificates);

  test("cuts a blocked root out of an entry, keeping benign neighbors", () => {
    const otherBenign = tls.rootCertificates.find(
      (pem) => pem !== benignPem && tryParse(pem) && !BLOCKED_CERT_HASHES.includes(certHash(pem)),
    ) as string;
    const entry = { pem: `${benignPem}\n${blockedPems[0]}\n${otherBenign}`, source: "bundled" };
    const result = dropBlockedCertificates([entry], blocked);
    expect(result.length).toBe(1);
    const hashes = allCertHashes(result);
    expect(hashes).not.toContain(BLOCKED_CERT_HASHES[0]);
    expect(hashes.length).toBe(2);
    expect((result[0] as string).includes("-----BEGIN CERTIFICATE-----")).toBe(true);
  });

  test("drops an entry that consisted only of a blocked root", () => {
    const result = dropBlockedCertificates(
      [{ pem: blockedPems[0] as string, source: "bundled" }],
      blocked,
    );
    expect(result).toEqual([]);
  });

  test("drops an unparseable block whose text contains a blocked root's base64", () => {
    // Unreadable-block detector (official `l`): the block does not parse as
    // X509 (junk prefix shifts the DER), but the deny-listed base64 survives
    // as a literal substring after whitespace stripping.
    const unreadable = `-----BEGIN CERTIFICATE-----\nQUJD\n${pemBody(blockedPems[0] as string)}\n-----END CERTIFICATE-----`;
    expect(tryParse(unreadable)).toBeUndefined();
    const result = dropBlockedCertificates([{ pem: unreadable, source: "bundled" }], blocked);
    expect(result).toEqual([]);
  });

  test("keeps an unparseable junk block that contains no blocked content", () => {
    const junk = "-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----";
    const result = dropBlockedCertificates([{ pem: junk, source: "bundled" }], blocked);
    expect(result).toEqual([junk]);
  });

  test("strips blocked certs re-exposed by cut-and-rejoin (split-marker chain)", () => {
    // Each stripped block re-fuses "-----BEGI" + "N CERTIFICATE-----" into a
    // new header, exposing the next blocked body — exercises the multi-pass
    // loop (official passes 0..me). The >8-deep branch is a pathological
    // safety valve kept byte-identical to the official; it is covered by the
    // nested warning pin below instead.
    const tail = `${pemBody(blockedPems[1] as string)}\n-----END CERTIFICATE-----`;
    let chain = tail;
    for (let layer = 0; layer < 3; layer++) {
      chain = `-----BEGI${blockedPems[0]}N CERTIFICATE-----\n${chain}`;
    }
    const result = dropBlockedCertificates([{ pem: chain, source: "bundled" }], blocked);
    expect(result).toEqual([]);

    // A benign cert trailing the chain survives: "the other certificates in
    // the file are still used".
    const withBenign = dropBlockedCertificates(
      [{ pem: `${chain}\n${benignPem}`, source: "bundled" }],
      blocked,
    );
    expect(withBenign.length).toBe(1);
    const hashes = allCertHashes(withBenign);
    expect(hashes).toEqual([certHash(benignPem)]);
  });
});

describe("2.1.303 warnIgnoredExtraCerts (official Ze)", () => {
  test("emits verbatim messages, dedupes per kind+hash", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const warned = new Set<string>();
      warnIgnoredExtraCerts("block", "h1", warned);
      warnIgnoredExtraCerts("block", "h1", warned);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenLastCalledWith(
        "Claude Code ignored a block in the NODE_EXTRA_CA_CERTS file: the block holds a root certificate on the CLI's deny list, in a form Claude Code could not read. The other certificates in the file are still used.",
      );
      warnIgnoredExtraCerts("file", "h1", warned);
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenLastCalledWith(
        "Claude Code ignored all of the NODE_EXTRA_CA_CERTS file: it holds a root certificate on the CLI's deny list, in a form Claude Code could not read. Run Claude Code with --debug to write its SHA-256 fingerprint to the debug log, then remove that certificate from the file.",
      );
      warnIgnoredExtraCerts("nested", "h2", warned);
      expect(errorSpy).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenLastCalledWith(
        "Claude Code ignored all of the NODE_EXTRA_CA_CERTS file: it holds root certificates on the CLI's deny list nested too deeply to cut out. Remove them so the rest of the file is used.",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("2.1.303 resolveTrustedCertificates (official qn)", () => {
  test("falls back to the deny-list-filtered bundled roots on empty entries", () => {
    const resolved = resolveTrustedCertificates([], tls.rootCertificates);
    expect(resolved.length).toBe(tls.rootCertificates.length - 4);
    expect(allCertHashes(resolved).some((hash) => BLOCKED_CERT_HASHES.includes(hash))).toBe(false);
  });

  test("throws the verbatim message when every candidate root is blocked", () => {
    const onlyBlocked = blockedPems[0] as string;
    expect(() =>
      resolveTrustedCertificates([{ pem: onlyBlocked, source: "bundled" }], [onlyBlocked]),
    ).toThrow(
      "No root certificates are left to trust: every root built into this runtime is on the CLI's deny list. Update Claude Code.",
    );
  });
});

describe("2.1.303 filterExpiredCertificates (official Mn)", () => {
  test("drops an expired cert, keeps a valid root and an unparseable entry", () => {
    const unparseable = "-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----";
    const kept = filterExpiredCertificates([EXPIRED_CERT_PEM, benignPem, unparseable]);
    expect(kept).toEqual([benignPem, unparseable]);
  });

  test("keeps everything when nothing is expired", () => {
    const input = [benignPem, blockedPems[0] as string];
    expect(filterExpiredCertificates(input)).toEqual(input);
  });
});

describe("2.1.303 getCACertificates loader (official Xn)", () => {
  const savedCertStore = process.env.CLAUDE_CODE_CERT_STORE;
  const savedExtra = process.env.NODE_EXTRA_CA_CERTS;
  const dir = mkdtempSync(join(tmpdir(), "occ-ca-denylist-"));
  const expectedStoreCount = tls.rootCertificates.length - 4;

  beforeAll(() => {
    process.env.CLAUDE_CODE_CERT_STORE = "bundled";
  });
  afterAll(() => {
    if (savedCertStore === undefined) delete process.env.CLAUDE_CODE_CERT_STORE;
    else process.env.CLAUDE_CODE_CERT_STORE = savedCertStore;
    if (savedExtra === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = savedExtra;
    clearCACertsCache();
    rmSync(dir, { recursive: true, force: true });
  });

  function withExtraFile(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content, "utf8");
    process.env.NODE_EXTRA_CA_CERTS = path;
    clearCACertsCache();
    return path;
  }

  test("excludes the four eMudhra roots from the bundled store", () => {
    delete process.env.NODE_EXTRA_CA_CERTS;
    clearCACertsCache();
    const certs = getCACertificates();
    expect(certs).toBeDefined();
    expect((certs as string[]).length).toBe(expectedStoreCount);
    const hashes = allCertHashes(certs as string[]);
    for (const blocked of BLOCKED_CERT_HASHES) {
      expect(hashes).not.toContain(blocked);
    }
  });

  test("filters a blocked root out of NODE_EXTRA_CA_CERTS, appends the benign one", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      withExtraFile("mixed.pem", `${benignPem}\n${blockedPems[2]}\n`);
      const certs = getCACertificates() as string[];
      expect(certs.length).toBe(expectedStoreCount + 1);
      const appended = certs[certs.length - 1] as string;
      expect(allCertHashes([appended])).toEqual([certHash(benignPem)]);
      expect(allCertHashes(certs).some((hash) => BLOCKED_CERT_HASHES.includes(hash))).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("appends nothing when the file holds only a blocked root (parseable)", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      withExtraFile("blocked-only.pem", `${blockedPems[3]}\n`);
      const certs = getCACertificates() as string[];
      expect(certs.length).toBe(expectedStoreCount);
      // The block parsed cleanly, so no user-facing warning fires (official:
      // Ze only on residual or unreadable-block content).
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("warns with the verbatim 'file' message when only an unreadable blocked block exists", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const unreadable = `-----BEGIN CERTIFICATE-----\nQUJD\n${pemBody(blockedPems[1] as string)}\n-----END CERTIFICATE-----\n`;
      withExtraFile("unreadable.pem", unreadable);
      const certs = getCACertificates() as string[];
      expect(certs.length).toBe(expectedStoreCount);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenLastCalledWith(
        "Claude Code ignored all of the NODE_EXTRA_CA_CERTS file: it holds a root certificate on the CLI's deny list, in a form Claude Code could not read. Run Claude Code with --debug to write its SHA-256 fingerprint to the debug log, then remove that certificate from the file.",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
