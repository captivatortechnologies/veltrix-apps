// =============================================================================
// Drift-detection and health handler tests against a FAKE Defender API.
// Wiring + certificate-specific behaviour; the shared implementation is covered
// in full under mde-file-indicators.
// =============================================================================

import driftDetect from '../driftDetect'
import healthCheck from '../healthCheck'
import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import { apiError, driftCtx, healthCtx, mockMdeFetch } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-cert-indicators'
const THUMBPRINT = 'ab'.repeat(20)

function item(): CanvasItemSnapshot {
  return {
    name: 'Revoked signing certificate',
    fields: {
      indicator_type: 'CertificateThumbprint',
      indicator_value: THUMBPRINT,
      action: 'Block',
      severity: 'High',
      title: 'Revoked signing certificate',
      description: 'Stolen code-signing cert from IR-2317',
    },
  }
}

const liveThumbprint = {
  id: 'ind-1',
  indicatorType: 'CertificateThumbprint',
  indicatorValue: THUMBPRINT,
  action: 'Block',
  severity: 'High',
}

describe('Defender Certificate Indicators Drift Handler', () => {
  it('makes no call and raises no diff when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: { value: [] } }))
    const result = await driftDetect(driftCtx(TYPE, [item()], { credential: null }))

    expect(result.hasDrift).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('reports a deleted thumbprint as critical drift', async () => {
    mockMdeFetch(() => ({ status: 200, body: { value: [] } }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.diffs[0].field).toBe(`CertificateThumbprint ${THUMBPRINT}`)
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('reports a weakened action as a warning', async () => {
    mockMdeFetch(() => ({ status: 200, body: { value: [{ ...liveThumbprint, action: 'Audit' }] } }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.diffs[0].field).toBe(`CertificateThumbprint ${THUMBPRINT}.action`)
    expect(result.diffs[0].severity).toBe('warning')
  })

  it('reports the API as unreachable instead of throwing when the listing fails', async () => {
    mockMdeFetch(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.diffs[0].field).toBe('mde')
    expect(result.diffs[0].severity).toBe('critical')
  })
})

describe('Defender Certificate Indicators Health Handler', () => {
  it('fails closed without calling Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: { value: [] } }))
    const result = await healthCheck(healthCtx(TYPE, [item()], { credential: null }))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('scores 100 when the declared thumbprint is still present', async () => {
    mockMdeFetch(() => ({ status: 200, body: { value: [liveThumbprint] } }))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
  })

  it('reports unreachable rather than throwing when the listing fails', async () => {
    mockMdeFetch(() => ({ status: 503, body: apiError('service unavailable') }))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(result.checks).toHaveLength(1)
  })
})
