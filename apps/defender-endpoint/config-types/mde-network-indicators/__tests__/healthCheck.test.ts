// =============================================================================
// Health-check handler tests against a FAKE Defender API.
// Wiring + network-specific checks; the shared implementation is covered in
// full under mde-file-indicators.
// =============================================================================

import healthCheck from '../healthCheck'
import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import { apiError, healthCtx, mockMdeFetch } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-network-indicators'
const DOMAIN_VALUE = 'phish.example.net'

function item(): CanvasItemSnapshot {
  return {
    name: 'Phishing domain',
    fields: {
      indicator_type: 'DomainName',
      indicator_value: DOMAIN_VALUE,
      action: 'Block',
      severity: 'High',
      title: 'Phishing domain',
      description: 'Blocked during IR-2317',
    },
  }
}

describe('Defender Network Indicators Health Handler', () => {
  it('fails closed without calling Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: { value: [] } }))
    const result = await healthCheck(healthCtx(TYPE, [item()], { credential: null }))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('scores 100 when the declared domain indicator is still present', async () => {
    mockMdeFetch(() => ({
      status: 200,
      body: { value: [{ id: 'ind-1', indicatorType: 'DomainName', indicatorValue: DOMAIN_VALUE }] },
    }))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
  })

  it('fails the indicator check when it is gone', async () => {
    mockMdeFetch(() => ({ status: 200, body: { value: [] } }))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(result.checks[1].name).toBe(`indicator:DomainName ${DOMAIN_VALUE}`)
    expect(result.checks[1].passed).toBe(false)
  })

  it('reports unreachable rather than throwing when the listing fails', async () => {
    mockMdeFetch(() => ({ status: 503, body: apiError('service unavailable') }))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].passed).toBe(false)
  })
})
