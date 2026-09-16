// =============================================================================
// Rollback handler tests against a FAKE Defender API.
// Wiring + certificate-specific undo; the shared implementation is covered in
// full under mde-file-indicators.
// =============================================================================

import rollback from '../rollback'
import type { IndicatorRollbackEntry } from '../../../lib/indicators'
import { apiError, mockMdeFetch, rollbackCtx, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-cert-indicators'
const THUMBPRINT = 'ab'.repeat(20)
const OTHER_THUMBPRINT = 'cd'.repeat(20)

const created: IndicatorRollbackEntry = {
  key: JSON.stringify(['certificatethumbprint', THUMBPRINT]),
  label: `CertificateThumbprint ${THUMBPRINT}`,
  existed: false,
  id: 'ind-new',
}

const updated: IndicatorRollbackEntry = {
  key: JSON.stringify(['certificatethumbprint', OTHER_THUMBPRINT]),
  label: `CertificateThumbprint ${OTHER_THUMBPRINT}`,
  existed: true,
  id: 'ind-live',
  prior: {
    id: 'ind-live',
    indicatorType: 'CertificateThumbprint',
    indicatorValue: OTHER_THUMBPRINT,
    action: 'Audit',
    severity: 'Medium',
    title: 'Watchlisted',
    description: 'Previously audit-only',
    generateAlert: true,
  },
}

const state = (entries: IndicatorRollbackEntry[]) => ({ previousState: entries })

describe('Defender Certificate Indicators Rollback Handler', () => {
  it('reports failure without calling Defender when the deploy recorded no previous state', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, {}))

    expect(result.success).toBe(false)
    expect(result.message).toBe('No previous state available for rollback')
    expect(calls).toHaveLength(0)
  })

  it('deletes a thumbprint this deploy created', async () => {
    const calls = mockMdeFetch(() => ({ status: 204, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(vendorCalls(calls)[0].method).toBe('DELETE')
    expect(vendorCalls(calls)[0].url).toContain('/api/indicators/ind-new')
    expect(result.success).toBe(true)
  })

  it('restores a pre-existing thumbprint from its captured prior state', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([updated])))

    expect(vendorCalls(calls)[0].method).toBe('POST')
    expect((vendorCalls(calls)[0].body as Record<string, unknown>).indicatorValue).toBe(OTHER_THUMBPRINT)
    expect((vendorCalls(calls)[0].body as Record<string, unknown>).action).toBe('Audit')
    expect(result.success).toBe(true)
  })

  it('returns a FAILED result instead of throwing when Defender rejects the undo', async () => {
    mockMdeFetch(() => ({ status: 500, body: apiError('boom') }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Rollback failed after 0 of 1')
  })
})
