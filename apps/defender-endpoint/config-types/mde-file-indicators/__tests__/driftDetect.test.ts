// =============================================================================
// Drift-detection handler tests against a FAKE Defender API.
//
// Drift reads the DEPLOYED snapshot (not the live canvas) and attributes each
// diff to the human who last changed the object, excluding Veltrix's own app
// registration so a deploy never looks like a manual change.
// =============================================================================

import driftDetect from '../driftDetect'
import type { CanvasItemSnapshot, DriftDiff } from '@veltrixsecops/app-sdk'
import { apiError, credential, driftCtx, mockMdeFetch, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-file-indicators'
const SHA256 = 'a'.repeat(64)
const LABEL = `FileSha256 ${SHA256}`

function item(fields: Record<string, unknown> = {}): CanvasItemSnapshot {
  return {
    name: 'Known-bad installer',
    fields: {
      indicator_type: 'FileSha256',
      indicator_value: SHA256,
      action: 'Block',
      severity: 'High',
      title: 'Known-bad installer',
      description: 'Blocked during IR-2317',
      ...fields,
    },
  }
}

function live(extra: Record<string, unknown> = {}) {
  return {
    id: 'ind-live',
    indicatorType: 'FileSha256',
    indicatorValue: SHA256,
    action: 'Block',
    severity: 'High',
    title: 'Known-bad installer',
    description: 'Blocked during IR-2317',
    ...extra,
  }
}

const listing = (indicators: unknown[]) => () => ({ status: 200, body: { value: indicators } })
const find = (diffs: DriftDiff[], field: string): DriftDiff | undefined => diffs.find((d) => d.field === field)

describe('Defender File Indicators Drift Handler', () => {
  it('makes no call and raises no diff when no credential is configured', async () => {
    const calls = mockMdeFetch(listing([]))
    const result = await driftDetect(driftCtx(TYPE, [item()], { credential: null }))

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('makes no call when the deployed snapshot declares nothing', async () => {
    const calls = mockMdeFetch(listing([]))
    const result = await driftDetect(driftCtx(TYPE, []))

    expect(result.hasDrift).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('reads the DEPLOYED snapshot, not the live canvas', async () => {
    // driftCtx leaves the canvas empty: a handler reading ctx.canvas sees nothing.
    mockMdeFetch(listing([]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
  })

  it('reports a deleted indicator as critical drift', async () => {
    mockMdeFetch(listing([]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, LABEL)?.expected).toBe('exists')
    expect(find(result.diffs, LABEL)?.actual).toBe('missing')
    expect(find(result.diffs, LABEL)?.severity).toBe('critical')
  })

  it('reports no drift when the live indicator still matches', async () => {
    mockMdeFetch(listing([live()]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('grades a weakened action as a warning and a changed severity as info', async () => {
    mockMdeFetch(listing([live({ action: 'Audit', severity: 'Low' })]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, `${LABEL}.action`)?.severity).toBe('warning')
    expect(find(result.diffs, `${LABEL}.action`)?.actual).toBe('Audit')
    expect(find(result.diffs, `${LABEL}.severity`)?.severity).toBe('info')
    expect(find(result.diffs, `${LABEL}.severity`)?.actual).toBe('Low')
  })

  it('attributes the change to the human who last updated the indicator', async () => {
    mockMdeFetch(
      listing([
        live({
          action: 'Audit',
          createdBy: 'app-client-id',
          sourceType: 'AadApp',
          creationTimeDateTimeUtc: '2026-01-01T00:00:00Z',
          lastUpdatedBy: 'analyst@contoso.com',
          lastUpdateTime: '2026-02-02T10:00:00Z',
        }),
      ]),
    )
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    const diff = find(result.diffs, `${LABEL}.action`)
    expect(diff?.actor?.name).toBe('analyst@contoso.com')
    expect(diff?.actor?.email).toBe('analyst@contoso.com')
    expect(diff?.actor?.at).toBe('2026-02-02T10:00:00Z')
    expect(diff?.actor?.eventType).toBe('updated')
  })

  it('does not attribute a change to Veltrix when the app registration is the only stamp', async () => {
    mockMdeFetch(
      listing([
        live({
          action: 'Audit',
          createdBy: credential.username,
          createdBySource: credential.username,
          sourceType: 'AadApp',
          creationTimeDateTimeUtc: '2026-01-01T00:00:00Z',
          lastUpdatedBy: credential.username,
          lastUpdateTime: '2026-02-02T10:00:00Z',
        }),
      ]),
    )
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, `${LABEL}.action`)?.actor).toBeUndefined()
  })

  it('reports the API as unreachable instead of throwing when the listing fails', async () => {
    mockMdeFetch(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(true)
    expect(find(result.diffs, 'mde')?.severity).toBe('critical')
    expect(String(find(result.diffs, 'mde')?.actual)).toContain('unreachable')
  })

  it('ignores indicators it never declared, which other tools may own', async () => {
    const calls = mockMdeFetch(
      listing([live(), { id: 'other', indicatorType: 'FileSha256', indicatorValue: 'f'.repeat(64), action: 'Block' }]),
    )
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
    expect(vendorCalls(calls).filter((c) => c.method !== 'GET')).toHaveLength(0)
  })
})
