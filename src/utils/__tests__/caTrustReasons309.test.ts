import { afterEach, describe, expect, spyOn, test } from "bun:test";
import tls from "node:tls";
import * as caDenyList from "../caDenyList";
import {
  CA_TRUST_FAILURE_REASONS,
  clearCACertsCache,
  getCACertificates,
  noCertificateAuthorityMessage,
} from "../caCerts";

/**
 * claude-code 2.1.309 (F-20): the CA-store loader (`Kr`, BIN309 @241,583,000)
 * now tracks WHY the system store could not supply trust and, when the
 * resolved store list comes back empty, throws the official
 * "No certificate authority to trust: …" diagnostic interpolating that reason.
 *
 * Reason strings are byte-verbatim from BIN309:
 *   default:      @241,583,9xx  "every certificate in the system CA store is expired or on the deny list"
 *   empty store:  `h=l?"the system CA store is empty: check that this process can read its CA files
 *                  (SSL_CERT_FILE, SSL_CERT_DIR, or the system's default paths)"
 *                  :"the runtime has no system CA store"`
 *   read failure: catch branch  "reading the system CA store failed"
 *
 * In the shipped official CLI the empty-resolve path is gated by
 * `refusesBundledFallback` (class default `!1` @241,573,710; never assigned
 * true in the binary — only host-provided config can set it), so the guard is
 * defensive here exactly as it is in the CLI. Tests force the empty resolve by
 * spying `resolveTrustedCertificates` (official `qr` @241,581,524, which
 * itself throws the older 303 "No root certificates are left to trust" message
 * before it could ever return []).
 */

const SAVED_CERT_STORE = process.env.CLAUDE_CODE_CERT_STORE;
const SAVED_EXTRA = process.env.NODE_EXTRA_CA_CERTS;

afterEach(() => {
  if (SAVED_CERT_STORE === undefined) delete process.env.CLAUDE_CODE_CERT_STORE;
  else process.env.CLAUDE_CODE_CERT_STORE = SAVED_CERT_STORE;
  if (SAVED_EXTRA === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = SAVED_EXTRA;
  clearCACertsCache();
});

describe("2.1.309 CA_TRUST_FAILURE_REASONS (official Kr reason variable h)", () => {
  test("carries the four reason strings byte-verbatim from BIN309", () => {
    expect(CA_TRUST_FAILURE_REASONS.expiredOrDenied).toBe(
      "every certificate in the system CA store is expired or on the deny list",
    );
    expect(CA_TRUST_FAILURE_REASONS.emptySystemStore).toBe(
      "the system CA store is empty: check that this process can read its CA files (SSL_CERT_FILE, SSL_CERT_DIR, or the system's default paths)",
    );
    expect(CA_TRUST_FAILURE_REASONS.noSystemStore).toBe(
      "the runtime has no system CA store",
    );
    expect(CA_TRUST_FAILURE_REASONS.readFailed).toBe(
      "reading the system CA store failed",
    );
  });
});

describe("2.1.309 noCertificateAuthorityMessage (official Kr throw)", () => {
  test("interpolates the reason into the verbatim throw message", () => {
    expect(noCertificateAuthorityMessage(CA_TRUST_FAILURE_REASONS.expiredOrDenied)).toBe(
      "No certificate authority to trust: CLAUDE_CODE_CERT_STORE=system (or NODE_OPTIONS --use-system-ca or --use-openssl-ca) leaves out the runtime's bundled roots, and every certificate in the system CA store is expired or on the deny list. NODE_EXTRA_CA_CERTS only adds to the store; it does not count on its own.",
    );
    expect(noCertificateAuthorityMessage(CA_TRUST_FAILURE_REASONS.noSystemStore)).toBe(
      "No certificate authority to trust: CLAUDE_CODE_CERT_STORE=system (or NODE_OPTIONS --use-system-ca or --use-openssl-ca) leaves out the runtime's bundled roots, and the runtime has no system CA store. NODE_EXTRA_CA_CERTS only adds to the store; it does not count on its own.",
    );
  });
});

describe("2.1.309 getCACertificates empty-resolve guard (official P.length===0 throw)", () => {
  function withEmptyResolve(fn: () => void): void {
    const resolveSpy = spyOn(caDenyList, "resolveTrustedCertificates").mockReturnValue([]);
    try {
      fn();
    } finally {
      resolveSpy.mockRestore();
      clearCACertsCache();
    }
  }

  test("bundled-only store: throws with the default expired-or-deny-listed reason", () => {
    process.env.CLAUDE_CODE_CERT_STORE = "bundled";
    delete process.env.NODE_EXTRA_CA_CERTS;
    clearCACertsCache();
    withEmptyResolve(() => {
      expect(() => getCACertificates()).toThrow(
        noCertificateAuthorityMessage(CA_TRUST_FAILURE_REASONS.expiredOrDenied),
      );
    });
  });

  test("system store returns empty: throws with the 'system CA store is empty' reason", () => {
    process.env.CLAUDE_CODE_CERT_STORE = "system";
    delete process.env.NODE_EXTRA_CA_CERTS;
    clearCACertsCache();
    const getSpy = spyOn(tls as typeof tls & { getCACertificates?: (type: string) => string[] }, "getCACertificates")
      .mockReturnValue([]);
    try {
      withEmptyResolve(() => {
        expect(() => getCACertificates()).toThrow(
          noCertificateAuthorityMessage(CA_TRUST_FAILURE_REASONS.emptySystemStore),
        );
      });
    } finally {
      getSpy.mockRestore();
    }
  });

  test("system CA API unavailable: throws with the 'runtime has no system CA store' reason", () => {
    process.env.CLAUDE_CODE_CERT_STORE = "system";
    delete process.env.NODE_EXTRA_CA_CERTS;
    clearCACertsCache();
    const holder = tls as typeof tls & { getCACertificates?: (type: string) => string[] };
    const saved = holder.getCACertificates;
    delete holder.getCACertificates;
    try {
      withEmptyResolve(() => {
        expect(() => getCACertificates()).toThrow(
          noCertificateAuthorityMessage(CA_TRUST_FAILURE_REASONS.noSystemStore),
        );
      });
    } finally {
      if (saved !== undefined) holder.getCACertificates = saved;
    }
  });

  test("system store read throws: guard uses the 'reading the system CA store failed' reason", () => {
    process.env.CLAUDE_CODE_CERT_STORE = "system";
    delete process.env.NODE_EXTRA_CA_CERTS;
    clearCACertsCache();
    const getSpy = spyOn(tls as typeof tls & { getCACertificates?: (type: string) => string[] }, "getCACertificates")
      .mockImplementation(() => {
        throw new Error("simulated store read failure");
      });
    try {
      withEmptyResolve(() => {
        expect(() => getCACertificates()).toThrow(
          noCertificateAuthorityMessage(CA_TRUST_FAILURE_REASONS.readFailed),
        );
      });
    } finally {
      getSpy.mockRestore();
    }
  });

  test("a healthy store resolves normally (guard does not fire)", () => {
    process.env.CLAUDE_CODE_CERT_STORE = "bundled";
    delete process.env.NODE_EXTRA_CA_CERTS;
    clearCACertsCache();
    const certs = getCACertificates();
    expect(certs).toBeDefined();
    expect((certs as string[]).length).toBeGreaterThan(0);
  });
});
