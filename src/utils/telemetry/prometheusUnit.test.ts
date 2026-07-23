// 2.1.216 #26 — Prometheus metrics endpoint must not emit invalid `# UNIT`
// lines.
//
// The OpenTelemetry `@opentelemetry/exporter-prometheus` library's
// `PrometheusSerializer` emits `# UNIT` comment lines for any metric that
// has a `unit` descriptor. `# UNIT` is only valid in the OpenMetrics 1.0.0
// format (`application/openmetrics-text`); the exporter serves
// `text/plain` (plain Prometheus exposition, version 0.0.1), where `# UNIT`
// is invalid and causes scrapers to reject or warn on the payload.
//
// This test verifies the exposition-filtering helper never leaves a `# UNIT`
// line in the served payload, while preserving `# HELP`, `# TYPE`, and all
// metric samples.

import { describe, expect, test } from 'bun:test'
import { stripUnitLines } from './prometheusExporter.js'

describe('2.1.216 #26 — prometheus # UNIT lines', () => {
  test('serialized prometheus exposition contains no # UNIT comment lines', () => {
    // A sample payload mimicking what PrometheusSerializer produces:
    //   # HELP foo Total requests
    //   # UNIT foo requests
    //   # TYPE foo counter
    //   foo 42
    // After the fix, the `# UNIT` line must be stripped.
    const sampleWithUnit = [
      '# HELP foo_total Total requests',
      '# UNIT foo_total requests',
      '# TYPE foo_total counter',
      'foo_total 42',
      '',
    ].join('\n')

    const result = stripUnitLines(sampleWithUnit)

    expect(result).not.toContain('# UNIT')
    // # HELP and # TYPE must survive.
    expect(result).toContain('# HELP foo_total Total requests')
    expect(result).toContain('# TYPE foo_total counter')
    expect(result).toContain('foo_total 42')
  })

  test('a payload with no # UNIT lines is returned unchanged', () => {
    const clean = [
      '# HELP bar Some metric',
      '# TYPE bar gauge',
      'bar 7',
      '',
    ].join('\n')
    expect(stripUnitLines(clean)).toBe(clean)
  })

  test('multiple # UNIT lines are all stripped', () => {
    const multi = [
      '# HELP a Metric A',
      '# UNIT a bytes',
      '# TYPE a gauge',
      'a 1',
      '# HELP b Metric B',
      '# UNIT b seconds',
      '# TYPE b counter',
      'b 2',
      '',
    ].join('\n')
    const result = stripUnitLines(multi)
    expect(result).not.toContain('# UNIT')
    expect(result).toContain('# HELP a Metric A')
    expect(result).toContain('# HELP b Metric B')
  })

  test('a metric value containing the substring "# UNIT" is not touched', () => {
    // A sample line whose value text contains "# UNIT" but is NOT a comment
    // line — must not be stripped. Only lines that START with `# UNIT ` are
    // removed.
    const tricky = [
      '# HELP c Counter',
      '# TYPE c counter',
      'c{label="# UNIT suffix"} 3',
      '',
    ].join('\n')
    const result = stripUnitLines(tricky)
    // No line in the result starts with `# UNIT `.
    expect(result.split('\n').some(l => l.startsWith('# UNIT '))).toBe(false)
    // The value line itself must survive intact.
    expect(result).toContain('c{label="# UNIT suffix"} 3')
  })
})
