// =============================================================================
// Drift-detection handler tests against a FAKE Defender API.
//
// Machines carry no per-property audit stamp, so these diffs are deliberately
// unattributed — what matters is that a device that no longer resolves is
// separated from one whose criticality was simply changed by hand.
// =============================================================================

import driftDetect from '../driftDetect'
import type { CanvasItemSnapshot, DriftDiff } from '@veltrixsecops/app-sdk'
import { MACHINE_ID, apiError, driftCtx, mockMdeFetch } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-device-values'

function item(fields: Record<string, unknown> = {}): CanvasItemSnapshot {
  return {
    name: 'Domain controller',
    fields: { device_type: 'id', device: MACHINE_ID, criticality: 'High', ...fields },
  }
}

const find = (diffs: DriftDiff[], field: string): DriftDiff | undefined => diffs.find((d) => d.field === field)

describe('Defender Device Values Drift Handler', () => {
  it('makes no call and raises no diff when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await driftDetect(driftCtx(TYPE, [item()], { credential: null }))

    expect(result.hasDrift).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('makes no call when the deployed snapshot declares nothing', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await driftDetect(driftCtx(TYPE, []))

    expect(result.hasDrift).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('reports no drift when the device still carries the declared criticality', async () => {
    mockMdeFetch(() => ({ status: 200, body: { id: MACHINE_ID, computerDnsName: 'dc01.contoso.com', deviceValue: 'High' } }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('reports a hand-changed criticality as a warning, showing live vs declared', async () => {
    mockMdeFetch(() => ({ status: 200, body: { id: MACHINE_ID, computerDnsName: 'dc01.contoso.com', deviceValue: 'Low' } }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    const diff = find(result.diffs, 'dc01.contoso.com.deviceValue')
    expect(diff?.expected).toBe('High')
    expect(diff?.actual).toBe('Low')
    expect(diff?.severity).toBe('warning')
  })

  it('treats a device whose criticality was cleared as back to Normal', async () => {
    mockMdeFetch(() => ({ status: 200, body: { id: MACHINE_ID, computerDnsName: 'dc01.contoso.com' } }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, 'dc01.contoso.com.deviceValue')?.actual).toBe('Normal')
  })

  it('reports a device that no longer resolves as critical drift', async () => {
    mockMdeFetch(() => ({ status: 404, body: apiError('ResourceNotFound') }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, `device:${MACHINE_ID}`)?.actual).toBe('not found')
    expect(find(result.diffs, `device:${MACHINE_ID}`)?.severity).toBe('critical')
  })

  it('separates an unreachable API from a missing device', async () => {
    mockMdeFetch(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    const diff = find(result.diffs, `device:${MACHINE_ID}`)
    expect(diff?.expected).toBe('reachable')
    expect(String(diff?.actual)).toContain('unreachable')
    expect(diff?.severity).toBe('critical')
  })

  it('checks every device a computer name resolves to', async () => {
    mockMdeFetch(() => ({
      status: 200,
      body: {
        value: [
          { id: MACHINE_ID, computerDnsName: 'web01.contoso.com', deviceValue: 'High' },
          { id: 'e'.repeat(40), computerDnsName: 'web01.contoso.com', deviceValue: 'Normal' },
        ],
      },
    }))
    const result = await driftDetect(driftCtx(TYPE, [item({ device_type: 'name', device: 'web01.contoso.com' })]))

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].actual).toBe('Normal')
  })
})
