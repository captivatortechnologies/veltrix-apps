// =============================================================================
// Health-check handler tests against a FAKE Microsoft Graph.
// =============================================================================

import healthCheck from '../healthCheck'
import type { CanvasItemSnapshot, HealthCheck } from '@veltrixsecops/app-sdk'
import { apiError, healthCtx, mockMdeFetch } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-detection-rules'
const RULE_ID = 'office-encoded-powershell'
const OTHER_RULE_ID = 'lsass-credential-access'

function item(ruleId: string, name = ruleId): CanvasItemSnapshot {
  return {
    name,
    fields: {
      rule_id: ruleId,
      display_name: name,
      query_text: 'DeviceProcessEvents | take 1',
      frequency: 'PT1H',
      status: 'enabled',
      alert_title: 'Alert',
      alert_description: 'Description',
      alert_severity: 'high',
    },
  }
}

const listing = (rules: unknown[]) => () => ({ status: 200, body: { value: rules } })
const named = (checks: HealthCheck[], name: string): HealthCheck | undefined => checks.find((c) => c.name === name)

describe('Defender Detection Rules Health Handler', () => {
  it('fails closed without calling Graph when no credential is configured', async () => {
    const calls = mockMdeFetch(listing([]))
    const result = await healthCheck(healthCtx(TYPE, [item(RULE_ID)], { credential: null }))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks[0].name).toBe('mde_credential')
    expect(calls).toHaveLength(0)
  })

  it('reports the feature as unavailable in a gov cloud rather than probing Graph', async () => {
    const calls = mockMdeFetch(listing([]))
    const result = await healthCheck(
      healthCtx(TYPE, [item(RULE_ID)], { settings: { tenant_id: 'tenant', azure_cloud: 'gcc' } }),
    )

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks[0].name).toBe('graph_available')
    expect(calls).toHaveLength(0)
  })

  it('scores 100 when Graph is reachable and every declared rule is present', async () => {
    mockMdeFetch(listing([{ id: RULE_ID }]))
    const result = await healthCheck(healthCtx(TYPE, [item(RULE_ID)]))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(named(result.checks, `rule:${RULE_ID}`)?.passed).toBe(true)
  })

  it('fails the check for a rule that is gone, and drops the score', async () => {
    mockMdeFetch(listing([{ id: RULE_ID }]))
    const result = await healthCheck(healthCtx(TYPE, [item(RULE_ID), item(OTHER_RULE_ID)]))

    expect(result.healthy).toBe(false)
    expect(named(result.checks, `rule:${OTHER_RULE_ID}`)?.passed).toBe(false)
    expect(named(result.checks, `rule:${OTHER_RULE_ID}`)?.message).toBe('Detection rule is missing')
    expect(result.score).toBe(67)
  })

  it('reports unreachable rather than throwing, and claims no per-rule result it could not check', async () => {
    mockMdeFetch(() => ({ status: 503, body: apiError('Graph unavailable') }))
    const result = await healthCheck(healthCtx(TYPE, [item(RULE_ID)]))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(named(result.checks, 'graph_reachable')?.passed).toBe(false)
  })
})
