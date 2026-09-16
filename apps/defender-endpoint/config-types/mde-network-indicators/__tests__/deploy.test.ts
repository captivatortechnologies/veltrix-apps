// =============================================================================
// Deploy handler tests against a FAKE Defender API.
//
// This config type is a thin wrapper over the shared indicator implementation
// (lib/indicators.ts, fully covered under mde-file-indicators). These tests pin
// the wiring — that this directory's deploy really is the deployer — and the
// network-specific values it has to carry to Defender intact.
// =============================================================================

import deploy from '../deploy'
import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { IndicatorRollbackEntry } from '../../../lib/indicators'
import { apiError, deployCtx, mockMdeFetch, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-network-indicators'
const URL_VALUE = 'https://malware.example.com/payload'
const IP_VALUE = '203.0.113.42'
const DOMAIN_VALUE = 'phish.example.net'

function item(indicatorType: string, indicatorValue: string, fields: Record<string, unknown> = {}): CanvasItemSnapshot {
  return {
    name: `${indicatorType} ${indicatorValue}`,
    fields: {
      indicator_type: indicatorType,
      indicator_value: indicatorValue,
      action: 'Block',
      severity: 'High',
      title: 'C2 infrastructure',
      description: 'Blocked during IR-2317',
      ...fields,
    },
  }
}

const emptyTenant = (method: string) =>
  method === 'GET' ? { status: 200, body: { value: [] } } : { status: 201, body: { id: 'ind-new' } }

const rollbackEntries = (result: { rollbackData?: unknown }): IndicatorRollbackEntry[] =>
  (result.rollbackData as { previousState?: IndicatorRollbackEntry[] })?.previousState ?? []

describe('Defender Network Indicators Deploy Handler', () => {
  it('refuses before touching Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [item('Url', URL_VALUE)], { credential: null }))

    expect(result.success).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('sends a URL, an IP and a domain indicator through the one /api/indicators endpoint', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(
      deployCtx(TYPE, [item('Url', URL_VALUE), item('IpAddress', IP_VALUE), item('DomainName', DOMAIN_VALUE)]),
    )

    const posts = vendorCalls(calls).filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(3)
    for (const post of posts) expect(post.url).toContain('/api/indicators')
    expect((posts[0].body as Record<string, unknown>).indicatorValue).toBe(URL_VALUE)
    expect((posts[1].body as Record<string, unknown>).indicatorValue).toBe(IP_VALUE)
    expect((posts[2].body as Record<string, unknown>).indicatorValue).toBe(DOMAIN_VALUE)
    expect(result.success).toBe(true)
    expect(result.message).toContain('Deployed 3 indicator(s)')
  })

  it('records a pre-existing domain indicator as an update so rollback restores rather than deletes it', async () => {
    const live = {
      id: 'ind-live',
      indicatorType: 'DomainName',
      indicatorValue: DOMAIN_VALUE,
      action: 'Audit',
      severity: 'Low',
    }
    mockMdeFetch((method) =>
      method === 'GET' ? { status: 200, body: { value: [live] } } : { status: 200, body: { id: 'ind-live' } },
    )
    const result = await deploy(deployCtx(TYPE, [item('DomainName', DOMAIN_VALUE)]))

    expect(rollbackEntries(result)[0].existed).toBe(true)
    expect(rollbackEntries(result)[0].prior?.action).toBe('Audit')
  })

  it('returns a FAILED result instead of throwing when Defender rejects the write', async () => {
    mockMdeFetch((method) =>
      method === 'GET' ? { status: 200, body: { value: [] } } : { status: 400, body: apiError('Invalid indicator value') },
    )
    const result = await deploy(deployCtx(TYPE, [item('Url', URL_VALUE)]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Invalid indicator value')
  })

  it('writes nothing when the live listing cannot be read', async () => {
    const calls = mockMdeFetch(() => ({ status: 503, body: apiError('service unavailable') }))
    const result = await deploy(deployCtx(TYPE, [item('IpAddress', IP_VALUE)]))

    expect(result.success).toBe(false)
    expect(vendorCalls(calls).filter((c) => c.method === 'POST')).toHaveLength(0)
  })
})
