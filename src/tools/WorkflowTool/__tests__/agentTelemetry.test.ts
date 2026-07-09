import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  logEvent,
  attachAnalyticsSink,
  _resetForTesting,
  type AnalyticsSink,
} from '../../../services/analytics/index.js'
import { workflowAgentTelemetryAttributes } from '../primitives.js'

/**
 * 2.1.202: workflow-spawned agent telemetry must carry `workflow.run_id` and
 * `workflow.name` OpenTelemetry attributes so a run's activity can be
 * reconstructed from OTel data. OCC's analytics sink is stubbed, so this is
 * no-op parity — the stubbed logEvent still accepts the dotted-key attributes.
 */

const RUN_ID = 'wf_abc123def456'
const WORKFLOW_NAME = 'research-and-summarize'

describe('2.1.202 workflow.run_id + workflow.name OTel attributes', () => {
  test('helper returns the dotted OTel attribute keys (not snake_case)', () => {
    const attrs = workflowAgentTelemetryAttributes(RUN_ID, WORKFLOW_NAME)
    // Dotted OTel form — the official attribute names per the 2.1.202 changelog.
    expect(attrs['workflow.run_id']).toBe(RUN_ID)
    expect(attrs['workflow.name']).toBe(WORKFLOW_NAME)
    // Must NOT use the legacy snake_case keys for these OTel attributes.
    expect(attrs).not.toHaveProperty('workflow_run_id')
    expect(attrs).not.toHaveProperty('workflow_name')
  })

  test('helper carries the run id + name for arbitrary inputs', () => {
    const attrs = workflowAgentTelemetryAttributes('wf_x', 'my-wf')
    expect(attrs['workflow.run_id']).toBe('wf_x')
    expect(attrs['workflow.name']).toBe('my-wf')
  })
})

describe('2.1.202 agent-spawn telemetry call includes run_id + name', () => {
  let recorded: Array<{ eventName: string; metadata: Record<string, unknown> }>
  let sink: AnalyticsSink

  beforeEach(() => {
    _resetForTesting()
    recorded = []
    sink = {
      logEvent: (eventName, metadata) => {
        recorded.push({ eventName, metadata: { ...metadata } })
      },
      logEventAsync: async (eventName, metadata) => {
        recorded.push({ eventName, metadata: { ...metadata } })
      },
    }
    attachAnalyticsSink(sink)
  })

  afterEach(() => {
    _resetForTesting()
  })

  test('tengu_workflow_agent_started telemetry includes both attributes', () => {
    // Mirrors the logEvent call in primitives.ts agent() at spawn time.
    logEvent('tengu_workflow_agent_started', {
      ...workflowAgentTelemetryAttributes(RUN_ID, WORKFLOW_NAME),
      agent_id: 'wf-agent-0001',
      phase: 'research',
      model: 'sonnet',
    })

    expect(recorded).toHaveLength(1)
    const ev = recorded[0]
    expect(ev.eventName).toBe('tengu_workflow_agent_started')
    // The stubbed sink accepted the dotted-key string attributes (no-op parity).
    expect(ev.metadata['workflow.run_id']).toBe(RUN_ID)
    expect(ev.metadata['workflow.name']).toBe(WORKFLOW_NAME)
    expect(ev.metadata['agent_id']).toBe('wf-agent-0001')
  })

  test('tengu_workflow_agent_completed telemetry includes both attributes', () => {
    logEvent('tengu_workflow_agent_completed', {
      ...workflowAgentTelemetryAttributes(RUN_ID, WORKFLOW_NAME),
      agent_id: 'wf-agent-0001',
      status: 'done',
      tokens: 1234,
      tool_use_count: 5,
      elapsed_ms: 9000,
    })

    expect(recorded).toHaveLength(1)
    const ev = recorded[0]
    expect(ev.eventName).toBe('tengu_workflow_agent_completed')
    expect(ev.metadata['workflow.run_id']).toBe(RUN_ID)
    expect(ev.metadata['workflow.name']).toBe(WORKFLOW_NAME)
    expect(ev.metadata['status']).toBe('done')
  })
})
