import { describe, expect, test } from 'bun:test'
import {
  deriveForkName,
  FORK_NAME_FALLBACK,
} from './name.js'

/**
 * `deriveForkName` is a verbatim mirror of the official 2.1.212 `uwd`:
 *
 *   e.trim().split(/\s+/).slice(0,3).join("-").toLowerCase()
 *    .replace(/[^a-z0-9-]/g,"").replace(/-+/g,"-").replace(/^-|-$/g,"")
 *    .slice(0,24) || "fork"
 *
 * These tests pin the algorithm symbol-by-symbol so a regression in any step
 * (trim, first-3-words, join, lowercase, char-class filter, hyphen collapse,
 * edge trim, 24-cap, fallback) is caught.
 */
describe('deriveForkName (mirrors official uwd)', () => {
  test('leader example: "Deploy to staging" -> "deploy-to-staging"', () => {
    expect(deriveForkName('Deploy to staging')).toBe('deploy-to-staging')
  })

  test('joins the first 3 whitespace-separated words with "-"', () => {
    expect(deriveForkName('hello world')).toBe('hello-world')
    expect(deriveForkName('one two three')).toBe('one-two-three')
  })

  test('drops words beyond the first 3', () => {
    expect(deriveForkName('refactor the auth module')).toBe('refactor-the-auth')
  })

  test('lowercases the result', () => {
    expect(deriveForkName('UPPER Case')).toBe('upper-case')
    expect(deriveForkName('DeployToStaging')).toBe('deploytostaging')
  })

  test('trims leading/trailing whitespace and collapses internal whitespace', () => {
    expect(deriveForkName('  leading   spaces  ')).toBe('leading-spaces')
    expect(deriveForkName('\tone\ttwo\tthree\t')).toBe('one-two-three')
  })

  test('drops characters outside [a-z0-9-] after lowercasing', () => {
    expect(deriveForkName('Hello, World!')).toBe('hello-world')
    expect(deriveForkName('fix #123 now')).toBe('fix-123-now')
  })

  test('collapses runs of "-" into a single "-"', () => {
    expect(deriveForkName('a--b')).toBe('a-b')
    expect(deriveForkName('one--two three')).toBe('one-two-three')
  })

  test('trims leading and trailing "-"', () => {
    expect(deriveForkName('--weird--')).toBe('weird')
  })

  test('caps the name at 24 characters', () => {
    const long = 'a'.repeat(30)
    expect(deriveForkName(long)).toBe('a'.repeat(24))
    // 24-char boundary: exactly 24 is kept, 25 is truncated.
    expect(deriveForkName('a'.repeat(24))).toBe('a'.repeat(24))
  })

  test('falls back to "fork" when the directive has no usable chars', () => {
    expect(deriveForkName('!!!')).toBe(FORK_NAME_FALLBACK)
    expect(deriveForkName('!!! ???')).toBe(FORK_NAME_FALLBACK)
  })

  test('falls back to "fork" for empty / whitespace-only directives', () => {
    expect(deriveForkName('')).toBe(FORK_NAME_FALLBACK)
    expect(deriveForkName('   ')).toBe(FORK_NAME_FALLBACK)
    expect(deriveForkName('\t\t')).toBe(FORK_NAME_FALLBACK)
  })

  test('FORK_NAME_FALLBACK is the official uwd literal "fork"', () => {
    expect(FORK_NAME_FALLBACK).toBe('fork')
  })
})
