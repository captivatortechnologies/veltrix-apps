// =============================================================================
// Rollback handler tests against a FAKE Defender API.
// Wiring + network-specific undo; the shared implementation is covered in full
// under mde-file-indicators.
// =============================================================================

import rollback from '../rollback'
import type { IndicatorRollbackEntry } from '../../../lib/indicators'
import { apiError, mockMdeFetch, rollbackCtx, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-network-indicators'
const IP_VALUE = '203.0.113.42'
const URL_VALUE = 'https://malware.example.com/payload'

const created: IndicatorRollbackEntry = {
  key: JSON.stringify(['ipaddress', IP_VALUE]),
  label: `IpAddress ${IP_VALUE}`,
  existed: false,
  id: 'ind-new',
}

const updated: IndicatorRollbackEntry = {
  key: JSON.stringify(['url', URL_VALUE]),
  label: `Url ${URL_VALUE}`,
  existed: true,
  id: 'ind-live',
  prior: {
    id: 'ind-live',
    indicatorType: 'Url',
    indicatorValue: URL_VALUE,
    action: 'Audit',
    severity: 'Informational',
    title: 'Watchlisted',
    description: 'Previously audit-only',
    generateAlert: true,
  },
}

const state = (entries: IndicatorRollbackEntry[]) => ({ previousState: entries })

describe('Defender Network Indicators Rollback Handler', () => {
  it('reports failure without calling Defender when the deploy recorded no previous state', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, {}))

    expect(result.success).toBe(false)
    expect(result.message).toBe('No previous state available for rollback')
    expect(calls).toHaveLength(0)
  })

  it('deletes only the indicators this deploy created and restores the ones it updated', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([created, updated])))

    const vendor = vendorCalls(calls)
    expect(vendor).toHaveLength(2)
    // Reverse order: the updated URL indicator was written last, so it is undone first.
    expect(vendor[0].method).toBe('POST')
    expect((vendor[0].body as Record<string, unknown>).indicatorValue).toBe(URL_VALUE)
    expect((vendor[0].body as Record<string, unknown>).action).toBe('Audit')
    expect(vendor[1].method).toBe('DELETE')
    expect(vendor[1].url).toContain('/api/indicators/ind-new')
    expect(result.success).toBe(true)
  })

  it('returns a FAILED result instead of throwing when Defender rejects the undo', async () => {
    mockMdeFetch(() => ({ status: 403, body: apiError('insufficient privileges') }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(result.success).toBe(false)
    expect(result.message).toContain('insufficient privileges')
  })
})
