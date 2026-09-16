// =============================================================================
// Drift-detection handler tests against a FAKE Microsoft Graph.
// =============================================================================

import driftDetect from '../driftDetect'
import type { CanvasItemSnapshot, DriftDiff } from '@veltrixsecops/app-sdk'
import { apiError, credential, driftCtx, mockMdeFetch } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-detection-rules'
const RULE_ID = 'office-encoded-powershell'

function item(fields: Record<string, unknown> = {}): CanvasItemSnapshot {
  return {
    name: 'Encoded PowerShell from Office',
    fields: {
      rule_id: RULE_ID,
      display_name: 'Encoded PowerShell from Office',
      query_text: 'DeviceProcessEvents | take 1',
      frequency: 'PT1H',
      status: 'enabled',
      alert_title: 'Encoded PowerShell launched from Office',
      alert_description: 'Possible macro-based execution',
      alert_severity: 'high',
      ...fields,
    },
  }
}

function live(extra: Record<string, unknown> = {}) {
  return { id: RULE_ID, displayName: 'Encoded PowerShell from Office', status: 'enabled', ...extra }
}

const listing = (rules: unknown[]) => () => ({ status: 200, body: { value: rules } })
const find = (diffs: DriftDiff[], field: string): DriftDiff | undefined => diffs.find((d) => d.field === field)

describe('Defender Detection Rules Drift Handler', () => {
  it('makes no call and raises no diff when no credential is configured', async () => {
    const calls = mockMdeFetch(listing([]))
    const result = await driftDetect(driftCtx(TYPE, [item()], { credential: null }))

    expect(result.hasDrift).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('makes no call in a gov cloud, where the feature does not exist', async () => {
    const calls = mockMdeFetch(listing([]))
    const result = await driftDetect(driftCtx(TYPE, [item()], { settings: { tenant_id: 'tenant', azure_cloud: 'gcc' } }))

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('reads the DEPLOYED snapshot and reports a deleted rule as critical drift', async () => {
    mockMdeFetch(listing([]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, RULE_ID)?.expected).toBe('exists')
    expect(find(result.diffs, RULE_ID)?.actual).toBe('missing')
    expect(find(result.diffs, RULE_ID)?.severity).toBe('critical')
  })

  it('reports no drift when the live rule still matches', async () => {
    mockMdeFetch(listing([live()]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('reports a rule that was switched off, and a renamed rule, as warnings', async () => {
    mockMdeFetch(listing([live({ status: 'disabled', displayName: 'Renamed by hand' })]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, `${RULE_ID}.status`)?.actual).toBe('disabled')
    expect(find(result.diffs, `${RULE_ID}.status`)?.severity).toBe('warning')
    expect(find(result.diffs, `${RULE_ID}.displayName`)?.actual).toBe('Renamed by hand')
  })

  it('attributes the change to the human who last modified the rule', async () => {
    mockMdeFetch(
      listing([
        live({
          status: 'disabled',
          createdBy: 'Veltrix Deployer',
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedBy: 'soc-lead@contoso.com',
          lastModifiedDateTime: '2026-02-02T10:00:00Z',
        }),
      ]),
    )
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    const diff = find(result.diffs, `${RULE_ID}.status`)
    expect(diff?.actor?.name).toBe('soc-lead@contoso.com')
    expect(diff?.actor?.at).toBe('2026-02-02T10:00:00Z')
    expect(diff?.actor?.eventType).toBe('updated')
  })

  it('does not attribute a change to Veltrix when only the app registration stamped it', async () => {
    mockMdeFetch(
      listing([
        live({
          status: 'disabled',
          createdBy: credential.username,
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedBy: credential.username,
          lastModifiedDateTime: '2026-02-02T10:00:00Z',
        }),
      ]),
    )
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, `${RULE_ID}.status`)?.actor).toBeUndefined()
  })

  it('reports Graph as unreachable instead of throwing when the listing fails', async () => {
    mockMdeFetch(() => ({ status: 500, body: apiError('Graph unavailable') }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(true)
    expect(find(result.diffs, 'graph')?.severity).toBe('critical')
    expect(String(find(result.diffs, 'graph')?.actual)).toContain('unreachable')
  })

  it('ignores live rules it never declared, which other tools may own', async () => {
    mockMdeFetch(listing([live(), { id: 'someone-elses-rule', displayName: 'Not ours', status: 'disabled' }]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
  })
})
