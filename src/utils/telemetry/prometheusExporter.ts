// 2.1.216 #26 — Prometheus metrics endpoint must not emit invalid `# UNIT`
// lines.
//
// The OpenTelemetry `@opentelemetry/exporter-prometheus` library serves the
// metrics endpoint with `content-type: text/plain` (plain Prometheus
// exposition format, version 0.0.1). Its `PrometheusSerializer` emits `# UNIT`
// comment lines for any metric carrying a `unit` descriptor. `# UNIT` is only
// valid in the OpenMetrics 1.0.0 format (`application/openmetrics-text`); in
// plain `text/plain` exposition it is invalid and causes scrapers to reject or
// warn on the payload.
//
// This module wraps the library `PrometheusExporter` so the serialized
// exposition output never contains a `# UNIT` line, while preserving `# HELP`
// and `# TYPE` comments and all metric samples.

/**
 * Strip every `# UNIT <name> <unit>` comment line from a Prometheus exposition
 * payload. `# HELP` and `# TYPE` lines (and all sample lines) are preserved
 * untouched. Lines are matched at line start so a metric *value* containing the
 * substring "# UNIT" is never touched.
 *
 * Each removed `# UNIT` line also removes its trailing newline so the payload
 * does not grow blank lines.
 */
export function stripUnitLines(exposition: string): string {
  return exposition
    .split('\n')
    .filter(line => !line.startsWith('# UNIT '))
    .join('\n')
}

/**
 * Build a Prometheus exporter with the invalid `# UNIT` comment lines stripped
 * from its serialized output.
 *
 * The library `PrometheusExporter` constructs its own HTTP server and
 * `PrometheusSerializer`; the serializer emits `# UNIT` lines which are invalid
 * for the `text/plain` content-type the exporter sets. We wrap the exporter's
 * serializer so `serialize()` post-filters its own output through
 * {@link stripUnitLines}.
 *
 * Lazily imports `@opentelemetry/exporter-prometheus` so the ~prometheus
 * exporter chunk stays out of startup for processes that never select it.
 */
export async function createPrometheusExporterWithoutUnitLines(): Promise<
  // The concrete type is `PrometheusExporter` from the library; we keep the
  // return type loose to avoid a static import that would load the chunk on
  // every startup.
  unknown
> {
  const { PrometheusExporter } = await import(
    '@opentelemetry/exporter-prometheus'
  )
  const exporter = new PrometheusExporter()

  // Wrap the serializer's serialize() so # UNIT lines are stripped from the
  // served exposition payload. The exporter holds the serializer on a private
  // `_serializer` field; we patch it in place after construction.
  const serializer = (
    exporter as unknown as { _serializer: { serialize: (data: unknown) => string } }
  )._serializer
  const originalSerialize = serializer.serialize.bind(serializer)
  serializer.serialize = (data: unknown): string =>
    stripUnitLines(originalSerialize(data))

  return exporter
}
