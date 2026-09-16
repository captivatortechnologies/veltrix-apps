// =============================================================================
// Deploy handler tests against a FAKE Microsoft Graph.
//
// Custom detection rules are the one config type in this app that talks to
// Graph beta rather than the Defender API — a different host, a different token
// audience, and a feature that does not exist in the gov clouds at all.
// =============================================================================

import deploy from '../deploy'
import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { DetectionRuleRollbackEntry } from '../deploy'
import { GRAPH_HOST, TOKEN_PATH, apiError, deployCtx, mockMdeFetch, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-detection-rules'
const RULE_ID = 'office-encoded-powershell'

function item(fields: Record<string, unknown> = {}, name = 'Encoded PowerShell from Office'): CanvasItemSnapshot {
  return {
    name,
    fields: {
      rule_id: RULE_ID,
      display_name: 'Encoded PowerShell from Office',
      query_text: 'DeviceProcessEvents | where ProcessCommandLine has "-enc"',
      frequency: 'PT1H',
      status: 'enabled',
      alert_title: 'Encoded PowerShell launched from Office',
      alert_description: 'Possible macro-based execution',
      alert_severity: 'high',
      alert_category: 'Execution',
      ...fields,
    },
  }
}

const emptyTenant = (method: string) =>
  method === 'GET' ? { status: 200, body: { value: [] } } : { status: 201, body: { id: RULE_ID } }

const rollbackEntries = (result: { rollbackData?: unknown }): DetectionRuleRollbackEntry[] =>
  (result.rollbackData as { previousState?: DetectionRuleRollbackEntry[] })?.previousState ?? []

describe('Defender Detection Rules Deploy Handler', () => {
  it('refuses before touching Graph when no credential is configured', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [item()], { credential: null }))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Client ID')
    expect(calls).toHaveLength(0)
  })

  it('refuses before touching Graph in a gov cloud, where custom detection rules do not exist', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(
      deployCtx(TYPE, [item()], { settings: { tenant_id: 'tenant', azure_cloud: 'gcc-high' } }),
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('commercial cloud')
    expect(calls).toHaveLength(0)
  })

  it('authenticates for the GRAPH audience, not the Defender one', async () => {
    const calls = mockMdeFetch(emptyTenant)
    await deploy(deployCtx(TYPE, [item()]))

    expect(calls[0].url).toContain(TOKEN_PATH)
    expect(String(calls[0].body)).toContain('scope=https%3A%2F%2Fgraph.microsoft.com%2F.default')
    expect(vendorCalls(calls)[0].url).toContain(GRAPH_HOST)
  })

  it('reads the live rules, then creates one that does not exist yet with its client-chosen id', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [item()]))

    const vendor = vendorCalls(calls)
    expect(vendor[0].method).toBe('GET')
    expect(vendor[0].url).toContain('/beta/security/rules/detectionRules')
    expect(vendor[1].method).toBe('POST')
    expect(vendor[1].body).toEqual({
      id: RULE_ID,
      displayName: 'Encoded PowerShell from Office',
      queryCondition: { queryText: 'DeviceProcessEvents | where ProcessCommandLine has "-enc"' },
      schedule: { frequency: 'PT1H' },
      status: 'enabled',
      detectionAction: {
        alertTemplate: {
          title: 'Encoded PowerShell launched from Office',
          description: 'Possible macro-based execution',
          severity: 'high',
          category: 'Execution',
        },
      },
    })
    expect(result.success).toBe(true)
    expect(result.message).toContain('1 created, 0 updated')
  })

  it('updates a rule that already exists, matching the id case-insensitively', async () => {
    const live = { id: RULE_ID.toUpperCase(), displayName: 'Old name', status: 'disabled' }
    const calls = mockMdeFetch((method) =>
      method === 'GET' ? { status: 200, body: { value: [live] } } : { status: 200, body: live },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    const patch = vendorCalls(calls).find((c) => c.method === 'PATCH')
    expect(patch?.url).toContain(`/security/rules/detectionRules/${RULE_ID.toUpperCase()}`)
    // The id lives in the URL on a PATCH; sending it in the body too is rejected.
    expect('id' in (patch?.body as Record<string, unknown>)).toBe(false)
    expect((patch?.body as Record<string, unknown>).displayName).toBe('Encoded PowerShell from Office')
    expect(vendorCalls(calls).filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(result.message).toContain('0 created, 1 updated')
  })

  it('records an updated rule with its prior state so rollback can restore it', async () => {
    const live = { id: RULE_ID, displayName: 'Old name', status: 'disabled', schedule: { frequency: 'P1D' } }
    mockMdeFetch((method) => (method === 'GET' ? { status: 200, body: { value: [live] } } : { status: 200, body: live }))
    const result = await deploy(deployCtx(TYPE, [item()]))

    const entries = rollbackEntries(result)
    expect(entries).toHaveLength(1)
    expect(entries[0].existed).toBe(true)
    expect(entries[0].id).toBe(RULE_ID)
    expect(entries[0].prior?.displayName).toBe('Old name')
    expect(entries[0].prior?.status).toBe('disabled')
  })

  it('records a created rule as new, falling back to the declared id when Graph echoes none', async () => {
    mockMdeFetch((method) => (method === 'GET' ? { status: 200, body: { value: [] } } : { status: 201, body: {} }))
    const result = await deploy(deployCtx(TYPE, [item()]))

    const entries = rollbackEntries(result)
    expect(entries[0].existed).toBe(false)
    expect(entries[0].id).toBe(RULE_ID)
    expect(entries[0].prior).toBeUndefined()
  })

  it('returns a FAILED result instead of throwing when Graph rejects the create', async () => {
    mockMdeFetch((method) =>
      method === 'GET' ? { status: 200, body: { value: [] } } : { status: 403, body: apiError('CustomDetection.ReadWrite.All is required') },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('CustomDetection.ReadWrite.All is required')
    expect(result.message).toContain('failed after 0 of 1')
  })

  it('writes nothing when the live rules cannot be read', async () => {
    const calls = mockMdeFetch(() => ({ status: 500, body: apiError('Graph unavailable') }))
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Failed to list detection rules')
    expect(vendorCalls(calls).filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('omits the optional alert fields that were left blank', async () => {
    const calls = mockMdeFetch(emptyTenant)
    await deploy(deployCtx(TYPE, [item({ alert_category: '', recommended_actions: '' })]))

    const alert = ((vendorCalls(calls).find((c) => c.method === 'POST')?.body as Record<string, unknown>)
      .detectionAction as { alertTemplate: Record<string, unknown> }).alertTemplate
    expect('category' in alert).toBe(false)
    expect('recommendedActions' in alert).toBe(false)
  })

  it('skips canvas items with no rule id rather than posting an unidentifiable rule', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [{ name: 'placeholder', fields: {} }, item()]))

    expect(vendorCalls(calls).filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(result.message).toContain('Deployed 1 detection rule(s)')
  })
})
