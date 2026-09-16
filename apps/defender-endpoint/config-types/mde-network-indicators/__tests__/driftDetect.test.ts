// =============================================================================
// Drift-detection handler tests against a FAKE Defender API.
// Wiring + network-specific drift; the shared implementation is covered in full
// under mde-file-indicators.
// =============================================================================

import driftDetect from '../driftDetect'
import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import { apiError, driftCtx, mockMdeFetch } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-network-indicators'
const IP_VALUE = '203.0.113.42'

function item(): CanvasItemSnapshot {
  return {
    name: 'C2 address',
    fields: {
      indicator_type: 'IpAddress',
      indicator_value: IP_VALUE,
      action: 'Block',
      severity: 'High',
      title: 'C2 infrastructure',
      description: 'Blocked during IR-2317',
    },
  }
}

describe('Defender Network Indicators Drift Handler', () => {
  it('makes no call and raises no diff when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: { value: [] } }))
    const result = await driftDetect(driftCtx(TYPE, [item()], { credential: null }))

    expect(result.hasDrift).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('reports a deleted network indicator as critical drift', async () => {
    mockMdeFetch(() => ({ status: 200, body: { value: [] } }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe(`IpAddress ${IP_VALUE}`)
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('reports no drift when the live indicator still matches', async () => {
    mockMdeFetch(() => ({
      status: 200,
      body: { value: [{ id: 'ind-1', indicatorType: 'IpAddress', indicatorValue: IP_VALUE, action: 'Block', severity: 'High' }] },
    }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('reports the API as unreachable instead of throwing when the listing fails', async () => {
    mockMdeFetch(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('mde')
    expect(result.diffs[0].severity).toBe('critical')
  })
})
