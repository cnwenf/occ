/**
 * Semver comparison utilities that use Bun.semver when available
 * and fall back to the npm `semver` package in Node.js environments.
 *
 * Bun.semver.order() is ~20x faster than npm semver comparisons.
 * The npm semver fallback always uses { loose: true }.
 */

let _npmSemver: typeof import('semver') | undefined

function getNpmSemver(): typeof import('semver') {
  if (!_npmSemver) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _npmSemver = require('semver') as typeof import('semver')
  }
  return _npmSemver
}

export function gt(a: string, b: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b) === 1
  }
  return getNpmSemver().gt(a, b, { loose: true })
}

export function gte(a: string, b: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b) >= 0
  }
  return getNpmSemver().gte(a, b, { loose: true })
}

export function lt(a: string, b: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b) === -1
  }
  return getNpmSemver().lt(a, b, { loose: true })
}

export function lte(a: string, b: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b) <= 0
  }
  return getNpmSemver().lte(a, b, { loose: true })
}

export function satisfies(version: string, range: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.satisfies(version, range)
  }
  return getNpmSemver().satisfies(version, range, { loose: true })
}

export function order(a: string, b: string): -1 | 0 | 1 {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b)
  }
  return getNpmSemver().compare(a, b, { loose: true })
}

/**
 * Parse a version string and return the clean semver version, or null if it is
 * not a valid semver. Mirrors the official `semver.parse(v)?.version` used by
 * the startup version gate (requiredMinimumVersion/requiredMaximumVersion):
 * validating the managed constraint before comparing, and logging+ignoring
 * when it is not a valid semver. Always uses the npm `semver` package for
 * parsing (the official binary uses the same package for parse, Bun.semver
 * only for order/gte/lte).
 */
export function parseVersion(v: string): string | null {
  return getNpmSemver().parse(v, { loose: true })?.version ?? null
}
