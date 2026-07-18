import { describe, expect, test } from "bun:test"
import { hasUnsafeHelpManForm } from "../bashPermissions"

/** M5 (CC 2.1.214): help/man with unsafe options, command substitutions, or
 * backslash paths no longer auto-approved as read-only. Pure helper TDD. */

describe("M5 (2.1.214): help/man unsafe form detection", () => {
  test("man ls → false (plain, auto-allowed)", () => {
    expect(hasUnsafeHelpManForm("man ls")).toBe(false)
  })
  test("help ls → false (plain, auto-allowed)", () => {
    expect(hasUnsafeHelpManForm("help ls")).toBe(false)
  })
  test("man $(whoami) → true (command substitution)", () => {
    expect(hasUnsafeHelpManForm("man $(whoami)")).toBe(true)
  })
  test("help `whoami` → true (backtick substitution)", () => {
    expect(hasUnsafeHelpManForm("help `whoami`")).toBe(true)
  })
  test("man \\\\path → true (backslash path)", () => {
    expect(hasUnsafeHelpManForm("man \\\\path")).toBe(true)
  })
  test("echo hello → false (not help/man)", () => {
    expect(hasUnsafeHelpManForm("echo hello")).toBe(false)
  })
  test("echo foo && man $(x) → true (man at command-start + substitution)", () => {
    expect(hasUnsafeHelpManForm("echo foo && man $(x)")).toBe(true)
  })
  test("echo foo && man ls → false (man plain, no substitution anywhere)", () => {
    expect(hasUnsafeHelpManForm("echo foo && man ls")).toBe(false)
  })
})
